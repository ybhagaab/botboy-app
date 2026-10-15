/**
 * The test override `BOTBOY_KNOWLEDGE_ROOT` never changes a stored database (P1 review N6 / D2, knowledge-library.md K3 and
 * K11), and a prompt's headroom is shared by every file loaded in one assistant message (D5, K8/K9). Synthetic content
 * only; a fresh HOME and root per test, the root name holds a space.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANALYTICS_CONTEXT_DIR_KEY, analyticsLibraryMode } from './analytics-context.js';
import { registerCaptureExcludedRoots } from './capture-exclusions.js';
import { withKnowledgeChatTools } from './knowledge-chat-tools.js';
import { writeTree } from './knowledge-fixtures.testutil.js';
import { createKnowledgeLibrary, wholeFileTokenLimit, type KnowledgeLibrary } from './knowledge-library.js';
import { createKnowledgeMigration, type KnowledgeMigration } from './knowledge-migration.js';
import {
  KNOWLEDGE_ROOT_ENV,
  effectiveAnalyticsDir,
  emptyKnowledgeState,
  knowledgeDenyRoots,
  knowledgeExcludedRoots,
  readKnowledgeState,
  writeKnowledgeState,
} from './knowledge-root.js';
import type { ToolCall } from './llm-client.js';
import { registerWriteProtectedRoots } from './protected-local-resources.js';
import { createStorage, getSetting, setSetting, type StorageLayer } from './storage.js';
import type { ToolExecutionContext, ToolExecutor } from './tool-executor.js';

let storage: StorageLayer;
let base: string;
let home: string;
let root: string;
let legacy: string;
let library: KnowledgeLibrary;
let migration: KnowledgeMigration;
const db = () => storage.getDb();
const call = (name: string, args: Record<string, unknown> = {}, id = `${name}-1`): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const stored = () => JSON.stringify(readKnowledgeState(db()));

beforeEach(() => {
  storage = createStorage(':memory:');
  storage.initialize();
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-envmode-')));
  home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  vi.stubEnv('HOME', home);
  root = path.join(base, 'Docs', 'BotBoy Knowledge');
  legacy = path.join(home, '.personal-productivity-tracker', 'analytics-context');
  registerWriteProtectedRoots(() => knowledgeDenyRoots(db()));
  registerCaptureExcludedRoots(() => knowledgeExcludedRoots(db()));
  library = createKnowledgeLibrary({ db: db() });
  migration = createKnowledgeMigration({ db: db(), library, logFile: path.join(base, 'migration.log') });
});
afterEach(() => {
  registerWriteProtectedRoots(null);
  registerCaptureExcludedRoots(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  storage.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('D2: the environment override decides the mode in memory and leaves the stored state alone', () => {
  it('a fresh install with no legacy content is in library mode for the process, and nothing is stored', async () => {
    const before = stored();
    expect(before).toBe(JSON.stringify(emptyKnowledgeState()));
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, root);
    const status = await library.status();
    expect(status).toMatchObject({ state: 'ready', activated: true, pinnedByEnvironment: true, analyticsDir: 'library' });
    expect(analyticsLibraryMode(db())).toBe(true);
    await library.listSets();
    await library.rescan();
    expect(stored()).toBe(before);
    expect(fs.existsSync(path.join(root, 'analytics', 'presets'))).toBe(true);

    // The override goes away: the stored (legacy) mode applies again, the in-memory answer does not outlive it.
    vi.unstubAllEnvs();
    vi.stubEnv('HOME', home);
    expect(analyticsLibraryMode(db())).toBe(false);
    expect(effectiveAnalyticsDir(db())).toBe('legacy');
    expect(stored()).toBe(before);
  });

  it('a second override root does not inherit the first one\'s mode', async () => {
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, root);
    await library.status();
    expect(analyticsLibraryMode(db())).toBe(true);
    // A different root, not yet activated: the memo belongs to the first one.
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, path.join(base, 'Docs', 'Another Knowledge'));
    expect(analyticsLibraryMode(db())).toBe(false);
  });

  it('an install with legacy analytics content stays in legacy mode under the override, and its stored state is untouched', async () => {
    writeTree(legacy, { 'notes.md': '# Notes\n', 'presets/shopwave.md': '# Shopwave\n' });
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root: null, analyticsDir: 'legacy' });
    const before = stored();
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, root);
    const status = await library.status();
    expect(status).toMatchObject({ state: 'ready', analyticsDir: 'legacy', legacyAnalytics: { files: 2 } });
    expect(stored()).toBe(before);
    expect(fs.existsSync(path.join(root, 'analytics'))).toBe(false);
  });

  it('a stored library-mode install keeps library mode under the override', async () => {
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root: path.join(base, 'Elsewhere', 'BotBoy Knowledge'), analyticsDir: 'library' });
    const before = stored();
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, root);
    expect((await library.status()).analyticsDir).toBe('library');
    expect(stored()).toBe(before);
  });
});

describe('D2: Move and Revert are refused while the override pins the location; Preview still works', () => {
  beforeEach(() => {
    writeTree(legacy, { 'notes.md': '# Notes\n', 'presets/shopwave.md': '# Shopwave\n' });
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root: null, analyticsDir: 'legacy' });
    setSetting(db(), ANALYTICS_CONTEXT_DIR_KEY, legacy);
  });

  it('Move answers root_pinned_by_environment with a next action and stores nothing', async () => {
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, root);
    await library.status();
    const plan = await migration.plan();
    expect(plan.ok).toBe(true);
    const before = stored();
    const explicit = getSetting<string>(db(), ANALYTICS_CONTEXT_DIR_KEY);
    const result = await migration.apply({ confirm: plan.planSha256 });
    expect(result).toMatchObject({ ok: false, code: 'root_pinned_by_environment', nextAction: expect.stringContaining('Unset BOTBOY_KNOWLEDGE_ROOT') });
    expect(stored()).toBe(before);
    expect(getSetting<string>(db(), ANALYTICS_CONTEXT_DIR_KEY)).toBe(explicit);
    expect(fs.existsSync(path.join(root, 'analytics', 'notes.md'))).toBe(false);
  });

  it('Revert answers root_pinned_by_environment even for a stored migration', async () => {
    writeKnowledgeState(db(), {
      ...emptyKnowledgeState(), root: path.join(base, 'Elsewhere', 'BotBoy Knowledge'), analyticsDir: 'library',
      migration: { at: '2026-10-15T00:00:00.000Z', source: legacy, files: 2, planSha256: 'a'.repeat(64), previousDir: legacy },
    });
    const before = stored();
    vi.stubEnv(KNOWLEDGE_ROOT_ENV, root);
    const result = await migration.revert();
    expect(result).toMatchObject({ ok: false, code: 'root_pinned_by_environment' });
    expect(stored()).toBe(before);
  });

  it('without the override the same Move works (the guard is the pin, not the install)', async () => {
    await library.activate(root);
    const plan = await migration.plan();
    expect(plan.ok).toBe(true);
    const applied = await migration.apply({ confirm: plan.planSha256 });
    expect(applied).toMatchObject({ ok: true });
    expect(readKnowledgeState(db()).analyticsDir).toBe('library');
  });
});

describe('D5: two knowledge_load calls in one assistant message share the prompt headroom', () => {
  const body = (label: string, lines: number) => `# ${label}\n\n${Array.from({ length: lines }, (_, index) => `Line ${index} of ${label}: a synthetic fact about orders and baskets.`).join('\n')}\n`;
  let tools: ToolExecutor;
  const stub: ToolExecutor = { async executeTool(toolCall) { return { toolCallId: toolCall.id, content: `base:${toolCall.function.name}` }; } };

  beforeEach(async () => {
    writeTree(root, {
      'GUIDE.md': '# Root\n',
      'notes/GUIDE.md': '# Notes\n\nPersonal notes.\n\n## File Ecosystem\n\n| File | Purpose |\n|---|---|\n| `one.md` | First |\n| `two.md` | Second |\n',
      'notes/one.md': body('One', 400),
      'notes/two.md': body('Two', 400),
    });
    writeKnowledgeState(db(), { ...emptyKnowledgeState(), root, analyticsDir: 'library' });
    library = createKnowledgeLibrary({ db: db() });
    tools = withKnowledgeChatTools(stub, { library });
  });

  /** The estimated tokens of one of the two files, and a headroom that holds one of them but not both. */
  async function sizes() {
    const loaded = await library.load({ set: 'notes', file: 'one.md' }, {});
    if (!loaded.ok) throw new Error('setup load failed');
    const each = loaded.receipt.estimatedTokens;
    // Headroom limit = headroom - 4,000: fit one file, not two.
    return { each, headroom: 4_000 + each + Math.floor(each / 2) };
  }

  it('sequential: the second load that no longer fits returns the outline error and does not load', async () => {
    const { each, headroom } = await sizes();
    expect(wholeFileTokenLimit({ promptHeadroomTokens: headroom })).toBeGreaterThanOrEqual(each);
    const context: ToolExecutionContext = { currentUserMessage: 'read both', callerKind: 'interactive', promptHeadroomTokens: headroom };
    const first = await tools.executeTool(call('knowledge_load', { set: 'notes', file: 'one.md' }, 'a'), context);
    expect(first.isError).toBeFalsy();
    expect(context.promptHeadroomTokens).toBeLessThan(headroom);
    expect(context.promptHeadroomTokens).toBeLessThanOrEqual(headroom - each);
    const second = await tools.executeTool(call('knowledge_load', { set: 'notes', file: 'two.md' }, 'b'), context);
    expect(second.isError).toBe(true);
    expect(JSON.parse(second.content)).toMatchObject({ code: 'file_too_large_for_context', effect: 'none', outline: expect.anything() });
  });

  it('parallel: both calls start at once, yet the second still sees what the first took', async () => {
    const { headroom } = await sizes();
    const context: ToolExecutionContext = { currentUserMessage: 'read both', callerKind: 'interactive', promptHeadroomTokens: headroom };
    const [first, second] = await Promise.all([
      tools.executeTool(call('knowledge_load', { set: 'notes', file: 'one.md' }, 'a'), context),
      tools.executeTool(call('knowledge_load', { set: 'notes', file: 'two.md' }, 'b'), context),
    ]);
    expect(first.isError).toBeFalsy();
    expect(JSON.parse(second.content)).toMatchObject({ code: 'file_too_large_for_context' });
  });

  it('a load that fits alone is not blocked when the headroom is generous, and a refusal takes nothing', async () => {
    const { each, headroom } = await sizes();
    const roomy: ToolExecutionContext = { currentUserMessage: 'x', callerKind: 'interactive', promptHeadroomTokens: 4_000 + each * 3 };
    expect((await tools.executeTool(call('knowledge_load', { set: 'notes', file: 'one.md' }, 'a'), roomy)).isError).toBeFalsy();
    expect((await tools.executeTool(call('knowledge_load', { set: 'notes', file: 'two.md' }, 'b'), roomy)).isError).toBeFalsy();
    const tight: ToolExecutionContext = { currentUserMessage: 'x', callerKind: 'interactive', promptHeadroomTokens: headroom };
    await tools.executeTool(call('knowledge_load', { set: 'notes', file: 'one.md' }, 'a'), tight);
    const afterFirst = tight.promptHeadroomTokens;
    const refused = await tools.executeTool(call('knowledge_load', { set: 'notes', file: 'two.md' }, 'b'), tight);
    expect(refused.isError).toBe(true);
    expect(tight.promptHeadroomTokens).toBe(afterFirst);
  });

  it('without a headroom value (no chat loop) nothing is subtracted and nothing breaks', async () => {
    const context: ToolExecutionContext = { currentUserMessage: 'x', callerKind: 'interactive' };
    expect((await tools.executeTool(call('knowledge_load', { set: 'notes', file: 'one.md' }, 'a'), context)).isError).toBeFalsy();
    expect(context.promptHeadroomTokens).toBeUndefined();
  });
});
