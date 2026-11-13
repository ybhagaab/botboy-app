import { describe, expect, it } from 'vitest';
import { jobsMessageConfirmed, waitsInCall } from './chat.js';

/** wait_for and the repeat breaker (docs/maps/job-waits.md): only a call that waits server-side may repeat freely. */
describe('wait_for and the repeat breaker', () => {
  it('a call that waits 30 s or more in the call is a wait; a no-wait call again is a poll', () => {
    expect(waitsInCall(JSON.stringify({ kind: 'sql_export', id: 'e_x', waitSeconds: 300 }))).toBe(true);
    expect(waitsInCall(JSON.stringify({ kind: 'sql_export', id: 'e_x', waitSeconds: 30 }))).toBe(true);
    expect(waitsInCall(JSON.stringify({ kind: 'sql_export', id: 'e_x', waitSeconds: 10 }))).toBe(false);
    expect(waitsInCall(JSON.stringify({ kind: 'sql_export', id: 'e_x' }))).toBe(false);
    expect(waitsInCall('not json')).toBe(false);
  });
});

/**
 * The reply's integrity gate counts a `jobs` call as an effect only when a job took the message (PARALLEL_JOBS_PLAN.md §11 R3):
 * list, read and every refusal are not effects, so the main chat cannot say it passed something on when nothing went.
 */
describe('jobs message as an effect', () => {
  it('counts only a message the job took', () => {
    expect(jobsMessageConfirmed('jobs', JSON.stringify({ ok: true, messaged: true, job: { number: 3 } }))).toBe(true);
    expect(jobsMessageConfirmed('jobs', JSON.stringify({ ok: true, jobs: [] }))).toBe(false);
    expect(jobsMessageConfirmed('jobs', JSON.stringify({ ok: false, code: 'owner_turn_active' }))).toBe(false);
    expect(jobsMessageConfirmed('jobs', JSON.stringify({ ok: true, messaged: 'yes' }))).toBe(false);
    expect(jobsMessageConfirmed('jobs', 'not json')).toBe(false);
    expect(jobsMessageConfirmed('job_update', JSON.stringify({ messaged: true }))).toBe(false);
  });

  // §12: keeping a job going and asking the owner are effects too, once the desk did them.
  it('counts a job kept going and a question set for the owner, never a refusal of either', () => {
    expect(jobsMessageConfirmed('jobs', JSON.stringify({ ok: true, continued: true }))).toBe(true);
    expect(jobsMessageConfirmed('jobs', JSON.stringify({ ok: true, asked: true }))).toBe(true);
    expect(jobsMessageConfirmed('jobs', JSON.stringify({ ok: false, code: 'needs_answer' }))).toBe(false);
    expect(jobsMessageConfirmed('jobs', JSON.stringify({ ok: false, code: 'rounds_used', continued: 'true' }))).toBe(false);
  });
});
