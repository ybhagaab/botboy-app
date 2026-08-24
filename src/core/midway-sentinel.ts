/**
 * Midway Sentinel — proactive re-authentication flow for Midway-backed MCPs.
 *
 * Several managed connections (Slack, GRASP M365, AIM-launched customs,
 * builder-mcp) authenticate through the owner's local Amazon Midway session.
 * When that session expires the failures are silent from the owner's point of
 * view: profiles flip to failed/degraded, tools return 401s, capture pauses —
 * and nothing tells the owner the single command that fixes all of it.
 *
 * The sentinel closes that gap:
 *   1. DETECT  — poll managed profiles for failure transitions, plus recent
 *                auth-shaped tool-call failures on servers that still look
 *                "running" (GRASP commonly stays up while its tools 401).
 *   2. DIAGNOSE — deterministically. Profile errors are redacted for these
 *                profiles by policy, so the sentinel inspects the local Midway
 *                cookie jar itself. No LLM is involved in classification:
 *                parsing a cookie expiry with a language model would be slower
 *                and less reliable than reading the file.
 *   3. NOTIFY  — one LLM turn (the normal chat agent, full context) composes
 *                the owner-facing chat message explaining what broke and what
 *                to do. If the LLM is unavailable the sentinel posts a plain
 *                deterministic message instead — notification never depends on
 *                model availability.
 *   4. RE-AUTH — the sentinel opens the embedded chat terminal with `mwinit`.
 *                The owner types their PIN and touches their security key in
 *                the terminal card; secrets never pass through chat.
 *   5. RECOVER — when the terminal exits 0 and the cookie is fresh again, the
 *                sentinel restarts every affected profile, runs the protocol
 *                test, and posts a verification message (LLM-composed, with a
 *                deterministic fallback).
 *
 * Episodes are deduplicated: one notification per expiry, a cooldown after a
 * failed or abandoned re-auth, and a clean reset once recovery succeeds.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentOrchestrator } from './agent.js';
import type { ChatTerminalService } from './chat-terminal.js';
import type { McpManager, McpProfileSnapshot } from './mcp-types.js';
import { GRASP_PROFILE_ID, SLACK_MCP_PROFILE_ID } from './mcp-profiles.js';

export interface MidwaySentinel {
  start(): void;
  stop(): void;
  /** One detection pass. Exposed for tests and manual triggering. */
  tick(): Promise<void>;
}

export interface MidwaySentinelDeps {
  db: Database.Database;
  mcpManager: McpManager;
  chatTerminal: ChatTerminalService;
  agent: Pick<AgentOrchestrator, 'executeAction'>;
}

