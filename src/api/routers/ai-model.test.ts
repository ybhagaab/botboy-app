import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiModelSettingsError, type AiModelSettingsService, type AiModelStatus } from '../../core/ai-model-settings.js';
import { createAiModelRouter } from './ai-model.js';

/**
 * Settings → AI model API: status is readable locally; saving or removing a
 * key and changing a background model require the rendered same-origin owner
 * page; no response ever carries a key or unexpected error text.
 */
const ROLE = {
  modelKey: 'team.terra', label: 'GPT-5.6 Terra', connectionId: 'team' as const,
  connectionLabel: 'Team gateway', thinking: 'off' as const, chosen: false, images: true,
};
const STATUS: AiModelStatus = {
  state: 'ready',
  configVersion: 2,
  connections: [
    { id: 'team', label: 'Team gateway (Amazon Bedrock)', source: 'environment', healthy: true, models: [{ key: 'team.terra', label: 'GPT-5.6 Terra', images: true, contextWindow: 1_000_000 }] },
    { id: 'openai', label: 'OpenAI', source: 'settings', healthy: true, keySuffix: '…abcd', savedAt: '2026-09-30T00:00:00.000Z', verifiedAt: '2026-09-30T00:00:00.000Z', models: [] },
  ],
  roles: { processing: ROLE, documents: ROLE },
  source: 'environment',
  provider: 'gateway',
  providerLabel: 'Team gateway (Amazon Bedrock)',
  backgroundModel: 'GPT-5.6 Terra',
  healthy: true,
  models: [{ key: 'team.terra', label: 'GPT-5.6 Terra' }],
  openai: { keySuffix: '…abcd', savedAt: '2026-09-30T00:00:00.000Z', verifiedAt: '2026-09-30T00:00:00.000Z' },
};

