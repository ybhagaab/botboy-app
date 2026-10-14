/**
 * BotBoy's own Node (scripts/node-runtime.sh) lives under ~/.personal-productivity-tracker/runtime, and start.sh puts its
 * bin folder first on the server's PATH. A child whose sandbox cannot read that folder must not see it on PATH (a
 * half-working Node), so modelChildEnvironment drops the entries under that folder unless the child was given read
 * access to the runtime (the `use` argument; run_command, the chat terminal and user-added MCP servers are, while BotBoy
 * runs on its own Node: protected-local-resources.chat-node.test.ts). These cases pass `use = null`. Only strings and a
 * temporary folder are used; the owner's real runtime folder is never read.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { modelChildEnvironment, pathWithoutPrivateRuntime, privateRuntimeRoot } from './protected-local-resources.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
const tempHome = () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-runtime-path-')));
  roots.push(home);
  return home;
};

describe('the model-run PATH does not carry BotBoy\'s own Node', () => {
  it('names the folder start.sh and scripts/node-runtime.sh use', () => {
    expect(privateRuntimeRoot('/Users/maria')).toBe('/Users/maria/.personal-productivity-tracker/runtime');
    expect(privateRuntimeRoot()).toBe(path.join(os.homedir(), '.personal-productivity-tracker', 'runtime'));
    const shell = fs.readFileSync(new URL('../../scripts/node-runtime.sh', import.meta.url), 'utf8');
    expect(shell).toContain('NODE_RUNTIME_ROOT="$HOME/.personal-productivity-tracker/runtime"');
  });

  it('removes every entry under the runtime folder and keeps all others, in order, with empty entries', () => {
    const home = tempHome();
    const root = privateRuntimeRoot(home);
    const bin24 = path.join(root, 'node-24.21.0-arm64', 'bin');
    const kept = ['/opt/homebrew/bin', '/usr/bin', '', path.join(home, '.personal-productivity-tracker', 'files', 'bin'), `${root}-old/bin`, path.join(home, '.personal-productivity-tracker', 'runtime2', 'bin'), '/usr/local/bin'];
    const input = [bin24, kept[0], path.join(root, 'node-22.1.2-arm64', 'bin'), kept[1], `${root}/`, kept[2], kept[3], root, kept[4], kept[5], kept[6]].join(path.delimiter);
    expect(pathWithoutPrivateRuntime(input, root)).toBe(kept.join(path.delimiter));
  });

  it('also removes an entry that reaches the folder through a symbolic link or another spelling', () => {
    const home = tempHome();
    const root = privateRuntimeRoot(home);
    fs.mkdirSync(path.join(root, 'node-24.21.0-arm64', 'bin'), { recursive: true });
    const link = path.join(home, 'quick-node');
    fs.symlinkSync(path.join(root, 'node-24.21.0-arm64', 'bin'), link);
    expect(pathWithoutPrivateRuntime(['/usr/bin', link, `${root}/node-24.21.0-arm64/../node-24.21.0-arm64/bin`].join(path.delimiter), root)).toBe('/usr/bin');
    // a folder that merely looks similar stays
    expect(pathWithoutPrivateRuntime(path.join(home, 'runtime', 'bin'), root)).toBe(path.join(home, 'runtime', 'bin'));
  });

  it('applies to the environment of a child whose sandbox cannot read the runtime (use=null); credentials are still removed and extra is applied last', () => {
    const runtimeBin = path.join(privateRuntimeRoot(), 'node-24.21.0-arm64', 'bin');
    const env = modelChildEnvironment({ BOTBOY_FILES: '/files' }, {
      PATH: `${runtimeBin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      HOME: '/Users/owner',
      BOTBOY_INFERENCE_API_KEY: 'secret',
    }, null);
    expect(env.PATH).toBe(`/usr/bin${path.delimiter}/bin`);
    expect(env).not.toHaveProperty('BOTBOY_INFERENCE_API_KEY');
    expect(env).toMatchObject({ HOME: '/Users/owner', BOTBOY_FILES: '/files' });
    // extra wins, as before
    expect(modelChildEnvironment({ PATH: '/custom' }, { PATH: runtimeBin }, null).PATH).toBe('/custom');
  });

  it('leaves an environment without a PATH, and a PATH with nothing to remove, exactly as it was', () => {
    expect(modelChildEnvironment({}, { HOME: '/x' }, null)).toEqual({ HOME: '/x' });
    expect(modelChildEnvironment({}, { PATH: '/opt/homebrew/bin:/usr/bin::/bin' }, null).PATH).toBe('/opt/homebrew/bin:/usr/bin::/bin');
  });
});
