/**
 * The Knowledge folder sits outside the update flow (docs/maps/knowledge-library.md K3, teammate-install-release.md).
 * `./start.sh --update` and the in-app update replace tracked files of the program folder only, so no launcher or update
 * code may name the folder, its settings key or its migration log; and the release ships no knowledge content because the
 * root-guide seed is a TypeScript string (the DOMAIN.md lesson: a repo file read at run time must be in `PATHS`).
 * This is the static guard; `knowledge-update-run.test.ts` runs the real `./start.sh --update` against a library and its History.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

/** Names that identify the owner's Knowledge folder and its state: none may appear in update or launcher code. */
const KNOWLEDGE_TOKENS = ['BotBoy Knowledge', 'knowledge.library', 'BOTBOY_KNOWLEDGE_ROOT', 'knowledge-migration.log', 'knowledge_load', 'knowledge-root'];

/** The shell and node scripts that ship to a teammate (top level of scripts/, not scripts/dev). */
function shippedScripts(): string[] {
  return fs.readdirSync(path.join(root, 'scripts'), { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(sh|mjs|cjs)$/.test(entry.name))
    .map(entry => `scripts/${entry.name}`);
}

function releasePaths(): string[] {
  const script = read('scripts/release.sh');
  const block = script.slice(script.indexOf('PATHS=('), script.indexOf('\n)\n', script.indexOf('PATHS=(')));
  return block.split('\n').slice(1)
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

describe('the Knowledge folder and the update flow', () => {
  it('start.sh, the in-app update and every shipped script name none of the folder, its setting or its log', () => {
    const files = ['start.sh', 'src/core/app-update.ts', 'src/api/routers/app-update.ts', ...shippedScripts()];
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = read(file);
      for (const token of KNOWLEDGE_TOKENS) expect(text.includes(token), `${file} names ${token}`).toBe(false);
    }
  });

  it('the update flow still replaces tracked program files only (git pull/patch in the program folder, nothing under HOME documents)', () => {
    const start = read('start.sh');
    // The documented customization backups live in private state, never next to or inside the Knowledge folder.
    expect(start).toContain('update-backups');
    expect(start).not.toMatch(/Documents\/BotBoy/);
    expect(read('src/core/app-update.ts')).not.toMatch(/Documents\//);
  });

  it('release.sh ships src whole and no knowledge content or dev check', () => {
    const paths = releasePaths();
    expect(paths).toContain('src');
    expect(paths.filter(entry => /knowledge|\.agents|docs\/maps|scripts\/dev/i.test(entry))).toEqual([]);
  });

  it('the dev-only checks exist outside the allowlist, and nothing that ships imports them', () => {
    const dev = fs.readdirSync(path.join(root, 'scripts/dev')).filter(name => name.startsWith('knowledge-'));
    expect(dev.sort()).toEqual(['knowledge-live-check.mjs', 'knowledge-migration-check.mjs']);
    for (const file of ['start.sh', ...shippedScripts()]) expect(read(file)).not.toMatch(/scripts\/dev|knowledge-live-check|knowledge-migration-check/);
  });

  it('no library code reads a repo file at run time: the root-guide seed is a string in knowledge-templates.ts', () => {
    const templates = read('src/core/knowledge-templates.ts');
    expect(templates).toContain('ROOT_GUIDE_SEED');
    expect(templates).not.toMatch(/node:fs|readFile|import\.meta/);
    for (const file of ['knowledge-templates.ts', 'knowledge-root.ts', 'knowledge-library.ts', 'knowledge-migration.ts', 'knowledge-guide.ts', 'knowledge-routing.ts', 'knowledge-chat-tools.ts']) {
      const text = read(`src/core/${file}`);
      expect(text, `${file} reads a file of the program folder`).not.toMatch(/process\.cwd\(\)|__dirname|DOMAIN\.md|docs\/(?:etl|maps|release)/);
    }
    // The one use of import.meta.url is knowledge-root's program-folder PATH (a root may not overlap it), never a read.
    const rootText = read('src/core/knowledge-root.ts');
    expect(rootText.match(/import\.meta\.url/g)).toHaveLength(1);
    expect(rootText).toMatch(/path\.resolve\(path\.dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.', '\.\.'\)/);
  });
});
