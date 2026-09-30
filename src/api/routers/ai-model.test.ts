import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiModelSettingsError, type AiModelSettingsService, type AiModelStatus } from '../../core/ai-model-settings.js';
import { createAiModelRouter } from './ai-model.js';

/**
 * Settings → AI model API: status is readable locally; saving or removing a
 * key requires the rendered same-origin owner page; no response ever carries
 * the key or unexpected error text.
 */
const STATUS: AiModelStatus = {
  state: 'ready',
  source: 'settings',
  provider: 'openai',
  providerLabel: 'OpenAI (your API key)',
  backgroundModel: 'GPT-5.6 Terra',
  healthy: true,
  models: [{ key: 'terra', label: 'GPT-5.6 Terra' }],
  openai: { keySuffix: '…abcd', savedAt: '2026-09-30T00:00:00.000Z', verifiedAt: '2026-09-30T00:00:00.000Z' },
  configVersion: 2,
};

function fakeService(overrides: Partial<AiModelSettingsService> = {}): AiModelSettingsService {
  return {
    client: {} as AiModelSettingsService['client'],
    status: vi.fn(() => STATUS),
    state: vi.fn(() => 'ready' as const),
    version: vi.fn(() => 2),
    saveOpenAiKey: vi.fn(async () => STATUS),
    removeOpenAiKey: vi.fn(async () => ({ ...STATUS, source: 'environment' as const, openai: undefined })),
    ...overrides,
  };
}

describe('AI model settings router', () => {
  let server: http.Server;
  let origin: string;
  let settings: AiModelSettingsService;

  function listen(service: AiModelSettingsService | undefined): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use('/api', createAiModelRouter({ nodeManager: {} as any, ...(service ? { aiModelSettings: service } : {}) }));
    server = http.createServer(app);
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    }));
  }

  beforeEach(async () => {
    settings = fakeService();
    await listen(settings);
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  const ownerPut = (body: unknown) => request(server)
    .put('/api/settings/ai-model/openai')
    .set('Origin', origin)
    .set('Sec-Fetch-Site', 'same-origin')
    .send(body as object);

  it('serves status without caching and without the key', async () => {
    const response = await request(server).get('/api/settings/ai-model');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ provider: 'openai', openai: { keySuffix: '…abcd' } });
  });

  it('saves a key only from the same-origin owner page', async () => {
    const noOrigin = await request(server).put('/api/settings/ai-model/openai').send({ apiKey: 'sk-proj-x' });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body).toMatchObject({ code: 'owner_action_required', nextAction: expect.stringContaining('Settings → AI model') });

    const crossSite = await request(server).put('/api/settings/ai-model/openai')
      .set('Origin', origin).set('Sec-Fetch-Site', 'cross-site').send({ apiKey: 'sk-proj-x' });
    expect(crossSite.status).toBe(403);

    const foreignOrigin = await request(server).put('/api/settings/ai-model/openai')
      .set('Origin', 'https://evil.example').set('Sec-Fetch-Site', 'same-origin').send({ apiKey: 'sk-proj-x' });
    expect(foreignOrigin.status).toBe(403);
    expect(settings.saveOpenAiKey).not.toHaveBeenCalled();

    const saved = await ownerPut({ apiKey: 'sk-proj-ownerkey' });
    expect(saved.status).toBe(200);
    expect(saved.headers['cache-control']).toBe('no-store');
    expect(settings.saveOpenAiKey).toHaveBeenCalledWith('sk-proj-ownerkey');
  });

  it('accepts only the key field', async () => {
    const response = await ownerPut({ apiKey: 'sk-proj-ownerkey', endpoint: 'https://attacker.example/v1' });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_request');
    expect(settings.saveOpenAiKey).not.toHaveBeenCalled();
  });

  it('returns structured owner-facing failures', async () => {
    settings.saveOpenAiKey = vi.fn(async () => {
      throw new AiModelSettingsError('invalid_key', 'OpenAI rejected this API key.', 'Copy a current key and try again.');
    });
    const response = await ownerPut({ apiKey: 'sk-proj-wrong' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'OpenAI rejected this API key.',
      code: 'invalid_key',
      nextAction: 'Copy a current key and try again.',
    });
  });

  it('never echoes unexpected error text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    settings.saveOpenAiKey = vi.fn(async () => { throw new Error('boom sk-proj-leakedsecret'); });
    const response = await ownerPut({ apiKey: 'sk-proj-anything' });
    expect(response.status).toBe(500);
    expect(response.body.code).toBe('internal_error');
    expect(JSON.stringify(response.body)).not.toContain('leakedsecret');
  });

  it('removes the key only from the owner page', async () => {
    const blocked = await request(server).delete('/api/settings/ai-model/openai');
    expect(blocked.status).toBe(403);
    expect(settings.removeOpenAiKey).not.toHaveBeenCalled();
    const removed = await request(server).delete('/api/settings/ai-model/openai')
      .set('Origin', origin).set('Sec-Fetch-Site', 'same-origin');
    expect(removed.status).toBe(200);
    expect(removed.body.source).toBe('environment');
  });

  it('answers 503 when the settings service is absent', async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await listen(undefined);
    expect((await request(server).get('/api/settings/ai-model')).status).toBe(503);
  });
});
