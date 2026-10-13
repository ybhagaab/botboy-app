import { describe, expect, it } from 'vitest';
import {
  AnthropicApiError,
  ANTHROPIC_BILLING_URL,
  ANTHROPIC_KEYS_URL,
  AnthropicUnreachableError,
  classifyAnthropicHttpError,
  isAnthropicApiError,
  isAnthropicUnreachableError,
  statusForAnthropicErrorType,
  type AnthropicErrorClassification,
} from './anthropic-errors.js';

/**
 * Design v3 D10: every row of the status table, once, plus the rules around
 * it: non-JSON bodies map by status alone and never surface their text,
 * provider text is redacted and bounded, and only 5xx answers may mark health.
 */
// Assembled at runtime: a realistic key literal must never sit in a source file.
const PLANTED_KEY = ['sk', 'ant', 'api03', `${'planted'.repeat(8)}`].join('-');

const errorBody = (type: string, message: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'error', error: { type, message, ...extra }, request_id: 'req_0123456789abcdef' });

const classify = (status: number, body: string, headers: Record<string, string> = {}): AnthropicErrorClassification =>
  classifyAnthropicHttpError(status, new Headers(headers), body);

describe('classifyAnthropicHttpError: the D10 table', () => {
  it('401 authentication_error is a terminal credential problem recorded as auth_rejected', () => {
    const result = classify(401, errorBody('authentication_error', 'invalid x-api-key'));
    expect(result).toMatchObject({
      status: 401, kind: 'auth_rejected', class: 'terminal', logLevel: 'warn', issue: 'auth_rejected',
      marksHealth: false, retry: 'none', saveCode: 'invalid_key', saveStatus: 400,
      errorType: 'authentication_error', requestId: 'req_0123456789abcdef',
    });
    expect(result.message).toContain('expired, revoked or malformed');
    expect(result.nextAction).toContain(ANTHROPIC_KEYS_URL);
  });

  it('402 billing_error is terminal quota exhaustion saved as no_credit', () => {
    const result = classify(402, errorBody('billing_error', 'Your credit balance is too low'));
    expect(result).toMatchObject({
      kind: 'quota_exhausted', class: 'terminal', logLevel: 'warn', issue: 'quota_exhausted', quotaCause: 'billing',
      retry: 'none', marksHealth: false, saveCode: 'no_credit', saveStatus: 400,
    });
    expect(result.nextAction).toContain(ANTHROPIC_BILLING_URL);
  });

  it('a 400 that begins "You have reached your specified (workspace) API usage limits" is the same quota error, worded as an owner limit', () => {
    for (const message of [
      'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.',
      'You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.',
    ]) {
      const result = classify(400, errorBody('invalid_request_error', message));
      expect(result).toMatchObject({
        kind: 'quota_exhausted', class: 'terminal', issue: 'quota_exhausted', quotaCause: 'owner_limit',
        saveCode: 'no_credit', logLevel: 'warn', retry: 'none',
      });
      expect(result.message).toContain('spend limit you set');
    }
  });

  it('a 429 carrying details.error_code enforced_spend_limit_reached is the same quota error and is never retried', () => {
    const result = classify(429, errorBody('rate_limit_error', 'You have reached your monthly spend cap', {
      details: { error_code: 'enforced_spend_limit_reached' },
    }));
    expect(result).toMatchObject({
      kind: 'quota_exhausted', class: 'terminal', issue: 'quota_exhausted', quotaCause: 'tier_cap',
      retry: 'none', saveCode: 'no_credit',
    });
    expect(result.retryAfterMs).toBeUndefined();
    // Even if a proxy added a retry-after, a spend cap does not wait.
    expect(classify(429, errorBody('rate_limit_error', 'cap', { details: { error_code: 'enforced_spend_limit_reached' } }), { 'retry-after': '30' }).retryAfterMs).toBeUndefined();
  });

  it('a 400 naming anthropic-workspace-id as required is a request-level workspace_required', () => {
    const result = classify(400, errorBody('invalid_request_error', 'anthropic-workspace-id is required when the credential can act on more than one workspace'));
    expect(result).toMatchObject({
      kind: 'workspace_required', class: 'request', logLevel: 'warn', saveCode: 'workspace_required', saveStatus: 400, marksHealth: false,
    });
    expect(result.message).toBe('This key is not tied to one workspace.');
    expect(result.nextAction).toBe('Create a key scoped to one workspace (Console → Settings → API keys → Create key, choose a workspace), then save it here.');
  });

  it('other 400s name their documented cause and a next action', () => {
    const cases: [string, string, string][] = [
      ['`thinking.type.enabled` is not supported for this model. Use `thinking.type.adaptive` and `output_config.effort` to control thinking behavior.', 'thinking_type', 'Thinking setting'],
      ['adaptive thinking is not supported for this model', 'thinking_type', 'Thinking setting'],
      ['`thinking.type.disabled` is not supported for this model', 'thinking_type', 'Thinking setting'],
      ['effort level `xhigh` is not supported when thinking is disabled', 'thinking_type', 'Thinking setting'],
      ["tool_choice type 'any' is not supported with this model", 'forced_tool_choice', 'forced tool use'],
      ['Schema is too complex for compilation', 'schema_too_complex', 'response format'],
      ['messages.3.content.0: Invalid `signature` in `thinking` block', 'thinking_replay', 'earlier reasoning'],
      ['messages.3.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.', 'thinking_replay', 'earlier reasoning'],
      ['max_tokens: field required', 'other', 'rejected the request (HTTP 400)'],
    ];
    for (const [message, cause, wording] of cases) {
      const result = classify(400, errorBody('invalid_request_error', message));
      expect(result, message).toMatchObject({
        kind: 'invalid_request', class: 'request', logLevel: 'warn', requestCause: cause, marksHealth: false,
        saveCode: 'rejected', saveStatus: 502, retry: 'none',
      });
      expect(result.message).toContain(wording);
      expect(result.nextAction.length).toBeGreaterThan(10);
      // A thinking-type 400 also queues a free model-list refresh.
      expect(result.refreshModels).toBe(cause === 'thinking_type');
    }
  });

  it('403 permission_error and 404 not_found_error name the model, not the key, and stay request-level', () => {
    const forbidden = classify(403, errorBody('permission_error', 'Your API key does not have permission to use the specified resource.'));
    expect(forbidden).toMatchObject({ kind: 'forbidden', class: 'request', logLevel: 'warn', marksHealth: false, saveCode: 'forbidden', saveStatus: 400 });
    expect(forbidden.issue).toBeUndefined();
    expect(forbidden.message).toContain('that Claude model');
    // The same 403 on the model LIST is about the key (no model was named): key-level wording, same code and class.
    const onList = classifyAnthropicHttpError(403, new Headers(), errorBody('permission_error', 'no'), 'models');
    expect(onList).toMatchObject({ kind: 'forbidden', class: 'request', saveCode: 'forbidden', saveStatus: 400, marksHealth: false });
    expect(onList.message).toBe('This key is not allowed to list Claude models.');
    expect(onList.message).not.toContain('that Claude model');
    expect(onList.nextAction).toContain('permissions and workspace');
    expect(classifyAnthropicHttpError(403, new Headers(), errorBody('permission_error', 'no'), 'generation').message).toBe(forbidden.message);
    const missing = classify(404, errorBody('not_found_error', 'model: claude-gone'));
    expect(missing).toMatchObject({ kind: 'model_unavailable', class: 'request', logLevel: 'warn', marksHealth: false, refreshModels: true, saveCode: 'model_unavailable', saveStatus: 400 });
    expect(missing.issue).toBeUndefined();
  });

  it('409 conflict_error and any other 4xx are request-specific errors', () => {
    for (const status of [409, 408, 418, 422]) {
      const result = classify(status, errorBody('conflict_error', 'conflict'));
      expect(result, String(status)).toMatchObject({
        kind: 'request_rejected', class: 'request', logLevel: 'warn', marksHealth: false, saveCode: 'rejected', saveStatus: 502, retry: 'none',
      });
      expect(result.message).toContain(`HTTP ${status}`);
      expect(result.issue).toBeUndefined();
    }
  });

  it('413 request_too_large maps to the payload-too-large kind', () => {
    const result = classify(413, errorBody('request_too_large', 'Request exceeds the maximum allowed number of bytes.'));
    expect(result).toMatchObject({ kind: 'payload_too_large', class: 'request', logLevel: 'warn', marksHealth: false, retry: 'none' });
  });

  it('other 429 rate_limit_error is transient with a bounded retry and honors retry-after', () => {
    const result = classify(429, errorBody('rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit'), { 'retry-after': '7' });
    expect(result).toMatchObject({
      kind: 'rate_limited', class: 'transient', logLevel: 'info', issue: 'rate_limited', retry: 'bounded',
      marksHealth: false, saveCode: 'rate_limited', saveStatus: 429, retryAfterMs: 7_000,
    });
    expect(classify(429, errorBody('rate_limit_error', 'slow down')).retryAfterMs).toBeUndefined();
    // Negative and non-finite waits are ignored.
    expect(classify(429, errorBody('rate_limit_error', 'slow down'), { 'retry-after': '-5' }).retryAfterMs).toBeUndefined();
    expect(classify(429, errorBody('rate_limit_error', 'slow down'), { 'retry-after': 'soon' }).retryAfterMs).toBeUndefined();
  });

  it('529 overloaded_error is transient, never health, and saves as provider_overloaded (503)', () => {
    const result = classify(529, errorBody('overloaded_error', 'Overloaded'), { 'retry-after': '2' });
    expect(result).toMatchObject({
      kind: 'overloaded', class: 'transient', logLevel: 'info', issue: 'overloaded', retry: 'bounded',
      marksHealth: false, saveCode: 'provider_overloaded', saveStatus: 503, retryAfterMs: 2_000,
    });
    expect(result.message).toBe('Anthropic is temporarily overloaded.');
  });

  it('500 api_error and 504 timeout_error are transient server errors that may mark health', () => {
    for (const [status, type] of [[500, 'api_error'], [504, 'timeout_error'], [503, 'api_error']] as const) {
      const result = classify(status, errorBody(type, 'internal'));
      expect(result, String(status)).toMatchObject({
        kind: 'server_error', class: 'transient', logLevel: 'info', marksHealth: true, retry: 'none',
        saveCode: 'rejected', saveStatus: 502, errorType: type,
      });
      expect(result.issue).toBeUndefined();
      expect(new AnthropicApiError(result).message).toMatch(new RegExp(`^HTTP ${status} \\(${type}\\)`));
    }
  });
});

