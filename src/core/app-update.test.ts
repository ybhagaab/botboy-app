import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { AppUpdater, detachedUpdateOptions, isReleaseCheckout, type GitRunner } from './app-update.js';
import { createAppUpdateRouter } from '../api/routers/app-update.js';

const dirs: string[] = [];
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'app-update-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function fakeGit(origin: string, head: string, latest: string, behind: number): GitRunner {
  return async (args) => {
    const a = args.join(' ');
    if (a === 'remote get-url origin') return origin;
    if (a.startsWith('fetch')) return '';
    if (a === 'rev-parse HEAD') return head;
    if (a === 'rev-parse origin/main') return latest;
    if (a.startsWith('rev-list')) return String(behind);
    if (a.startsWith('log')) return 'release: dev@abc';
    throw new Error(`unexpected ${a}`);
  };
}

describe('app update', () => {
  it('detects release checkouts by marker or origin, never the dev repo', async () => {
    const dir = tmp();
    expect(await isReleaseCheckout(dir, async () => 'https://github.com/ybhagaab/botboy.git')).toBe(false);
    expect(await isReleaseCheckout(dir, async () => 'https://github.com/ybhagaab/botboy-app.git')).toBe(true);
    expect(await isReleaseCheckout(dir, async () => 'git@github.com:ybhagaab/botboy-app')).toBe(true);
    fs.writeFileSync(path.join(dir, '.botboy-distribution'), 'x');
    expect(await isReleaseCheckout(dir, async () => { throw new Error('no git'); })).toBe(true);
  });

  it('reports an available update with count and subject', async () => {
    const u = new AppUpdater({ projDir: tmp(), git: fakeGit('https://github.com/ybhagaab/botboy-app.git', 'aaa', 'bbb', 2) });
    const s = await u.check();
    expect(s).toMatchObject({ supported: true, available: true, behind: 2, current: 'aaa', latest: 'bbb', latestSubject: 'release: dev@abc', error: null });
  });

  it('dev checkout is unsupported and cannot start an update', async () => {
    const spawned: unknown[] = [];
    const u = new AppUpdater({ projDir: tmp(), git: fakeGit('https://github.com/ybhagaab/botboy.git', 'a', 'b', 3),
      spawner: (...args) => { spawned.push(args); return { unref() {} }; } });
    expect((await u.check()).supported).toBe(false);
    expect(u.startUpdate()).toMatchObject({ ok: false, code: 'update_not_supported' });
    expect(spawned).toHaveLength(0);
  });

  it('launches start.sh --update detached, unref-ed, logging to a file', async () => {
    const projDir = tmp(); const dataDir = tmp();
    fs.writeFileSync(path.join(projDir, 'start.sh'), '#!/bin/bash\n');
    const calls: Array<{ cmd: string; args: string[]; opts: any; unref: boolean }> = [];
    const u = new AppUpdater({ projDir, dataDir, git: fakeGit('https://github.com/ybhagaab/botboy-app.git', 'a', 'b', 1),
      spawner: (cmd, args, opts) => { const c = { cmd, args, opts, unref: false }; calls.push(c); return { unref() { c.unref = true; } }; } });
    await u.check();
    const r = u.startUpdate();
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('/bin/bash');
    expect(calls[0].args).toEqual([path.join(projDir, 'start.sh'), '--update']);
    expect(calls[0].opts.detached).toBe(true);
    expect(calls[0].opts.stdio[0]).toBe('ignore');
    expect(calls[0].unref).toBe(true);
    expect(fs.existsSync((r as { logPath: string }).logPath)).toBe(true);
    // A second click while updating does not spawn again.
    u.startUpdate();
    expect(calls).toHaveLength(1);
    expect(u.status().updating).toBe(true);
  });

  it('detached options put the child in its own session', () => {
    const o = detachedUpdateOptions('/x', 9);
    expect(o).toMatchObject({ cwd: '/x', detached: true, stdio: ['ignore', 9, 9] });
  });

  it('start route is owner-UI only', async () => {
    const app = express();
    app.use(express.json());
    const u = new AppUpdater({ projDir: tmp(), git: fakeGit('https://github.com/ybhagaab/botboy-app.git', 'a', 'b', 1), spawner: () => ({ unref() {} }) });
    app.use(createAppUpdateRouter({ appUpdater: u } as any));
    const denied = await request(app).post('/app-update/start').send({});
    expect(denied.status).toBe(403);
    const status = await request(app).get('/app-update/status');
    expect(status.status).toBe(200);
  });
});
