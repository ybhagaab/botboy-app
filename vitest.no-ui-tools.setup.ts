/**
 * Test hygiene: no test may put UI on the owner's screen or register an app with macOS.
 *
 * Why (2026-10-13): a test run showed "BotBoy launcher is stale" dialogs (the generated
 * shell launcher calls `osascript` when it finds no folder) and left a temporary BotBoy.app
 * registered with LaunchServices beside the real /Applications/BotBoy.app. Both are one
 * missing stub away, in any test that runs a launcher, `start.sh` or scripts/make-app-bundle.mjs.
 *
 * What this file does for EVERY test file (it is a vitest setup file):
 *  - Puts a folder of stub tools first on PATH: `osascript`, `open` and `lsregister` only
 *    record that they were called, and a test file that reaches one FAILS in afterAll
 *    (the tool must be stubbed by the test: a PATH stub of its own or a BOTBOY_TEST_* hook).
 *  - Defaults BOTBOY_TEST_LSREGISTER_BIN to the stub (in this process and in every child
 *    environment a test passes), so no builder or start.sh run can register a bundle.
 *  - Refuses, in the spawn functions of node:child_process, to run the REAL osascript, open or
 *    lsregister (absolute path, or a bare name that PATH resolves to the real one) before any
 *    process starts. src/core/test-hygiene.test.ts proves this and scans the tests for the
 *    other half of the rule (a bundle test names its own HOME and lsregister stub).
 *
 * It cannot see inside a child process that calls /usr/bin/osascript by absolute path; the
 * only such caller is the generated shell launcher, which uses the bare name `osascript`
 * (so the PATH stub catches it), and its tests give it a recording stub of their own.
 *
 * Where the stub folder lives. vitest.no-ui-tools.global.ts (a globalSetup, run once in the main process)
 * makes one folder per RUN and tells the workers through BOTBOY_TEST_UI_STUBS_RUN_DIR. Each test file's
 * stubs go inside it and are NOT removed when the file ends: a process that outlives its test file still finds
 * a stub first on its PATH rather than the real tool, and the run's teardown removes everything once (a worker
 * is ended by a signal, so nothing here could be trusted to). Without that variable, each file keeps a folder
 * of its own in the temp directory and removes it in afterAll.
 */
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll } from 'vitest';
import { RUN_DIR_ENV } from './vitest.no-ui-tools.global';

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const GUARDED_NAMES = ['osascript', 'open', 'lsregister'] as const;
const INSTALLED = Symbol.for('botboy.test.noUiTools');

type Guard = {
  stubDir: string;
  /** True when stubDir sits inside the run's folder, which the run's teardown removes (this file must leave it). */
  inRunFolder: boolean;
  logFile: string;
  lsregisterStub: string;
  /** What reached a stub tool since the last reset (one line per call). */
  calls: () => string[];
  reset: () => void;
  realTools: ReadonlyMap<string, string>;
};

const realpath = (file: string) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
};

function createGuard(): Guard {
  const runFolder = process.env[RUN_DIR_ENV];
  const inRunFolder = Boolean(runFolder && path.isAbsolute(runFolder) && fs.existsSync(runFolder));
  const stubDir = fs.mkdtempSync(path.join(inRunFolder ? runFolder! : os.tmpdir(), 'botboy-test-ui-stubs-'));
  const logFile = path.join(stubDir, 'calls.log');
  fs.writeFileSync(logFile, '');
  for (const name of GUARDED_NAMES) {
    fs.writeFileSync(path.join(stubDir, name), `#!/bin/sh\necho "${name} $*" >> '${logFile}'\nexit 0\n`, { mode: 0o755 });
  }
  const real = new Map<string, string>();
  for (const [file, name] of [['/usr/bin/osascript', 'osascript'], ['/usr/bin/open', 'open'], [LSREGISTER, 'lsregister']] as const) {
    real.set(file, name);
    real.set(realpath(file), name);
  }
  return {
    stubDir,
    inRunFolder,
    logFile,
    lsregisterStub: path.join(stubDir, 'lsregister'),
    realTools: real,
    calls: () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean),
    reset: () => fs.writeFileSync(logFile, ''),
  };
}

