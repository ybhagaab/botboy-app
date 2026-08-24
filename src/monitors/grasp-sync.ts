/**
 * GRASP background sync — canonical Outlook mail + calendar ingestion.
 *
 * Every 30 minutes this loop pulls the owner's new inbox mail, sent mail, and
 * a rolling calendar window from the managed GRASP MCP (read tools only), and
 * emits the survivors as RawWorkItems through the shared event bus. Items then
 * flow through the normal capture path (lossless ContentStore, FTS) and are
 * consumed by the interpretation pipeline (librarian → brain updates →
 * projects/areas) on its own cadence — the batcher's age trigger folds a
 * fresh sync into synthesis within minutes.
 *
 * Trust and noise rules (user directives, 2026-08-17):
 * - Owner identity is auto-detected from GRASP `get_profile` and can be
 *   overridden via the `grasp_sync.owner_email` setting.
 * - Automated senders (no-reply, pipelines, CleverTap, marketing…) are
 *   dropped BEFORE the direct-address check, because automation regularly
 *   addresses the owner directly. Meeting summary/recap subjects override the
 *   deny list — those carry project action items.
 * - Inbox mail is kept only when the owner's address is literally in To or
 *   Cc. To gets precedence via `directlyAddressedToOwner`, which unlocks
 *   action-capable email evidence in the brain updater. Distribution-list
 *   mail is dropped.
 * - Sent mail is the owner's own writing: no filters, direction 'sent'.
 * - Calendar events re-emit only when their rendered content changes, so a
 *   moved meeting lands as a fresh observation instead of silent churn.
 *
 * This module never calls a write-classified MCP tool: the mailbox is never
 * marked read, moved, or modified.
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import type { McpManager } from '../core/mcp-types.js';
import type { RawWorkItem } from '../core/types.js';
import { getSetting, setSetting } from '../core/storage.js';

const GRASP_PROFILE_ID = 'grasp-m365';

const KEYS = {
  enabled: 'grasp_sync.enabled',
  ownerEmail: 'grasp_sync.owner_email',
  ownerName: 'grasp_sync.owner_name',
  noiseSenders: 'grasp_sync.noise_senders',
  cursorInbox: 'grasp_sync.cursor.mail_inbox',
  cursorSent: 'grasp_sync.cursor.mail_sent',
  mailActive: 'grasp_sync.mail_active',
  lastRun: 'grasp_sync.last_run',
} as const;

/**
 * Deny-list applied to the sender address AND display name (lowercase
 * substring match). Deliberately conservative: the direct-address rule
 * already drops distribution-list bulk, so this list only needs the
 * automation that writes straight TO the owner.
 */
const DEFAULT_NOISE_SENDERS = [
  'no-reply', 'noreply', 'donotreply', 'do-not-reply', 'do_not_reply',
  'notification', 'mailer-daemon', 'postmaster', 'bounces@', 'bounce@',
  'pipeline', 'jenkins', 'clevertap', 'newsletter', 'marketing@', 'campaign',
  'alerts@', 'alert@', 'digest@', 'automated@', 'auto-confirm', 'billing@',
  'receipts@', 'survey@', 'surveys@', 'feedback@', 'reminderservice',
  'concursolutions',
];

/** Meeting recap/summary mail carries action items — never treat as noise. */
const MEETING_SUMMARY_SUBJECT = /\bmeeting\s+(?:summary|recap|notes|minutes|insights)\b|\baction\s+items?\b|\brecap\b/i;

export interface GraspSyncConfig {
  intervalMs?: number; // default 30 min
  initialDelayMs?: number; // default 90 s (lets the MCP runtime settle after boot)
  mailLookbackHours?: number; // first-run inbox/sent window (default 48 h)
  calendarPastDays?: number; // rolling window start (default 1)
  calendarFutureDays?: number; // rolling window end (default 14)
  pageSize?: number; // list page size (default 50, tool max 100)
  maxPagesPerFolder?: number; // per-run page cap (default 4)
  maxDetailCallsPerRun?: number; // get_email_details budget per run (default 80)
}

