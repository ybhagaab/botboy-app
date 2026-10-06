/**
 * Capture health: is each enabled source still delivering evidence?
 *
 * Process liveness says nothing about outcomes. SharePoint discovery failed
 * every 30 minutes for days while its MCP server answered pings and stayed
 * "running" (the server had started prefixing its JSON with a trust notice),
 * and Slack polls received per-conversation Midway errors inside successful
 * tool results. Nobody was told.
 *
 * Each capture source reports the outcome of every run here. A failure
 * streak that lasts past the source's threshold becomes an owner-facing
 * issue naming the cause and the next action. Classification is
 * deterministic (error text patterns); no model is involved.
 *
 * State is kept in memory and persisted to one settings key on meaningful
 * changes, so "failing since" and "last success" survive a restart.
 */

import type Database from 'better-sqlite3';
import { getSetting, setSetting } from './storage.js';
import { redactSensitiveText } from './prompt-redaction.js';

export type CaptureSourceId = 'slack' | 'sharepoint' | 'grasp' | 'gmail';

export type CaptureFailureKind =
  | 'midway_auth'
  | 'service_auth'
  | 'rate_limited'
  | 'network'
  | 'connector_down'
  | 'unexpected_response'
  | 'unknown';

export interface CaptureFailure {
  kind: CaptureFailureKind;
  reason: string;
}

export interface CaptureSourceHealth {
  source: CaptureSourceId;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** First failure of the current streak; null while healthy. */
  failingSince: string | null;
  consecutiveFailures: number;
  kind: CaptureFailureKind | null;
  reason: string | null;
}

export interface CaptureHealthIssue {
  source: CaptureSourceId;
  name: string;
  kind: CaptureFailureKind;
  /** Owner-facing cause, one short sentence. */
  cause: string;
  nextAction: string;
  since: string;
  lastSuccessAt: string | null;
  failures: number;
  /** Sanitized technical detail (no URLs, no secrets). */
  reason: string;
  /** UI route of the source's settings page. */
  href: string;
}

export interface CaptureHealth {
  reportSuccess(source: CaptureSourceId): void;
  reportFailure(source: CaptureSourceId, failure: CaptureFailure): void;
  /** Sources whose failure streak crossed their warning threshold. */
  issues(): CaptureHealthIssue[];
  sources(): CaptureSourceHealth[];
  /** In-memory counter that changes whenever the issue set changes. */
  version(): number;
  /**
   * True while this source's current streak is an explicit Midway re-auth
   * demand last reported after `reportedAfterMs` (epoch ms). The sentinel
   * passes its last recovery time so a stale report cannot reopen an episode
   * before the source has polled again.
   */
  needsMidwayReauth(source: CaptureSourceId, reportedAfterMs?: number): boolean;
}

const SETTING_KEY = 'capture_health.v1';
const SOURCES: readonly CaptureSourceId[] = ['slack', 'sharepoint', 'grasp', 'gmail'];

const SOURCE_NAMES: Record<CaptureSourceId, string> = {
  slack: 'Slack',
  sharepoint: 'SharePoint documents',
  grasp: 'Outlook mail & calendar',
  gmail: 'Gmail',
};

const SOURCE_HREFS: Record<CaptureSourceId, string> = {
  slack: '#/connections/slack',
  sharepoint: '#/connections/document-sync',
  grasp: '#/connections/mail-calendar-sync',
  gmail: '#/connections/gmail-sync',
};

/**
 * Warn once a streak has both this many failed runs and this much age. The
 * ages match each source's cadence (Slack 90 s, GRASP and Gmail 5 min,
 * SharePoint 30 min), so one transient failure never raises a warning.
 */
const WARN_AFTER: Record<CaptureSourceId, { failures: number; ms: number }> = {
  slack: { failures: 2, ms: 5 * 60_000 },
  grasp: { failures: 2, ms: 10 * 60_000 },
  gmail: { failures: 2, ms: 10 * 60_000 },
  sharepoint: { failures: 2, ms: 25 * 60_000 },
};

/** A successful run refreshes the persisted "last success" at most this often. */
const SUCCESS_PERSIST_INTERVAL_MS = 15 * 60_000;

const CAUSES: Record<CaptureFailureKind, string> = {
  midway_auth: 'Your Midway session expired',
  service_auth: 'The service rejected BotBoy’s sign-in',
  rate_limited: 'The service asked BotBoy to slow down',
  network: 'The service or network is not reachable',
  connector_down: 'The connection is not running',
  unexpected_response: 'The connection answered in a format BotBoy can’t read',
  unknown: 'Capture keeps failing',
};