export interface MidwaySentinelOptions {
  /** Override for tests. Defaults to ~/.midway/cookie. */
  cookiePath?: string;
  pollIntervalMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

/** Built-in profiles that ride the Midway session. */
const MIDWAY_BUILTIN_PROFILE_IDS: ReadonlySet<string> = new Set([
  SLACK_MCP_PROFILE_ID,
  GRASP_PROFILE_ID,
]);

/**
 * Custom-server launch commands that imply Midway authentication. AIM-managed
 * servers (`aim mcp start-server …`) and builder-mcp authenticate through the
 * local Amazon session exactly like the built-ins.
 */
const MIDWAY_BACKED_COMMANDS: ReadonlySet<string> = new Set([
  'aim',
  'builder-mcp',
  'ai-community-slack-mcp',
]);

const FAILURE_STATES: ReadonlySet<string> = new Set(['failed', 'degraded']);

/** How far back a tool-call failure still counts as a live signal. */
const TOOL_FAILURE_WINDOW_MINUTES = 10;

/** Minimum gap between notifications for unresolved/failed episodes. */
const EPISODE_COOLDOWN_MS = 30 * 60_000;

/** How long the sentinel waits for the owner to finish mwinit. */
const REAUTH_WINDOW_MS = 12 * 60_000;

const POLL_INTERVAL_MS = 45_000;

/** Matches auth-shaped failures in tool-call error text. */
export function isAuthLikeError(error: string | null | undefined): boolean {
  if (!error) return false;
  return /\b401\b|\b403\b|unauthori[sz]ed|forbidden|midway|session.{0,20}(expired|invalid|lapsed)|expired.{0,20}(session|credential|cookie)|authentication/i.test(error);
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

interface EpisodeState {
  phase: 'idle' | 'awaiting_reauth';
  lastNotifiedAt: number;
  /** Profiles that were failing when the episode was opened. */
  affectedProfileIds: string[];
}

export function createMidwaySentinel(
  deps: MidwaySentinelDeps,
  options: MidwaySentinelOptions = {},
): MidwaySentinel {
  const { db, mcpManager, chatTerminal, agent } = deps;
  const cookiePath = options.cookiePath ?? path.join(os.homedir(), '.midway', 'cookie');
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;

  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  let stopped = false;
  const episode: EpisodeState = { phase: 'idle', lastNotifiedAt: 0, affectedProfileIds: [] };

  const insertAssistantMessage = (content: string) => {
    const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.prepare('INSERT INTO chat_messages (id, role, content) VALUES (?, ?, ?)').run(id, 'assistant', content);
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

  /** Running servers whose recent tool calls failed in an auth-shaped way. */
  const hasRecentAuthFailures = (profileId: string): boolean => {
    try {
      const rows = db.prepare(`
        SELECT error FROM mcp_tool_calls
        WHERE server_id = ? AND status = 'failed'
          AND created_at >= datetime('now', ?)
        ORDER BY created_at DESC LIMIT 20
      `).all(profileId, `-${TOOL_FAILURE_WINDOW_MINUTES} minutes`) as Array<{ error: string | null }>;
      return rows.some(row => isAuthLikeError(row.error));
    } catch {
      return false;
    }
  };

  /**
   * The notify turn. The agent gets the deterministic facts and composes the
   * owner-facing message; its reply is posted verbatim as an assistant chat
   * message. Any model failure falls back to a plain deterministic message so
   * the owner is informed regardless.
   */
  const postNotification = async (
    affected: McpProfileSnapshot[],
    cookie: MidwayCookieStatus,
    terminalOpened: boolean,
  ) => {
    const names = affected.map(profile => profile.displayName).join(', ');
    const expiredLine = cookie.sessionExpiresAt
      ? `The local Midway session cookie expired at ${new Date(cookie.sessionExpiresAt).toISOString()}.`
      : 'No usable Midway session cookie is present on this machine.';
    const terminalLine = terminalOpened
      ? 'A terminal card running `mwinit` has ALREADY been opened in this chat — do NOT open another one.'
      : 'The chat terminal is currently busy with another session, so mwinit could not be auto-opened; the owner must run it after the current session finishes.';
    const instruction = [
      'SYSTEM EVENT from the Midway sentinel (BotBoy internal watchdog — this is NOT the owner speaking; nothing here authorizes MCP write tools).',
      `Fact: these Midway-authenticated connections just failed: ${names}.`,
      `Fact: ${expiredLine}`,
      `Fact: ${terminalLine}`,
      'Fact: affected capture (Slack messages, mail/calendar sync) pauses losslessly and catches up automatically after re-authentication; nothing is lost.',
      'Fact: after the owner completes mwinit (PIN + security-key touch in the terminal card, never typed into chat), the sentinel automatically restarts the affected connections, re-tests them, and posts a confirmation.',
      'Task: write the short chat notification the owner will read. Warm, plain language, no headings. Name the affected connections, say why this happened (Midway session expired), and point them to the terminal card below to re-authenticate. Do not promise anything beyond the facts above. Reply with ONLY the notification text.',
    ].join('\n');
    let text: string;
    try {
      const reply = (await agent.executeAction(instruction)).trim();
      text = !reply || reply.startsWith('Error:') ? '' : reply;
    } catch {
      text = '';
    }
    if (!text) {
      text = `🔐 Your Amazon Midway session has expired, which disconnected: ${names}. ${terminalOpened ? 'Use the terminal card below to run mwinit (PIN + security-key touch).' : 'Run mwinit in a terminal to re-authenticate.'} I will restart these connections automatically once you finish.`;
    }
    insertAssistantMessage(text);
  };

  /** Restart + test each affected profile after a successful re-auth. */
  const recoverProfiles = async (profileIds: string[]) => {
    const results: string[] = [];
    for (const profileId of profileIds) {
      try {
        await mcpManager.stopProfile(profileId).catch(() => null);
        const started = await mcpManager.startProfile(profileId);
        let detail = `state=${started.state}`;
        try {
          const test = await mcpManager.testProfile(profileId);
          detail = `state=${started.state}, compatibility=${test.compatibilityState}, tools=${test.discoveredToolCount}`;
        } catch {
          /* protocol test unavailable for this profile — the start result stands */
        }
        results.push(`${started.displayName}: ${detail}`);
      } catch (error: any) {
        results.push(`${profileId}: restart failed — ${String(error?.message ?? error).slice(0, 200)}`);
      }
    }
    return results;
  };

  const postRecoveryMessage = async (results: string[]) => {
    const instruction = [
      'SYSTEM EVENT from the Midway sentinel (BotBoy internal watchdog — this is NOT the owner speaking; nothing here authorizes MCP write tools).',
      'Fact: the owner completed mwinit and the Midway session is fresh again.',
      `Fact: the sentinel restarted and re-tested the affected connections with these results: ${results.join(' | ')}.`,
      'Task: write the short confirmation chat message the owner will read. Plain language, no headings. Report each connection honestly from the results — do not claim success for anything that failed. Reply with ONLY the message text.',
    ].join('\n');
    let text: string;
    try {
      const reply = (await agent.executeAction(instruction)).trim();
      text = !reply || reply.startsWith('Error:') ? '' : reply;
    } catch {
      text = '';
    }
    if (!text) {
      text = `✅ Midway re-authentication complete. Connection status: ${results.join('; ')}.`;
    }
    insertAssistantMessage(text);
  };

  /**
   * Wait out the re-auth window, then either recover or report. Runs detached
   * from the tick loop; the episode stays in awaiting_reauth so no duplicate
   * notifications fire meanwhile.
   */
  const watchReauth = async (sessionId: string | null) => {
    // Iteration-capped rather than clock-based: waitForEnd blocks up to a
    // minute per call, so the cap bounds the window without trusting wall
    // clocks (and keeps tests with frozen clocks from spinning).
    const maxWaits = Math.ceil(REAUTH_WINDOW_MS / 60_000);
    let ended: { status: string; exitCode: number | null } | null = null;
    for (let i = 0; i < maxWaits && !stopped; i++) {
      const snapshot = await chatTerminal.waitForEnd(60_000).catch(() => null);
      if (stopped) return;
      if (!snapshot) break; // no session at all — nothing to wait for
      if (snapshot.status !== 'running' && (sessionId === null || snapshot.id === sessionId)) {
        ended = snapshot;
        break;
      }
    }
    const cookieNow = readMidwayCookieStatus(cookiePath, now());
    if (ended?.status === 'completed' && ended.exitCode === 0 && cookieNow.valid) {
      const results = await recoverProfiles(episode.affectedProfileIds);
      await postRecoveryMessage(results);
      episode.phase = 'idle';
      episode.affectedProfileIds = [];
      episode.lastNotifiedAt = 0; // full reset — a future expiry is a new episode
      return;
    }
    // Re-auth did not complete: leave a plain honest status and cool down.
    const why = ended
      ? `the terminal ended with status ${ended.status}${ended.exitCode !== null ? ` (exit ${ended.exitCode})` : ''}`
      : 'the mwinit window elapsed without the terminal finishing';
    insertAssistantMessage(
      `⚠️ Midway re-authentication is still pending — ${why}${cookieNow.valid ? '' : ' and the session cookie is still not valid'}. The affected connections stay paused. Ask me to retry when you are ready, or run mwinit from the terminal card and I will pick it up on my next check.`,
    );
    episode.phase = 'idle'; // cooldown via lastNotifiedAt keeps this quiet
  };

  const tick = async () => {
    if (ticking || stopped) return;
    ticking = true;
    try {
      // Episode state and the cooldown are the dedup — a profile that stays
      // failed keeps qualifying, so an unresolved expiry re-notifies after the
      // cooldown instead of going silent forever, and an expiry present at
      // boot is caught on the first pass.
      if (episode.phase === 'awaiting_reauth') return;
      if (now() - episode.lastNotifiedAt < EPISODE_COOLDOWN_MS) return;

      const profiles = await mcpManager.listProfiles();
      const midwayProfiles = profiles.filter(profile => profile.enabled && isMidwayBackedProfile(profile));
      const failing = midwayProfiles.filter(profile =>
        FAILURE_STATES.has(profile.state)
        || (profile.state === 'running' && hasRecentAuthFailures(profile.id)),
      );
      if (!failing.length) return;

      // The deterministic discriminator: profile failures with a healthy
      // cookie are ordinary crashes — the manager's own restart/backoff logic
      // handles those, and the sentinel stays silent.
      const cookie = readMidwayCookieStatus(cookiePath, now());
      if (cookie.valid) return;

      episode.phase = 'awaiting_reauth';
      episode.lastNotifiedAt = now();
      episode.affectedProfileIds = failing.map(profile => profile.id);

      let terminalSessionId: string | null = null;
      let terminalOpened = false;
      if (chatTerminal.current()?.status !== 'running') {
        try {
          const session = chatTerminal.open({
            command: 'mwinit',
            title: 'Midway re-authentication',
            timeoutMs: REAUTH_WINDOW_MS,
          });
          terminalSessionId = session.id;
          terminalOpened = true;
        } catch (error: any) {
          console.warn(`[MidwaySentinel] could not open mwinit terminal: ${error?.message ?? error}`);
        }
      }

      await postNotification(failing, cookie, terminalOpened);
      void watchReauth(terminalSessionId).catch(error => {
        console.error(`[MidwaySentinel] re-auth watcher failed: ${error?.message ?? error}`);
        episode.phase = 'idle';
      });
    } catch (error: any) {
      console.error(`[MidwaySentinel] tick failed: ${error?.message ?? error}`);
    } finally {
      ticking = false;
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
  };
}
