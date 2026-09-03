/**
 * ETL ad-hoc query runner — the one-shot composite behind `mcp_etl_run_query`.
 *
 * Datanet has no "run SQL, get rows" primitive: the minimal path is
 * profile → job → run → poll → download. This module owns that dance so the
 * model sees ONE deterministic tool (etl-analytics map A1; practical-agent
 * framework: composite over dance).
 *
 * Namespace hygiene: Datanet profiles are visible to the user's whole group.
 * BotBoy therefore keeps exactly ONE scratch pair per user —
 * `botboy_adhoc_<alias>` (TRANSFORM profile + NOT_SCHEDULED TRANSFORM job) —
 * created once, pinned in settings, and REUSED for every ad-hoc query via
 * SQL revisions. The TRANSFORM pair is load-bearing: the EXTRACT creation
 * path fails owner validation and its profiles are invisible to the type
 * detector (live-verified 2026-08-28, datanet-etl.md gotchas).
 *
 * Environment discovery (zero manual inputs): group / logical DB / db user
 * come from the user's own Datanet footprint — search their alias, take the
 * modal values from their jobs. Users with no footprint get ONE structured
 * error naming the single fact needed (their team's Datanet group), which
 * then also resolves via search.
 *
 * `QueryRunner` is the A4 seam: dashboards later select SqlMcpRunner ⇄
 * EtlQueryRunner by availability. Only the interface ships now (A4 parked).
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getSetting, setSetting } from './storage.js';
import { resolveOwnerIdentity } from './owner-identity.js';
import { isSentryAuthShapedError, primeDatanetSentrySession } from './sentry-session.js';
import type { McpManager } from './mcp-types.js';

/** Raw ETL tool call with the Sentry self-heal built in (see createEtlToolCall). */
export type EtlToolCall = (
  toolName: string,
  args: Record<string, unknown>,
  opts?: { ownerApproved?: boolean },
) => Promise<{ isError: boolean; text: string; serverId?: string; toolName?: string }>;

export const ETL_TOOL_TIMEOUT_MS = 5 * 60_000;

/**
 * The one way BotBoy talks to the a2-analytics server: policy-gated call
 * with the Sentry retry-once self-heal, auth-shaped TEXT treated as an auth
 * failure regardless of the isError flag (a lapsed session answers with a
 * 307 HTML page wrapped as data — live 2026-09-02). Shared by the chat
 * tool handlers (which add the trust envelope), the ad-hoc runner, and the
 * onboarding service. Terminal auth failures return plain `Error:` strings
 * with the exact remedy and NO serverId — callers can tell them from data.
 */
export function createEtlToolCall(mcpManager: McpManager): EtlToolCall {
  return async (toolName, args, opts = {}) => {
    const call = () => mcpManager.callTool('a2-analytics', toolName, args, {
      source: 'agent',
      timeoutMs: ETL_TOOL_TIMEOUT_MS,
      ownerApproved: opts.ownerApproved === true,
    });
    let result;
    try {
      result = await call();
      if (isSentryAuthShapedError(result.text)) {
        const prime = await primeDatanetSentrySession();
        if (prime.ok) result = await call();
      }
    } catch (error: any) {
      const message = String(error?.message ?? error);
      if (!isSentryAuthShapedError(message)) throw error;
      const prime = await primeDatanetSentrySession();
      if (!prime.ok) {
        return { isError: true, text: `Error: the Datanet ETL connection needs re-authentication and the silent Kerberos re-prime failed (${prime.reason}). Tell the owner to run \`mwinit -o -s\` (or use Connections → Datanet ETL → Refresh Midway + Sentry), then retry this tool.` };
      }
      result = await call();
    }
    if (isSentryAuthShapedError(result.text)) {
      return { isError: true, text: 'Error: the Datanet ETL connection needs re-authentication. Tell the owner to run `mwinit -o -s` (or use Connections → Datanet ETL → Refresh Midway + Sentry), then retry this tool.' };
    }
    return { isError: result.isError, text: result.text, serverId: result.serverId, toolName: result.toolName };
  };
}