function nextActionFor(source: CaptureSourceId, kind: CaptureFailureKind): string {
  switch (kind) {
    case 'midway_auth':
      return 'Run mwinit. BotBoy opens a terminal for it in chat; capture catches up on its own afterwards.';
    case 'service_auth':
      if (source === 'sharepoint') {
        return 'BotBoy refreshes the SharePoint sign-in on its own. If this persists, run mwinit and restart the SharePoint connection.';
      }
      if (source === 'grasp') {
        // GRASP mints its token from Midway: after mwinit it signs back in on
        // its next sync with no restart (live 2026-10-03). Its own message
        // names grasp-mcp login for a token that mwinit cannot renew.
        return 'Run mwinit; mail sync signs back in on its next run. If it still fails after that, run grasp-mcp login in a terminal.';
      }
      if (source === 'gmail') {
        // OAuth, not Midway: Google ended the grant (revoked, expired after
        // 7 days in a Testing-mode app, or a password change).
        return 'Open Connections → Gmail and choose Reconnect. Google ended BotBoy’s access; captured mail is kept.';
      }
      return `Restart the ${SOURCE_NAMES[source]} connection. If that doesn’t help, run mwinit.`;
    case 'rate_limited':
      return 'Nothing to do: BotBoy slows down and retries.';
    case 'network':
      return 'Check your network or VPN. BotBoy retries automatically.';
    case 'connector_down':
      return 'Open the connection page and start the connection.';
    case 'unexpected_response':
      return 'This usually follows a connector update. Update BotBoy (./start.sh --update); if it continues, report it.';
    default:
      return 'Open the connection page to see the last error.';
  }
}

/**
 * Deterministic failure classification from error text. Midway comes first:
 * its message also carries a 401, and it has the one fix the owner must run.
 */
export function classifyCaptureFailure(message: string): CaptureFailureKind {
  const text = String(message ?? '');
  if (/mwinit|authenticationRequired|Request to IDP URL|midway[^\n]{0,80}\b(?:401|expired|authenticat|session)/i.test(text)) {
    return 'midway_auth';
  }
  if (/ratelimited|rate[ -]?limit|\b429\b|too many requests|throttl/i.test(text)) return 'rate_limited';
  if (/invalid_auth|not_authed|token_expired|token_revoked|account_inactive|invalid_grant|invalid_client|unauthorized_client|invalid_token|AADSTS\d+|silent authorize|\b401\b|unauthori[sz]ed|unauthenticated|authentication failed|session has expired|no valid tokens|\b403\b|forbidden/i.test(text)) {
    return 'service_auth';
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|getaddrinfo|socket hang up|fetch failed|network error|network is unreachable|status(?: code)? 5\d\d\b|\b50[234]\b|timed? ?out|timeout/i.test(text)) {
    return 'network';
  }
  if (/no active transport|not running|is not installed|profile (?:missing|stopped|failed|degraded|needs_configuration)|connection closed|transport (?:closed|unavailable)/i.test(text)) {
    return 'connector_down';
  }
  if (/non-JSON|not JSON|unexpected token|unreadable|malformed|unexpected (?:batch )?response|profile incompatible/i.test(text)) {
    return 'unexpected_response';
  }
  return 'unknown';
}

