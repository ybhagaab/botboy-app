import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, setSetting, type StorageLayer } from './storage.js';
import { createNodeManager } from './node-manager.js';
import { createChatJobStore, type ChatJobStore } from './chat-jobs.js';
import { createDataRoomDatasetParametersSchema } from './analytics-job-tool-schema.js';
import {
  createToolExecutor,
  dataRoomImportRequestId,
  ETL_MAX_WAIT_SECONDS,
  etlWaitSeconds,
  RUN_COMMAND_EXECUTOR_TIMEOUT_MS,
  toolRunsWithoutExecutorCap,
  withDatasetRequestDefaults,
  type ToolExecutionContext,
} from './tool-executor.js';

/**
 * Async ETL from chat (ANALYTICS_AUTONOMY_PLAN.md P1/P2): a run outlives the
 * call, so the call registers a watch for the owner's job instead of timing
 * out, and the result lands in the files workspace.
 */
describe('async ETL tools', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  let resultsDir: string;
  let status: string;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    setSetting(storage.getDb(), 'grasp_sync.owner_name', 'Bhagat, AB');
    setSetting(storage.getDb(), 'grasp_sync.owner_email', 'ybhagaab@amazon.com');
    jobs = createChatJobStore(storage.getDb());
    resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-async-'));
    status = 'EXECUTING';
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(resultsDir, { recursive: true, force: true });
  });

  /** The a2-analytics surface the scratch runner drives. */
  function fakeMcp() {
    const calls: string[] = [];
    const searchDoc = { job_group_name: 'Team-Group-ETLM', job_logical_db_name: 'team-db', job_db_user_name: 'amzn:cdo:datanet-dbuser:team_etl_npe' };
    const reply = (toolName: string, text: string) => ({ isError: false, text, serverId: 'a2-analytics', toolName });
    const callTool = vi.fn(async (_server: string, toolName: string, args: Record<string, unknown>) => {
      calls.push(toolName);
      switch (toolName) {
        case 'datanet_search': return reply(toolName, JSON.stringify({ found: 1, searchResults: [{ document: searchDoc }] }));
        case 'datanet_create_profile': return reply(toolName, JSON.stringify({ id: 101, type: 'TRANSFORM', revision: 1 }));
        case 'datanet_create_job': return reply(toolName, JSON.stringify({ id: 9001, schedule: { type: 'NOT_SCHEDULED' } }));
        case 'datanet_update_profile_sql': return reply(toolName, JSON.stringify({ id: 101, revision: 2 }));
        case 'datanet_submit_run': return reply(toolName, JSON.stringify({ jobRuns: [{ id: 777001 }] }));
        case 'datanet_get_job_run_status': return reply(toolName, JSON.stringify({ status }));
        case 'datanet_get_job_run_error': return reply(toolName, JSON.stringify({ error: 'column "nope" does not exist' }));
        case 'datanet_download_results':
          fs.mkdirSync(path.dirname(String(args.output)), { recursive: true });
          fs.writeFileSync(String(args.output), 'week\tplayers\n2026-W40\t1234\n');
          return reply(toolName, `saved to ${args.output}`);
        default: return { isError: true, text: `no fake for ${toolName}`, serverId: 'a2-analytics', toolName };
      }
    });
    return { callTool, calls };
  }

  const executor = (mcp = fakeMcp()) => createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
    mcpManager: { callTool: mcp.callTool } as any,
    chatJobs: jobs,
    etlResultsDir: path.join(resultsDir, 'files', 'etl-results'),
  });
  const run = async (exec: ReturnType<typeof executor>, name: string, args: Record<string, unknown>, context?: ToolExecutionContext) => {
    const result = await exec.executeTool({ id: `${name}-1`, type: 'function', function: { name, arguments: JSON.stringify(args) } }, context);
    try { return JSON.parse(result.content); } catch { return result.content; }
  };
  const owner: ToolExecutionContext = { callerKind: 'interactive', currentUserMessage: 'Weekly PV players for Local', ownerRequestId: 'req-00000001' };

  it('a run that outlives the wait is watched for a job started from the owner request', async () => {
    const exec = executor();
    const outcome = await run(exec, 'mcp_etl_run_query', { sql: 'select 1', waitSeconds: 0, purpose: 'weekly players', ownerRequested: true }, owner);
    expect(outcome).toMatchObject({ ok: false, code: 'alive_handoff', runId: '777001' });
    expect(outcome.nextAction).toContain('BotBoy is watching run 777001');
    expect(outcome.nextAction).toContain('wait_for_etl_run');
    const job = jobs.activeJob()!;
    expect(job.goal).toBe('Weekly PV players for Local');
    expect(jobs.watch('777001')).toMatchObject({ jobId: job.id, status: 'pending', purpose: 'weekly players', source: 'run_query' });
  });

  it('the scratch runner can prioritize an existing run once, and nothing else', async () => {
    const mcp = fakeMcp();
    mcp.callTool.mockImplementationOnce(async (_server: string, toolName: string) => ({ isError: false, text: '{"ok":true}', serverId: 'a2-analytics', toolName }));
    const { createEtlQueryRunner, createEtlToolCall } = await import('./etl-adhoc.js');
    const runner = createEtlQueryRunner({ db: storage.getDb(), call: createEtlToolCall({ callTool: mcp.callTool } as any), downloadDir: resultsDir });
    expect(await runner.prioritizeRun!({ runId: 'not-a-run' })).toMatchObject({ ok: false });
    expect(await runner.prioritizeRun!({ runId: '777001' })).toEqual({ ok: true });
    expect(mcp.callTool.mock.calls.map(call => [call[1], call[2]])).toEqual([
      ['datanet_alter_run', { run_id: '777001', action: 'PRIORITIZE', reason: expect.any(String) }],
    ]);
  });

  it('a run that finishes in the wait returns rows and a workspace file, and needs no continuation', async () => {
    status = 'SUCCESS';
    const outcome = await run(executor(), 'mcp_etl_run_query', { sql: 'select 1', waitSeconds: 1, ownerRequested: true }, owner);
    expect(outcome).toMatchObject({ ok: true, runId: '777001', rowCount: 1, workspacePath: 'etl-results/adhoc_777001.tsv' });
    expect(fs.existsSync(outcome.savedTo)).toBe(true);
    expect(jobs.watch('777001')).toMatchObject({ status: 'finished', consumedAt: expect.any(String) });
    expect(jobs.unconsumedFinished(jobs.activeJob()!.id)).toEqual([]);
  });

  it('a background caller neither starts a job nor watches its run', async () => {
    const outcome = await run(executor(), 'mcp_etl_run_query', { sql: 'select 1', waitSeconds: 0, ownerRequested: true }, { callerKind: 'background', currentUserMessage: 'diagnose' });
    expect(outcome.code).toBe('alive_handoff');
    expect(jobs.activeJob()).toBeNull();
    expect(jobs.watch('777001')).toBeNull();
    expect(outcome.nextAction).toContain('wait_for_etl_run');
  });

  it('wait_for_etl_run returns a finished run and consumes its watch', async () => {
    const exec = executor();
    await run(exec, 'mcp_etl_run_query', { sql: 'select 1', waitSeconds: 0, ownerRequested: true }, owner);
    status = 'SUCCESS';
    const waited = await run(exec, 'wait_for_etl_run', { runId: '777001', waitSeconds: 5 }, owner);
    expect(waited).toMatchObject({ ok: true, runId: '777001', workspacePath: 'etl-results/adhoc_777001.tsv' });
    expect(waited.nextAction).toContain('Use it');
    expect(jobs.watch('777001')).toMatchObject({ status: 'finished', consumedAt: expect.any(String) });
  });

  it('wait_for_etl_run on a still-running run hands it to the watcher, and stops waiting with the turn', async () => {
    const exec = executor();
    const timedOut = await run(exec, 'wait_for_etl_run', { runId: '888001', waitSeconds: 0 }, owner);
    expect(timedOut).toMatchObject({ code: 'alive_handoff', runId: '888001' });
    expect(timedOut.nextAction).toContain('BotBoy is watching run 888001');
    expect(jobs.watch('888001')).toMatchObject({ status: 'pending', source: 'wait' });

    const abort = new AbortController();
    const started = Date.now();
    const pending = run(exec, 'wait_for_etl_run', { runId: '888001', waitSeconds: 600 }, { ...owner, abortSignal: abort.signal });
    setTimeout(() => abort.abort(), 50);
    await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a failed run reports its root cause with a fix-and-retry next action', async () => {
    status = 'ERROR';
    const outcome = await run(executor(), 'mcp_etl_run_query', { sql: 'select nope', waitSeconds: 1, ownerRequested: true }, owner);
    expect(outcome).toMatchObject({ ok: false, code: 'remote_failed', runId: '777001' });
    expect(outcome.error).toContain('column "nope" does not exist');
    expect(outcome.nextAction).toContain('same failure repeats three times');
    expect(jobs.watch('777001')).toMatchObject({ status: 'finished', outcome: { remoteStatus: 'ERROR' } });
  });

  it('downloads land in the files workspace and settle a watched run', async () => {
    const exec = executor();
    const job = jobs.start({ goal: 'g' });
    jobs.addWatch({ runId: '555', jobId: job.id, source: 'run_query' });
    const outcome = await run(exec, 'mcp_etl_download_results', { runId: '555' }, owner);
    const result = JSON.parse(outcome.result);
    expect(result).toMatchObject({ runId: '555', workspacePath: 'etl-results/run_555.tsv' });
    expect(result.note).toContain('run_command');
    expect(jobs.watch('555')).toMatchObject({ status: 'finished', consumedAt: expect.any(String) });
  });

  it('job_update starts only from an owner turn, records the working set, and closes the job', async () => {
    const exec = executor();
    const refused = await run(exec, 'job_update', { action: 'start', goal: 'x' }, { callerKind: 'continuation', jobMandate: { jobId: 'cj_x', goal: 'x' } });
    expect(refused).toMatchObject({ ok: false, code: 'owner_turn_required' });
    const started = await run(exec, 'job_update', { action: 'start', nextStep: 'Pull Local weekly', notes: ['IST weeks'] }, owner);
    expect(started).toMatchObject({ ok: true, job: { goal: 'Weekly PV players for Local', status: 'active' } });
    const jobId = started.job.id;
    jobs.addWatch({ runId: '1', jobId, source: 'run_query' });
    const updated = await run(exec, 'job_update', { action: 'update', nextStep: 'Join lanes' }, { callerKind: 'continuation', jobMandate: { jobId, goal: 'g' } });
    expect(updated).toMatchObject({ ok: true, job: { nextStep: 'Join lanes', notes: 1 } });
    const done = await run(exec, 'job_update', { action: 'done', summary: 'Dashboard dash_1 verified' }, owner);
    expect(done).toMatchObject({ ok: true, job: { status: 'done' } });
    expect(done.note).toContain('Runs 1 were still running');
    expect(jobs.get(jobId)).toMatchObject({ status: 'done', endReason: 'Dashboard dash_1 verified' });
    expect(await run(exec, 'job_update', { action: 'done' }, owner)).toMatchObject({ ok: false, code: 'no_active_job' });
  });

  it('ETL and shell tools run on their own bounded waits, not the executor caps', () => {
    for (const name of ['mcp_etl_run_query', 'wait_for_etl_run', 'mcp_etl_download_results']) expect(toolRunsWithoutExecutorCap(name)).toBe(true);
    expect(toolRunsWithoutExecutorCap('mcp_etl_job_run')).toBe(false);
    expect(RUN_COMMAND_EXECUTOR_TIMEOUT_MS).toBeGreaterThan(600_000);
    expect(etlWaitSeconds(undefined, 90)).toBe(90);
    expect(etlWaitSeconds(0, 90)).toBe(0);
    expect(etlWaitSeconds(99_999, 90)).toBe(ETL_MAX_WAIT_SECONDS);
    expect(etlWaitSeconds('abc', 300)).toBe(300);
  });
});

