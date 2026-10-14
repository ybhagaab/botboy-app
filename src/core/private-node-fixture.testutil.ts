/**
 * A temporary stand-in for a Mac that runs BotBoy on its own Node: a temp HOME whose private folder
 * (`.personal-productivity-tracker`) holds a copy of the runtime that runs the tests, laid out like start.sh lays it out
 * (`runtime/node-<version>-<chip>/{bin/node, bin/npm, bin/npx, lib/node_modules/npm}`), plus things that must stay
 * unreadable. The copy is the Node and the npm of the process that runs the test (an APFS clone where the volume allows
 * it), so nothing is downloaded and the owner's real ~/.personal-productivity-tracker is never read.
 * Used by the tests that run the real /usr/bin/sandbox-exec.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hostNode = fs.realpathSync(process.execPath);
const hostNpm = path.join(path.dirname(path.dirname(hostNode)), 'lib', 'node_modules', 'npm');
const hasNpm = fs.existsSync(path.join(hostNpm, 'bin', 'npm-cli.js')) && fs.existsSync(path.join(hostNpm, 'bin', 'npx-cli.js'));

/** True where the live cases can run: macOS with sandbox-exec, and a Node that has its npm beside it. */
export const livePrivateNode = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec') && hasNpm;

export const RUNTIME_VERSION_NAME = 'node-24.21.0-arm64';

export interface PrivateNodeFixture {
  home: string;
  privateRoot: string;
  filesDir: string;
  runtimeRoot: string;
  versionDir: string;
  runtimeBin: string;
  /** The runtime's own node binary (a copy of the Node that runs this test). */
  nodeCopy: string;
  /** A folder outside the private root for scripts the tests write. */
  tools: string;
  cleanup(): void;
}

export function createPrivateNodeFixture(): PrivateNodeFixture {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-private-node-')));
  const privateRoot = path.join(home, '.personal-productivity-tracker');
  const filesDir = path.join(privateRoot, 'files');
  const runtimeRoot = path.join(privateRoot, 'runtime');
  const versionDir = path.join(runtimeRoot, RUNTIME_VERSION_NAME);
  const runtimeBin = path.join(versionDir, 'bin');
  const nodeCopy = path.join(runtimeBin, 'node');
  const tools = path.join(home, 'tools');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(runtimeBin, { recursive: true });
  fs.mkdirSync(tools, { recursive: true });
  if (livePrivateNode) {
    fs.copyFileSync(hostNode, nodeCopy, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(nodeCopy, 0o755);
    fs.mkdirSync(path.join(versionDir, 'lib', 'node_modules'), { recursive: true });
    fs.cpSync(hostNpm, path.join(versionDir, 'lib', 'node_modules', 'npm'), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
    fs.symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', path.join(runtimeBin, 'npm'));
    fs.symlinkSync('../lib/node_modules/npm/bin/npx-cli.js', path.join(runtimeBin, 'npx'));
  } else {
    fs.writeFileSync(nodeCopy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  fs.writeFileSync(path.join(versionDir, 'LICENSE'), 'license text\n');
  // Things that must stay unreadable, in and around the runtime.
  fs.writeFileSync(path.join(privateRoot, 'ai-model.json'), '{"apiKey":"sk-proj-secretkey0000000000000000"}', { mode: 0o600 });
  fs.writeFileSync(path.join(privateRoot, 'tracker.db'), 'SQLite format 3 secret rows');
  fs.symlinkSync(path.join(privateRoot, 'ai-model.json'), path.join(versionDir, 'leak'));
  fs.mkdirSync(path.join(runtimeRoot, 'node-22.1.2-arm64'));
  fs.writeFileSync(path.join(runtimeRoot, 'node-22.1.2-arm64', 'old.txt'), 'an older runtime');
  fs.mkdirSync(path.join(runtimeRoot, '.download'));
  fs.writeFileSync(path.join(runtimeRoot, '.download', 'partial.part'), 'half a download');
  // A script outside the private root that needs `node` from PATH.
  fs.writeFileSync(path.join(tools, 'hello.js'), '#!/usr/bin/env node\nconsole.log(process.execPath);\n', { mode: 0o755 });
  return { home, privateRoot, filesDir, runtimeRoot, versionDir, runtimeBin, nodeCopy, tools, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}
