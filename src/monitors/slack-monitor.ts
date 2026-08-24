/**
 * Slack Monitor — real-time (Socket Mode) or token-only (polling) capture.
 *
 * Three-tier filter, keyed on Slack conversation ID against the watched set:
 *   (a) Watched DMs / group DMs → emitted immediately (high priority)
 *   (b) Watched channels        → emitted immediately (the 30-min batch was
 *       retired — see the note in the message handler)
 *   (c) Conversations not in the watched set → dropped (not stored)
 *
 * Capture modes (SLACK_CAPTURE_MODE=socket|poll, default auto):
 *   socket — Events API over Socket Mode; needs SLACK_APP_TOKEN and
 *            SLACK_USER_TOKEN. Instant delivery plus owner-reaction events,
 *            but Slack disables event delivery for apps that stop
 *            acknowledging (closed laptop), and one app cannot serve several
 *            users because events are load-balanced across connections.
 *   poll   — user-token-only pull loop (2026-08-18): every interval, page
 *            conversations.history since a durable per-conversation cursor
 *            for watched channels plus all auto-discovered DMs/group DMs,
 *            and catch up recently active threads. Survives the app being
 *            closed (the cursor simply waits), needs NO app-level token, and
 *            lets any number of teammates share one reviewed Slack app —
 *            each user token can only ever see that user's own view.
 *   auto   — socket when both tokens exist, poll when only the user token
 *            exists, disabled when there is no user token.
 *
 * History backfill: `backfillChannel(id)` pages conversations.history (plus
 * thread replies) and pushes old messages through the same buildItem/emit
 * path as live capture, deduped by permalink URL against work_items. Used
 * when a channel is newly added to the watched set, since live capture only
 * covers messages that arrive while the app runs.
 *
 * Config loaded from ~/.personal-productivity-tracker/.env:
 *   SLACK_APP_TOKEN=xapp-...   (socket mode only)
 *   SLACK_USER_TOKEN=xoxp-...
 *   SLACK_CAPTURE_MODE=poll    (optional; forces a mode)
 *   SLACK_POLL_INTERVAL_MS / SLACK_POLL_CALL_BUDGET (optional poll tuning)
 *
 * The watched-conversation set is populated from the database (app_settings)
 * by the caller; see slack-channel-config spec.
 */

import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import type { McpManager } from '../core/mcp-types.js';
import { createSlackMcpClient, type SlackMcpClient } from './slack-mcp-client.js';
import fs from 'fs';
import type Database from 'better-sqlite3';
import type { RawWorkItem } from '../core/types.js';
import { getChannelConfig } from '../core/slack-config.js';
import { getSetting, setSetting } from '../core/storage.js';

export interface SlackBackfillOptions {
  /** How many days of history to fetch (default 30). */
  oldestDays?: number;
  /** Hard cap on emitted-candidate messages incl. thread replies (default 500, keeps the newest). */
  maxMessages?: number;
}

export interface SlackBackfillResult {
  channelId: string;
  /** Eligible messages after live-path filtering (bots/subtypes dropped). */
  fetched: number;
  /** New items delivered to the pipeline. */
  emitted: number;
  /** Eligible messages already present (permalink match). */
  skipped: number;
  threadsFetched: number;
  error?: string;
}

export type SlackCaptureMode = 'socket' | 'poll' | 'mcp' | 'disabled';

export interface SlackMonitor {
  start(): Promise<void>;
  stop(): void;
  isConnected(): boolean;
  onWorkItem(handler: (item: RawWorkItem) => void): void;
  setWatchedChannels(ids: Iterable<string>): void;
  getWatchedChannels(): string[];
  // Optional so lightweight test doubles of the pre-backfill shape stay valid.
  backfillChannel?(channelId: string, opts?: SlackBackfillOptions): Promise<SlackBackfillResult>;
  backfillStatus?(): { inFlight: string[] };
  /** Active transport. Optional so pre-polling test doubles stay valid. */
  getCaptureMode?(): SlackCaptureMode;
}

/**
 * Read `~/.personal-productivity-tracker/.env` into a plain object.
 *
 * Exported so other startup code (e.g. `src/index.ts` building the Slack
 * `WebClient` for the channel-config bootstrap) can read the same env file
 * without duplicating the parsing logic.
 */
export function loadEnv(): Record<string, string> {
  const envPath = `${process.env.HOME}/.personal-productivity-tracker/.env`;
  const vars: Record<string, string> = {};
  try {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const match = line.match(/^([A-Z_]+)=(.+)$/);
      if (match) vars[match[1]] = match[2].trim();
    }
  } catch {}
  return vars;
}

/**
 * Resolve the capture transport. Socket mode needs both tokens; polling needs
 * only the user token, which is what makes one reviewed Slack app shareable
 * across teammates (each user token sees only that user's own conversations).
 */
export function resolveSlackCaptureMode(
  appToken: string,
  userToken: string,
  requested: string,
): SlackCaptureMode {
  if (!userToken) return 'disabled';
  const mode = requested.trim().toLowerCase();
  if (mode === 'poll') return 'poll';
  if (mode === 'socket') return appToken ? 'socket' : 'disabled';
  return appToken ? 'socket' : 'poll';
}

