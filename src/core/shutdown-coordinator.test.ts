import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createStorage } from './storage.js';
import { createShutdownCoordinator } from './shutdown-coordinator.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return (server.address() as { port: number }).port;
}

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-shutdown-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'tracker.db');
  const receiptPath = path.join(root, 'shutdown.json');
  fs.writeFileSync(databasePath, 'synthetic-db');
  return { root, databasePath, receiptPath };
}

function get(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/ready' }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve(body));
    });
    request.on('error', reject);
  });
}

describe('shutdown coordinator', () => {
  it('closes admission and bounded stages before flushing and closing the database, then writes a clean atomic receipt', async () => {
    const box = sandbox();
    const order: string[] = [];
    const exitCodes: number[] = [];
    const server = http.createServer();
    const coordinator = createShutdownCoordinator({
      server,
      databasePath: box.databasePath,
      receiptPath: box.receiptPath,
      pid: 4242,
      httpGraceMs: 100,
      httpSettleMs: 50,
      hardDeadlineMs: 500,
      quiesce: () => { order.push('quiesce'); },
      closeStages: [
        { name: 'filesystem', timeoutMs: 100, close: async () => { order.push('filesystem'); } },
        { name: 'mcp', timeoutMs: 100, close: async () => { order.push('mcp'); } },
      ],
      beforeDatabaseClose: () => { order.push('bookkeeping'); },
      flushQueue: () => { order.push('flush'); },
      closeDatabase: () => { order.push('database'); },
      exit: code => { exitCodes.push(code); },
    });
    server.on('request', coordinator.wrapRequestHandler((_request, response) => response.end('ok')));
    const port = await listen(server);
    expect(await get(port)).toBe('ok');

    let unregister = () => {};
    unregister = coordinator.context.registerWork({
      id: 'turn-synthetic',
      kind: 'chat_turn',
      abort: () => unregister(),
    });
    const receipt = await coordinator.begin('SIGINT');

    expect(receipt.status).toBe('complete');
    expect(receipt.outcome).toBe('clean');
    expect(receipt.admission.shutdownSignalAborted).toBe(true);
    expect(receipt.http.listenerClosed).toBe(true);
    expect(receipt.http.destroyedSocketCount).toBe(0);
    expect(receipt.work.activeAtStart).toEqual([{ id: 'turn-synthetic', kind: 'chat_turn' }]);
    expect(receipt.work.remainingAtFinish).toEqual([]);
    expect(receipt.database).toMatchObject({ flushQueueCompleted: true, closed: true });
    expect(order.indexOf('database')).toBeGreaterThan(order.indexOf('filesystem'));
    expect(order.indexOf('database')).toBeGreaterThan(order.indexOf('mcp'));
    expect(order.slice(-3)).toEqual(['bookkeeping', 'flush', 'database']);
    expect(exitCodes).toEqual([0]);

    const diskText = fs.readFileSync(box.receiptPath, 'utf8');
    const disk = JSON.parse(diskText);
    expect(disk).toMatchObject({ pid: 4242, status: 'complete', outcome: 'clean' });
    expect(disk.database).not.toHaveProperty('path');
    expect(diskText).not.toContain(box.databasePath);
    expect(Date.parse(disk.startedAt)).toBeLessThanOrEqual(Date.parse(disk.updatedAt));
    expect(Date.parse(disk.completedAt)).toBeGreaterThanOrEqual(Date.parse(disk.startedAt));
    expect(Date.parse(disk.updatedAt)).toBeGreaterThanOrEqual(Date.parse(disk.completedAt));
    expect(fs.statSync(box.receiptPath).mode & 0o777).toBe(0o600);
  });

  it('destroys a stubborn owned HTTP socket after grace and records a forced but DB-closed outcome', async () => {
    const box = sandbox();
    const exitCodes: number[] = [];
    const server = http.createServer();
    const coordinator = createShutdownCoordinator({
      server,
      databasePath: box.databasePath,
      receiptPath: box.receiptPath,
      pid: 4343,
      httpGraceMs: 30,
      httpSettleMs: 50,
      hardDeadlineMs: 500,
      quiesce: () => {},
      closeStages: [],
      flushQueue: () => {},
      closeDatabase: () => {},
      exit: code => { exitCodes.push(code); },
    });
    server.on('request', coordinator.wrapRequestHandler(() => {
      // Deliberately never write or end: this models a handler stuck in model/tool work.
    }));
    const port = await listen(server);
    const client = http.request({ host: '127.0.0.1', port, path: '/api/chat/messages', method: 'POST' });
    client.on('error', () => {});
    client.end();
    await new Promise(resolve => setTimeout(resolve, 15));

    const receipt = await coordinator.begin('SIGINT');

    expect(receipt.status).toBe('complete');
    expect(receipt.outcome).toBe('forced');
    expect(receipt.forcedReasons).toContain('http_grace_timeout');
    expect(receipt.http.destroyedSocketCount).toBe(1);
    expect(receipt.database.closed).toBe(true);
    expect(exitCodes).toEqual([2]);
    client.destroy();
  });

  it('uses a second signal as real escalation and closes the database once without awaiting a stuck subsystem', async () => {
    const box = sandbox();
    const exitCodes: number[] = [];
    let closeCount = 0;
    let escalations = 0;
    const server = http.createServer();
    const coordinator = createShutdownCoordinator({
      server,
      databasePath: box.databasePath,
      receiptPath: box.receiptPath,
      pid: 4444,
      httpGraceMs: 100,
      httpSettleMs: 20,
      hardDeadlineMs: 2_000,
      quiesce: () => {},
      closeStages: [{ name: 'mcp', timeoutMs: 1_000, close: () => new Promise(() => {}) }],
      onEscalate: () => { escalations++; },
      flushQueue: () => {},
      closeDatabase: () => { closeCount++; },
      exit: code => { exitCodes.push(code); },
    });
    server.on('request', coordinator.wrapRequestHandler((_request, response) => response.end('ok')));
    await listen(server);

    const started = Date.now();
    const completion = coordinator.begin('SIGINT');
    coordinator.escalate('SIGTERM');
    const receipt = await completion;

    expect(Date.now() - started).toBeLessThan(500);
    expect(receipt.signals.map(signal => signal.name)).toEqual(['SIGINT', 'SIGTERM']);
    expect(receipt.escalation).toMatchObject({ requested: true, reason: 'second_signal' });
    expect(receipt.outcome).toBe('forced');
    expect(receipt.database.closed).toBe(true);
    expect(closeCount).toBe(1);
    expect(escalations).toBe(1);
    expect(exitCodes).toEqual([2]);
  });

  it('continues to DB-last finalization when a subsystem times out', async () => {
    const box = sandbox();
    const order: string[] = [];
    const server = http.createServer();
    const coordinator = createShutdownCoordinator({
      server,
      databasePath: box.databasePath,
      receiptPath: box.receiptPath,
      pid: 4545,
      httpGraceMs: 50,
      httpSettleMs: 20,
      hardDeadlineMs: 500,
      quiesce: () => {},
      closeStages: [{ name: 'filesystem', timeoutMs: 25, close: () => new Promise(() => {}) }],
      flushQueue: () => { order.push('flush'); },
      closeDatabase: () => { order.push('database'); },
      exit: () => {},
    });
    server.on('request', coordinator.wrapRequestHandler((_request, response) => response.end('ok')));
    await listen(server);

    const receipt = await coordinator.begin('SIGINT');

    expect(receipt.stages.find(stage => stage.name === 'filesystem')?.status).toBe('timed_out');
    expect(receipt.outcome).toBe('forced');
    expect(receipt.database.closed).toBe(true);
    expect(order).toEqual(['flush', 'database']);
  });
});

