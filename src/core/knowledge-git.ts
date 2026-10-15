/**
 * Git as a best-effort, browsable MIRROR of the Knowledge library's history (knowledge-library.md K13; brief 4.5). The
 * journal in `knowledge-history.ts` is the source of truth and powers Undo; git adds nothing Undo depends on.
 *
 *  - The git directory lives in BotBoy's private state and the knowledge folder is only the work tree: no `.git` entry ever
 *    appears in the visible folder (iCloud and Time Machine on Desktop/Documents, and owners may keep repositories of their own).
 *  - Every call is an argument array (never a shell, so the space in "BotBoy Knowledge" is safe) with explicit `--git-dir`
 *    and `--work-tree`, a per-command identity and a scrubbed environment: global and system git config are never read,
 *    no hook runs, nothing is signed, stdin is closed, the working directory is an empty private folder and a call has a
 *    time limit. Only `add --all -- <explicit paths>` is ever staged, never the whole tree.
 *  - The macOS `/usr/bin/git` is a stand-in without the Command Line Tools and raises the install dialog when run:
 *    it is used only when `commandLineToolsKnown() === true`. `false` counts as missing; `null` (not known yet) skips git
 *    for this write and asks again at the next one.
 *  - Missing, stand-in or failing git degrades to the journal alone; three failures open a ten-minute breaker.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandLineToolsKnown } from './command-line-tools.js';
import { XCODE_SHIM_TOOLS, knownToolDirectories, resolveBinary } from './toolchain.js';

export interface GitResolution {
  /** The git to run, or null. */
  path: string | null;
  /** `ready`: run it. `missing`: no git. `stand_in`: only the macOS stand-in and the tools are absent. `unknown`: not known yet; ask later. */
  state: 'ready' | 'missing' | 'stand_in' | 'unknown';
}

export interface ResolveGitOptions {
  /** Finds the git binary (default: PATH, then the toolchain's known folders). */
  find?: () => string | null;
  /** The stand-in paths (default: the toolchain's `XCODE_SHIM_TOOLS`). */
  shimTools?: ReadonlySet<string>;
  /** Whether the Command Line Tools are installed (default: the cached answer). */
  commandLineTools?: () => boolean | null;
}

export function resolveGit(options: ResolveGitOptions = {}): GitResolution {
  const find = options.find ?? (() => resolveBinary('git', process.env.PATH ?? '', knownToolDirectories()));
  const found = find();
  if (!found) return { path: null, state: 'missing' };
  const shims = options.shimTools ?? XCODE_SHIM_TOOLS;
  if (!shims.has(found)) return { path: found, state: 'ready' };
  const tools = (options.commandLineTools ?? (() => commandLineToolsKnown()))();
  if (tools === true) return { path: found, state: 'ready' };
  if (tools === false) return { path: null, state: 'stand_in' };
  return { path: null, state: 'unknown' };
}

export interface GitRunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type GitRunner = (gitPath: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<GitRunResult>;

const MAX_OUTPUT_BYTES = 256 * 1024;

/** Runs one git command without a shell. Never rejects. */
export const runGit: GitRunner = (gitPath, args, options) => new Promise((resolve) => {
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let settled = false;
  const finish = (code: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ code, stdout, stderr, timedOut });
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(gitPath, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) {
    resolve({ code: null, stdout: '', stderr: String((error as Error)?.message ?? error), timedOut: false });
    return;
  }
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    finish(null);
  }, options.timeoutMs);
  child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8'); });
  child.on('error', (error) => { stderr += String(error?.message ?? error); finish(null); });
  child.on('close', (code) => finish(code));
});