export interface QueryRunResult {
  ok: boolean;
  runId?: string;
  columns?: string[];
  rows?: string[][];
  rowCount?: number;
  truncated?: boolean;
  savedTo?: string;
  /** Non-ok: what happened, in one line the model can act on. */
  error?: string;
  /** Non-ok: the exact next action. Never leaves the model guessing. */
  nextAction?: string;
}

/** The A4 dashboard seam: implementations run one SQL statement chain. */
export interface QueryRunner {
  id: string;
  runQuery(input: { sql: string; datasetDate?: string; group?: string }): Promise<QueryRunResult>;
}

const KEYS = {
  profileId: 'etl.adhoc.profile_id',
  jobId: 'etl.adhoc.job_id',
  alias: 'etl.adhoc.alias',
  env: 'etl.adhoc.env', // { group, logicalDb, dbUser }
} as const;

interface ScratchEnv { group: string; logicalDb: string; dbUser: string }

export interface EtlAdhocOptions {
  db: Database.Database;
  call: EtlToolCall;
  /** Injectables for tests. */
  pollIntervalMs?: number;
  pollBudgetMs?: number;
  /** How long a run may sit in WAITING_FOR_RESOURCES before the one-time PRIORITIZE rescue. */
  prioritizeAfterMs?: number;
  downloadDir?: string;
  maxRows?: number;
  now?: () => number;
}

const DEP_HEADER_RE = /\/\*\s*(NO DEPENDENCIES|\+?\s*ETLM)/i;

/** Parse a Datanet JSON response defensively; returns {} on non-JSON. */
function parseJson(text: string): Record<string, any> {
  try { return JSON.parse(text) as Record<string, any>; } catch { return {}; }
}

function firstLine(text: string, max = 400): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

