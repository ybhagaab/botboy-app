/**
 * ETL run watcher: BotBoy's built-in "reusable script" for async Datanet runs
 * (ANALYTICS_AUTONOMY_PLAN.md, owner decision D2, 2026-10-08).
 *
 * Every 30 s it reads each pending watched run through the a2-analytics
 * connection. A finished run is downloaded (success) or diagnosed (failure)
 * exactly once, its outcome is stored on the watch, and the job is handed to
 * the continuation runner, which continues the chat on its own. State lives
 * in SQLite (chat-jobs.ts), so a restart resumes every watch.
 *
 * It reads runs (`readRun` cannot stage SQL, submit, restart, or kill;
 * etl-adhoc.ts › readRun). The one exception is runQuery's own queue rescue:
 * a scratch run still queued a minute after submission is prioritized once.
 */
import type { ChatJobStore, EtlRunOutcome } from './chat-jobs.js';
import type { QueryRunResult } from './etl-adhoc.js';

export const ETL_WATCH_INTERVAL_MS = 30_000;
/** Downloads of a SUCCESS run retried this many ticks before reporting failure. */
const MAX_DOWNLOAD_ATTEMPTS = 3;
/** Same delay as runQuery's own queue rescue (etl-adhoc.ts › prioritizeAfterMs). */
export const ETL_WATCH_PRIORITIZE_AFTER_MS = 60_000;

export interface EtlRunWatcherOptions {
  jobs: ChatJobStore;
  /** Read-only status + download of one existing run. */
  readRun: (runId: string) => Promise<QueryRunResult>;
  /**
   * The queue rescue for BotBoy's own scratch runs: one PRIORITIZE of a run
   * still WAITING_FOR_RESOURCES a minute after submission, when runQuery's
   * wait ended before its own rescue ran. Never for a run the model only
   * waited on (source 'wait', which may be a production run).
   */
  prioritizeRun?: (runId: string) => Promise<{ ok: boolean; error?: string }>;
  prioritizeAfterMs?: number;
  now?: () => number;
  /** Whether the Datanet ETL connection can take calls now (a call may start it). */
  etlAvailable: () => boolean | Promise<boolean>;
  /** A job has finished runs no turn has seen yet. */
  onRunsFinished: (jobId: string) => void;
  intervalMs?: number;
  log?: (message: string) => void;
}

export interface EtlRunWatcher {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

/** 'pending' while the run is still going (or its status could not be read). */
export function outcomeFromReadRun(result: QueryRunResult): EtlRunOutcome | 'pending' | 'download_failed' {
  if (result.ok) {
    return {
      remoteStatus: 'SUCCESS',
      ...(result.savedTo ? { savedTo: result.savedTo } : {}),
      ...(result.rowCount !== undefined ? { rowCount: result.rowCount } : {}),
      ...(result.columns ? { columns: result.columns } : {}),
      ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
      ...(result.resultBytes !== undefined ? { resultBytes: result.resultBytes } : {}),
    };
  }
  if (result.code === 'remote_failed') {
    return { remoteStatus: result.remoteStatus || 'ERROR', ...(result.error ? { error: result.error } : {}) };
  }
  if (result.code === 'download_failed') return 'download_failed';
  return 'pending';
}

export function createEtlRunWatcher(options: EtlRunWatcherOptions): EtlRunWatcher {
  const intervalMs = options.intervalMs ?? ETL_WATCH_INTERVAL_MS;
  const prioritizeAfterMs = options.prioritizeAfterMs ?? ETL_WATCH_PRIORITIZE_AFTER_MS;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.log(message));
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (ticking || stopped) return;
    ticking = true;
    try {
      for (const jobId of options.jobs.expireIdle()) log(`[EtlWatch] job ${jobId} expired after 24 h idle`);
      const pending = options.jobs.pendingWatches();
      // The connection is checked only when a run is waiting.
      if (pending.length && await options.etlAvailable()) {
        for (const watch of pending) {
          if (stopped) break;
          let result: QueryRunResult;
          try {
            result = await options.readRun(watch.runId);
          } catch (error: any) {
            options.jobs.markPolled(watch.runId, { failed: true });
            log(`[EtlWatch] run ${watch.runId} read failed: ${String(error?.message ?? error).slice(0, 200)}`);
            continue;
          }
          const outcome = outcomeFromReadRun(result);
          if (outcome === 'pending') {
            options.jobs.markPolled(watch.runId, { remoteStatus: result.remoteStatus, failed: result.code === 'status_unavailable' });
            const queuedFor = now() - Date.parse(watch.submittedAt);
            if (result.remoteStatus === 'WAITING_FOR_RESOURCES' && watch.source === 'run_query' && !watch.prioritizedAt
              && options.prioritizeRun && queuedFor >= prioritizeAfterMs && options.jobs.markPrioritized(watch.runId)) {
              // Once, whatever the outcome — never a loop (same rule as runQuery).
              try {
                const bump = await options.prioritizeRun(watch.runId);
                log(`[EtlWatch] run ${watch.runId} queued — PRIORITIZE ${bump.ok ? 'requested' : `failed: ${bump.error ?? 'unknown'}`}`);
              } catch (error: any) {
                log(`[EtlWatch] run ${watch.runId} PRIORITIZE failed: ${String(error?.message ?? error).slice(0, 160)}`);
              }
            }
            continue;
          }
          if (outcome === 'download_failed') {
            if (watch.pollFailures + 1 < MAX_DOWNLOAD_ATTEMPTS) {
              options.jobs.markPolled(watch.runId, { remoteStatus: 'SUCCESS', failed: true });
              continue;
            }
            options.jobs.finishWatch(watch.runId, {
              remoteStatus: 'SUCCESS',
              error: `The run succeeded, but BotBoy could not download its result: ${result.error ?? 'unknown error'}. Download it with mcp_etl_download_results.`,
            });
          } else {
            options.jobs.finishWatch(watch.runId, outcome);
          }
          log(`[EtlWatch] run ${watch.runId} finished (${outcome === 'download_failed' ? 'SUCCESS, download failed' : outcome.remoteStatus}) for job ${watch.jobId}`);
        }
      }
      // Re-announce every tick: a continuation may have waited for an owner
      // turn, or BotBoy restarted before it ran.
      const active = options.jobs.activeJob();
      if (active && options.jobs.unconsumedFinished(active.id).length) options.onRunsFinished(active.id);
    } catch (error: any) {
      log(`[EtlWatch] tick failed: ${String(error?.message ?? error).slice(0, 200)}`);
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref?.();
      void tick();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
