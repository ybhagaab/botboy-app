/**
 * Dashboard support routes — refresh-version signalling and log tailing.
 *
 * `DashboardState` holds the monotonic refresh counter that used to be a
 * `let refreshVersion` inside the monolithic createRouter. The chat router
 * bumps it from POST /chat/agent-message; the UI polls GET /dashboard/version.
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type Database from 'better-sqlite3';
import { getToolchainSnapshot, initToolchain, loadPersistedToolchain } from '../../core/toolchain.js';
import type { ChatTerminalService } from '../../core/chat-terminal.js';

/** Identity of this server process — new on every restart. */
const BOOT_ID = randomUUID();

/** The directory express.static serves the SPA from (dist/ui at runtime, src/ui under tsx). */
const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui');

/**
 * UI-assets version stamp: file count + max mtime across the served UI
 * directory. bootId only changes on server RESTART, but BotBoy edits and
 * rebuilds UI files while the server keeps running — express.static serves
 * the new files immediately, yet an open SPA tab keeps executing the old
 * JavaScript until it reloads. Incident 2026-09-03: a correct chart fix
 * produced two phantom "verification failed" rounds because the verifying
 * tab never re-fetched. This stamp lets pollVersion detect new assets
 * without a restart. Computed per request: ~30 statSync calls, sub-ms.
 */
export function computeUiAssetsVersion(dir: string = UI_DIR): string {
  try {
    let count = 0;
    let maxMtime = 0;
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.isFile()) {
          count++;
          const m = statSync(p).mtimeMs;
          if (m > maxMtime) maxMtime = m;
        }
      }
    };
    walk(dir);
    return `${count}:${Math.round(maxMtime)}`;
  } catch {
    return '0';
  }
}

export interface DashboardState {
  bump(): number;
  current(): number;
}

export function createDashboardState(): DashboardState {
  let version = 0;
  return {
    bump: () => ++version,
    current: () => version,
  };
}

export function createDashboardRouter(state: DashboardState, db?: Database.Database, chatTerminal?: ChatTerminalService): Router {
  const router = Router();

  // Include durable capture/assignment revisions so monitor and pipeline
  // activity invalidates the dashboard even when no HTTP action calls bump().
  // The composite remains opaque to clients; they only compare for changes.
  function currentVersion(): number | string {
    if (!db) return state.current();
    try {
      const workItems = db.prepare(`
        SELECT COALESCE(MAX(rowid), 0) AS rowId,
               COALESCE(MAX(captured_at), '') AS capturedAt
        FROM work_items
      `).get() as { rowId: number; capturedAt: string };
      const projectEvents = db.prepare(`
        SELECT COALESCE(MAX(id), 0) AS eventId
        FROM work_item_project_events
      `).get() as { eventId: number };
      return [state.current(), workItems.rowId, workItems.capturedAt, projectEvents.eventId].join(':');
    } catch {
      return state.current();
    }
  }

  function currentAnalyticsVersion(): string {
    if (!db) return '0';
    try {
      const analytics = db.prepare(`
        SELECT COUNT(*) AS runCount,
          COALESCE(MAX(rowid), 0) AS runRowId,
          COALESCE(MAX(queued_at), '') AS queuedAt,
          COALESCE(MAX(heartbeat_at), '') AS heartbeatAt,
          COALESCE(MAX(completed_at), '') AS completedAt
        FROM analytics_runs
      `).get() as {
        runCount: number;
        runRowId: number;
        queuedAt: string;
        heartbeatAt: string;
        completedAt: string;
      };
      return [
        analytics.runCount,
        analytics.runRowId,
        analytics.queuedAt,
        analytics.heartbeatAt,
        analytics.completedAt,
      ].join(':');
    } catch {
      return '0';
    }
  }

  router.post('/dashboard/refresh', (_req: Request, res: Response) => {
    res.json({ version: state.bump() });
  });

  router.get('/dashboard/version', (_req: Request, res: Response) => {
    // bootId identifies THIS server process. A change means the server
    // restarted — possibly with new UI code — so open tabs reload themselves
    // instead of running stale JavaScript indefinitely (post-mortem
    // 2026-08-18: a days-old tab kept pre-fix code and looked broken).
    // terminal: lets every open tab discover chat terminal sessions on the
    // regular poll, regardless of which tab (or API path) opened them.
    const terminalSession = chatTerminal?.current() ?? null;
    res.json({
      version: currentVersion(),
      analyticsVersion: currentAnalyticsVersion(),
      bootId: BOOT_ID,
      uiVersion: computeUiAssetsVersion(),
      terminal: terminalSession ? { id: terminalSession.id, status: terminalSession.status } : null,
    });
  });
  // ── Log viewer (tail kiro-cli and app logs) ──

  function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\[[\d;]*m/g, '');
  }

  router.get('/logs/agent', async (_req: Request, res: Response) => {
    const { execSync } = await import('child_process');
    try {
      const logPath = `${process.env.TMPDIR || '/tmp/'}kiro-log/kiro-chat.log`;
      const content = execSync(`tail -50 "${logPath}" 2>/dev/null || echo "No log"`, { encoding: 'utf-8' });
      res.json({ lines: content.split('\n').filter(l => l.trim()).map(stripAnsi) });
    } catch { res.json({ lines: ['Error reading log'] }); }
  });

  router.get('/logs/app', async (_req: Request, res: Response) => {
    const { execSync } = await import('child_process');
    try {
      const content = execSync('tail -50 /tmp/ppt.log 2>/dev/null || echo "No log"', { encoding: 'utf-8' });
      res.json({ lines: content.split('\n').filter(l => l.trim()).map(stripAnsi) });
    } catch { res.json({ lines: ['Error reading log'] }); }
  });

  // ── Toolchain diagnostics ──
  // The discovered external-tool map: what resolved where, versions, and what
  // is missing with install guidance. Refresh re-runs discovery so a tool
  // installed mid-session becomes usable without a server restart.
  router.get('/system/toolchain', (_req: Request, res: Response) => {
    const live = getToolchainSnapshot();
    const snapshot = live ?? (db ? loadPersistedToolchain(db) : null);
    if (!snapshot) return res.status(503).json({ error: 'Toolchain not discovered yet' });
    res.json({ toolchain: snapshot, live: live !== null });
  });

  router.post('/system/toolchain/refresh', async (_req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: 'Toolchain refresh needs the database' });
    try {
      const snapshot = await initToolchain(db);
      res.json({ toolchain: snapshot, live: true });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? 'Toolchain refresh failed' });
    }
  });

 return router;
}