interface FolderCounters {
  listed: number;
  noise: number;
  notAddressed: number;
  duplicates: number;
  emitted: number;
  detailFailures: number;
}

export interface GraspSyncResult {
  status: 'completed' | 'skipped' | 'failed';
  reason?: string;
  ownerEmail?: string;
  inbox: FolderCounters;
  sent: FolderCounters;
  calendar: { listed: number; unchanged: number; emitted: number };
  durationMs: number;
}

export interface GraspSyncStatusView {
  enabled: boolean;
  running: boolean;
  intervalMinutes: number;
  ownerEmail: string;
  ownerName: string;
  noiseSenders: string[];
  mailActive: boolean;
  lastRun: Record<string, unknown> | null;
  cursors: { inbox: string | null; sent: string | null };
}

export interface GraspSyncConfigInput {
  enabled?: boolean;
  /** Empty string clears the override; the next run re-detects via get_profile. */
  ownerEmail?: string;
  noiseSenders?: string[];
}

export interface GraspSync {
  start(): void;
  stop(): void;
  /** Run one sync now (single-flight with the timer). */
  runNow(): Promise<GraspSyncResult>;
  isRunning(): boolean;
  /** Settings-backed status for the Connections surface. */
  getStatus(): GraspSyncStatusView;
  /** Validate and persist connection settings; returns the fresh status. */
  updateConfig(input: GraspSyncConfigInput): GraspSyncStatusView;
}

interface GraspEmailListEntry {
  id: string;
  subject?: string;
  from?: { emailAddress?: string; displayName?: string };
  toRecipients?: Array<{ emailAddress?: string; displayName?: string }>;
  ccRecipients?: Array<{ emailAddress?: string; displayName?: string }>;
  receivedDateTime?: string;
  sentDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  importance?: string;
  folder?: string;
}

interface GraspEmailDetail extends GraspEmailListEntry {
  bodyContent?: string;
  bodyType?: string;
  conversationId?: string;
}