describe('shutdown SQLite boundary', () => {
  it('records the DB/WAL/SHM unit, closes SQLite last, and reopens with quick_check ok', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-shutdown-sqlite-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const databasePath = path.join(root, 'tracker.db');
    const receiptPath = path.join(root, 'shutdown.json');
    const storage = createStorage(databasePath);
    storage.initialize();
    storage.getDb().prepare("INSERT INTO nodes (id, title) VALUES ('shutdown_fixture', 'Synthetic shutdown fixture')").run();
    const server = http.createServer();
    const coordinator = createShutdownCoordinator({
      server,
      databasePath,
      receiptPath,
      pid: 4646,
      httpGraceMs: 100,
      httpSettleMs: 20,
      hardDeadlineMs: 500,
      quiesce: () => {},
      closeStages: [],
      flushQueue: () => storage.flushQueue(),
      closeDatabase: () => storage.close(),
      exit: () => {},
    });
    server.on('request', coordinator.wrapRequestHandler((_request, response) => response.end('ok')));
    await listen(server);

    const receipt = await coordinator.begin('SIGINT');
    expect(receipt.outcome).toBe('clean');
    expect(receipt.database.before?.db.exists).toBe(true);
    expect(receipt.database.before?.wal.exists).toBe(true);
    expect(receipt.database.before?.shm.exists).toBe(true);
    expect(receipt.database.closed).toBe(true);

    const reopened = new Database(databasePath, { readonly: true });
    try {
      expect(reopened.pragma('quick_check', { simple: true })).toBe('ok');
      expect((reopened.prepare("SELECT COUNT(*) AS count FROM nodes WHERE id='shutdown_fixture'").get() as { count: number }).count).toBe(1);
    } finally {
      reopened.close();
    }
  });
});


