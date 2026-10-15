/**
 * Text that reaches a model WITHOUT an explicit load is scanned for secret formats (P1 review N2; knowledge-library.md K7,
 * K8): a file's first line, a guide's purposes, descriptions and summaries. A hit shows the file by name only and an issue
 * names the kind, never the value; a guide that holds a credential is unusable, like an oversize one. The load of such a
 * file is still refused (`file_has_secret`). The credentials are assembled at run time; nothing secret-shaped is a literal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCaptureExcludedRoots } from './capture-exclusions.js';
import { withKnowledgeChatTools } from './knowledge-chat-tools.js';
import { SHOP_GUIDE, fakePrivateKeyBlock, sampleLibraryFiles, writeTree } from './knowledge-fixtures.testutil.js';
import { buildPreviewFence, parseGuide, secretFree } from './knowledge-guide.js';
import { createKnowledgeLibrary, type KnowledgeLibrary } from './knowledge-library.js';
import { canonicalRootOrNull, emptyKnowledgeState, knowledgeExcludedRoots, writeKnowledgeState } from './knowledge-root.js';
import type { ToolCall } from './llm-client.js';
import { registerWriteProtectedRoots } from './protected-local-resources.js';
import { detectSecrets } from './sensitive-files.js';
import { createStorage, type StorageLayer } from './storage.js';
import type { ToolExecutor } from './tool-executor.js';

let storage: StorageLayer;
let base: string;
let root: string;
let clock: number;
let library: KnowledgeLibrary;
const db = () => storage.getDb();
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: `${name}-1`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
/** A GitHub-style token, built from pieces so no secret-shaped literal sits in the repository. */
const fakeToken = () => ['ghp', '_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');
const stub: ToolExecutor = { async executeTool(toolCall) { return { toolCallId: toolCall.id, content: `base:${toolCall.function.name}` }; } };

