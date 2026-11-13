import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createNodeManager } from './node-manager.js';
import { createChatJobStore, type ChatJobStore, type EtlRunWatch } from './chat-jobs.js';
import type { JobWaitCheck, JobWaitChecker } from './job-waits.js';
import { createToolExecutor, toolRunsWithoutExecutorCap, type ToolExecutionContext } from './tool-executor.js';

/**
 * wait_for and BotBoy's own waits in the executor (docs/maps/job-waits.md; owner request 2026-11-12): a job waits for what ends
 * on its own instead of checking on it in turns, a background export or a Data Room job left running is waited for by itself,
 * and job_update wait ends a turn on what is pending.
 */
describe('wait_for and automatic waits', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  let filesDir: string;
  let checks: JobWaitCheck[];
  let checked: EtlRunWatch[];
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
    filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-for-'));
    checks = [];
    checked = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    storage.close();
    fs.rmSync(filesDir, { recursive: true, force: true });
  });

  /** A checker that answers the queued results in order, then "still pending". */
  const checker: JobWaitChecker = {
    check: async (wait) => {
      checked.push(wait);
      return checks.shift() ?? { state: 'pending', note: 'still going' };
    },
  };
  let exportAnswer: { isError: boolean; text: string };
  const mcp = {
    callTool: vi.fn(async (_server: string, toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'export_query' || toolName === 'export_status') return { ...exportAnswer, serverId: 'sql-context', toolName, durationMs: 1 };
      return { isError: true, text: `no fake for ${toolName} ${JSON.stringify(args)}`, serverId: 'sql-context', toolName, durationMs: 1 };
    }),
    getServer: vi.fn(async (id: string) => (id === 'sql-context' ? { id, displayName: 'SQL warehouse', enabled: true, state: 'running' } : null)),
    isHiddenByWorkplace: vi.fn((id: string) => id === 'a2-analytics'),
  };
  const analyticsJobService = {
    wake: vi.fn(),
    observe: vi.fn((jobId: string) => ({ trust: 'verified_analytics_job_receipt', status: 'in_progress', action: 'observe', jobId, responseGuidance: { nextAction: 'Observe it again later.' } })),
  };
  const executor = () => createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
    mcpManager: mcp as any,
    chatJobs: jobs,
    jobWaits: checker,
    analyticsJobService: analyticsJobService as any,
    etlResultsDir: path.join(filesDir, 'etl-results'),
  });
  const call = async (name: string, args: Record<string, unknown>, context?: ToolExecutionContext) => {
    const result = await executor().executeTool({ id: `${name}-1`, type: 'function', function: { name, arguments: JSON.stringify(args) } }, context);
    let body: any;
    try { body = JSON.parse(result.content); } catch { body = result.content; }
    return { body, isError: result.isError };
  };
  const owner: ToolExecutionContext = { callerKind: 'interactive', currentUserMessage: 'Study the overlap', ownerRequestId: 'req-00000001' };
  const mainTurn = (): ToolExecutionContext => ({ ...owner, heldJobIds: [], startedJobIds: [] });
  const inJob = (jobId: string): ToolExecutionContext => ({ callerKind: 'continuation', currentUserMessage: 'Study the overlap', jobMandate: { jobId, goal: 'g' } });

  it('runs without the executor\'s cap (it bounds its own wait), and only in the owner\'s chat and in jobs', async () => {
    expect(toolRunsWithoutExecutorCap('wait_for')).toBe(true);
    const background = await call('wait_for', { kind: 'time', minutes: 5 }, { callerKind: 'background' });
    expect(background).toMatchObject({ isError: true, body: { ok: false, code: 'not_available' } });
    expect(checked).toEqual([]);
  });

  it('in a job: the wait is stored on the job, and the turn is told to end with job_update wait', async () => {
    const job = jobs.start({ goal: 'Study the overlap' });
    const { body, isError } = await call('wait_for', { kind: 'time', minutes: 90, label: 'after the nightly load' }, inJob(job.id));
    expect(isError).toBe(false);
    expect(body).toMatchObject({ ok: true, waiting: true, kind: 'time', waitId: expect.stringMatching(/^w_/), at: expect.any(String) });
    expect(body.nextAction).toContain('End this turn now with job_update wait');
    const [wait] = jobs.watchesForJob(job.id);
    expect(wait).toMatchObject({ runId: body.waitId, source: 'job_wait', kind: 'time', purpose: 'after the nightly load', status: 'pending', remoteStatus: 'still going' });
    // The first check ran on a draft before anything was stored.
    expect(checked).toHaveLength(1);
    expect(checked[0]).toMatchObject({ runId: 'w_draft', kind: 'time' });
  });

  it('in the main chat: the wait goes to a provisional job the turn holds (it becomes a job if the wait outlives the reply)', async () => {
    const context = mainTurn();
    const { body } = await call('wait_for', { kind: 'sql_export', id: 'e_abcdefghijklmn23' }, context);
    expect(body).toMatchObject({ ok: true, waiting: true, kind: 'sql_export' });
    expect(body.nextAction).toContain('this request becomes a job of its own');
    expect(context.heldJobIds).toHaveLength(1);
    const held = jobs.get(context.heldJobIds![0])!;
    expect(held).toMatchObject({ seq: 0, goal: 'Study the overlap', dataWork: true });
    expect(jobs.watchesForJob(held.id)).toEqual([expect.objectContaining({ kind: 'sql_export', target: 'e_abcdefghijklmn23' })]);
  });

  it('what has already ended answers at once, and nothing is stored', async () => {
    const job = jobs.start({ goal: 'g' });
    checks.push({ state: 'ended', outcome: { remoteStatus: 'DONE', summary: 'landed, 14 bytes', savedTo: path.join(filesDir, 'downloads', 'a.csv'), resultBytes: 14 } });
    const { body } = await call('wait_for', { kind: 'file', id: 'downloads/a.csv' }, inJob(job.id));
    expect(body).toMatchObject({ ok: true, ended: true, kind: 'file', status: 'DONE', workspacePath: 'downloads/a.csv', bytes: 14, waitedSeconds: 0 });
    expect(body.nextAction).toContain('Use the file now');
    expect(body.trust).toBeUndefined();
    expect(jobs.watchesForJob(job.id)).toEqual([]);
  });

  it('an export\'s outcome is fenced as data; a lost export says what to do instead', async () => {
    const job = jobs.start({ goal: 'g' });
    checks.push({ state: 'ended', outcome: { remoteStatus: 'LOST', error: 'The SQL connection no longer knows this export.' } });
    const { body } = await call('wait_for', { kind: 'sql_export', id: 'e_abcdefghijklmn23' }, inJob(job.id));
    expect(body).toMatchObject({ trust: 'external_untrusted_data', ended: true, status: 'LOST' });
    expect(body.nextAction).toContain('do not repeat the same wait unchanged');
  });

  it('waitSeconds waits in this call: it returns the outcome when the wait ends, and this turn has seen it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const job = jobs.start({ goal: 'g' });
    checks.push({ state: 'pending', note: 'running, 1 rows written so far' });
    checks.push({ state: 'ended', outcome: { remoteStatus: 'DONE', summary: '9 rows, 90 bytes', savedTo: '/f/a.csv', rowCount: 9 } });
    const pending = call('wait_for', { kind: 'sql_export', id: 'e_abcdefghijklmn23', waitSeconds: 120 }, inJob(job.id));
    await vi.advanceTimersByTimeAsync(15_000);
    const { body } = await pending;
    expect(body).toMatchObject({ ended: true, status: 'DONE', rowCount: 9, savedTo: '/f/a.csv', waitedSeconds: 15 });
    const [wait] = jobs.watchesForJob(job.id);
    expect(wait).toMatchObject({ status: 'finished', consumedAt: expect.any(String) });
    expect(jobs.unconsumedFinished(job.id)).toEqual([]);
  });

  it('a turn that stops ends the in-call wait; the stored wait goes on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const job = jobs.start({ goal: 'g' });
    const abort = new AbortController();
    const pending = call('wait_for', { kind: 'time', minutes: 60, waitSeconds: 600 }, { ...inJob(job.id), abortSignal: abort.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    abort.abort();
    await vi.advanceTimersByTimeAsync(1);
    const { body } = await pending;
    expect(body).toMatchObject({ ok: true, waiting: true });
    expect(jobs.watchesForJob(job.id)[0]).toMatchObject({ status: 'pending' });
  });

  it('list shows the job\'s waits; stop ends one of its own, by id or by what it waits for', async () => {
    const job = jobs.start({ goal: 'g' });
    const first = (await call('wait_for', { kind: 'file', id: 'downloads/a.csv' }, inJob(job.id))).body;
    await call('wait_for', { kind: 'time', minutes: 30 }, inJob(job.id));
    const listed = (await call('wait_for', { action: 'list' }, inJob(job.id))).body;
    expect(listed.waits.map((wait: any) => wait.kind).sort()).toEqual(['file', 'time']);
    expect((await call('wait_for', { action: 'stop', waitId: first.waitId }, inJob(job.id))).body).toMatchObject({ ok: true, stopped: first.waitId });
    expect((await call('wait_for', { action: 'stop', waitId: first.waitId }, inJob(job.id))).body).toMatchObject({ ok: false, code: 'not_waiting' });
    const other = jobs.start({ goal: 'other' });
    expect((await call('wait_for', { action: 'stop', kind: 'time', id: 'x' }, inJob(other.id))).body).toMatchObject({ ok: false, code: 'wait_required' });
    expect((await call('wait_for', { action: 'list' }, mainTurn())).body).toMatchObject({ ok: true, waits: [] });
  });

  it('refuses a connection BotBoy does not have, one the Workplace setting hides, and ETL runs while Amazon Employee is off', async () => {
    const job = jobs.start({ goal: 'g' });
    expect((await call('wait_for', { kind: 'connection', id: 'nope' }, inJob(job.id))).body).toMatchObject({ ok: false, code: 'no_connection' });
    expect((await call('wait_for', { kind: 'connection', id: 'a2-analytics' }, inJob(job.id))).body).toMatchObject({ code: 'amazon_employee_off' });
    expect((await call('wait_for', { kind: 'etl_run', id: '123' }, inJob(job.id))).body).toMatchObject({ code: 'amazon_employee_off' });
    expect((await call('wait_for', { kind: 'data_room_job', id: `aj_${'c'.repeat(32)}` }, inJob(job.id))).body).toMatchObject({ ok: false, code: 'no_data_room_job' });
    expect((await call('wait_for', { kind: 'nap' }, inJob(job.id))).body).toMatchObject({ ok: false, code: 'bad_kind' });
    expect(checked).toEqual([]);
  });

  it('job_update wait ends the turn on what is pending; with nothing pending it says what to do instead', async () => {
    const job = jobs.start({ goal: 'g' });
    expect((await call('job_update', { action: 'wait' }, inJob(job.id))).body).toMatchObject({ ok: false, code: 'nothing_to_wait_for' });
    expect(jobs.get(job.id)!.declaration).toBeUndefined();
    await call('wait_for', { kind: 'sql_export', id: 'e_abcdefghijklmn23', label: 'overlap' }, inJob(job.id));
    const waited = (await call('job_update', { action: 'wait', nextStep: 'join with segments' }, inJob(job.id))).body;
    expect(waited).toMatchObject({ ok: true, job: { next: 'wait' }, waitingFor: ['SQL export e_abcdefghijklmn23 (overlap)'] });
    expect(jobs.get(job.id)).toMatchObject({ declaration: 'wait', workingSet: { nextStep: 'join with segments' } });
    // continue while something is pending: the job waits, and the turn is told so (do the rest now).
    const continued = (await call('job_update', { action: 'continue', nextStep: 'chart it' }, inJob(job.id))).body;
    expect(continued).toMatchObject({ ok: true, job: { next: 'wait' } });
    expect(continued.note).toContain('not at once');
    // done with something pending says what BotBoy stops waiting for, and that it is not stopped.
    const done = (await call('job_update', { action: 'done', summary: 'partial' }, inJob(job.id))).body;
    expect(done.note).toContain('Still pending when it ended: SQL export e_abcdefghijklmn23 (overlap)');
    expect(done.note).toContain('cancel_query');
  });

  it('job_update wait in the main chat: the held request becomes a job when the reply ends', async () => {
    const context = mainTurn();
    expect((await call('job_update', { action: 'wait' }, context)).body).toMatchObject({ ok: false, code: 'nothing_to_wait_for' });
    await call('wait_for', { kind: 'time', minutes: 30 }, context);
    expect((await call('job_update', { action: 'wait' }, context)).body).toMatchObject({ ok: true, note: expect.stringContaining('becomes a job of its own') });
  });

  it('an export started with wait:false is waited for by itself; reading its status says so, and an ended status ends the wait', async () => {
    const job = jobs.start({ goal: 'g' });
    exportAnswer = { isError: false, text: JSON.stringify({ exportId: 'e_abcdefghijklmn23', state: 'running' }) };
    const started = (await call('mcp_call_tool', { serverId: 'sql-context', toolName: 'export_query', arguments: { sql: 'select * from big', wait: false, fileName: 'overlap' } }, inJob(job.id))).body;
    expect(started.botboyWait).toMatchObject({ waitId: expect.stringMatching(/^w_/), note: expect.stringContaining('end this turn with job_update wait') });
    expect(jobs.watchesForJob(job.id)).toEqual([expect.objectContaining({ kind: 'sql_export', target: 'e_abcdefghijklmn23', purpose: 'overlap', status: 'pending' })]);
    const polled = (await call('mcp_call_tool', { serverId: 'sql-context', toolName: 'export_status', arguments: { exportId: 'e_abcdefghijklmn23' } }, inJob(job.id))).body;
    expect(polled.botboyWait.note).toContain('BotBoy already waits for this export for this job');
    exportAnswer = { isError: false, text: JSON.stringify({ exportId: 'e_abcdefghijklmn23', state: 'done', path: '/f/sql-exports/x.csv', rowCount: 3, bytes: 30 }) };
    const done = (await call('mcp_call_tool', { serverId: 'sql-context', toolName: 'export_status', arguments: { exportId: 'e_abcdefghijklmn23' } }, inJob(job.id))).body;
    expect(done.botboyWait).toBeUndefined();
    // The turn that read it has seen it: no continuation is due for it.
    expect(jobs.watchesForJob(job.id)[0]).toMatchObject({ status: 'finished', outcome: { remoteStatus: 'DONE', rowCount: 3 }, consumedAt: expect.any(String) });
    expect(jobs.unconsumedFinished(job.id)).toEqual([]);
  });

  it('an export that finished inside its own call, or one read by another job, starts no wait for this one', async () => {
    const job = jobs.start({ goal: 'g' });
    exportAnswer = { isError: false, text: JSON.stringify({ exportId: 'e_abcdefghijklmn23', state: 'done', path: '/f/a.csv' }) };
    const quick = (await call('mcp_call_tool', { serverId: 'sql-context', toolName: 'export_query', arguments: { sql: 'select 1', wait: false } }, inJob(job.id))).body;
    expect(quick.botboyWait).toBeUndefined();
    expect(jobs.watchesForJob(job.id)).toEqual([]);
    // A background caller holds no job: nothing is registered.
    exportAnswer = { isError: false, text: JSON.stringify({ exportId: 'e_bbbbbbbbbbbbbbbb', state: 'queued' }) };
    expect((await call('mcp_call_tool', { serverId: 'sql-context', toolName: 'export_query', arguments: { sql: 'select 1', wait: false } }, { callerKind: 'background' })).body.botboyWait).toBeUndefined();
    // Another job's wait ends with what this read showed, but stays that job's to see.
    const other = jobs.start({ goal: 'other' });
    jobs.addJobWait({ jobId: other.id, kind: 'sql_export', target: 'e_abcdefghijklmn23', deadlineAt: new Date(Date.now() + 3_600_000).toISOString() });
    exportAnswer = { isError: false, text: JSON.stringify({ exportId: 'e_abcdefghijklmn23', state: 'failed', error: 'boom' }) };
    await call('mcp_call_tool', { serverId: 'sql-context', toolName: 'export_status', arguments: { exportId: 'e_abcdefghijklmn23' } }, inJob(job.id));
    expect(jobs.unconsumedFinished(other.id)).toEqual([expect.objectContaining({ outcome: expect.objectContaining({ remoteStatus: 'FAILED', error: 'boom' }) })]);
  });

  it('a Data Room job left running is waited for by itself, and the receipt says so', async () => {
    const job = jobs.start({ goal: 'g' });
    const jobId = `aj_${'d'.repeat(32)}`;
    const { body } = await call('create_data_room_dataset', { action: 'status', jobId }, { ...inJob(job.id), ownerRequestId: 'req-00000002' });
    expect(body).toMatchObject({ trust: 'verified_analytics_job_receipt', status: 'in_progress', jobId, botboyWait: { waitId: expect.stringMatching(/^w_/) } });
    expect(body.botboyWait.note).toContain('job_update wait');
    expect(jobs.watchesForJob(job.id)).toEqual([expect.objectContaining({ kind: 'data_room_job', target: jobId })]);
    // A finished one starts none.
    analyticsJobService.observe.mockReturnValueOnce({ trust: 'verified_analytics_job_receipt', status: 'completed', action: 'observe', jobId: `aj_${'e'.repeat(32)}`, responseGuidance: { nextAction: '' } });
    const finished = (await call('create_data_room_dataset', { action: 'status', jobId: `aj_${'e'.repeat(32)}` }, { ...inJob(job.id), ownerRequestId: 'req-00000003' })).body;
    expect(finished.botboyWait).toBeUndefined();
    expect(jobs.watchesForJob(job.id)).toHaveLength(1);
  });
});