describe('Data Room imports in one turn', () => {
  const source = (overrides: Record<string, unknown> = {}) => ({ kind: 'local_file', alias: 'a', path: 'etl-results/a.tsv', target: { name: 'A' }, ...overrides });

  it('gives each independent source its own request id, stable for a resend', () => {
    const base = 'req-00000001';
    const one = dataRoomImportRequestId(base, { sources: [source()] });
    expect(one).toMatch(/^req-00000001:[a-f0-9]{16}$/);
    expect(dataRoomImportRequestId(base, { sources: [source({ alias: 'renamed', target: { name: 'B' } })] })).toBe(one);
    expect(dataRoomImportRequestId(base, { sources: [source({ path: 'etl-results/b.tsv' })] })).not.toBe(one);
    expect(dataRoomImportRequestId(base, { sources: [source({ into: { datasetId: 'ds_x', mode: 'merge_partitions' } })] })).not.toBe(one);
    const long = dataRoomImportRequestId('x'.repeat(128), { sources: [source()] });
    expect(long.length).toBeLessThanOrEqual(128);
    expect(long).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
  });

  it('advertises that a coverage may prove no partition complete', () => {
    expect(JSON.stringify(createDataRoomDatasetParametersSchema())).toContain('"completeRanges":{"type":"array","minItems":0');
  });

  it('defaults omitted request dimensions and filters to none', () => {
    expect(withDatasetRequestDefaults({ request: { domainKey: 'ott' } })).toEqual({ request: { domainKey: 'ott', dimensions: [], filters: [] } });
    const explicit = { request: { dimensions: ['city'], filters: [] } };
    expect(withDatasetRequestDefaults(explicit)).toBe(explicit);
    expect(withDatasetRequestDefaults('not a plan')).toBe('not a plan');
  });
});