function setup(files: Record<string, string>) {
  writeTree(root, { ...sampleLibraryFiles(), ...files });
  writeKnowledgeState(db(), { ...emptyKnowledgeState(), root, analyticsDir: 'library' });
  library = createKnowledgeLibrary({ db: db(), now: () => clock });
}
beforeEach(() => {
  storage = createStorage(':memory:');
  storage.initialize();
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-secprev-')));
  fs.mkdirSync(path.join(base, 'home'), { recursive: true });
  vi.stubEnv('HOME', path.join(base, 'home'));
  root = path.join(base, 'BotBoy Knowledge');
  clock = 1_800_000_000_000;
  registerWriteProtectedRoots(() => canonicalRootOrNull(db()));
  registerCaptureExcludedRoots(() => knowledgeExcludedRoots(db()));
});
afterEach(() => {
  registerWriteProtectedRoots(null);
  registerCaptureExcludedRoots(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  storage.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('the fixtures are credentials the scanner really recognizes', () => {
  it('the key block and the token are detected, ordinary prose is not', () => {
    expect(detectSecrets(fakePrivateKeyBlock())).toEqual(['private_key']);
    expect(detectSecrets(`token=${fakeToken()}`).length).toBeGreaterThan(0);
    expect(detectSecrets('# Plain heading\nnothing here\n')).toEqual([]);
  });
});

describe('an unlisted file that starts with a credential', () => {
  beforeEach(() => setup({
    'field-notes/deploy.txt': `${fakePrivateKeyBlock()}\n`,
    'field-notes/token.txt': `token=${fakeToken()}\nthe rest is prose\n`,
    'field-notes/readme.md': '# Field notes readme\n\nHow the notes are kept.\n',
  }));

  it('shows by name in the matched block, with no line of the credential', async () => {
    const routed = await library.routeTurn({ message: 'please look at the field-notes' });
    expect(routed?.matchedSetId).toBe('field-notes');
    const text = routed?.text ?? '';
    expect(text).toContain('- deploy.txt');
    expect(text).toContain('- token.txt');
    expect(text).toContain('- readme.md: Field notes readme');
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain('MIIEow');
    expect(text).not.toContain(fakeToken());
    expect(text).not.toContain('token=');
  });

  it('knowledge_list shows the names without the line, and the set carries an issue that names the kind and no value', async () => {
    const tools = withKnowledgeChatTools(stub, { library });
    const result = await tools.executeTool(call('knowledge_list', { set: 'field-notes' }));
    const body = JSON.parse(result.content);
    const byName = Object.fromEntries(body.files.map((file: { name: string; purpose: string }) => [file.name, file.purpose]));
    expect(byName['deploy.txt']).toBe('');
    expect(byName['token.txt']).toBe('');
    expect(byName['readme.md']).toBe('Field notes readme');
    expect(result.content).not.toContain('PRIVATE KEY');
    expect(result.content).not.toContain(fakeToken());
    const detail = await library.getSet('field-notes');
    if ('code' in detail) throw new Error('set not found');
    const issues = detail.issues.filter((issue) => issue.code === 'title_withheld');
    expect(issues.map((issue) => issue.file).sort()).toEqual(['deploy.txt', 'token.txt']);
    for (const issue of issues) {
      expect(issue.message).not.toContain(fakeToken());
      expect(issue.message).not.toContain('MIIEow');
    }
    expect(issues.some((issue) => /private key/i.test(issue.message))).toBe(true);
  });

  it('knowledge_load of the same file is still refused with file_has_secret', async () => {
    const tools = withKnowledgeChatTools(stub, { library });
    const result = await tools.executeTool(call('knowledge_load', { set: 'field-notes', file: 'deploy.txt' }));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ code: 'file_has_secret', effect: 'none' });
    const readme = await tools.executeTool(call('knowledge_load', { set: 'field-notes', file: 'readme.md' }));
    expect(readme.isError).toBeFalsy();
  });
});

describe('a guide that contains a credential is unusable', () => {
  it('parseGuide returns an empty guide with an issue that names the kind', () => {
    const parsed = parseGuide(`${SHOP_GUIDE}\n\nNote: ${fakePrivateKeyBlock()}\n`);
    expect(parsed.rows).toEqual([]);
    expect(parsed.guardrails).toEqual([]);
    expect(parsed.issues.map((issue) => issue.code)).toEqual(['guide_has_secret']);
    expect(parsed.issues[0].message).toMatch(/private key/i);
    expect(parsed.issues[0].message).not.toContain('MIIEow');
    expect(parseGuide(SHOP_GUIDE).issues.map((issue) => issue.code)).not.toContain('guide_has_secret');
  });

  it('the set is listed without a guide, its purposes and description never reach the block or the list, and an issue says why', async () => {
    setup({ 'shop-data/GUIDE.md': `${SHOP_GUIDE}\n\nPurpose note: use ${fakeToken()} for the export.\n` });
    const detail = await library.getSet('shop-data');
    if ('code' in detail) throw new Error('set not found');
    expect(detail.hasGuide).toBe(false);
    expect(detail.description).toBe('');
    expect(detail.issues.some((issue) => issue.code === 'guide_has_secret')).toBe(true);
    const routed = await library.routeTurn({ message: 'look at shop-data orders' });
    expect(routed?.text ?? '').not.toContain(fakeToken());
    const tools = withKnowledgeChatTools(stub, { library });
    const listed = await tools.executeTool(call('knowledge_list', { set: 'shop-data' }));
    expect(listed.content).not.toContain(fakeToken());
    // The files stay readable: only the guide is unusable.
    const loaded = await tools.executeTool(call('knowledge_load', { set: 'shop-data', file: 'orders.md' }));
    expect(loaded.isError).toBeFalsy();
  });
});

describe('secretFree and the preview fence, the last wall', () => {
  it('secretFree empties only text with a secret format', () => {
    expect(secretFree('Orders and baskets')).toBe('Orders and baskets');
    expect(secretFree(`use ${fakeToken()} here`)).toBe('');
    expect(secretFree('')).toBe('');
  });

  it('buildPreviewFence drops a purpose and a description that hold a secret format, keeping the file name', () => {
    const { fence } = buildPreviewFence({
      setId: 'shop-data', kind: 'generic', description: `Export with ${fakeToken()}`,
      files: [{ name: 'a.md', purpose: `key ${fakeToken()}` }, { name: 'b.md', purpose: 'Baskets' }],
    });
    expect(fence).not.toContain(fakeToken());
    expect(fence).toContain('- a.md');
    expect(fence).not.toContain('- a.md:');
    expect(fence).toContain('- b.md: Baskets');
  });
});
