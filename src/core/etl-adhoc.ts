/**
 * ETL ad-hoc query runner — the one-shot composite behind `mcp_etl_run_query`.
 *
 * Datanet has no "run SQL, get rows" primitive: the minimal path is
 * profile → job → run → poll → download. This module owns that dance so the
 * model sees ONE deterministic tool (etl-analytics map A1; practical-agent
 * framework: composite over dance).
 *
 * Namespace hygiene: Datanet profiles are visible to the user's whole group.
 * BotBoy keeps a bounded named POOL of scratch pairs per user (TRANSFORM
 * profile + NOT_SCHEDULED TRANSFORM job each) — created lazily on demand,
 * pinned in settings, and REUSED forever via SQL revisions. Parallel
 * queries claim distinct pairs: the only real Datanet constraint is per
 * JOB (duplicate queued runs for one job+dataset-date get collapsed), so
 * pool width = concurrency, all widgets of a dashboard at once (owner
 * ruling 2026-09-09). The TRANSFORM pair is load-bearing: the EXTRACT
 * creation path fails owner validation and its profiles are invisible to
 * the type detector (live-verified 2026-08-28, datanet-etl.md gotchas).
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
      if (!isSentryAuthShapedError(message)) {
        // Structured-errors invariant: no raw transport error may leave the
        // managed path (live 2026-09-04: three dashboard widgets surfaced
        // bare "MCP error -32001: Request timed out" — mid-run network loss
        // with no next action named).
        if (/timed?\s?out|-32001/i.test(message)) {
          return {
            isError: true,
            text: `Error: the Datanet ETL call ${toolName} timed out after ${Math.round(ETL_TOOL_TIMEOUT_MS / 60_000)} min — the transport, not the query. Likely the corp network/VPN dropped or Datanet is unresponsive. Check connectivity, then retry ONCE. If a run was already submitted, poll it (mcp_etl_run_status / mcp_etl_latest_run) instead of resubmitting — Datanet collapses duplicate queued runs.`,
          };
        }
        throw error;
      }
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
  /** The scratch-pair POOL (owner ruling 2026-09-09: dashboard widgets run
   * all-parallel; Datanet's queue takes it — the per-JOB serialization is
   * the only real constraint, so parallelism = more pairs). */
  pool: 'etl.adhoc.pairs',
  alias: 'etl.adhoc.alias',
  env: 'etl.adhoc.env', // { group, logicalDb, dbUser }
  /** Legacy single-pair keys — migrated into pool slot 1 on first acquire. */
  legacyProfileId: 'etl.adhoc.profile_id',
  legacyJobId: 'etl.adhoc.job_id',
} as const;

interface ScratchEnv { group: string; logicalDb: string; dbUser: string }

export interface ScratchPair { profileId: number; jobId: string; slot: number }

/**
 * Runaway fuse, NOT capacity policy: Datanet handles enormous parallel run
 * counts fine (owner ruling). This only stops a BotBoy bug from creating
 * profiles in a loop — same spirit as the local-folders EMFILE fuse.
 */
export const SCRATCH_POOL_FUSE = 32;

/** Claim ledgers shared across ALL runner instances on one db (chat runner
 * and dashboard runner must never claim the same pair concurrently). */
const claimLedgers = new WeakMap<Database.Database, Set<string>>();
const creationLocks = new WeakMap<Database.Database, Promise<void>>();

function ledgerFor(db: Database.Database): Set<string> {
  let ledger = claimLedgers.get(db);
  if (!ledger) { ledger = new Set(); claimLedgers.set(db, ledger); }
  return ledger;
}

/** Run-states that occupy a pair's job (submitting under these risks
 * Datanet's duplicate-collapse and SQL-revision clobber). */
