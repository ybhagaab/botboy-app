import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, setSetting, type StorageLayer } from './storage.js';
import { createNodeManager } from './node-manager.js';
import { createChatJobStore, type ChatJobStore } from './chat-jobs.js';
import { createDataRoomDatasetParametersSchema } from './analytics-job-tool-schema.js';
import { resetEtlDownloadsForTests } from './etl-downloads.js';
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
    resetEtlDownloadsForTests();
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
  /** A main chat turn from the chat route: it can hold provisional jobs and hand jobs off (PARALLEL_JOBS_PLAN.md §6). */
  const mainTurn = (): ToolExecutionContext => ({ ...owner, heldJobIds: [], startedJobIds: [], turnModelKey: 'team.sol', turnThinking: 'high' });

  it('a run that outlives the wait is watched for a job started from the owner request', async () => {
    const exec = executor();
    const outcome = await run(exec, 'mcp_etl_run_query', { sql: 'select 1', waitSeconds: 0, purpose: 'weekly players', ownerRequested: true }, owner);
    expect(outcome).toMatchObject({ ok: false, code: 'alive_handoff', runId: '777001' });
    expect(outcome.nextAction).toContain('BotBoy is watching run 777001');
    expect(outcome.nextAction).toContain('wait_for {"kind":"etl_run","id":"777001"');
    const job = jobs.activeJobs()[0]!;
    expect(job.goal).toBe('Weekly PV players for Local');
    expect(jobs.watch('777001')).toMatchObject({ jobId: job.id, status: 'pending', purpose: 'weekly players', source: 'run_query' });
  });

  it('a main chat turn\'s runs belong to ONE provisional job it holds, started on the turn\'s model', async () => {
    const exec = executor();
    const context = mainTurn();
    await run(exec, 'mcp_etl_run_query', { sql: 'select 1', waitSeconds: 0, ownerRequested: true }, context);
    expect(context.heldJobIds).toHaveLength(1);
    const held = jobs.get(context.heldJobIds![0])!;
    expect(held).toMatchObject({ seq: 0, status: 'active', modelKey: 'team.sol', thinking: 'high', goal: 'Weekly PV players for Local' });
    expect(jobs.watch('777001')).toMatchObject({ jobId: held.id });
    // A second run in the same turn joins the same job.
    await run(exec, 'wait_for_etl_run', { runId: '888001', waitSeconds: 0 }, context);
    expect(jobs.watch('888001')).toMatchObject({ jobId: held.id });
    expect(context.heldJobIds).toHaveLength(1);
    // In a job's own thread, the runs are that job's.
    const threadJob = jobs.start({ goal: 'thread job' });
    await run(exec, 'wait_for_etl_run', { runId: '888002', waitSeconds: 0 }, { ...owner, threadJobId: threadJob.id, heldJobIds: [] });
    expect(jobs.watch('888002')).toMatchObject({ jobId: threadJob.id });
  });

  it('job_update start hands off: a numbered job with its first turn due, on the named model or the turn\'s', async () => {
    const exec = executor();
    const nudged: string[] = [];
    const context = { ...mainTurn(), nudgeJobs: (id: string) => nudged.push(id), resolveJobModel: (name: string) => (/sonnet/i.test(name) ? { key: 'anthropic.sonnet', title: 'Claude Sonnet' } : { error: 'No connected model matches.', offered: ['GPT-6.1 Sol'] }) };
    const plain = await run(exec, 'job_update', { action: 'start', title: 'PV players', nextStep: 'Pull Local weekly' }, context);
    expect(plain).toMatchObject({ ok: true, job: { number: 1, title: 'PV players', status: 'active' } });
    expect(plain.note).toMatch(/ONE short sentence/);
    expect(jobs.get(plain.job.id)).toMatchObject({ modelKey: 'team.sol', thinking: 'high', continueReason: 'The owner just handed this job off from the main chat.', continueRequestedAt: expect.any(String) });
    const named = await run(exec, 'job_update', { action: 'start', goal: 'Draft the note', model: 'Claude Sonnet' }, context);
    expect(named).toMatchObject({ ok: true, job: { number: 2, model: 'Claude Sonnet' } });
    expect(jobs.get(named.job.id)?.modelKey).toBe('anthropic.sonnet');
    expect(await run(exec, 'job_update', { action: 'start', goal: 'x', model: 'Gemini' }, context)).toMatchObject({ ok: false, code: 'model_not_offered' });
    expect(context.startedJobIds).toEqual([plain.job.id, named.job.id]);
    expect(nudged).toEqual([plain.job.id, named.job.id]);
    expect(jobs.activeJobs()).toHaveLength(2); // the refused start made nothing
  });

  it('job_update start after the turn ran ETL hands off THAT job: it surfaces with a number instead of a second job', async () => {
    const exec = executor();
    const context = mainTurn();
    await run(exec, 'mcp_etl_run_query', { sql: 'select 1', waitSeconds: 0, ownerRequested: true }, context);
    const heldId = context.heldJobIds![0];
    const handed = await run(exec, 'job_update', { action: 'start', title: 'Weekly PV players' }, context);
    expect(handed.job.id).toBe(heldId);
    expect(jobs.get(heldId)).toMatchObject({ seq: 1, title: 'Weekly PV players' });
    // Its run is still pending: the run's finish continues it, so no first turn is made due now.
    expect(jobs.get(heldId)?.continueRequestedAt).toBeUndefined();
    expect(context.heldJobIds).toEqual([]);
    expect(context.startedJobIds).toEqual([heldId]);
    expect(jobs.activeJobs()).toHaveLength(1);
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
    expect(jobs.unconsumedFinished(jobs.activeJobs()[0]!.id)).toEqual([]);
  });

  it('a background caller neither starts a job nor watches its run', async () => {
    const outcome = await run(executor(), 'mcp_etl_run_query', { sql: 'select 1', waitSeconds: 0, ownerRequested: true }, { callerKind: 'background', currentUserMessage: 'diagnose' });
    expect(outcome.code).toBe('alive_handoff');
    expect(jobs.activeJobs()).toEqual([]);
    expect(jobs.watch('777001')).toBeNull();
    expect(outcome.nextAction).toContain('wait_for {"kind":"etl_run","id":"777001"');
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

  it('one download per run: the download tool uses the result BotBoy already has in the files workspace (etl-downloads.ts)', async () => {
    const mcp = fakeMcp();
    const exec = executor(mcp);
    status = 'SUCCESS';
    // The run finished in a wait: the runner downloaded it as adhoc_777001.tsv.
    const waited = await run(exec, 'wait_for_etl_run', { runId: '777001', waitSeconds: 0 }, owner);
    expect(waited).toMatchObject({ ok: true, rowCount: 1, workspacePath: 'etl-results/adhoc_777001.tsv' });
    expect(mcp.calls.filter(name => name === 'datanet_download_results')).toHaveLength(1);
    const downloaded = await run(exec, 'mcp_etl_download_results', { runId: '777001' }, owner);
    const result = JSON.parse(downloaded.result);
    expect(result).toMatchObject({ runId: '777001', workspacePath: 'etl-results/adhoc_777001.tsv', preview: 'week\tplayers\n2026-W40\t1234\n' });
    expect(result.reused).toContain('nothing was downloaded again');
    expect(mcp.calls.filter(name => name === 'datanet_download_results')).toHaveLength(1);
  });

  it('a download that outlasts the connector is waited for, in the download tool and in wait_for_etl_run alike', async () => {
    const mcp = fakeMcp();
    mcp.callTool.mockImplementation(async (_server: string, toolName: string) => {
      if (toolName === 'datanet_get_job_run_status') return { isError: false, text: JSON.stringify({ status: 'SUCCESS' }), serverId: 'a2-analytics', toolName };
      if (toolName === 'datanet_download_results') {
        mcp.calls.push(toolName);
        // The connector's own 5-minute answer; its background download has not written the file yet.
        return { isError: false, text: '{"error": "Timeout", "message": "Tool \'datanet_download_results\' exceeded 300s timeout."}', serverId: 'a2-analytics', toolName };
      }
      return { isError: true, text: `no fake for ${toolName}`, serverId: 'a2-analytics', toolName };
    });
    const exec = executor(mcp);
    const first = await run(exec, 'mcp_etl_download_results', { runId: '901' }, owner);
    expect(first).toMatchObject({ ok: false, code: 'download_landing', runId: '901' });
    expect(first.error).toContain('still downloading');
    expect(first.nextAction).toContain('Do not download it again');
    const again = await run(exec, 'mcp_etl_download_results', { runId: '901' }, owner);
    expect(again).toMatchObject({ code: 'download_landing' });
    const waited = await run(exec, 'wait_for_etl_run', { runId: '902', waitSeconds: 0 }, owner);
    expect(waited).toMatchObject({ ok: false, code: 'download_landing', runId: '902' });
    expect(waited.nextAction).toContain('Do not download it again or resubmit the run');
    expect(mcp.calls.filter(name => name === 'datanet_download_results')).toHaveLength(2); // one per run, never twice
  });

  it('the download tool takes its own timed-out download once the file lands, asking the connector once', async () => {
    const mcp = fakeMcp();
    mcp.callTool.mockImplementation(async (_server: string, toolName: string) => {
      if (toolName === 'datanet_get_job_run_status') return { isError: false, text: JSON.stringify({ status: 'SUCCESS' }), serverId: 'a2-analytics', toolName };
      if (toolName === 'datanet_download_results') {
        mcp.calls.push(toolName);
        return { isError: false, text: '{"error": "Timeout", "message": "Tool \'datanet_download_results\' exceeded 300s timeout."}', serverId: 'a2-analytics', toolName };
      }
      return { isError: true, text: `no fake for ${toolName}`, serverId: 'a2-analytics', toolName };
    });
    let clock = Date.now();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const exec = executor(mcp);
      expect(await run(exec, 'mcp_etl_download_results', { runId: '903' }, owner)).toMatchObject({ code: 'download_landing' });
      // The connector's background download writes the file.
      const file = path.join(resultsDir, 'files', 'etl-results', 'run_903.tsv');
      fs.writeFileSync(file, 'week\tplayers\n2026-W41\t99\n');
      fs.utimesSync(file, new Date(clock), new Date(clock));
      clock += 1_000;
      expect(await run(exec, 'mcp_etl_download_results', { runId: '903' }, owner)).toMatchObject({ code: 'download_landing' }); // first sighting
      clock += 20_000;
      const landed = await run(exec, 'mcp_etl_download_results', { runId: '903' }, owner);
      expect(JSON.parse(landed.result)).toMatchObject({ runId: '903', workspacePath: 'etl-results/run_903.tsv', preview: 'week\tplayers\n2026-W41\t99\n' });
      expect(mcp.calls.filter(name => name === 'datanet_download_results')).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('delete_working_file: a job deletes its own raw download once its gzip copy matches; outside a job it refuses', async () => {
    const exec = executor();
    const job = jobs.start({ goal: 'Local study' });
    const filesDir = path.join(resultsDir, 'files');
    fs.mkdirSync(path.join(filesDir, 'etl-results'), { recursive: true });
    const raw = 'uuid\na\nb\n';
    fs.writeFileSync(path.join(filesDir, 'etl-results', 'adhoc_1.tsv'), raw);
    fs.writeFileSync(path.join(filesDir, 'etl-results', 'adhoc_1.tsv.gz'), gzipSync(raw));
    const args = { path: 'etl-results/adhoc_1.tsv', keptCopy: 'etl-results/adhoc_1.tsv.gz' };
    expect(await run(exec, 'delete_working_file', args, owner)).toMatchObject({ ok: false, code: 'job_required' });
    expect(fs.existsSync(path.join(filesDir, 'etl-results', 'adhoc_1.tsv'))).toBe(true);
    const deleted = await run(exec, 'delete_working_file', args, { callerKind: 'continuation', jobMandate: { jobId: job.id, goal: 'Local study' } });
    expect(deleted).toMatchObject({ ok: true, deleted: 'etl-results/adhoc_1.tsv', keptCopy: 'etl-results/adhoc_1.tsv.gz', bytesFreed: raw.length });
    expect(fs.existsSync(path.join(filesDir, 'etl-results', 'adhoc_1.tsv'))).toBe(false);
    // The owner, in the job's own thread, uses the same tool and the same checks.
    fs.writeFileSync(path.join(filesDir, 'b.tsv'), raw);
    expect(await run(exec, 'delete_working_file', { path: 'b.tsv', keptCopy: 'etl-results/adhoc_1.tsv.gz' }, { ...owner, threadJobId: job.id })).toMatchObject({ ok: true, deleted: 'b.tsv' });
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

  it('job_update starts only from an owner turn, records the working set, and closes the job in its own thread', async () => {
    const exec = executor();
    const refused = await run(exec, 'job_update', { action: 'start', goal: 'x' }, { callerKind: 'continuation', jobMandate: { jobId: 'cj_x', goal: 'x' } });
    expect(refused).toMatchObject({ ok: false, code: 'owner_turn_required' });
    const started = await run(exec, 'job_update', { action: 'start', nextStep: 'Pull Local weekly', notes: ['IST weeks'] }, owner);
    expect(started).toMatchObject({ ok: true, job: { number: 1, title: 'Weekly PV players for Local', status: 'active' } });
    const jobId = started.job.id;
    expect(jobs.get(jobId)?.goal).toBe('Weekly PV players for Local');
    jobs.addWatch({ runId: '1', jobId, source: 'run_query' });
    const updated = await run(exec, 'job_update', { action: 'update', nextStep: 'Join lanes' }, { callerKind: 'continuation', jobMandate: { jobId, goal: 'g' } });
    expect(updated).toMatchObject({ ok: true, job: { nextStep: 'Join lanes', notes: 1 } });
    // The main chat belongs to no job: done there closes nothing.
    expect(await run(exec, 'job_update', { action: 'done' }, owner)).toMatchObject({ ok: false, code: 'no_active_job' });
    const done = await run(exec, 'job_update', { action: 'done', summary: 'Dashboard dash_1 verified' }, { ...owner, threadJobId: jobId });
    expect(done).toMatchObject({ ok: true, job: { status: 'done' } });
    expect(done.note).toContain('Still pending when it ended: 1. BotBoy stopped waiting for them for this job');
    expect(jobs.get(jobId)).toMatchObject({ status: 'done', endReason: 'Dashboard dash_1 verified' });
    expect(await run(exec, 'job_update', { action: 'done' }, { ...owner, threadJobId: jobId })).toMatchObject({ ok: false, code: 'no_active_job' });
  });

  it('job_update continue / needs_owner declare the turn end in a job\'s thread; continue in the main chat hands a job off', async () => {
    const exec = executor();
    const handed = await run(exec, 'job_update', { action: 'continue', nextStep: 'Pull Local weekly' }, owner);
    expect(handed).toMatchObject({ ok: true, job: { number: 1, status: 'active' } });
    const job = jobs.get(handed.job.id)!;
    expect(job).toMatchObject({ goal: 'Weekly PV players for Local', continueRequestedAt: expect.any(String) });
    expect(job.workingSet.nextStep).toBe('Pull Local weekly');
    const inThread = { ...owner, threadJobId: job.id };
    expect(await run(exec, 'job_update', { action: 'needs_owner' }, inThread)).toMatchObject({ ok: false, code: 'question_required' });
    expect(await run(exec, 'job_update', { action: 'continue', nextStep: 'Build the widgets' }, inThread)).toMatchObject({ ok: true, job: { next: 'continue' } });
    expect(jobs.get(job.id)).toMatchObject({ declaration: 'continue', continueReason: 'Build the widgets' });
    // 'blocked' (first build) is needs_owner: it pauses, it no longer ends the job. One-tap answers ride along.
    const blocked = await run(exec, 'job_update', { action: 'blocked', question: 'Which cohort?', options: ['2025', 'All years'] }, { callerKind: 'continuation', jobMandate: { jobId: job.id, goal: 'g' } });
    expect(blocked).toMatchObject({ ok: true, job: { next: 'needs_owner' } });
    expect(jobs.get(job.id)).toMatchObject({ status: 'active', declaration: 'needs_owner', pauseNote: 'Which cohort?', options: ['2025', 'All years'] });
    expect(await run(exec, 'job_update', { action: 'pause' }, owner)).toContain('action must be one of');
  });
  it('job_update continue never starts a job outside a live owner turn', async () => {
    const exec = executor();
    expect(await run(exec, 'job_update', { action: 'continue' }, { callerKind: 'continuation', jobMandate: { jobId: 'cj_x', goal: 'x' } }))
      .toMatchObject({ ok: false, code: 'no_active_job' });
    expect(jobs.activeJobs()).toEqual([]);
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
