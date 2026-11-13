/**
 * Midway Sentinel — the watchdog for Midway-backed connections (MIDWAY_NOTICES_PLAN.md §5, docs/maps/midway-sentinel.md).
 *
 * Slack, GRASP (Outlook mail and calendar), SharePoint, Datanet and AIM-launched servers sign in through the owner's Amazon
 * Midway session. When that sign-in fails, capture pauses (losslessly) and the owner needs one clear notice with the one thing
 * to do. Everything here is deterministic — no model reads or writes anything:
 *
 *   OBSERVE  every 45 s: each connection's recent call outcomes (mcp_tool_calls), capture health per source, the profile
 *            state, and the session cookie's expiry in ~/.midway/cookie (names and expiries only; values are never read).
 *   CLASSIFY each failure: network (ignored), timeout (a hung server), GRASP sign-in (its own tokens), sign-in (401s), other.
 *   DECIDE   one episode at a time, with the cause the evidence supports:
 *              session expired — sign-in failures and the session cookie expired → a notice after 5 min
 *              device check    — sign-in failures while the session cookie is valid (the 2-hour device-check cookie lapsed)
 *                                → wait 20 min, since its background renewal usually heals it, then a notice
 *              GRASP sign-in   — "no valid tokens" → restart GRASP after 5 min (it signs in again from Midway); a notice only
 *                                when that did not help 10 min later
 *   ACT      one notice when an episode opens (and one if its cause gets worse or more connections join), one "working
 *            again" notice when it closes; the mwinit terminal opens by itself only while the owner is at the Mac, once per
 *            episode (otherwise the notice's Re-authenticate button opens it). When the session cookie's expiry moves
 *            forward (an mwinit from anywhere) the still-failing connections restart, every connection not working yet
 *            checks at once (registerRecheck: GRASP and SharePoint runNow, Slack checkNow), the line says "Signed in
 *            again", and once the checks answer one notice says what the sign-in fixed: working again, still refused, or
 *            failing for another reason (which leaves the episode: signing in again does not fix it). Recovery is the
 *            connections' own calls succeeding, never the cookie file.
 *   HANGS    a connection whose every call times out for 10 min restarts (at most every 30 min); a notice only while the
 *            owner is at the Mac and a restart did not help.
 *
 * The episode lives in app_settings, so restarting BotBoy never re-alerts. Datanet keeps its silent Sentry re-prime.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatTerminalService } from './chat-terminal.js';
import type { McpManager, McpProfileSnapshot } from './mcp-types.js';
import { A2_ANALYTICS_PROFILE_ID, GRASP_PROFILE_ID, SHAREPOINT_MCP_PROFILE_ID, SLACK_MCP_PROFILE_ID } from './mcp-profiles.js';
import { isSentryAuthShapedError, primeDatanetSentrySession } from './sentry-session.js';
import {
  NETWORK_FAILURE_WORDS, captureFailureCause, classifyCaptureFailure, type CaptureHealth, type CaptureSourceHealth, type CaptureSourceId,
} from './capture-health.js';
import { postChatNotice, type ChatNoticeInput } from './chat-notices.js';
import { ownerIdleSeconds as readOwnerIdleSeconds } from './owner-presence.js';
import { getSetting, setSetting } from './storage.js';

export interface MidwaySentinel {
  start(): void;
  stop(): void;
  /** One pass. Exposed for tests and manual triggering. */
  tick(): Promise<void>;
  /** The owner pressed Re-authenticate on a notice: open the mwinit terminal now. */
  openReauth(): { ok: true; sessionId: string; command: string } | { ok: false; code: 'terminal_busy' | 'open_failed'; error: string };
  /**
   * How a connection's capture runs now (GRASP and SharePoint runNow, Slack checkNow). The sentinel calls it right after it
   * restarts that connection, and for every connection still waiting when the owner signs in again, so recovery does not
   * wait for the next scheduled run (up to 30 minutes for SharePoint).
   */
  registerRecheck(profileId: string, run: () => unknown): void;
  /** Resolves once the checks the sentinel started have finished and the tick they asked for has run (tests, diagnostics). */
  settled(): Promise<void>;
}

export interface MidwaySentinelDeps {
  db: Database.Database;
  mcpManager: Pick<McpManager, 'listProfiles' | 'stopProfile' | 'startProfile'>;
  chatTerminal: Pick<ChatTerminalService, 'current' | 'open' | 'waitForEnd'>;
  /** Capture outcomes per source: Slack reports a Midway 401 inside successful batch results, invisible to the call log. */
  captureHealth?: Pick<CaptureHealth, 'sources'>;
  /** Seconds since the owner's last keyboard or mouse input; null when unknown (owner-presence.ts). */
  ownerIdleSeconds?: () => Promise<number | null>;
}

export interface MidwaySentinelOptions {
  /** Override for tests. Defaults to ~/.midway/cookie. */
  cookiePath?: string;
  pollIntervalMs?: number;
  /** Clock override for tests. */
  now?: () => number;
  /** Settings → Workplace: false while Amazon Employee is off; the tick then does nothing. */
  active?: () => boolean;
}

/** Built-in profiles that ride the Midway session. */
const MIDWAY_BUILTIN_PROFILE_IDS: ReadonlySet<string> = new Set([
  SLACK_MCP_PROFILE_ID,
  GRASP_PROFILE_ID,
  SHAREPOINT_MCP_PROFILE_ID,
  A2_ANALYTICS_PROFILE_ID,
]);

/** Custom-server launch commands that imply Midway authentication (AIM-managed servers, builder-mcp). */
const MIDWAY_BACKED_COMMANDS: ReadonlySet<string> = new Set(['aim', 'builder-mcp', 'ai-community-slack-mcp']);

/** Capture source fed by each Midway-backed built-in profile. */
const CAPTURE_SOURCE_BY_PROFILE: ReadonlyMap<string, CaptureSourceId> = new Map([
  [SLACK_MCP_PROFILE_ID, 'slack'],
  [GRASP_PROFILE_ID, 'grasp'],
  [SHAREPOINT_MCP_PROFILE_ID, 'sharepoint'],
]);

