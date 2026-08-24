/**
 * Chat-embedded interactive terminal — the agent's escape hatch for anything
 * run_command cannot do: interactive authentication (Midway PIN entry,
 * security-key touch, installer prompts, sudo), long installs the user should
 * watch, and stuck commands that need a human decision.
 *
 * The agent opens a session as a tool call; the chat UI renders a live
 * terminal dock where the USER types (secrets never travel through chat
 * messages or the model). The agent observes output through read_terminal and
 * guides the user.
 *
 * Reuses the proven MCP setup-terminal PTY engine (bounded buffer, SSE
 * subscription, SIGTERM→SIGKILL stop, retention window) with one dedicated
 * engine instance, so chat sessions and MCP setup sessions cannot block each
 * other. Commands run under `/bin/zsh -lc` so pipes, globs, and login-shell
 * PATH behave exactly like the user's own terminal; the server's
 * toolchain-augmented PATH is inherited on top.
 *
 * Safety model:
 *   - Opening a session and sending agent input require ownerRequested=true
 *     (the house policy for every write-classified chat tool).
 *   - The exact command line is shown in the UI card before anything runs;
 *     the user is present by definition (they're chatting).
 *   - Catastrophic patterns stay blocked. `sudo` IS allowed here — unlike
 *     run_command — because a present user types the password into the PTY;
 *     the model never sees or relays it.
 *   - Output is never persisted; the buffer lives in memory only.
 */

import {
  createMcpTerminalEngine,
  type McpTerminalEngine,
  type McpTerminalSessionSnapshot,
} from './mcp-terminal.js';

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
// Source builds are real on machines whose Homebrew prefix disables bottles
// (observed live: poppler pulled a gnupg compile past 20 minutes).
const MAX_TIMEOUT_MS = 120 * 60_000;
const MODEL_OUTPUT_CAP = 6_000;

/** Catastrophic patterns the agent may never run, even with the user watching. */
const BLOCKED_PATTERNS: readonly RegExp[] = Object.freeze([
  /\brm\s+-[a-z]*r[a-z]*f?\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bkillall\b/i,
  /\blaunchctl\b/i,
  /\bdiskutil\s+(erase|partition)/i,
]);

export interface ChatTerminalOpenInput {
  command: string;
  /** Short human title shown on the card, e.g. "Install poppler". */
  title: string;
  timeoutMs?: number;
}

export interface ChatTerminalService {
  open(input: ChatTerminalOpenInput): McpTerminalSessionSnapshot;
  /** The most recent session (running or recently ended), if any. */
  current(): McpTerminalSessionSnapshot | null;
  get(sessionId: string): McpTerminalSessionSnapshot | null;
  /** Plain-text tail of the session output for the model (ANSI stripped). */
  readOutput(lastChars?: number): { session: McpTerminalSessionSnapshot; output: string } | null;
  writeInput(sessionId: string, data: string): void;
  stop(sessionId: string): void;
  subscribe(
    sessionId: string,
    onChunk: (chunk: string) => void,
    onEnd: (snapshot: McpTerminalSessionSnapshot) => void,
  ): () => void;
  /**
   * Block until the latest session ends or maxWaitMs elapses (whichever
   * first). Server-side waiting: the agent polls through ONE tool call
   * instead of burning an LLM round-trip every few seconds. Resolves
   * immediately when the session already ended. Null when no session exists.
   */
  waitForEnd(maxWaitMs: number): Promise<McpTerminalSessionSnapshot | null>;
  /**
   * Called when a session ends and NO waitForEnd is attached — the agent's
   * turn is over, so the server surfaces completion into chat instead.
   */
  setUnattendedEndListener(listener: (snapshot: McpTerminalSessionSnapshot) => void): void;
  shutdown(): void;
}

