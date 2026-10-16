/**
 * A job that paused for the owner's decision on a Knowledge card goes on once the decision is made
 * (knowledge-job-wake.ts, docs/maps/knowledge-library.md K21).
 *
 * Owner report 2026-10-16: the chat strip kept saying "Paused: review the revised proposal in Settings, needs you" after the
 * owner had applied that very proposal. Nothing connected the click on the Settings page to the job. These tests build the
 * real stores on in-memory SQLite and put the clock under test control, so each case is a timeline: the job starts, a card is
 * staged, the job pauses, the owner decides.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatJobStore, type ChatJob, type ChatJobStore } from './chat-jobs.js';
import { buildSelfContinuationTrigger } from './chat-continuations.js';
import { createKnowledgeChangeStore, type KnowledgeChangeStore, type NewChange } from './knowledge-changes.js';
import { DECISION_SEPARATOR, createKnowledgeJobWaker, decisionsForPausedJob, describeChange } from './knowledge-job-wake.js';
import { createStorage, type StorageLayer } from './storage.js';

let storage: StorageLayer;
let jobs: ChatJobStore;
let changes: KnowledgeChangeStore;
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 16, 4, 0, 0) + minutes * 60_000);
const clockAt = (minutes: number) => vi.setSystemTime(at(minutes));

const plan = { mode: 'create' as const, set: 'ott', file: null, files: [{ path: 'ott/GUIDE.md', before: null, after: '# OTT\n' }], summary: 'create the set' };
const stage = (over: Partial<NewChange> = {}): string => changes.insert({
  setName: 'analytics/ott-discovery-cx-analysis-methodology', kind: 'create_set', mode: 'create', file: null, plan, baseSha256: null, rulesSha256: 'b'.repeat(64),
  diffText: '+x', why: 'the methodology', trigger: 'owner_request', origin: 'botboy_proposal', sources: ['files and commands'], candidateSha256: 'c'.repeat(64), status: 'staged', ...over,
}).id;
const pause = (job: ChatJob, note = 'Please review the revised proposal in Settings → Knowledge.') => jobs.settle(job.id, { action: 'pause', note }, 'answered')!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clockAt(0);
  storage = createStorage(':memory:');
  storage.initialize();
  jobs = createChatJobStore(storage.getDb());
  changes = createKnowledgeChangeStore(storage.getDb(), { now: () => Date.now() });
});
afterEach(() => {
  storage.close();
  vi.useRealTimers();
});

/** The owner's story: the job starts, BotBoy stages a card and pauses, the owner decides on the Settings page. */
function pausedJobWithCard() {
  const job = jobs.start({ goal: 'Rethink the proposed OTT study Knowledge' });
  clockAt(2);
  const changeId = stage();
  clockAt(3);
  const paused = pause(job);
  return { job: paused, changeId };
}

