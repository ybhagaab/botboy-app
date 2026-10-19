import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { createStorage, type StorageLayer } from '../core/storage.js';
import { createNodeManager } from '../core/node-manager.js';
import { createPromptManager } from '../core/prompt-manager.js';
import { createChatJobStore, type ChatJobStore } from '../core/chat-jobs.js';
import { withJobNotifyChatTools } from '../core/job-notify-chat-tools.js';
import { withJobMandate } from '../core/job-mandate.js';
import type { ToolExecutionContext, ToolExecutor } from '../core/tool-executor.js';
import type { WhatsAppSender } from '../core/whatsapp-send.js';
import type { WhatsAppConnection } from '../core/whatsapp-connection.js';
import { createRouter } from './routes.js';

/**
 * The chat loop around job_notify (docs/maps/job-notify.md): the tool is offered only on turns that ask to be told on WhatsApp (or
 * switch it off), the job's closing words are kept as the report, and a Stop wakes the notifier. Same harness as
 * routes.chat.ui-theme.test.ts, with the real prompt manager and the real job store.
 */
function streamResult(partial: Record<string, unknown>) {
  return { content: '', reasoning: '', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'stop', ...partial };
}

describe('chat loop around job_notify', () => {
  let storage: StorageLayer;
  let db: Database.Database;
  let jobs: ChatJobStore;
  let seen: string[][];
  let contexts: Array<ToolExecutionContext | undefined>;
  let sent: string[];
  const nudge = vi.fn();
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    db = storage.getDb();
    jobs = createChatJobStore(db);
    seen = [];
    contexts = [];
    sent = [];
    nudge.mockReset();
  });
  afterEach(() => storage.close());

  function app(script: (call: number) => { tool?: { name: string; arguments: string }; text: string }, options: { enabled?: boolean; endJobOnUpdate?: string } = {}) {
    const real = createPromptManager();
    const promptManager = {
      getSystemPrompt: (role: any, context: any) => real.getSystemPrompt(role, context),
      getToolDefinitions: (role: any, context: any) => {
        const tools = real.getToolDefinitions(role, context);
        seen.push(tools.map((tool) => tool.function.name));
        return tools;
      },
    };
    let call = 0;
    const llmClient = {
      getActiveEndpoint: () => 'ecs',
      chatCompletionStream: vi.fn((req: any) => {
        call += 1;
        const step = script(call);
        return (async function* () {
          if (step.tool && req.tools?.some((tool: any) => tool.function.name === step.tool!.name)) {
            yield { type: 'tool_call_start', toolCall: { index: 0, id: 'c1', name: step.tool.name } };
            return streamResult({ toolCalls: [{ id: 'c1', type: 'function', function: step.tool }], finishReason: 'tool_calls' });
          }
          yield { type: 'content', text: step.text };
          return streamResult({ content: step.text });
        })();
      }),
    };
    const sender = {
      async contacts() { return []; },
      async self() { return { name: 'Me (You)', number: '6580000001', self: true }; },
      async send(input: any) { sent.push(input.text); return {} as never; },
    } as unknown as WhatsAppSender;
    const connection = {
      settings: () => ({ enabled: false, chatNumber: null }),
      status: async () => ({ chrome: true, tabOpen: true, session: 'signed_in', me: { number: '6580000001', name: 'Me' }, enabled: false, chat: { number: '6580000001', name: 'Me (You)', self: true } }),
      openWindow: async () => true,
    } as unknown as WhatsAppConnection;
    const base: ToolExecutor = {
      executeTool: vi.fn(async (c) => {
        // The real job_update handler ends the job in the middle of the turn (tool-executor.ts); the closing words come after.
        if (c.function.name === 'job_update' && options.endJobOnUpdate) {
          jobs.end(options.endJobOnUpdate, 'done', 'Study complete');
          return { toolCallId: c.id, content: JSON.stringify({ ok: true, job: { id: options.endJobOnUpdate, status: 'done' } }), isError: false };
        }
        return { toolCallId: c.id, content: JSON.stringify({ ok: false, error: `unknown tool ${c.function.name}` }), isError: true };
      }),
    };
    const withNotify = withJobMandate(withJobNotifyChatTools(base, { jobs, sender, connection, notifier: { nudge } }), { jobs });
    const toolExecutor: ToolExecutor = { executeTool: async (c, context) => { contexts.push(context); return withNotify.executeTool(c, context); } };
    const server = express();
    server.use(express.json());
    server.use('/api', createRouter({
      nodeManager: createNodeManager(db),
      db,
      llmClient: llmClient as any,
      toolExecutor,
      chatJobs: jobs,
      ...(options.enabled === false ? {} : { jobNotifyEnabled: true, jobNotifier: { nudge } }),
      chatInterface: { getHistory: () => [], sendMessage: async () => ({ message: { id: 'x', role: 'assistant', content: '' } }) } as any,
      promptManager: promptManager as any,
      conversationManager: {
        getActiveSessionId: () => null, createSession: () => 'sess-test', appendUser: vi.fn(), appendAssistant: vi.fn(), countUserMessages: () => 1,
        getSummary: () => null, getMessages: () => [], getMessagesSinceId: () => [], getRecentMessages: () => [], saveSummary: vi.fn(),
      } as any,
    }));
    return { server, llmClient };
  }
  const say = (server: express.Express, message: string) => request(server).post('/api/chat/messages').send({ message, stream: true });
  const chatTools = () => seen.filter((names) => names.includes('run_command') || names.length > 5);
  const lastReply = () => (db.prepare("SELECT content FROM chat_messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1").get() as any).content as string;
  const ASK = 'start work on this & if it pauses, or any question or stops, send me report on whatsapp please.';

  it('offers the tool, and its guidance, on the owner\'s real request; arming sends one confirmation and turns updates on', async () => {
    const { server, llmClient } = app((call) => (call === 1
      ? { tool: { name: 'job_notify', arguments: '{"action":"on"}' }, text: '' }
      : { text: 'Updates are on. I will message you on WhatsApp.' }));
    await say(server, ASK);
    expect(chatTools()[0]).toContain('job_notify');
    const system = llmClient.chatCompletionStream.mock.calls[0][0].messages[0].content as string;
    expect(system).toContain('## Telling the owner on WhatsApp when a job needs them or ends');
    expect(contexts[0]).toMatchObject({ callerKind: 'interactive' });
    expect(sent).toHaveLength(1);
    expect(sent[0].startsWith('🤖 ')).toBe(true);
    expect(jobs.activeJob()!.notify).toBeDefined();
    // A truthful "updates are on" reply is not flagged by the false-claim gate: no corrective note is appended.
    expect(lastReply()).not.toContain('System note');
  });

  it('does not offer the tool, or its guidance, on an ordinary turn', async () => {
    const { server, llmClient } = app(() => ({ text: 'Your open tasks are in Today.' }));
    await say(server, 'what are my open tasks');
    for (const names of chatTools()) expect(names).not.toContain('job_notify');
    expect(llmClient.chatCompletionStream.mock.calls[0][0].messages[0].content as string).not.toContain('## Telling the owner on WhatsApp');
    expect(jobs.activeJob()).toBeNull();
  });

  it('does not offer the tool when the build has no notifier (nothing could keep the promise)', async () => {
    const { server } = app(() => ({ text: 'ok' }), { enabled: false });
    await say(server, ASK);
    for (const names of chatTools()) expect(names).not.toContain('job_notify');
  });

  it('a model that claims "I\'ve sent" after job_notify was REFUSED is caught by the integrity gate, and the owner is told', async () => {
    // The refused call (an argument the tool does not accept) arms nothing and sends nothing; the reply still claims it did.
    const { server } = app((call) => (call <= 2
      ? { tool: { name: 'job_notify', arguments: '{"action":"on","to":"+6599999999"}' }, text: '' }
      : { text: "I've sent you a WhatsApp confirmation and updates are now on." }));
    await say(server, ASK);
    expect(jobs.activeJob()?.notify).toBeUndefined();
    expect(sent).toEqual([]);
    expect(lastReply()).toContain('System note: no data-modifying tool ran in this turn');
  });

  it('a truthful "I\'ve sent" after job_notify really armed updates gets no corrective note', async () => {
    const { server } = app((call) => (call === 1
      ? { tool: { name: 'job_notify', arguments: '{"action":"on"}' }, text: '' }
      : { text: "I've sent you a WhatsApp confirmation, and updates are on." }));
    await say(server, ASK);
    expect(jobs.activeJob()!.notify).toBeDefined();
    expect(sent).toHaveLength(1);
    expect(lastReply()).not.toContain('System note');
  });

  it('keeps the job\'s closing words as the report (only for a job that asked), and wakes the notifier', async () => {
    const job = jobs.start({ goal: 'Study how customers reach the home screen' });
    jobs.setNotify(job.id, true);
    const { server } = app(() => ({ text: '**The study is complete.**\n\nTop finding: Search Back.' }));
    await say(server, 'any news on the study?');
    expect(jobs.get(job.id)!.lastReply).toBe('**The study is complete.**\n\nTop finding: Search Back.');
    expect(nudge).toHaveBeenCalled();
  });

  it('a job that did not ask keeps no report', async () => {
    const job = jobs.start({ goal: 'quiet job' });
    const { server } = app(() => ({ text: 'Working on it.' }));
    await say(server, 'status?');
    expect(jobs.get(job.id)!.lastReply).toBeUndefined();
  });

  it('the report written after job_update done is kept for the ended job (the finish message waits for it)', async () => {
    const job = jobs.start({ goal: 'g' });
    jobs.setNotify(job.id, true);
    // Progress written earlier in the job; it must not survive the end.
    jobs.recordLastReply(job.id, 'Halfway there.');
    const { server } = app((call) => (call === 1
      ? { tool: { name: 'job_update', arguments: '{"action":"done","summary":"Study complete"}' }, text: '' }
      : { text: 'All done. The answer is in the findings file.' }), { endJobOnUpdate: job.id });
    await say(server, 'wrap up');
    const ended = jobs.get(job.id)!;
    expect(ended.status).toBe('done');
    expect(ended.lastReply).toBe('All done. The answer is in the findings file.');
    expect(ended.lastReply).not.toContain('Halfway');
  });

  it('Stop on the strip wakes the notifier at once for a job that asked to be told; a refused Stop wakes nothing', async () => {
    const job = jobs.start({ goal: 'g' });
    jobs.setNotify(job.id, true);
    const { server: app$ } = app(() => ({ text: 'x' }));
    const server = await new Promise<import('node:http').Server>((resolve) => { const s = app$.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const port = (server.address() as import('node:net').AddressInfo).port;
      const scripted = await request(server).post(`/api/chat/jobs/${job.id}/stop`);
      expect(scripted.status).toBe(403);
      expect(jobs.get(job.id)!.status).toBe('active');
      expect(nudge).not.toHaveBeenCalled();
      const stopped = await request(server).post(`/api/chat/jobs/${job.id}/stop`)
        .set('Origin', `http://127.0.0.1:${port}`).set('Sec-Fetch-Site', 'same-origin');
      expect(stopped.body).toMatchObject({ ok: true, job: { id: job.id, status: 'stopped' } });
      expect(nudge).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
    }
  });

  it('Stop on a job that did not ask to be told wakes nothing', async () => {
    const job = jobs.start({ goal: 'quiet' });
    const { server: app$ } = app(() => ({ text: 'x' }));
    const server = await new Promise<import('node:http').Server>((resolve) => { const s = app$.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const port = (server.address() as import('node:net').AddressInfo).port;
      await request(server).post(`/api/chat/jobs/${job.id}/stop`).set('Origin', `http://127.0.0.1:${port}`).set('Sec-Fetch-Site', 'same-origin');
      expect(jobs.get(job.id)!.status).toBe('stopped');
      expect(nudge).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});
