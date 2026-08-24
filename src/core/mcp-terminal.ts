/**
 * Embedded setup-terminal engine for managed MCP profiles.
 *
 * Runs exactly one approved, registry-declared command at a time under a
 * pseudo-terminal so interactive authentication works end to end inside
 * BotBoy: Midway PIN entry, security-key touch prompts, and browser
 * hand-offs. The browser never supplies a command — only a registry command
 * identifier — and the manager enforces profile policy before a session
 * starts.
 *
 * The PTY comes from the macOS `/usr/bin/script` wrapper, which gives the
 * child a controlling terminal without native module dependencies. Output is
 * kept in one bounded in-memory buffer, streamed to subscribers, and never
 * persisted.
 */

import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';

const MAX_BUFFER_CHARS = 200_000;
const MAX_INPUT_CHARS = 4_096;
const RETENTION_AFTER_EXIT_MS = 10 * 60_000;
const FORCE_KILL_AFTER_MS = 5_000;

export type McpTerminalStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'stopped';

export interface McpTerminalSessionSnapshot {
  id: string;
  profileId: string;
  commandId: string;
  title: string;
  status: McpTerminalStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}

export interface McpTerminalStartInput {
  profileId: string;
  commandId: string;
  title: string;
  /** Resolved absolute executable path or shim path. Never user-supplied. */
  executable: string;
  args: readonly string[];
  env: Record<string, string>;
  timeoutMs: number;
}

interface SessionState {
  snapshot: McpTerminalSessionSnapshot;
  child: pty.IPty;
  buffer: string;
  subscribers: Set<(chunk: string) => void>;
  enders: Set<(snapshot: McpTerminalSessionSnapshot) => void>;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  forceKillTimer: ReturnType<typeof setTimeout> | null;
  retentionTimer: ReturnType<typeof setTimeout> | null;
  pendingOutcome: McpTerminalStatus | null;
}

export interface McpTerminalEngine {
  start(input: McpTerminalStartInput): McpTerminalSessionSnapshot;
  activeSession(): McpTerminalSessionSnapshot | null;
  sessionFor(profileId: string): McpTerminalSessionSnapshot | null;
  get(sessionId: string): McpTerminalSessionSnapshot | null;
  write(sessionId: string, data: string): void;
  stop(sessionId: string): void;
  /** Replays buffered output, then streams. Returns an unsubscribe function. */
  subscribe(
    sessionId: string,
    onChunk: (chunk: string) => void,
    onEnd: (snapshot: McpTerminalSessionSnapshot) => void,
  ): () => void;
  shutdown(): void;
}

