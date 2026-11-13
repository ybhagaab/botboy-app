import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createChatJobStore, type ChatJobStore } from '../core/chat-jobs.js';
import { createChatInterface } from '../core/chat-interface.js';
import { createConversationManager } from '../core/conversation-manager.js';
import { CONTINUATION_HEADER, createContinuationBridge, type ContinuationBridge } from '../core/chat-continuations.js';
import { createRouter } from './routes.js';
import { CONTINUATION_PREEMPTED_TEXT, DATA_ROOM_SAME_FAILURE_BLOCK, JOB_STOPPED_TEXT } from './routers/chat.js';

/**
 * Continuation turns through the chat route (ANALYTICS_AUTONOMY_PLAN.md D2):
 * only BotBoy's secret starts one, it is never an owner turn, it never shows
 * a fake owner message, and the owner's own message always comes first.
 */

function streamResult(partial: Record<string, unknown>) {
  return { content: '', reasoning: '', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'stop', ...partial };
}

/** A real loopback listener, so Origin can name its exact port (owner UI checks). */
function listening(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const TOOL_DEFS = ['query_db', 'gmail_send', 'mcp_etl_run_query', 'mcp_etl_job_run', 'create_data_room_dataset', 'job_update']
  .map(name => ({ type: 'function', function: { name, description: name, parameters: {} } }));

describe('continuation turns in the chat route', () => {
  let storage: StorageLayer;
  let db: Database.Database;
  let jobs: ChatJobStore;
  let bridge: ContinuationBridge;
  let promptContexts: any[];
  let appendUser: ReturnType<typeof vi.fn>;
  let appendAssistant: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
    jobs = createChatJobStore(db);
    bridge = createContinuationBridge();
    promptContexts = [];
    appendUser = vi.fn();
    appendAssistant = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
    storage.close();
  });

  function makeApp(llmClient: any, toolExecutor: any, overrides: Record<string, unknown> = {}) {
    const server = express();
    server.use(express.json());
    server.use('/api', createRouter({
      nodeManager: createNodeManager(db),
      db,
      llmClient,
      toolExecutor,
      chatJobs: jobs,
      chatContinuations: bridge,
      // The real transcript reader (its agent is never used by streamed turns).
      chatInterface: createChatInterface(db, {} as any),
      promptManager: {
        getSystemPrompt: (_role: string, context: any) => { promptContexts.push(context); return 'You are a test bot.'; },
        getToolDefinitions: () => TOOL_DEFS,
      } as any,
      conversationManager: {
        getActiveSessionId: () => 'sess-test',
        createSession: () => 'sess-test',
        appendUser,
        appendAssistant,
        countUserMessages: () => 1,
        getSummary: () => null,
        getMessages: () => [],
        getMessagesSinceId: () => [],
        getRecentMessages: () => [{ role: 'user' as const, content: 'latest' }],
        saveSummary: vi.fn(),
      } as any,
      ...overrides,
    } as any));
    return server;
  }

  /** A model that replies once with text (after optional tool calls per iteration). */
  function model(script: Array<{ tools?: Array<{ name: string; arguments: string }>; text?: string; waitFor?: Promise<void> }>) {
    let call = 0;
    const requests: any[] = [];
    return {
      requests,
      getActiveEndpoint: () => 'ecs',
      chatCompletionStream: vi.fn((req: any) => {
        requests.push(req);
        const step = script[Math.min(call, script.length - 1)];
        call++;
        return (async function* () {
          if (step.waitFor) {
            await Promise.race([step.waitFor, new Promise<void>((resolve) => req.signal?.addEventListener('abort', () => resolve(), { once: true }))]);
            if (req.signal?.aborted) throw new Error('aborted');
          }
          if (step.tools?.length) {
            const toolCalls = step.tools.map((tool, index) => ({ id: `c${call}-${index}`, type: 'function', function: tool }));
            return streamResult({ toolCalls, finishReason: 'tool_calls' });
          }
          yield { type: 'content', text: step.text ?? 'ok' };
          return streamResult({ content: step.text ?? 'ok' });
        })();
      }),
    };
  }

  const chatRows = () => db.prepare('SELECT role, content FROM chat_messages ORDER BY rowid').all() as Array<{ role: string; content: string }>;
  const continuationBody = (jobId: string, ordinal = 1) => ({
    message: '[Automatic continuation — not a message from the owner]\nETL runs for the job you are working on finished:\n- Run 1: SUCCESS.',
    stream: true,
    continuation: { jobId, ordinal, note: '↻ Continued automatically: run 1 finished (3 rows).' },
  });

  it('refuses a wrong secret and an ended job without writing anything', async () => {
    const llm = model([{ text: 'never' }]);
    const app = makeApp(llm, { executeTool: vi.fn() });
    const job = jobs.start({ goal: 'Build the dashboard' });
    const wrong = await request(app).post('/api/chat/messages').set(CONTINUATION_HEADER, 'not-the-secret').send(continuationBody(job.id));
    expect(wrong.status).toBe(403);
    jobs.end(job.id, 'stopped', 'owner');
    const ended = await request(app).post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id));
    expect(ended.status).toBe(409);
    expect(ended.body.code).toBe('job_not_active');
    expect(chatRows()).toEqual([]);
    expect(llm.chatCompletionStream).not.toHaveBeenCalled();
  });

  // Owner decision 2026-11-10: a data job's turns carry the detailed dashboard and Data Room rules; every job turn the essentials.
  it('tells the prompt whether the job is data work', async () => {
    const data = jobs.start({ goal: 'get both up & fresh', title: 'Repair both dashboard refreshes' });
    const general = jobs.start({ goal: 'Draft the offsite note' });
    const app = makeApp(model([{ text: 'Done for now.' }]), { executeTool: vi.fn() });
    for (const job of [data, general]) {
      const res = await request(app).post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id));
      expect(res.status).toBe(200);
    }
    expect(promptContexts.map(context => [context.jobTurn, context.jobDataWork])).toEqual([[true, true], [true, false]]);
  });

  it('runs as a continuation of the job: no owner row, the note on the reply, job-scope tools only', async () => {
    const job = jobs.start({ goal: 'Build the PV dashboard' });
    const llm = model([{ tools: [{ name: 'query_db', arguments: '{"sql":"select 1"}' }] }, { text: 'Imported the weekly file.' }]);
    const executeTool = vi.fn(async (call: any) => ({ toolCallId: call.id, content: '[]' }));
    const res = await request(makeApp(llm, { executeTool })).post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id, 4));
    expect(res.status).toBe(200);
    expect(chatRows()).toEqual([{ role: 'assistant', content: '↻ Continued automatically: run 1 finished (3 rows).\n\nImported the weekly file.' }]);
    expect(executeTool.mock.calls[0][1]).toMatchObject({
      callerKind: 'continuation',
      jobMandate: { jobId: job.id, goal: 'Build the PV dashboard' },
      currentUserMessage: 'Build the PV dashboard',
      ownerRequestId: `cont:${job.id.replace(/_/g, '')}:4`,
    });
    expect(llm.requests[0].tools.map((tool: any) => tool.function.name)).toEqual(['query_db', 'mcp_etl_run_query', 'mcp_etl_job_run', 'create_data_room_dataset', 'job_update']);
    expect(appendUser).toHaveBeenCalledWith('sess-test', expect.stringContaining('[Automatic continuation'));
    expect(promptContexts[0].conversationMode).toBe('general');
    expect(promptContexts[0].jobBlock).toContain('AUTOMATIC CONTINUATION');
    expect(promptContexts[0].jobTurn).toBe(true);
  });

  it('runs a repeated status read again instead of blocking it as unchanged', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const call = { name: 'mcp_etl_job_run', arguments: '{"runId":"7"}' };
    let iteration = 0;
    const llm = {
      getActiveEndpoint: () => 'ecs',
      chatCompletionStream: vi.fn(() => {
        iteration++;
        // Time passes between the model's status checks.
        vi.setSystemTime(Date.now() + 11_000);
        return (async function* () {
          if (iteration <= 2) return streamResult({ toolCalls: [{ id: `s${iteration}`, type: 'function', function: call }], finishReason: 'tool_calls' });
          yield { type: 'content', text: 'Still running.' };
          return streamResult({ content: 'Still running.' });
        })();
      }),
    };
    const executeTool = vi.fn(async (toolCall: any) => ({ toolCallId: toolCall.id, content: '{"status":"EXECUTING"}' }));
    await request(makeApp(llm, { executeTool })).post('/api/chat/messages').send({ message: 'status of run 7', stream: true });
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  it('lets several imports run in one turn and stops only a repeating validation failure', async () => {
    const createCall = (alias: string) => ({ name: 'create_data_room_dataset', arguments: JSON.stringify({ action: 'create', ownerRequested: true, plan: { terminal: { kind: 'source', alias } } }) });
    const script = [
      { tools: [createCall('first')] },
      { tools: [createCall('second')] },
      ...Array.from({ length: DATA_ROOM_SAME_FAILURE_BLOCK + 1 }, (_, index) => ({ tools: [createCall(`bad${index}`)] })),
      { text: 'Reported the unresolved issue.' },
    ];
    const llm = model(script);
    const admitted = (jobId: string) => JSON.stringify({ trust: 'verified_analytics_job_receipt', status: 'in_progress', jobId });
    const failure = JSON.stringify({ version: 1, type: 'data_room_tool_failure', ok: false, code: 'invalid_input', issues: [{ code: 'required', path: 'plan.request.metric' }], effect: { state: 'none', mutationApplied: false }, nextAction: 'Correct it.' });
    const executeTool = vi.fn(async (toolCall: any) => {
      const alias = JSON.parse(toolCall.function.arguments).plan.terminal.alias;
      const content = alias === 'first' ? admitted(`aj_${'1'.repeat(32)}`) : alias === 'second' ? admitted(`aj_${'2'.repeat(32)}`) : failure;
      return { toolCallId: toolCall.id, content, isError: content === failure };
    });
    await request(makeApp(llm, { executeTool })).post('/api/chat/messages').send({ message: 'import both files', stream: true });
    // Two admitted imports, then failures until the fifth identical one; the sixth is refused unexecuted.
    expect(executeTool).toHaveBeenCalledTimes(2 + DATA_ROOM_SAME_FAILURE_BLOCK);
    const toolMessages = llm.requests.at(-1).messages.filter((message: any) => message.role === 'tool').map((message: any) => message.content as string);
    expect(toolMessages[4]).toContain('come back 3 times');
    expect(toolMessages.at(-1)).toContain('repair_budget_exhausted');
  });

  const say = (app: express.Express | Server, message: string, extra: Record<string, unknown> = {}) =>
    request(app).post('/api/chat/messages').send({ message, stream: true, ...extra });
  const rowsOf = (jobId: string | null) => (jobId
    ? db.prepare('SELECT role, content, ref_job_id AS ref FROM chat_messages WHERE job_id = ? ORDER BY rowid').all(jobId)
    : db.prepare('SELECT role, content, ref_job_id AS ref FROM chat_messages WHERE job_id IS NULL ORDER BY rowid').all()) as Array<{ role: string; content: string; ref: string | null }>;

  it('an owner turn in a job\'s own thread goes first for that job; the main chat never holds a job back', async () => {
    const job = jobs.start({ goal: 'Build the PV dashboard' });
    const ownerGate = deferred();
    const ownerLlm = model([{ waitFor: ownerGate.promise, text: 'Owner answer.' }, { text: 'Continuation reply.' }]);
    const app = makeApp(ownerLlm, { executeTool: vi.fn() });
    const inThread = say(app, 'how is it going?', { jobId: job.id }).then(response => response);
    await vi.waitFor(() => expect(ownerLlm.chatCompletionStream).toHaveBeenCalled());
    expect(bridge.isOwnerTurnActive(job.id)).toBe(true);
    const busy = await request(app).post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id));
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('owner_turn_active');
    ownerGate.resolve();
    await inThread;

    // A main chat turn in progress does not hold the job: its continuation runs beside it.
    const mainGate = deferred();
    const mainLlm = model([{ waitFor: mainGate.promise, text: 'Main answer.' }, { text: 'Job progress.' }]);
    const app2 = makeApp(mainLlm, { executeTool: vi.fn() });
    const main = say(app2, 'what is on my calendar?').then(response => response);
    await vi.waitFor(() => expect(mainLlm.chatCompletionStream).toHaveBeenCalledTimes(1));
    expect(bridge.isMainTurnActive()).toBe(true);
    expect(bridge.isOwnerTurnActive(job.id)).toBe(false);
    const parallel = await request(app2).post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id, 2));
    expect(parallel.status).toBe(200);
    mainGate.resolve();
    expect((await main).status).toBe(200);
    expect(rowsOf(job.id).map(row => row.content).at(-1)).toBe('↻ Continued automatically: run 1 finished (3 rows).\n\nJob progress.');
    // The main chat holds its own conversation (the job's cards aside: its second undeclared end made it stuck).
    expect(rowsOf(null).filter(row => !row.ref).map(row => row.content)).toEqual(['what is on my calendar?', 'Main answer.']);
    expect(rowsOf(null).filter(row => row.ref).map(row => row.content)).toEqual([`[[job:${job.id}:stuck]]`]);
  });

  it('an owner message in a job\'s thread preempts that job\'s continuation; a main chat message does not', async () => {
    const job = jobs.start({ goal: 'Build the PV dashboard' });
    const never = deferred();
    const contLlm = model([{ waitFor: never.promise, text: 'never' }, { text: 'Main chat answer.' }, { text: 'Answer to the owner.' }]);
    const app = makeApp(contLlm, { executeTool: vi.fn() });
    const continuation = request(app).post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id, 2)).then(response => response);
    await vi.waitFor(() => expect(contLlm.chatCompletionStream).toHaveBeenCalledTimes(1));
    expect((await say(app, 'unrelated question')).status).toBe(200);
    expect(bridge.isTurnActive()).toBe(true); // the job's turn still runs
    const owner = await say(app, 'change of plan', { jobId: job.id });
    expect(owner.status).toBe(200);
    await continuation;
    const rows = rowsOf(job.id).map(row => row.content);
    const preempted = rows.findIndex(content => content.endsWith(CONTINUATION_PREEMPTED_TEXT));
    expect(preempted).toBeGreaterThanOrEqual(0);
    expect(rows[preempted]).toMatch(/^↻ Continued automatically/);
    expect(rows.indexOf('change of plan')).toBeGreaterThan(preempted);
    expect(rows.at(-1)).toBe('Answer to the owner.');
  });

  it('a job\'s thread carries its job block and uses finished runs; the main chat sees only the JOBS list', async () => {
    const job = jobs.start({ goal: 'Build the PV dashboard', title: 'PV dashboard', modelKey: 'team.sol' });
    jobs.addWatch({ runId: '42', jobId: job.id, source: 'run_query' });
    jobs.finishWatch('42', { remoteStatus: 'SUCCESS', savedTo: '/f/etl-results/adhoc_42.tsv', rowCount: 3 });
    const done = jobs.start({ goal: 'Refresh the downloads dashboard', title: 'Downloads refresh' });
    jobs.end(done.id, 'done', 'All six widgets refreshed');
    const llm = model([{ text: 'Main answer.' }, { text: 'Here is where it stands.' }]);
    const app = makeApp(llm, { executeTool: vi.fn() });
    await say(app, 'what is running?');
    expect(promptContexts[0].jobBlock).toContain('## JOBS');
    expect(promptContexts[0].jobBlock).toContain(`#${job.seq} PV dashboard`);
    expect(promptContexts[0].jobBlock).toContain(`#${done.seq} Downloads refresh — done: All six widgets refreshed`);
    expect(promptContexts[0].jobBlock).not.toContain('"Build the PV dashboard"');
    expect(jobs.unconsumedFinished(job.id)).toHaveLength(1); // the main chat used nothing of the job's
    expect(promptContexts[0].jobTurn).toBe(false); // the job's own tools (delete_working_file) stay out of the main chat
    await say(app, 'check', { jobId: job.id, thinking: 'high', model: 'team.terra' });
    expect(promptContexts[1].jobTurn).toBe(true);
    expect(promptContexts[1].jobBlock).toContain(`## ACTIVE JOB #${job.seq} — PV dashboard`);
    expect(promptContexts[1].jobBlock).toContain('"Build the PV dashboard"');
    expect(promptContexts[1].jobBlock).toContain('42: SUCCESS — 3 rows');
    // The thread keeps the job's own model (the main picker never changes it), and records the thinking level.
    expect(jobs.get(job.id)).toMatchObject({ thinking: 'high', modelKey: 'team.sol' });
    expect(jobs.unconsumedFinished(job.id)).toEqual([]);
  });

  it('#N in the main chat runs in job N\'s thread, and both sides show the message and its reply', async () => {
    const job = jobs.start({ goal: 'Draft the release note', title: 'Release note' });
    const llm = model([{ text: 'Made it warmer.' }]);
    const app = makeApp(llm, { executeTool: vi.fn() });
    await say(app, `#${job.seq} make it a little warmer`);
    expect(promptContexts[0].jobBlock).toContain(`## ACTIVE JOB #${job.seq}`);
    expect(rowsOf(job.id).map(row => row.content)).toEqual(['make it a little warmer', 'Made it warmer.']);
    expect(rowsOf(null)).toEqual([
      { role: 'user', content: `#${job.seq} make it a little warmer`, ref: job.id },
      { role: 'assistant', content: 'Made it warmer.', ref: job.id },
    ]);
    // An unknown number stays a main chat message.
    await say(makeApp(model([{ text: 'There is no job 9.' }]), { executeTool: vi.fn() }), '#9 hello');
    expect(rowsOf(null).at(-1)).toMatchObject({ content: 'There is no job 9.', ref: null });
  });

  it('#N to a job that ended reopens it in its own thread, which starts with the main chat\'s messages since the job began (the upgrade path)', async () => {
    // Before threads, a job's work lived in the main chat's session.
    const conversations = createConversationManager(db);
    const main = conversations.createSession('chat');
    const job = jobs.start({ goal: 'Continue the offline study', modelKey: 'team.sol' });
    conversations.appendUser(main, 'Continue the offline study');
    conversations.appendAssistant(main, 'Run 88412 succeeded; 7 dates checked.');
    jobs.end(job.id, 'stopped', 'stopped by the owner');
    const llm = model([{ text: 'Picking it up from the weekly split.' }]);
    const app = makeApp(llm, { executeTool: vi.fn() }, { conversationManager: conversations });
    expect((await say(app, `#${job.seq} continue`)).status).toBe(200);
    expect(jobs.get(job.id)).toMatchObject({ status: 'active', seq: job.seq, modelKey: 'team.sol' });
    expect(promptContexts[0].jobBlock).toContain(`## ACTIVE JOB #${job.seq}`);
    // The model sees the job's earlier work, then the owner's message, in the job's own thread.
    const sent = llm.requests[0].messages.filter((m: any) => m.role !== 'system').map((m: any) => m.content);
    expect(sent).toEqual(['Continue the offline study', 'Run 88412 succeeded; 7 dates checked.', 'continue']);
    const thread = jobs.get(job.id)!.sessionId!;
    expect(thread).not.toBe(main);
    expect(conversations.getActiveSessionId('chat')).toBe(main);
    expect(conversations.getMessages(thread).map(m => m.content)).toEqual(['Continue the offline study', 'Run 88412 succeeded; 7 dates checked.', 'continue', 'Picking it up from the weekly split.']);
    // The main chat's own context gains nothing from the job's turn; its transcript shows the exchange, marked as the job's.
    expect(conversations.getMessages(main).map(m => m.content)).toEqual(['Continue the offline study', 'Run 88412 succeeded; 7 dates checked.']);
    expect(rowsOf(null)).toEqual([
      { role: 'user', content: `#${job.seq} continue`, ref: job.id },
      { role: 'assistant', content: 'Picking it up from the weekly split.', ref: job.id },
    ]);
    expect(rowsOf(job.id).map(row => row.content)).toEqual(['continue', 'Picking it up from the weekly split.']);
  });

  it('job routes: every job with its phase, one job with its thread, and Stop, Pause, Resume and model only from the owner UI', async () => {
    const job = jobs.start({ goal: 'Build the PV dashboard', title: 'PV dashboard' });
    const other = jobs.start({ goal: 'Draft the note' });
    jobs.addWatch({ runId: '55', jobId: job.id, source: 'run_query', purpose: 'Local weekly' });
    db.prepare('INSERT INTO chat_messages (id, role, content, job_id) VALUES (?, ?, ?, ?)').run('m1', 'user', 'thread message', job.id);
    const server = await listening(makeApp(model([{ text: 'x' }]), { executeTool: vi.fn() }));
    const owner = (path: string) => {
      const port = (server.address() as AddressInfo).port;
      return request(server).post(path).set('Origin', `http://127.0.0.1:${port}`).set('Sec-Fetch-Site', 'same-origin');
    };
    try {
      const list = (await request(server).get('/api/chat/jobs')).body;
      expect(list.jobs.map((entry: any) => entry.number)).toEqual([job.seq, other.seq]);
      expect(list.jobs[0]).toMatchObject({ id: job.id, title: 'PV dashboard', phase: 'waiting', waitingRuns: [{ runId: '55', purpose: 'Local weekly' }] });
      const one = (await request(server).get(`/api/chat/jobs/${job.id}`)).body;
      expect(one.history.map((row: any) => row.content)).toEqual(['thread message']);
      expect((await request(server).get('/api/chat/jobs/cj_missing')).status).toBe(404);

      for (const path of [`/api/chat/jobs/${job.id}/stop`, `/api/chat/jobs/${job.id}/pause`, `/api/chat/jobs/${job.id}/resume`]) {
        expect((await request(server).post(path)).status).toBe(403);
      }
      expect((await request(server).put(`/api/chat/jobs/${job.id}/model`).send({ model: 'default' })).status).toBe(403);
      expect(jobs.get(job.id)?.status).toBe('active');

      expect((await owner(`/api/chat/jobs/${other.id}/pause`)).body.job).toMatchObject({ phase: 'paused', pauseNote: expect.stringContaining('You paused this job') });
      const resumed = (await owner(`/api/chat/jobs/${other.id}/resume`)).body.job;
      expect(resumed.phase).toBe('continuing');
      expect(jobs.get(other.id)?.continueReason).toContain('resumed');

      const stopped = await owner(`/api/chat/jobs/${job.id}/stop`);
      expect(stopped.body).toMatchObject({ ok: true, job: { id: job.id, status: 'stopped' } });
      expect(jobs.watch('55')?.status).toBe('abandoned');
      const after = (await request(server).get('/api/chat/jobs')).body;
      expect(after.jobs.map((entry: any) => entry.id)).toEqual([other.id]);
      expect(after.recent.map((entry: any) => entry.id)).toEqual([job.id]);
      expect((await owner(`/api/chat/jobs/${job.id}/pause`)).status).toBe(409);
    } finally {
      server.close();
    }
  });

  it('the list says whether the owner asked to be told on WhatsApp (job-notify.md), and only as a boolean', async () => {
    const job = jobs.start({ goal: 'Study the home screen' });
    const server = await listening(makeApp(model([{ text: 'x' }]), { executeTool: vi.fn() }));
    try {
      expect((await request(server).get('/api/chat/jobs')).body.jobs[0].notifyWhatsApp).toBe(false);
      jobs.setNotify(job.id, true);
      const armed = (await request(server).get('/api/chat/jobs')).body.jobs[0];
      expect(armed.notifyWhatsApp).toBe(true);
      // Nothing about what was sent, or the report, leaks into the polled payload.
      expect(JSON.stringify(armed)).not.toContain('lastReply');
      expect(JSON.stringify(armed)).not.toContain('armedAt');
    } finally {
      server.close();
    }
  });

  it('a stopped job ends its running continuation with a plain note; a plain Stop leaves job turns running', async () => {
    const job = jobs.start({ goal: 'Build the PV dashboard' });
    const never = deferred();
    const llm = model([{ waitFor: never.promise, text: 'never' }]);
    const server = await listening(makeApp(llm, { executeTool: vi.fn() }));
    try {
      const port = (server.address() as AddressInfo).port;
      const running = request(server).post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id)).then(response => response);
      await vi.waitFor(() => expect(llm.chatCompletionStream).toHaveBeenCalled());
      // The main chat's Stop is for the owner's own reply: it never ends a job's automatic turn.
      expect((await request(server).post('/api/chat/stop').send({})).body.stopped).toBe(0);
      const stopped = await request(server).post(`/api/chat/jobs/${job.id}/stop`)
        .set('Origin', `http://127.0.0.1:${port}`).set('Sec-Fetch-Site', 'same-origin');
      expect(stopped.body.stoppedTurns).toBe(1);
      await running;
      expect(rowsOf(job.id).at(-1)?.content).toBe(`↻ Continued automatically: run 1 finished (3 rows).\n\n${JOB_STOPPED_TEXT}`);
    } finally {
      server.close();
    }
  });

  it('agent messages come only from BotBoy itself', async () => {
    const app = makeApp(model([{ text: 'x' }]), { executeTool: vi.fn() });
    expect((await request(app).post('/api/chat/agent-message').send({ message: 'spoofed' })).status).toBe(403);
    const posted = await request(app).post('/api/chat/agent-message').set(CONTINUATION_HEADER, bridge.secret).send({ message: '🔎 diagnostics' });
    expect(posted.status).toBe(200);
    expect(chatRows()).toEqual([{ role: 'assistant', content: '🔎 diagnostics' }]);
  });

  describe('end-of-turn settle (a job never sits "working" with nothing running)', () => {
    function bindRunner() {
      const runner = {
        request: vi.fn(), start: vi.fn(), stop: vi.fn(), tick: vi.fn(), running: () => [], isRunning: () => false, forget: vi.fn(),
        providerLimited: vi.fn(() => '2026-10-28T10:05:00.000Z'), providerClear: vi.fn(), providerReadyAt: () => 0, idle: async () => {},
      };
      bridge.bindRunner(runner as any);
      return runner;
    }
    /** A tool executor whose job tools act like the real handlers (tool-executor.ts › job_update, etlJobFor). */
    function declaringExecutor() {
      return {
        executeTool: vi.fn(async (call: any, context: any) => {
          const args = JSON.parse(call.function.arguments || '{}');
          if (call.function.name === 'job_update' && args.action === 'start') {
            const job = jobs.start({ goal: context.currentUserMessage, title: args.title });
            jobs.requestTurn(job.id, 'The owner just handed this job off from the main chat.');
            context.startedJobIds?.push(job.id);
            return { toolCallId: call.id, content: JSON.stringify({ ok: true, job: { id: job.id, number: job.seq } }) };
          }
          if (call.function.name === 'job_update') {
            const jobId = context.jobMandate?.jobId ?? context.threadJobId;
            if (args.action === 'done') jobs.end(jobId, 'done', args.summary ?? 'done');
            else jobs.declare(jobId, args.action, args.nextStep ?? args.question, args.options);
          }
          if (call.function.name === 'mcp_etl_run_query') {
            // A main chat turn's run belongs to a provisional job the turn holds.
            const held = jobs.start({ goal: context.currentUserMessage, provisional: true });
            context.heldJobIds?.push(held.id);
            jobs.addWatch({ runId: args.runId, jobId: held.id, source: 'run_query' });
            if (args.finishInTurn) {
              jobs.finishWatch(args.runId, { remoteStatus: 'SUCCESS', rowCount: 1 });
              jobs.consumeWatch(args.runId);
            }
          }
          return { toolCallId: call.id, content: '{"ok":true}' };
        }),
      };
    }

    it('a job\'s turn that declares continue starts its next turn on its own', async () => {
      const runner = bindRunner();
      const job = jobs.start({ goal: 'Build the PV dashboard' });
      const llm = model([
        { tools: [{ name: 'job_update', arguments: '{"action":"continue","nextStep":"Build the widgets"}' }] },
        { text: 'Data is in; building the widgets next.' },
      ]);
      const app = makeApp(llm, declaringExecutor());
      const res = await say(app, 'build it', { jobId: job.id });
      expect(res.status).toBe(200);
      const after = jobs.get(job.id)!;
      expect(after.continueRequestedAt).toBeTruthy();
      expect(after.continueReason).toBe('Build the widgets');
      expect(after.pausedAt).toBeUndefined();
      expect(runner.request).toHaveBeenCalledWith(job.id);
      expect((await request(app).get('/api/chat/jobs')).body.jobs[0].phase).toBe('continuing');
      // The provider answered: its line is released for waiting jobs.
      expect(runner.providerClear).toHaveBeenCalled();
    });

    it('needs_owner pauses with the question and its one-tap answers: the list says it needs you', async () => {
      const runner = bindRunner();
      const job = jobs.start({ goal: 'Draft the note' });
      const llm = model([
        { tools: [{ name: 'job_update', arguments: '{"action":"needs_owner","question":"Short or long?","options":["Short","Long"]}' }] },
        { text: 'Short or long?' },
      ]);
      const app = makeApp(llm, declaringExecutor());
      await request(app).post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id));
      expect(jobs.get(job.id)).toMatchObject({ pauseNote: 'Short or long?', pauseKind: 'question' });
      expect(runner.request).not.toHaveBeenCalled();
      expect((await request(app).get('/api/chat/jobs')).body.jobs[0]).toMatchObject({ phase: 'needs_owner', pauseNote: 'Short or long?', options: ['Short', 'Long'] });
      // The owner's one-tap answer in the job's thread moves the job on even when the reply only chats.
      await say(makeApp(model([{ text: 'Short it is.' }]), declaringExecutor()), 'Short', { jobId: job.id });
      expect(jobs.get(job.id)?.pausedAt).toBeUndefined();
      expect(jobs.get(job.id)?.continueRequestedAt).toBeTruthy();
    });

    it('an undeclared end continues once with a nudge, then a second undeclared end pauses as stuck, with a card in the main chat', async () => {
      const runner = bindRunner();
      const job = jobs.start({ goal: 'Build the PV dashboard' });
      const ownerTurn = model([{ tools: [{ name: 'query_db', arguments: '{"sql":"select 1"}' }] }, { text: 'Loaded the data. Next I will build the widgets.' }]);
      await say(makeApp(ownerTurn, declaringExecutor()), 'build it', { jobId: job.id });
      let after = jobs.get(job.id)!;
      expect(after.continueRequestedAt).toBeTruthy();
      expect(after.continueReason).toContain('ended without saying');
      expect(after.undeclaredEnds).toBe(1);
      expect(runner.request).toHaveBeenCalledTimes(1);

      jobs.clearContinueRequest(job.id);
      const continuationTurn = model([{ text: 'Still thinking about the widgets.' }]);
      await request(makeApp(continuationTurn, declaringExecutor())).post('/api/chat/messages')
        .set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id));
      after = jobs.get(job.id)!;
      expect(after.continueRequestedAt).toBeUndefined();
      expect(after).toMatchObject({ pausedAt: expect.any(String), pauseKind: 'stuck' });
      expect(after.pauseNote).toContain('Still thinking about the widgets.');
      expect(runner.request).toHaveBeenCalledTimes(1);
      expect(rowsOf(null)).toEqual([{ role: 'assistant', content: `[[job:${job.id}:stuck]]`, ref: job.id }]);
    });

    it('an undeclared end with watched runs pending just waits', async () => {
      const runner = bindRunner();
      const job = jobs.start({ goal: 'Build the PV dashboard' });
      jobs.addWatch({ runId: '77', jobId: job.id, source: 'run_query' });
      const llm = model([{ tools: [{ name: 'query_db', arguments: '{}' }] }, { text: 'Run 77 is going; I continue when it finishes.' }]);
      const app = makeApp(llm, declaringExecutor());
      await say(app, 'build it', { jobId: job.id });
      const after = jobs.get(job.id)!;
      expect(after.continueRequestedAt).toBeUndefined();
      expect(after.pausedAt).toBeUndefined();
      expect(runner.request).not.toHaveBeenCalled();
      expect((await request(app).get('/api/chat/jobs')).body.jobs[0].phase).toBe('waiting');
    });

    it('a main chat hand-off: the reply carries the started card, the job\'s first turn is asked for, and its thread starts with the request', async () => {
      const runner = bindRunner();
      const appendUserCalls = appendUser;
      const llm = model([
        { tools: [{ name: 'job_update', arguments: '{"action":"start","title":"Local offline study"}' }] },
        { text: 'On it.' },
      ]);
      const app = makeApp(llm, declaringExecutor());
      await say(app, 'Study how Local offline usage changes as the customer base shrinks.');
      const job = jobs.activeJobs()[0];
      expect(job).toMatchObject({ seq: 1, title: 'Local offline study', continueRequestedAt: expect.any(String) });
      expect(rowsOf(null).map(row => row.content)).toEqual([
        'Study how Local offline usage changes as the customer base shrinks.',
        `On it.\n\n[[job:${job.id}:started]]`,
      ]);
      expect(runner.request).toHaveBeenCalledWith(job.id);
      expect(appendUserCalls).toHaveBeenCalledWith('sess-test', 'Study how Local offline usage changes as the customer base shrinks.');
    });

    it('a failed main chat turn that had done work becomes a job of its own and continues once', async () => {
      const runner = bindRunner();
      let call = 0;
      const llm = {
        getActiveEndpoint: () => 'ecs',
        chatCompletionStream: vi.fn(() => (async function* () {
          call++;
          if (call === 1) return streamResult({ toolCalls: [{ id: 'c1', type: 'function', function: { name: 'query_db', arguments: '{}' } }], finishReason: 'tool_calls' });
          throw Object.assign(new Error('provider 500'), { status: 400 });
          yield { type: 'content', text: '' };
        })()),
      };
      await say(makeApp(llm, declaringExecutor()), 'summarize the PV weekly data');
      const job = jobs.activeJobs()[0];
      expect(job).toMatchObject({ seq: 1, goal: 'summarize the PV weekly data', continueRequestedAt: expect.any(String) });
      expect(job.continueReason).toContain('failed');
      expect(runner.request).toHaveBeenCalledWith(job.id);
      const main = rowsOf(null).map(row => row.content);
      expect(main[1]).toContain('carries on as a job by itself');
      expect(main[2]).toBe(`[[job:${job.id}:started]]`);
    });

    // Owner decision 2026-11-10: a job is data work when the turn that hands it off already did data work, whatever its words.
    it('a hand-off sees the data tools its turn called before it', async () => {
      bindRunner();
      const executor = declaringExecutor();
      const declaring = executor.executeTool;
      const seen: boolean[] = [];
      executor.executeTool = vi.fn(async (call: any, context: any) => {
        seen.push(context.turnDataWork?.() === true);
        return declaring(call, context);
      });
      const llm = model([
        { tools: [{ name: 'list_data_room_datasets', arguments: '{}' }] },
        { tools: [{ name: 'job_update', arguments: '{"action":"start","title":"Local launch"}' }] },
        { text: 'On it.' },
      ]);
      await say(makeApp(llm, executor), 'Look after the Local launch for me.');
      expect(seen).toEqual([false, true]);
    });

    it('a failed main chat turn that had called a data tool becomes a data job, whatever its words', async () => {
      bindRunner();
      let call = 0;
      const llm = {
        getActiveEndpoint: () => 'ecs',
        chatCompletionStream: vi.fn(() => (async function* () {
          call++;
          if (call === 1) return streamResult({ toolCalls: [{ id: 'c1', type: 'function', function: { name: 'list_data_room_datasets', arguments: '{}' } }], finishReason: 'tool_calls' });
          throw Object.assign(new Error('provider 500'), { status: 400 });
          yield { type: 'content', text: '' };
        })()),
      };
      await say(makeApp(llm, declaringExecutor()), 'Look after the Local launch for me.');
      const job = jobs.activeJobs()[0];
      expect(job).toMatchObject({ seq: 1, goal: 'Look after the Local launch for me.' });
      expect(job.dataWork).toBe(true);
    });

    it('a main chat ETL run that outlives the turn surfaces as a numbered job; one the turn used folds away unseen', async () => {
      bindRunner();
      const outlived = model([
        { tools: [{ name: 'mcp_etl_run_query', arguments: '{"runId":"901"}' }] },
        { text: 'Run 901 is going; I will report when it finishes.' },
      ]);
      await say(makeApp(outlived, declaringExecutor()), 'weekly downloads by state');
      const surfaced = jobs.activeJobs();
      expect(surfaced).toHaveLength(1);
      expect(surfaced[0]).toMatchObject({ seq: 1, goal: 'weekly downloads by state' });
      expect(jobs.watch('901')).toMatchObject({ jobId: surfaced[0].id, status: 'pending' });
      expect(rowsOf(null).at(-1)?.content).toBe(`[[job:${surfaced[0].id}:started]]`);

      const answered = model([
        { tools: [{ name: 'mcp_etl_run_query', arguments: '{"runId":"902","finishInTurn":true}' }] },
        { text: '1,234 downloads.' },
      ]);
      await say(makeApp(answered, declaringExecutor()), 'downloads yesterday?');
      const folded = jobs.get(jobs.watch('902')!.jobId)!;
      expect(folded).toMatchObject({ status: 'done', endReason: 'answered in the main chat', seq: 0 });
      expect(jobs.activeJobs().map(job => job.seq)).toEqual([1]);
      expect(rowsOf(null).at(-1)?.content).toBe('1,234 downloads.');
      expect((await request(makeApp(model([{ text: 'x' }]), { executeTool: vi.fn() })).get('/api/chat/jobs')).body.recent).toEqual([]);
    });

    it('a plain main chat question with no tools creates nothing', async () => {
      bindRunner();
      await say(makeApp(model([{ text: 'Hi.' }]), declaringExecutor()), 'hello');
      expect(jobs.activeJobs()).toEqual([]);
    });

    it('an owner reply in a paused job\'s thread that only chats keeps it paused', async () => {
      const runner = bindRunner();
      const job = jobs.start({ goal: 'Build the PV dashboard' });
      jobs.settle(job.id, { action: 'pause', note: 'Two turns in a row failed.', kind: 'stuck' }, 'failed');
      await new Promise(resolve => setTimeout(resolve, 5));
      await say(makeApp(model([{ text: 'It failed on the cohort join.' }]), declaringExecutor()), 'why did it stop?', { jobId: job.id });
      expect(jobs.get(job.id)).toMatchObject({ pauseNote: 'Two turns in a row failed.', pauseKind: 'stuck' });
      expect(runner.request).not.toHaveBeenCalled();
    });

    // Owner report 2026-11-08: "the results of a job are kept quiet inside the job itself" (PARALLEL_JOBS_PLAN.md §11 R1).
    it('a job that finishes posts its own report in the main chat once, and the main chat\'s model gets it in its history', async () => {
      bindRunner();
      const job = jobs.start({ goal: 'Build the PV dashboard' });
      const llm = model([
        { tools: [{ name: 'job_update', arguments: '{"action":"done","summary":"Dashboard verified"}' }] },
        { text: '**Dashboard is live.** 6 of 6 widgets loaded; downloads are down 4% week over week.' },
      ]);
      const app = makeApp(llm, declaringExecutor());
      await request(app).post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id));
      const report = '**Dashboard is live.** 6 of 6 widgets loaded; downloads are down 4% week over week.';
      expect(rowsOf(null)).toEqual([{ role: 'assistant', content: `${report}\n\n[[job:${job.id}:report]]`, ref: job.id }]);
      expect(appendAssistant).toHaveBeenCalledWith('sess-test', expect.stringContaining(`Job #${job.seq} "${job.title}" is done. Its report, as posted in this chat:\n\n${report}`));
      // Posted once: a later turn's end (or the boot) finds nothing more to post.
      expect(bridge.jobDesk()?.deliverReports()).toBe(0);
      expect(rowsOf(null)).toHaveLength(1);
      const list = (await request(app).get('/api/chat/jobs')).body;
      expect(list.jobs).toEqual([]);
      expect(list.recent[0]).toMatchObject({ id: job.id, status: 'done', endReason: 'Dashboard verified' });
    });

    it('a #N message from the main chat that finishes the job shows its reply there once, with the job\'s card under it', async () => {
      bindRunner();
      const job = jobs.start({ goal: 'Monthly players report', title: 'Monthly report' });
      const llm = model([
        { tools: [{ name: 'job_update', arguments: '{"action":"done","summary":"February added"}' }] },
        { text: 'Added February: 4,120 players.' },
      ]);
      await say(makeApp(llm, declaringExecutor()), `#${job.seq} add February`);
      expect(rowsOf(null)).toEqual([
        { role: 'user', content: `#${job.seq} add February`, ref: job.id },
        { role: 'assistant', content: 'Added February: 4,120 players.', ref: job.id },
        { role: 'assistant', content: `[[job:${job.id}:report]]`, ref: job.id },
      ]);
      expect(jobs.get(job.id)).toMatchObject({ status: 'done', report: 'Added February: 4,120 players.', reportedAt: expect.any(String) });
      expect(appendAssistant).toHaveBeenCalledWith('sess-test', expect.stringContaining('Its report, as posted in this chat:\n\nAdded February: 4,120 players.'));
    });

    it('a report that finishes while the owner talks in the main chat waits for that reply, then lands after it', async () => {
      bindRunner();
      const job = jobs.start({ goal: 'Refresh the downloads dashboard' });
      const gate = deferred();
      // One router (as in BotBoy): call 0 is the owner's main-chat turn, held open; calls 1-2 are the job's turn that finishes.
      const llm = model([
        { waitFor: gate.promise, text: 'Here is your answer.' },
        { tools: [{ name: 'job_update', arguments: '{"action":"done","summary":"Refreshed"}' }] },
        { text: 'All six widgets refreshed.' },
      ]);
      const app = makeApp(llm, declaringExecutor());
      const mainTurn = say(app, 'what is on my calendar?').then(response => response);
      await vi.waitFor(() => expect(llm.chatCompletionStream).toHaveBeenCalled());
      await request(app).post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id));
      expect(rowsOf(null).some(row => row.content.includes(':report]]'))).toBe(false);
      gate.resolve();
      await mainTurn;
      const rows = rowsOf(null).map(row => row.content);
      expect(rows.at(-1)).toBe(`All six widgets refreshed.\n\n[[job:${job.id}:report]]`);
      expect(rows.indexOf('Here is your answer.')).toBeLessThan(rows.length - 1);
    });

    // Owner decision 2026-11-09 (§12): every job state goes to the main chat model, which decides with its own tools.
    it('a job that gets stuck keeps the turn\'s tool calls for the main chat\'s look, which is nudged; no stuck card lands first', async () => {
      bindRunner();
      const jobReviews = { nudge: vi.fn(), isReviewing: () => false };
      const job = jobs.start({ goal: 'Weekly PV players for Local' });
      jobs.settle(job.id, { action: 'continue', reason: 'x', undeclared: true }, 'answered'); // one undeclared end already
      const llm = model([{ tools: [{ name: 'query_db', arguments: '{"sql":"select dt from t"}' }] }, { text: 'The query failed again.' }]);
      const executor = { executeTool: vi.fn(async (call: any) => ({ toolCallId: call.id, content: '{"error":"column dt does not exist"}' })) };
      await request(makeApp(llm, executor, { jobReviews }))
        .post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id));
      expect(jobs.get(job.id)).toMatchObject({
        pauseKind: 'stuck',
        lastTools: [{ name: 'query_db', args: '{"sql":"select dt from t"}', result: '{"error":"column dt does not exist"}' }],
      });
      expect(jobReviews.nudge).toHaveBeenCalled();
      expect(rowsOf(null).some(row => row.content.includes(':stuck]]'))).toBe(false);
    });

    it('an owner turn in a job\'s thread uses up a finished refresh for that job only; another job waiting on it still wakes', async () => {
      bindRunner();
      const job = jobs.start({ goal: 'Refresh the downloads dashboard' });
      const other = jobs.start({ goal: 'Weekly report from the same dashboard' });
      for (const id of [job.id, other.id]) {
        jobs.addDashboardWait({ runId: 'run_abd1cfcd40e545fe', jobId: id, dashboardId: 'dash_1', title: 'Downloads' });
        jobs.finishDashboardWait('run_abd1cfcd40e545fe', id, { remoteStatus: 'COMPLETED', widgetCount: 2, widgetsSucceeded: 2 });
      }
      await say(makeApp(model([{ text: 'Both widgets loaded.' }]), declaringExecutor()), 'how did it go?', { jobId: job.id });
      expect(jobs.unconsumedFinished(job.id)).toEqual([]);
      expect(jobs.unconsumedFinished(other.id)).toMatchObject([{ runId: 'run_abd1cfcd40e545fe', source: 'dashboard' }]);
    });

    // Live 2026-11-09: job #12 read its Downloads dashboard every turn to watch a refresh it had not started, slept 3 minutes and
    // said continue; the dashboard was never in its working set, so nothing made it wait.
    it('a job turn that only read a dashboard whose refresh still runs waits for that refresh too', async () => {
      const runner = bindRunner();
      const job = jobs.start({ goal: 'Repair both dashboard refreshes' });
      const analyticsService = {
        getDashboard: vi.fn((id: string) => (id === 'dash_38326feaa58f4933'
          ? { title: 'Downloads', recentRuns: [{ id: 'run_68b067b849044a63', status: 'running' }] }
          : { title: 'Other', recentRuns: [{ id: 'run_0000bbbb', status: 'running' }] })),
      };
      const llm = model([
        { tools: [
          { name: 'get_analytics_dashboard', arguments: '{"dashboardId":"dash_38326feaa58f4933"}' },
          { name: 'get_dashboard_sharing_status', arguments: '{"dashboardId":"dash_0ther0000000000"}' },
          { name: 'job_update', arguments: '{"action":"continue","nextStep":"Check the refresh again"}' },
        ] },
        { text: 'The contribution widget is still refreshing.' },
      ]);
      await request(makeApp(llm, declaringExecutor(), { analyticsService }))
        .post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id));
      expect(jobs.get(job.id)!.continueRequestedAt).toBeUndefined();
      expect(runner.request).not.toHaveBeenCalledWith(job.id);
      // Only the dashboard it read: no other dashboard's refresh holds it, and reading one never makes it the job's result.
      expect(jobs.watchesForJob(job.id)).toMatchObject([{ runId: 'run_68b067b849044a63', source: 'dashboard', dashboardId: 'dash_38326feaa58f4933', purpose: 'refresh of dashboard "Downloads"' }]);
      expect(jobs.get(job.id)!.workingSet.dashboards).toEqual([]);
    });

    it('a job turn that would continue while its dashboard refresh runs waits for it instead (§12 R1)', async () => {
      const runner = bindRunner();
      const job = jobs.start({ goal: 'Refresh the downloads dashboard' });
      jobs.recordDashboard(job.id, { dashboardId: 'dash_38326feaa58f4933', title: 'Downloads' });
      const analyticsService = {
        getDashboard: vi.fn(() => ({ title: 'Downloads', recentRuns: [
          { id: 'run_abd1cfcd40e545fe', status: 'running' }, { id: 'run_0000aaaa', status: 'completed' },
        ] })),
      };
      const llm = model([
        { tools: [{ name: 'job_update', arguments: '{"action":"continue","nextStep":"Check the refresh"}' }] },
        { text: 'The refresh is still running; checking again.' },
      ]);
      await request(makeApp(llm, declaringExecutor(), { analyticsService }))
        .post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id));
      const after = jobs.get(job.id)!;
      expect(after.continueRequestedAt).toBeUndefined();
      expect(after.pausedAt).toBeUndefined();
      expect(runner.request).not.toHaveBeenCalledWith(job.id);
      expect(jobs.watchesForJob(job.id)).toMatchObject([{ runId: 'run_abd1cfcd40e545fe', source: 'dashboard', status: 'pending', dashboardId: 'dash_38326feaa58f4933' }]);
      const listed = (await request(makeApp(llm, declaringExecutor(), { analyticsService })).get('/api/chat/jobs')).body.jobs[0];
      expect(listed.phase).toBe('waiting');
      // The panel names what the job waits for in the owner's words (docs/maps/job-waits.md).
      expect(listed.waitingRuns).toEqual([expect.objectContaining({ runId: 'run_abd1cfcd40e545fe', kind: 'dashboard_refresh', label: expect.stringMatching(/^the refresh of dashboard /) })]);
    });

    it('a main-chat message to a job comes back with the job\'s answer as "#N replied" (§11 R3)', async () => {
      const runner = bindRunner();
      const job = jobs.start({ goal: 'Weekly PV players for Local' });
      // The main chat's owner turn (the tool would do this through the context's messageJob).
      makeApp(model([{ text: 'x' }]), declaringExecutor());
      const sent = await bridge.jobDesk()!.messageJob(job.id, 'Add last week too.', { from: 'main_chat', ownerWords: 'tell the Local job to add last week' });
      expect(sent).toMatchObject({ ok: true, job: { number: job.seq } });
      expect(runner.request).toHaveBeenCalledWith(job.id);
      expect(rowsOf(job.id).at(-1)?.content).toBe('↪ From the main chat: Add last week too.');
      // The job's automatic turn answers it; the answer goes back to the main chat, once.
      const llm = model([{ tools: [{ name: 'job_update', arguments: '{"action":"continue","nextStep":"Pull last week"}' }] }, { text: 'Adding last week (Oct 26 to Nov 1) now.' }]);
      await request(makeApp(llm, declaringExecutor())).post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id, 2));
      expect(rowsOf(null)).toEqual([{ role: 'assistant', content: 'Adding last week (Oct 26 to Nov 1) now.', ref: job.id }]);
      expect(appendAssistant).toHaveBeenCalledWith('sess-test', expect.stringContaining('replied to the main chat\'s message'));
      expect(jobs.get(job.id)?.mainReplyAt).toBeUndefined();
    });

    it('a main-chat message waits while the owner talks to the job in its thread, and reaches the job when that reply ends', async () => {
      const runner = bindRunner();
      const job = jobs.start({ goal: 'Weekly PV players for Local' });
      const gate = deferred();
      const ownerLlm = model([{ waitFor: gate.promise, text: 'Here is where it stands.' }]);
      const app = makeApp(ownerLlm, declaringExecutor());
      const inThread = say(app, 'how is it going?', { jobId: job.id }).then(response => response);
      await vi.waitFor(() => expect(ownerLlm.chatCompletionStream).toHaveBeenCalled());
      const sent = await bridge.jobDesk()!.messageJob(job.id, 'Add last week too.', { from: 'main_chat', ownerWords: 'tell the Local job to add last week' });
      expect(sent).toMatchObject({ ok: true, queued: true, job: { number: job.seq } });
      // Nothing reaches the job while he talks to it.
      expect(jobs.get(job.id)!.inbox).toEqual([]);
      expect(rowsOf(job.id).map(row => row.content)).not.toContain('↪ From the main chat: Add last week too.');
      gate.resolve();
      expect((await inThread).status).toBe(200);
      await vi.waitFor(() => expect(jobs.get(job.id)!.inbox).toEqual([expect.objectContaining({ from: 'main_chat', text: 'Add last week too.' })]));
      expect(rowsOf(job.id).at(-1)?.content).toBe('↪ From the main chat: Add last week too.');
      expect(jobs.get(job.id)).toMatchObject({ continueRequestedAt: expect.any(String), mainReplyAt: expect.any(String) });
      expect(runner.request).toHaveBeenCalledWith(job.id);
    });

    it('the jobs tool is offered only in the main chat\'s owner turns, with a way to message a job', async () => {
      const job = jobs.start({ goal: 'Weekly PV players for Local', title: 'Local players' });
      const executeTool = vi.fn(async (call: any) => ({ toolCallId: call.id, content: '{"ok":true}' }));
      const app = makeApp(model([
        { tools: [{ name: 'query_db', arguments: '{}' }] }, { text: 'ok' },
        { tools: [{ name: 'query_db', arguments: '{}' }] }, { text: 'ok' },
      ]), { executeTool });
      await say(app, 'how is the Local job going?');
      expect(promptContexts[0]).toMatchObject({ mainChatTurn: true, jobTurn: false });
      expect(typeof executeTool.mock.calls[0][1].messageJob).toBe('function');
      await say(app, 'check', { jobId: job.id });
      expect(promptContexts[1]).toMatchObject({ mainChatTurn: false, jobTurn: true });
      expect(executeTool.mock.calls.at(-1)[1].messageJob).toBeUndefined();
    });

    it('a provider limit makes the job wait its turn in line instead of failing (PJ2)', async () => {
      const runner = bindRunner();
      const job = jobs.start({ goal: 'Build the PV dashboard' });
      const llm = {
        getActiveEndpoint: () => 'ecs',
        chatCompletionStream: vi.fn(() => (async function* () {
          throw Object.assign(new Error('The AI provider is rate-limiting this API key.'), { code: 'LLM_RATE_LIMITED', retryAfterMs: 20_000 });
          yield { type: 'content', text: '' };
        })()),
      };
      await request(makeApp(llm, declaringExecutor())).post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id));
      expect(runner.providerLimited).toHaveBeenCalledWith('active', 20_000, 'limit'); // the single-client connection
      expect(jobs.get(job.id)).toMatchObject({ rateWaitUntil: '2026-10-28T10:05:00.000Z', continueRequestedAt: expect.any(String), failedTurns: 0 });
      expect(rowsOf(job.id).at(-1)?.content).toContain('waits its turn and carries on by itself');
      expect(runner.request).toHaveBeenCalledWith(job.id);
      expect(runner.providerClear).not.toHaveBeenCalled();
    });

    // Live 2026-10-29 16:09: the Mac lost DNS for a moment; a job turn failed on ENOTFOUND, retried at once, failed again and
    // went stuck until the owner said "try again" an hour later. A network outage is a wait now (owner approval 2026-10-29).
    it('a network outage makes a job wait and try again instead of failing twice and going stuck', async () => {
      const runner = bindRunner();
      const job = jobs.start({ goal: 'Audit offline study gaps' });
      const unreachable = () => ({
        getActiveEndpoint: () => 'ecs',
        chatCompletionStream: vi.fn(() => (async function* () {
          throw Object.assign(new TypeError('fetch failed (ENOTFOUND)'), { cause: { code: 'ENOTFOUND' } });
          yield { type: 'content', text: '' };
        })()),
      });
      for (let attempt = 1; attempt <= 3; attempt++) {
        await request(makeApp(unreachable(), declaringExecutor())).post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id, attempt));
        expect(jobs.get(job.id), `attempt ${attempt}`).toMatchObject({ status: 'active', failedTurns: 0, rateWaitUntil: '2026-10-28T10:05:00.000Z', continueRequestedAt: expect.any(String) });
        expect(jobs.get(job.id)?.pausedAt, `attempt ${attempt}`).toBeUndefined();
      }
      expect(runner.providerLimited).toHaveBeenCalledTimes(3);
      expect(runner.providerLimited).toHaveBeenLastCalledWith('active', undefined, 'network');
      expect(jobs.get(job.id)?.continueReason).toContain('could not reach the AI model');
      expect(rowsOf(job.id).at(-1)?.content).toContain('⏳ BotBoy couldn\'t reach the AI model (fetch failed (ENOTFOUND)). This work waits and carries on by itself when the connection is back; nothing done so far is lost.');
    });

    it('a plain main chat question that hits a network outage still says to resend it (nothing carries on by itself)', async () => {
      const runner = bindRunner();
      const llm = {
        getActiveEndpoint: () => 'ecs',
        chatCompletionStream: vi.fn(() => (async function* () {
          throw new TypeError('fetch failed (ENOTFOUND)');
          yield { type: 'content', text: '' };
        })()),
      };
      await say(makeApp(llm, declaringExecutor()), 'what is on my calendar?');
      expect(runner.providerLimited).not.toHaveBeenCalled();
      expect(jobs.activeJobs()).toEqual([]);
      expect(rowsOf(null).at(-1)?.content).toContain('Please resend your message to continue.');
    });
  });
});
