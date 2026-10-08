import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createChatJobStore, type ChatJobStore } from '../core/chat-jobs.js';
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
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
    jobs = createChatJobStore(db);
    bridge = createContinuationBridge();
    promptContexts = [];
    appendUser = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
    storage.close();
  });

  function makeApp(llmClient: any, toolExecutor: any) {
    const server = express();
    server.use(express.json());
    server.use('/api', createRouter({
      nodeManager: createNodeManager(db),
      db,
      llmClient,
      toolExecutor,
      chatJobs: jobs,
      chatContinuations: bridge,
      chatInterface: { getHistory: () => [], sendMessage: async () => ({ message: { id: 'x', role: 'assistant', content: '' } }) } as any,
      promptManager: {
        getSystemPrompt: (_role: string, context: any) => { promptContexts.push(context); return 'You are a test bot.'; },
        getToolDefinitions: () => TOOL_DEFS,
      } as any,
      conversationManager: {
        getActiveSessionId: () => 'sess-test',
        createSession: () => 'sess-test',
        appendUser,
        appendAssistant: vi.fn(),
        countUserMessages: () => 1,
        getSummary: () => null,
        getMessages: () => [],
        getMessagesSinceId: () => [],
        getRecentMessages: () => [{ role: 'user' as const, content: 'latest' }],
        saveSummary: vi.fn(),
      } as any,
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
  });

  it('an owner turn in progress goes first; its message preempts a running continuation', async () => {
    const job = jobs.start({ goal: 'Build the PV dashboard' });
    const ownerGate = deferred();
    const ownerLlm = model([{ waitFor: ownerGate.promise, text: 'Owner answer.' }]);
    const app = makeApp(ownerLlm, { executeTool: vi.fn() });
    const ownerTurn = request(app).post('/api/chat/messages').send({ message: 'how is it going?', stream: true });
    const ownerDone = ownerTurn.then(response => response);
    await vi.waitFor(() => expect(ownerLlm.chatCompletionStream).toHaveBeenCalled());
    const busy = await request(app).post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id));
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('owner_turn_active');
    ownerGate.resolve();
    await ownerDone;

    // Now a continuation runs and the owner writes during it.
    const never = deferred();
    const contLlm = model([{ waitFor: never.promise, text: 'never' }, { text: 'Answer to the owner.' }]);
    const app2 = makeApp(contLlm, { executeTool: vi.fn() });
    const continuation = request(app2).post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id, 2));
    const continuationDone = continuation.then(response => response);
    await vi.waitFor(() => expect(contLlm.chatCompletionStream).toHaveBeenCalledTimes(1));
    expect(bridge.isTurnActive()).toBe(true);
    const owner = await request(app2).post('/api/chat/messages').send({ message: 'change of plan', stream: true });
    expect(owner.status).toBe(200);
    await continuationDone;
    const rows = chatRows().map(row => row.content);
    const preempted = rows.findIndex(content => content.endsWith(CONTINUATION_PREEMPTED_TEXT));
    expect(preempted).toBeGreaterThanOrEqual(0);
    expect(rows[preempted]).toMatch(/^↻ Continued automatically/);
    // The continuation's note lands before the owner's message.
    expect(rows.indexOf('change of plan')).toBeGreaterThan(preempted);
    expect(rows.at(-1)).toBe('Answer to the owner.');
  });

  it('an owner turn carries the job block, records its model and thinking, and uses finished runs', async () => {
    const job = jobs.start({ goal: 'Build the PV dashboard' });
    jobs.addWatch({ runId: '42', jobId: job.id, source: 'run_query' });
    jobs.finishWatch('42', { remoteStatus: 'SUCCESS', savedTo: '/f/etl-results/adhoc_42.tsv', rowCount: 3 });
    const llm = model([{ text: 'Here is where it stands.' }]);
    await request(makeApp(llm, { executeTool: vi.fn() })).post('/api/chat/messages').send({ message: 'check', stream: true, thinking: 'high' });
    expect(promptContexts[0].jobBlock).toContain('"Build the PV dashboard"');
    expect(promptContexts[0].jobBlock).toContain('42: SUCCESS — 3 rows');
    expect(jobs.get(job.id)).toMatchObject({ thinking: 'high' });
    expect(jobs.unconsumedFinished(job.id)).toEqual([]);
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

  it('job routes: the active job for the strip, Stop only from the owner UI', async () => {
    const job = jobs.start({ goal: 'Build the PV dashboard' });
    jobs.addWatch({ runId: '55', jobId: job.id, source: 'run_query', purpose: 'Local weekly' });
    const server = await listening(makeApp(model([{ text: 'x' }]), { executeTool: vi.fn() }));
    try {
      const port = (server.address() as AddressInfo).port;
      const active = await request(server).get('/api/chat/jobs/active');
      expect(active.body.job).toMatchObject({ id: job.id, goal: 'Build the PV dashboard', waitingRuns: [{ runId: '55', purpose: 'Local weekly' }], continuing: false });
      const scripted = await request(server).post(`/api/chat/jobs/${job.id}/stop`);
      expect(scripted.status).toBe(403);
      expect(jobs.get(job.id)?.status).toBe('active');
      const stopped = await request(server).post(`/api/chat/jobs/${job.id}/stop`)
        .set('Origin', `http://127.0.0.1:${port}`).set('Sec-Fetch-Site', 'same-origin');
      expect(stopped.body).toMatchObject({ ok: true, job: { id: job.id, status: 'stopped' } });
      expect(jobs.watch('55')?.status).toBe('abandoned');
      expect((await request(server).get('/api/chat/jobs/active')).body.job).toBeNull();
    } finally {
      server.close();
    }
  });

  it('a stopped job ends its running continuation with a plain note', async () => {
    const job = jobs.start({ goal: 'Build the PV dashboard' });
    const never = deferred();
    const llm = model([{ waitFor: never.promise, text: 'never' }]);
    const server = await listening(makeApp(llm, { executeTool: vi.fn() }));
    try {
      const port = (server.address() as AddressInfo).port;
      const running = request(server).post('/api/chat/messages').set(CONTINUATION_HEADER, bridge.secret).send(continuationBody(job.id)).then(response => response);
      await vi.waitFor(() => expect(llm.chatCompletionStream).toHaveBeenCalled());
      const stopped = await request(server).post(`/api/chat/jobs/${job.id}/stop`)
        .set('Origin', `http://127.0.0.1:${port}`).set('Sec-Fetch-Site', 'same-origin');
      expect(stopped.body.stoppedTurns).toBe(1);
      await running;
      expect(chatRows().at(-1)?.content).toBe(`↻ Continued automatically: run 1 finished (3 rows).\n\n${JOB_STOPPED_TEXT}`);
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
      const runner = { request: vi.fn(), start: vi.fn(), stop: vi.fn(), tick: vi.fn(), running: () => null, forget: vi.fn() };
      bridge.bindRunner(runner as any);
      return runner;
    }
    /** A tool executor whose job_update records the declaration like the real handler. */
    function declaringExecutor() {
      return {
        executeTool: vi.fn(async (call: any) => {
          if (call.function.name === 'job_update') {
            const args = JSON.parse(call.function.arguments);
            const job = jobs.activeJob()!;
            jobs.declare(job.id, args.action, args.nextStep ?? args.question);
          }
          return { toolCallId: call.id, content: '{"ok":true}' };
        }),
      };
    }

    it('a turn that declares continue starts the next turn on its own', async () => {
      const runner = bindRunner();
      const job = jobs.start({ goal: 'Build the PV dashboard' });
      const llm = model([
        { tools: [{ name: 'job_update', arguments: '{"action":"continue","nextStep":"Build the widgets"}' }] },
        { text: 'Data is in; building the widgets next.' },
      ]);
      const app = makeApp(llm, declaringExecutor());
      const res = await request(app).post('/api/chat/messages').send({ message: 'build it', stream: true });
      expect(res.status).toBe(200);
      const after = jobs.get(job.id)!;
      expect(after.continueRequestedAt).toBeTruthy();
      expect(after.continueReason).toBe('Build the widgets');
      expect(after.pausedAt).toBeUndefined();
      expect(runner.request).toHaveBeenCalledWith(job.id);
      const strip = await request(app).get('/api/chat/jobs/active');
      expect(strip.body.job.phase).toBe('continuing');
    });

    it('needs_owner pauses with the question; the strip says Paused, not working', async () => {
      const runner = bindRunner();
      const job = jobs.start({ goal: 'Build the PV dashboard' });
      const llm = model([
        { tools: [{ name: 'job_update', arguments: '{"action":"needs_owner","question":"Use the 2025 cohort or all years?"}' }] },
        { text: 'Which cohort should I use?' },
      ]);
      const app = makeApp(llm, declaringExecutor());
      await request(app).post('/api/chat/messages').send({ message: 'build it', stream: true });
      const after = jobs.get(job.id)!;
      expect(after.pausedAt).toBeTruthy();
      expect(after.pauseNote).toBe('Use the 2025 cohort or all years?');
      expect(runner.request).not.toHaveBeenCalled();
      const strip = await request(app).get('/api/chat/jobs/active');
      expect(strip.body.job).toMatchObject({ phase: 'paused', pauseNote: 'Use the 2025 cohort or all years?' });
    });

    it('an undeclared end continues once with a nudge, then a second undeclared end pauses', async () => {
      const runner = bindRunner();
      const job = jobs.start({ goal: 'Build the PV dashboard' });
      const ownerTurn = model([{ tools: [{ name: 'query_db', arguments: '{"sql":"select 1"}' }] }, { text: 'Loaded the data. Next I will build the widgets.' }]);
      await request(makeApp(ownerTurn, declaringExecutor())).post('/api/chat/messages').send({ message: 'build it', stream: true });
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
      expect(after.pausedAt).toBeTruthy();
      expect(after.pauseNote).toContain('Still thinking about the widgets.');
      expect(runner.request).toHaveBeenCalledTimes(1);
    });

    it('an undeclared end with watched runs pending just waits', async () => {
      const runner = bindRunner();
      const job = jobs.start({ goal: 'Build the PV dashboard' });
      jobs.addWatch({ runId: '77', jobId: job.id, source: 'run_query' });
      const llm = model([{ tools: [{ name: 'query_db', arguments: '{}' }] }, { text: 'Run 77 is going; I continue when it finishes.' }]);
      const app = makeApp(llm, declaringExecutor());
      await request(app).post('/api/chat/messages').send({ message: 'build it', stream: true });
      const after = jobs.get(job.id)!;
      expect(after.continueRequestedAt).toBeUndefined();
      expect(after.pausedAt).toBeUndefined();
      expect(runner.request).not.toHaveBeenCalled();
      expect((await request(app).get('/api/chat/jobs/active')).body.job.phase).toBe('waiting');
    });

    it('a failed owner turn that had done work becomes a job and continues once', async () => {
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
      await request(makeApp(llm, declaringExecutor())).post('/api/chat/messages').send({ message: 'summarize the PV weekly data', stream: true });
      const job = jobs.activeJob();
      expect(job?.goal).toBe('summarize the PV weekly data');
      expect(job?.continueRequestedAt).toBeTruthy();
      expect(job?.continueReason).toContain('failed');
      expect(runner.request).toHaveBeenCalledWith(job!.id);
    });

    it('a plain owner question with no job and no tools creates nothing', async () => {
      bindRunner();
      await request(makeApp(model([{ text: 'Hi.' }]), declaringExecutor())).post('/api/chat/messages').send({ message: 'hello', stream: true });
      expect(jobs.activeJob()).toBeNull();
    });

    it('an owner reply to a paused job that only chats keeps it paused', async () => {
      const runner = bindRunner();
      const job = jobs.start({ goal: 'Build the PV dashboard' });
      jobs.settle(job.id, { action: 'pause', note: 'Which cohort?' }, 'answered');
      await new Promise(resolve => setTimeout(resolve, 5));
      await request(makeApp(model([{ text: 'Sure, tell me when.' }]), declaringExecutor())).post('/api/chat/messages').send({ message: 'what was the question?', stream: true });
      expect(jobs.get(job.id)?.pauseNote).toBe('Which cohort?');
      expect(runner.request).not.toHaveBeenCalled();
    });

    it('the strip shows a job that just finished as done', async () => {
      const job = jobs.start({ goal: 'Build the PV dashboard' });
      jobs.end(job.id, 'done', 'dashboard verified');
      const res = await request(makeApp(model([{ text: 'x' }]), { executeTool: vi.fn() })).get('/api/chat/jobs/active');
      expect(res.body.job).toBeNull();
      expect(res.body.recent).toMatchObject({ id: job.id, status: 'done', endReason: 'dashboard verified' });
    });
  });
});