/** Short names for the notice labels. */
const SHORT_NAMES: Readonly<Record<string, string>> = {
  [GRASP_PROFILE_ID]: 'GRASP',
  [SLACK_MCP_PROFILE_ID]: 'Slack',
  [SHAREPOINT_MCP_PROFILE_ID]: 'SharePoint',
  [A2_ANALYTICS_PROFILE_ID]: 'Datanet',
};

const FAILURE_STATES: ReadonlySet<string> = new Set(['failed', 'degraded']);
const STATE_KEY = 'midway_sentinel.v2';
const POLL_INTERVAL_MS = 45_000;
/** How far back the call log counts. */
const CALL_WINDOW_MS = 120 * 60_000;
export const SESSION_EXPIRED_GRACE_MS = 5 * 60_000;
export const DEVICE_CHECK_GRACE_MS = 20 * 60_000;
export const GRASP_RESTART_AFTER_MS = 5 * 60_000;
export const GRASP_ALERT_AFTER_RESTART_MS = 10 * 60_000;
export const HANG_RESTART_AFTER_MS = 10 * 60_000;
export const HANG_RESTART_INTERVAL_MS = 30 * 60_000;
export const HANG_ALERT_AFTER_RESTART_MS = 10 * 60_000;
/** The owner counts as at the Mac when the last input was this recent (terminal opening; hang notices). */
const PRESENT_FOR_TERMINAL_S = 120;
const PRESENT_FOR_HANG_NOTICE_S = 300;
/** Cooldown for the SILENT Datanet Sentry re-prime, so a broken server cannot turn the sentinel into a restart loop. */
const A2_PRIME_COOLDOWN_MS = 10 * 60_000;
/** How long the mwinit terminal stays open for the owner. */
const REAUTH_WINDOW_MS = 12 * 60_000;

/** Matches auth-shaped failures in tool-call error text. */
export function isAuthLikeError(error: string | null | undefined): boolean {
  if (!error) return false;
  return /\b401\b|\b403\b|unauthori[sz]ed|unauthenticated|forbidden|midway|mwinit|session.{0,20}(expired|invalid|lapsed)|expired.{0,20}(session|credential|cookie)|authentication/i.test(error);
}

export type MidwayFailureKind = 'network' | 'grasp_signin' | 'timeout' | 'auth' | 'other';

/**
 * What one failure says, in priority order. Network first: SharePoint's "Midway SAML round trip failed (HTTP network error).
 * Run mwinit" is a network failure that only mentions Midway. GRASP's "no valid tokens … grasp-mcp login" is its own sign-in.
 */
export function classifyMidwayFailure(error: string | null | undefined): MidwayFailureKind {
  const text = String(error ?? '');
  if (!text.trim()) return 'other';
  if (NETWORK_FAILURE_WORDS.test(text)) return 'network'; // the same words capture health reads first (capture-health.ts)
  if (/no valid tokens|grasp-mcp login/i.test(text)) return 'grasp_signin';
  if (/request timed out|\b-32001\b|timed out after/i.test(text)) return 'timeout';
  if (isAuthLikeError(text) || isSentryAuthShapedError(text)) return 'auth';
  return 'other';
}

export interface MidwayCookieStatus {
  /** True when a usable (unexpired) Midway session cookie exists. */
  valid: boolean;
  /** Expiry of the freshest session cookie, epoch ms, when one exists. */
  sessionExpiresAt: number | null;
  reason: 'ok' | 'expired' | 'missing_session_cookie' | 'missing_file';
}

/**
 * Read the Midway session state from the local cookie jar (Netscape format).
 * Only names, domains, and expiry timestamps are examined; values are never
 * read into messages or logs. `#HttpOnly_` prefixes are part of the format,
 * not comments (curl convention), and the session cookie usually hides there.
 */
export function readMidwayCookieStatus(cookiePath: string, nowMs: number): MidwayCookieStatus {
  let raw: string;
  try {
    raw = fs.readFileSync(cookiePath, 'utf8');
  } catch {
    return { valid: false, sessionExpiresAt: null, reason: 'missing_file' };
  }
  let bestSessionExpiry: number | null = null;
  for (const line of raw.split('\n')) {
    let entry = line.trim();
    if (!entry) continue;
    if (entry.startsWith('#HttpOnly_')) entry = entry.slice('#HttpOnly_'.length);
    else if (entry.startsWith('#')) continue;
    const fields = entry.split(/\t+|\s{2,}|\s/).filter(Boolean);
    if (fields.length < 6) continue;
    const [domain, , , , expiryRaw, name] = fields;
    if (!domain.toLowerCase().includes('midway')) continue;
    if (name !== 'session') continue;
    const expiry = Number(expiryRaw);
    if (!Number.isFinite(expiry)) continue;
    const expiryMs = expiry * 1000;
    if (bestSessionExpiry === null || expiryMs > bestSessionExpiry) bestSessionExpiry = expiryMs;
  }
  if (bestSessionExpiry === null) {
    return { valid: false, sessionExpiresAt: null, reason: 'missing_session_cookie' };
  }
  return bestSessionExpiry > nowMs
    ? { valid: true, sessionExpiresAt: bestSessionExpiry, reason: 'ok' }
    : { valid: false, sessionExpiresAt: bestSessionExpiry, reason: 'expired' };
}

export type MidwayCause = 'session_expired' | 'device_check' | 'grasp_signin';

interface Episode {
  cause: MidwayCause;
  /** Affected profile ids (the union while the episode is open). */
  profiles: string[];
  /** First failure, epoch ms. */
  since: number;
  /** mwinit -o -s is needed (Datanet is affected and its Sentry sign-in cannot renew without it). */
  datanet?: boolean;
  alertedAt?: number;
  /** How serious the last notice was (alertLevel); a worse episode gets one more notice. */
  alertedLevel?: number;
  /** The connections the last notice named; when more join, one more notice names them all. */
  alertedProfiles?: string[];
  terminalOpenedAt?: number;
  graspRestartedAt?: number;
  /** When BotBoy saw the owner sign in again during this episode (the session cookie's expiry moved forward). */
  signedInAt?: number;
  /** When BotBoy reported what that sign-in fixed: once per sign-in, after the connections it checked have answered. */
  signInReportedAt?: number;
}

