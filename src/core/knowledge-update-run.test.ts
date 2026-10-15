/**
 * `./start.sh --update` against a Knowledge folder and its History, run for real (docs/maps/knowledge-library.md K3, K13,
 * teammate-install-release.md): the REAL start.sh updates a temp botboy-app checkout from a local bare remote (a tracked
 * customization is backed up and reapplied, like a teammate's) while a Knowledge folder with a space in its name, its
 * History, its git mirror and its settings sit beside it. Afterwards every byte and every modification time of the folder
 * and of the History is exactly what it was, while the update's own backup landed elsewhere in the private state.
 * Hygiene: HOME is private, the UI tools are recording stubs, git is the developer-tools git (never the macOS stand-in),
 * nothing starts (BOTBOY_UPDATE_NO_START), and the remote is a file path.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubUiTools } from './launcher-fixtures.testutil';

vi.setConfig({ testTimeout: 120_000 });
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const REAL_GIT = ['/Library/Developer/CommandLineTools/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'].find((candidate) => { try { return fs.statSync(candidate).isFile(); } catch { return false; } }) ?? null;
const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

/** Every file under the given folders: path → content hash and modification time. */
function snapshot(folders: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const stat = fs.lstatSync(full);
      out[full] = `${entry.isSymbolicLink() ? 'link' : createHash('sha256').update(fs.readFileSync(full)).digest('hex')}@${Math.round(stat.mtimeMs)}`;
    }
  };
  for (const folder of folders) {
    if (!fs.existsSync(folder)) continue;
    if (fs.lstatSync(folder).isFile()) {
      out[folder] = `${createHash('sha256').update(fs.readFileSync(folder)).digest('hex')}@${Math.round(fs.lstatSync(folder).mtimeMs)}`;
    } else walk(folder);
  }
  return out;
}

describe.runIf(process.platform === 'darwin' && REAL_GIT !== null)('./start.sh --update and the Knowledge folder', () => {
  it('updates the program folder, backs up and reapplies a customization, and leaves the Knowledge folder and its History byte-identical', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-update-')));
    roots.push(root);
    const ui = stubUiTools(root);
    const home = path.join(root, 'home');
    const state = path.join(home, '.personal-productivity-tracker');
    const knowledge = path.join(home, 'Documents', 'BotBoy Knowledge');
    const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

    // The owner's library, its History and mirror, and the settings next to them.
    put(path.join(knowledge, 'GUIDE.md'), '# BotBoy Knowledge\n');
    put(path.join(knowledge, 'shop-data', 'GUIDE.md'), '---\nname: Shop data\n---\n# Shop data\n');
    put(path.join(knowledge, 'shop-data', 'orders.md'), '# Orders\n\nVersion one.\n');
    put(path.join(knowledge, 'analytics', 'lessons', 'general.md'), '# Lessons\n');
    put(path.join(state, 'knowledge-history', 'log.jsonl'), '{"id":"h_000000000001"}\n');
    put(path.join(state, 'knowledge-history', 'state.json'), '{"version":1,"files":{},"started":true}');
    put(path.join(state, 'knowledge-history', 'objects', 'a'.repeat(64)), '# Orders\n\nVersion zero.\n');
    put(path.join(state, 'knowledge-history.git', 'HEAD'), 'ref: refs/heads/main\n');
    put(path.join(state, 'knowledge-history-home', '.keep'), '');
    put(path.join(state, 'knowledge-migration.log'), '{"at":"x"}\n');

    // A botboy-app checkout with a newer release waiting on a local remote.
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync(REAL_GIT as string, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
        cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: path.join(root, 'git-home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      });
      expect(result.status, `${args.join(' ')}: ${result.stderr}`).toBe(0);
      return result.stdout;
    };
    fs.mkdirSync(path.join(root, 'git-home'), { recursive: true });
    const remote = path.join(root, 'remote', 'botboy-app.git');
    fs.mkdirSync(remote, { recursive: true });
    git(remote, 'init', '--bare', '--initial-branch=main', '--quiet');
    const seed = path.join(root, 'seed');
    fs.mkdirSync(seed, { recursive: true });
    git(seed, 'init', '--initial-branch=main', '--quiet');
    fs.copyFileSync(path.join(packageRoot, 'start.sh'), path.join(seed, 'start.sh'));
    fs.chmodSync(path.join(seed, 'start.sh'), 0o755);
    put(path.join(seed, 'package.json'), JSON.stringify({ name: 'botboy-app', version: '1.0.0' }, null, 2));
    put(path.join(seed, 'README.md'), '# BotBoy\n');
    put(path.join(seed, '.botboy-distribution'), 'release: dev@test\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '--quiet', '-m', 'release: one');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '--quiet', 'origin', 'main');
    const checkout = path.join(root, 'botboy-app');
    git(root, 'clone', '--quiet', remote, checkout);
    git(checkout, 'branch', '--set-upstream-to=origin/main', 'main');
    put(path.join(seed, 'README.md'), '# BotBoy, release two\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '--quiet', '-m', 'release: two');
    git(seed, 'push', '--quiet', 'origin', 'main');
    // The teammate customized a tracked file (the update backs it up and reapplies it).
    put(path.join(checkout, 'package.json'), JSON.stringify({ name: 'botboy-app', version: '1.0.0', note: 'my customization' }, null, 2));

    const protectedFolders = [path.join(home, 'Documents'), path.join(state, 'knowledge-history'), path.join(state, 'knowledge-history.git'), path.join(state, 'knowledge-history-home'), path.join(state, 'knowledge-migration.log')];
    const before = snapshot(protectedFolders);
    expect(Object.keys(before).length).toBeGreaterThanOrEqual(9);
    // Let any mtime granularity pass, so a touch would show.
    const base: Record<string, string | undefined> = { ...process.env };
    for (const key of ['BOTBOY_NATIVE_REEXEC', 'BOTBOY_REEXEC_FROM', 'BOTBOY_KNOWLEDGE_ROOT']) delete base[key];
    const result = spawnSync('/bin/bash', [path.join(checkout, 'start.sh'), '--update'], {
      cwd: checkout, encoding: 'utf8', timeout: 100_000,
      env: {
        ...base, ...ui.env, HOME: home, BOTBOY_UPDATE_NO_START: '1', BOTBOY_NO_ARCH_REEXEC: '1', PPT_LOG_FILE: path.join(root, 'launcher.log'),
        PATH: `${ui.dir}:${path.dirname(REAL_GIT as string)}:/usr/bin:/bin:${path.dirname(process.execPath)}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
      } as Record<string, string>,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(0);
    expect(output).toContain('BotBoy updated');
    // The program folder really updated and kept the customization.
    expect(fs.readFileSync(path.join(checkout, 'README.md'), 'utf8')).toContain('release two');
    expect(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8')).toContain('my customization');
    expect(fs.readdirSync(path.join(state, 'update-backups')).some((name) => name.endsWith('.patch'))).toBe(true);
    // The library, its History, its mirror and its log are exactly what they were: bytes and modification times.
    expect(snapshot(protectedFolders)).toEqual(before);
    expect(ui.calls()).toEqual([]);
  });
});