describe('Data Room create under the job mandate', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
  });
  afterEach(() => storage.close());

  const plan = { version: 1, mode: 'dataset_preparation', request: { domainKey: 'ott' }, sources: [{ kind: 'local_file', alias: 'a', path: 'etl-results/a.tsv' }], fragments: [], terminal: { kind: 'source', alias: 'a' } };
  const make = (prepareOrJoinAndWait: (...args: any[]) => Promise<any>) => createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
    chatJobs: jobs,
    analyticsJobService: { prepareOrJoinAndWait } as any,
    analyticsJobOwnerId: 'owner',
  });
  const create = async (exec: ReturnType<typeof make>, context: ToolExecutionContext) => JSON.parse((await exec.executeTool({
    id: 'c1', type: 'function', function: { name: 'create_data_room_dataset', arguments: JSON.stringify({ action: 'create', ownerRequested: true, plan }) },
  }, context)).content);

  it('runs for a continuation of an active job, with the per-import request id and request defaults', async () => {
    const prepare = vi.fn(async () => ({ status: 'in_progress', jobId: `aj_${'b'.repeat(32)}`, trust: 'verified_analytics_job_receipt' }));
    const exec = make(prepare);
    const job = jobs.start({ goal: 'Import the weekly file' });
    const receipt = await create(exec, { callerKind: 'continuation', jobMandate: { jobId: job.id, goal: job.goal }, currentUserMessage: job.goal, ownerRequestId: 'cont:cjx:1' });
    expect(receipt).toMatchObject({ status: 'in_progress' });
    const [owner, sentPlan] = prepare.mock.calls[0] as unknown as [any, any];
    expect(owner.requestId).toMatch(/^cont:cjx:1:[a-f0-9]{16}$/);
    expect(owner.message).toBe('Import the weekly file');
    expect(sentPlan.request).toMatchObject({ dimensions: [], filters: [] });

    jobs.end(job.id, 'stopped', 'owner');
    const refused = await create(exec, { callerKind: 'continuation', jobMandate: { jobId: job.id, goal: job.goal }, currentUserMessage: job.goal, ownerRequestId: 'cont:cjx:2' });
    expect(refused).toMatchObject({ type: 'data_room_tool_failure', code: 'owner_context_required' });
  });

  it('reports a changed plan for an already-admitted source as a known no-effect conflict', async () => {
    const existingJobId = `aj_${'c'.repeat(32)}`;
    const prepare = vi.fn(async () => {
      throw Object.assign(new Error('Owner request ID is already bound to a different analytics job intent.'), { code: 'conflict', ownerRequestConflict: true, existingJobId });
    });
    const failure = await create(make(prepare), { callerKind: 'interactive', currentUserMessage: 'import it', ownerRequestId: 'req-00000002' });
    expect(failure).toMatchObject({
      code: 'source_already_admitted',
      effect: { state: 'none', mutationApplied: false },
      target: { jobId: existingJobId },
    });
    expect(failure.nextAction).toContain(`"jobId":"${existingJobId}"`);
  });
});
