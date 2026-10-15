/**
 * Boot order (design amendment P2-2). The MCP manager launches every enabled custom-command server in the background
 * as soon as it starts, and a server keeps the sandbox profile it was launched with, for its life. The write-deny
 * provider needs only the database and the environment, so it is registered right after the database opens, BEFORE the
 * manager exists. A provider registered where the library service is built would leave every boot-time server able
 * to write the folder.
 *
 * This is a source-seam test, the same kind the UI shell map uses for boot wiring: it reads `src/index.ts`.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const indexSource = fs.readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');

/** The statements, in order, that must come before the manager is built and started. */
const MUST_PRECEDE = [
  'const storage = createStorage();',
  'const db = storage.getDb();',
  'registerWriteProtectedRoots(() => knowledgeDenyRoots(db));',
  'registerCaptureExcludedRoots(() => knowledgeExcludedRoots(db));',
] as const;
const MANAGER_BUILT = 'const mcpManager = createMcpManager(';
const MANAGER_STARTED = 'mcpManager.start()';

function checkBootOrder(source: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const built = source.indexOf(MANAGER_BUILT);
  const started = source.indexOf(MANAGER_STARTED);
  if (built < 0) problems.push(`${MANAGER_BUILT} not found`);
  if (started < 0) problems.push(`${MANAGER_STARTED} not found`);
  let previous = -1;
  for (const statement of MUST_PRECEDE) {
    const at = source.indexOf(statement);
    if (at < 0) { problems.push(`${statement} not found`); continue; }
    if (at < previous) problems.push(`${statement} is out of order`);
    if (built >= 0 && at > built) problems.push(`${statement} comes after the MCP manager is built`);
    if (started >= 0 && at > started) problems.push(`${statement} comes after the MCP manager starts`);
    previous = at;
  }
  return { ok: problems.length === 0, problems };
}

describe('knowledge boundaries are registered before the first sandboxed process can start', () => {
  it('index.ts opens the database, registers both providers, and only then builds the MCP manager', () => {
    expect(checkBootOrder(indexSource)).toEqual({ ok: true, problems: [] });
  });

  it('registers the deny and the capture exclusion from the database-only providers', () => {
    expect(indexSource).toContain('registerWriteProtectedRoots(() => knowledgeDenyRoots(db))');
    expect(indexSource).toContain('registerCaptureExcludedRoots(() => knowledgeExcludedRoots(db))');
  });

  it('the checker catches a registration moved after the MCP manager is built, and one moved after it starts', () => {
    const line = '  registerWriteProtectedRoots(() => knowledgeDenyRoots(db));\n';
    expect(indexSource).toContain(line);
    const without = indexSource.replace(line, '');
    const afterBuild = without.replace("  startInBackground('Managed MCP runtime'", `${line}  startInBackground('Managed MCP runtime'`);
    expect(checkBootOrder(afterBuild).ok).toBe(false);
    const afterStart = without.replace('  const analyticsDataRoomStore = ', `${line}  const analyticsDataRoomStore = `);
    expect(checkBootOrder(afterStart).ok).toBe(false);
    expect(checkBootOrder(without).problems.join(' ')).toMatch(/registerWriteProtectedRoots/);
  });

  it('the checker catches a capture exclusion registered late', () => {
    const line = '  registerCaptureExcludedRoots(() => knowledgeExcludedRoots(db));\n';
    expect(indexSource).toContain(line);
    const without = indexSource.replace(line, '');
    const late = without.replace('  const analyticsDataRoomStore = ', `${line}  const analyticsDataRoomStore = `);
    expect(checkBootOrder(late).ok).toBe(false);
  });
});
