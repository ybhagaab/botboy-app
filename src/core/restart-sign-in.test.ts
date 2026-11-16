import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { deviceCheckExpiry, lapseTime, readRestartSignInRisk, restartSignInMessage } from './restart-sign-in.js';
import { createAppUpdateRouter } from '../api/routers/app-update.js';

/**
 * Before a restart: whether it may cut Datanet off (docs/maps/midway-sentinel.md › Restart sign-in check). Live 2026-11-14:
 * Amazon's device check lapsed at 14:57, a restart at 18:33 started a new a2 connector, and every Datanet read was its
 * sign-in page until 21:36. The launcher (start.sh › restart_sign_in_warning) and the in-app Update (app-update router)
 * give the same words from the same rule; both are checked here against the same jars.
 */
const launcherPath = fileURLToPath(new URL('../../start.sh', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A Midway jar (names, domains and expiries as mwinit writes them; values are placeholders) and the connector's file. */
function mac(rows: Array<[string, string, number]>, options: { datanet?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-restart-sign-in-'));
  roots.push(root);
  const jar = path.join(root, 'cookie');
  fs.writeFileSync(jar, [
    '# Netscape HTTP Cookie File',
    ...rows.map(([domain, name, expiry]) => `${domain}\tTRUE\t/\tTRUE\t${expiry}\t${name}\tVALUE-NOT-READ`),
    '',
  ].join('\n'));
  const sentry = path.join(root, 'datanet_sentry_cookie');
  if (options.datanet !== false) fs.writeFileSync(sentry, '# Netscape HTTP Cookie File\n');
  return { jar, sentry };
}

function launcherSays(files: { jar: string; sentry: string }, nowS: number): string {
  const result = spawnSync('/bin/bash', [launcherPath], {
    cwd: path.dirname(launcherPath),
    env: {
      ...process.env,
      BOTBOY_NO_ARCH_REEXEC: '1',
      BOTBOY_TEST_RESTART_SIGN_IN: '1',
      BOTBOY_MIDWAY_COOKIE_FILE: files.jar,
      BOTBOY_DATANET_SENTRY_COOKIE_FILE: files.sentry,
      BOTBOY_TEST_NOW_EPOCH: String(nowS),
      PPT_LOG_FILE: path.join(path.dirname(files.jar), 'launcher.log'),
      PPT_PID_FILE: path.join(path.dirname(files.jar), 'ppt.pid'),
      PPT_STARTUP_SAFETY_BLOCK: path.join(path.dirname(files.jar), 'guard.json'),
      PPT_SHUTDOWN_RECEIPT_DIR: path.dirname(files.jar),
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

// 2026-11-14 23:40 local time, whole seconds (the launcher reads seconds).
const NOW_S = Math.floor(new Date(2026, 10, 14, 23, 40, 0).getTime() / 1000);
const MIDWAY = ['.midway-auth.amazon.com', '#HttpOnly_.auth.midway.aws.a2z.com', '.auth.midway.aws.dev', '.auth.midway.amazon.dev'];
const deviceCheck = (expiryS: number): Array<[string, string, number]> => MIDWAY.map(domain => [domain, 'amazon_enterprise_access', expiryS]);
const OTHER: Array<[string, string, number]> = [
  ['midway-auth.amazon.com', 'session', NOW_S + 20 * 3600],
  ['datanet-service.amazon.com', 'amzn_sso_token', NOW_S - 3600],
  ['.midway-auth.amazon.com', 'tpm_metrics', NOW_S + 18 * 3600],
];

describe('the restart sign-in check', () => {
  const cases: Array<{ name: string; rows: Array<[string, string, number]>; datanet?: boolean; atRisk: boolean; expiresAt?: number }> = [
    { name: 'the device check lapsed 4 minutes ago (the owner\'s Mac, 2026-11-14 23:40)', rows: [...OTHER, ...deviceCheck(NOW_S - 240)], atRisk: true, expiresAt: NOW_S - 240 },
    { name: 'it lapses in 5 minutes', rows: [...deviceCheck(NOW_S + 300), ...OTHER], atRisk: true, expiresAt: NOW_S + 300 },
    { name: 'it lapsed yesterday', rows: deviceCheck(NOW_S - 24 * 3600), atRisk: true, expiresAt: NOW_S - 24 * 3600 },
    { name: 'it lapses in 11 minutes (outside the margin)', rows: deviceCheck(NOW_S + 660), atRisk: false },
    { name: 'it is fine for another 2 hours', rows: deviceCheck(NOW_S + 7200), atRisk: false },
    { name: 'the latest of several rows counts', rows: [['.midway-auth.amazon.com', 'amazon_enterprise_access', NOW_S + 7000], ...deviceCheck(NOW_S - 7200)], atRisk: false },
    { name: 'a row without an expiry is not lapsed', rows: [...deviceCheck(NOW_S - 7200), ['.midway-auth.amazon.com', 'amazon_enterprise_access', 0]], atRisk: false },
    { name: 'a lapsed device check on another site does not count', rows: [['.example.com', 'amazon_enterprise_access', NOW_S - 600], ...OTHER], atRisk: false },
    { name: 'no device check in the jar says nothing', rows: OTHER, atRisk: false },
    { name: 'a Mac that does not use Datanet says nothing', rows: deviceCheck(NOW_S - 600), datanet: false, atRisk: false },
  ];
  for (const testCase of cases) {
    it(`${testCase.name}: the server and the launcher agree`, () => {
      const files = mac(testCase.rows, { datanet: testCase.datanet });
      const risk = readRestartSignInRisk({ cookiePath: files.jar, sentryCookiePath: files.sentry, nowMs: NOW_S * 1000 });
      expect(risk.atRisk).toBe(testCase.atRisk);
      const said = launcherSays(files, NOW_S);
      if (testCase.atRisk) {
        expect(risk.deviceCheckExpiresAt).toBe(testCase.expiresAt! * 1000);
        expect(risk.message).toBe(restartSignInMessage(testCase.expiresAt! * 1000, NOW_S * 1000));
        expect(said).toBe(`⚠️  ${risk.message}`);
      } else {
        expect(risk.message).toBeNull();
        expect(said).toBe('');
      }
    }, 30_000); // the launcher takes about 2 s to reach its test hook, more under a full suite
  }

  it('words a lapse in the past, a lapse to come, and one on another day', () => {
    const now = NOW_S * 1000;
    expect(restartSignInMessage(now - 240_000, now)).toBe("Amazon's device check lapsed at 23:36. Datanet still works on its earlier sign-in, but a restart makes it sign in again, which may be refused until you run mwinit -o -s. Run it first to avoid that.");
    expect(restartSignInMessage(now + 300_000, now)).toBe("Amazon's device check lapses at 23:45. A restart makes Datanet sign in again, which may be refused once it lapses, until you run mwinit -o -s. Run it first to avoid that.");
    expect(lapseTime(new Date(2026, 10, 13, 9, 5).getTime(), now)).toBe('Nov 13 09:05');
  });

  it('reads names, domains and expiries only: an unreadable jar or a malformed row says nothing', () => {
    expect(deviceCheckExpiry('#HttpOnly_.midway-auth.amazon.com\tTRUE\t/\tTRUE\tsoon\tamazon_enterprise_access\tx\n')).toBeNull();
    expect(deviceCheckExpiry('.midway-auth.amazon.com amazon_enterprise_access\n')).toBeNull();
    expect(readRestartSignInRisk({ cookiePath: '/nonexistent/cookie', sentryCookiePath: launcherPath, nowMs: NOW_S * 1000 }).atRisk).toBe(false);
  });

  it('the launcher warns before a restart only, never on a first start, and the restart goes on', () => {
    const launcher = fs.readFileSync(launcherPath, 'utf8');
    const takeover = launcher.slice(launcher.indexOf('safe_takeover() {'), launcher.indexOf('\n}\n', launcher.indexOf('safe_takeover() {')));
    expect(takeover).toContain('[ -z "$(discover_tracker_pids)" ] || restart_sign_in_warning');
    expect(takeover.indexOf('restart_sign_in_warning')).toBeLessThan(takeover.indexOf('stop_existing_server'));
    const warning = launcher.slice(launcher.indexOf('restart_sign_in_warning() {'), launcher.indexOf('\n}\n', launcher.indexOf('restart_sign_in_warning() {')));
    expect(warning).not.toMatch(/return 1|exit /);
  });
});

describe('the in-app Update while the device check has lapsed', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  });
  async function app(atRisk: boolean) {
    const started: number[] = [];
    const appUpdater = {
      check: async () => ({}),
      startUpdate: () => { started.push(1); return { ok: true, logPath: '/tmp/update.log' }; },
    };
    const server = express();
    server.use(express.json());
    server.use('/api', createAppUpdateRouter({
      appUpdater,
      restartSignInRisk: () => ({ atRisk, deviceCheckExpiresAt: atRisk ? 1 : null, message: atRisk ? 'Amazon\'s device check lapsed at 23:36. …' : null }),
    } as any));
    const listening = await new Promise<Server>((resolve) => { const live = server.listen(0, '127.0.0.1', () => resolve(live)); });
    servers.push(listening);
    const origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
    const owner = () => request(listening).post('/api/app-update/start').set('Origin', origin).set('Sec-Fetch-Site', 'same-origin');
    return { owner, started };
  }
  it('asks first, then starts once confirmed', async () => {
    const { owner, started } = await app(true);
    const first = await owner().send({});
    expect(first.status).toBe(409);
    expect(first.body).toEqual({ ok: false, code: 'sign_in_lapsed', error: 'Amazon\'s device check lapsed at 23:36. …', confirm: 'Update anyway?' });
    expect(started).toEqual([]);
    const confirmed = await owner().send({ confirmed: true });
    expect(confirmed.status).toBe(200);
    expect(started).toEqual([1]);
  });
  it('starts at once when the device check is fine', async () => {
    const { owner, started } = await app(false);
    expect((await owner().send({})).status).toBe(200);
    expect(started).toEqual([1]);
  });
});
