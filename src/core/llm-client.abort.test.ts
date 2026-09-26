import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLlmClient } from './llm-client.js';

function config() {
  return {
    ecs: { endpoint: 'http://abort.test', model: 'openai.gpt-5.6-terra', maxContextTokens: 262144, requestTimeoutMs: 300_000 },
    ollama: { endpoint: '', model: '', maxContextTokens: 0, requestTimeoutMs: 0 },
    defaults: { temperature: 0.2, maxCompletionTokens: 1024, contextBudgetTokens: 200000 },
    healthCheckIntervalMs: 3_600_000,
    streamIdleTimeoutMs: 120_000,
    fallbackEnabled: false,
  };
}

function pendingFetch(seen: AbortSignal[]) {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method !== 'POST') return { ok: true, status: 200 } as Response;
    const signal = init?.signal as AbortSignal;
    seen.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      const fail = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });
  });
}

function postCalls(fetchMock: ReturnType<typeof pendingFetch>) {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
}

afterEach(() => vi.unstubAllGlobals());

describe('LLM external cancellation', () => {
  it('aborts a batch request without serializing the signal, poisoning health, or trying fallback', async () => {
    const seenSignals: AbortSignal[] = [];
    const fetchMock = pendingFetch(seenSignals);
    vi.stubGlobal('fetch', fetchMock);
    const client = createLlmClient(config());
    const controller = new AbortController();

    const pending = client.chatCompletion({
      messages: [{ role: 'user', content: 'synthetic shutdown wait' }],
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(postCalls(fetchMock)).toHaveLength(1));
    const body = JSON.parse(String(postCalls(fetchMock)[0][1]?.body));
    expect(body).not.toHaveProperty('signal');
    controller.abort(new Error('BotBoy shutdown'));

    await expect(pending).rejects.toThrow('BotBoy shutdown');
    expect(seenSignals[0].aborted).toBe(true);
    expect(client.getActiveEndpoint()).toBe('ecs');
    expect(postCalls(fetchMock)).toHaveLength(1);
    client.close();
  });

  it('aborts a streaming request during time-to-first-byte without marking the endpoint unhealthy', async () => {
    const seenSignals: AbortSignal[] = [];
    const fetchMock = pendingFetch(seenSignals);
    vi.stubGlobal('fetch', fetchMock);
    const client = createLlmClient(config());
    const controller = new AbortController();
    const stream = client.chatCompletionStream({
      messages: [{ role: 'user', content: 'synthetic streaming shutdown wait' }],
      signal: controller.signal,
    });

    const pending = stream.next();
    await vi.waitFor(() => expect(postCalls(fetchMock)).toHaveLength(1));
    controller.abort(new Error('BotBoy shutdown'));

    await expect(pending).rejects.toThrow('BotBoy shutdown');
    expect(seenSignals[0].aborted).toBe(true);
    expect(client.getActiveEndpoint()).toBe('ecs');
    expect(postCalls(fetchMock)).toHaveLength(1);
    client.close();
  });
});
