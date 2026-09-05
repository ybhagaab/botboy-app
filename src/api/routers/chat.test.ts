/**
 * Chat router unit tests — currently the transient-error classifier that
 * gates the single stream retry. The classifier is the difference between
 * "provider blip costs one second" and "an 11-iteration turn dies silently"
 * (live incident 2026-09-03: a mid-turn provider 500 was classified
 * non-transient, so the turn was never retried).
 */

import { describe, it, expect } from 'vitest';
import { isTransientStreamError } from './chat.js';

describe('isTransientStreamError', () => {
  describe('provider-side 5xx (the 2026-09-03 incident class) — retryable', () => {
    it('classifies the exact incident shape: HTTP 500 with provider apology', () => {
      const err = new Error(
        'OpenAI-compatible chat stream failed: HTTP 500 — {"error":{"message":"The server had an error while processing your request. Sorry about that!","type":"server_error"}}'
      );
      expect(isTransientStreamError(err)).toBe(true);
    });

    it('classifies a bare "server had an error" message without HTTP prefix', () => {
      expect(isTransientStreamError(new Error('The server had an error processing your request'))).toBe(true);
    });

    it('classifies HTTP 502/503 gateway shapes', () => {
      expect(isTransientStreamError(new Error('HTTP 502 Bad Gateway'))).toBe(true);
      expect(isTransientStreamError(new Error('HTTP 503 Service Unavailable'))).toBe(true);
    });

    it('classifies "internal server error" and "overloaded" case-insensitively', () => {
      expect(isTransientStreamError(new Error('Internal Server Error'))).toBe(true);
      expect(isTransientStreamError(new Error('Model is OVERLOADED, try again'))).toBe(true);
    });

    it('classifies structured server_error type markers', () => {
      expect(isTransientStreamError(new Error('{"type":"server_error","message":"unexpected"}'))).toBe(true);
    });
  });

  describe('network transients — retryable', () => {
    it.each(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'])(
      'classifies %s',
      code => {
        expect(isTransientStreamError(new Error(`request failed: ${code}`))).toBe(true);
      }
    );

    it('classifies socket hang up, terminated, and fetch failed', () => {
      expect(isTransientStreamError(new Error('socket hang up'))).toBe(true);
      expect(isTransientStreamError(new Error('terminated'))).toBe(true);
      expect(isTransientStreamError(new Error('fetch failed'))).toBe(true);
    });
  });

  describe('4xx rejections — never retryable', () => {
    it('rejects HTTP 400 and HTTP 429', () => {
      expect(isTransientStreamError(new Error('HTTP 400 — bad request: invalid tool schema'))).toBe(false);
      expect(isTransientStreamError(new Error('HTTP 429 — rate limited'))).toBe(false);
    });

    it('lets the 4xx guard win even when a transient keyword co-occurs', () => {
      // "network" is a transient pattern, but an HTTP 4xx is a deterministic
      // rejection: retrying resends the same bad request.
      expect(isTransientStreamError(new Error('HTTP 429 network throttle'))).toBe(false);
    });
  });

  describe('non-transient failures — never retryable', () => {
    it('rejects plain logic errors', () => {
      expect(isTransientStreamError(new Error("Cannot read properties of undefined (reading 'content')"))).toBe(false);
    });

    it('rejects empty and nullish inputs', () => {
      expect(isTransientStreamError(undefined)).toBe(false);
      expect(isTransientStreamError(null)).toBe(false);
      expect(isTransientStreamError(new Error(''))).toBe(false);
    });
  });

  it('accepts non-Error inputs via string coercion', () => {
    expect(isTransientStreamError('fetch failed mid-stream')).toBe(true);
    expect(isTransientStreamError('validation exception')).toBe(false);
  });
});
