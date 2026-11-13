import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createChatJobStore, type ChatJob, type ChatJobStore } from '../core/chat-jobs.js';
import { createChatInterface } from '../core/chat-interface.js';
import { CONTINUATION_HEADER, createContinuationBridge, JOB_UPDATE_TRIGGER_HEADER, type ContinuationBridge } from '../core/chat-continuations.js';
import { withJobMandate } from '../core/job-mandate.js';
import { createRouter } from './routes.js';

/**
 * The main chat's job updates through the chat route (PARALLEL_JOBS_PLAN.md §12, owner decision 2026-11-09): only BotBoy's secret
 * and a claimed state start one, it is BotBoy's own turn in the main chat (no owner row, read tools and `jobs` only), its decision
 * lands with the job's card, the owner's own message there stops it, and how it ends settles the state it claimed.
 */

function streamResult(partial: Record<string, unknown>) {
  return { content: '', reasoning: '', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'stop', ...partial };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const TOOL_DEFS = ['query_db', 'gmail_send', 'run_command', 'get_analytics_dashboard', 'refresh_analytics_dashboard', 'jobs', 'job_update']
  .map(name => ({ type: 'function', function: { name, description: name, parameters: {} } }));

describe('job updates in the main chat', () => {
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
  afterEach(() => storage.close());

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

  /** A model that answers each call in turn (tool calls first, then text); a step may wait until released or aborted. */
  function model(script: Array<{ tools?: Array<{ name: string; arguments: string }>; text?: string; waitFor?: Promise<void>; fail?: Error }>) {
    let call = 0;
    const requests: any[] = [];
    return {
      requests,
      getActiveEndpoint: () => 'ecs',
      chatCompletionStream: vi.fn((req: any) => {
        // A copy: the route keeps adding to the same message list after the call returns.
        requests.push({ ...req, messages: Array.isArray(req.messages) ? req.messages.map((message: any) => ({ ...message })) : req.messages });
        const step = script[Math.min(call, script.length - 1)];
        call++;
        return (async function* () {
          if (step.waitFor) {
            await Promise.race([step.waitFor, new Promise<void>((resolve) => req.signal?.addEventListener('abort', () => resolve(), { once: true }))]);
            if (req.signal?.aborted) throw new Error('aborted');
          }
          if (step.fail) throw step.fail;
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

  const NOTE = '↻ Job update: #1 Weekly players paused after 25 automatic turns in a row.';
  /** A job BotBoy paused at its turn limit, its state claimed by the runner (job-review.ts › tick). */
  function limitedJob(): { job: ChatJob; key: string } {
    const job = jobs.start({ goal: 'Weekly PV players for Local', title: 'Weekly players' });
    jobs.settle(job.id, { action: 'pause', note: 'Paused after 25 automatic turns in a row. Reply to continue.', kind: 'limit' }, 'answered');
    const key = `limit:${jobs.get(job.id)!.pausedAt}`;
    expect(jobs.claimReview(job.id, key)).toBe(true);
    return { job: jobs.get(job.id)!, key };
  }
  const reviewBody = (jobId: string, key: string, extra: Record<string, unknown> = {}) => ({
    message: `${JOB_UPDATE_TRIGGER_HEADER}\nJob #1 "Weekly players" needs a decision.`,
    stream: true,
    review: { jobId, key, note: NOTE },
    ...extra,
  });
  const sendReview = (app: express.Express, body: Record<string, unknown>, secret = bridge.secret) =>
    request(app).post('/api/chat/messages').set(CONTINUATION_HEADER, secret).send(body);
  const say = (app: express.Express, message: string, extra: Record<string, unknown> = {}) =>
    request(app).post('/api/chat/messages').send({ message, stream: true, ...extra });
  const mainRows = () => db.prepare('SELECT role, content, ref_job_id AS ref FROM chat_messages WHERE job_id IS NULL ORDER BY rowid').all() as
    Array<{ role: string; content: string; ref: string | null }>;
  const okTool = () => ({ executeTool: vi.fn(async (call: any) => ({ toolCallId: call.id, content: '{"ok":true}' })) });

  it('refuses a wrong secret, a state nobody claimed, an ended job and a turn that is not streamed, writing nothing', async () => {
    const llm = model([{ text: 'never' }]);
    const app = makeApp(llm, okTool());
    const { job, key } = limitedJob();
    expect((await sendReview(app, reviewBody(job.id, key), 'not-the-secret')).status).toBe(403);
    const unclaimed = await sendReview(app, reviewBody(job.id, `${key}x`));
    expect(unclaimed.status).toBe(409);
    expect(unclaimed.body.code).toBe('review_not_claimed');
    expect((await sendReview(app, reviewBody(job.id, key, { stream: false }))).status).toBe(400);
    jobs.end(job.id, 'stopped', 'stopped by the owner');
    const ended = await sendReview(app, reviewBody(job.id, key));
    expect(ended.status).toBe(409);
    expect(ended.body.code).toBe('job_not_active');
    expect(mainRows()).toEqual([]);
    expect(llm.chatCompletionStream).not.toHaveBeenCalled();
    expect(appendUser).not.toHaveBeenCalled();
  });

  it('runs as BotBoy\'s own main-chat turn: no owner row, read tools and jobs only; a job it kept going leaves the main chat alone', async () => {
    const { job, key } = limitedJob();
    const llm = model([
      { tools: [{ name: 'jobs', arguments: `{"action":"read","job":"#${job.seq}"}` }] },
      { tools: [{ name: 'jobs', arguments: `{"action":"continue","job":"#${job.seq}"}` }] },
      { text: 'It is still building widgets; I kept it going.' },
    ]);
    const executeTool = vi.fn(async (call: any) => ({ toolCallId: call.id, content: '{"ok":true}' }));
    const mainChatModel = { record: vi.fn() };
    const res = await sendReview(makeApp(llm, { executeTool }, { mainChatModel }), reviewBody(job.id, key, { thinking: 'high' }));
    expect(res.status).toBe(200);
    // BotBoy handled it (owner decision 2026-11-13): no row in the main chat; the job's thread keeps the main chat's words.
    expect(mainRows()).toEqual([]);
    expect(executeTool.mock.calls[0][1]).toMatchObject({ callerKind: 'review', reviewJobId: job.id, currentUserMessage: 'Weekly PV players for Local' });
    expect(executeTool.mock.calls[0][1].jobMandate).toBeUndefined();
    expect(llm.requests[0].tools.map((tool: any) => tool.function.name)).toEqual(['query_db', 'get_analytics_dashboard', 'jobs']);
    expect(promptContexts[0]).toMatchObject({ reviewTurn: true, mainChatTurn: true, jobTurn: false, conversationMode: 'general' });
    // The trigger is BotBoy's words in the model's history, never an owner row.
    expect(appendUser).toHaveBeenCalledWith('sess-test', expect.stringContaining(JOB_UPDATE_TRIGGER_HEADER));
    // Decided: the state is never looked at again, and the owner's model is not overwritten by BotBoy's own turn.
    expect(jobs.get(job.id)).toMatchObject({ reviewedKey: key });
    expect(jobs.get(job.id)!.reviewKey).toBeUndefined();
    expect(mainChatModel.record).not.toHaveBeenCalled();
  });

  // Owner decision 2026-11-10: the main chat decides on a data job with the same detailed dashboard and Data Room rules.
  it('tells the update\'s prompt whether the job it decides on is data work', async () => {
    const { job, key } = limitedJob();
    jobs.markDataWork(job.id);
    const llm = model([{ tools: [{ name: 'jobs', arguments: `{"action":"continue","job":"#${job.seq}"}` }] }, { text: 'Kept it going.' }]);
    const executeTool = vi.fn(async (call: any) => ({ toolCallId: call.id, content: '{"ok":true}' }));
    const res = await sendReview(makeApp(llm, { executeTool }), reviewBody(job.id, key));
    expect(res.status).toBe(200);
    expect(promptContexts[0]).toMatchObject({ reviewTurn: true, jobTurn: false, jobDataWork: true });
  });

  it('an update that leaves a paused job without a decision gets one internal check, then decides (owner report 2026-11-09)', async () => {
    const { job, key } = limitedJob();
    const llm = model([
      { tools: [{ name: 'jobs', arguments: `{"action":"read","job":"#${job.seq}"}` }] },
      { text: 'I am leaving #1 paused for you.' },
      { tools: [{ name: 'jobs', arguments: `{"action":"message","job":"#${job.seq}","text":"Rebuild the weekly widget from the daily table."}` }] },
      { text: 'It was going in circles, so I told #1 to rebuild the weekly widget from the daily table.' },
    ]);
    await sendReview(makeApp(llm, okTool()), reviewBody(job.id, key));
    expect(llm.requests).toHaveLength(4);
    // Reading the job is not a decision: the draft that left it paused is followed by the check, once.
    const checked = llm.requests[2].messages.slice(-2);
    expect(checked[0]).toMatchObject({ role: 'assistant', content: 'I am leaving #1 paused for you.' });
    expect(checked[1].role).toBe('user');
    expect(checked[1].content).toMatch(new RegExp(`^JOB UPDATE CHECK \\(internal.*job #${job.seq} is still paused and you have not decided`));
    expect(checked[1].content).toContain('jobs continue when it was making progress');
    // A message to the job is BotBoy handling it: the main chat gets no row (owner decision 2026-11-13).
    expect(mainRows()).toEqual([]);
    expect(jobs.get(job.id)).toMatchObject({ reviewedKey: key });
  });
  it('a question the main chat leaves to the owner stays in the main chat, with the job\'s card', async () => {
    const { job, key } = limitedJob();
    const llm = model([
      { tools: [{ name: 'jobs', arguments: `{"action":"ask_owner","job":"#${job.seq}","text":"Publish the dashboard to the team?","options":["Publish it","Keep it private"]}` }] },
      { text: 'This one is your call: #1 wants to publish the dashboard to the team.' },
    ]);
    await sendReview(makeApp(llm, okTool()), reviewBody(job.id, key));
    expect(mainRows()).toEqual([{ role: 'assistant', content: `${NOTE}\n\nThis one is your call: #1 wants to publish the dashboard to the team.\n\n[[job:${job.id}:update]]`, ref: job.id }]);
    expect(jobs.get(job.id)).toMatchObject({ reviewedKey: key });
  });

  it('the check comes once; a decision on the first pass, an update about a wait, or a refused decision change nothing else', async () => {
    const { job, key } = limitedJob();
    const stubborn = model([{ text: 'Left it for you.' }]);
    await sendReview(makeApp(stubborn, okTool()), reviewBody(job.id, key));
    expect(stubborn.requests).toHaveLength(2);
    expect(mainRows().at(-1)!.content).toBe(`${NOTE}\n\nLeft it for you.\n\n[[job:${job.id}:update]]`);
    expect(jobs.get(job.id)).toMatchObject({ reviewedKey: key });

    const decided = limitedJob();
    const prompt = model([{ tools: [{ name: 'jobs', arguments: `{"action":"message","job":"#${decided.job.seq}","text":"Split it by week."}` }] }, { text: 'Told it to split the query by week.' }]);
    await sendReview(makeApp(prompt, okTool()), reviewBody(decided.job.id, decided.key));
    expect(prompt.requests).toHaveLength(2);
    expect(JSON.stringify(prompt.requests.map((req: any) => req.messages))).not.toContain('JOB UPDATE CHECK');

    // A job that only waits on its runs may simply wait: it is not a paused state, so there is nothing to check.
    const waiting = jobs.start({ goal: 'Monthly report', title: 'Monthly report' });
    const waitKey = `wait:${jobs.get(waiting.id)!.lastActivityAt}:0`;
    expect(jobs.claimReview(waiting.id, waitKey)).toBe(true);
    const patient = model([{ text: 'Its run is still moving; I let it wait.' }]);
    await sendReview(makeApp(patient, okTool()), reviewBody(waiting.id, waitKey));
    expect(patient.requests).toHaveLength(1);

    // A decision the tool refused is no decision: the check still comes.
    const refusedJob = limitedJob();
    const refusing = { executeTool: vi.fn(async (call: any) => ({ toolCallId: call.id, content: '{"ok":false,"code":"job_not_found"}' })) };
    const retried = model([{ tools: [{ name: 'jobs', arguments: `{"action":"continue","job":"#${refusedJob.job.seq}"}` }] }, { text: 'Kept it going.' }]);
    await sendReview(makeApp(retried, refusing), reviewBody(refusedJob.job.id, refusedJob.key));
    expect(retried.requests).toHaveLength(3);
    expect(retried.requests[2].messages.at(-1).content).toMatch(/^JOB UPDATE CHECK/);
  });

  it('a pause BotBoy made reads as being looked at in the job list until the main chat hands it to the owner', async () => {
    const job = jobs.start({ goal: 'Repair both dashboards', title: 'Repairs' });
    jobs.declare(job.id, 'needs_owner', 'Close with the gaps?', ['Close with the gaps', 'Keep trying']);
    jobs.settle(job.id, { action: 'pause', note: 'Close with the gaps?', kind: 'question' }, 'answered');
    let deciding = true;
    const jobReviews = { nudge: vi.fn(), isReviewing: () => false, awaitsDecision: (jobId: string) => deciding && jobId === job.id };
    const app = makeApp(model([{ text: 'ok' }]), okTool(), { jobReviews });
    const listed = async () => (await request(app).get('/api/chat/jobs')).body.jobs.find((entry: any) => entry.id === job.id);
    expect(await listed()).toMatchObject({ phase: 'working', pauseNote: null, options: [] });
    deciding = false;
    expect(await listed()).toMatchObject({ phase: 'needs_owner', pauseNote: 'Close with the gaps?', options: ['Close with the gaps', 'Keep trying'] });
    // An older runner without the check still shows the question while its turn is not running.
    const legacy = makeApp(model([{ text: 'ok' }]), okTool(), { jobReviews: { nudge: vi.fn(), isReviewing: () => false } });
    expect((await request(legacy).get('/api/chat/jobs')).body.jobs.find((entry: any) => entry.id === job.id)).toMatchObject({ phase: 'needs_owner' });
  });

  it('the job mandate gate refuses a review turn anything outside its read tools and jobs, whatever the model asks', async () => {
    const { job, key } = limitedJob();
    const llm = model([{ tools: [{ name: 'run_command', arguments: '{"command":"ls"}' }] }, { text: 'Left it for you.' }]);
    const base = { executeTool: vi.fn(async (call: any) => ({ toolCallId: call.id, content: '{"ok":true}' })) };
    await sendReview(makeApp(llm, withJobMandate(base as any, { jobs })), reviewBody(job.id, key));
    expect(base.executeTool).not.toHaveBeenCalled();
    const toolMessage = llm.requests[1].messages.find((message: any) => message.role === 'tool');
    expect(JSON.parse(toolMessage.content)).toMatchObject({ status: 'blocked', code: 'outside_job_update' });
  });

  it('the owner\'s message in the main chat stops a running update: it leaves no trace and is decided again later', async () => {
    const { job, key } = limitedJob();
    const gate = deferred();
    const llm = model([{ waitFor: gate.promise, text: 'never shown' }, { text: 'You have two meetings today.' }]);
    const jobReviews = { nudge: vi.fn(), isReviewing: () => false };
    const app = makeApp(llm, okTool(), { jobReviews });
    const reviewing = sendReview(app, reviewBody(job.id, key)).then(response => response);
    await vi.waitFor(() => expect(llm.chatCompletionStream).toHaveBeenCalledTimes(1));
    // While it runs, a second update and a plain Stop leave it alone; the owner's message does not.
    const second = await sendReview(app, reviewBody(job.id, key));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('review_turn_active');
    expect((await request(app).post('/api/chat/stop').send({})).body).toMatchObject({ stopped: 0 });
    const owner = await say(app, 'what is on my calendar?');
    expect(owner.status).toBe(200);
    await reviewing;
    gate.resolve();
    expect(mainRows().map(row => row.content)).toEqual(['what is on my calendar?', 'You have two meetings today.']);
    // Released, not decided: the runner looks at it again after the owner's turn (it is nudged when that turn ends).
    expect(jobs.get(job.id)!.reviewKey).toBeUndefined();
    expect(jobs.get(job.id)!.reviewedKey).toBeUndefined();
    expect(jobReviews.nudge).toHaveBeenCalled();
  });

  it('waits its turn while the owner is talking in the main chat', async () => {
    const { job, key } = limitedJob();
    const gate = deferred();
    const llm = model([{ waitFor: gate.promise, text: 'Your answer.' }]);
    const app = makeApp(llm, okTool());
    const owner = say(app, 'summarize my week').then(response => response);
    await vi.waitFor(() => expect(llm.chatCompletionStream).toHaveBeenCalledTimes(1));
    const refused = await sendReview(app, reviewBody(job.id, key));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('owner_turn_active');
    gate.resolve();
    await owner;
    expect(jobs.get(job.id)).toMatchObject({ reviewKey: key }); // still claimed: the runner releases it (job-review.ts)
  });

  it('an update that fails says so with the job\'s card and counts as decided; a provider or network wait leaves nothing and is due again', async () => {
    const { job, key } = limitedJob();
    const failing = model([{ fail: Object.assign(new Error('provider 500'), { status: 400 }) }]);
    await sendReview(makeApp(failing, okTool()), reviewBody(job.id, key));
    expect(mainRows()).toEqual([{
      role: 'assistant',
      content: `${NOTE}\n\n⚠️ I could not finish looking at this job (provider 500). It stays as it is; reply in #${job.seq} to steer it.\n\n[[job:${job.id}:update]]`,
      ref: job.id,
    }]);
    expect(jobs.get(job.id)).toMatchObject({ reviewedKey: key });

    const other = limitedJob();
    const limited = model([{ fail: Object.assign(new Error('The AI provider is rate-limiting this API key.'), { code: 'LLM_RATE_LIMITED', retryAfterMs: 20_000 }) }]);
    await sendReview(makeApp(limited, okTool()), reviewBody(other.job.id, other.key));
    const offline = limitedJob();
    const unreachable = model([{ fail: Object.assign(new TypeError('fetch failed (ENOTFOUND)'), { cause: { code: 'ENOTFOUND' } }) }]);
    await sendReview(makeApp(unreachable, okTool()), reviewBody(offline.job.id, offline.key));
    expect(mainRows()).toHaveLength(1);
    for (const entry of [other, offline]) {
      expect(jobs.get(entry.job.id)!.reviewKey).toBeUndefined();
      expect(jobs.get(entry.job.id)!.reviewedKey).toBeUndefined();
    }
  });

  it('remembers the model and thinking of the owner\'s main-chat turns only, and nudges the job updates after every turn', async () => {
    const mainChatModel = { record: vi.fn() };
    const jobReviews = { nudge: vi.fn(), isReviewing: () => false };
    const job = jobs.start({ goal: 'g', title: 'Players' });
    const app = makeApp(model([{ text: 'ok' }]), okTool(), { mainChatModel, jobReviews });
    await say(app, 'hello', { thinking: 'high' });
    expect(mainChatModel.record).toHaveBeenCalledTimes(1);
    expect(mainChatModel.record).toHaveBeenCalledWith({ thinking: 'high' });
    await say(app, 'how is it going?', { jobId: job.id, thinking: 'low' });
    expect(mainChatModel.record).toHaveBeenCalledTimes(1);
    expect(jobReviews.nudge).toHaveBeenCalledTimes(2);
  });
});
