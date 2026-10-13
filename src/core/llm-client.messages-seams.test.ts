import { describe, expect, it } from 'vitest';
import {
  LlmPayloadConstraintError,
  LlmPayloadTooLargeError,
  LlmProviderOverloadedError,
  LlmQuotaExhaustedError,
  LlmRateLimitedError,
  abortableDelay,
  assertProviderRequestSize,
  isLlmProviderLimitError,
  providerRequestSize,
  serializeProviderRequest,
  validateStrictResponseFormat,
  type LlmApiMode,
  type LlmResponseFormat,
} from './llm-client.js';
import { AiModelSettingsError, modelSettingsError } from './ai-model-settings.js';
import { convertHistory, measureAnthropicRequest } from './anthropic-messages.js';

/**
 * Design v3 section 5 (slice A2): the additive seams in llm-client.ts that the Anthropic transport needs. The
 * OpenAI-compatible client itself is untouched, so OpenAI and DeepSeek wording is pinned here as well.
 */
describe('LlmQuotaExhaustedError', () => {
  it('keeps the exact OpenAI and DeepSeek wording', () => {
    const openai = new LlmQuotaExhaustedError();
    expect(openai.message).toBe('The OpenAI account behind this API key has no available credit.');
    expect(openai.nextAction).toBe('Add credit or raise the spending limit for this OpenAI account (platform.openai.com → Billing), then try again.');
    const deepseek = new LlmQuotaExhaustedError('deepseek');
    expect(deepseek.message).toBe('The DeepSeek account behind this API key has no balance left.');
    expect(deepseek.nextAction).toBe('Top up this DeepSeek account (platform.deepseek.com → Top up), then try again.');
  });

  it('serves Anthropic with its own wording, or with the classified text the caller passes', () => {
    const plain = new LlmQuotaExhaustedError('anthropic');
    expect(plain.platform).toBe('anthropic');
    expect(plain.message).toBe('The Anthropic account behind this API key has no available credit.');
    expect(plain.nextAction).toContain('platform.claude.com/settings/billing');
    const classified = new LlmQuotaExhaustedError('anthropic', { message: 'Your Anthropic account has reached a spend limit you set.', nextAction: 'Raise the limit.' });
    expect(classified.message).toBe('Your Anthropic account has reached a spend limit you set.');
    expect(classified.nextAction).toBe('Raise the limit.');
    expect(classified.code).toBe('LLM_QUOTA_EXHAUSTED');
  });
});

describe('LlmProviderOverloadedError and isLlmProviderLimitError', () => {
  it('carries the designed copy and counts as a provider limit, never as endpoint health', () => {
    const error = new LlmProviderOverloadedError();
    expect(error.message).toBe('Anthropic is temporarily overloaded.');
    expect(error.nextAction).toBe('Anthropic is busy. BotBoy already retried; try again in a minute.');
    expect(error.code).toBe('LLM_PROVIDER_OVERLOADED');
    expect(isLlmProviderLimitError(error)).toBe(true);
    expect(isLlmProviderLimitError(new LlmRateLimitedError(1000))).toBe(true);
    expect(isLlmProviderLimitError(new LlmQuotaExhaustedError('anthropic'))).toBe(true);
    // A structurally identical error from another module instance still counts.
    expect(isLlmProviderLimitError(Object.assign(new Error('x'), { code: 'LLM_PROVIDER_OVERLOADED' }))).toBe(true);
    expect(isLlmProviderLimitError(new Error('HTTP 500'))).toBe(false);
    expect(isLlmProviderLimitError(null)).toBe(false);
    expect(new LlmProviderOverloadedError(undefined, 'Example').message).toBe('Example is temporarily overloaded.');
  });

  it('is a Save-time "busy" answer (503), not a rate limit, while quota and rate limits keep their codes', () => {
    const busy = modelSettingsError(new LlmProviderOverloadedError(), 'anthropic');
    expect(busy).toBeInstanceOf(AiModelSettingsError);
    expect(busy.code).toBe('provider_overloaded');
    expect(busy.httpStatus).toBe(503);
    expect(busy.message).toContain('temporarily overloaded');
    expect(modelSettingsError(new LlmQuotaExhaustedError('openai'), 'openai').code).toBe('no_credit');
    const limited = modelSettingsError(new LlmRateLimitedError(), 'openai');
    expect(limited.code).toBe('rate_limited');
    expect(limited.httpStatus).toBe(429);
  });
});

describe('abortableDelay', () => {
  it('waits, and rejects with the signal reason when aborted first', async () => {
    await expect(abortableDelay(1)).resolves.toBeUndefined();
    const controller = new AbortController();
    const waiting = abortableDelay(10_000, controller.signal);
    controller.abort(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
    const already = new AbortController();
    already.abort();
    await expect(abortableDelay(10, already.signal)).rejects.toBeDefined();
  });
});

describe('serializeProviderRequest with a custom image measure', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const anthropicBody = () => ({
    model: 'm', max_tokens: 10,
    messages: convertHistory([{ role: 'user', content: 'look', images: [png] }]).messages,
  });

  it('is unchanged by default: data URLs are counted, an Anthropic body reads as image-free', () => {
    const openAiBody = { input: [{ role: 'user', content: [{ type: 'input_image', image_url: png }] }] };
    expect(serializeProviderRequest(openAiBody).size.imageCount).toBe(1);
    // Without a measure, the base64 block is invisible, so requireImageFree would pass vacuously. This is why `measure` exists.
    expect(serializeProviderRequest(anthropicBody(), undefined, { requireImageFree: true }).size.imageCount).toBe(0);
  });

  it('uses the supplied measure for the size and for requireImageFree', () => {
    const { size } = serializeProviderRequest(anthropicBody(), undefined, undefined, measureAnthropicRequest);
    expect(size.imageCount).toBe(1);
    expect(() => serializeProviderRequest(anthropicBody(), undefined, { requireImageFree: true }, measureAnthropicRequest)).toThrow(LlmPayloadConstraintError);
    expect(() => serializeProviderRequest(anthropicBody(), 100, undefined, measureAnthropicRequest)).toThrow(LlmPayloadTooLargeError);
    expect(assertProviderRequestSize('{}', 1000, () => ({ bodyChars: 2, bodyBytes: 2, imageCount: 7, imageChars: 0 })).imageCount).toBe(7);
    expect(providerRequestSize('{}').imageCount).toBe(0);
  });
});

describe('validateStrictResponseFormat', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } };

  it('returns a valid strict format, null for other formats, and refuses the rest before any request', () => {
    const strict: LlmResponseFormat = { type: 'json_schema', name: 'thing_1', strict: true, schema };
    expect(validateStrictResponseFormat(strict)).toBe(strict);
    expect(validateStrictResponseFormat({ type: 'json_object' })).toBeNull();
    expect(validateStrictResponseFormat({ type: 'text' })).toBeNull();
    expect(() => validateStrictResponseFormat({ ...strict, name: 'bad name!' })).toThrow(/strict mode, a provider-safe name/);
    expect(() => validateStrictResponseFormat({ ...strict, strict: false as unknown as true })).toThrow(/strict mode/);
    expect(() => validateStrictResponseFormat({ ...strict, schema: { ...schema, additionalProperties: true } })).toThrow(/additionalProperties/);
    expect(() => validateStrictResponseFormat({ ...strict, schema: { ...schema, required: [] } })).toThrow(/every property must be required/);
  });
});

describe('LlmApiMode', () => {
  it('has a messages mode for the Anthropic transport', () => {
    const mode: LlmApiMode = 'messages';
    expect(mode).toBe('messages');
  });
});
