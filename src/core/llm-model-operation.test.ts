import { describe, expect, it } from 'vitest';
import { analyticsHandlingAllowsModelContext, type AnalyticsModelContextRuntime } from './analytics-data-room-policy.js';
import { analyticsImportProviderReceipt } from './analytics-import-semantic-proposal.js';
import { currentLlmModelOperation, runInLlmModelOperation, type LlmModelOperation, type LlmProviderDescriptor } from './llm-model-operation.js';

/**
 * Per-operation data locality: the model operation active in an async
 * context decides where tool results go, so the Data Room policy is judged
 * per chat turn or agent loop, falling back to the organizing model.
 */
function operation(connectionId: string, provider: LlmProviderDescriptor): LlmModelOperation {
  return {
    connectionId,
    modelKey: `${connectionId}.${provider.model}`,
    label: provider.model,
    provider,
    capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    client: {} as LlmModelOperation['client'],
  };
}

const TEAM: LlmProviderDescriptor = {
  id: 'gateway',
  endpoint: 'https://botboy.gateway.bedrock-agentcore.us-east-1.amazonaws.com/inference/v1',
  model: 'bedrock-mantle-luna/openai.gpt-5.6-terra',
  apiMode: 'responses',
};
const DEEPSEEK: LlmProviderDescriptor = { id: 'deepseek', endpoint: 'https://api.deepseek.com', model: 'deepseek-flash', apiMode: 'responses' };
const OPENAI: LlmProviderDescriptor = { id: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-5.6-terra', apiMode: 'responses' };

describe('model operation context', () => {
  it('follows awaits and timers, nests, and is absent outside', async () => {
    expect(currentLlmModelOperation()).toBeUndefined();
    const seen = await runInLlmModelOperation(operation('deepseek', DEEPSEEK), async () => {
      await Promise.resolve();
      const afterAwait = currentLlmModelOperation()?.connectionId;
      const inTimer = await new Promise<string | undefined>(resolve => setTimeout(() => resolve(currentLlmModelOperation()?.connectionId), 1));
      const nested = runInLlmModelOperation(operation('team', TEAM), () => currentLlmModelOperation()?.connectionId);
      const passthrough = runInLlmModelOperation(undefined, () => currentLlmModelOperation()?.connectionId);
      return { afterAwait, inTimer, nested, passthrough };
    });
    expect(seen).toEqual({ afterAwait: 'deepseek', inTimer: 'deepseek', nested: 'team', passthrough: 'deepseek' });
    expect(currentLlmModelOperation()).toBeUndefined();
  });

  it('classifies the owner-key APIs as external and the team gateway as Amazon-managed', () => {
    expect(analyticsImportProviderReceipt(DEEPSEEK).providerLocality).toBe('external_remote');
    expect(analyticsImportProviderReceipt(OPENAI).providerLocality).toBe('external_remote');
    expect(analyticsImportProviderReceipt(TEAM).providerLocality).toBe('amazon_managed_remote');
  });

  it('judges Data Room rows by the operation that will receive them', () => {
    // Mirrors index.ts › answerProviderReceipt: operation first, else the organizing model.
    const organizing = () => TEAM;
    const runtime: AnalyticsModelContextRuntime = {
      get providerLocality() { return analyticsImportProviderReceipt(currentLlmModelOperation()?.provider ?? organizing()).providerLocality; },
      get endpointSha256() { return analyticsImportProviderReceipt(currentLlmModelOperation()?.provider ?? organizing()).endpointSha256; },
    };
    const handling = {
      classification: 'internal',
      allowModelContext: true,
      modelContextPolicy: {
        allowedProviderLocalities: ['amazon_managed_remote' as const],
        endpointSha256: analyticsImportProviderReceipt(TEAM).endpointSha256,
        disclosurePolicyVersion: 'botboy-data-room-v1',
      },
    } as any;
    expect(analyticsHandlingAllowsModelContext(handling, runtime)).toBe(true);
    expect(runInLlmModelOperation(operation('team', TEAM), () => analyticsHandlingAllowsModelContext(handling, runtime))).toBe(true);
    expect(runInLlmModelOperation(operation('deepseek', DEEPSEEK), () => analyticsHandlingAllowsModelContext(handling, runtime))).toBe(false);
    expect(runInLlmModelOperation(operation('openai', OPENAI), () => analyticsHandlingAllowsModelContext(handling, runtime))).toBe(false);
  });
});