/** Strip ANSI escapes so model-visible output stays readable and compact. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007|\u001b[()][0-9A-B]|\r(?!\n)/g, '');
}

export function validateChatTerminalCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return 'command is required';
  if (trimmed.length > 2_000) return 'command is too long (2000 chars max)';
  if (trimmed.includes('\0')) return 'command contains a null byte';
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) return `blocked command pattern (${pattern.source})`;
  }
  return null;
}

export function createChatTerminalService(): ChatTerminalService {
  const engine: McpTerminalEngine = createMcpTerminalEngine();
  // The engine retains ended sessions for 10 minutes; track the latest id so
  // "current" survives session end (read_terminal after exit is the common
  // agent flow: open → user acts → command exits → agent reads the tail).
  let latestSessionId: string | null = null;
  // Output mirror for model reads. The engine buffer is subscriber-based;
  // keeping our own bounded mirror avoids attaching throwaway subscribers on
  // every read_terminal call.
  const outputs = new Map<string, string>();
  const MIRROR_CAP = 200_000;
  // waitForEnd wakers per session + unattended-end notification plumbing.
  const endWaiters = new Map<string, Set<() => void>>();
  let unattendedEndListener: ((snapshot: McpTerminalSessionSnapshot) => void) | null = null;
  // Sessions whose end the agent has already seen (via waitForEnd resolution
  // or a post-end read). Suppresses the duplicate unattended notification.
  const endObserved = new Set<string>();

  return {
    open(input) {
      const problem = validateChatTerminalCommand(input.command);
      if (problem) throw new Error(problem);
      const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10_000), MAX_TIMEOUT_MS);
      const snapshot = engine.start({
        profileId: 'chat',
        commandId: 'chat-command',
        title: input.title || input.command.slice(0, 60),
        executable: '/bin/zsh',
        args: ['-lc', input.command],
        env: {
          ...(process.env as Record<string, string>),
          TERM: 'xterm-256color',
          // Non-interactive-friendly defaults; prompts still work via PTY.
          HOMEBREW_NO_AUTO_UPDATE: '1',
        },
        timeoutMs,
      });
      latestSessionId = snapshot.id;
      outputs.set(snapshot.id, '');
      const unsubscribe = engine.subscribe(
        snapshot.id,
        (chunk) => {
          const prior = outputs.get(snapshot.id) ?? '';
          const next = prior + chunk;
          outputs.set(snapshot.id, next.length > MIRROR_CAP ? next.slice(next.length - MIRROR_CAP) : next);
        },
        (ended) => {
          // Keep the mirror for post-exit reads; engine retention (10 min)
          // bounds the lifetime. Unsubscribe happens via the returned fn when
          // the engine clears subscribers on finalize.
          unsubscribe();
          setTimeout(() => outputs.delete(snapshot.id), 10 * 60_000).unref?.();
          // Wake any agent turn blocked in waitForEnd; if nobody is waiting,
          // the turn already ended — surface completion into chat instead.
          // A 15s grace covers the gap between two consecutive agent waits so
          // completion is not reported twice.
          const waiters = endWaiters.get(snapshot.id);
          if (waiters && waiters.size > 0) {
            for (const wake of waiters) { try { wake(); } catch { /* waiter gone */ } }
            endWaiters.delete(snapshot.id);
          } else {
            setTimeout(() => {
              if (!endObserved.has(snapshot.id) && unattendedEndListener) {
                endObserved.add(snapshot.id);
                try { unattendedEndListener(ended); } catch { /* listener failure never breaks the session */ }
              }
            }, 15_000).unref?.();
          }
        },
      );
      return snapshot;
    },

    waitForEnd(maxWaitMs) {
      const sessionId = latestSessionId;
      if (!sessionId) return Promise.resolve(null);
      const now = engine.get(sessionId);
      if (!now) return Promise.resolve(null);
      if (now.status !== 'running') return Promise.resolve(now);
      const boundedMs = Math.min(Math.max(maxWaitMs, 1_000), 10 * 60_000);
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const waiters = endWaiters.get(sessionId);
          if (waiters) {
            waiters.delete(wake);
            if (waiters.size === 0) endWaiters.delete(sessionId);
          }
          const finalSnapshot = engine.get(sessionId);
          if (finalSnapshot && finalSnapshot.status !== 'running') endObserved.add(sessionId);
          resolve(finalSnapshot);
        };
        const wake = finish;
        const timer = setTimeout(finish, boundedMs);
        timer.unref?.();
        if (!endWaiters.has(sessionId)) endWaiters.set(sessionId, new Set());
        endWaiters.get(sessionId)!.add(wake);
      });
    },

    setUnattendedEndListener(listener) {
      unattendedEndListener = listener;
    },

    current() {
      if (!latestSessionId) return null;
      return engine.get(latestSessionId);
    },

    get(sessionId) {
      return engine.get(sessionId);
    },

    readOutput(lastChars = MODEL_OUTPUT_CAP) {
      if (!latestSessionId) return null;
      const session = engine.get(latestSessionId);
      if (!session) return null;
      if (session.status !== 'running') endObserved.add(session.id);
      const cap = Math.min(Math.max(lastChars, 200), 20_000);
      const raw = outputs.get(latestSessionId) ?? '';
      const plain = stripAnsi(raw);
      return { session, output: plain.slice(-cap) };
    },

    writeInput(sessionId, data) {
      engine.write(sessionId, data);
    },

    stop(sessionId) {
      engine.stop(sessionId);
    },

    subscribe(sessionId, onChunk, onEnd) {
      return engine.subscribe(sessionId, onChunk, onEnd);
    },

    shutdown() {
      engine.shutdown();
    },
  };
}