describe('launcher failed-start cleanup contract', () => {
  it('uses exact attempt-bound receipts and has no receipt-less takeover bypass', () => {
    const launcher = fs.readFileSync(new URL('../../start.sh', import.meta.url), 'utf8');
    const start = launcher.indexOf('stop_startup_child() {');
    const end = launcher.indexOf('\n# Teammate machines', start);
    const cleanup = launcher.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(launcher).toContain('STARTUP_INT_GRACE_SECONDS="${PPT_STARTUP_INT_GRACE_SECONDS:-20}"');
    expect(launcher).toContain('STARTUP_TERM_GRACE_SECONDS="${PPT_STARTUP_TERM_GRACE_SECONDS:-10}"');
    expect(cleanup).toContain('seq 1 "$STARTUP_INT_GRACE_SECONDS"');
    expect(cleanup).toContain('seq 1 "$STARTUP_TERM_GRACE_SECONDS"');
    expect(cleanup).toContain('shutdown_receipt_state "$receipt" "$server_pid" "$attempt_started_ms"');
    expect(cleanup).toContain('write_startup_safety_block "$server_pid" "$attempt_started_ms"');
    expect(cleanup).toContain('scrub_shutdown_receipt "$receipt" "$server_pid"');
    expect(cleanup).toContain('exact, fresh DB-last closure');
    expect(cleanup).not.toContain('seq 1 5');

    const safetyStart = launcher.indexOf('startup_safety_allows_takeover() {');
    const takeoverEnd = launcher.indexOf('\nforeground_shutdown()', safetyStart);
    const takeover = launcher.slice(safetyStart, takeoverEnd);
    expect(launcher).toContain('value.pid !== expectedPid');
    expect(launcher).toContain('Math.max(...signalTimes) < notBeforeMs');
    expect(launcher).toContain('schemaVersion: 2');
    expect(launcher).toContain('pids.length > 20');
    expect(launcher).toContain('BOTBOY_TEST_EXISTING_CLEANUP_PID');
    expect(takeover).toContain('lacks exact, fresh DB-last closure');
    expect(launcher).not.toContain('legacy takeover');
    expect(launcher).toContain('[ "$1" = "--recover-shutdown" ] && RECOVER_SHUTDOWN=1');
    expect(launcher).toContain('exec "$NODE" "$RECOVERY_SCRIPT"');
    expect(launcher).toContain('shutdown recovery: BLOCKED helper=missing next=update-without-start');
    expect(launcher.indexOf('Update paused: an earlier shutdown is still unverified'))
      .toBeLessThan(launcher.indexOf('git -C "$PROJ_DIR" pull --ff-only'));
    const stopStart = launcher.indexOf('if [ "$STOP_ONLY" = "1" ]; then');
    const stopEnd = launcher.indexOf('\n# ── --doctor', stopStart);
    const stopBlock = launcher.slice(stopStart, stopEnd);
    expect(stopBlock.indexOf('BotBoy stop refused: an earlier shutdown guard is unresolved'))
      .toBeLessThan(stopBlock.indexOf("pgrep -f 'node dist/index.js'"));
  });

  it('executes PID/freshness binding, private-path scrubbing, blocked retry, late recovery, and receipt-less refusal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-launcher-cleanup-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixturePath = path.join(root, 'child.mjs');
    fs.writeFileSync(fixturePath, `
      import fs from 'node:fs';
      import path from 'node:path';
      const [receiptDir, mode] = process.argv.slice(2);
      const writeReceipt = (pid, outcome, offsetMs = 0) => {
        const stamp = new Date(Date.now() + offsetMs).toISOString();
        fs.writeFileSync(path.join(receiptDir, \`ppt-shutdown-\${process.pid}.json\`), JSON.stringify({
          schemaVersion: 1,
          pid,
          status: 'complete',
          outcome,
          startedAt: stamp,
          updatedAt: stamp,
          completedAt: stamp,
          signals: [{ name: 'SIGTERM', at: stamp, ordinal: 1 }],
          database: { closed: true, closeStartedAt: stamp, closedAt: stamp, path: '/Users/synthetic/private/tracker.db' },
        }));
      };
      process.on('SIGINT', () => {
        if (mode === 'unforced-missing') process.exit(0);
      });
      process.on('SIGTERM', () => {
        if (mode === 'forced') {
          writeReceipt(process.pid, 'forced');
          process.exit(2);
        }
        if (mode === 'wrong-pid') {
          writeReceipt(process.pid + 1, 'forced');
          process.exit(2);
        }
        if (mode === 'stale') {
          writeReceipt(process.pid, 'forced', -60_000);
          process.exit(2);
        }
      });
      console.log('ready');
      setInterval(() => {}, 1000);
    `);
    const launcherPath = fileURLToPath(new URL('../../start.sh', import.meta.url));
    const pidFile = path.join(root, 'ppt.pid');
    const safetyBlock = path.join(root, 'startup-block.json');
    const baseEnv = {
      ...process.env,
      PPT_LOG_FILE: path.join(root, 'launcher.log'),
      PPT_PID_FILE: pidFile,
      PPT_STARTUP_SAFETY_BLOCK: safetyBlock,
      PPT_SHUTDOWN_RECEIPT_DIR: root,
      PPT_STARTUP_INT_GRACE_SECONDS: '1',
      PPT_STARTUP_TERM_GRACE_SECONDS: '1',
    };
    const startChild = async (mode: 'forced' | 'wrong-pid' | 'stale' | 'missing' | 'unforced-missing') => {
      const child = spawn(process.execPath, [fixturePath, root, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
      cleanups.push(() => { try { child.kill('SIGKILL'); } catch {} });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('synthetic launcher child did not become ready')), 5_000);
        child.stdout.on('data', chunk => {
          if (String(chunk).includes('ready')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once('error', reject);
      });
      fs.writeFileSync(pidFile, String(child.pid));
      return child;
    };
    const runLauncher = (env: Record<string, string | undefined>) => spawnSync('/bin/bash', [launcherPath], {
      cwd: path.dirname(launcherPath),
      env: { ...baseEnv, ...env },
      encoding: 'utf8',
      timeout: 15_000,
    });
    const writeLateReceipt = (
      targetPid: number,
      timestampMs: number,
      outcome: 'clean' | 'failed' = 'failed',
      embeddedPid: number = targetPid,
      signalTimestampMs: number = timestampMs,
    ) => {
      const stamp = new Date(timestampMs).toISOString();
      const signalStamp = new Date(signalTimestampMs).toISOString();
      fs.writeFileSync(path.join(root, `ppt-shutdown-${targetPid}.json`), JSON.stringify({
        schemaVersion: 1,
        pid: embeddedPid,
        status: 'complete',
        outcome,
        startedAt: stamp,
        updatedAt: stamp,
        completedAt: stamp,
        signals: [{ name: 'SIGTERM', at: signalStamp, ordinal: 1 }],
        database: { closed: true, closeStartedAt: stamp, closedAt: stamp, path: '/Users/synthetic/private/tracker.db' },
      }));
    };

    const forced = await startChild('forced');
    const forcedRun = runLauncher({ BOTBOY_TEST_STARTUP_CLEANUP_PID: String(forced.pid) });
    expect(forcedRun.status).toBe(2);
    expect(forcedRun.stdout).toContain('required bounded cleanup but proved SQLite closed');
    expect(fs.existsSync(safetyBlock)).toBe(false);
    const forcedReceiptPath = path.join(root, `ppt-shutdown-${forced.pid}.json`);
    const forcedReceipt = JSON.parse(fs.readFileSync(forcedReceiptPath, 'utf8'));
    expect(forcedReceipt).toMatchObject({ pid: forced.pid, outcome: 'forced', database: { closed: true } });
    expect(forcedReceipt.database).not.toHaveProperty('path');
    expect(fs.statSync(forcedReceiptPath).mode & 0o777).toBe(0o600);

    const wrongPid = await startChild('wrong-pid');
    const wrongPidRun = runLauncher({ BOTBOY_TEST_STARTUP_CLEANUP_PID: String(wrongPid.pid) });
    expect(wrongPidRun.status).toBe(1);
    expect(wrongPidRun.stdout).toContain('pid_mismatch');
    expect(fs.statSync(safetyBlock).mode & 0o777).toBe(0o600);

    const stale = await startChild('stale');
    const staleRun = runLauncher({ BOTBOY_TEST_STARTUP_CLEANUP_PID: String(stale.pid) });
    expect(staleRun.status).toBe(1);
    expect(staleRun.stdout).toContain('(stale)');

    const missing = await startChild('missing');
    const missingRun = runLauncher({ BOTBOY_TEST_STARTUP_CLEANUP_PID: String(missing.pid) });
    expect(missingRun.status).toBe(1);
    expect(missingRun.stdout).toContain('Replacement starts are blocked');
    const missingGuard = JSON.parse(fs.readFileSync(safetyBlock, 'utf8'));
    expect(missingGuard).toMatchObject({
      schemaVersion: 2,
      reason: 'startup_child_shutdown_unverified',
      targets: [{ pid: missing.pid }],
    });
    const missingBoundary = Number(missingGuard.targets[0].notBeforeMs);

    writeLateReceipt(missing.pid ?? 0, Date.now(), 'failed', (missing.pid ?? 0) + 1);
    const wrongLate = runLauncher({ BOTBOY_TEST_STARTUP_SAFETY_CHECK: '1' });
    expect(wrongLate.status).toBe(1);
    expect(wrongLate.stdout).toContain('pid_mismatch');

    writeLateReceipt(missing.pid ?? 0, missingBoundary - 1_000);
    const staleLate = runLauncher({ BOTBOY_TEST_STARTUP_SAFETY_CHECK: '1' });
    expect(staleLate.status).toBe(1);
    expect(staleLate.stdout).toContain('(stale)');

    const impossibleBase = Math.max(Date.now(), missingBoundary + 1);
    writeLateReceipt(missing.pid ?? 0, impossibleBase, 'failed', missing.pid ?? 0, impossibleBase + 60_000);
    const futureSignal = runLauncher({ BOTBOY_TEST_STARTUP_SAFETY_CHECK: '1' });
    expect(futureSignal.status).toBe(1);
    expect(futureSignal.stdout).toContain('invalid_signal_chronology');

    const missingReceiptPath = path.join(root, `ppt-shutdown-${missing.pid}.json`);
    writeLateReceipt(missing.pid ?? 0, Date.now());
    const malformedSignals = JSON.parse(fs.readFileSync(missingReceiptPath, 'utf8'));
    malformedSignals.signals.push({ name: 'SIGTERM', at: 'not-a-time', ordinal: 2 });
    fs.writeFileSync(missingReceiptPath, JSON.stringify(malformedSignals));
    const malformedSignalRun = runLauncher({ BOTBOY_TEST_STARTUP_SAFETY_CHECK: '1' });
    expect(malformedSignalRun.status).toBe(1);
    expect(malformedSignalRun.stdout).toContain('invalid_signals');

    writeLateReceipt(missing.pid ?? 0, Date.now());
    const invalidClose = JSON.parse(fs.readFileSync(missingReceiptPath, 'utf8'));
    invalidClose.database.closedAt = new Date(Date.parse(invalidClose.completedAt) + 60_000).toISOString();
    fs.writeFileSync(missingReceiptPath, JSON.stringify(invalidClose));
    const invalidCloseRun = runLauncher({ BOTBOY_TEST_STARTUP_SAFETY_CHECK: '1' });
    expect(invalidCloseRun.status).toBe(1);
    expect(invalidCloseRun.stdout).toContain('invalid_database_timestamps');

    writeLateReceipt(missing.pid ?? 0, Date.now());
    const staleMtime = new Date(missingBoundary - 1_000);
    fs.utimesSync(missingReceiptPath, staleMtime, staleMtime);
    const staleMtimeRun = runLauncher({ BOTBOY_TEST_STARTUP_SAFETY_CHECK: '1' });
    expect(staleMtimeRun.status).toBe(1);
    expect(staleMtimeRun.stdout).toContain('(stale)');

    writeLateReceipt(missing.pid ?? 0, Date.now());
    const lateClosed = runLauncher({ BOTBOY_TEST_STARTUP_SAFETY_CHECK: '1' });
    expect(lateClosed.status).toBe(0);
    expect(lateClosed.stdout).toContain('Cleared shutdown safety block');
    expect(fs.existsSync(safetyBlock)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root, `ppt-shutdown-${missing.pid}.json`), 'utf8')).database)
      .not.toHaveProperty('path');

    const unforcedMissing = await startChild('unforced-missing');
    const unforcedRun = runLauncher({ BOTBOY_TEST_EXISTING_CLEANUP_PID: String(unforcedMissing.pid) });
    expect(unforcedRun.status).toBe(1);
    expect(unforcedRun.stdout).toContain('process exit is not DB-closure proof');
    expect(unforcedRun.stdout).not.toContain('legacy takeover');
    expect(fs.existsSync(safetyBlock)).toBe(true);

    const blockedRetry = runLauncher({ BOTBOY_TEST_STARTUP_SAFETY_CHECK: '1' });
    expect(blockedRetry.status).toBe(1);
    expect(blockedRetry.stdout).toContain('Replacement start blocked');
    const ordinaryGuard = JSON.parse(fs.readFileSync(safetyBlock, 'utf8'));
    writeLateReceipt(unforcedMissing.pid ?? 0, Math.max(Date.now(), Number(ordinaryGuard.targets[0].notBeforeMs) + 1), 'clean');
    const recoveredRetry = runLauncher({ BOTBOY_TEST_STARTUP_SAFETY_CHECK: '1' });
    expect(recoveredRetry.status).toBe(0);
    expect(fs.existsSync(safetyBlock)).toBe(false);

    const multiNow = Date.now();
    const multiBoundary = multiNow - 2_000;
    const multiPids = [910001, 910002];
    fs.writeFileSync(safetyBlock, JSON.stringify({
      schemaVersion: 2,
      reason: 'tracker_shutdown_unverified',
      createdAt: new Date().toISOString(),
      targets: multiPids.map(pid => ({ pid, notBeforeMs: multiBoundary })),
    }), { mode: 0o600 });
    writeLateReceipt(multiPids[0], multiNow, 'clean');
    writeLateReceipt(multiPids[1], multiNow, 'clean');
    const reversedReceiptPath = path.join(root, `ppt-shutdown-${multiPids[1]}.json`);
    const reversedReceipt = JSON.parse(fs.readFileSync(reversedReceiptPath, 'utf8'));
    reversedReceipt.startedAt = new Date(multiNow - 1_000).toISOString();
    reversedReceipt.signals = [
      { name: 'SIGINT', at: new Date(multiNow - 100).toISOString(), ordinal: 1 },
      { name: 'SIGTERM', at: new Date(multiNow - 200).toISOString(), ordinal: 2 },
    ];
    reversedReceipt.database.closeStartedAt = new Date(multiNow - 80).toISOString();
    reversedReceipt.database.closedAt = new Date(multiNow - 60).toISOString();
    fs.writeFileSync(reversedReceiptPath, JSON.stringify(reversedReceipt));
    const multiBlocked = runLauncher({ BOTBOY_TEST_STARTUP_SAFETY_CHECK: '1' });
    expect(multiBlocked.status).toBe(1);
    expect(multiBlocked.stdout).toContain(`PID ${multiPids[1]}`);
    expect(multiBlocked.stdout).toContain('invalid_signal_chronology');
    expect(fs.existsSync(safetyBlock)).toBe(true);

    writeLateReceipt(multiPids[1], Date.now(), 'clean');
    const multiRecovered = runLauncher({ BOTBOY_TEST_STARTUP_SAFETY_CHECK: '1' });
    expect(multiRecovered.status).toBe(0);
    expect(fs.existsSync(safetyBlock)).toBe(false);
  }, 30_000);
});