const datanetOnly = (episode: Episode): boolean => episode.profiles.every(id => id === A2_ANALYTICS_PROFILE_ID);
/** GRASP's own sign-in < Datanet's sign-in < Amazon's device check < an expired Midway session. */
const alertLevel = (episode: Episode): number => episode.cause === 'session_expired' ? 4
  : episode.cause === 'device_check' ? (datanetOnly(episode) ? 2 : 3)
    : 1;

interface HangState {
  since: number;
  restartedAt?: number;
  alertedAt?: number;
}

interface SentinelState {
  v: 2;
  /** The session cookie expiry seen last; when it moves forward, someone signed in again. */
  lastSessionExpiry: number | null;
  episode: Episode | null;
  hangs: Record<string, HangState>;
  /**
   * When the sentinel last restarted each connection. Evidence from before is stale: a restarted server has not answered
   * yet, and old failures must not trigger the next restart (Datanet is called only on demand, so its last failure can sit
   * in the call log for hours).
   */
  restarts: Record<string, number>;
  lastA2PrimeAt?: number;
  lastA2PrimeOk?: boolean;
}

/** What one connection's evidence says right now. */
interface ProfileSignal {
  profile: McpProfileSnapshot;
  failing: boolean;
  /** Kind of the latest failure. */
  kind: MidwayFailureKind | null;
  /** First failure of the current streak, epoch ms. */
  since: number | null;
  lastFailureAt: number | null;
  /** Latest successful call, epoch ms (Slack's batch 401s are successes here; capture health covers them). */
  lastSuccessAt: number | null;
  /** The text of the latest failure (call error, capture reason, or the profile's last error); null while not failing. */
  lastError: string | null;
}

/** A sign-in failure: the Midway session or device check (auth), or GRASP's own tokens. Everything else is another problem. */
const isSignInFailure = (kind: MidwayFailureKind | null): boolean => kind === 'auth' || kind === 'grasp_signin';

/** What the episode's connections say once the owner signed in again (createMidwaySentinel › afterSignIn). */
interface SignInReport {
  /** Working again: no failure and a success after the episode began. */
  working: string[];
  /** Still refusing the sign-in after it. */
  refused: string[];
  /** Failing after the sign-in for another reason: the Midway problem is over for them. */
  other: Array<{ id: string; reason: string }>;
  /** No answer yet and no check BotBoy can run (an on-demand connection such as Datanet). */
  unchecked: string[];
  /** Every connection BotBoy asked to check has answered. */
  ready: boolean;
}

const sqliteUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
/**
 * Epoch ms of a stored time. SQLite's datetime('now') ("2026-10-29 10:10:00", the call log and mcp_servers.updated_at) is UTC
 * without a zone, which Date.parse would read as local time; ISO strings (capture health) carry their zone.
 */
const parseTime = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const text = String(value).trim();
  const ms = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text) ? Date.parse(`${text.replace(' ', 'T')}Z`) : Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
};
/** Times read as the owner reads them in the panel ("9:42 AM"). */
const clockOf = (ms: number): string => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

function loadState(db: Database.Database): SentinelState {
  const stored = getSetting<Partial<SentinelState>>(db, STATE_KEY);
  return {
    v: 2,
    lastSessionExpiry: typeof stored?.lastSessionExpiry === 'number' ? stored.lastSessionExpiry : null,
    episode: stored?.episode && typeof stored.episode === 'object' && Array.isArray(stored.episode.profiles) ? stored.episode : null,
    hangs: stored?.hangs && typeof stored.hangs === 'object' ? stored.hangs : {},
    restarts: stored?.restarts && typeof stored.restarts === 'object' ? stored.restarts : {},
    ...(typeof stored?.lastA2PrimeAt === 'number' ? { lastA2PrimeAt: stored.lastA2PrimeAt, lastA2PrimeOk: Boolean(stored.lastA2PrimeOk) } : {}),
  };
}

