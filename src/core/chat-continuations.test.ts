import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { CHAT_JOB_MAX_CONTINUATIONS, createChatJobStore, JOB_START_REASON, providerWaitMs, type ChatJobStore } from './chat-jobs.js';
import {
  authenticateContinuationRequest,
  buildContinuationTrigger,
  CONTINUATION_HEADER,
  continuationRequestId,
  continuationSecretMatches,
  createChatLiveHub,
  createContinuationBridge,
  createContinuationRunner,
  networkWaitOf,
  providerWaitOf,
} from './chat-continuations.js';

/**
 * Continuation turns (ANALYTICS_AUTONOMY_PLAN.md D2, PARALLEL_JOBS_PLAN.md): only this process can start one (in-memory
 * secret), only for an active job, one turn per job with no cap across jobs, after an owner turn in that job's own thread,
 * waiting in line when a provider says slow down, and at most CHAT_JOB_MAX_CONTINUATIONS in a row per job.
 */
describe('continuation authentication', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
  });
  afterEach(() => storage.close());

  it('is null without the header, refuses a wrong secret or an ended job, and admits the live job', () => {
    const job = jobs.start({ goal: 'goal' });
    const body = { continuation: { jobId: job.id, ordinal: 3, note: '↻ note' } };
    expect(authenticateContinuationRequest({ secret: 's'.repeat(64), header: undefined, body, jobs })).toBeNull();
    expect(authenticateContinuationRequest({ secret: 's'.repeat(64), header: 'x'.repeat(64), body, jobs })).toMatchObject({ ok: false, status: 403 });
    expect(authenticateContinuationRequest({ secret: '', header: '', body, jobs })).toMatchObject({ ok: false, status: 403 });
    expect(authenticateContinuationRequest({ secret: 's'.repeat(64), header: 's'.repeat(64), body, jobs }))
      .toMatchObject({ ok: true, ordinal: 3, note: '↻ note', job: { id: job.id } });
    jobs.end(job.id, 'stopped', 'owner');
    expect(authenticateContinuationRequest({ secret: 's'.repeat(64), header: 's'.repeat(64), body, jobs }))
      .toMatchObject({ ok: false, status: 409, code: 'job_not_active' });
  });

  it('compares secrets in constant time and never matches an empty secret', () => {
    expect(continuationSecretMatches('abc', 'abc')).toBe(true);
    expect(continuationSecretMatches('abc', 'abd')).toBe(false);
    expect(continuationSecretMatches('abc', 'ab')).toBe(false);
    expect(continuationSecretMatches('', '')).toBe(false);
    expect(continuationSecretMatches('abc', undefined)).toBe(false);
  });

  it('continuation request ids are valid owner request ids and differ per turn', () => {
    const id = continuationRequestId('cj_0123456789abcdef01234567', 4);
    expect(id).toBe('cont:cj0123456789abcdef01234567:4');
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
    expect(continuationRequestId('cj_0123456789abcdef01234567', 5)).not.toBe(id);
  });

  it('the trigger marks itself automatic, names each run, and points at the workspace files', () => {
    const job = jobs.start({ goal: 'goal' });
    jobs.addWatch({ runId: '11', jobId: job.id, source: 'run_query', purpose: 'Local weekly' });
    jobs.addWatch({ runId: '12', jobId: job.id, source: 'run_query' });
    jobs.addWatch({ runId: '13', jobId: job.id, source: 'run_query' });
    jobs.finishWatch('11', { remoteStatus: 'SUCCESS', savedTo: '/h/files/etl-results/adhoc_11.tsv', rowCount: 1, columns: ['week', 'players'] });
    jobs.finishWatch('12', { remoteStatus: 'ERROR', error: 'Run 12 ERROR. bad column' });
    const { message, note } = buildContinuationTrigger(job, jobs.unconsumedFinished(job.id), jobs.watchesForJob(job.id), '/h/files');
    expect(message.split('\n')[0]).toBe('[Automatic continuation — not a message from the owner]');
    expect(message).toContain('Run 11 (Local weekly): SUCCESS — 1 row, saved to etl-results/adhoc_11.tsv; columns: week, players.');
    expect(message).toContain('Run 12: ERROR — Run 12 ERROR. bad column.');
    expect(message).toContain('Still running (BotBoy continues again when they finish): 13.');
    expect(message).toContain('Do not ask the owner to check back.');
    expect(note).toBe('↻ Continued automatically: run 11 finished (1 row); run 12 error.');
  });
});