const IN_FLIGHT_STATES = new Set(['NEW', 'SUBMITTED', 'RUNNABLE', 'EXECUTING',
  'WAITING_FOR_RESOURCES', 'WAITING_FOR_REQUIREMENTS', 'WAITING_FOR_DEPENDENCIES']);

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

  /** Pool read with alias guard + one-time migration of the legacy single
   * pair into slot 1. An alias change orphans the old pool (rare; the old
   * pairs stay server-side as inert NOT_SCHEDULED jobs). */
  function readPool(): ScratchPair[] {
    const alias = aliasForUser();
    const storedAlias = getSetting<string>(db, KEYS.alias);
    if (storedAlias && storedAlias !== alias) {
      setSetting(db, KEYS.pool, []);
      setSetting(db, KEYS.legacyProfileId, null);
      setSetting(db, KEYS.legacyJobId, null);
      setSetting(db, KEYS.alias, alias);
      return [];
    }
    let pool = getSetting<ScratchPair[]>(db, KEYS.pool) ?? [];
    if (!Array.isArray(pool)) pool = [];
    const legacyProfile = getSetting<number>(db, KEYS.legacyProfileId);
    const legacyJob = getSetting<string>(db, KEYS.legacyJobId);
    if (legacyProfile && legacyJob && !pool.some(pair => pair.jobId === String(legacyJob))) {
      pool = [{ profileId: legacyProfile, jobId: String(legacyJob), slot: 1 }, ...pool];
      setSetting(db, KEYS.pool, pool);
      setSetting(db, KEYS.legacyProfileId, null);
      setSetting(db, KEYS.legacyJobId, null);
    }
    return pool;
  }

  function writePool(pool: ScratchPair[]): void {
    setSetting(db, KEYS.pool, pool);
    setSetting(db, KEYS.alias, aliasForUser());
  }

  function prunePair(jobId: string): void {
    writePool(readPool().filter(pair => pair.jobId !== jobId));
  }

  /** Create ONE new pair (TRANSFORM+TRANSFORM — the proven path; EXTRACT is
   * broken server-side) and append it to the pool. */
  async function createPair(slot: number, groupHint?: string): Promise<ScratchPair | { error: string; nextAction: string }> {
    const alias = aliasForUser();

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

    const slotLabel = slot > 1 ? ` (parallel slot ${slot})` : '';
    const profileResult = await call('datanet_create_profile', {
      sql: '/* NO DEPENDENCIES */\nselect 1 as botboy_scratch_init;',
      description: `BotBoy ad-hoc scratch profile for ${alias}${slotLabel}. Reused for one-off queries via SQL revisions — `
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
      description: `BotBoy ad-hoc scratch job for ${alias}${slotLabel} (NOT_SCHEDULED; runs only when asked).`,
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

    const pair: ScratchPair = { profileId, jobId, slot };
    writePool([...readPool(), pair]);
    console.log(`[EtlAdhoc] scratch pair created for ${alias} (slot ${slot}): profile ${profileId}, job ${jobId}`);
    return pair;
  }

  /** Is this pair's job occupied by a live run? Fails OPEN (an unreadable
   * latest-run never bricks the tool — the DELETED terminal handling covers
   * the rare wrong guess, exactly as before the pool). */
  async function pairBusy(pair: ScratchPair): Promise<{ busy: boolean; runId?: string }> {
    const latest = await call('datanet_get_latest_run', { job_id: pair.jobId });
    if (latest.isError) return { busy: false };
    const latestRun = parseJson(latest.text);
    const status = String(latestRun.status ?? '').toUpperCase();
    const runId = String(latestRun.id ?? '');
    if (runId && IN_FLIGHT_STATES.has(status)) return { busy: true, runId };
    return { busy: false };
  }

  interface PairHandle { pair: ScratchPair; release(): void }

  /**
   * Claim a free pair, growing the pool on demand (all widgets of a
   * dashboard run in parallel — owner ruling 2026-09-09). Claim ledger is
   * process-wide per db; busy pairs (e.g. a chat run handed off alive) are
   * skipped, not waited on.
   */
  async function acquirePair(groupHint?: string): Promise<PairHandle | { error: string; nextAction: string }> {
    const claimed = ledgerFor(db);
    for (;;) {
      const pool = readPool();
      for (const pair of pool) {
        if (claimed.has(pair.jobId)) continue;
        claimed.add(pair.jobId); // synchronous claim — atomic between awaits
        const occupancy = await pairBusy(pair);
        if (!occupancy.busy) {
          return { pair, release: () => { claimed.delete(pair.jobId); } };
        }
        claimed.delete(pair.jobId); // busy server-side (alive handoff) — leave it be
      }
      if (pool.length >= SCRATCH_POOL_FUSE) {
        return {
          error: `All ${pool.length} scratch pairs are occupied and the pool is at its runaway fuse (${SCRATCH_POOL_FUSE}).`,
          nextAction: 'This many simultaneous ETL queries is almost certainly a bug — check for stuck runs with mcp_etl_latest_run on the scratch jobs, and report to the user.',
        };
      }
      // Grow the pool by one, serialized so concurrent widgets never
      // double-create the same slot.
      const previous = creationLocks.get(db) ?? Promise.resolve();
      let outcome: ScratchPair | { error: string; nextAction: string } | null = null;
      const next = previous.then(async () => {
        const fresh = readPool();
        if (fresh.length > pool.length) return; // someone else already grew it
        outcome = await createPair(fresh.length + 1, groupHint);
      }).catch(() => undefined);
      creationLocks.set(db, next);
      await next;
      if (outcome && 'error' in (outcome as any)) return outcome as { error: string; nextAction: string };
      // Loop: re-read the pool and claim (the new pair, or any freed one).
    }
  }

  async function runQuery(input: { sql: string; datasetDate?: string; group?: string }): Promise<QueryRunResult> {
    const sqlBody = String(input.sql ?? '').trim();
    if (!sqlBody) return { ok: false, error: 'sql required', nextAction: 'Call again with the SQL to run.' };
    const sql = DEP_HEADER_RE.test(sqlBody.slice(0, 500))
      ? sqlBody
      : `/* NO DEPENDENCIES */\n${sqlBody}`;
    const datasetDate = (input.datasetDate ?? '').trim() || new Date(now()).toISOString().slice(0, 10);

    // Acquire a pair from the pool. Per-JOB serialization is the only real
    // Datanet constraint (duplicate queued runs for one job + dataset date
    // are collapsed — live 2026-09-02, first run came back DELETED; and a
    // SQL revision under a queued run risks executing the wrong query).
    // Parallelism across DIFFERENT pairs is unbounded by design (owner
    // ruling 2026-09-09): busy pairs are skipped and the pool grows.
    const handle = await acquirePair(input.group);
    if ('error' in handle) return { ok: false, error: handle.error, nextAction: handle.nextAction };

    try {
      // New revision on the claimed pair. A vanished profile (deleted
      // server-side) prunes THIS pair and re-creates once — self-heal, not a loop.
      let update = await call('datanet_update_profile_sql', {
        profile_id: String(handle.pair.profileId),
        sql,
        profile_type: 'TRANSFORM',
      }, { ownerApproved: true });
      let profileId = handle.pair.profileId;
      let jobId = handle.pair.jobId;
      if (update.isError && /not.?found|does not exist/i.test(update.text)) {
        console.log(`[EtlAdhoc] scratch pair (slot ${handle.pair.slot}) missing server-side — recreating once`);
        prunePair(handle.pair.jobId);
        handle.release();
        const fresh = await acquirePair(input.group);
        if ('error' in fresh) return { ok: false, error: fresh.error, nextAction: fresh.nextAction };
        // Hand off to the replacement pair for the rest of the flow.
        (handle as { pair: ScratchPair; release(): void }).pair = fresh.pair;
        (handle as { pair: ScratchPair; release(): void }).release = fresh.release;
        profileId = fresh.pair.profileId;
        jobId = fresh.pair.jobId;
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
    } finally {
      // Pair goes back to the pool whatever happened. A run handed off
      // alive (budget exhausted) keeps its job busy SERVER-side — the next
      // acquisition's pairBusy check skips it until the run terminalizes.
      handle.release();
    }
  }

  return { id: 'etl', runQuery };
}