export function createMidwaySentinel(
  deps: MidwaySentinelDeps,
  options: MidwaySentinelOptions = {},
): MidwaySentinel {
  const { db, mcpManager, chatTerminal } = deps;
  const cookiePath = options.cookiePath ?? path.join(os.homedir(), '.midway', 'cookie');
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const idleSeconds = deps.ownerIdleSeconds ?? (() => readOwnerIdleSeconds());

  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let state = loadState(db);
  const save = () => {
    try { setSetting(db, STATE_KEY, state); } catch (error: any) { console.warn(`[MidwaySentinel] could not save its state: ${error?.message ?? error}`); }
  };

  /** Midway-backed custom servers, identified by their launch command. */
  const isMidwayBackedProfile = (profile: McpProfileSnapshot): boolean => {
    if (MIDWAY_BUILTIN_PROFILE_IDS.has(profile.id)) return true;
    if (!profile.id.startsWith('custom-')) return false;
    try {
      const row = db.prepare('SELECT config_json FROM mcp_servers WHERE id = ?').get(profile.id) as { config_json?: string } | undefined;
      const command = String(JSON.parse(row?.config_json ?? '{}').command ?? '');
      return MIDWAY_BACKED_COMMANDS.has(path.basename(command));
    } catch {
      return false;
    }
  };
  const shortName = (profile: McpProfileSnapshot): string =>
    SHORT_NAMES[profile.id] ?? String(profile.displayName || profile.id).replace(/\s+MCP(\s+Server)?$/i, '').slice(0, 28);

  const selectCalls = db.prepare(`SELECT status, error, created_at FROM mcp_tool_calls
    WHERE server_id = ? AND status IN ('completed', 'failed') AND created_at >= ?
    ORDER BY created_at DESC, rowid DESC LIMIT 400`);

  /** The connection's evidence: its calls since the latest success, its capture source's streak, and its state. */
  const signalOf = (profile: McpProfileSnapshot, captureSources: CaptureSourceHealth[]): ProfileSignal => {
    let lastSuccessAt: number | null = null;
    let since: number | null = null;
    let lastFailureAt: number | null = null;
    let kind: MidwayFailureKind | null = null;
    let lastError: string | null = null;
    const restartedAt = state.restarts[profile.id] ?? null;
    const windowStart = Math.max(now() - CALL_WINDOW_MS, restartedAt ?? 0);
    try {
      const rows = selectCalls.all(profile.id, sqliteUtc(windowStart)) as Array<{ status: string; error: string | null; created_at: string }>;
      for (const row of rows) {
        const at = parseTime(row.created_at);
        if (at === null || (restartedAt !== null && at <= restartedAt)) continue;
        if (row.status === 'completed') { lastSuccessAt = at; break; }
        if (lastFailureAt === null) { lastFailureAt = at; kind = classifyMidwayFailure(row.error); lastError = row.error; }
        since = at;
      }
    } catch { /* no call log: the other signals decide */ }
    let failing = lastFailureAt !== null;
    const source = CAPTURE_SOURCE_BY_PROFILE.get(profile.id);
    const capture = source ? captureSources.find(entry => entry.source === source) : undefined;
    const captureAt = capture ? parseTime(capture.lastFailureAt) ?? parseTime(capture.failingSince) : null;
    // A source keeps its streak until its next poll, which can trail a restart (or a recovery) by minutes.
    if (capture && capture.consecutiveFailures > 0 && capture.kind && captureAt !== null && (restartedAt === null || captureAt > restartedAt)) {
      const captureKind: MidwayFailureKind = capture.kind === 'midway_auth' ? 'auth'
        : capture.kind === 'network' ? 'network'
          : capture.kind === 'service_auth' ? (classifyMidwayFailure(capture.reason) === 'grasp_signin' ? 'grasp_signin' : 'other')
            : 'other';
      const captureSince = Math.min(parseTime(capture.failingSince) ?? captureAt, captureAt);
      failing = true;
      if (lastFailureAt === null || captureAt >= lastFailureAt) { lastFailureAt = captureAt; kind = captureKind; lastError = capture.reason; }
      since = since === null ? captureSince : Math.min(since, captureSince);
    }
    if (FAILURE_STATES.has(profile.state)) {
      const stateAt = parseTime(profile.updatedAt) ?? now();
      failing = true;
      if (lastFailureAt === null) { lastFailureAt = stateAt; kind = classifyMidwayFailure(profile.lastError); lastError = profile.lastError ?? null; }
      since = since === null ? stateAt : Math.min(since, stateAt);
    }
    return {
      profile, failing, kind: failing ? kind : null, since: failing ? since : null, lastFailureAt, lastSuccessAt,
      lastError: failing ? lastError : null,
    };
  };

  /** Back to working: no failure, and a success after the episode began (no evidence either way keeps it open). */
  const recovered = (signal: ProfileSignal | undefined, sinceMs: number): boolean =>
    !signal || (!signal.failing && signal.lastSuccessAt !== null && signal.lastSuccessAt > sinceMs);

  /** Connections whose capture BotBoy can run on demand (registerRecheck), and the chain of checks still running. */
  const rechecks = new Map<string, () => unknown>();
  let followUp: Promise<void> = Promise.resolve();
  /**
   * Asks these connections' capture to run now instead of at its next scheduled run, then ticks once more when every check
   * has finished, so what they answered reaches the notice within seconds instead of the next 45 s tick.
   */
  const recheck = (profileIds: string[]): void => {
    const ids = profileIds.filter(id => rechecks.has(id));
    if (!ids.length || stopped) return;
    console.log(`[MidwaySentinel] checking ${ids.join(', ')} now`);
    const runs = ids.map(id => Promise.resolve().then(() => rechecks.get(id)!()).catch((error: any) => {
      console.warn(`[MidwaySentinel] could not check ${id}: ${String(error?.message ?? error).slice(0, 200)}`);
    }));
    followUp = followUp.then(() => Promise.allSettled(runs)).then(async () => {
      if (stopped) return;
      await (running ?? Promise.resolve());
      await tick();
    });
  };

  const restart = async (profileIds: string[], why: string): Promise<void> => {
    const started: string[] = [];
    for (const profileId of profileIds) {
      state.restarts[profileId] = now();
      try {
        await mcpManager.stopProfile(profileId).catch(() => null);
        const snapshot = await mcpManager.startProfile(profileId);
        console.log(`[MidwaySentinel] restarted ${profileId} (${why}): state=${snapshot.state}`);
        if (snapshot.state === 'running') started.push(profileId);
      } catch (error: any) {
        console.warn(`[MidwaySentinel] could not restart ${profileId} (${why}): ${String(error?.message ?? error).slice(0, 200)}`);
      }
    }
    // A connection that came back checks at once; one still starting answers on its own schedule.
    recheck(started);
  };

  const ownerPresent = async (withinSeconds: number): Promise<boolean> => {
    try {
      const idle = await idleSeconds();
      return idle !== null && idle <= withinSeconds;
    } catch {
      return false;
    }
  };

  const labelsOf = (profileIds: string[], profiles: McpProfileSnapshot[]): string[] =>
    profileIds.map(id => profiles.find(profile => profile.id === id)).filter((p): p is McpProfileSnapshot => Boolean(p)).map(shortName);

  /** The episode's notice: a few words, the connections, the one thing to do, and the facts behind it. */
  const alertNotice = (episode: Episode, labels: string[], cookie: MidwayCookieStatus): ChatNoticeInput => {
    const reauth = { kind: 'midway_reauth' as const, label: 'Re-authenticate' };
    const mwinit = episode.datanet ? 'mwinit -o -s' : 'mwinit';
    if (episode.cause === 'session_expired') {
      const capturing = episode.profiles.some(id => CAPTURE_SOURCE_BY_PROFILE.has(id));
      return {
        key: 'midway', topic: 'midway', state: 'open', severity: 'warning', title: 'Midway sign-in needed', labels,
        next: `Run ${mwinit}.${capturing ? ' Capture catches up on its own afterwards.' : ''}`,
        detail: [
          cookie.sessionExpiresAt ? `Your Midway session expired at ${clockOf(cookie.sessionExpiresAt)}.` : 'No Midway session was found on this Mac.',
          `Signing in has failed since ${clockOf(episode.since)}.`,
          'BotBoy restarts these connections as soon as you sign in again.',
        ].join('\n'),
        action: reauth,
      };
    }
    if (episode.cause === 'device_check' && datanetOnly(episode)) {
      // Only Datanet, with Midway itself fine: its Sentry sign-in lapsed and BotBoy's silent re-prime did not renew it.
      return {
        key: 'midway', topic: 'midway', state: 'open', severity: 'warning', title: 'Datanet sign-in needed', labels,
        next: 'Run mwinit -o -s.',
        detail: [
          `Datanet's sign-in has failed since ${clockOf(episode.since)}${cookie.sessionExpiresAt ? `, while your Midway session is valid until ${clockOf(cookie.sessionExpiresAt)}` : ''}.`,
          "BotBoy's own re-sign-in from your Kerberos ticket did not work. mwinit -o -s renews the Datanet sign-in too.",
        ].join('\n'),
        action: reauth,
      };
    }
    if (episode.cause === 'device_check') {
      return {
        key: 'midway', topic: 'midway', state: 'open', severity: 'warning', title: 'Amazon device check failing', labels,
        next: `Usually clears on its own. If it keeps failing, run ${mwinit}.`,
        detail: [
          cookie.sessionExpiresAt ? `Your Midway session is valid until ${clockOf(cookie.sessionExpiresAt)}.` : '',
          `Since ${clockOf(episode.since)}, Amazon's device check has refused these connections. It renews in the background every couple of hours and usually recovers by itself.`,
          episode.datanet ? `BotBoy's own Datanet re-sign-in did not work either; ${mwinit} renews both.` : '',
        ].filter(Boolean).join('\n'),
        action: reauth,
      };
    }
    return {
      key: 'midway', topic: 'midway', state: 'open', severity: 'warning', title: 'GRASP sign-in lost', labels: [],
      next: 'Open GRASP and run Authorize Personal Access.',
      detail: [
        `GRASP has had no valid sign-in since ${clockOf(episode.since)}.`,
        episode.graspRestartedAt ? `BotBoy restarted it at ${clockOf(episode.graspRestartedAt)}; it did not sign back in.` : '',
      ].filter(Boolean).join('\n'),
      action: { kind: 'open_route', label: 'Open GRASP', route: `#/connections/${GRASP_PROFILE_ID}` },
    };
  };

  const nameOf = (id: string, all: McpProfileSnapshot[]): string => labelsOf([id], all)[0] ?? id;
  /** "Slack", "GRASP and Slack", "GRASP, SharePoint and Slack". */
  const listOf = (names: string[]): string => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

  /** Why a connection still fails once the sign-in works: a few words, then its own error (the notice sanitizes it). */
  const otherReason = (signal: ProfileSignal): string => {
    const error = String(signal.lastError ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const words = signal.kind === 'timeout' ? 'its requests time out'
      : signal.kind === 'network' ? 'the service or network is not reachable'
        : FAILURE_STATES.has(signal.profile.state) ? 'the connection is not running'
          : captureFailureCause(classifyCaptureFailure(error)).replace(/^./, first => first.toLowerCase());
    return error ? `${words} ("${error}")` : words;
  };

  /** What the episode's connections say since the owner signed in again. */
  const afterSignIn = (episode: Episode, signals: ProfileSignal[]): SignInReport => {
    const signedInAt = episode.signedInAt ?? episode.since;
    const report: SignInReport = { working: [], refused: [], other: [], unchecked: [], ready: true };
    for (const id of episode.profiles) {
      const signal = signals.find(entry => entry.profile.id === id);
      if (!signal) continue; // turned off or removed: nothing to say about it
      if (recovered(signal, episode.since)) report.working.push(id);
      else if (signal.failing && (signal.lastFailureAt ?? 0) > signedInAt) {
        if (isSignInFailure(signal.kind)) report.refused.push(id);
        else report.other.push({ id, reason: otherReason(signal) });
      } else if (rechecks.has(id)) report.ready = false; // BotBoy asked it to check: its answer is still coming
      else report.unchecked.push(id); // used on demand (Datanet): its next call tells
    }
    return report;
  };

  /** BotBoy saw a new sign-in: which connections it checks now. The panel folds this into the open notice's line. */
  const signedInNotice = (checking: string[], working: string[], all: McpProfileSnapshot[], at: number): ChatNoticeInput => {
    const names = labelsOf(checking, all);
    const already = labelsOf(working, all);
    return {
      key: 'midway', topic: 'midway', state: 'info', severity: 'info', title: 'Signed in again', labels: names,
      next: `Checking ${listOf(names)} now.`,
      detail: [
        `Signed in again at ${clockOf(at)}.`,
        already.length ? `Already working: ${already.join(', ')}.` : '',
        'BotBoy restarts the connections that still failed and checks each one now, without waiting for its next scheduled run.',
      ].filter(Boolean).join('\n'),
    };
  };

  /**
   * "Working again" when an episode closes. After a sign-in it says when, and names each connection that now fails for
   * another reason (a chip, and the reason in the details): signing in again does not fix those.
   */
  const resolvedNotice = (
    working: string[], other: SignInReport['other'], unchecked: string[], all: McpProfileSnapshot[], at: number, signedInAt?: number,
  ): ChatNoticeInput => {
    const workingNames = labelsOf(working, all);
    const uncheckedNames = labelsOf(unchecked, all);
    return {
      key: 'midway', topic: 'midway', state: 'resolved', severity: workingNames.length ? 'success' : 'info',
      title: workingNames.length ? 'Amazon sign-in working again' : 'Signed in again',
      labels: [...workingNames, ...other.map(item => `${nameOf(item.id, all)} still failing`)],
      detail: [
        signedInAt !== undefined ? `Signed in again at ${clockOf(signedInAt)}.` : '',
        workingNames.length
          ? `Working again at ${clockOf(at)}${signedInAt !== undefined ? `: ${workingNames.join(', ')}` : ''}. Capture catches up on its own.`
          : '',
        ...other.map(item => {
          const name = nameOf(item.id, all);
          return `${name} still fails for another reason: ${item.reason}. Signing in again does not fix this; BotBoy keeps retrying, and the ${name} connection page shows its state.`;
        }),
        uncheckedNames.length ? `${listOf(uncheckedNames)} ${uncheckedNames.length === 1 ? 'is' : 'are'} checked again on next use.` : '',
      ].filter(Boolean).join('\n'),
    };
  };

  /** An open notice after a sign-in that did not fix everything: what it fixed first, then the notice's own facts. */
  const withSignInFacts = (notice: ChatNoticeInput, signedInAt: number, report: SignInReport, all: McpProfileSnapshot[]): ChatNoticeInput => ({
    ...notice,
    detail: [
      `Signed in again at ${clockOf(signedInAt)}.`,
      report.working.length ? `Working again: ${labelsOf(report.working, all).join(', ')}.` : '',
      ...report.other.map(item => `${nameOf(item.id, all)} fails for another reason: ${item.reason}.`),
      report.unchecked.length ? `${listOf(labelsOf(report.unchecked, all))} ${report.unchecked.length === 1 ? 'is' : 'are'} checked again on next use.` : '',
      notice.detail ?? '',
    ].filter(Boolean).join('\n'),
  });

  /** When the sentinel last opened its terminal (the tick, or the owner's button); the tick folds it into the episode. */
  let ownTerminalOpenedAt = 0;
  /** Opens the owner's mwinit terminal (never two at once), and watches it quietly so its end posts no extra message. */
  const openTerminal = (command: string): string | null => {
    if (chatTerminal.current()?.status === 'running') return null;
    try {
      const session = chatTerminal.open({ command, title: 'Midway re-authentication', timeoutMs: REAUTH_WINDOW_MS });
      ownTerminalOpenedAt = now();
      void watchOwnTerminal(session.id);
      return session.id;
    } catch (error: any) {
      console.warn(`[MidwaySentinel] could not open the ${command} terminal: ${error?.message ?? error}`);
      return null;
    }
  };
  /** Waiting marks the end as seen (chat-terminal.ts › waitForEnd), so the "Terminal ended" note is not posted; then re-check. */
  const watchOwnTerminal = async (sessionId: string): Promise<void> => {
    for (let i = 0; i < Math.ceil(REAUTH_WINDOW_MS / 60_000) + 1 && !stopped; i++) {
      const snapshot = await chatTerminal.waitForEnd(60_000).catch(() => null);
      if (!snapshot || snapshot.id !== sessionId) return;
      if (snapshot.status !== 'running') break;
    }
    if (!stopped) void tick();
  };

  /** The episode the evidence supports right now, or null. */
  const decide = (signals: ProfileSignal[], cookie: MidwayCookieStatus): { cause: MidwayCause; affected: ProfileSignal[] } | null => {
    const failing = signals.filter(signal => signal.failing && signal.kind !== 'network' && signal.kind !== 'timeout');
    if (!cookie.valid) {
      // With the session expired, a sign-in failure is the expiry; so is a connection that is down (its start needs Midway).
      const affected = failing.filter(signal => signal.kind !== 'other' || FAILURE_STATES.has(signal.profile.state));
      return affected.length ? { cause: 'session_expired', affected } : null;
    }
    const signIn = failing.filter(signal => signal.kind === 'auth');
    if (signIn.length) return { cause: 'device_check', affected: failing.filter(signal => signal.kind === 'auth' || signal.kind === 'grasp_signin') };
    const grasp = failing.filter(signal => signal.kind === 'grasp_signin');
    return grasp.length ? { cause: 'grasp_signin', affected: grasp } : null;
  };

  const alertDue = (episode: Episode, at: number): boolean => {
    if (episode.cause === 'session_expired') return at - episode.since >= SESSION_EXPIRED_GRACE_MS;
    if (episode.cause === 'device_check') return at - episode.since >= DEVICE_CHECK_GRACE_MS;
    return episode.graspRestartedAt !== undefined && at - episode.graspRestartedAt >= GRASP_ALERT_AFTER_RESTART_MS;
  };

  /** Datanet rides Sentry on top of Midway: a valid cookie with Sentry-shaped failures re-primes silently first. */
  const handleDatanet = async (signals: ProfileSignal[], cookie: MidwayCookieStatus): Promise<ProfileSignal[]> => {
    const a2 = signals.find(signal => signal.profile.id === A2_ANALYTICS_PROFILE_ID);
    if (!a2 || !a2.failing || a2.kind !== 'auth' || !cookie.valid) return signals;
    const at = now();
    if (state.lastA2PrimeAt === undefined || at - state.lastA2PrimeAt >= A2_PRIME_COOLDOWN_MS) {
      state.lastA2PrimeAt = at;
      const prime = await primeDatanetSentrySession(cookiePath);
      state.lastA2PrimeOk = prime.ok;
      if (prime.ok) {
        await restart([A2_ANALYTICS_PROFILE_ID], 'Datanet Sentry session re-primed');
        return signals.filter(signal => signal !== a2);
      }
      console.warn(`[MidwaySentinel] silent Datanet Sentry prime failed (${prime.reason})`);
    } else if (state.lastA2PrimeOk) {
      return signals.filter(signal => signal !== a2); // a re-prime just worked; give the restarted server time
    }
    return signals;
  };

  /** A connection whose every call times out: restart it; tell the owner only if they are here and that did not help. */
  const handleHangs = async (signals: ProfileSignal[]): Promise<void> => {
    const at = now();
    for (const id of Object.keys(state.hangs)) {
      if (!signals.some(signal => signal.profile.id === id)) delete state.hangs[id]; // turned off or removed
    }
    for (const signal of signals) {
      const id = signal.profile.id;
      const hang = state.hangs[id];
      const hung = signal.failing && signal.kind === 'timeout' && signal.since !== null;
      if (!hung) {
        if (!hang) continue;
        // Over only on evidence that it answers: a call that succeeded, or a running server failing in another way (other
        // checks own that). A restarted server that has not answered yet, or one that is down, keeps the hang.
        const answered = (signal.lastSuccessAt !== null && signal.lastSuccessAt > hang.since)
          || (signal.failing && !FAILURE_STATES.has(signal.profile.state));
        if (!answered) continue;
        if (hang.alertedAt !== undefined) {
          postChatNotice(db, {
            key: `connection:${id}`, topic: 'connection', state: 'resolved', severity: 'success',
            title: `${shortName(signal.profile)} responding again`,
            detail: `Responding again at ${clockOf(at)}.`,
          });
        }
        delete state.hangs[id];
        continue;
      }
      const current = state.hangs[id] ?? (state.hangs[id] = { since: signal.since! });
      if (at - current.since >= HANG_RESTART_AFTER_MS && (current.restartedAt === undefined || at - current.restartedAt >= HANG_RESTART_INTERVAL_MS)) {
        current.restartedAt = at;
        await restart([id], 'every call timed out');
        continue;
      }
      if (current.restartedAt !== undefined && current.alertedAt === undefined && at - current.restartedAt >= HANG_ALERT_AFTER_RESTART_MS
        && (signal.lastFailureAt ?? 0) > current.restartedAt && await ownerPresent(PRESENT_FOR_HANG_NOTICE_S)) {
        const name = shortName(signal.profile);
        current.alertedAt = at;
        postChatNotice(db, {
          key: `connection:${id}`, topic: 'connection', state: 'open', severity: 'warning', title: `${name} not responding`,
          next: `BotBoy restarted it at ${clockOf(current.restartedAt)}. If it keeps failing, open the ${name} connection.`,
          detail: `Every ${name} request has timed out since ${clockOf(current.since)}.`,
          action: { kind: 'open_route', label: `Open ${name}`, route: `#/connections/${encodeURIComponent(id)}` },
        });
      }
    }
  };

  /** One tick at a time: a tick asked for while one runs (the timer, a finished check, the terminal) waits for that one. */
  let running: Promise<void> | null = null;
  const tick = (): Promise<void> => {
    if (options.active?.() === false || stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      try {
        await tickOnce();
      } finally {
        running = null;
      }
    })();
    return running;
  };

  const tickOnce = async (): Promise<void> => {
    try {
      state = loadState(db);
      const profiles = (await mcpManager.listProfiles()).filter(profile => profile.enabled && isMidwayBackedProfile(profile));
      const cookie = readMidwayCookieStatus(cookiePath, now());
      const captureSources = deps.captureHealth?.sources() ?? [];
      let signals = profiles.map(profile => signalOf(profile, captureSources));
      signals = await handleDatanet(signals, cookie);
      await handleHangs(signals);
      const signalFor = (id: string) => signals.find(signal => signal.profile.id === id);

      // Signed in again from anywhere (the terminal card, a chat turn, another terminal): the session cookie's expiry moved
      // forward. Connections that still fail restart once (GRASP then signs in again from the fresh session), every
      // connection not working yet checks now instead of at its next scheduled run, and the owner sees at once that BotBoy
      // noticed. What the sign-in fixed is reported once those checks have answered (afterSignIn, below).
      const signedInAgain = cookie.sessionExpiresAt !== null && state.lastSessionExpiry !== null
        && cookie.sessionExpiresAt > state.lastSessionExpiry + 60_000;
      if (cookie.sessionExpiresAt !== null) state.lastSessionExpiry = cookie.sessionExpiresAt;
      const episode = state.episode;
      if (signedInAgain && episode) {
        const at = now();
        const present = episode.profiles.filter(id => signalFor(id));
        const stillFailing = present.filter(id => signalFor(id)!.failing);
        const waiting = present.filter(id => !stillFailing.includes(id) && !recovered(signalFor(id), episode.since));
        const working = present.filter(id => !stillFailing.includes(id) && !waiting.includes(id));
        episode.signedInAt = at;
        delete episode.signInReportedAt;
        if (stillFailing.length + waiting.length > 0) {
          if (stillFailing.includes(GRASP_PROFILE_ID)) episode.graspRestartedAt = at;
          if (episode.alertedAt !== undefined) postChatNotice(db, signedInNotice([...stillFailing, ...waiting], working, profiles, at));
          await restart(stillFailing, 'Midway session renewed');
          recheck(waiting);
          return; // the restarted connections' old evidence is stale; the next tick reads what they answer
        }
        // Everything already works again: the report below closes the episode in this tick.
      }

      const decision = decide(signals, cookie);
      const at = now();

      // After a sign-in: once every connection BotBoy asked to check has answered, say once what the sign-in fixed.
      if (episode && episode.signedInAt !== undefined && episode.signInReportedAt === undefined) {
        // A connection that starts refusing the sign-in meanwhile joins the episode, so the report names it.
        if (decision) episode.profiles = [...new Set([...episode.profiles, ...decision.affected.map(signal => signal.profile.id)])];
        const report = afterSignIn(episode, signals);
        if (!report.ready) return; // still waiting for a connection BotBoy asked to check
        if (!report.refused.length) {
          if (episode.alertedAt !== undefined) {
            postChatNotice(db, resolvedNotice(report.working, report.other, report.unchecked, profiles, at, episode.signedInAt));
          }
          state.episode = null;
          return;
        }
        // Some still refuse the sign-in: the episode goes on with them (and the ones nobody could check yet). The owner
        // sees what the sign-in fixed, and the notice now names only what is left.
        const refusedSignals = report.refused.map(id => signalFor(id)!);
        const remaining = [...report.refused, ...report.unchecked];
        const current: Episode = {
          ...episode,
          cause: decision?.cause ?? episode.cause,
          profiles: remaining,
          since: Math.min(...refusedSignals.map(signal => signal.since ?? at)),
          signInReportedAt: at,
        };
        current.datanet = current.profiles.includes(A2_ANALYTICS_PROFILE_ID)
          && (current.cause === 'session_expired' || state.lastA2PrimeOk === false);
        state.episode = current;
        if (current.alertedAt !== undefined) {
          current.alertedLevel = alertLevel(current);
          current.alertedProfiles = [...remaining];
          postChatNotice(db, withSignInFacts(alertNotice(current, labelsOf(report.refused, profiles), cookie), episode.signedInAt, report, profiles));
        }
        return;
      }

      if (!decision) {
        // Over when every connection works again; after a sign-in, one that now fails for another reason is no longer a
        // Midway problem (its connection page shows it). No evidence either way keeps the episode open.
        const movedOut = (id: string): boolean => {
          const signal = signalFor(id);
          return episode?.signedInAt !== undefined && Boolean(signal?.failing) && !isSignInFailure(signal!.kind)
            && (signal!.lastFailureAt ?? 0) > episode.signedInAt;
        };
        if (episode && episode.profiles.every(id => recovered(signalFor(id), episode.since) || movedOut(id))) {
          if (episode.alertedAt !== undefined) {
            const other = episode.profiles.filter(movedOut).map(id => ({ id, reason: otherReason(signalFor(id)!) }));
            postChatNotice(db, resolvedNotice(episode.profiles.filter(id => !movedOut(id)), other, [], profiles, at, episode.signedInAt));
          }
          state.episode = null;
        }
        return;
      }

      const affectedIds = decision.affected.map(signal => signal.profile.id);
      const since = Math.min(...decision.affected.map(signal => signal.since ?? at));
      const current: Episode = episode
        ? { ...episode, cause: decision.cause, profiles: [...new Set([...episode.profiles, ...affectedIds])], since: Math.min(episode.since, since) }
        : { cause: decision.cause, profiles: affectedIds, since };
      // Datanet signs in through Sentry on top of Midway, and only mwinit -o -s renews both (sentry-session.ts): with the
      // session expired, or once BotBoy's own silent re-prime failed.
      current.datanet = current.profiles.includes(A2_ANALYTICS_PROFILE_ID)
        && (current.cause === 'session_expired' || state.lastA2PrimeOk === false);
      if (current.terminalOpenedAt === undefined && ownTerminalOpenedAt >= current.since) current.terminalOpenedAt = ownTerminalOpenedAt;
      state.episode = current;

      // GRASP's own sign-in: one restart after 5 minutes (it signs in again from the Midway session).
      const grasp = decision.affected.find(signal => signal.profile.id === GRASP_PROFILE_ID && signal.kind === 'grasp_signin');
      if (grasp && current.graspRestartedAt === undefined && at - (grasp.since ?? at) >= GRASP_RESTART_AFTER_MS) {
        current.graspRestartedAt = at;
        await restart([GRASP_PROFILE_ID], 'GRASP has no valid sign-in');
        return;
      }

      const labels = labelsOf(current.profiles, profiles);
      if (current.alertedAt === undefined) {
        if (!alertDue(current, at)) return;
        current.alertedAt = at;
        current.alertedLevel = alertLevel(current);
        current.alertedProfiles = [...current.profiles];
        postChatNotice(db, alertNotice(current, labels, cookie));
      } else {
        // An episode stored before alertedProfiles existed: its last notice named the connections it had then.
        const named = current.alertedProfiles ?? episode?.profiles ?? current.profiles;
        const joined = current.profiles.some(id => !named.includes(id));
        if (alertLevel(current) > (current.alertedLevel ?? 0) || joined) {
          // Worse than what the owner was told, or more connections affected: one more notice (the panel folds it into the
          // same line, so the line names them all).
          current.alertedLevel = alertLevel(current);
          current.alertedProfiles = [...current.profiles];
          postChatNotice(db, alertNotice(current, labels, cookie));
        } else if (current.alertedProfiles === undefined) {
          current.alertedProfiles = [...named];
        }
      }
      // An expired session: the mwinit terminal opens by itself only while the owner is at the Mac, once per episode. A device
      // check usually clears on its own, so it waits for the notice's button.
      if (current.cause === 'session_expired' && current.terminalOpenedAt === undefined && await ownerPresent(PRESENT_FOR_TERMINAL_S)) {
        if (openTerminal(current.datanet ? 'mwinit -o -s' : 'mwinit')) current.terminalOpenedAt = ownTerminalOpenedAt;
      }
    } catch (error: any) {
      console.error(`[MidwaySentinel] tick failed: ${error?.message ?? error}`);
    } finally {
      save();
    }
  };

  return {
    start() {
      if (timer) return;
      stopped = false;
      timer = setInterval(() => { void tick(); }, pollIntervalMs);
      timer.unref?.();
      console.log(`[MidwaySentinel] watching Midway-backed MCP profiles every ${Math.round(pollIntervalMs / 1000)}s`);
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    openReauth() {
      if (chatTerminal.current()?.status === 'running') {
        return { ok: false, code: 'terminal_busy', error: 'A terminal is already running in the chat. Finish or stop it, then press Re-authenticate again.' };
      }
      // Reads only: the next tick records the opening (ownTerminalOpenedAt), so the two never overwrite each other's state.
      const command = loadState(db).episode?.datanet ? 'mwinit -o -s' : 'mwinit';
      const sessionId = openTerminal(command);
      if (!sessionId) return { ok: false, code: 'open_failed', error: 'The terminal could not be opened. Run mwinit in a terminal of your own.' };
      return { ok: true, sessionId, command };
    },
    registerRecheck(profileId, run) {
      rechecks.set(profileId, run);
    },
    settled: () => followUp,
  };
}