export function createEtlQueryRunner(options: EtlAdhocOptions): QueryRunner {
  const { db, call } = options;
  const pollIntervalMs = options.pollIntervalMs ?? 15_000;
  const pollBudgetMs = options.pollBudgetMs ?? 6 * 60_000;
  const prioritizeAfterMs = options.prioritizeAfterMs ?? 60_000;
  const maxRows = options.maxRows ?? 200;
  const now = options.now ?? Date.now;
  const downloadDir = options.downloadDir
    ?? path.join(os.homedir(), '.personal-productivity-tracker', 'etl-results');
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  function aliasForUser(): string {
    const identity = resolveOwnerIdentity(db);
    const alias = (identity.alias || '').trim().toLowerCase();
    if (alias) return alias;
    try { return os.userInfo().username.toLowerCase(); } catch { return 'user'; }
  }

  /**
   * Discover group/logicalDb/dbUser from the user's own Datanet footprint
   * (or, when given, from any job of their team's group). Modal values win —
   * a user's jobs overwhelmingly share one environment.
   */
  async function discoverEnv(searchTerm: string): Promise<ScratchEnv | { error: string }> {
    const result = await call('datanet_search', { query: searchTerm, size: 25 });
    if (result.isError) return { error: `Datanet search failed: ${firstLine(result.text)}` };
    const parsed = parseJson(result.text);
    const docs: Array<Record<string, any>> = Array.isArray(parsed.searchResults)
      ? parsed.searchResults.map((r: any) => r?.document ?? {})
      : [];
    const tally = new Map<string, { count: number; env: ScratchEnv }>();
    for (const doc of docs) {
      const group = String(doc.job_group_name ?? '').trim();
      const logicalDb = String(doc.job_logical_db_name ?? '').trim();
      const dbUser = String(doc.job_db_user_name ?? '').trim();
      if (!group || !logicalDb || !dbUser) continue;
      const key = `${group}\u0000${logicalDb}\u0000${dbUser}`;
      const entry = tally.get(key);
      if (entry) entry.count += 1;
      else tally.set(key, { count: 1, env: { group, logicalDb, dbUser } });
    }
    const best = [...tally.values()].sort((a, b) => b.count - a.count)[0];
    if (!best) {
      return {
        error: `No Datanet environment found for "${searchTerm}" — the user has no Datanet footprint yet. `
          + 'Ask the user for their team\'s Datanet GROUP NAME (visible on any of the team\'s DataCentral job pages), '
          + 'then call this tool again with that group.',
      };
    }
    return best.env;
  }

  async function ensureScratchPair(groupHint?: string): Promise<
    { profileId: number; jobId: string } | { error: string; nextAction: string }
  > {
    const alias = aliasForUser();
    const storedAlias = getSetting<string>(db, KEYS.alias);
    const storedProfile = getSetting<number>(db, KEYS.profileId);
    const storedJob = getSetting<string>(db, KEYS.jobId);
    if (storedAlias === alias && storedProfile && storedJob) {
      return { profileId: storedProfile, jobId: storedJob };
    }

    // Environment: cached → hint → own-footprint discovery.
    let env = getSetting<ScratchEnv>(db, KEYS.env) ?? null;
    if (!env) {
      const discovered = await discoverEnv(groupHint?.trim() || alias);
      if ('error' in discovered) {
        return {
          error: discovered.error,
          nextAction: 'Relay the question to the user, then retry mcp_etl_run_query with the group parameter set.',
        };
      }
      env = discovered;
      setSetting(db, KEYS.env, env);
    }

    // TRANSFORM pair — the proven creation path (EXTRACT is broken server-side).
    const profileResult = await call('datanet_create_profile', {
      sql: '/* NO DEPENDENCIES */\nselect 1 as botboy_scratch_init;',
      description: `BotBoy ad-hoc scratch profile for ${alias}. Reused for one-off queries via SQL revisions — `
        + 'revision history is expected. Managed automatically; safe to ignore.',
      profile_type: 'TRANSFORM',
      group: env.group,
    }, { ownerApproved: true });
    if (profileResult.isError) {
      return {
        error: `Could not create the scratch profile: ${firstLine(profileResult.text)}`,
        nextAction: 'Report this to the user; the Datanet group may not permit profile creation for them.',
      };
    }
    const profile = parseJson(profileResult.text);
    const profileId = Number(profile.id);
    if (!Number.isFinite(profileId) || profileId <= 0) {
      return {
        error: `Scratch profile creation returned no id: ${firstLine(profileResult.text)}`,
        nextAction: 'Report this to the user and stop.',
      };
    }

    const jobResult = await call('datanet_create_job', {
      profile_id: profileId,
      description: `BotBoy ad-hoc scratch job for ${alias} (NOT_SCHEDULED; runs only when asked).`,
      group: env.group,
      logical_db: env.logicalDb,
      db_user: env.dbUser,
      job_type: 'TRANSFORM',
      timezone: 'UTC',
      // Interactive ad-hoc work queues in Datanet's priority-ordered
      // compute-slot line (WFR). LOW (bucket 30) starved for 6+ minutes at
      // peak in live testing; HIGH (37) is the polite interactive default —
      // the in-flight PRIORITIZE rescue below covers the rest.
      priority: 'HIGH',
      partition_type: 'REGION',
      partition_value: 2,
      scheduled: false,
    }, { ownerApproved: true });
    if (jobResult.isError) {
      return {
        error: `Could not create the scratch job: ${firstLine(jobResult.text)}`,
        nextAction: 'The profile was created but the job step failed — call this tool again once; if it fails again, report the error to the user.',
      };
    }
    const job = parseJson(jobResult.text);
    const jobId = String(job.id ?? '').trim();
    if (!jobId || jobId === 'undefined') {
      return {
        error: `Scratch job creation returned no id: ${firstLine(jobResult.text)}`,
        nextAction: 'Report this to the user and stop.',
      };
    }

    setSetting(db, KEYS.alias, alias);
    setSetting(db, KEYS.profileId, profileId);
    setSetting(db, KEYS.jobId, jobId);
    console.log(`[EtlAdhoc] scratch pair created for ${alias}: profile ${profileId}, job ${jobId} (group ${env.group})`);
    return { profileId, jobId };
  }

  function clearPinnedPair(): void {
    setSetting(db, KEYS.profileId, null);
    setSetting(db, KEYS.jobId, null);
  }

  async function runQuery(input: { sql: string; datasetDate?: string; group?: string }): Promise<QueryRunResult> {
    const sqlBody = String(input.sql ?? '').trim();
    if (!sqlBody) return { ok: false, error: 'sql required', nextAction: 'Call again with the SQL to run.' };
    const sql = DEP_HEADER_RE.test(sqlBody.slice(0, 500))
      ? sqlBody
      : `/* NO DEPENDENCIES */\n${sqlBody}`;
    const datasetDate = (input.datasetDate ?? '').trim() || new Date(now()).toISOString().slice(0, 10);

    const pair = await ensureScratchPair(input.group);
    if ('error' in pair) return { ok: false, error: pair.error, nextAction: pair.nextAction };

    // ONE query at a time: Datanet collapses duplicate queued runs for the
    // same job + dataset date (live 2026-09-02: two back-to-back submissions
    // both queued at peak → the first run came back DELETED), and staging a
    // new SQL revision under a queued run risks it executing the wrong
    // query. Fail-open on unknown states — only the known in-flight ones
    // block, so a weird status can never brick the tool.
    const inFlight = new Set(['NEW', 'SUBMITTED', 'RUNNABLE', 'EXECUTING',
      'WAITING_FOR_RESOURCES', 'WAITING_FOR_REQUIREMENTS', 'WAITING_FOR_DEPENDENCIES']);
    const latest = await call('datanet_get_latest_run', { job_id: pair.jobId });
    if (!latest.isError) {
      const latestRun = parseJson(latest.text);
      const latestStatus = String(latestRun.status ?? '').toUpperCase();
      const latestId = String(latestRun.id ?? '');
      if (latestId && inFlight.has(latestStatus)) {
        return {
          ok: false,
          runId: latestId,
          error: `The ad-hoc job already has run ${latestId} in flight (${latestStatus}).`,
          nextAction: `One ETL query at a time: poll mcp_etl_job_run with runId ${latestId} and download its results on SUCCESS — submitting another query now would make Datanet collapse the queued run.`,
        };
      }
    }

    // New revision on the scratch profile. A vanished profile (deleted
    // server-side) re-creates the pair ONCE — self-heal, not a loop.
    let update = await call('datanet_update_profile_sql', {
      profile_id: String(pair.profileId),
      sql,
      profile_type: 'TRANSFORM',
    }, { ownerApproved: true });
    let profileId = pair.profileId;
    let jobId = pair.jobId;
    if (update.isError && /not.?found|does not exist/i.test(update.text)) {
      console.log('[EtlAdhoc] pinned scratch pair missing server-side — recreating once');
      clearPinnedPair();
      const fresh = await ensureScratchPair(input.group);
      if ('error' in fresh) return { ok: false, error: fresh.error, nextAction: fresh.nextAction };
      profileId = fresh.profileId;
      jobId = fresh.jobId;
      update = await call('datanet_update_profile_sql', {
        profile_id: String(profileId),
        sql,
        profile_type: 'TRANSFORM',
      }, { ownerApproved: true });
    }
    if (update.isError) {
      return {
        ok: false,
        error: `Could not stage the SQL on the scratch profile: ${firstLine(update.text)}`,
        nextAction: 'Fix the reported issue (usually SQL syntax rejected by Datanet validation) and call again once.',
      };
    }

    const submit = await call('datanet_submit_run', { job_id: jobId, dataset_date: datasetDate }, { ownerApproved: true });
    if (submit.isError) {
      return {
        ok: false,
        error: `Run submission failed: ${firstLine(submit.text)}`,
        nextAction: 'Report the reason to the user; do not resubmit blindly.',
      };
    }
    const submitted = parseJson(submit.text);
    const runId = String(submitted?.jobRuns?.[0]?.id ?? '').trim();
    if (!/^\d+$/.test(runId)) {
      return {
        ok: false,
        error: `Submission returned no run id: ${firstLine(submit.text)}`,
        nextAction: 'Check the job with mcp_etl_latest_run before retrying.',
      };
    }

    // Poll to a terminal state within the budget. WAITING_FOR_RESOURCES is a
    // compute-slot QUEUE ordered strictly by priority bucket — restarting
    // forfeits the queue position (BDT wiki), so the rescue for a stuck run
    // is Datanet's own "Prioritized Run" bucket (91) via PRIORITIZE, once.
    const deadline = now() + pollBudgetMs;
    const prioritizeAt = now() + prioritizeAfterMs;
    let prioritized = false;
    let status = 'SUBMITTED';
    while (now() < deadline) {
      await sleep(pollIntervalMs);
      const poll = await call('datanet_get_job_run_status', { run_id: runId });
      if (poll.isError) continue; // transient poll failures never kill the run
      status = String(parseJson(poll.text).status ?? '').toUpperCase() || status;
      if (status === 'SUCCESS' || status === 'ERROR' || status === 'KILLED' || status === 'DELETED') break;
      if (!prioritized && status === 'WAITING_FOR_RESOURCES' && now() >= prioritizeAt) {
        prioritized = true; // once, whatever the outcome — never a loop
        const bump = await call('datanet_alter_run', {
          run_id: runId,
          action: 'PRIORITIZE', // Datanet validates these names case-sensitively
          reason: 'BotBoy interactive ad-hoc query queued behind batch work',
        }, { ownerApproved: true });
        console.log(`[EtlAdhoc] run ${runId} stuck in WFR — PRIORITIZE ${bump.isError ? `failed: ${firstLine(bump.text, 120)}` : 'requested'}`);
      }
    }

    if (status === 'DELETED') {
      return {
        ok: false,
        runId,
        error: `Run ${runId} was deleted server-side while queued — usually a duplicate queued run for the same job and dataset date (Datanet collapses those).`,
        nextAction: 'Submit the query again ONCE, after confirming no other run is in flight for the ad-hoc job (mcp_etl_latest_run). If the new run is deleted too, stop and report.',
      };
    }
    if (status === 'ERROR' || status === 'KILLED') {
      const diagnose = await call('datanet_get_job_run_error', { run_id: runId });
      const diagnosed = parseJson(diagnose.text);
      const detail = diagnose.isError
        ? ''
        : firstLine(String(diagnosed.error ?? diagnosed.message ?? diagnose.text), 600);
      return {
        ok: false,
        runId,
        error: `Run ${runId} ${status}. ${detail || 'No error detail returned.'}`,
        nextAction: 'Fix the SQL per the root cause and call mcp_etl_run_query again ONCE. If it fails again for the same reason, stop and report.',
      };
    }
    if (status !== 'SUCCESS') {
      return {
        ok: false,
        runId,
        error: `Run ${runId} still ${status || 'running'} after ${Math.round(pollBudgetMs / 60000)} minutes.`,
        nextAction: `Do NOT resubmit — the run is alive. Check later with mcp_etl_job_run (runId ${runId}) and download with mcp_etl_download_results when SUCCESS.`,
      };
    }

    // Download + parse TSV.
    fs.mkdirSync(downloadDir, { recursive: true });
    const output = path.join(downloadDir, `adhoc_${runId}.tsv`);
    const download = await call('datanet_download_results', { run_id: runId, output });
    if (download.isError || !fs.existsSync(output)) {
      return {
        ok: false,
        runId,
        error: `Run ${runId} succeeded but the download failed: ${firstLine(download.text)}`,
        nextAction: `Retry mcp_etl_download_results with runId ${runId} once; results purge over time, so do it promptly.`,
      };
    }
    const raw = fs.readFileSync(output, 'utf8');
    const lines = raw.split('\n').filter(line => line.length > 0);
    const columns = (lines[0] ?? '').split('\t');
    const body = lines.slice(1);
    const rows = body.slice(0, maxRows).map(line => line.split('\t'));
    return {
      ok: true,
      runId,
      columns,
      rows,
      rowCount: body.length,
      truncated: body.length > maxRows,
      savedTo: output,
    };
  }

  return { id: 'etl', runQuery };
}