describe('continuation runner', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
  });
  afterEach(() => storage.close());


  function sse(events: Array<Record<string, unknown>>): Response {
    const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  function setup(fetchImpl: typeof fetch, options: {
    ownerTurn?: (jobId: string) => boolean;
    connectionOf?: (modelKey?: string) => string | undefined;
    now?: () => number;
    onPaused?: (jobId: string) => void;
  } = {}) {
    const hub = createChatLiveHub();
    const notes: Array<{ jobId: string; text: string }> = [];
    const runner = createContinuationRunner({
      jobs,
      url: 'http://127.0.0.1:7778/api/chat/messages',
      secret: 'secret-1',
      hub,
      isOwnerTurnActive: options.ownerTurn ?? (() => false),
      ...(options.connectionOf ? { connectionOf: options.connectionOf } : {}),
      ...(options.onPaused ? { onPaused: options.onPaused } : {}),
      postNote: (jobId, text) => notes.push({ jobId, text }),
      filesDir: '/h/files',
      fetchImpl,
      // Ticks run only when the test calls them.
      scheduleTick: () => {},
      log: () => {},
      ...(options.now ? { now: options.now } : {}),
    });
    /** One scan, then every turn it launched runs to its end. */
    const settle = async () => { await runner.tick(); await runner.idle(); };
    return { runner, hub, notes, settle };
  }

  function finishedRun(jobId: string, runId = '21') {
    jobs.addWatch({ runId, jobId, source: 'run_query' });
    jobs.finishWatch(runId, { remoteStatus: 'SUCCESS', savedTo: `/h/files/etl-results/adhoc_${runId}.tsv`, rowCount: 3 });
  }

  /** A fetch whose streams stay open until the test releases them (a turn that is still running). */
  function heldFetch() {
    const releases: Array<() => void> = [];
    const fetchImpl = vi.fn(async () => {
      let close: () => void = () => {};
      const stream = new ReadableStream({ start(controller) { close = () => controller.close(); } });
      releases.push(() => close());
      return new Response(stream, { status: 200 });
    });
    return { fetchImpl, releaseAll: () => { while (releases.length) releases.shift()!(); } };
  }

  it('starts one streamed turn with the secret, the job model and thinking, and relays its events', async () => {
    const job = jobs.start({ goal: 'goal', modelKey: 'team.sol', thinking: 'high' });
    finishedRun(job.id);
    const fetchImpl = vi.fn(async () => sse([{ type: 'token', text: 'Hi' }, { type: 'done', message: { id: 'asst-1', content: 'Hi' } }]));
    const { runner, hub, settle } = setup(fetchImpl as any);
    const seen: string[] = [];
    hub.subscribe(message => seen.push(message.kind === 'event' ? String(message.event.type) : message.kind));
    runner.request(job.id);
    await settle();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:7778/api/chat/messages');
    expect((init.headers as Record<string, string>)[CONTINUATION_HEADER]).toBe('secret-1');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ stream: true, model: 'team.sol', thinking: 'high', continuation: { jobId: job.id, ordinal: 1 } });
    expect(body.message).toContain('[Automatic continuation');
    expect(seen).toEqual(['begin', 'token', 'done', 'end']);
    expect(jobs.unconsumedFinished(job.id)).toEqual([]);
    expect(jobs.get(job.id)?.continuationCount).toBe(1);
  });

  it('runs every due job at once (PJ2: no cap across jobs), one turn per job, each live in the hub with its number', async () => {
    const a = jobs.start({ goal: 'first' });
    const b = jobs.start({ goal: 'second' });
    const c = jobs.start({ goal: 'third' });
    finishedRun(a.id, '31');
    finishedRun(b.id, '32');
    jobs.requestTurn(c.id, 'handed off');
    const { fetchImpl, releaseAll } = heldFetch();
    const { runner, hub } = setup(fetchImpl as any);
    await runner.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(hub.current().map(turn => turn.info.seq).sort()).toEqual([1, 2, 3]));
    expect(runner.running().map(turn => turn.jobId).sort()).toEqual([a.id, b.id, c.id].sort());
    // A second scan while they run starts nothing more: one turn per job.
    jobs.requestTurn(a.id, 'again');
    await runner.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    releaseAll();
    await runner.idle();
    expect(hub.current()).toEqual([]);
    expect(runner.isRunning(a.id)).toBe(false);
  });

  it('an owner turn in a job\'s own thread holds only that job; the others run', async () => {
    const a = jobs.start({ goal: 'first' });
    const b = jobs.start({ goal: 'second' });
    finishedRun(a.id, '41');
    finishedRun(b.id, '42');
    let ownerInA = true;
    const fetchImpl = vi.fn(async () => sse([{ type: 'done', message: { id: 'x', content: 'x' } }]));
    const { settle } = setup(fetchImpl as any, { ownerTurn: (jobId) => ownerInA && jobId === a.id });
    await settle();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse((fetchImpl.mock.calls[0] as any)[1].body).continuation.jobId).toBe(b.id);
    ownerInA = false;
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchImpl.mock.calls[1] as any)[1].body).continuation.jobId).toBe(a.id);
  });

  it('retries after an owner turn the route reported, and drops a job that ended meanwhile', async () => {
    const job = jobs.start({ goal: 'goal' });
    finishedRun(job.id);
    const replies = [
      new Response(JSON.stringify({ code: 'owner_turn_active', error: 'busy' }), { status: 409 }),
      new Response(JSON.stringify({ code: 'job_not_active', error: 'ended' }), { status: 409 }),
    ];
    const fetchImpl = vi.fn(async () => replies.shift()!);
    const { notes, settle } = setup(fetchImpl as any);
    await settle();
    expect(jobs.unconsumedFinished(job.id)).toHaveLength(1); // still waiting to be used
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(notes).toEqual([]);
    expect(jobs.get(job.id)?.continuationCount).toBe(0);
  });

  it('a refused continuation leaves a visible note in the job\'s own thread instead of silence', async () => {
    const job = jobs.start({ goal: 'goal' });
    finishedRun(job.id);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'Chat needs an AI model first.' }), { status: 409 }));
    const { notes, settle } = setup(fetchImpl as any);
    await settle();
    expect(notes).toHaveLength(1);
    expect(notes[0].jobId).toBe(job.id);
    expect(notes[0].text).toContain('↻ Continued automatically: run 21 finished (3 rows).');
    expect(notes[0].text).toContain('Chat needs an AI model first.');
    expect(jobs.unconsumedFinished(job.id)).toEqual([]);
  });

  it('pauses a job at BotBoy\'s turn limit as the limit\'s (not the owner\'s), says so in its thread, and tells the main chat', async () => {
    const job = jobs.start({ goal: 'Build it' });
    for (let index = 0; index < CHAT_JOB_MAX_CONTINUATIONS; index++) jobs.incrementContinuations(job.id);
    finishedRun(job.id);
    const fetchImpl = vi.fn();
    const paused: string[] = [];
    const { runner, notes, settle } = setup(fetchImpl as any, { onPaused: (jobId) => { paused.push(jobId); } });
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(jobs.get(job.id)?.status).toBe('active');
    expect(jobs.get(job.id)).toMatchObject({
      pausedAt: expect.any(String), pauseKind: 'limit',
      pauseNote: `Paused after ${CHAT_JOB_MAX_CONTINUATIONS} automatic turns in a row. Reply to continue.`,
    });
    expect(notes).toEqual([{ jobId: job.id, text: `↻ I paused this job after ${CHAT_JOB_MAX_CONTINUATIONS} automatic turns in a row. The main chat looks at it next; you can also reply here to continue.` }]);
    expect(paused).toEqual([job.id]);
    // Paused at the limit: later ticks neither run nor repeat the note.
    runner.request(job.id);
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(notes).toHaveLength(1);
    expect(paused).toEqual([job.id]);
    // A failing onPaused never undoes the pause.
    const second = jobs.start({ goal: 'Again' });
    for (let index = 0; index < CHAT_JOB_MAX_CONTINUATIONS; index++) jobs.incrementContinuations(second.id);
    finishedRun(second.id, '22');
    await setup(fetchImpl as any, { onPaused: () => { throw new Error('no review'); } }).settle();
    expect(jobs.get(second.id)).toMatchObject({ pauseKind: 'limit' });
  });

  it('runs a continuation the job asked for (no finished run), and picks it up after a restart', async () => {
    const job = jobs.start({ goal: 'Build it' });
    jobs.update(job.id, { nextStep: 'Build the widgets' });
    jobs.settle(job.id, { action: 'continue', reason: 'The previous turn said the job continues.' }, 'answered');
    const fetchImpl = vi.fn(async () => sse([{ type: 'done', message: { id: 'asst-2', content: 'ok' } }]));
    const { settle } = setup(fetchImpl as any);
    // No request(): a fresh runner finds the due continuation on the job row.
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body);
    expect(body.message).toContain('[Automatic continuation');
    expect(body.message).toContain('Next step you recorded: Build the widgets');
    expect(body.message).toContain('job_update continue, wait, needs_owner, or done');
    expect(body.continuation.note).toBe('↻ Continued automatically: the job\'s next step.');
    expect(jobs.get(job.id)?.continueRequestedAt).toBeUndefined();
    expect(jobs.get(job.id)?.continuationCount).toBe(1);
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a handed-off job\'s first turn is told it starts the work in its own thread', async () => {
    const job = jobs.start({ goal: 'Study Local offline usage', title: 'Local offline study' });
    jobs.requestTurn(job.id, JOB_START_REASON);
    const fetchImpl = vi.fn(async () => sse([{ type: 'done', message: { id: 'a', content: 'ok' } }]));
    const { settle } = setup(fetchImpl as any);
    await settle();
    const body = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body);
    expect(body.message).toContain(`job #${job.seq}, "Local offline study"`);
    expect(body.message).toContain('"Study Local offline usage"');
    expect(body.message).toContain('first turn, in its own thread');
    expect(body.continuation.note).toBe('▶ Started from your request.');
  });

  it('an undeclared-end continuation tells the model to declare', async () => {
    const job = jobs.start({ goal: 'Build it' });
    jobs.settle(job.id, { action: 'continue', reason: 'The previous turn ended without saying whether the job is done, needs the owner, or continues.', undeclared: true }, 'answered');
    const fetchImpl = vi.fn(async () => sse([{ type: 'done', message: { id: 'asst-3', content: 'ok' } }]));
    const { settle } = setup(fetchImpl as any);
    await settle();
    const body = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body);
    expect(body.message).toContain('Without one, the job pauses.');
  });

  it('a paused job with no finished run starts nothing', async () => {
    const job = jobs.start({ goal: 'Build it' });
    jobs.settle(job.id, { action: 'pause', note: 'Which cohort?' }, 'answered');
    const fetchImpl = vi.fn();
    const { runner, settle } = setup(fetchImpl as any);
    runner.request(job.id);
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a forgotten or stopped runner starts nothing', async () => {
    const job = jobs.start({ goal: 'goal' });
    jobs.addWatch({ runId: '51', jobId: job.id, source: 'run_query' }); // pending: only a request() would start it
    const fetchImpl = vi.fn();
    const { runner, settle } = setup(fetchImpl as any);
    runner.request(job.id);
    runner.forget(job.id);
    await settle();
    runner.stop();
    finishedRun(job.id, '52');
    runner.request(job.id);
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('provider wait-in-line (PJ2: jobs wait their turn when a provider says slow down)', () => {
    it('a limited connection holds its jobs until the cool-down ends; jobs on other connections keep running', async () => {
      let clock = 1_000_000;
      const a = jobs.start({ goal: 'on team', modelKey: 'team.sol' });
      const b = jobs.start({ goal: 'on claude', modelKey: 'anthropic.sonnet' });
      jobs.requestTurn(a.id, 'go');
      jobs.requestTurn(b.id, 'go');
      const fetchImpl = vi.fn(async () => sse([{ type: 'done', message: { id: 'x', content: 'x' } }]));
      const { runner, settle } = setup(fetchImpl as any, {
        connectionOf: (key) => (key?.startsWith('anthropic.') ? 'anthropic' : 'team'),
        now: () => clock,
      });
      const until = runner.providerLimited('team', 45_000);
      expect(Date.parse(until)).toBe(clock + 45_000);
      expect(runner.providerReadyAt('team')).toBe(clock + 45_000);
      await settle();
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(JSON.parse((fetchImpl.mock.calls[0] as any)[1].body).continuation.jobId).toBe(b.id);
      clock += 45_001;
      await settle();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(JSON.parse((fetchImpl.mock.calls[1] as any)[1].body).continuation.jobId).toBe(a.id);
    });

    it('after the cool-down, the connection starts one job at a time until a turn finishes cleanly', async () => {
      let clock = 2_000_000;
      const ids = [1, 2, 3].map(n => jobs.start({ goal: `job ${n}` }).id);
      for (const id of ids) jobs.requestTurn(id, 'go');
      const { fetchImpl, releaseAll } = heldFetch();
      const { runner } = setup(fetchImpl as any, { connectionOf: () => 'team', now: () => clock });
      runner.providerLimited('team');
      clock += 31_000; // past the first strike's 30 s back-off
      await runner.tick();
      expect(fetchImpl).toHaveBeenCalledOnce();
      await runner.tick();
      expect(fetchImpl).toHaveBeenCalledOnce(); // still one in flight on the limited connection
      // The provider answered that turn: the line is released and every waiting job may start.
      runner.providerClear('team');
      await runner.tick();
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      releaseAll();
      await runner.idle();
    });

    it('back-off grows per strike, a burst of limits is one strike, and the provider\'s own wait wins when longer', () => {
      let clock = 3_000_000;
      const { runner } = setup(vi.fn() as any, { now: () => clock });
      expect(Date.parse(runner.providerLimited('team'))).toBe(clock + 30_000);
      clock += 1_000; // same burst: still the first strike's 30 s, counted from this latest limit
      expect(Date.parse(runner.providerLimited('team'))).toBe(clock + 30_000);
      clock += 10_000;
      expect(Date.parse(runner.providerLimited('team'))).toBe(clock + 60_000);
      clock += 10_000;
      expect(Date.parse(runner.providerLimited('team', 600_000))).toBe(clock + 600_000);
      runner.providerClear('team');
      expect(runner.providerReadyAt('team')).toBe(0);
      expect(providerWaitMs(10)).toBe(8 * 60_000);
    });

    it('a job\'s own wait (kept on its row) holds it across restarts until the time passes', async () => {
      let clock = Date.parse('2026-10-28T10:00:00.000Z');
      const job = jobs.start({ goal: 'g' });
      jobs.settle(job.id, { action: 'continue', reason: 'slow down', notBefore: '2026-10-28T10:01:00.000Z' }, 'rate_limited');
      const fetchImpl = vi.fn(async () => sse([{ type: 'done', message: { id: 'x', content: 'x' } }]));
      const { settle } = setup(fetchImpl as any, { now: () => clock });
      await settle();
      expect(fetchImpl).not.toHaveBeenCalled();
      clock = Date.parse('2026-10-28T10:01:01.000Z');
      await settle();
      expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it('reads a provider limit from the typed errors and the gateway\'s words, never a spent quota', () => {
      expect(providerWaitOf({ code: 'LLM_RATE_LIMITED', retryAfterMs: 12_000 })).toEqual({ retryAfterMs: 12_000 });
      expect(providerWaitOf({ code: 'LLM_PROVIDER_OVERLOADED' })).toEqual({});
      expect(providerWaitOf(new Error('429 — retryable'))).toEqual({});
      expect(providerWaitOf(new Error('HTTP 429: Too Many Requests'))).toEqual({});
      expect(providerWaitOf({ code: 'LLM_QUOTA_EXHAUSTED', message: 'rate limit' })).toBeNull();
      expect(providerWaitOf(new Error('HTTP 500: internal error'))).toBeNull();
    });

    it('reads a network outage from Node\'s and undici\'s errors, and nothing the provider answered (owner approval 2026-10-29)', () => {
      expect(networkWaitOf(new TypeError('fetch failed (ENOTFOUND)'))).toBe(true);
      expect(networkWaitOf(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe(true);
      expect(networkWaitOf(Object.assign(new Error('terminated'), { cause: { cause: { code: 'UND_ERR_SOCKET' } } }))).toBe(true);
      expect(networkWaitOf({ code: 'EAI_AGAIN', message: 'getaddrinfo EAI_AGAIN api.example.com' })).toBe(true);
      expect(networkWaitOf(new Error('socket hang up'))).toBe(true);
      expect(networkWaitOf(new Error('connect EHOSTUNREACH 10.0.0.1:443'))).toBe(true);
      expect(networkWaitOf(new Error('HTTP 500: internal error'))).toBe(false);
      expect(networkWaitOf(new Error('HTTP 400: {"error":{"message":"Payload size of 9 MB exceeds the allowed limit"}}'))).toBe(false);
      expect(networkWaitOf({ code: 'LLM_RATE_LIMITED' })).toBe(false);
      expect(networkWaitOf(new Error('The model refused: fetch failed is not a thing'))).toBe(false);
      expect(networkWaitOf(undefined)).toBe(false);
    });

    it('a network wait is logged as one, and backs off like a provider limit', () => {
      const logs: string[] = [];
      let t = Date.parse('2026-10-29T08:09:35.000Z');
      const runner = createContinuationRunner({
        jobs,
        url: 'http://127.0.0.1:7778/api/chat/messages',
        secret: 'secret-1',
        hub: createChatLiveHub(),
        isOwnerTurnActive: () => false,
        postNote: () => {},
        filesDir: '/h/files',
        fetchImpl: vi.fn() as any,
        scheduleTick: () => {},
        log: (line: string) => { logs.push(line); },
        now: () => t,
      });
      const first = runner.providerLimited('team', undefined, 'network');
      expect(first).toBe('2026-10-29T08:10:05.000Z'); // 30 s
      t += 31_000;
      expect(runner.providerLimited('team', undefined, 'network')).toBe('2026-10-29T08:11:06.000Z'); // 60 s
      expect(logs.at(-1)).toContain('could not reach the AI model behind team (network)');
      runner.providerLimited('team', 20_000);
      expect(logs.at(-1)).toContain('asked BotBoy to slow down');
    });
  });
});

describe('live hub and bridge', () => {
  it('replays every running turn and keeps only structural events past its cap', () => {
    const hub = createChatLiveHub();
    hub.begin({ turnKey: 't1', jobId: 'cj_x', seq: 1, title: 'X', goal: 'g', note: 'n', startedAt: 'now' });
    hub.begin({ turnKey: 't2', jobId: 'cj_y', seq: 2, title: 'Y', goal: 'g', note: 'n', startedAt: 'now' });
    hub.push('t1', { type: 'status', text: 'Working' });
    hub.push('t1', { type: 'token', text: 'a' });
    hub.push('t2', { type: 'token', text: 'b' });
    expect(hub.current().map(turn => [turn.info.turnKey, turn.events.length])).toEqual([['t1', 2], ['t2', 1]]);
    hub.end('t1');
    expect(hub.current().map(turn => turn.info.turnKey)).toEqual(['t2']);
    hub.push('t1', { type: 'token', text: 'late' }); // an ended turn takes nothing
    hub.end('t2');
    expect(hub.current()).toEqual([]);
  });

  it('keeps a fresh in-memory secret and answers per thread through its probe', () => {
    const bridge = createContinuationBridge();
    expect(bridge.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(createContinuationBridge().secret).not.toBe(bridge.secret);
    expect(bridge.isTurnActive()).toBe(false);
    expect(bridge.isOwnerTurnActive('cj_a')).toBe(false);
    bridge.bindTurnProbe({ any: () => true, mainOwnerTurn: () => false, ownerTurnInJob: (jobId) => jobId === 'cj_a' });
    expect(bridge.isTurnActive()).toBe(true);
    expect(bridge.isMainTurnActive()).toBe(false);
    expect(bridge.isOwnerTurnActive('cj_a')).toBe(true);
    expect(bridge.isOwnerTurnActive('cj_b')).toBe(false);
  });
});
