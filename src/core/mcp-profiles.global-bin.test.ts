/**
 * Owner question 2026-10-14: "many mcps end up adding their mcp server name in json config instead of npm, npx". A bare
 * command is looked up in the server's PATH and the code-owned fallback folders. While BotBoy runs on its own Node, a
 * program installed with `npm install -g` from chat lands in ~/.npm-global/bin, so a USER-ADDED command is also looked up
 * there, LAST: it can add a command and never shadows one found elsewhere. Built-in profiles run outside the sandbox and
 * never resolve from a folder that sandboxed code can write.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executableSearchDirectories,
  FALLBACK_EXECUTABLE_DIRECTORIES,
  resolveCommandExecutable,
  resolveDefinitionExecutable,
  type McpServerDefinition,
} from './mcp-profiles.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
const temp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-global-bin-')));
  roots.push(dir);
  return dir;
};
const program = (dir: string, name: string, body = '#!/bin/sh\nexit 0\n') => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
};
const custom = (command: string) => ({ launch: { type: 'custom-command', command, args: [] } }) as unknown as McpServerDefinition;
const builtIn = (executableName: string) => ({ launch: { type: 'local-executable', executableName } }) as unknown as McpServerDefinition;

describe('where a launch command is looked up', () => {
  it('lists the folders in order: PATH, the fallback folders, then the last resort', () => {
    expect(executableSearchDirectories('/a:/b', ['/g'])).toEqual(['/a', '/b', ...FALLBACK_EXECUTABLE_DIRECTORIES, '/g']);
    expect(executableSearchDirectories('/a:/b')).toEqual(['/a', '/b', ...FALLBACK_EXECUTABLE_DIRECTORIES]);
  });

  it('finds a user-added command that lives only in the last-resort folder, by its bare name', async () => {
    const home = temp();
    const globalBin = path.join(home, '.npm-global', 'bin');
    const bin = program(globalBin, 'botboy-global-probe');
    const pathValue = `${path.join(home, 'empty')}${path.delimiter}/usr/bin`;
    expect(await resolveDefinitionExecutable(custom('botboy-global-probe'), pathValue, [globalBin])).toBe(bin);
    expect(await resolveCommandExecutable('botboy-global-probe', pathValue, [globalBin])).toBe(bin);
  });

  it('never shadows: a same-named command in an earlier folder wins', async () => {
    const home = temp();
    const globalBin = path.join(home, '.npm-global', 'bin');
    program(globalBin, 'botboy-global-probe');
    const early = program(path.join(home, 'early'), 'botboy-global-probe');
    expect(await resolveDefinitionExecutable(custom('botboy-global-probe'), `${path.join(home, 'early')}`, [globalBin])).toBe(early);
  });

  it('with no last resort (a Mac with its own Node) the same command is simply not found: nothing changed', async () => {
    const home = temp();
    program(path.join(home, '.npm-global', 'bin'), 'botboy-global-probe');
    const pathValue = '/usr/bin';
    expect(await resolveDefinitionExecutable(custom('botboy-global-probe'), pathValue)).toBeNull();
    expect(await resolveDefinitionExecutable(custom('botboy-global-probe'), pathValue, [])).toBeNull();
  });

  it('a built-in profile never resolves from the last-resort folder, even when the program is there', async () => {
    const home = temp();
    const globalBin = path.join(home, '.npm-global', 'bin');
    program(globalBin, 'botboy-global-probe');
    expect(await resolveDefinitionExecutable(builtIn('botboy-global-probe'), '/usr/bin', [globalBin])).toBeNull();
    // The same name for a user-added command is found, which is the whole difference.
    expect(await resolveDefinitionExecutable(custom('botboy-global-probe'), '/usr/bin', [globalBin])).toBe(path.join(globalBin, 'botboy-global-probe'));
  });

  it('an absolute path is judged by itself, and a relative one is refused, whatever the last resort holds', async () => {
    const home = temp();
    const globalBin = path.join(home, '.npm-global', 'bin');
    const bin = program(globalBin, 'botboy-global-probe');
    expect(await resolveDefinitionExecutable(custom(bin), '/usr/bin', [globalBin])).toBe(bin);
    expect(await resolveDefinitionExecutable(custom(`./botboy-global-probe`), '/usr/bin', [globalBin])).toBeNull();
    expect(await resolveDefinitionExecutable(custom(path.join(home, 'missing')), '/usr/bin', [globalBin])).toBeNull();
  });
});