function fakeService(overrides: Partial<AiModelSettingsService> = {}): AiModelSettingsService {
  return {
    client: {} as AiModelSettingsService['client'],
    processing: {} as AiModelSettingsService['processing'],
    documents: {} as AiModelSettingsService['documents'],
    chatModels: {} as AiModelSettingsService['chatModels'],
    status: vi.fn(() => STATUS),
    state: vi.fn(() => 'ready' as const),
    version: vi.fn(() => 2),
    saveApiKey: vi.fn(async () => STATUS),
    removeApiKey: vi.fn(async () => ({ ...STATUS, openai: undefined })),
    setRole: vi.fn(async () => STATUS),
    saveOpenAiKey: vi.fn(async () => STATUS),
    removeOpenAiKey: vi.fn(async () => STATUS),
    close: vi.fn(),
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

  const owner = (call: request.Test) => call.set('Origin', origin).set('Sec-Fetch-Site', 'same-origin');
  const ownerPut = (path: string, body: unknown) => owner(request(server).put(path)).send(body as object);

  it('serves status without caching and without a key', async () => {
    const response = await request(server).get('/api/settings/ai-model');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ openai: { keySuffix: '…abcd' }, roles: { processing: { modelKey: 'team.terra' } } });
  });

  it('saves OpenAI and DeepSeek keys only from the same-origin owner page', async () => {
    for (const provider of ['openai', 'deepseek']) {
      const noOrigin = await request(server).put(`/api/settings/ai-model/${provider}`).send({ apiKey: 'sk-proj-x' });
      expect(noOrigin.status).toBe(403);
      expect(noOrigin.body).toMatchObject({ code: 'owner_action_required', nextAction: expect.stringContaining('Settings → AI model') });
      const crossSite = await request(server).put(`/api/settings/ai-model/${provider}`)
        .set('Origin', origin).set('Sec-Fetch-Site', 'cross-site').send({ apiKey: 'sk-proj-x' });
      expect(crossSite.status).toBe(403);
      const foreignOrigin = await request(server).put(`/api/settings/ai-model/${provider}`)
        .set('Origin', 'https://evil.example').set('Sec-Fetch-Site', 'same-origin').send({ apiKey: 'sk-proj-x' });
      expect(foreignOrigin.status).toBe(403);
    }
    expect(settings.saveApiKey).not.toHaveBeenCalled();

    const saved = await ownerPut('/api/settings/ai-model/openai', { apiKey: 'sk-proj-ownerkey' });
    expect(saved.status).toBe(200);
    expect(saved.headers['cache-control']).toBe('no-store');
    expect(settings.saveApiKey).toHaveBeenCalledWith('openai', 'sk-proj-ownerkey');
    const deepseek = await ownerPut('/api/settings/ai-model/deepseek', { apiKey: 'sk-deepseekownerkey' });
    expect(deepseek.status).toBe(200);
    expect(settings.saveApiKey).toHaveBeenCalledWith('deepseek', 'sk-deepseekownerkey');
    expect((await ownerPut('/api/settings/ai-model/anthropic', { apiKey: 'sk-x' })).status).toBe(404);
  });

  it('accepts only the key field', async () => {
    const response = await ownerPut('/api/settings/ai-model/deepseek', { apiKey: 'sk-proj-ownerkey', endpoint: 'https://attacker.example/v1' });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_request');
    expect(settings.saveApiKey).not.toHaveBeenCalled();
  });

  it('returns structured owner-facing failures', async () => {
    settings.saveApiKey = vi.fn(async () => {
      throw new AiModelSettingsError('invalid_key', 'DeepSeek rejected this API key.', 'Copy a current key and try again.');
    });
    const response = await ownerPut('/api/settings/ai-model/deepseek', { apiKey: 'sk-proj-wrong' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'DeepSeek rejected this API key.',
      code: 'invalid_key',
      nextAction: 'Copy a current key and try again.',
    });
  });

  it('never echoes unexpected error text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    settings.saveApiKey = vi.fn(async () => { throw new Error('boom sk-proj-leakedsecret'); });
    const response = await ownerPut('/api/settings/ai-model/openai', { apiKey: 'sk-proj-anything' });
    expect(response.status).toBe(500);
    expect(response.body.code).toBe('internal_error');
    expect(JSON.stringify(response.body)).not.toContain('leakedsecret');
  });

  it('removes a key only from the owner page', async () => {
    const blocked = await request(server).delete('/api/settings/ai-model/deepseek');
    expect(blocked.status).toBe(403);
    expect(settings.removeApiKey).not.toHaveBeenCalled();
    const removed = await owner(request(server).delete('/api/settings/ai-model/deepseek'));
    expect(removed.status).toBe(200);
    expect(settings.removeApiKey).toHaveBeenCalledWith('deepseek');
  });

  it('changes a background model or Thinking level only from the owner page, with only those fields', async () => {
    const blocked = await request(server).put('/api/settings/ai-model/roles/processing').send({ modelKey: 'openai.gpt-4o' });
    expect(blocked.status).toBe(403);
    const extra = await ownerPut('/api/settings/ai-model/roles/processing', { modelKey: 'openai.gpt-4o', endpoint: 'https://x.example' });
    expect(extra.status).toBe(400);
    const empty = await ownerPut('/api/settings/ai-model/roles/processing', {});
    expect(empty.status).toBe(400);
    expect(settings.setRole).not.toHaveBeenCalled();

    const changed = await ownerPut('/api/settings/ai-model/roles/documents', { modelKey: null, thinking: 'high' });
    expect(changed.status).toBe(200);
    expect(changed.headers['cache-control']).toBe('no-store');
    expect(settings.setRole).toHaveBeenCalledWith('documents', { modelKey: null, thinking: 'high' });

    settings.setRole = vi.fn(async () => {
      throw new AiModelSettingsError('model_unavailable', 'That model is not offered by a connected provider right now.', 'Pick a model from the list in Settings → AI model.');
    });
    const unavailable = await ownerPut('/api/settings/ai-model/roles/processing', { modelKey: 'openai.gone' });
    expect(unavailable.status).toBe(400);
    expect(unavailable.body.code).toBe('model_unavailable');
  });

  it('answers 503 when the settings service is absent', async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await listen(undefined);
    expect((await request(server).get('/api/settings/ai-model')).status).toBe(503);
  });
});