/** The environment git runs in: nothing inherited that could redirect it, no user or system configuration. */
export function scrubbedGitEnv(homeDir: string, gitPath: string): NodeJS.ProcessEnv {
  const gitFolder = path.dirname(gitPath);
  return {
    PATH: [gitFolder, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter((value, index, all) => all.indexOf(value) === index).join(path.delimiter),
    HOME: homeDir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
}

/**
 * The per-command configuration: an identity, no hook, no signing, no line-ending rewrite, and git's own gc on its own
 * thresholds (`gc.auto` untouched, 6,700 loose objects) but never detached: an automatic gc runs inside the command that
 * triggered it, under this module's time limit, and leaves no background process behind (P2 review R17).
 */
export const GIT_COMMAND_CONFIG: readonly string[] = Object.freeze([
  '-c', 'user.name=BotBoy',
  '-c', 'user.email=botboy@localhost',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'core.quotepath=false',
  '-c', 'gc.autoDetach=false',
]);

export interface GitMirrorOptions {
  /** `~/.personal-productivity-tracker/knowledge-history.git`. */
  gitDir: string;
  /** An empty private folder: the working directory and HOME of every git call. */
  homeDir: string;
  /** The knowledge folder (canonical), or null while there is none. */
  workTree: () => string | null;
  resolve?: () => GitResolution;
  run?: GitRunner;
  now?: () => number;
  timeoutMs?: number;
}

export type GitRecordResult =
  | { ok: true; committed: boolean }
  | { ok: false; reason: 'missing' | 'stand_in' | 'unknown' | 'breaker_open' | 'no_work_tree' | 'failed'; message?: string };

export interface GitMirrorStatus {
  /** `active`: commits are being made. `degraded`: history is kept as plain copies (a reason is in `notice`). `idle`: nothing recorded yet. */
  state: 'active' | 'degraded' | 'idle';
  /** One sentence for the owner, said once ("History is kept as plain copies; git was unavailable"), or null. */
  notice: string | null;
  gitDirectory: string;
  /** A copyable `git --git-dir … log` line while git is active. */
  hint: string | null;
}

export interface GitMirror {
  record(input: { paths: string[]; message: string }): Promise<GitRecordResult>;
  status(): GitMirrorStatus;
}

const BREAKER_FAILURES = 3;
const BREAKER_MS = 10 * 60_000;
export const GIT_DEGRADED_NOTICE = 'History is kept as plain copies; git was unavailable. Undo works the same.';

export function createGitMirror(options: GitMirrorOptions): GitMirror {
  const now = options.now ?? (() => Date.now());
  const resolve = options.resolve ?? (() => resolveGit());
  const run = options.run ?? runGit;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let failures = 0;
  let openUntil = 0;
  let notice: string | null = null;
  let active = false;
  let lastGitPath: string | null = null;
  let initialized = false;

  async function git(gitPath: string, workTree: string, args: string[]): Promise<GitRunResult> {
    const full = ['--no-pager', `--git-dir=${options.gitDir}`, `--work-tree=${workTree}`, ...GIT_COMMAND_CONFIG, ...args];
    return run(gitPath, full, { cwd: options.homeDir, env: scrubbedGitEnv(options.homeDir, gitPath), timeoutMs });
  }

  const fail = (reason: Extract<GitRecordResult, { ok: false }>['reason'], message?: string): GitRecordResult => ({ ok: false, reason, ...(message ? { message } : {}) });

  function noteFailure(message: string): GitRecordResult {
    failures += 1;
    if (failures >= BREAKER_FAILURES) openUntil = now() + BREAKER_MS;
    active = false;
    notice = GIT_DEGRADED_NOTICE;
    return fail('failed', message.slice(0, 300));
  }

  async function ensureRepository(gitPath: string, workTree: string): Promise<GitRunResult | null> {
    if (initialized && fs.existsSync(path.join(options.gitDir, 'HEAD'))) return null;
    await fsp.mkdir(options.homeDir, { recursive: true });
    await fsp.mkdir(path.dirname(options.gitDir), { recursive: true });
    if (!fs.existsSync(path.join(options.gitDir, 'HEAD'))) {
      const init = await run(gitPath, ['--no-pager', ...GIT_COMMAND_CONFIG, 'init', '--bare', '--quiet', options.gitDir], { cwd: options.homeDir, env: scrubbedGitEnv(options.homeDir, gitPath), timeoutMs });
      if (init.code !== 0) return init;
    }
    // A repository born on another branch name must not matter: commits go to whatever HEAD names.
    void workTree;
    initialized = true;
    return null;
  }

  async function record(input: { paths: string[]; message: string }): Promise<GitRecordResult> {
    const workTree = options.workTree();
    if (!workTree) return fail('no_work_tree');
    if (now() < openUntil) return fail('breaker_open');
    const resolution = resolve();
    if (resolution.state === 'unknown') return fail('unknown');
    if (resolution.state !== 'ready' || !resolution.path) {
      if (resolution.state === 'stand_in' || resolution.state === 'missing') {
        active = false;
        notice = GIT_DEGRADED_NOTICE;
      }
      return fail(resolution.state === 'stand_in' ? 'stand_in' : 'missing');
    }
    const gitPath = resolution.path;
    lastGitPath = gitPath;
    const paths = [...new Set(input.paths.map((entry) => entry.split(path.sep).join('/')).filter((entry) => entry && !entry.startsWith('/') && !entry.split('/').includes('..') && !entry.startsWith('.git')))];
    if (paths.length === 0) return { ok: true, committed: false };
    try {
      const initFailure = await ensureRepository(gitPath, workTree);
      if (initFailure) return noteFailure(`git init failed: ${initFailure.stderr || initFailure.stdout || (initFailure.timedOut ? 'timed out' : 'no output')}`);
      const add = await git(gitPath, workTree, ['add', '--all', '--', ...paths]);
      if (add.code !== 0) return noteFailure(`git add failed: ${add.stderr || (add.timedOut ? 'timed out' : 'no output')}`);
      const staged = await git(gitPath, workTree, ['diff', '--cached', '--quiet']);
      if (staged.code === 0) { failures = 0; active = true; return { ok: true, committed: false }; }
      if (staged.code !== 1) return noteFailure(`git diff failed: ${staged.stderr || (staged.timedOut ? 'timed out' : 'no output')}`);
      const commit = await git(gitPath, workTree, ['commit', '--quiet', '--no-verify', '--allow-empty-message', '-m', input.message.slice(0, 500) || 'knowledge change']);
      if (commit.code !== 0) return noteFailure(`git commit failed: ${commit.stderr || commit.stdout || (commit.timedOut ? 'timed out' : 'no output')}`);
      failures = 0;
      active = true;
      notice = null;
      return { ok: true, committed: true };
    } catch (error) {
      return noteFailure(String((error as Error)?.message ?? error));
    }
  }

  return {
    record,
    status() {
      const quoted = (value: string) => `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
      return {
        state: active ? 'active' : notice ? 'degraded' : 'idle',
        notice,
        gitDirectory: options.gitDir,
        hint: active && lastGitPath ? `git --git-dir=${quoted(options.gitDir)} log --stat` : null,
      };
    },
  };
}

/** The default private locations. */
export function defaultGitLocations(home: string = os.homedir()): { gitDir: string; homeDir: string } {
  const base = path.join(home, '.personal-productivity-tracker');
  return { gitDir: path.join(base, 'knowledge-history.git'), homeDir: path.join(base, 'knowledge-history-home') };
}
