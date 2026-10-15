/**
 * The briefing's "no knowledge" text and the Knowledge library (knowledge-library.md K10). With no library, or a library
 * that says nothing, the text is exactly what it always was; a blocked folder and an analytics-sets pointer are added
 * after it, never instead of it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnalyticsSchemaBriefingLoader } from './analytics-chat-context.js';
import { ANALYTICS_CONTEXT_DIR_KEY } from './analytics-context.js';
import { emptyKnowledgeState, writeKnowledgeState } from './knowledge-root.js';
import { createStorage, setSetting, type StorageLayer } from './storage.js';

let storage: StorageLayer;
let base: string;
const db = () => storage.getDb();

/** The sentence the loader has always produced when no source has any knowledge (amazonEmployee not false). */
const BASE_TEXT = ' No business/schema knowledge is available from any source. Configure a schema knowledge source at #/connections/sql-context, or add knowledge files to the analytics knowledge directory (a2-analytics connection card — ETL onboarding can generate business presets).';

beforeEach(() => {
  storage = createStorage(':memory:');
  storage.initialize();
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-brief-')));
});
afterEach(() => {
  vi.restoreAllMocks();
  storage.close();
  fs.rmSync(base, { recursive: true, force: true });
});

const load = async (options: Parameters<typeof createAnalyticsSchemaBriefingLoader>[1]) => {
  const briefing = await createAnalyticsSchemaBriefingLoader(undefined, options).load('how many orders per day', { amazonEmployee: true });
  return briefing;
};

describe('the empty-catalog text', () => {
  it('is byte-identical in legacy mode with and without the new option', async () => {
    setSetting(db(), ANALYTICS_CONTEXT_DIR_KEY, path.join(base, 'legacy'));
    const plain = await load({ db: db() });
    const withNullHint = await load({ db: db(), knowledgeHint: () => null });
    const withEmptyHint = await load({ db: db(), knowledgeHint: () => '' });
    const throwingHint = await load({ db: db(), knowledgeHint: () => { throw new Error('boom'); } });
    expect(plain.selectionStatus).toBe('unavailable');
    expect(plain.text).toContain(BASE_TEXT);
    expect(plain.text.endsWith(BASE_TEXT)).toBe(true);
    for (const other of [withNullHint, withEmptyHint, throwingHint]) expect(other.text).toBe(plain.text);
  });

  it('adds the library pointer after the base text, only when the library reports analytics sets', async () => {
    setSetting(db(), ANALYTICS_CONTEXT_DIR_KEY, path.join(base, 'legacy'));
    const hinted = await load({ db: db(), knowledgeHint: () => 'Your Knowledge library has analytics sets: use knowledge_list and knowledge_load.' });
    expect(hinted.text.endsWith(`${BASE_TEXT} Your Knowledge library has analytics sets: use knowledge_list and knowledge_load.`)).toBe(true);
  });

  it('names a Knowledge folder that macOS blocks instead of looking empty', async () => {
    const root = path.join(base, 'BotBoy Knowledge');
    fs.mkdirSync(path.join(root, 'analytics'), { recursive: true });
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root, analyticsDir: 'library' });
    const real = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target) === path.join(root, 'analytics')) throw Object.assign(new Error('nope'), { code: 'EPERM' });
      return (real as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.readdirSync);
    const blocked = await load({ db: db() });
    expect(blocked.text).toContain(BASE_TEXT);
    expect(blocked.text).toContain('The Knowledge folder is blocked: macOS did not let BotBoy read');
    expect(blocked.text).toMatch(/Files and Folders/);
  });
});
