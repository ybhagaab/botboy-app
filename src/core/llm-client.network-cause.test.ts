import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLlmClient, type LlmConfig } from './llm-client.js';
import { createLlmUsageService } from './llm-usage.js';
import { createStorage, type StorageLayer } from './storage.js';
import { canMakeSelfSignedCert, closedLoopbackPort, startSelfSignedServer } from './tls-loopback.testutil.js';

/**
 * D2 of the DeepSeek diagnosability fixes (deepseek-failures report § 6): a network failure used to reach the person
 * as a bare `fetch failed`, because Node keeps the errno one level down (`TypeError: fetch failed` → `cause`). Whatever
 * can be told apart there (a refused connection, a name that does not resolve, a connect that timed out, a certificate
 * a proxy replaced) is a different fix. These tests use REAL loopback sockets, never a mocked fetch, so the error
 * shapes are the ones Node produces. Nothing here leaves 127.0.0.1.
 */
const KEY = 'sk-deepseekcause0000000000000000abcd';

function configFor(endpoint: string, overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    ecs: {
      endpoint,
      model: 'deepseek-flash',
      apiMode: 'responses',
      dialect: 'openai',
      maxContextTokens: 1_000_000,
      requestTimeoutMs: 30_000,
      reasoningEffort: 'low',
      requestAuthorizer: async () => ({ Authorization: `Bearer ${KEY}` }),
    },
    ollama: { endpoint: '', model: '', maxContextTokens: 0, requestTimeoutMs: 0 },
    defaults: { temperature: 0.7, maxCompletionTokens: 1024, contextBudgetTokens: 100_000 },
    healthCheckIntervalMs: 0,
    fallbackEnabled: false,
    providerId: 'deepseek',
    platform: 'deepseek',
    ...overrides,
  };
}

const ask = { messages: [{ role: 'user' as const, content: 'hi' }] };
afterEach(() => vi.unstubAllGlobals());

describe('the network cause in a provider failure (D2)', () => {
  it('shows the errno of a refused connection on both the batch and the stream path, and keeps the error itself', async () => {
    const client = createLlmClient(configFor(`http://127.0.0.1:${await closedLoopbackPort()}`));
    const batch = await client.chatCompletion(ask).catch(e => e);
    expect(batch.message).toBe('fetch failed (ECONNREFUSED)');
    // The same object Node threw: its name, its cause and the checks that read them keep working.
    expect(batch).toBeInstanceOf(TypeError);
    expect(batch.cause?.code).toBe('ECONNREFUSED');

    const stream = await client.chatCompletionStream(ask).next().catch(e => e);
    expect(stream.message).toBe('fetch failed (ECONNREFUSED)');
    // The cause in words never carries the address, a header or the key.
    for (const error of [batch, stream]) expect(String(error.message)).not.toMatch(/127\.0\.0\.1|sk-|Bearer/);
    client.close();
  });

  it('words every platform the same way, a team gateway included, and leaves the usage ledger\'s error class alone', async () => {
    let storage: StorageLayer | undefined;
    try {
      storage = createStorage(':memory:');
      storage.initialize();
      const db = storage.getDb();
      const port = await closedLoopbackPort();
      const gateway = createLlmClient(configFor(`http://127.0.0.1:${port}`, { providerId: 'gateway', platform: undefined }), createLlmUsageService(db, { primaryProvider: 'gateway' }));
      const error = await gateway.chatCompletion({ ...ask, usageContext: { workload: 'background' } }).catch(e => e);
      expect(error.message).toBe('fetch failed (ECONNREFUSED)');
      // The ledger names the class of the original failure (unchanged by the longer message).
      expect(db.prepare("SELECT status, error_class FROM llm_usage_attempts WHERE attempt_reason = 'initial'").all())
        .toEqual([{ status: 'failed', error_class: 'TypeError' }]);
      gateway.close();
    } finally {
      storage?.close();
    }
  });

  it.skipIf(!canMakeSelfSignedCert())('says in words that a proxy or security product replaced the certificate (a real self-signed loopback server)', async () => {
    const tls = await startSelfSignedServer();
    try {
      const client = createLlmClient(configFor(tls.url));
      const error = await client.chatCompletion(ask).catch(e => e);
      expect(error.message).toBe(`fetch failed (DEPTH_ZERO_SELF_SIGNED_CERT: a proxy or security product on this network replaces the provider's TLS certificate, and BotBoy does not trust the replacement)`);
      expect(error.cause?.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
      expect(tls.requests, 'the handshake failed, so no request was served').toEqual([]);
      client.close();
    } finally {
      await tls.close();
    }
  });

  it('leaves a timeout, an idle-stream abort and an HTTP answer exactly as they were', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    vi.stubGlobal('fetch', vi.fn(async () => { throw timeout; }));
    const client = createLlmClient(configFor('https://api.deepseek.test'));
    const error = await client.chatCompletion(ask).catch(e => e);
    expect(error).toBe(timeout);
    expect(error.message).toBe('The operation was aborted due to timeout');

    const idle = new Error('LLM stream aborted: no data received for 120000ms');
    vi.stubGlobal('fetch', vi.fn(async () => { throw idle; }));
    expect((await client.chatCompletionStream(ask).next().catch(e => e)).message).toBe('LLM stream aborted: no data received for 120000ms');

    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => (init?.method === 'POST' ? new Response('{"error":{"message":"bad"}}', { status: 400 }) : new Response('{}'))));
    expect((await client.chatCompletion(ask).catch(e => e)).message).toBe('HTTP 400: {"error":{"message":"bad"}}');
    client.close();
  });
});
