import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { CHAT_JOB_MAX_CONTINUATIONS, createChatJobStore, type ChatJobStore } from './chat-jobs.js';
import {
  authenticateContinuationRequest,
  buildContinuationTrigger,
  CONTINUATION_HEADER,
  continuationRequestId,
  continuationSecretMatches,
  createChatLiveHub,
  createContinuationBridge,
  createContinuationRunner,
} from './chat-continuations.js';

/**
 * Continuation turns (ANALYTICS_AUTONOMY_PLAN.md D2): only this process can
 * start one (in-memory secret), only for an active job, one at a time, after
 * the owner's own turn, and at most CHAT_JOB_MAX_CONTINUATIONS per job.
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

  function setup(fetchImpl: typeof fetch, options: { turnActive?: () => boolean } = {}) {
    const hub = createChatLiveHub();
    const notes: string[] = [];
    const runner = createContinuationRunner({
      jobs,
      url: 'http://127.0.0.1:7778/api/chat/messages',
      secret: 'secret-1',
      hub,
      isTurnActive: options.turnActive ?? (() => false),
      postNote: text => notes.push(text),
      filesDir: '/h/files',
      fetchImpl,
      // Ticks run only when the test calls them.
      scheduleTick: () => {},
      log: () => {},
    });
    return { runner, hub, notes };
  }

  function finishedRun(jobId: string, runId = '21') {
    jobs.addWatch({ runId, jobId, source: 'run_query' });
    jobs.finishWatch(runId, { remoteStatus: 'SUCCESS', savedTo: `/h/files/etl-results/adhoc_${runId}.tsv`, rowCount: 3 });
  }

  it('starts one streamed turn with the secret, the job model and thinking, and relays its events', async () => {
    const job = jobs.start({ goal: 'goal', modelKey: 'team.sol', thinking: 'high' });
    finishedRun(job.id);
    const fetchImpl = vi.fn(async () => sse([{ type: 'token', text: 'Hi' }, { type: 'done', message: { id: 'asst-1', content: 'Hi' } }]));
    const { runner, hub } = setup(fetchImpl as any);
    const seen: string[] = [];
    hub.subscribe(message => seen.push(message.kind === 'event' ? String(message.event.type) : message.kind));
    runner.request(job.id);
    await runner.tick();
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

  it('waits while any chat turn runs, then continues', async () => {
    const job = jobs.start({ goal: 'goal' });
    finishedRun(job.id);
    let ownerTurn = true;
    const fetchImpl = vi.fn(async () => sse([{ type: 'done', message: { id: 'a', content: 'x' } }]));
    const { runner } = setup(fetchImpl as any, { turnActive: () => ownerTurn });
    runner.request(job.id);
    await runner.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    ownerTurn = false;
    await runner.tick();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('retries after an owner turn the route reported, and drops a job that ended meanwhile', async () => {
    const job = jobs.start({ goal: 'goal' });
    finishedRun(job.id);
    const replies = [
      new Response(JSON.stringify({ code: 'owner_turn_active', error: 'busy' }), { status: 409 }),
      new Response(JSON.stringify({ code: 'job_not_active', error: 'ended' }), { status: 409 }),
    ];
    const fetchImpl = vi.fn(async () => replies.shift()!);
    const { runner, notes } = setup(fetchImpl as any);
    runner.request(job.id);
    await runner.tick();
    expect(jobs.unconsumedFinished(job.id)).toHaveLength(1); // still waiting to be used
    await runner.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(notes).toEqual([]);
    expect(jobs.get(job.id)?.continuationCount).toBe(0);
  });

  it('a refused continuation leaves a visible note instead of silence', async () => {
    const job = jobs.start({ goal: 'goal' });
    finishedRun(job.id);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'Chat needs an AI model first.' }), { status: 409 }));
    const { runner, notes } = setup(fetchImpl as any);
    runner.request(job.id);
    await runner.tick();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('↻ Continued automatically: run 21 finished (3 rows).');
    expect(notes[0]).toContain('Chat needs an AI model first.');
    expect(jobs.unconsumedFinished(job.id)).toEqual([]);
  });

  it('pauses a job after the continuation limit and says so', async () => {
    const job = jobs.start({ goal: 'Build it' });
    for (let index = 0; index < CHAT_JOB_MAX_CONTINUATIONS; index++) jobs.incrementContinuations(job.id);
    finishedRun(job.id);
    const fetchImpl = vi.fn();
    const { runner, notes } = setup(fetchImpl as any);
    runner.request(job.id);
    await runner.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(jobs.get(job.id)?.status).toBe('active');
    expect(jobs.get(job.id)?.pausedAt).toBeTruthy();
    expect(notes[0]).toContain(`after ${CHAT_JOB_MAX_CONTINUATIONS} automatic continuations`);
    // Paused at the limit: later ticks neither run nor repeat the note.
    runner.request(job.id);
    await runner.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(notes).toHaveLength(1);
  });

  it('runs a continuation the job asked for (no finished run), and picks it up after a restart', async () => {
    const job = jobs.start({ goal: 'Build it' });
    jobs.update(job.id, { nextStep: 'Build the widgets' });
    jobs.settle(job.id, { action: 'continue', reason: 'The previous turn said the job continues.' }, 'answered');
    const fetchImpl = vi.fn(async () => sse([{ type: 'done', message: { id: 'asst-2', content: 'ok' } }]));
    const { runner } = setup(fetchImpl as any);
    // No request(): a fresh runner finds the due continuation on the job row.
    await runner.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body);
    expect(body.message).toContain('[Automatic continuation');
    expect(body.message).toContain('Next step you recorded: Build the widgets');
    expect(body.message).toContain('job_update continue, needs_owner, or done');
    expect(body.continuation.note).toBe('↻ Continued automatically: the job\'s next step.');
    expect(jobs.get(job.id)?.continueRequestedAt).toBeUndefined();
    expect(jobs.get(job.id)?.continuationCount).toBe(1);
    await runner.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('an undeclared-end continuation tells the model to declare', async () => {
    const job = jobs.start({ goal: 'Build it' });
    jobs.settle(job.id, { action: 'continue', reason: 'The previous turn ended without saying whether the job is done, needs the owner, or continues.', undeclared: true }, 'answered');
    const fetchImpl = vi.fn(async () => sse([{ type: 'done', message: { id: 'asst-3', content: 'ok' } }]));
    const { runner } = setup(fetchImpl as any);
    runner.request(job.id);
    await runner.tick();
    const body = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body);
    expect(body.message).toContain('Without one, the job pauses.');
  });

  it('a paused job with no finished run starts nothing', async () => {
    const job = jobs.start({ goal: 'Build it' });
    jobs.settle(job.id, { action: 'pause', note: 'Which cohort?' }, 'answered');
    const fetchImpl = vi.fn();
    const { runner } = setup(fetchImpl as any);
    runner.request(job.id);
    await runner.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a forgotten or stopped runner starts nothing', async () => {
    const job = jobs.start({ goal: 'goal' });
    finishedRun(job.id);
    const fetchImpl = vi.fn();
    const { runner } = setup(fetchImpl as any);
    runner.request(job.id);
    runner.forget(job.id);
    await runner.tick();
    runner.stop();
    runner.request(job.id);
    await runner.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('live hub and bridge', () => {
  it('replays the current turn and keeps only structural events past its cap', () => {
    const hub = createChatLiveHub();
    hub.begin({ turnKey: 't1', jobId: 'cj_x', goal: 'g', note: 'n', startedAt: 'now' });
    hub.push({ type: 'status', text: 'Working' });
    hub.push({ type: 'token', text: 'a' });
    expect(hub.current()).toMatchObject({ ended: false, events: [{ type: 'status' }, { type: 'token' }] });
    hub.end();
    expect(hub.current()?.ended).toBe(true);
    hub.push({ type: 'token', text: 'late' });
    expect(hub.current()?.events).toHaveLength(2);
  });

  it('keeps a fresh in-memory secret and reports turns through its probe', () => {
    const bridge = createContinuationBridge();
    expect(bridge.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(createContinuationBridge().secret).not.toBe(bridge.secret);
    expect(bridge.isTurnActive()).toBe(false);
    bridge.bindTurnProbe(() => true);
    expect(bridge.isTurnActive()).toBe(true);
  });
});