/** The first match of a bare command name along a PATH string, or null. */
function resolveOnPath(name: string, pathValue: string | undefined): string | null {
  for (const dir of (pathValue ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Which real tool (osascript, open, lsregister) does this command word run, or null. */
function realToolOf(guard: Guard, word: string, pathValue: string | undefined): string | null {
  if (!word) return null;
  if (path.isAbsolute(word)) return guard.realTools.get(word) ?? guard.realTools.get(realpath(word)) ?? null;
  if (!(GUARDED_NAMES as readonly string[]).includes(word)) return null;
  const found = resolveOnPath(word, pathValue);
  return found ? (guard.realTools.get(found) ?? guard.realTools.get(realpath(found)) ?? null) : null;
}

/** The options object of a spawn-style call (the last plain object after the command), or null. */
function optionsIndex(args: unknown[]): number {
  for (let index = args.length - 1; index >= 1; index--) {
    const value = args[index];
    if (value && typeof value === 'object' && !Array.isArray(value)) return index;
  }
  return -1;
}

function patchedEnv(guard: Guard, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const current = next.PATH ?? '';
  if (!current.split(path.delimiter).includes(guard.stubDir)) next.PATH = current ? `${guard.stubDir}${path.delimiter}${current}` : guard.stubDir;
  if (next.BOTBOY_TEST_LSREGISTER_BIN === undefined) next.BOTBOY_TEST_LSREGISTER_BIN = guard.lsregisterStub;
  return next;
}

/**
 * exec and execFile carry a util.promisify.custom that resolves { stdout, stderr }; a plain wrapper would lose it
 * (promisify would then resolve with stdout alone and every `const { stdout } = await execFileAsync(...)` in the
 * code under test would break). The same shape, calling the guarded function.
 */
function keepPromisified(wrapper: (...args: unknown[]) => unknown, original: object): void {
  if (!(promisify.custom in original)) return;
  const custom = (...args: unknown[]) => {
    let child: unknown;
    const promise = new Promise((resolve, reject) => {
      child = wrapper(...args, (error: (Error & { stdout?: unknown; stderr?: unknown }) | null, stdout: unknown, stderr: unknown) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        } else resolve({ stdout, stderr });
      });
    });
    (promise as unknown as { child: unknown }).child = child;
    return promise;
  };
  Object.defineProperty(wrapper, promisify.custom, { value: custom, enumerable: false, configurable: true });
}

const globals = globalThis as unknown as { __botboyUiGuard?: Guard };

function install(first: Guard): void {
  const target = cp as unknown as Record<string | symbol, unknown>;
  if (target[INSTALLED]) return;
  // The wrappers outlive one test file's guard when a worker is reused (its stub folder is removed in afterAll and
  // the next file's setup creates a new one), so they always ask for the live guard.
  const live = (): Guard => globals.__botboyUiGuard ?? first;
  const refuse = (call: string, tool: string): never => {
    throw new Error(
      `[test hygiene] ${call} would run the REAL ${tool}. That shows UI on the owner's screen or registers an app with LaunchServices. `
      + 'Stub it: a recording script first on the PATH you pass, or the BOTBOY_TEST_* hook (BOTBOY_TEST_LSREGISTER_BIN, BOTBOY_TEST_XATTR_BIN, ...).',
    );
  };
  const wrapFile = (name: 'spawn' | 'spawnSync' | 'execFile' | 'execFileSync') => {
    const original = (cp as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
    target[name] = function guarded(this: unknown, ...args: unknown[]) {
      const index = optionsIndex(args);
      const options = index > 0 ? (args[index] as { env?: NodeJS.ProcessEnv }) : undefined;
      // The child's PATH always starts with the stub folder, so a bare name can only reach the stub.
      if (options?.env && index > 0) args[index] = { ...options, env: patchedEnv(live(), options.env) };
      const env = (index > 0 ? (args[index] as { env?: NodeJS.ProcessEnv }).env : undefined) ?? process.env;
      const hit = typeof args[0] === 'string' ? realToolOf(live(), args[0], env.PATH) : null;
      if (hit) refuse(`${name}(${JSON.stringify(args[0])})`, hit);
      return original.apply(this, args);
    };
    keepPromisified(target[name] as (...args: unknown[]) => unknown, original);
  };
  const wrapShell = (name: 'exec' | 'execSync') => {
    const original = (cp as unknown as Record<string, (...a: unknown[]) => unknown>)[name];
    target[name] = function guarded(this: unknown, ...args: unknown[]) {
      const index = optionsIndex(args);
      const options = index > 0 ? (args[index] as { env?: NodeJS.ProcessEnv }) : undefined;
      if (options?.env && index > 0) args[index] = { ...options, env: patchedEnv(live(), options.env) };
      const env = (index > 0 ? (args[index] as { env?: NodeJS.ProcessEnv }).env : undefined) ?? process.env;
      if (typeof args[0] === 'string') {
        for (const word of args[0].split(/[\s;&|()<>`"']+/)) {
          const hit = realToolOf(live(), word, env.PATH);
          if (hit) refuse(`${name}(${JSON.stringify(args[0].slice(0, 80))})`, hit);
        }
      }
      return original.apply(this, args);
    };
    keepPromisified(target[name] as (...args: unknown[]) => unknown, original);
  };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync'] as const) wrapFile(name);
  for (const name of ['exec', 'execSync'] as const) wrapShell(name);
  target[INSTALLED] = true;
  // Modules that import { spawnSync } from 'node:child_process' bind to the ESM facade of the builtin.
  syncBuiltinESMExports();
}

if (!globals.__botboyUiGuard) {
  globals.__botboyUiGuard = createGuard();
  const { stubDir: folder, inRunFolder } = globals.__botboyUiGuard;
  // A fallback only, and only for a folder this file owns (the run's teardown removes the others): vitest ends
  // its workers with a signal, so this handler rarely runs. Such a folder is removed in afterAll below; without
  // that, every test file left one folder behind in the temp directory.
  if (!inRunFolder) {
    process.on('exit', () => {
      try {
        fs.rmSync(folder, { recursive: true, force: true });
      } catch {
        // the temp folder cleaner gets it
      }
    });
  }
}
const guard = globals.__botboyUiGuard;
process.env.PATH = (process.env.PATH ?? '').split(path.delimiter).includes(guard.stubDir)
  ? process.env.PATH
  : `${guard.stubDir}${path.delimiter}${process.env.PATH ?? ''}`;
if (process.env.BOTBOY_TEST_LSREGISTER_BIN === undefined) process.env.BOTBOY_TEST_LSREGISTER_BIN = guard.lsregisterStub;
install(guard);

afterAll(() => {
  let calls: string[] = [];
  try {
    calls = guard.calls();
  } catch {
    // the folder is already gone (a test removed the temp directory): nothing was recorded that we can read
  }
  try {
    if (calls.length) {
      throw new Error(
        `[test hygiene] a test reached a stub of the macOS UI tools (${calls.length} call${calls.length === 1 ? '' : 's'}: ${calls.slice(0, 3).join(' | ')}). `
        + 'osascript shows dialogs, open launches apps and lsregister registers them: give the test its own recording stub, and keep the real tool out of it.',
      );
    }
  } finally {
    // This file's folder is finished with, unless it sits in the run's folder: that stays until the run ends, so
    // a process that outlives this file still hits a stub. A reused worker gets a fresh guard from the next file's setup.
    if (!guard.inRunFolder) {
      try {
        fs.rmSync(guard.stubDir, { recursive: true, force: true });
      } catch {
        // best effort; the temp folder cleaner gets it
      }
    }
    if (globals.__botboyUiGuard === guard) globals.__botboyUiGuard = undefined;
  }
});
