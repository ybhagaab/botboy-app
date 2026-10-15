/**
 * ETL onboarding when the analytics knowledge lives in the Knowledge library (knowledge-library.md K10; design
 * amendment P2-13b, brief 4.8 "work files stay in private state"). Fake Datanet and LLM, synthetic businesses.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EtlToolCall } from './etl-adhoc.js';
import { createEtlOnboardingService, type EtlOnboardingService } from './etl-onboarding.js';
import { emptyKnowledgeState, writeKnowledgeState } from './knowledge-root.js';
import { createStorage, type StorageLayer } from './storage.js';

const SQL = "SELECT * FROM andes.shop.orders WHERE event = 'order_placed' AND day = {RUN_DATE_YYYYMMDD};";
const doc = (id: string, description: string) => ({ profile_id: id, job_id: `9${id}`, job_group_name: 'MY-GROUP', job_description: description, job_schedule_type: 'DAILY' });

const call: EtlToolCall = async (tool, args) => {
  if (tool === 'datanet_search') {
    const docs = [doc('1', 'Shopwave daily orders rollup'), doc('2', 'Shopwave weekly customers')];
    const start = Number(args.start ?? 0);
    const size = Number(args.size ?? 25);
    return { isError: false, text: JSON.stringify({ found: docs.length, searchResults: docs.slice(start, start + size).map((document) => ({ document })) }) };
  }
  if (tool === 'datanet_get_profile_sql') return { isError: false, text: SQL };
  return { isError: true, text: `unexpected tool ${tool}` };
};
const llm = {
  chatCompletion: async (request: any) => {
    const input = JSON.parse(request.messages[1].content);
    if (request.responseFormat?.type === 'json_object') {
      return { content: JSON.stringify({ assignments: input.profiles.map((p: { id: string }) => ({ id: p.id, business: 'shopwave' })) }) };
    }
    return { content: `# ${input.business} — Datanet ETL SQL Context\n\n## Tables that matter\n(stub brief)` };
  },
};

let storage: StorageLayer;
let base: string;
let root: string;
let home: string;
const db = () => storage.getDb();

async function untilDone(service: EtlOnboardingService) {
  const started = Date.now();
  while (service.getStatus().state === 'running') {
    if (Date.now() - started > 8_000) throw new Error('onboarding did not finish in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return service.getStatus();
}
const makeService = () => createEtlOnboardingService({
  db: db(), call, llm: llm as any, pageSize: 5, fetchDelayMs: 0, classifyBatchSize: 10, minClusterSize: 2, sqlSampleChars: 500, synthesisMaxTokens: 200,
});

beforeEach(() => {
  storage = createStorage(':memory:');
  storage.initialize();
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-onboard-')));
  root = path.join(base, 'BotBoy Knowledge');
  // A fresh HOME per test, so the default private analytics folder starts empty and is never shared between runs.
  home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  vi.stubEnv('HOME', home);
  fs.mkdirSync(path.join(root, 'analytics'), { recursive: true });
  writeKnowledgeState(db(), { ...emptyKnowledgeState(), root, analyticsDir: 'library' });
});

afterEach(() => {
  vi.unstubAllEnvs();
  storage.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('ETL onboarding in library mode', () => {
  it('writes presets and the manifest into the library and keeps its work files in private state', async () => {
    const service = makeService();
    service.start({ group: 'MY-GROUP' });
    const status = await untilDone(service);
    expect(status.state).toBe('completed');
    expect(status.lastResult?.presetsWritten).toBe(1);
    expect(fs.existsSync(path.join(root, 'analytics', 'presets', 'shopwave.md'))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'analytics', 'manifest.json'), 'utf8'));
    expect(manifest.files[0]).toMatchObject({ file: 'presets/shopwave.md', source: 'etl-derived', business: 'shopwave' });
    // The visible library holds no work files.
    const names = fs.readdirSync(path.join(root, 'analytics'));
    expect(names.filter((name) => name.startsWith('.'))).toEqual([]);
    expect(fs.existsSync(path.join(root, '.onboarding'))).toBe(false);
    // They sit in BotBoy's private folder, as before.
    expect(fs.existsSync(path.join(home, '.personal-productivity-tracker', 'analytics-context', '.onboarding', 'estate.json'))).toBe(true);
  });

  it('fails through its failed state, naming the fix, when the library root is missing, and never recreates it', async () => {
    fs.rmSync(root, { recursive: true, force: true });
    const service = makeService();
    service.start({ group: 'MY-GROUP' });
    const status = await untilDone(service);
    expect(status.state).toBe('failed');
    expect(status.error).toMatch(/Knowledge folder .* is missing/);
    expect(status.error).toMatch(/Settings → Knowledge/);
    expect(fs.existsSync(root)).toBe(false);
  });
});