export function createSlackMonitor(deps: { db: Database.Database; mcpManager?: McpManager }): SlackMonitor {
  const env = loadEnv();
  const appToken = process.env.SLACK_APP_TOKEN || env.SLACK_APP_TOKEN || '';
  const userToken = process.env.SLACK_USER_TOKEN || env.SLACK_USER_TOKEN || '';
  const tokenMode = resolveSlackCaptureMode(
    appToken,
    userToken,
    process.env.SLACK_CAPTURE_MODE || env.SLACK_CAPTURE_MODE || '',
  );
  // The managed Slack MCP (built-in `slack` profile) is the preferred
  // transport: token-free polling through the owner's Amazon session
  // (migration decision 2026-08-21). With an MCP manager present, capture
  // polls and elects the MCP each cycle, falling back to the token WebClient
  // when the managed server is down. SLACK_CAPTURE_MODE=socket explicitly
  // restores token socket mode (real-time events + owner-reaction capture).
  const requestedMode = (process.env.SLACK_CAPTURE_MODE || env.SLACK_CAPTURE_MODE || '').trim().toLowerCase();
  const mcpClient: SlackMcpClient | null = deps.mcpManager
    ? createSlackMcpClient({ db: deps.db, mcpManager: deps.mcpManager })
    : null;
  const captureMode: SlackCaptureMode = mcpClient
    ? (requestedMode === 'socket' && tokenMode === 'socket' ? 'socket' : 'poll')
    : tokenMode;
  // True while the current poll/backfill work should go through the MCP.
  // Re-evaluated at every cycle start so a lapsed Midway session falls back
  // to the token route (when configured) or defers losslessly.
  let mcpTransportActive = false;
  const pollIntervalMs = Math.max(
    30_000,
    Number.parseInt(process.env.SLACK_POLL_INTERVAL_MS || env.SLACK_POLL_INTERVAL_MS || '', 10) || 90_000,
  );
  // History/replies/discovery calls allowed per cycle — Tier-3 politeness
  // (60 calls per 90s cycle ≈ 40/min sustained, under Slack's ~50/min tier).
  // Hot conversations beyond the budget carry over; dormant ones rotate.
  const pollCallBudget = Math.max(
    10,
    Number.parseInt(process.env.SLACK_POLL_CALL_BUDGET || env.SLACK_POLL_CALL_BUDGET || '', 10) || 60,
  );

  // Watched conversations — Slack conversation IDs (e.g. C012ABCDEF) for which
  // non-DM messages get buffered into the 30-minute batch. Populated later by
  // setWatchedChannels (task 3.2) / start() loading from the DB (task 3.3).
  let watchedConversations = new Set<string>();

  if (captureMode === 'disabled') {
    console.log('⚠️  Slack capture disabled — no Slack MCP manager and no usable token configuration');
    console.log('   Preferred: start the built-in Slack MCP connection. Token fallback: SLACK_USER_TOKEN (+ SLACK_APP_TOKEN for socket mode) in ~/.personal-productivity-tracker/.env');
    return {
      async start() {}, stop() {}, isConnected: () => false, onWorkItem() {}, setWatchedChannels() {}, getWatchedChannels: () => [],
      backfillChannel: async (channelId: string) => ({
        channelId, fetched: 0, emitted: 0, skipped: 0, threadsFetched: 0,
        error: 'Slack tokens not configured',
      }),
      backfillStatus: () => ({ inFlight: [] }),
      getCaptureMode: () => 'disabled',
    };
  }

  // The socket client exists only in socket mode. The WebClient exists only
  // when a user token is configured; MCP-only setups run tokenless.
  const socketClient = captureMode === 'socket' ? new SocketModeClient({ appToken }) : null;
  const webClient = userToken ? new WebClient(userToken) : null;
  const handlers: ((item: RawWorkItem) => void)[] = [];
  let connected = false;
  let batchTimer: ReturnType<typeof setInterval> | null = null;

  // Batch buffer for watched channels
  const batchBuffer: RawWorkItem[] = [];

  // Cache
  const userCache = new Map<string, { name: string; email?: string; tz?: string }>();
  const channelCache = new Map<string, { name: string; type: string }>();
  let myUserId: string | null = null;

  // ── Transport helpers ─────────────────────────────────────────────────
  // Every Slack read goes through one of these; they route to the MCP when
  // the managed server is active this cycle, else the token WebClient. The
  // response shapes are WebClient-compatible so all downstream logic is
  // transport-agnostic.

  function requireWebClient(): WebClient {
    if (!webClient) throw new Error('Slack transport unavailable: the Slack MCP server is not running and no user token is configured');
    return webClient;
  }

  async function fetchHistory(
    channelId: string,
    opts: { oldest?: string; limit?: number; cursor?: string },
  ): Promise<{ messages: any[]; nextCursor?: string }> {
    if (mcpTransportActive && mcpClient) {
      const page = await mcpClient.history(channelId, opts);
      return { messages: page.messages ?? [], nextCursor: page.response_metadata?.next_cursor };
    }
    const page: any = await requireWebClient().conversations.history({
      channel: channelId,
      ...(opts.oldest ? { oldest: opts.oldest } : {}),
      limit: opts.limit ?? 100,
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    });
    return { messages: page.messages ?? [], nextCursor: page.response_metadata?.next_cursor || undefined };
  }

  async function fetchReplies(
    channelId: string,
    threadTs: string,
    opts: { oldest?: string; limit?: number },
  ): Promise<{ messages: any[] }> {
    if (mcpTransportActive && mcpClient) {
      const page = await mcpClient.replies(channelId, threadTs);
      const oldestFloat = opts.oldest ? parseFloat(opts.oldest) : 0;
      return {
        messages: (page.messages ?? []).filter((m: any) => !oldestFloat || parseFloat(m?.ts ?? '0') > oldestFloat),
      };
    }
    const page: any = await requireWebClient().conversations.replies({
      channel: channelId,
      ts: threadTs,
      ...(opts.oldest ? { oldest: opts.oldest } : {}),
      limit: opts.limit ?? 100,
    });
    return { messages: page.messages ?? [] };
  }

  async function getMyUserId(): Promise<string> {
    if (myUserId) return myUserId;
    if (mcpTransportActive && mcpClient) {
      myUserId = await mcpClient.getSelfUserId();
      if (myUserId) return myUserId;
    }
    try {
      const auth = webClient ? await webClient.auth.test() : null;
      myUserId = (auth?.user_id as string) || '';
    } catch { myUserId = ''; }
    return myUserId || '';
  }

  async function resolveUser(userId: string): Promise<string> {
    return (await resolveUserProfile(userId)).name;
  }

  /** Resolved identity; MCP adds email/timezone for people extraction. */
  async function resolveUserProfile(userId: string): Promise<{ name: string; email?: string; tz?: string }> {
    if (userCache.has(userId)) return userCache.get(userId)!;
    try {
      let profile: { name: string; email?: string; tz?: string };
      if (mcpTransportActive && mcpClient) {
        const user = await mcpClient.userInfo(userId);
        profile = {
          name: user?.real_name || user?.name || userId,
          ...(user?.email ? { email: user.email } : {}),
          ...(user?.tz ? { tz: user.tz } : {}),
        };
      } else {
        const result = await requireWebClient().users.info({ user: userId });
        profile = { name: result.user?.real_name || result.user?.name || userId };
      }
      userCache.set(userId, profile);
      return profile;
    } catch { return { name: userId }; }
  }

  async function resolveChannel(channelId: string): Promise<{ name: string; type: string }> {
    if (channelCache.has(channelId)) return channelCache.get(channelId)!;
    try {
      let ch: any;
      if (mcpTransportActive && mcpClient) {
        ch = await mcpClient.channelInfo(channelId);
        if (!ch) return { name: channelId, type: 'unknown' };
      } else {
        const result = await requireWebClient().conversations.info({ channel: channelId });
        ch = result.channel as any;
      }
      const type = ch.is_im ? 'dm' : ch.is_mpim ? 'group_dm' : ch.is_private ? 'private_channel' : 'channel';
      const name = ch.name || (ch.is_im ? 'DM' : `group-${channelId.slice(-4)}`);
      const info = { name, type };
      channelCache.set(channelId, info);
      return info;
    } catch { return { name: channelId, type: 'unknown' }; }
  }

  function emit(item: RawWorkItem) {
    for (const h of handlers) h(item);
  }

  // ── Personal engagement capture ────────────────────────────────────────
  // Append-only record of the owner's own engagement (sent message, @-mention
  // of the owner, owner reaction, thread the owner is part of). Channel tiers
  // and routing gates derive from these rows deterministically. Best-effort:
  // an insert failure must never block message capture.
  type EngagementKind = 'sent' | 'mention' | 'reaction' | 'thread';

  function recordEngagement(
    channelId: string,
    kind: EngagementKind,
    messageTs: string,
    threadTs: string,
    occurredAt: string,
  ): void {
    if (!channelId) return;
    try {
      deps.db.prepare(
        'INSERT OR IGNORE INTO slack_engagement (channel_id, kind, message_ts, thread_ts, occurred_at) VALUES (?, ?, ?, ?, ?)',
      ).run(channelId, kind, messageTs, threadTs, occurredAt);
    } catch { /* engagement capture is best-effort */ }
  }

  function hasThreadEngagement(channelId: string, threadTs: string): boolean {
    if (!channelId || !threadTs) return false;
    try {
      return Boolean(deps.db.prepare(
        'SELECT 1 FROM slack_engagement WHERE channel_id = ? AND thread_ts = ? LIMIT 1',
      ).get(channelId, threadTs));
    } catch {
      return false;
    }
  }

  function setWatchedChannelsImpl(ids: Iterable<string>): void {
    // Single atomic JS reassignment — in-flight handlers see either the old
    // or new set, never partial state. Does NOT touch the SocketModeClient
    // connection (Events API delivery is unaffected).
    watchedConversations = new Set(ids);
    console.log(`[Slack] Watched set updated: ${watchedConversations.size} conversations`);
  }

  function flushBatch() {
    if (batchBuffer.length === 0) return;
    console.log(`[Slack] Flushing ${batchBuffer.length} batched channel messages`);
    for (const item of batchBuffer) emit(item);
    batchBuffer.length = 0;
  }

  async function buildItem(event: any): Promise<RawWorkItem | null> {
    const text = event.text || '';
    const userId = event.user || '';
    const channelId = event.channel || '';
    const ts = event.ts || '';

    const [userProfile, channelInfo] = await Promise.all([
      resolveUserProfile(userId),
      resolveChannel(channelId),
    ]);
    const userName = userProfile.name;

    const me = await getMyUserId();
    const direction = userId === me ? 'sent' : 'received';
    // Named group DMs carry their topic name so routing can anchor evidence
    // to the right project; auto-named ones (mpdm-…) stay person-labeled.
    const namedGroup = channelInfo.type === 'group_dm'
      && channelInfo.name
      && !channelInfo.name.startsWith('mpdm-')
      && !channelInfo.name.startsWith('group-');
    const title = channelInfo.type === 'dm' || (channelInfo.type === 'group_dm' && !namedGroup)
      ? `Slack DM with ${userName}`
      : namedGroup
        ? `Slack group: ${channelInfo.name}`
        : `Slack #${channelInfo.name}`;

    // Engagement flags — computed deterministically at capture so downstream
    // passes never have to infer personal relevance from message text.
    const threadTs = String(event.thread_ts || '');
    const mentionedMe = Boolean(me && new RegExp(`<@${me}(?:\\|[^>]*)?>`).test(text));
    const occurredAt = new Date(parseFloat(ts) * 1000 || Date.now()).toISOString();
    if (direction === 'sent') {
      recordEngagement(channelId, 'sent', ts, threadTs, occurredAt);
      if (threadTs) recordEngagement(channelId, 'thread', '', threadTs, occurredAt);
    }
    if (mentionedMe) recordEngagement(channelId, 'mention', ts, threadTs, occurredAt);
    const threadEngaged = Boolean(threadTs && (direction === 'sent' || hasThreadEngagement(channelId, threadTs)));
    const engaged = direction === 'sent' || mentionedMe || threadEngaged;

    const files = (event.files || []).map((f: any) => `[${f.filetype}] ${f.name}`).join(', ');
    const content = files ? `${text}\n\nAttachments: ${files}` : text;

    return {
      type: 'slack_message',
      source: 'slack',
      sourceApp: 'Slack',
      title,
      // Lossless capture: full message text, no cap (R1.1/R1.2). Attachment
      // *content* extraction is handled downstream by the extractor (task 4.2).
      content,
      url: `https://slack.com/archives/${channelId}/p${ts.replace('.', '')}`,
      metadata: {
        channelId, channelName: channelInfo.name, channelType: channelInfo.type,
        userId, userName, direction, timestamp: ts,
        // Enriched context (MCP transport): ISO timestamp for chronology and
        // resolved identity for people extraction. Additive — every existing
        // consumer of this metadata contract keeps working unchanged.
        timestampIso: occurredAt,
        ...(userProfile.email ? { userEmail: userProfile.email } : {}),
        ...(userProfile.tz ? { userTz: userProfile.tz } : {}),
        transport: mcpTransportActive ? 'mcp' : 'token',
        hasFiles: (event.files || []).length > 0 ? 'true' : 'false',
        threadTs,
        mentionedMe: mentionedMe ? 'true' : 'false',
        threadEngaged: threadEngaged ? 'true' : 'false',
        engaged: engaged ? 'true' : 'false',
      },
      capturedAt: new Date(parseFloat(ts) * 1000),
    };
  }

  // ── Attachment content capture (lossless-capture-brain-pipeline R1.4) ──
  // Downloads each Slack file to a stable local dir and delivers a separate
  // `document_capture` RawWorkItem whose metadata.filePath points at the file,
  // so the pipeline extractor parses/OCRs its FULL content downstream. The
  // parent message item still lists attachment names as a text preview.
  const attachmentDir = `${process.env.HOME}/.personal-productivity-tracker/slack-attachments`;

  /** Attachments above this size are recorded but not downloaded/parsed. */
  const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

  async function downloadAndDeliverAttachments(
    event: any,
    deliver: (item: RawWorkItem) => void,
  ): Promise<void> {
    const files = event.files || [];
    if (files.length === 0) return;
    const channelId = event.channel || '';
    const ts = event.ts || '';
    for (const f of files) {
      try {
        if (Number(f.size ?? 0) > ATTACHMENT_MAX_BYTES) {
          console.warn(`[Slack] attachment skipped (over ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB): ${f.name}`);
          continue;
        }
        fs.mkdirSync(attachmentDir, { recursive: true });
        const safeName = String(f.name || f.id || 'file').replace(/[^\w.\-]+/g, '_');
        let dest = `${attachmentDir}/${f.id || Date.now()}-${safeName}`;

        if (mcpTransportActive && mcpClient && f.id) {
          // MCP transport: the server downloads with the owner's session and
          // returns either a saved binary path or inline text content.
          const downloaded = await mcpClient.downloadFile(String(f.id));
          if (!downloaded) {
            console.warn(`[Slack] attachment download failed via MCP: ${f.name}`);
            continue;
          }
          if (downloaded.savedPath) {
            fs.copyFileSync(downloaded.savedPath, dest);
            try { fs.unlinkSync(downloaded.savedPath); } catch { /* temp cleanup is best-effort */ }
          } else if (downloaded.inlineText != null) {
            if (!/\.(txt|md|csv|json)$/i.test(dest)) dest = `${dest}.txt`;
            fs.writeFileSync(dest, downloaded.inlineText, 'utf8');
          } else {
            console.warn(`[Slack] attachment had no content via MCP: ${f.name}`);
            continue;
          }
        } else {
          const url = f.url_private_download || f.url_private;
          if (!url) continue;
          const resp = await fetch(url, { headers: { Authorization: `Bearer ${userToken}` } });
          if (!resp.ok) {
            console.warn(`[Slack] attachment download failed (${resp.status}): ${f.name}`);
            continue;
          }
          fs.writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
        }

        // The pipeline extractor parses by file type downstream:
        // document-parser for .pdf/.docx/.xlsx/.pptx/.txt/.md/.csv/.json,
        // OCR for images — the same path local-folder captures take.
        deliver({
          type: 'document_capture',
          source: 'slack',
          sourceApp: 'Slack',
          title: f.name || safeName,
          url: `https://slack.com/archives/${channelId}/p${String(ts).replace('.', '')}`,
          content: '', // extractor fills this from the downloaded file
          metadata: {
            filePath: dest,
            slackFileId: String(f.id || ''),
            mimetype: String(f.mimetype || ''),
            filetype: String(f.filetype || ''),
            channelId,
            transport: mcpTransportActive ? 'mcp' : 'token',
          },
          capturedAt: new Date(parseFloat(ts) * 1000 || Date.now()),
        });
      } catch (err: any) {
        console.warn(`[Slack] attachment error for ${f?.name}: ${err?.message ?? err}`);
      }
    }
  }

  // ── History backfill ──────────────────────────────────────────────────────
  // Socket Mode only delivers messages that arrive while the app runs, so a
  // newly watched channel starts empty. backfillChannel pulls recent history
  // through the SAME buildItem/emit path as live capture (same filtering,
  // enrichment, attachments) — downstream dedup/storage/routing is untouched.
  // Idempotent: a message's permalink URL is unique per (channel, ts), so
  // anything already in work_items is skipped and re-runs are safe.

  const backfillInFlight = new Set<string>();

  const permalinkFor = (channelId: string, ts: string) =>
    `https://slack.com/archives/${channelId}/p${ts.replace('.', '')}`;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function backfillChannelImpl(
    channelId: string,
    opts?: SlackBackfillOptions,
  ): Promise<SlackBackfillResult> {
    const result: SlackBackfillResult = { channelId, fetched: 0, emitted: 0, skipped: 0, threadsFetched: 0 };
    if (backfillInFlight.has(channelId)) {
      return { ...result, error: 'backfill already in progress for this channel' };
    }
    backfillInFlight.add(channelId);
    // API-triggered backfills can run outside a poll cycle — elect transport.
    if (mcpClient) mcpTransportActive = await mcpClient.isAvailable();
    const oldestDays = opts?.oldestDays ?? 30;
    const maxMessages = opts?.maxMessages ?? 500;
    const oldest = String(Date.now() / 1000 - oldestDays * 86400);
    const urlExists = deps.db.prepare('SELECT 1 FROM work_items WHERE url = ? LIMIT 1');

    try {
      // 1. Page through top-level history. Slack returns newest→oldest, so
      //    stopping at maxMessages keeps the most recent window.
      //    (@slack/web-api retries HTTP 429 with Retry-After automatically;
      //    the sleep between pages is Tier-3 politeness, not correctness.)
      const collected: any[] = [];
      let cursor: string | undefined;
      do {
        const page = await fetchHistory(channelId, { oldest, limit: 200, cursor });
        collected.push(...page.messages);
        cursor = page.nextCursor;
        if (cursor && collected.length < maxMessages) await sleep(300);
      } while (cursor && collected.length < maxMessages);

      // 2. Thread replies. conversations.replies echoes the parent as its
      //    first message — drop it to avoid double-processing. Reply failures
      //    degrade to top-level-only rather than failing the whole backfill.
      for (const parent of [...collected]) {
        if (collected.length >= maxMessages) break;
        if (!parent.reply_count || !parent.ts) continue;
        try {
          const rep = await fetchReplies(channelId, parent.ts, { limit: 100 });
          collected.push(...rep.messages.filter((m: any) => m.ts !== parent.ts));
          result.threadsFetched++;
          await sleep(300);
        } catch (err: any) {
          console.warn(`[Slack] backfill: replies fetch failed for ${channelId}/${parent.ts}: ${err?.message ?? err}`);
        }
      }

      // 3. Same exclusions as the live event handler; oldest-first so items
      //    land in natural timeline order; keep the NEWEST maxMessages.
      const eligible = collected
        .filter((m) => m.ts && !(m.subtype && m.subtype !== 'file_share') && !m.bot_id)
        .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))
        .slice(-maxMessages);
      result.fetched = eligible.length;

      // 4. Emit anything we don't already have. History messages carry no
      //    `channel` field (it's implied by the request) — inject it so
      //    buildItem / attachment download see a live-shaped event.
      for (const msg of eligible) {
        if (urlExists.get(permalinkFor(channelId, msg.ts))) {
          result.skipped++;
          continue;
        }
        const event = { ...msg, channel: channelId };
        const item = await buildItem(event);
        if (!item) {
          result.skipped++;
          continue;
        }
        emit(item);
        await downloadAndDeliverAttachments(event, emit);
        result.emitted++;
      }

      setSetting(deps.db, `slack.backfill.${channelId}`, {
        at: new Date().toISOString(),
        oldestDays,
        maxMessages,
        fetched: result.fetched,
        emitted: result.emitted,
        skipped: result.skipped,
        threadsFetched: result.threadsFetched,
      });
      console.log(
        `[Slack] Backfill ${channelId}: fetched=${result.fetched} emitted=${result.emitted} skipped=${result.skipped} threads=${result.threadsFetched}`,
      );
      return result;
    } catch (err: any) {
      // No completion marker on failure — a later PUT/manual run can retry.
      const message = err?.data?.error || err?.message || String(err);
      console.error(`[Slack] Backfill failed for ${channelId}: ${message}`);
      return { ...result, error: message };
    } finally {
      backfillInFlight.delete(channelId);
    }
  }

  // ── Polling mode ──────────────────────────────────────────────────────────
  // User-token-only capture (2026-08-18). Each cycle pages history since a
  // durable per-conversation cursor for every watched channel plus every
  // auto-discovered DM/group DM, catches up recently active threads, and
  // emits through the SAME buildItem/dedup path as socket capture. A closed
  // laptop is a non-event: the cursor waits, and the next launch pulls what
  // was missed — unlike Events API delivery, nothing gets disabled by Slack.
  // Owner-reaction events are a socket-only extra; sent/mention/thread
  // engagement still records here because buildItem computes it per message.

  const pollCursorKey = (channelId: string) => `slack.poll.cursor.${channelId}`;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  let pollCycleCount = 0;
  let pollCarryover: string[] = [];
  let lastPollError = '';

  const eligibleHistoryMessage = (m: any): boolean =>
    Boolean(m?.ts && !(m.subtype && m.subtype !== 'file_share') && !m.bot_id);

  async function emitHistoryMessage(channelId: string, msg: any, urlExists: any): Promise<boolean> {
    if (urlExists.get(permalinkFor(channelId, msg.ts))) return false;
    const event = { ...msg, channel: channelId };
    const item = await buildItem(event);
    if (!item) return false;
    emit(item);
    await downloadAndDeliverAttachments(event, emit);
    return true;
  }

  /** DMs and group DMs the user is in — the poll-mode analog of socket mode's
   * "DMs are personal by definition" rule. A long Slack tenure can hold many
   * hundreds of mostly dormant conversations, so enumeration is cheap paging
   * (≤6 calls) while HISTORY polling is tiered (hot set + slow rotation). */
  async function discoverDirectConversations(): Promise<{ ids: string[]; calls: number }> {
    const ids: string[] = [];
    let calls = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 6; page++) {
      let channels: any[];
      let nextCursor: string | undefined;
      if (mcpTransportActive && mcpClient) {
        const resp = await mcpClient.listConversations(['dm', 'group_dm'], { limit: 200, ...(cursor ? { cursor } : {}) });
        channels = resp.channels;
        nextCursor = resp.response_metadata?.next_cursor;
      } else {
        const resp: any = await requireWebClient().users.conversations({
          types: 'im,mpim', exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}),
        });
        channels = resp.channels ?? [];
        nextCursor = resp.response_metadata?.next_cursor || undefined;
      }
      calls++;
      for (const conversation of channels) {
        if (conversation?.id && !conversation.is_user_deleted && !conversation.is_archived) ids.push(conversation.id);
      }
      cursor = nextCursor;
      if (!cursor) break;
    }
    return { ids, calls };
  }

  // Hot set: conversations with captured activity in the last 7 days are
  // polled EVERY cycle. It derives from work_items itself, so it needs no
  // separate bookkeeping, survives restarts, carries over from socket-mode
  // history, and any rotation hit that emits a message promotes that
  // conversation automatically. Dormant conversations rotate through the
  // leftover call budget with a persisted position.
  const hotConversationsQuery = deps.db.prepare(`
    SELECT DISTINCT json_extract(metadata, '$.channelId') AS ch
    FROM work_items
    WHERE source = 'slack' AND datetime(captured_at) > datetime('now', '-7 days')
  `);

  function hotConversations(): Set<string> {
    try {
      return new Set(
        (hotConversationsQuery.all() as { ch: string | null }[])
          .map(row => row.ch ?? '')
          .filter(Boolean),
      );
    } catch {
      return new Set();
    }
  }

  /**
   * Pull one conversation forward from its cursor. Returns API calls used.
   * The cursor advances only after every new message in this conversation is
   * fully processed; a crash re-lists from the old cursor and the permalink
   * dedup absorbs the overlap.
   */
  async function pollConversation(channelId: string, threadScanDue: boolean): Promise<number> {
    let calls = 0;
    const cursorKey = pollCursorKey(channelId);
    const cursor = getSetting<string>(deps.db, cursorKey);
    if (!cursor) {
      // First sight: live-start semantics — capture from now. The one-time
      // DM context backfill is queued by the cycle loop, bounded per cycle,
      // so a fresh machine with many DMs cannot stampede the rate limits.
      setSetting(deps.db, cursorKey, (Date.now() / 1000).toFixed(6));
      return calls;
    }

    const urlExists = deps.db.prepare('SELECT 1 FROM work_items WHERE url = ? LIMIT 1');
    const cursorFloat = parseFloat(cursor);
    let maxSeen = cursorFloat;
    const fresh: any[] = [];

    // 1. New top-level messages since the cursor (bounded paging).
    let pageCursor: string | undefined;
    for (let page = 0; page < 2; page++) {
      const resp = await fetchHistory(channelId, { oldest: cursor, limit: 100, cursor: pageCursor });
      calls++;
      fresh.push(...resp.messages);
      pageCursor = resp.nextCursor;
      if (!pageCursor) break;
    }
    const newMessages = fresh
      .filter(eligibleHistoryMessage)
      .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

    // 2. Thread catch-up. Replies never appear in history, so scan recent
    //    parents for reply activity past the cursor — on activity, or on the
    //    periodic sweep cycle. Bounded to three threads per conversation.
    const threadReplies: any[] = [];
    if (threadScanDue || newMessages.length > 0) {
      const recent = await fetchHistory(channelId, { limit: 25 });
      calls++;
      const activeParents = recent.messages
        .filter((m: any) => m?.ts && m.reply_count > 0 && parseFloat(m.latest_reply || '0') > cursorFloat)
        .slice(0, 3);
      for (const parent of activeParents) {
        try {
          const rep = await fetchReplies(channelId, parent.ts, { oldest: cursor, limit: 100 });
          calls++;
          threadReplies.push(...rep.messages.filter(
            (m: any) => m.ts !== parent.ts && parseFloat(m.ts) > cursorFloat && eligibleHistoryMessage(m),
          ));
        } catch { /* thread catch-up degrades to top-level-only */ }
      }
    }

    // 3. Emit oldest-first through the shared path, then advance the cursor.
    const batch = [...newMessages, ...threadReplies]
      .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
    let emitted = 0;
    for (const msg of batch) {
      if (await emitHistoryMessage(channelId, msg, urlExists)) emitted++;
      if (parseFloat(msg.ts) > maxSeen) maxSeen = parseFloat(msg.ts);
    }
    if (maxSeen > cursorFloat) setSetting(deps.db, cursorKey, maxSeen.toFixed(6));
    if (emitted > 0) console.log(`[Slack] poll: ${emitted} new message(s) from ${channelId}`);
    return calls;
  }

  async function pollCycle(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      pollCycleCount++;
      // Transport election, once per cycle: the managed Slack MCP when its
      // server is running, else the token WebClient, else defer losslessly
      // (cursors only advance after successful processing).
      mcpTransportActive = Boolean(mcpClient && await mcpClient.isAvailable());
      if (!mcpTransportActive && !webClient) {
        throw new Error('no active transport — start the Slack MCP connection (or configure a user token)');
      }
      // Full thread sweep every 5th cycle — never the first after a start,
      // which must stay cheap so catch-up after downtime lands immediately.
      const threadScanDue = pollCycleCount % 5 === 0;
      let budget = pollCallBudget;

      const discovery = await discoverDirectConversations();
      budget -= discovery.calls;
      const hot = hotConversations();

      // Tier 1, polled every cycle: carryover from a budget-capped cycle,
      // then hot DMs/group DMs (personal by definition — same priority rule
      // as socket mode), then watched channels.
      const tierOne = [...new Set([
        ...pollCarryover,
        ...discovery.ids.filter(id => hot.has(id)),
        ...watchedConversations,
      ])];
      pollCarryover = [];
      for (let index = 0; index < tierOne.length; index++) {
        if (budget <= 0) {
          pollCarryover = tierOne.slice(index);
          break;
        }
        const channelId = tierOne[index];
        try {
          budget -= await pollConversation(channelId, threadScanDue);
        } catch (err: any) {
          // One broken conversation must not stall the rest of the cycle.
          console.warn(`[Slack] poll failed for ${channelId}: ${err?.data?.error || err?.message || err}`);
        }
      }

      // Tier 2, slow rotation: dormant DMs/group DMs take the leftover budget
      // from a persisted position, so a large old DM list still gets swept
      // completely every few dozen cycles. A rotation hit that captures a
      // message promotes the conversation into the hot tier automatically.
      const cold = discovery.ids.filter(id => !hot.has(id) && !watchedConversations.has(id));
      if (cold.length > 0 && budget > 0) {
        let position = (getSetting<number>(deps.db, 'slack.poll.rotation') ?? 0) % cold.length;
        let visited = 0;
        while (budget > 0 && visited < cold.length) {
          const channelId = cold[position];
          position = (position + 1) % cold.length;
          visited++;
          try {
            budget -= await pollConversation(channelId, false);
          } catch (err: any) {
            console.warn(`[Slack] poll failed for ${channelId}: ${err?.data?.error || err?.message || err}`);
          }
        }
        setSetting(deps.db, 'slack.poll.rotation', position);
      }

      // One-time DM context backfills, SEQUENTIAL and capped per cycle — the
      // poll analog of socket mode's backfill-on-first-DM-message. Only HOT
      // conversations qualify (dormant DMs backfill when they next show
      // activity via rotation), exactly matching socket semantics where the
      // backfill trigger is an arriving message.
      let backfillsStarted = 0;
      for (const channelId of discovery.ids.filter(id => hot.has(id))) {
        if (backfillsStarted >= 2) break;
        if (backfillInFlight.has(channelId) || getSetting(deps.db, `slack.backfill.${channelId}`)) continue;
        backfillsStarted++;
        await backfillChannelImpl(channelId).catch(() => { /* best-effort */ });
      }

      connected = true;
      lastPollError = '';
    } catch (err: any) {
      connected = false;
      const message = String(err?.data?.error || err?.message || err);
      if (message !== lastPollError) {
        console.warn(`[Slack] poll cycle failed: ${message}`);
        lastPollError = message;
      }
    } finally {
      polling = false;
    }
  }

  return {
    async start(): Promise<void> {
      // Load the watched conversation IDs from app_settings before subscribing
      // to events so the very first message is filtered against the persisted
      // configuration. Never reads SLACK_WATCHED_CHANNELS directly.
      setWatchedChannelsImpl(getChannelConfig(deps.db));

      if (captureMode === 'poll' || !socketClient) {
        await pollCycle(); // seeds first-sight cursors and proves the token
        pollTimer = setInterval(() => { void pollCycle(); }, pollIntervalMs);
        pollTimer.unref?.();
        console.log(`✅ Slack polling mode active (user token only, every ${Math.round(pollIntervalMs / 1000)}s)`);
        return;
      }

      // Debug: log ALL events to see what's coming through
      socketClient.on('slack_event', async ({ ack, body }) => {
        await ack();
        console.log(`[Slack] raw event type=${body?.event?.type || body?.type || 'unknown'}, subtype=${body?.event?.subtype || 'none'}`);
      });

      socketClient.on('message', async ({ event, ack }) => {
        await ack();

        // Skip bot messages, edits, system messages
        if (event.subtype && event.subtype !== 'file_share') return;
        if (event.bot_id) return;

        const channelId = event.channel || '';

        // Conversation filter:
        //   - DMs and group DMs are ALWAYS captured — they are personal by
        //     definition and never require manual subscription.
        //   - Channels require membership in the watched set.
        const watched = watchedConversations.has(channelId);
        let isDm = event.channel_type === 'im' || event.channel_type === 'mpim';
        if (!watched && !isDm) {
          // Known non-DM types drop without an API call; unknown payload
          // shapes resolve once (cached) to catch DMs missing channel_type.
          if (event.channel_type === 'channel' || event.channel_type === 'group') return;
          const info = await resolveChannel(channelId);
          isDm = info.type === 'dm' || info.type === 'group_dm';
          if (!isDm) return;
        }

        const item = await buildItem(event);
        if (!item) return;

        // First sight of a DM conversation: pull its recent history once so
        // the discussion's past context lands too (marker prevents repeats).
        if (isDm && !backfillInFlight.has(channelId)
          && !getSetting(deps.db, `slack.backfill.${channelId}`)) {
          void backfillChannelImpl(channelId).catch(() => { /* best-effort */ });
        }

        // Emit immediately for DMs and watched channels alike. The previous
        // 30-minute channel batch delayed capture by up to 30 min and — since
        // the buffer is in-memory — lost messages on restart/disconnect. For a
        // personal tracker, immediate capture is more useful and restart-safe;
        // downstream routing is already batched, so volume is handled there.
        emit(item);
        await downloadAndDeliverAttachments(event, emit);
      });

      // Owner reactions are engagement, even without a captured message row.
      socketClient.on('reaction_added', async ({ event, ack }: any) => {
        await ack();
        try {
          const me = await getMyUserId();
          if (!me || event?.user !== me) return;
          const channelId = event?.item?.channel || '';
          if (!channelId || !watchedConversations.has(channelId)) return;
          const messageTs = String(event?.item?.ts || '');
          const occurredAt = new Date(parseFloat(event?.event_ts) * 1000 || Date.now()).toISOString();
          recordEngagement(channelId, 'reaction', messageTs, '', occurredAt);
        } catch { /* engagement capture is best-effort */ }
      });

      socketClient.on('connected', () => {
        connected = true;
        console.log('✅ Slack Socket Mode connected');
      });

      socketClient.on('disconnected', () => {
        connected = false;
        console.log('⚠️  Slack Socket Mode disconnected');
      });

      // Batch flush timer — every 30 minutes
      batchTimer = setInterval(() => flushBatch(), 30 * 60 * 1000);

      try {
        await socketClient.start();
      } catch (err: any) {
        console.error('❌ Slack Socket Mode failed:', err.message);
        connected = false;
      }
    },

    stop(): void {
      flushBatch(); // flush remaining before shutdown
      if (batchTimer) { clearInterval(batchTimer); batchTimer = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      try { socketClient?.disconnect(); } catch {}
      connected = false;
    },

    isConnected: () => connected,

    onWorkItem(handler: (item: RawWorkItem) => void): void {
      handlers.push(handler);
    },

    setWatchedChannels(ids: Iterable<string>): void {
      setWatchedChannelsImpl(ids);
    },

    getWatchedChannels(): string[] {
      return [...watchedConversations];
    },

    backfillChannel: backfillChannelImpl,

    backfillStatus: () => ({ inFlight: [...backfillInFlight] }),

    // 'mcp' when the managed MCP carried the last cycle; the configured mode
    // otherwise. The Connections UI shows this as the live transport.
    getCaptureMode: () => (mcpTransportActive ? 'mcp' : captureMode),
  };
}