export function createMcpTerminalEngine(): McpTerminalEngine {
  const sessions = new Map<string, SessionState>();

  function running(): SessionState | null {
    for (const session of sessions.values()) {
      if (session.snapshot.status === 'running') return session;
    }
    return null;
  }

  function finalize(session: SessionState, status: McpTerminalStatus, exitCode: number | null): void {
    if (session.snapshot.status !== 'running') return;
    session.snapshot = {
      ...session.snapshot,
      status,
      exitCode,
      endedAt: new Date().toISOString(),
    };
    if (session.timeoutTimer) { clearTimeout(session.timeoutTimer); session.timeoutTimer = null; }
    if (session.forceKillTimer) { clearTimeout(session.forceKillTimer); session.forceKillTimer = null; }
    for (const end of session.enders) {
      try { end(session.snapshot); } catch { /* subscriber went away */ }
    }
    session.subscribers.clear();
    session.enders.clear();
    session.retentionTimer = setTimeout(() => { sessions.delete(session.snapshot.id); }, RETENTION_AFTER_EXIT_MS);
    session.retentionTimer.unref?.();
  }

  function terminate(session: SessionState, outcome: McpTerminalStatus): void {
    if (session.snapshot.status !== 'running' || session.pendingOutcome) return;
    session.pendingOutcome = outcome;
    try { session.child.kill('SIGTERM'); } catch { /* already gone */ }
    session.forceKillTimer = setTimeout(() => {
      try { session.child.kill('SIGKILL'); } catch { /* already gone */ }
    }, FORCE_KILL_AFTER_MS);
    session.forceKillTimer.unref?.();
  }

  function bind(session: SessionState): void {
    session.child.onData((chunk: string) => append(session, chunk));
    session.child.onExit(({ exitCode }: { exitCode: number }) => {
      finalize(
        session,
        session.pendingOutcome ?? (exitCode === 0 ? 'completed' : 'failed'),
        typeof exitCode === 'number' ? exitCode : null,
      );
    });
  }

  function append(session: SessionState, chunk: string): void {
    session.buffer += chunk;
    if (session.buffer.length > MAX_BUFFER_CHARS) {
      session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER_CHARS);
    }
    for (const subscriber of session.subscribers) {
      try { subscriber(chunk); } catch { /* subscriber went away */ }
    }
  }

  return {
    start(input) {
      const active = running();
      if (active) {
        throw new Error(`A setup terminal session is already running: ${active.snapshot.title}`);
      }
      // A real PTY: interactive prompts (Midway PIN, security-key touch,
      // confirmation questions) behave exactly as in a normal terminal.
      const child = pty.spawn(input.executable, [...input.args], {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        env: input.env,
      });
      const snapshot: McpTerminalSessionSnapshot = {
        id: randomUUID(),
        profileId: input.profileId,
        commandId: input.commandId,
        title: input.title,
        status: 'running',
        exitCode: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
      };
      const session: SessionState = {
        snapshot,
        child,
        buffer: '',
        subscribers: new Set(),
        enders: new Set(),
        timeoutTimer: null,
        forceKillTimer: null,
        retentionTimer: null,
        pendingOutcome: null,
      };
      sessions.set(snapshot.id, session);
      bind(session);

      session.timeoutTimer = setTimeout(() => {
        append(session, '\n[BotBoy] The command timed out and was stopped.\n');
        terminate(session, 'timed_out');
      }, input.timeoutMs);
      session.timeoutTimer.unref?.();

      return snapshot;
    },

    activeSession() {
      return running()?.snapshot ?? null;
    },

    sessionFor(profileId) {
      let latest: SessionState | null = null;
      for (const session of sessions.values()) {
        if (session.snapshot.profileId !== profileId) continue;
        if (!latest || session.snapshot.startedAt > latest.snapshot.startedAt) latest = session;
      }
      return latest?.snapshot ?? null;
    },

    get(sessionId) {
      return sessions.get(sessionId)?.snapshot ?? null;
    },

    write(sessionId, data) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error('Unknown terminal session');
      if (session.snapshot.status !== 'running') throw new Error('The terminal session has ended');
      if (typeof data !== 'string' || data.length === 0) throw new Error('Input data is required');
      if (data.length > MAX_INPUT_CHARS) throw new Error('Input data is too long');
      if (data.includes('\0')) throw new Error('Input data contains a null byte');
      session.child.write(data);
    },

    stop(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error('Unknown terminal session');
      if (session.snapshot.status !== 'running') return;
      append(session, '\n[BotBoy] Stop requested.\n');
      terminate(session, 'stopped');
    },

    subscribe(sessionId, onChunk, onEnd) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error('Unknown terminal session');
      if (session.buffer) onChunk(session.buffer);
      if (session.snapshot.status !== 'running') {
        onEnd(session.snapshot);
        return () => {};
      }
      session.subscribers.add(onChunk);
      session.enders.add(onEnd);
      return () => {
        session.subscribers.delete(onChunk);
        session.enders.delete(onEnd);
      };
    },

    shutdown() {
      for (const session of sessions.values()) {
        if (session.snapshot.status === 'running') terminate(session, 'stopped');
        if (session.retentionTimer) clearTimeout(session.retentionTimer);
      }
    },
  };
}