describe('waking a job once the card it waited on is decided', () => {
  it('applying the card wakes the paused job: the pause is cleared and a continuation is due, with the decision as its reason', () => {
    const { job, changeId } = pausedJobWithCard();
    expect(job.pausedAt).toBeTruthy();
    expect(decisionsForPausedJob(jobs.activeJob(), changes)).toBeNull(); // still waiting: nothing to do yet
    clockAt(10);
    changes.update(changeId, { status: 'applied' });
    const request = vi.fn();
    const found = createKnowledgeJobWaker({ jobs, changes, request, log: () => undefined }).wakeIfDecided();
    expect(found).toMatchObject({ jobId: job.id, applied: ['Create the set analytics/ott-discovery-cx-analysis-methodology'], dismissed: [] });
    const woken = jobs.get(job.id)!;
    expect(woken.pausedAt).toBeUndefined();
    expect(woken.pauseNote).toBeUndefined();
    expect(woken.continueRequestedAt).toBeTruthy();
    expect(woken.continueReason).toContain('The owner applied "Create the set analytics/ott-discovery-cx-analysis-methodology", which this job was waiting on.');
    expect(woken.continueReason).toContain('Settings → Knowledge → History has the diff and an Undo');
    expect(request).toHaveBeenCalledExactlyOnceWith(job.id);
  });

  it('is idempotent: once woken, the same state wakes nothing again (the click and the boot check can both run)', () => {
    const { changeId } = pausedJobWithCard();
    clockAt(10);
    changes.update(changeId, { status: 'applied' });
    const request = vi.fn();
    const waker = createKnowledgeJobWaker({ jobs, changes, request, log: () => undefined });
    expect(waker.wakeIfDecided()).not.toBeNull();
    expect(waker.wakeIfDecided()).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('dismissing the card wakes it too, and says nothing was written', () => {
    const { job, changeId } = pausedJobWithCard();
    clockAt(10);
    changes.update(changeId, { status: 'dismissed' });
    const found = decisionsForPausedJob(jobs.activeJob(), changes)!;
    expect(found).toMatchObject({ jobId: job.id, applied: [], dismissed: ['Create the set analytics/ott-discovery-cx-analysis-methodology'] });
    expect(found.reason).toContain('The owner dismissed "Create the set analytics/ott-discovery-cx-analysis-methodology", which this job was waiting on.');
    expect(found.reason).toContain('Dismissed changes wrote nothing.');
  });

  it('waits for the LAST open card of the job: one wake-up, naming both decisions', () => {
    const job = jobs.start({ goal: 'Rework the Knowledge' });
    clockAt(2);
    const first = stage();
    clockAt(3);
    const second = stage({ kind: 'write', mode: 'edit', file: 'methods.md', setName: 'ott' });
    clockAt(4);
    pause(job);
    clockAt(10);
    changes.update(first, { status: 'dismissed' });
    expect(decisionsForPausedJob(jobs.activeJob(), changes)).toBeNull(); // the second still waits
    clockAt(11);
    changes.update(second, { status: 'applied' });
    const found = decisionsForPausedJob(jobs.activeJob(), changes)!;
    expect(found.applied).toEqual(['Edit methods.md in ott']);
    expect(found.dismissed).toEqual(['Create the set analytics/ott-discovery-cx-analysis-methodology']);
    expect(found.reason.split(DECISION_SEPARATOR)[0]).toBe('The owner decided on the Knowledge changes this job was waiting on: applied "Edit methods.md in ott", dismissed "Create the set analytics/ott-discovery-cx-analysis-methodology".');
  });

  it('a held or stale card of the job is still open, so it does not wake', () => {
    const job = jobs.start({ goal: 'g' });
    clockAt(1);
    const held = stage({ status: 'held' });
    clockAt(2);
    const applied = stage({ file: 'a.md', kind: 'write', mode: 'edit' });
    clockAt(3);
    pause(job);
    clockAt(5);
    changes.update(applied, { status: 'applied' });
    expect(decisionsForPausedJob(jobs.activeJob(), changes)).toBeNull();
    clockAt(6);
    changes.update(held, { status: 'dismissed' });
    expect(decisionsForPausedJob(jobs.activeJob(), changes)).not.toBeNull();
  });

  it('a decision stamped at the very instant of the pause still counts, so equal timestamps never lose the wake-up', () => {
    const job = jobs.start({ goal: 'g' });
    clockAt(2);
    const changeId = stage();
    clockAt(3);
    pause(job);
    changes.update(changeId, { status: 'applied' }); // the same clock reading as the pause
    expect(decisionsForPausedJob(jobs.activeJob(), changes)).not.toBeNull();
  });

  it('counts the other cards that still wait, from before the job, and does not let them block the wake', () => {
    clockAt(-60);
    stage(); // an old proposal from an earlier conversation, still waiting
    clockAt(0);
    const job = jobs.start({ goal: 'g' });
    clockAt(2);
    const changeId = stage();
    clockAt(3);
    pause(job);
    clockAt(10);
    changes.update(changeId, { status: 'applied' });
    const found = decisionsForPausedJob(jobs.activeJob(), changes)!;
    expect(found.reason).toContain('1 other Knowledge change still waits for the owner.');
  });
});

describe('what must NOT wake a job', () => {
  it('a card from before the job began, a card staged after it paused, and a card decided before it paused', () => {
    clockAt(-30);
    const before = stage();
    clockAt(0);
    const job = jobs.start({ goal: 'g' });
    clockAt(1);
    const decidedEarly = stage({ file: 'early.md', kind: 'write', mode: 'edit' });
    clockAt(2);
    changes.update(decidedEarly, { status: 'applied' }); // decided while the job still ran
    clockAt(3);
    pause(job, 'Which quarter should the study cover?');
    clockAt(4);
    const after = stage({ file: 'later.md', kind: 'write', mode: 'edit' });
    clockAt(10);
    changes.update(before, { status: 'applied' });
    changes.update(after, { status: 'applied' });
    expect(decisionsForPausedJob(jobs.activeJob(), changes)).toBeNull();
    expect(jobs.get(job.id)!.pausedAt).toBeTruthy();
  });

  it('a job that is running, one whose continuation is already due, an ended job, and no job at all', () => {
    const job = jobs.start({ goal: 'g' });
    clockAt(1);
    const changeId = stage();
    clockAt(5);
    changes.update(changeId, { status: 'applied' });
    expect(decisionsForPausedJob(jobs.activeJob(), changes)).toBeNull(); // not paused: its own turn will see the state
    clockAt(2);
    jobs.settle(job.id, { action: 'continue', reason: 'More to do.' }, 'answered');
    expect(decisionsForPausedJob(jobs.get(job.id), changes)).toBeNull(); // a continuation is already due
    jobs.end(job.id, 'done', 'finished');
    expect(decisionsForPausedJob(jobs.get(job.id), changes)).toBeNull();
    expect(decisionsForPausedJob(null, changes)).toBeNull();
  });

  it('missing stores wake nothing and never throw, and a failing runner does not undo the wake', () => {
    expect(createKnowledgeJobWaker({ jobs: undefined, changes }).wakeIfDecided()).toBeNull();
    expect(createKnowledgeJobWaker({ jobs, changes: undefined }).wakeIfDecided()).toBeNull();
    const { job, changeId } = pausedJobWithCard();
    clockAt(10);
    changes.update(changeId, { status: 'applied' });
    const logged: string[] = [];
    const found = createKnowledgeJobWaker({ jobs, changes, request: () => { throw new Error('runner stopped'); }, log: (line) => logged.push(line) }).wakeIfDecided();
    expect(found).not.toBeNull();
    expect(jobs.get(job.id)!.continueRequestedAt).toBeTruthy(); // the runner's own interval finds it
    // A second paused job, so the check reaches the store (a job with a continuation already due returns before it reads anything).
    jobs.end(job.id, 'done', 'finished');
    const second = jobs.start({ goal: 'a second job' });
    clockAt(12);
    pause(second);
    const broken = { ...changes, list: () => { throw new Error('db closed'); } } as unknown as KnowledgeChangeStore;
    expect(createKnowledgeJobWaker({ jobs, changes: broken, log: (line) => logged.push(line) }).wakeIfDecided()).toBeNull();
    expect(logged.some((line) => line.includes('db closed'))).toBe(true);
  });
});

describe('the store method and the turn it starts', () => {
  it('wake clears the pause and makes a continuation due, only for an active job that is paused with nothing due', () => {
    const job = jobs.start({ goal: 'g' });
    expect(jobs.wake(job.id, 'x')).toBeNull(); // not paused
    pause(job, 'Review it.');
    const woken = jobs.wake(job.id, 'The owner applied it.')!;
    expect(woken).toMatchObject({ id: job.id, continueReason: 'The owner applied it.' });
    expect(woken.pausedAt).toBeUndefined();
    expect(woken.continueRequestedAt).toBeTruthy();
    expect(jobs.wake(job.id, 'again')).toBeNull(); // already due
    jobs.end(job.id, 'done', 'finished');
    expect(jobs.wake(job.id, 'late')).toBeNull();
  });

  it('describes a change the way the card names it', () => {
    expect(describeChange({ kind: 'create_set', setName: 'ott', file: null, mode: 'create' })).toBe('Create the set ott');
    expect(describeChange({ kind: 'write', setName: 'ott', file: 'a.md', mode: 'append' })).toBe('Add to a.md in ott');
    expect(describeChange({ kind: 'write', setName: 'ott', file: 'a.md', mode: 'edit' })).toBe('Edit a.md in ott');
  });

  it('the continuation turn is told the decision is in, shows the owner what happened, and never sees the separator', () => {
    const { job, changeId } = pausedJobWithCard();
    clockAt(10);
    changes.update(changeId, { status: 'applied' });
    const reason = decisionsForPausedJob(jobs.activeJob(), changes)!.reason;
    const trigger = buildSelfContinuationTrigger(jobs.get(job.id)!, reason, []);
    expect(trigger.note).toBe('↻ Continued automatically: you applied "Create the set analytics/ott-discovery-cx-analysis-methodology", which this job was waiting on.');
    expect(trigger.message).toContain('Why this turn started: The owner applied "Create the set analytics/ott-discovery-cx-analysis-methodology", which this job was waiting on. Applied changes are saved');
    expect(trigger.message).not.toContain(DECISION_SEPARATOR);
    expect(trigger.message).toContain('The decision the job waited for is in.');
    expect(trigger.message).toContain('job_update: done when the deliverable is finished');
    // Any other reason keeps the generic turn, unchanged.
    const generic = buildSelfContinuationTrigger(jobs.get(job.id)!, 'The previous turn reached the per-turn tool limit.', []);
    expect(generic.note).toBe('↻ Continued automatically: the job\'s next step.');
    expect(generic.message).toContain('Continue the job from where it stands');
    expect(generic.message).not.toContain('The decision the job waited for is in.');
  });
});

describe('wiring in index.ts', () => {
  it('builds the waker over the real stores, gives it to the Knowledge routes, and checks once at boot after the continuation runner starts', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf8');
    expect(source).toContain('createKnowledgeJobWaker({ jobs: chatJobs, changes: knowledgeChanges, request: (jobId) => continuationRunner.request(jobId) })');
    const started = source.indexOf('continuationRunner.start();');
    const boot = source.indexOf('knowledgeJobWaker.wakeIfDecided();');
    expect(started).toBeGreaterThan(0);
    expect(boot).toBeGreaterThan(started); // the runner must be running to take the request the wake makes
    expect(source).toMatch(/knowledgeChanges,\n\s+knowledgeJobWaker,/);
  });
});