/** Owner-safe technical detail: URLs reduced to their host, secrets redacted. */
export function sanitizeCaptureReason(message: string): string {
  const withoutUrls = String(message ?? '').replace(/\bhttps?:\/\/([^\s/"'<>]+)[^\s"'<>]*/gi, '<$1>');
  return redactSensitiveText(withoutUrls).replace(/\s+/g, ' ').trim().slice(0, 240);
}

function emptyHealth(source: CaptureSourceId): CaptureSourceHealth {
  return {
    source,
    lastSuccessAt: null,
    lastFailureAt: null,
    failingSince: null,
    consecutiveFailures: 0,
    kind: null,
    reason: null,
  };
}

function isKind(value: unknown): value is CaptureFailureKind {
  return typeof value === 'string' && value in CAUSES;
}

function loadPersisted(db: Database.Database): Map<CaptureSourceId, CaptureSourceHealth> {
  const entries = new Map<CaptureSourceId, CaptureSourceHealth>();
  for (const source of SOURCES) entries.set(source, emptyHealth(source));
  let stored: Record<string, Partial<CaptureSourceHealth>> | null = null;
  try {
    stored = getSetting<Record<string, Partial<CaptureSourceHealth>>>(db, SETTING_KEY);
  } catch {
    stored = null;
  }
  if (!stored || typeof stored !== 'object') return entries;
  for (const source of SOURCES) {
    const raw = stored[source];
    if (!raw || typeof raw !== 'object') continue;
    const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
    const failures = Number(raw.consecutiveFailures);
    entries.set(source, {
      source,
      lastSuccessAt: text(raw.lastSuccessAt),
      lastFailureAt: text(raw.lastFailureAt),
      failingSince: text(raw.failingSince),
      consecutiveFailures: Number.isInteger(failures) && failures > 0 ? failures : 0,
      kind: isKind(raw.kind) ? raw.kind : null,
      reason: text(raw.reason),
    });
  }
  return entries;
}

export function createCaptureHealth(deps: { db: Database.Database; now?: () => number }): CaptureHealth {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const entries = loadPersisted(db);
  const lastSuccessPersistAt = new Map<CaptureSourceId, number>();
  let counter = 0;
  let lastSignature = '';

  function persist(): void {
    const value: Record<string, CaptureSourceHealth> = {};
    for (const [source, entry] of entries) value[source] = entry;
    try {
      setSetting(db, SETTING_KEY, value);
    } catch (error) {
      console.warn(`[CaptureHealth] could not persist capture health: ${(error as Error)?.message ?? error}`);
    }
  }

  function entryFor(source: CaptureSourceId): CaptureSourceHealth {
    let entry = entries.get(source);
    if (!entry) {
      entry = emptyHealth(source);
      entries.set(source, entry);
    }
    return entry;
  }

  function isIssue(entry: CaptureSourceHealth, at: number): boolean {
    if (!entry.failingSince || entry.consecutiveFailures <= 0 || !entry.kind) return false;
    // Midway says exactly what to do; there is nothing to wait for.
    if (entry.kind === 'midway_auth') return true;
    const threshold = WARN_AFTER[entry.source];
    const age = at - Date.parse(entry.failingSince);
    return entry.consecutiveFailures >= threshold.failures && Number.isFinite(age) && age >= threshold.ms;
  }

  function issues(): CaptureHealthIssue[] {
    const at = now();
    const out: CaptureHealthIssue[] = [];
    for (const source of SOURCES) {
      const entry = entryFor(source);
      if (!isIssue(entry, at) || !entry.kind || !entry.failingSince) continue;
      out.push({
        source,
        name: SOURCE_NAMES[source],
        kind: entry.kind,
        cause: CAUSES[entry.kind],
        nextAction: nextActionFor(source, entry.kind),
        since: entry.failingSince,
        lastSuccessAt: entry.lastSuccessAt,
        failures: entry.consecutiveFailures,
        reason: entry.reason ?? '',
        href: SOURCE_HREFS[source],
      });
    }
    return out;
  }

  return {
    reportSuccess(source) {
      const entry = entryFor(source);
      const at = now();
      const wasFailing = entry.consecutiveFailures > 0;
      entry.lastSuccessAt = new Date(at).toISOString();
      entry.failingSince = null;
      entry.consecutiveFailures = 0;
      entry.kind = null;
      entry.reason = null;
      const lastPersisted = lastSuccessPersistAt.get(source) ?? 0;
      if (wasFailing || at - lastPersisted >= SUCCESS_PERSIST_INTERVAL_MS) {
        lastSuccessPersistAt.set(source, at);
        persist();
      }
      if (wasFailing) console.log(`[CaptureHealth] ${SOURCE_NAMES[source]} is capturing again`);
    },

    reportFailure(source, failure) {
      const entry = entryFor(source);
      const at = new Date(now()).toISOString();
      const reason = sanitizeCaptureReason(failure.reason);
      const kind = isKind(failure.kind) ? failure.kind : 'unknown';
      if (entry.consecutiveFailures === 0 || !entry.failingSince) entry.failingSince = at;
      entry.consecutiveFailures += 1;
      entry.lastFailureAt = at;
      entry.kind = kind;
      entry.reason = reason;
      persist();
    },

    issues,

    sources() {
      return SOURCES.map(source => ({ ...entryFor(source) }));
    },

    version() {
      // Issues also appear by age alone, so the signature is recomputed on
      // read (three sources; trivial) rather than only on reports.
      const signature = issues().map(issue => `${issue.source}:${issue.kind}`).join('|');
      if (signature !== lastSignature) {
        lastSignature = signature;
        counter += 1;
      }
      return counter;
    },

    needsMidwayReauth(source, reportedAfterMs = 0) {
      const entry = entryFor(source);
      if (entry.consecutiveFailures <= 0 || entry.kind !== 'midway_auth' || !entry.lastFailureAt) return false;
      const reportedAt = Date.parse(entry.lastFailureAt);
      return Number.isFinite(reportedAt) && reportedAt > reportedAfterMs;
    },
  };
}
