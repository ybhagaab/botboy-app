import { describe, expect, it } from 'vitest';
import {
  CONNECT_PHASE_RETRYABLE_CODES,
  CONNECT_RETRY_BACKOFF_MS,
  NEVER_CONNECTED_CODES,
  allConnectPhase,
  retryAfterBackoff,
  transportCodesOf,
} from './transport-errors.js';

/** A socket error the way Node reports it. */
function errno(code: string, syscall = 'connect'): Error {
  return Object.assign(new Error(`${syscall} ${code}`), { code, syscall });
}

/** What the owner's Mac threw for every fetch to Google: one entry per address. */
function ownersAggregate(): Error {
  return Object.assign(new AggregateError([errno('ETIMEDOUT'), errno('EHOSTUNREACH')], ''), { code: 'ETIMEDOUT' });
}

describe('transport error codes', () => {
  it('reads the errno behind fetch’s TypeError and across an AggregateError’s addresses', () => {
    expect(transportCodesOf(Object.assign(new TypeError('fetch failed'), { cause: errno('ENOTFOUND') }))).toEqual(['ENOTFOUND']);
    expect(transportCodesOf(Object.assign(new TypeError('fetch failed'), { cause: ownersAggregate() }))).toEqual(['ETIMEDOUT', 'EHOSTUNREACH']);
    // The code list is the cause chain's, not the wrapper's own name.
    expect(transportCodesOf(new TypeError('fetch failed'))).toEqual([]);
    expect(transportCodesOf(null)).toEqual([]);
    expect(transportCodesOf('ETIMEDOUT')).toEqual([]);
  });

  it('follows an axios-style wrapper (original, cause) without looping or reading numbers', () => {
    const loop: any = Object.assign(new Error('loop'), { code: 'ECONNRESET' });
    loop.cause = loop;
    expect(transportCodesOf(loop)).toEqual(['ECONNRESET']);
    expect(transportCodesOf({ code: 23, cause: { code: 'ECONNREFUSED' } })).toEqual(['ECONNREFUSED']);
    expect(transportCodesOf({ original: { code: 'EAI_AGAIN' } })).toEqual(['EAI_AGAIN']);
    // Odd characters are stripped and the length is capped.
    expect(transportCodesOf({ code: 'E<script>X' })).toEqual(['EscriptX']);
  });

  it('calls only connect-phase codes retryable: never-connected ones plus ETIMEDOUT and ECONNRESET', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ECONNRESET']) {
      expect(CONNECT_PHASE_RETRYABLE_CODES.has(code), code).toBe(true);
    }
    for (const code of ['EPIPE', 'ECONNABORTED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_INVALID_URL', 'slack_webapi_request_error']) {
      expect(CONNECT_PHASE_RETRYABLE_CODES.has(code), code).toBe(false);
    }
    expect(NEVER_CONNECTED_CODES.has('ETIMEDOUT')).toBe(false);
    expect(allConnectPhase(['ETIMEDOUT', 'EHOSTUNREACH'])).toBe(true);
    // One code that is not a connect-phase one makes the whole failure unprovable.
    expect(allConnectPhase(['ETIMEDOUT', 'EPIPE'])).toBe(false);
    expect(allConnectPhase([])).toBe(false);
  });
});

describe('retry after a pause', () => {
  it('retries once, after the pause, and returns the second result', async () => {
    const pauses: number[] = [];
    const retried: unknown[] = [];
    let calls = 0;
    const value = await retryAfterBackoff(async () => {
      calls++;
      if (calls === 1) throw new Error('first');
      return 'second';
    }, { shouldRetry: () => true, sleep: async ms => { pauses.push(ms); }, onRetry: error => { retried.push(error); } });
    expect(value).toBe('second');
    expect(calls).toBe(2);
    expect(pauses).toEqual([CONNECT_RETRY_BACKOFF_MS]);
    expect(CONNECT_RETRY_BACKOFF_MS).toBe(1500);
    expect(retried).toHaveLength(1);
  });

  it('stops after the retries it was given and throws the last failure unchanged', async () => {
    let calls = 0;
    const failure = await retryAfterBackoff(async () => { calls++; throw new Error(`failure ${calls}`); }, { shouldRetry: () => true, sleep: async () => {} }).catch(error => error);
    expect(failure.message).toBe('failure 2');
    expect(calls).toBe(2);

    calls = 0;
    await expect(retryAfterBackoff(async () => { calls++; throw new Error('once'); }, { shouldRetry: () => true, retries: 0, sleep: async () => {} })).rejects.toThrow('once');
    expect(calls).toBe(1);
  });

  it('never retries a failure the caller refuses', async () => {
    let calls = 0;
    let slept = false;
    await expect(retryAfterBackoff(async () => { calls++; throw new Error('http 400'); }, { shouldRetry: () => false, sleep: async () => { slept = true; } })).rejects.toThrow('http 400');
    expect(calls).toBe(1);
    expect(slept).toBe(false);
  });
});