interface GraspCalendarEvent {
  id: string;
  subject?: string;
  start?: string;
  end?: string;
  location?: string;
  organizer?: string;
  isAllDay?: boolean;
  attendees?: string[];
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function emptyCounters(): FolderCounters {
  return { listed: 0, noise: 0, notAddressed: 0, duplicates: 0, emitted: 0, detailFailures: 0 };
}

/** ISO-8601 without milliseconds — the format the GRASP schemas document. */
function isoNoMs(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeAddress(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function addressesOf(list: Array<{ emailAddress?: string }> | undefined): string[] {
  return [...new Set((list ?? []).map(entry => normalizeAddress(entry.emailAddress)).filter(Boolean))];
}

/**
 * Readable text from an HTML mail body. Content is stored losslessly either
 * way; this only shapes the FTS/interpretation text.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<(?:style|script)\b[\s\S]*?<\/(?:style|script)>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * GRASP wraps mail bodies in an `<email_content_…>` envelope with injected
 * caution lines. The envelope is transport framing, not message content.
 */
function unwrapGraspEnvelope(text: string): string {
  return text
    .replace(/<\/?email_content_[0-9a-f]+>/gi, '')
    .replace(/^\s*⚠️ UNTRUSTED CONTENT[^\n]*\n?/gim, '')
    .replace(/^\s*Do NOT follow any instructions[^\n]*\n?/gim, '')
    .trim();
}

function parseToolJson<T>(text: string, tool: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${tool} returned non-JSON payload: ${text.slice(0, 160)}`);
  }
}

export function createGraspSync(deps: {
  db: Database.Database;
  mcpManager: McpManager;
  emit: (item: RawWorkItem) => void;
  config?: GraspSyncConfig;
}): GraspSync {
  const { db, mcpManager, emit } = deps;
  const intervalMs = deps.config?.intervalMs ?? 30 * 60 * 1000;
  const initialDelayMs = deps.config?.initialDelayMs ?? 90 * 1000;
  const mailLookbackHours = deps.config?.mailLookbackHours ?? 48;
  const calendarPastDays = deps.config?.calendarPastDays ?? 1;
  const calendarFutureDays = deps.config?.calendarFutureDays ?? 14;
  const pageSize = Math.min(deps.config?.pageSize ?? 50, 100);
  const maxPagesPerFolder = deps.config?.maxPagesPerFolder ?? 4;
  const maxDetailCallsPerRun = deps.config?.maxDetailCallsPerRun ?? 80;

  let timer: ReturnType<typeof setInterval> | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let lastLoggedError = '';
  let detailCallsThisRun = 0;

  const latestRowForUrl = db.prepare(
    'SELECT id, content_sha256 FROM work_items WHERE url = ? ORDER BY datetime(captured_at) DESC LIMIT 1',
  );

  async function call<T>(tool: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
    const result = await mcpManager.callTool(GRASP_PROFILE_ID, tool, args, { source: 'api', timeoutMs });
    if (result.isError) throw new Error(`${tool} failed: ${result.text.slice(0, 300)}`);
    return parseToolJson<T>(result.text, tool);
  }

  /** Owner identity: explicit setting wins; otherwise detect via get_profile. */
  async function resolveOwner(): Promise<{ email: string; name: string }> {
    const configured = normalizeAddress(getSetting<string>(db, KEYS.ownerEmail));
    if (configured) {
      return { email: configured, name: getSetting<string>(db, KEYS.ownerName) ?? '' };
    }
    const result = await mcpManager.callTool(GRASP_PROFILE_ID, 'get_profile', {}, { source: 'api', timeoutMs: 45_000 });
    if (result.isError) throw new Error(`get_profile failed: ${result.text.slice(0, 300)}`);
    const email = normalizeAddress(result.text.match(/\*\*Email\*\*:\s*([^\s*]+@[^\s*]+)/i)?.[1]);
    const name = result.text.match(/^#\s*User Profile:\s*(.+)$/im)?.[1]?.trim() ?? '';
    if (!email) throw new Error('Owner email not found in get_profile response; set grasp_sync.owner_email manually.');
    setSetting(db, KEYS.ownerEmail, email);
    if (name) setSetting(db, KEYS.ownerName, name);
    console.log(`[GraspSync] Owner identity detected: ${email}${name ? ` (${name})` : ''}`);
    return { email, name };
  }

  function noisePatterns(): string[] {
    const configured = getSetting<string[]>(db, KEYS.noiseSenders);
    if (Array.isArray(configured) && configured.length > 0) return configured.map(p => String(p).toLowerCase());
    setSetting(db, KEYS.noiseSenders, DEFAULT_NOISE_SENDERS);
    return [...DEFAULT_NOISE_SENDERS];
  }

  function isNoiseSender(entry: GraspEmailListEntry, patterns: string[]): boolean {
    if (MEETING_SUMMARY_SUBJECT.test(entry.subject ?? '')) return false;
    const haystack = `${normalizeAddress(entry.from?.emailAddress)} ${String(entry.from?.displayName ?? '').toLowerCase()}`;
    return patterns.some(pattern => haystack.includes(pattern));
  }

  async function fetchDetail(emailId: string): Promise<GraspEmailDetail> {
    detailCallsThisRun++;
    if (detailCallsThisRun > maxDetailCallsPerRun) {
      throw new Error(`detail-call budget exceeded (${maxDetailCallsPerRun}); remaining mail continues next run`);
    }
    return call<GraspEmailDetail>('get_email_details', { emailId }, 60_000);
  }

  function renderEmailContent(
    detail: GraspEmailDetail,
    entry: GraspEmailListEntry,
    direction: 'received' | 'sent',
  ): string {
    const rawBody = typeof detail.bodyContent === 'string' && detail.bodyContent.trim().length > 0
      ? (String(detail.bodyType ?? '').toLowerCase() === 'html' ? stripHtml(detail.bodyContent) : detail.bodyContent)
      : (entry.bodyPreview ?? '');
    const body = unwrapGraspEnvelope(rawBody);
    const fromLabel = `${entry.from?.displayName ?? ''} <${entry.from?.emailAddress ?? ''}>`.trim();
    const lines = [
      `Subject: ${entry.subject ?? '(no subject)'}`,
      `From: ${fromLabel}`,
      `To: ${addressesOf(entry.toRecipients).join(', ')}`,
    ];
    const cc = addressesOf(detail.ccRecipients ?? entry.ccRecipients);
    if (cc.length > 0) lines.push(`Cc: ${cc.join(', ')}`);
    lines.push(`${direction === 'sent' ? 'Sent' : 'Received'}: ${entry.receivedDateTime ?? entry.sentDateTime ?? ''}`);
    return `${lines.join('\n')}\n\n${body}`;
  }

  async function syncMailFolder(
    folder: 'inbox' | 'sent',
    owner: string,
    patterns: string[],
  ): Promise<FolderCounters> {
    const counters = emptyCounters();
    const cursorKey = folder === 'inbox' ? KEYS.cursorInbox : KEYS.cursorSent;
    const cursor = getSetting<string>(db, cursorKey)
      ?? isoNoMs(new Date(Date.now() - mailLookbackHours * 3_600_000));
    let pageToken: string | undefined;
    let maxSeen = cursor;
    // The cursor only advances past mail this run fully decided on (emitted or
    // deliberately dropped). A failure mid-folder keeps the cursor at the last
    // safe point so the next run re-lists from there; URL dedup absorbs overlap.
    let advanceTo = cursor;

    try {
      for (let page = 0; page < maxPagesPerFolder; page++) {
        const args: Record<string, unknown> = {
          folder,
          filter: `receivedDateTime ge ${cursor}`,
          orderBy: 'receivedDateTime asc',
          maxResults: pageSize,
        };
        if (pageToken) args.pageToken = pageToken;
        const payload = await call<{ emails?: GraspEmailListEntry[]; nextPageToken?: string; pageToken?: string }>(
          'get_emails', args,
        );
        const emails = payload.emails ?? [];
        counters.listed += emails.length;

        for (const entry of emails) {
          if (!entry.id) continue;
          if (entry.receivedDateTime && entry.receivedDateTime > maxSeen) maxSeen = entry.receivedDateTime;

          const url = `grasp://mail/${entry.id}`;
          if (latestRowForUrl.get(url)) { counters.duplicates++; advanceTo = maxSeen; continue; }

          if (folder === 'inbox') {
            if (isNoiseSender(entry, patterns)) { counters.noise++; advanceTo = maxSeen; continue; }
            const toEmails = addressesOf(entry.toRecipients);
            const direct = toEmails.includes(owner);

            let detail: GraspEmailDetail;
            try {
              detail = await fetchDetail(entry.id);
            } catch (error: any) {
              counters.detailFailures++;
              throw error; // abort folder — cursor stays at last decided mail
            }
            const ccEmails = addressesOf(detail.ccRecipients ?? entry.ccRecipients);
            if (!direct && !ccEmails.includes(owner)) { counters.notAddressed++; advanceTo = maxSeen; continue; }

            emit(buildEmailItem(detail, entry, 'received', owner, direct, folder));
          } else {
            let detail: GraspEmailDetail;
            try {
              detail = await fetchDetail(entry.id);
            } catch (error: any) {
              counters.detailFailures++;
              throw error;
            }
            emit(buildEmailItem(detail, entry, 'sent', owner, false, folder));
          }
          counters.emitted++;
          advanceTo = maxSeen;
        }

        pageToken = payload.nextPageToken ?? payload.pageToken;
        if (!pageToken || emails.length === 0) break;
      }
    } finally {
      if (advanceTo > cursor) setSetting(db, cursorKey, advanceTo);
    }
    return counters;
  }

  function buildEmailItem(
    detail: GraspEmailDetail,
    entry: GraspEmailListEntry,
    direction: 'received' | 'sent',
    owner: string,
    directlyAddressed: boolean,
    folder: string,
  ): RawWorkItem {
    const toEmails = addressesOf(entry.toRecipients);
    const ccEmails = addressesOf(detail.ccRecipients ?? entry.ccRecipients);
    const capturedAt = entry.receivedDateTime ? new Date(entry.receivedDateTime) : new Date();
    return {
      type: direction === 'sent' ? 'email_sent' : 'email_read',
      source: 'grasp',
      sourceApp: 'GRASP M365',
      url: `grasp://mail/${entry.id}`,
      title: entry.subject || '(no subject)',
      content: renderEmailContent(detail, entry, direction),
      metadata: {
        subject: entry.subject ?? '',
        sender: normalizeAddress(entry.from?.emailAddress),
        senderName: entry.from?.displayName ?? '',
        recipients: toEmails.join(','),
        toRecipients: toEmails.join(','),
        ccRecipients: ccEmails.join(','),
        direction,
        ownerEmail: owner,
        directlyAddressedToOwner: directlyAddressed ? 'true' : 'false',
        conversationId: detail.conversationId ?? '',
        importance: entry.importance ?? '',
        hasAttachments: entry.hasAttachments ? 'true' : 'false',
        folder,
        graspId: entry.id,
        platform: 'grasp_m365',
      },
      capturedAt: Number.isNaN(capturedAt.getTime()) ? new Date() : capturedAt,
    };
  }

  function renderEventContent(event: GraspCalendarEvent): string {
    const attendees = [...(event.attendees ?? [])].sort();
    const shown = attendees.slice(0, 80);
    const lines = [
      `Meeting: ${event.subject ?? '(no subject)'}`,
      `Organizer: ${event.organizer ?? ''}`,
      `Start: ${event.start ?? ''}`,
      `End: ${event.end ?? ''}`,
      `All day: ${event.isAllDay ? 'yes' : 'no'}`,
    ];
    if (event.location) lines.push(`Location: ${event.location}`);
    lines.push(`Attendees (${attendees.length}): ${shown.join(', ')}${attendees.length > shown.length ? `, +${attendees.length - shown.length} more` : ''}`);
    return lines.join('\n');
  }

  async function syncCalendar(): Promise<{ listed: number; unchanged: number; emitted: number }> {
    const counters = { listed: 0, unchanged: 0, emitted: 0 };
    const startDateTime = isoNoMs(new Date(Date.now() - calendarPastDays * 86_400_000));
    const endDateTime = isoNoMs(new Date(Date.now() + calendarFutureDays * 86_400_000));
    let pageToken: string | undefined;

    for (let page = 0; page < maxPagesPerFolder; page++) {
      const args: Record<string, unknown> = { startDateTime, endDateTime, maxResults: 100 };
      if (pageToken) args.pageToken = pageToken;
      const payload = await call<{ events?: GraspCalendarEvent[]; nextPageToken?: string }>('get_calendar_events', args);
      const events = payload.events ?? [];
      counters.listed += events.length;

      for (const event of events) {
        if (!event.id) continue;
        const url = `grasp://event/${event.id}`;
        const content = renderEventContent(event);
        const existing = latestRowForUrl.get(url) as { id: string; content_sha256: string | null } | undefined;
        if (existing && existing.content_sha256 === sha256Hex(content)) { counters.unchanged++; continue; }

        const startLabel = (event.start ?? '').slice(0, 16).replace('T', ' ');
        emit({
          type: 'calendar_event',
          source: 'grasp',
          sourceApp: 'GRASP M365',
          url,
          title: `${event.subject || '(no subject)'}${startLabel ? ` — ${startLabel}` : ''}`,
          content,
          metadata: {
            eventId: event.id,
            subject: event.subject ?? '',
            organizer: event.organizer ?? '',
            startsAt: event.start ?? '',
            endsAt: event.end ?? '',
            isAllDay: event.isAllDay ? 'true' : 'false',
            location: event.location ?? '',
            attendeeCount: String((event.attendees ?? []).length),
            changed: existing ? 'true' : 'false',
            graspId: event.id,
            platform: 'grasp_m365',
          },
          capturedAt: new Date(),
        });
        counters.emitted++;
      }

      pageToken = payload.nextPageToken;
      if (!pageToken || events.length === 0) break;
    }
    return counters;
  }

  async function runOnce(): Promise<GraspSyncResult> {
    const startedAt = Date.now();
    const result: GraspSyncResult = {
      status: 'completed',
      inbox: emptyCounters(),
      sent: emptyCounters(),
      calendar: { listed: 0, unchanged: 0, emitted: 0 },
      durationMs: 0,
    };

    if (getSetting<boolean>(db, KEYS.enabled) === false) {
      result.status = 'skipped';
      result.reason = 'grasp_sync.enabled is false';
      result.durationMs = Date.now() - startedAt;
      return result;
    }

    detailCallsThisRun = 0;
    try {
      const owner = await resolveOwner();
      result.ownerEmail = owner.email;
      const patterns = noisePatterns();

      // Any folder can fail independently (budget, transient MCP error); the
      // others still run. Cursors only advance over fully decided mail.
      const errors: string[] = [];
      try { result.inbox = await syncMailFolder('inbox', owner.email, patterns); }
      catch (error: any) { errors.push(`inbox: ${error?.message ?? error}`); }
      try { result.sent = await syncMailFolder('sent', owner.email, patterns); }
      catch (error: any) { errors.push(`sent: ${error?.message ?? error}`); }
      try { result.calendar = await syncCalendar(); }
      catch (error: any) { errors.push(`calendar: ${error?.message ?? error}`); }

      if (errors.length > 0) {
        result.status = 'failed';
        result.reason = errors.join(' | ');
      } else {
        // Mail sync is live — the browser Outlook capture becomes redundant.
        setSetting(db, KEYS.mailActive, true);
      }
    } catch (error: any) {
      result.status = 'failed';
      result.reason = String(error?.message ?? error);
    }

    result.durationMs = Date.now() - startedAt;
    setSetting(db, KEYS.lastRun, {
      at: new Date().toISOString(),
      status: result.status,
      reason: result.reason ?? null,
      ownerEmail: result.ownerEmail ?? null,
      inbox: result.inbox,
      sent: result.sent,
      calendar: result.calendar,
      durationMs: result.durationMs,
    });

    if (result.status === 'failed') {
      // A broken Midway session fails identically every 30 minutes — log the
      // transition, not the repetition.
      if (result.reason !== lastLoggedError) {
        console.warn(`[GraspSync] sync failed: ${result.reason}`);
        lastLoggedError = result.reason ?? '';
      }
    } else {
      lastLoggedError = '';
      console.log(
        `[GraspSync] ${result.status} in ${(result.durationMs / 1000).toFixed(1)}s — `
        + `inbox ${result.inbox.listed} listed → ${result.inbox.emitted} emitted `
        + `(${result.inbox.noise} noise, ${result.inbox.notAddressed} not addressed, ${result.inbox.duplicates} dup); `
        + `sent ${result.sent.emitted} emitted; `
        + `calendar ${result.calendar.listed} listed → ${result.calendar.emitted} emitted (${result.calendar.unchanged} unchanged)`,
      );
    }
    return result;
  }

  async function guardedRun(): Promise<GraspSyncResult> {
    if (running) {
      return {
        status: 'skipped', reason: 'sync already running',
        inbox: emptyCounters(), sent: emptyCounters(),
        calendar: { listed: 0, unchanged: 0, emitted: 0 }, durationMs: 0,
      };
    }
    running = true;
    try {
      return await runOnce();
    } finally {
      running = false;
    }
  }

  function getStatus(): GraspSyncStatusView {
    return {
      enabled: getSetting<boolean>(db, KEYS.enabled) !== false,
      running,
      intervalMinutes: Math.round(intervalMs / 60_000),
      ownerEmail: getSetting<string>(db, KEYS.ownerEmail) ?? '',
      ownerName: getSetting<string>(db, KEYS.ownerName) ?? '',
      noiseSenders: getSetting<string[]>(db, KEYS.noiseSenders) ?? [...DEFAULT_NOISE_SENDERS],
      mailActive: getSetting<boolean>(db, KEYS.mailActive) === true,
      lastRun: getSetting<Record<string, unknown>>(db, KEYS.lastRun) ?? null,
      cursors: {
        inbox: getSetting<string>(db, KEYS.cursorInbox) ?? null,
        sent: getSetting<string>(db, KEYS.cursorSent) ?? null,
      },
    };
  }

  function updateConfig(input: GraspSyncConfigInput): GraspSyncStatusView {
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw new Error('enabled must be a boolean');
      setSetting(db, KEYS.enabled, input.enabled);
    }
    if (input.ownerEmail !== undefined) {
      if (typeof input.ownerEmail !== 'string') throw new Error('ownerEmail must be a string');
      const email = normalizeAddress(input.ownerEmail);
      if (email === '') {
        // Clear the override — the next run re-detects via get_profile.
        setSetting(db, KEYS.ownerEmail, '');
        setSetting(db, KEYS.ownerName, '');
      } else {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('ownerEmail must be a valid email address');
        setSetting(db, KEYS.ownerEmail, email);
      }
    }
    if (input.noiseSenders !== undefined) {
      if (!Array.isArray(input.noiseSenders) || !input.noiseSenders.every(entry => typeof entry === 'string')) {
        throw new Error('noiseSenders must be a string array');
      }
      const cleaned = [...new Set(
        input.noiseSenders.map(entry => entry.trim().toLowerCase()).filter(entry => entry.length >= 2 && entry.length <= 120),
      )].slice(0, 200);
      setSetting(db, KEYS.noiseSenders, cleaned);
    }
    return getStatus();
  }

  return {
    start(): void {
      if (timer || initialTimer) return;
      initialTimer = setTimeout(() => {
        initialTimer = null;
        void guardedRun();
      }, initialDelayMs);
      initialTimer.unref?.();
      timer = setInterval(() => { void guardedRun(); }, intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (initialTimer) { clearTimeout(initialTimer); initialTimer = null; }
      if (timer) { clearInterval(timer); timer = null; }
    },
    runNow: guardedRun,
    isRunning(): boolean {
      return running;
    },
    getStatus,
    updateConfig,
  };
}

/**
 * True for every browser-captured email item (the legacy scrape path —
 * Outlook Web, Gmail, and any future browser mail pattern). Once canonical
 * GRASP mail sync is live, browser email is redundant noise (user directive
 * 2026-08-18): scraped fragments of the same messages without reliable
 * addressing metadata.
 */
export function isBrowserEmailItem(item: RawWorkItem): boolean {
  return item.source === 'browser' && (item.type === 'email_read' || item.type === 'email_sent');
}

/**
 * Browser email capture is suppressed once canonical GRASP mail sync has
 * succeeded at least once and stays enabled. Cached briefly — this runs on the
 * hot capture path. Disabling the sync (grasp_sync.enabled=false) restores
 * browser email capture automatically.
 */
export function createBrowserEmailCaptureGate(db: Database.Database): () => boolean {
  let cached = false;
  let checkedAt = 0;
  return () => {
    const now = Date.now();
    if (now - checkedAt > 60_000) {
      cached = getSetting<boolean>(db, KEYS.enabled) !== false
        && getSetting<boolean>(db, KEYS.mailActive) === true;
      checkedAt = now;
    }
    return cached;
  };
}
