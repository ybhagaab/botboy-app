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
 *
 * The same tick checks a job's dashboard refreshes and its general waits (an
 * export, a Data Room job, the terminal, a file, a connection, a time;
 * job-waits.ts, docs/maps/job-waits.md), whatever the ETL connection and the
 * Workplace setting say: those are BotBoy's own, read-only checks.
 */
import type { ChatJobStore, EtlRunOutcome, EtlRunWatch } from './chat-jobs.js';
import type { QueryRunResult } from './etl-adhoc.js';
import { JOB_WAIT_CHECK_EVERY_MS, timedOutOutcome, type JobWaitCheck } from './job-waits.js';
import { DATANET_SIGN_IN_REFUSED } from './sentry-session.js';

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
  /** Jobs that just expired after a day idle (the main chat gets one quiet line for each, PARALLEL_JOBS_PLAN.md §11 R1). */
  onJobsExpired?: (jobIds: string[]) => void;
  /**
   * One run of a BotBoy dashboard (analytics_runs), for the jobs that wait for a refresh of their dashboards (§12 R1). A local
   * read, done every tick whatever the ETL connection; null when the run is gone.
   */
  readDashboardRun?: (runId: string) => { status: string; widgetCount?: number; widgetsSucceeded?: number; error?: string } | null;
  /**
   * One check of a general wait (job-waits.ts › createJobWaitChecker: an export, a Data Room job, a terminal session, a file, a
   * connection, a time). Read-only; done every tick whatever the ETL connection and the Workplace setting say.
   */
  checkJobWait?: (wait: EtlRunWatch) => Promise<JobWaitCheck>;
  intervalMs?: number;
  log?: (message: string) => void;
  /** Settings → Workplace: false while Amazon Employee is off; pending watches then wait, unread. */
  enabled?: () => boolean;
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
  /** Runs whose still-downloading result was logged once. */
  const landingLogged = new Set<string>();
  /** Runs whose reads Datanet refuses at sign-in: logged once until a read works again (the run itself goes on). */
  const signInLogged = new Set<string>();
  /** Failed downloads per SUCCESS run (in memory: a restart gives a run three fresh tries). */
  const downloadFailures = new Map<string, number>();

  /** A job's dashboard refreshes that ended: their outcome is stored, and the job wakes below with the rest (§12 R1). */
  function checkDashboardWaits(): void {
    if (!options.readDashboardRun) return;
    for (const watch of options.jobs.pendingWatches()) {
      if (watch.source !== 'dashboard') continue;
      let run: ReturnType<NonNullable<EtlRunWatcherOptions['readDashboardRun']>>;
      try {
        run = options.readDashboardRun(watch.runId);
      } catch (error: any) {
        log(`[EtlWatch] dashboard refresh ${watch.runId} read failed: ${String(error?.message ?? error).slice(0, 160)}`);
        continue;
      }
      if (run && (run.status === 'queued' || run.status === 'running')) continue;
      const outcome: EtlRunOutcome = run
        ? {
          remoteStatus: String(run.status).toUpperCase(),
          ...(run.widgetCount !== undefined ? { widgetCount: run.widgetCount, widgetsSucceeded: run.widgetsSucceeded ?? 0 } : {}),
          ...(run.error ? { error: run.error } : {}),
        }
        : { remoteStatus: 'MISSING', error: 'The dashboard run is gone (the dashboard was deleted, or its runs were cleared).' };
      options.jobs.finishDashboardWait(watch.runId, watch.jobId, outcome);
      log(`[EtlWatch] dashboard refresh ${watch.runId} ended (${outcome.remoteStatus}) for job ${watch.jobId}`);
    }
  }

  /**
   * A job's general waits (docs/maps/job-waits.md): each is checked (a connection less often), and one that ended, or reached
   * its deadline, stores its outcome; the job wakes below with the rest. One at a time: each check is short and bounded.
   */
  async function checkJobWaits(): Promise<void> {
    if (!options.checkJobWait) return;
    for (const wait of options.jobs.pendingWatches()) {
      if (stopped) break;
      if (wait.source !== 'job_wait') continue;
      const t = now();
      const every = wait.kind ? JOB_WAIT_CHECK_EVERY_MS[wait.kind] ?? 0 : 0;
      const pastDeadline = Boolean(wait.deadlineAt) && t >= Date.parse(wait.deadlineAt!);
      if (every && wait.lastPolledAt && t - Date.parse(wait.lastPolledAt) < every && !pastDeadline) continue;
      let result: JobWaitCheck;
      try {
        result = await options.checkJobWait(wait);
      } catch (error: any) {
        // The checker never throws; if it did, the deadline still ends the wait.
        log(`[JobWait] ${wait.runId} check failed: ${String(error?.message ?? error).slice(0, 160)}`);
        result = pastDeadline ? { state: 'ended', outcome: timedOutOutcome(wait) } : { state: 'pending', failed: true };
      }
      if (result.state === 'pending') {
        options.jobs.markJobWaitChecked(wait.runId, { ...(result.note ? { note: result.note } : {}), ...(result.lastState ? { lastState: result.lastState } : {}), ...(result.failed ? { failed: true } : {}) });
        continue;
      }
      if (options.jobs.finishJobWait(wait.runId, result.outcome)) {
        log(`[JobWait] ${wait.kind} ${String(wait.target ?? '').slice(0, 80)} ended (${result.outcome.remoteStatus}) for job ${wait.jobId}`);
      }
    }
  }

  async function tick(): Promise<void> {
    if (ticking || stopped) return;
    ticking = true;
    try {
      // Dashboard refreshes and general waits are BotBoy's own: read whatever the ETL connection and the Workplace setting say.
      checkDashboardWaits();
      await checkJobWaits();
      if (options.enabled?.() === false) {
        for (const job of options.jobs.activeJobs()) {
          if (options.jobs.unconsumedFinished(job.id).some(watch => watch.source === 'dashboard' || watch.source === 'job_wait')) options.onRunsFinished(job.id);
        }
        return;
      }
      const expired = options.jobs.expireIdle();
      for (const jobId of expired) log(`[EtlWatch] job ${jobId} expired after 24 h idle`);
      if (expired.length) {
        try { options.onJobsExpired?.(expired); } catch (error: any) { log(`[EtlWatch] expiry note failed: ${error?.message ?? error}`); }
      }
      const pending = options.jobs.pendingWatches().filter(watch => watch.source === 'run_query' || watch.source === 'wait');
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
            if (!result.signInRefused) signInLogged.delete(watch.runId);
            else if (!signInLogged.has(watch.runId)) {
              signInLogged.add(watch.runId);
              log(`[EtlWatch] run ${watch.runId}: ${DATANET_SIGN_IN_REFUSED}; BotBoy keeps waiting and reads it again once Datanet answers`);
            }
            // A large result is still arriving in the connector's background: waited for, never downloaded again (etl-downloads.ts).
            if (result.code === 'download_landing' && !landingLogged.has(watch.runId)) {
              landingLogged.add(watch.runId);
              log(`[EtlWatch] run ${watch.runId} succeeded; its result is still downloading — waiting for the file`);
            }
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
            // Counted apart from status-read failures: a run whose status reads failed while it ran (a network blip, 100 of
            // them on 2026-10-29) still gets its three downloads.
            const failures = (downloadFailures.get(watch.runId) ?? 0) + 1;
            downloadFailures.set(watch.runId, failures);
            if (failures < MAX_DOWNLOAD_ATTEMPTS) {
              options.jobs.markPolled(watch.runId, { remoteStatus: 'SUCCESS', failed: true });
              continue;
            }
            downloadFailures.delete(watch.runId);
            options.jobs.finishWatch(watch.runId, {
              remoteStatus: 'SUCCESS',
              error: `The run succeeded, but BotBoy could not download its result after ${MAX_DOWNLOAD_ATTEMPTS} tries: ${result.error ?? 'unknown error'}. Check free disk space (df -h) and the Datanet connection, then download it once with mcp_etl_download_results; never resubmit the run.`,
            });
          } else {
            options.jobs.finishWatch(watch.runId, outcome);
          }
          log(`[EtlWatch] run ${watch.runId} finished (${outcome === 'download_failed' ? 'SUCCESS, download failed' : outcome.remoteStatus}) for job ${watch.jobId}`);
        }
      }
      // Re-announce every tick: a continuation may have waited for an owner
      // turn, or BotBoy restarted before it ran. Every active job, not one (PARALLEL_JOBS_PLAN.md).
      for (const job of options.jobs.activeJobs()) {
        if (options.jobs.unconsumedFinished(job.id).length) options.onRunsFinished(job.id);
      }
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