describe('receipt-less shutdown recovery composite', () => {
  const recoveryScript = fileURLToPath(new URL('../../scripts/recover-shutdown.mjs', import.meta.url));

  function recoveryFixture(targetPid: number) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-receiptless-recovery-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const databasePath = path.join(root, 'tracker.db');
    const guardPath = path.join(root, 'startup-guard.json');
    const pidFile = path.join(root, 'ppt.pid');
    const backupRoot = path.join(root, 'backups');
    const storage = createStorage(databasePath);
    storage.initialize();
    storage.getDb().prepare("INSERT INTO nodes (id, title) VALUES ('recovery_fixture', 'Receipt-less recovery')").run();
    storage.close();
    const guard = {
      schemaVersion: 2,
      reason: 'tracker_shutdown_unverified',
      createdAt: new Date().toISOString(),
      targets: [{ pid: targetPid, notBeforeMs: Date.now() - 100 }],
    };
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(pidFile, String(targetPid), { mode: 0o600 });
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      BOTBOY_TEST_RECOVERY_ISOLATED: '1',
      PPT_STARTUP_SAFETY_BLOCK: guardPath,
      PPT_SHUTDOWN_RECEIPT_DIR: root,
      PPT_PID_FILE: pidFile,
      PPT_RECOVERY_DATABASE_PATH: databasePath,
      PPT_RECOVERY_BACKUP_ROOT: backupRoot,
    };
    return { root, databasePath, guardPath, backupRoot, env };
  }

  it('inspects an unresolved guard without changing its bytes or mtime', () => {
    const box = recoveryFixture(987_654_321);
    const before = fs.statSync(box.guardPath);
    const bytes = fs.readFileSync(box.guardPath);

    const result = spawnSync(process.execPath, [recoveryScript, '--inspect'], {
      env: box.env,
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('shutdown recovery: BLOCKED');
    expect(result.stdout).toContain('targetCount=1');
    expect(result.stdout).toContain('targets=987654321:not-live:missing');
    expect(fs.readFileSync(box.guardPath)).toEqual(bytes);
    expect(fs.statSync(box.guardPath).mtimeMs).toBe(before.mtimeMs);
  });

  it('refuses a live guard target and leaves the original guard in place', () => {
    const box = recoveryFixture(process.pid);
    const bytes = fs.readFileSync(box.guardPath);

    const result = spawnSync(process.execPath, [recoveryScript], {
      env: box.env,
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Guard target PID(s) still live: ${process.pid}`);
    expect(fs.readFileSync(box.guardPath)).toEqual(bytes);
    expect(fs.existsSync(box.backupRoot)).toBe(false);
  });

  it('refuses an open database handle and retains the guard', () => {
    const box = recoveryFixture(987_654_321);
    const openDatabase = new Database(box.databasePath, { fileMustExist: true });
    try {
      const result = spawnSync(process.execPath, [recoveryScript], {
        env: box.env,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('database family still has open handles');
      expect(fs.existsSync(box.guardPath)).toBe(true);
    } finally {
      openDatabase.close();
    }
  });

  it('recovers a valid multi-target guard only after every target is not live', () => {
    const box = recoveryFixture(987_654_321);
    const guard = JSON.parse(fs.readFileSync(box.guardPath, 'utf8'));
    guard.targets.push({ pid: 987_654_322, notBeforeMs: Date.now() - 50 });
    fs.writeFileSync(box.guardPath, `${JSON.stringify(guard, null, 2)}\n`, { mode: 0o600 });

    const result = spawnSync(process.execPath, [recoveryScript], {
      env: box.env,
      encoding: 'utf8',
      timeout: 20_000,
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(box.guardPath)).toBe(false);
    const snapshots = fs.readdirSync(box.backupRoot);
    expect(snapshots).toHaveLength(1);
    const boundary = JSON.parse(fs.readFileSync(
      path.join(box.backupRoot, snapshots[0], 'source-boundary.json'),
      'utf8',
    ));
    expect(boundary.targetPids).toEqual([987_654_321, 987_654_322]);
  });

  it('snapshots and verifies the stopped DB family, archives the guard, and never claims a clean shutdown', () => {
    const box = recoveryFixture(987_654_321);
    const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(box.databasePath)).digest('hex');

    const result = spawnSync(process.execPath, [recoveryScript], {
      env: box.env,
      encoding: 'utf8',
      timeout: 20_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('quick_check=ok, foreign_key_violations=0');
    expect(result.stdout).toContain('does NOT claim the old process closed cleanly');
    expect(result.stdout).not.toContain('stopped cleanly');
    expect(fs.existsSync(box.guardPath)).toBe(false);
    const archivedGuards = fs.readdirSync(box.root).filter(name => name.startsWith('startup-guard.json.archived-'));
    expect(archivedGuards).toHaveLength(1);

    const snapshots = fs.readdirSync(box.backupRoot);
    expect(snapshots).toHaveLength(1);
    const snapshot = path.join(box.backupRoot, snapshots[0]);
    const exactDatabase = path.join(snapshot, 'exact', 'tracker.db');
    expect(fs.existsSync(exactDatabase)).toBe(true);
    expect(crypto.createHash('sha256').update(fs.readFileSync(exactDatabase)).digest('hex')).toBe(sourceHash);
    expect(fs.statSync(snapshot).mode & 0o777).toBe(0o700);
    expect(fs.statSync(exactDatabase).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(snapshot, 'guard-copy.json'))).toBe(true);
    expect(fs.existsSync(path.join(snapshot, 'guard-archived-from-tmp.json'))).toBe(true);

    const reopened = new Database(box.databasePath, { readonly: true, fileMustExist: true });
    try {
      expect(reopened.pragma('quick_check', { simple: true })).toBe('ok');
      expect((reopened.prepare("SELECT COUNT(*) AS count FROM nodes WHERE id='recovery_fixture'").get() as { count: number }).count).toBe(1);
    } finally {
      reopened.close();
    }
  });
});
