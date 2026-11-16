/**
 * Chat notices (MIDWAY_NOTICES_PLAN.md §6, docs/maps/chat-notices.md): BotBoy's own status rows in the chat — a sign-in problem,
 * a terminal that ended, a part of the app that did not start, a dashboard refresh that failed. A notice is a chat row whose
 * `notice_json` holds a small structured record the panel draws as one compact line (title, labels, next step, details on
 * demand); `content` keeps a short plain sentence for every other reader (history tools, search, exports).
 *
 * Everything in a notice is written by BotBoy's code, never by a model: the words are fixed, the labels are names of
 * connections or states, and the details are sanitized (URLs reduced to their host, secrets redacted, bounded).
 */
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { sanitizeCaptureReason } from './capture-health.js';
import { redactSensitiveText } from './prompt-redaction.js';

/** Which story a notice belongs to: consecutive notices of one topic fold into one bubble in the panel. */
export type ChatNoticeTopic = 'midway' | 'connection' | 'terminal' | 'startup' | 'dashboard-refresh' | 'sharepoint-write';
export type ChatNoticeState = 'open' | 'resolved' | 'info';
export type ChatNoticeSeverity = 'error' | 'warning' | 'info' | 'success';
/** What the notice's one button does. Only code-owned kinds; the panel maps each to a fixed owner control. */
export type ChatNoticeActionKind = 'midway_reauth' | 'open_route';

export interface ChatNoticeAction {
  kind: ChatNoticeActionKind;
  label: string;
  /** For open_route: an in-app hash route (#/connections/…). */
  route?: string;
}

export interface ChatNotice {
  v: 1;
  /** Which notices fold together in the panel ("midway", "connection:slack"); defaults to the topic. */
  key: string;
  topic: ChatNoticeTopic;
  state: ChatNoticeState;
  severity: ChatNoticeSeverity;
  /** A few words: what happened ("Midway sign-in needed"). */
  title: string;
  /** Short chips: the connections or states involved ("GRASP", "Slack"). */
  labels: string[];
  /** One line: the one thing to do, or what BotBoy is doing. */
  next?: string;
  /** The facts, shown only when the notice is opened. Markdown is allowed for long diagnostics. */
  detail?: string;
  /** Detail is Markdown (a dashboard diagnosis); otherwise plain text. */
  detailMarkdown?: boolean;
  action?: ChatNoticeAction;
}

export type ChatNoticeInput = Omit<ChatNotice, 'v' | 'labels' | 'key'> & { labels?: string[]; key?: string };

const TOPICS: ReadonlySet<string> = new Set(['midway', 'connection', 'terminal', 'startup', 'dashboard-refresh', 'sharepoint-write']);
const STATES: ReadonlySet<string> = new Set(['open', 'resolved', 'info']);
const SEVERITIES: ReadonlySet<string> = new Set(['error', 'warning', 'info', 'success']);
const ACTIONS: ReadonlySet<string> = new Set(['midway_reauth', 'open_route']);
const IN_APP_ROUTE = /^#\/[A-Za-z0-9._~%=?&:+\/-]{1,200}$/;
const NOTICE_KEY = /^[a-z0-9][a-z0-9:_.-]{0,79}$/i;
const MAX_TITLE = 60;
const MAX_LABEL = 28;
const MAX_LABELS = 6;
const MAX_NEXT = 160;
const MAX_DETAIL = 1_200;
const MAX_DETAIL_MARKDOWN = 6_000;

const oneLine = (value: unknown, max: number): string =>
  redactSensitiveText(String(value ?? '')).replace(/\s+/g, ' ').trim().slice(0, max).trim();

/** Validates and bounds a notice; anything malformed becomes null (the row then reads as its plain sentence). */
export function normalizeChatNotice(input: unknown): ChatNotice | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const topic = String(raw.topic ?? '');
  const state = String(raw.state ?? '');
  const severity = String(raw.severity ?? '');
  const title = oneLine(raw.title, MAX_TITLE);
  if (!TOPICS.has(topic) || !STATES.has(state) || !SEVERITIES.has(severity) || !title) return null;
  const labels = [...new Set((Array.isArray(raw.labels) ? raw.labels : [])
    .map(label => oneLine(label, MAX_LABEL))
    .filter(Boolean))].slice(0, MAX_LABELS);
  const next = oneLine(raw.next, MAX_NEXT);
  const detailMarkdown = raw.detailMarkdown === true;
  const detail = detailMarkdown
    ? redactSensitiveText(String(raw.detail ?? '')).trim().slice(0, MAX_DETAIL_MARKDOWN)
    : sanitizeDetail(raw.detail);
  let action: ChatNoticeAction | undefined;
  if (raw.action && typeof raw.action === 'object') {
    const candidate = raw.action as Record<string, unknown>;
    const kind = String(candidate.kind ?? '');
    const label = oneLine(candidate.label, 32);
    const route = typeof candidate.route === 'string' ? candidate.route.trim() : '';
    if (ACTIONS.has(kind) && label && (kind !== 'open_route' || IN_APP_ROUTE.test(route))) {
      action = { kind: kind as ChatNoticeActionKind, label, ...(kind === 'open_route' ? { route } : {}) };
    }
  }
  const key = typeof raw.key === 'string' && NOTICE_KEY.test(raw.key.trim()) ? raw.key.trim() : topic;
  return {
    v: 1,
    key,
    topic: topic as ChatNoticeTopic,
    state: state as ChatNoticeState,
    severity: severity as ChatNoticeSeverity,
    title,
    labels,
    ...(next ? { next } : {}),
    ...(detail ? { detail } : {}),
    ...(detail && detailMarkdown ? { detailMarkdown: true } : {}),
    ...(action ? { action } : {}),
  };
}

/** Plain detail: each line sanitized like a capture reason (URLs to their host, secrets redacted), bounded. */
function sanitizeDetail(value: unknown): string {
  const lines = String(value ?? '').split('\n')
    .map(line => sanitizeCaptureReason(line))
    .filter(Boolean);
  return lines.join('\n').slice(0, MAX_DETAIL);
}

/** The plain sentence a notice row carries for readers that are not the panel. */
export function noticeSentence(notice: ChatNotice): string {
  const labels = notice.labels.length ? ` (${notice.labels.join(', ')})` : '';
  return `${notice.title}${labels}.${notice.next ? ` ${notice.next}` : ''}`;
}

/** Parses a stored notice; a damaged value is ignored (the row shows its sentence). */
export function parseChatNotice(json: string | null | undefined): ChatNotice | null {
  if (!json) return null;
  try {
    return normalizeChatNotice(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * Writes one notice row to the main chat (or a job's thread) and returns its id, or null when the notice is malformed or the
 * write fails (a notice must never break the code that posts it).
 */
export function postChatNotice(db: Database.Database, input: ChatNoticeInput, options: { jobId?: string } = {}): string | null {
  const notice = normalizeChatNotice({ ...input, v: 1 });
  if (!notice) return null;
  const id = `notice-${Date.now()}-${randomBytes(4).toString('hex')}`;
  try {
    db.prepare('INSERT INTO chat_messages (id, role, content, notice_json, job_id) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'assistant', noticeSentence(notice), JSON.stringify(notice), options.jobId ?? null);
    return id;
  } catch (error: any) {
    console.warn(`[ChatNotice] could not post "${notice.title}": ${error?.message ?? error}`);
    return null;
  }
}
