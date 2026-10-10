/**
 * In-app update for teammate (botboy-app) installs.
 *
 * Owner job: "tell me when a new release exists, and let me update with one
 * click". Detection is read-only (`git fetch` + HEAD vs origin/main). The
 * update itself is the existing `./start.sh --update`, launched DETACHED in
 * its own session (setsid via `detached:true`) with output to a log file, so
 * it survives the BotBoy shutdown that `--update` itself performs. It is never
 * a chat-terminal/pty child: those are killed on shutdown or get SIGHUP.
 *
 * Development checkouts never offer an update (same rule as start.sh).
 */
import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AppUpdateStatus {
  supported: boolean;
  available: boolean;
  checking: boolean;
  current: string | null;
  latest: string | null;
  behind: number;
  latestSubject: string | null;
  checkedAt: string | null;
  error: string | null;
  updating: boolean;
  updateStartedAt: string | null;
  logPath: string | null;
}

export type GitRunner = (args: string[], cwd: string) => Promise<string>;
export type Spawner = (cmd: string, args: string[], opts: SpawnOptions) => { pid?: number; unref(): void };

const defaultGit: GitRunner = (args, cwd) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
    if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 300)));
    else resolve(String(stdout).trim());
  });
});

const defaultSpawn: Spawner = (cmd, args, opts) => spawn(cmd, args, opts);

/** Same detection as start.sh: release marker or a botboy-app origin. */
export async function isReleaseCheckout(projDir: string, git: GitRunner = defaultGit): Promise<boolean> {
  if (fs.existsSync(path.join(projDir, '.botboy-distribution'))) return true;
  try {
    const url = await git(['remote', 'get-url', 'origin'], projDir);
    return /\/botboy-app(\.git)?$/.test(url.trim());
  } catch { return false; }
}

/** Spawn options that let the updater outlive BotBoy. Exported for tests. */
export function detachedUpdateOptions(projDir: string, logFd: number): SpawnOptions {
  return {
    cwd: projDir,
    detached: true, // new session + process group: no SIGHUP/group kill from BotBoy
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, BOTBOY_UPDATE_FROM_APP: '1' },
  };
}

export interface AppUpdaterOptions {
  projDir: string;
  dataDir?: string;
  git?: GitRunner;
  spawner?: Spawner;
  intervalMs?: number;
  onChange?: () => void;
}

export class AppUpdater {
  private readonly projDir: string;
  private readonly logDir: string;
  private readonly git: GitRunner;
  private readonly spawner: Spawner;
  private readonly intervalMs: number;
  private readonly onChange?: () => void;
  private supported: boolean | null = null;
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<AppUpdateStatus> | null = null;
  private state: AppUpdateStatus = {
    supported: false, available: false, checking: false, current: null, latest: null, behind: 0,
    latestSubject: null, checkedAt: null, error: null, updating: false, updateStartedAt: null, logPath: null,
  };

  constructor(opts: AppUpdaterOptions) {
    this.projDir = opts.projDir;
    this.logDir = path.join(opts.dataDir ?? path.join(os.homedir(), '.personal-productivity-tracker'), 'logs');
    this.git = opts.git ?? defaultGit;
    this.spawner = opts.spawner ?? defaultSpawn;
    this.intervalMs = opts.intervalMs ?? 30 * 60_000;
    this.onChange = opts.onChange;
  }

  status(): AppUpdateStatus { return { ...this.state }; }

  /** First check shortly after boot, then every interval. Never throws. */
  start(): void {
    if (this.timer) return;
    const first = setTimeout(() => { void this.check(); }, 60_000);
    first.unref?.();
    this.timer = setInterval(() => { void this.check(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async check(): Promise<AppUpdateStatus> {
    if (this.checking) return this.checking;
    this.checking = this.doCheck().finally(() => { this.checking = null; });
    return this.checking;
  }

  private async doCheck(): Promise<AppUpdateStatus> {
    if (this.supported === null) this.supported = await isReleaseCheckout(this.projDir, this.git);
    if (!this.supported) { this.state = { ...this.state, supported: false, available: false }; return this.status(); }
    const wasAvailable = this.state.available;
    const wasLatest = this.state.latest;
    this.state = { ...this.state, supported: true, checking: true };
    try {
      await this.git(['fetch', '--quiet', 'origin', 'main'], this.projDir);
      const current = await this.git(['rev-parse', 'HEAD'], this.projDir);
      const latest = await this.git(['rev-parse', 'origin/main'], this.projDir);
      const behind = Number(await this.git(['rev-list', '--count', 'HEAD..origin/main'], this.projDir)) || 0;
      const latestSubject = behind > 0 ? await this.git(['log', '-1', '--format=%s', 'origin/main'], this.projDir) : null;
      this.state = { ...this.state, checking: false, current, latest, behind, latestSubject, available: behind > 0,
        checkedAt: new Date().toISOString(), error: null };
    } catch (err) {
      this.state = { ...this.state, checking: false, checkedAt: new Date().toISOString(),
        error: `Could not check for updates: ${(err as Error).message}. Check the network and try again.` };
    }
    if (this.state.available !== wasAvailable || this.state.latest !== wasLatest) this.onChange?.();
    return this.status();
  }

  /** Launch `./start.sh --update` detached. Idempotent while one is running. */
  startUpdate(): { ok: true; logPath: string } | { ok: false; code: string; error: string } {
    if (!this.supported) return { ok: false, code: 'update_not_supported', error: 'This install is a development checkout; update it with Git.' };
    if (this.state.updating && this.state.logPath) return { ok: true, logPath: this.state.logPath };
    const script = path.join(this.projDir, 'start.sh');
    if (!fs.existsSync(script)) return { ok: false, code: 'update_script_missing', error: 'start.sh is missing; re-clone botboy-app.' };
    fs.mkdirSync(this.logDir, { recursive: true });
    const logPath = path.join(this.logDir, `update-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    const fd = fs.openSync(logPath, 'a');
    try {
      const child = this.spawner('/bin/bash', [script, '--update'], detachedUpdateOptions(this.projDir, fd));
      child.unref();
    } catch (err) {
      return { ok: false, code: 'update_spawn_failed', error: `Could not start the update: ${(err as Error).message}` };
    } finally {
      fs.closeSync(fd);
    }
    this.state = { ...this.state, updating: true, updateStartedAt: new Date().toISOString(), logPath };
    this.onChange?.();
    return { ok: true, logPath };
  }
}