describe('classifyAnthropicHttpError: bodies, secrets and health', () => {
  it('maps a non-JSON body by status alone and never shows or logs its text', () => {
    const cloudflare413 = '<html><head><title>413 Request Entity Too Large</title></head><body>cloudflare nginx</body></html>';
    const result = classify(413, cloudflare413);
    expect(result.kind).toBe('payload_too_large');
    expect(result.providerMessage).toBeUndefined();
    expect(result.errorType).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/cloudflare|nginx|<html/i);
    expect(new AnthropicApiError(result).message).not.toMatch(/cloudflare|nginx|<html/i);

    const gateway502 = classify(502, '<html>Bad gateway</html>');
    expect(gateway502).toMatchObject({ kind: 'server_error', marksHealth: true });
    expect(JSON.stringify(gateway502)).not.toContain('Bad gateway');
    // A 400 whose body is not JSON cannot be refined: a plain 400.
    expect(classify(400, 'Bad Request')).toMatchObject({ kind: 'invalid_request', requestCause: 'other' });
  });

  it('maps JSON without an error object by status alone', () => {
    for (const body of ['{}', '[]', 'null', '{"error":"flat string"}', '{"error":[1]}', '{"message":"You have reached your specified API usage limits"}']) {
      const result = classify(400, body);
      expect(result, body).toMatchObject({ kind: 'invalid_request', requestCause: 'other' });
      expect(result.providerMessage).toBeUndefined();
    }
  });

  it('redacts and bounds provider text, and never carries a key', () => {
    const result = classify(401, errorBody('authentication_error', `invalid x-api-key: ${PLANTED_KEY} ${'x'.repeat(2_000)}`));
    expect(JSON.stringify(result)).not.toContain(PLANTED_KEY);
    expect(JSON.stringify(result)).not.toContain('planted');
    expect(result.providerMessage).toContain('[redacted]');
    expect(result.providerMessage!.length).toBeLessThanOrEqual(300);
    const error = new AnthropicApiError(result);
    expect(error.message).not.toContain(PLANTED_KEY);
    expect(error.message).toMatch(/^HTTP 401 \(authentication_error\)/);
  });

  it('keeps control characters out of provider text', () => {
    const result = classify(500, errorBody('api_error', 'line one\nline\ttwo\u0007\u0000end'));
    expect(result.providerMessage).toBe('line one line two end');
  });

  it('reads the request id from the header first, then the body, and ignores unsafe values', () => {
    expect(classify(500, errorBody('api_error', 'x'), { 'request-id': 'req_header01' }).requestId).toBe('req_header01');
    expect(classify(500, errorBody('api_error', 'x')).requestId).toBe('req_0123456789abcdef');
    expect(classify(500, errorBody('api_error', 'x'), { 'request-id': 'bad id!' }).requestId).toBe('req_0123456789abcdef');
    expect(classify(500, '<html>').requestId).toBeUndefined();
    const unsafe = JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'x' }, request_id: 'req; drop table' });
    expect(classify(500, unsafe).requestId).toBeUndefined();
  });

  it('drops a request id that looks like a key, from the header or the body, so it can never reach a message or a log', () => {
    const inHeader = classify(500, errorBody('api_error', 'x'), { 'request-id': PLANTED_KEY });
    expect(inHeader.requestId).toBe('req_0123456789abcdef');
    const body = JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'x' }, request_id: PLANTED_KEY });
    const inBody = classify(500, body);
    expect(inBody.requestId).toBeUndefined();
    for (const result of [inHeader, inBody]) {
      expect(JSON.stringify(result)).not.toContain('planted');
      expect(new AnthropicApiError(result).message).not.toContain('planted');
    }
  });

  it('only 5xx answers may mark endpoint health; every 4xx, including 401, is health-neutral', () => {
    for (let status = 400; status <= 599; status += 1) {
      const result = classify(status, errorBody('api_error', 'x'));
      expect(result.marksHealth, String(status)).toBe(status >= 500 && status !== 529);
      if (status < 500) expect(result.class === 'transient' && status !== 429, String(status)).toBe(false);
    }
  });

  it('records a provider issue only for credential, account and capacity answers', () => {
    const issues = new Map<number, string | undefined>();
    for (const status of [400, 401, 402, 403, 404, 409, 413, 429, 500, 504, 529]) {
      issues.set(status, classify(status, errorBody('api_error', 'x')).issue);
    }
    expect(Object.fromEntries(issues)).toEqual({
      400: undefined, 401: 'auth_rejected', 402: 'quota_exhausted', 403: undefined, 404: undefined,
      409: undefined, 413: undefined, 429: 'rate_limited', 500: undefined, 504: undefined, 529: 'overloaded',
    });
  });

  it('typed errors carry their classification and are recognizable without instanceof', () => {
    const classification = classify(402, errorBody('billing_error', 'low'));
    const error = new AnthropicApiError(classification);
    expect(isAnthropicApiError(error)).toBe(true);
    expect(isAnthropicApiError({ code: 'ANTHROPIC_API_ERROR' })).toBe(true);
    expect(isAnthropicApiError(new Error('HTTP 402'))).toBe(false);
    expect(error.status).toBe(402);
    expect(error.classification).toBe(classification);
    const unreachable = new AnthropicUnreachableError();
    expect(isAnthropicUnreachableError(unreachable)).toBe(true);
    expect(isAnthropicUnreachableError(new Error('x'))).toBe(false);
    expect(unreachable.message).toBe('BotBoy could not reach api.anthropic.com.');
  });
});

