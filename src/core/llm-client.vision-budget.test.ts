import { describe, expect, it } from 'vitest';
import {
  LlmPayloadConstraintError,
  LlmPayloadTooLargeError,
  assertProviderRequestSize,
  providerHttpError,
  providerRequestSize,
  serializeProviderRequest,
  toWireMessages,
  type LlmMessage,
} from './llm-client.js';

describe('provider request byte budget', () => {
  it('counts exact UTF-8 bytes and inline image characters', () => {
    const image = `data:image/jpeg;base64,${'A'.repeat(1_000)}`;
    const body = { input: [{ role: 'user', content: [{ type: 'input_text', text: 'नमस्ते' }, { type: 'input_image', image_url: image }] }] };
    const bodyStr = JSON.stringify(body);
    const size = providerRequestSize(bodyStr);
    expect(size.bodyBytes).toBe(Buffer.byteLength(bodyStr, 'utf8'));
    expect(size.bodyBytes).toBeGreaterThan(size.bodyChars);
    expect(size.imageCount).toBe(1);
    expect(size.imageChars).toBe(image.length);
    expect(assertProviderRequestSize(bodyStr, size.bodyBytes)).toEqual(size);
  });

  it('rejects an oversized body locally with actionable image diagnostics', () => {
    const image = `data:image/png;base64,${'A'.repeat(6_000_000)}`;
    const body = { input: [{ role: 'user', content: [{ type: 'input_image', image_url: image }] }] };
    expect(() => serializeProviderRequest(body, 5_500_000)).toThrow(LlmPayloadTooLargeError);
    try {
      serializeProviderRequest(body, 5_500_000);
    } catch (error) {
      const typed = error as LlmPayloadTooLargeError;
      expect(typed.code).toBe('LLM_PAYLOAD_TOO_LARGE');
      expect(typed.size.imageCount).toBe(1);
      expect(typed.size.imageChars).toBe(image.length);
      expect(typed.message).toContain('Capture fewer/more focused screenshots');
    }
  });

  it('never leaks internal evidence provenance onto Chat Completions wire messages', () => {
    const messages: LlmMessage[] = [{
      role: 'user',
      content: 'pixels',
      images: ['data:image/jpeg;base64,AAAA'],
      visionEvidenceKey: 'browser:tab1',
      visionEvidenceSource: 'browser_screenshot',
    }];
    const wire = toWireMessages({ dialect: 'openai' }, messages)[0];
    expect(wire.visionEvidenceKey).toBeUndefined();
    expect(wire.visionEvidenceSource).toBeUndefined();
    expect(wire.images).toBeUndefined();
    expect(wire.content[1].type).toBe('image_url');
  });
});

describe('payload rejection normalization and recovery wire constraints', () => {
  const rejectedSize = {
    bodyChars: 9_291_470,
    bodyBytes: 9_293_448,
    imageCount: 3,
    imageChars: 8_757_630,
  };

  it('normalizes only the explicit upstream payload-limit rejection', () => {
    const body = JSON.stringify({
      error: {
        message: 'Payload size of 9 MB exceeds the allowed limit of 6 MB',
        type: 'invalid_request_error',
        code: '400',
      },
    });
    const error = providerHttpError(400, body, rejectedSize);
    expect(error).toBeInstanceOf(LlmPayloadTooLargeError);
    const typed = error as LlmPayloadTooLargeError;
    expect(typed.source).toBe('remote');
    expect(typed.httpStatus).toBe(400);
    expect(typed.maximumBytes).toBe(6_000_000);
    expect(typed.size).toEqual(rejectedSize);
    expect(typed.message).toContain('rejected request was not processed');
  });

  it('does not reinterpret unrelated HTTP 400 failures as payload errors', () => {
    const error = providerHttpError(400, '{"error":{"message":"invalid tool schema"}}', rejectedSize);
    expect(error).not.toBeInstanceOf(LlmPayloadTooLargeError);
    expect(error.message).toBe('HTTP 400: {"error":{"message":"invalid tool schema"}}');
  });

  it('mechanically requires a recovery body to be image-free and strictly smaller', () => {
    const imageBody = { input: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' }] };
    expect(() => serializeProviderRequest(imageBody, 5_500_000, {
      requireImageFree: true,
      smallerThanBytes: 1_000,
    })).toThrow(LlmPayloadConstraintError);

    const textBody = { input: [{ type: 'input_text', text: 'resume' }] };
    const serialized = serializeProviderRequest(textBody, 5_500_000, {
      requireImageFree: true,
      smallerThanBytes: 1_000,
    });
    expect(serialized.size.imageCount).toBe(0);
    expect(serialized.size.bodyBytes).toBeLessThan(1_000);

    expect(() => serializeProviderRequest(textBody, 5_500_000, {
      requireImageFree: true,
      smallerThanBytes: serialized.size.bodyBytes,
    })).toThrow(LlmPayloadConstraintError);
  });
});