describe('statusForAnthropicErrorType: mid-stream error events', () => {
  it('maps every documented error.type to its status', () => {
    expect(Object.fromEntries([
      'invalid_request_error', 'authentication_error', 'billing_error', 'permission_error', 'not_found_error', 'conflict_error',
      'request_too_large', 'rate_limit_error', 'api_error', 'timeout_error', 'overloaded_error',
    ].map(type => [type, statusForAnthropicErrorType(type)]))).toEqual({
      invalid_request_error: 400, authentication_error: 401, billing_error: 402, permission_error: 403, not_found_error: 404,
      conflict_error: 409, request_too_large: 413, rate_limit_error: 429, api_error: 500, timeout_error: 504, overloaded_error: 529,
    });
  });

  it('counts a type the API adds later, or anything that is not a type, as 500', () => {
    for (const type of ['brand_new_error', '', 'constructor', '__proto__', 'toString', undefined, null, 42, {}]) {
      expect(statusForAnthropicErrorType(type), String(type)).toBe(500);
    }
  });

  it('agrees with the status classification of the same documented answers', () => {
    for (const type of ['authentication_error', 'billing_error', 'permission_error', 'not_found_error', 'rate_limit_error', 'overloaded_error', 'api_error']) {
      const status = statusForAnthropicErrorType(type);
      expect(classify(status, errorBody(type, 'x')).errorType, type).toBe(type);
    }
  });
});
