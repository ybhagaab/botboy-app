#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const guardPath = process.env.PPT_STARTUP_SAFETY_BLOCK || '/tmp/ppt-startup-safety-block.json';
const receiptDir = process.env.PPT_SHUTDOWN_RECEIPT_DIR || '/tmp';
const pidFile = process.env.PPT_PID_FILE || '/tmp/ppt.pid';
const databasePath = process.env.PPT_RECOVERY_DATABASE_PATH
  || path.join(os.homedir(), '.personal-productivity-tracker', 'tracker.db');
const backupRoot = process.env.PPT_RECOVERY_BACKUP_ROOT
  || path.join(os.homedir(), '.personal-productivity-tracker', 'recovery-backups');
// macOS ships SQLite (with FTS5) in the base system. Recovery falls back to it
// when better-sqlite3 cannot open a database in this Node.
const sqliteCli = process.env.PPT_RECOVERY_SQLITE_CLI || '/usr/bin/sqlite3';
const inspectOnly = process.argv.includes('--inspect');
const testIsolation = process.env.BOTBOY_TEST_RECOVERY_ISOLATED === '1';
if (testIsolation && process.env.NODE_ENV !== 'test') {
  throw new Error('BOTBOY_TEST_RECOVERY_ISOLATED is test-only');
}

function fail(message) {
  const error = new Error(message);
  error.name = 'ShutdownRecoveryRefused';
  throw error;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function oneLine(error) {
  return String(error?.message ?? error).replace(/\s+/g, ' ').trim().slice(0, 240) || 'unknown error';
}

function guardIsAbsent() {
  try {
    fs.lstatSync(guardPath);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

function assertRegularFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail(`${label} is missing: ${file}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file: ${file}`);
  return stat;
}

function parseGuard() {
  assertRegularFile(guardPath, 'Shutdown safety guard');
  const value = readJson(guardPath);
  if (value?.schemaVersion !== 2
      || !['tracker_shutdown_unverified', 'startup_child_shutdown_unverified'].includes(value.reason)
      || !Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > 20) {
    fail('Shutdown safety guard must be schema v2 with 1-20 recognized targets');
  }
  const seen = new Set();
  const targets = value.targets.map(target => {
    if (!Number.isInteger(target?.pid) || target.pid <= 0
        || !Number.isFinite(target?.notBeforeMs) || target.notBeforeMs <= 0
        || seen.has(target.pid)) {
      fail('Shutdown safety guard contains an invalid or duplicate target');
    }
    seen.add(target.pid);
    return { pid: target.pid, notBeforeMs: target.notBeforeMs };
  });
  if (!Number.isFinite(Date.parse(value.createdAt))) fail('Shutdown safety guard timestamp is invalid');
  return { value, targets };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) fail(`Required recovery command is unavailable: ${command}`);
  return result;
}

function pidIsLive(pid) {
  const result = run('ps', ['-p', String(pid), '-o', 'stat=']);
  const state = result.status === 0 ? result.stdout.trim() : '';
  return Boolean(state) && !state.startsWith('Z');
}

/** Start time of a live process, from `ps -o etime=` ([[dd-]hh:]mm:ss); null when unknown. */
function processStartMs(pid) {
  const result = run('ps', ['-p', String(pid), '-o', 'etime=']);
  const text = result.status === 0 ? result.stdout.trim() : '';
  const match = text.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [, days = '0', hours = '0', minutes, seconds] = match;
  const elapsedSeconds = ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
  return Date.now() - elapsedSeconds * 1000;
}

function processCommand(pid) {
  const result = run('ps', ['-ww', '-p', String(pid), '-o', 'command=']);
  return result.status === 0 ? result.stdout.trim() : '';
}

/**
 * `live`: the guarded BotBoy still runs. `reused`: the PID now belongs to a
 * process that started after the guard's boundary, so the guarded one is gone
 * (macOS reuses PIDs). `other`: the PID runs something that is not the BotBoy
 * server; launchers before 2026-10-07 could guard such a process from a stale
 * PID file. `not-live`: nothing runs under it. An unknown start time counts as
 * live, and recovery then refuses, which is the safe side. For `reused` and
 * `other`, the tracker, port 7778, and open-database checks still protect the
 * database.
 */
function targetState(target) {
  if (!pidIsLive(target.pid)) return 'not-live';
  const startedAt = processStartMs(target.pid);
  // etime has one-second resolution; the margin keeps a borderline case live.
  if (startedAt !== null && startedAt > target.notBeforeMs + 2_000) return 'reused';
  const command = processCommand(target.pid);
  return command && !command.includes('node dist/index.js') ? 'other' : 'live';
}

function listedPids(command, args) {
  const result = run(command, args);
  if (result.status !== 0 && result.status !== 1) fail(`${command} inspection failed`);
  return result.stdout.split(/\s+/).filter(value => /^\d+$/.test(value)).map(Number);
}

function trackerPids() {
  // Same match as the launcher's takeover/stop (`pgrep -f 'node dist/index.js'`):
  // start.sh always runs the server as `<node> dist/index.js` from the package
  // folder. The earlier `node .*dist/index.js` also matched every node MCP
  // server on the machine (Kiro's, BotBoy's own connector children), so
  // recovery refused while BotBoy was fully stopped. `[n]` keeps a shell
  // running this pattern from matching itself. A BotBoy started any other way
  // is still caught by the :7778 listener and open-database-handle checks.
  return testIsolation ? [] : listedPids('pgrep', ['-f', '[n]ode dist/index.js']);
}

function listenerPids() {
  return testIsolation ? [] : listedPids('lsof', ['-nP', '-tiTCP:7778', '-sTCP:LISTEN']);
}

function openHandlePids(files) {
  if (!files.length) return [];
  return listedPids('lsof', ['-t', ...files]);
}

function sha256(file) {
  // Chunked: readFileSync cannot hold files above 2 GiB, and a tracker
  // database family routinely grows past that.
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function fileState(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`Recovery source must be a regular non-symlink file: ${file}`);
    return { exists: true, bytes: stat.size, mtimeMs: stat.mtimeMs, sha256: sha256(file) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, bytes: null, mtimeMs: null, sha256: null };
    throw error;
  }
}

function familyState(files) {
  return Object.fromEntries(files.map(file => [path.basename(file), fileState(file)]));
}

function copyExact(source, destination) {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  if (sha256(source) !== sha256(destination)) fail(`Exact-copy verification failed for ${path.basename(source)}`);
}

function sameState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function contentState(state) {
  return Object.fromEntries(Object.entries(state).map(([name, value]) => [name, {
    exists: value.exists,
    bytes: value.bytes,
    sha256: value.sha256,
  }]));
}

function inspect() {
  if (!fs.existsSync(guardPath)) {
    console.log('shutdown recovery: no active safety guard');
    return;
  }
  try {
    const { value, targets } = parseGuard();
    const states = targets.map(target => {
      const receipt = path.join(receiptDir, `ppt-shutdown-${target.pid}.json`);
      return `${target.pid}:${targetState(target)}:${fs.existsSync(receipt) ? 'receipt' : 'missing'}`;
    });
    console.log([
      'shutdown recovery: BLOCKED',
      `reason=${value.reason}`,
      `targetCount=${targets.length}`,
      `targets=${states.join(',')}`,
      'next=./start.sh --recover-shutdown',
    ].join(' '));
  } catch (error) {
    console.log(`shutdown recovery: BLOCKED guard=invalid next=contact-owner detail=${String(error.message).slice(0, 160)}`);
  }
}

async function recover() {
  const { value: guard, targets } = parseGuard();
  const liveTargets = targets.filter(target => targetState(target) === 'live').map(target => target.pid);
  if (liveTargets.length) {
    const described = liveTargets.map(pid => {
      const command = processCommand(pid).slice(0, 120);
      return command ? `${pid} (${command})` : String(pid);
    });
    fail(`Guard target PID(s) still live: ${described.join(', ')}. `
      + `That is the old BotBoy; stop it: kill -INT ${liveTargets.join(' ')}, wait 30 seconds, then run ./start.sh `
      + '(a receipt it writes clears the guard) or ./start.sh --recover-shutdown again.');
  }
  const servers = trackerPids();
  if (servers.length) {
    fail(`BotBoy process still exists (${servers.join(', ')}). Stop it: kill -INT ${servers.join(' ')}, wait 30 seconds, then retry.`);
  }
  const listeners = listenerPids();
  if (listeners.length) {
    fail(`Port 7778 still has a listener (${listeners.join(', ')}). Find it with: lsof -nP -iTCP:7778 -sTCP:LISTEN`);
  }

  const family = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  const existing = family.filter(file => fs.existsSync(file));
  if (!existing.length) {
    // Nothing to protect: the data folder was removed (a factory reset). No
    // guarded process, BotBoy, or listener is left, so a new start creates a
    // fresh database. The archived guard keeps the evidence.
    archiveGuardWithoutDatabase(guard, targets);
    return;
  }
  if (!existing.includes(databasePath)) {
    fail(`${path.basename(databasePath)} is missing but ${existing.map(file => path.basename(file)).join(' and ')} remain; send the owner ./start.sh --doctor output and keep these files`);
  }
  assertRegularFile(databasePath, 'Tracker database');
  const handles = openHandlePids(existing);
  if (handles.length) fail(`Tracker database family still has open handles (${[...new Set(handles)].join(', ')})`);
  const verifier = await loadVerifier();

  const before = familyState(family);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const targetLabel = targets.length === 1 ? String(targets[0].pid) : `${targets.length}-targets`;
  const snapshot = path.join(backupRoot, `receiptless-${targetLabel}-${stamp}`);
  const exactDir = path.join(snapshot, 'exact');
  const verifyDir = path.join(snapshot, 'verify');
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupRoot, 0o700);
  fs.mkdirSync(snapshot, { mode: 0o700 });
  fs.mkdirSync(exactDir, { mode: 0o700 });
  fs.mkdirSync(verifyDir, { mode: 0o700 });

  fs.writeFileSync(path.join(snapshot, 'source-boundary.json'), `${JSON.stringify({
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    guardReason: guard.reason,
    targetPids: targets.map(target => target.pid),
    unverifiedShutdown: true,
    integrityVerifier: verifier.name,
    source: before,
  }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });

  for (const source of existing) {
    copyExact(source, path.join(exactDir, path.basename(source)));
    copyExact(source, path.join(verifyDir, path.basename(source)));
  }
  copyExact(guardPath, path.join(snapshot, 'guard-copy.json'));
  for (const target of targets) {
    const receiptPath = path.join(receiptDir, `ppt-shutdown-${target.pid}.json`);
    if (!fs.existsSync(receiptPath)) continue;
    assertRegularFile(receiptPath, `Shutdown receipt for PID ${target.pid}`);
    copyExact(receiptPath, path.join(snapshot, `receipt-${target.pid}.json`));
  }
  if (fs.existsSync(pidFile)) {
    assertRegularFile(pidFile, 'PID file');
    copyExact(pidFile, path.join(snapshot, 'pid-file-copy'));
  }

  const afterCopy = familyState(family);
  if (!sameState(before, afterCopy)) fail(`Database family changed during snapshot; guard retained. Evidence: ${snapshot}`);
  if (trackerPids().length || listenerPids().length || openHandlePids(existing).length) {
    fail(`Runtime state changed during snapshot; guard retained. Evidence: ${snapshot}`);
  }

  const verifyDatabase = path.join(verifyDir, path.basename(databasePath));
  let integrity;
  try {
    integrity = verifier.check(verifyDatabase);
  } catch (error) {
    fail(`Copied database could not be checked with ${verifier.name} (${oneLine(error)}); guard retained. Evidence: ${snapshot}`);
  }
  const { quickCheck, foreignKeyViolations } = integrity;
  if (quickCheck !== 'ok' || foreignKeyViolations !== 0) {
    fail(`Copied database integrity failed (quick_check=${quickCheck}, foreign_key_violations=${foreignKeyViolations}); guard retained. Evidence: ${snapshot}`);
  }
  const exactAfterVerify = familyState(family.map(file => path.join(exactDir, path.basename(file))));
  if (!sameState(contentState(before), contentState(exactAfterVerify))) {
    fail(`Exact backup changed during disposable verification; guard retained. Evidence: ${snapshot}`);
  }
  if (!sameState(before, familyState(family)) || trackerPids().length || listenerPids().length || openHandlePids(existing).length) {
    fail(`Source state changed before guard archive; guard retained. Evidence: ${snapshot}`);
  }

  const archivedGuard = `${guardPath}.archived-${stamp}`;
  if (fs.existsSync(archivedGuard)) fail(`Guard archive already exists: ${archivedGuard}`);
  fs.renameSync(guardPath, archivedGuard);
  copyExact(archivedGuard, path.join(snapshot, 'guard-archived-from-tmp.json'));

  console.log(`✅ Exact stopped DB/WAL/SHM snapshot: ${exactDir}`);
  console.log(`✅ Disposable copy verified: quick_check=ok, foreign_key_violations=0 (${verifier.name})`);
  console.log(`⚠️  Archived unverified shutdown guard: ${archivedGuard}`);
  console.log('    This recovery does NOT claim the old process closed cleanly.');
  console.log('    Next: ./start.sh');
  console.log('    Keep the snapshot; never restore tracker.db without its matching WAL/SHM and related private state.');
}

function archiveGuardWithoutDatabase(guard, targets) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const targetLabel = targets.length === 1 ? String(targets[0].pid) : `${targets.length}-targets`;
  const snapshot = path.join(backupRoot, `receiptless-${targetLabel}-${stamp}`);
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupRoot, 0o700);
  fs.mkdirSync(snapshot, { mode: 0o700 });
  fs.writeFileSync(path.join(snapshot, 'source-boundary.json'), `${JSON.stringify({
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    guardReason: guard.reason,
    targetPids: targets.map(target => target.pid),
    unverifiedShutdown: true,
    databaseFamilyPresent: false,
    source: familyState([databasePath, `${databasePath}-wal`, `${databasePath}-shm`]),
  }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  copyExact(guardPath, path.join(snapshot, 'guard-copy.json'));
  if (trackerPids().length || listenerPids().length || fs.existsSync(databasePath)) {
    fail(`Runtime state changed during recovery; guard retained. Evidence: ${snapshot}`);
  }
  const archivedGuard = `${guardPath}.archived-${stamp}`;
  if (fs.existsSync(archivedGuard)) fail(`Guard archive already exists: ${archivedGuard}`);
  fs.renameSync(guardPath, archivedGuard);
  console.log(`ℹ️  No tracker database exists at ${databasePath}, so there was nothing to back up.`);
  console.log(`⚠️  Archived unverified shutdown guard: ${archivedGuard}`);
  console.log('    Next: ./start.sh (it creates a new, empty database)');
}

/**
 * The integrity check for the disposable copy: better-sqlite3 when it opens a
 * database in this Node, else macOS's own sqlite3. A fresh clone has no
 * node_modules, npm 12 skips native builds, and a Node switch leaves a binary
 * built for another Node; none of that may block recovery (2026-10-07). Both
 * run the same quick_check and foreign_key_check.
 */
async function loadVerifier() {
  let reason;
  try {
    const Database = (await import('better-sqlite3')).default;
    new Database(':memory:').close();
    return {
      name: 'better-sqlite3',
      check(file) {
        const db = new Database(file, { readonly: false, fileMustExist: true });
        try {
          return {
            quickCheck: db.pragma('quick_check', { simple: true }),
            foreignKeyViolations: db.pragma('foreign_key_check').length,
          };
        } finally {
          db.close();
        }
      },
    };
  } catch (error) {
    reason = oneLine(error);
  }
  let usable = false;
  try {
    fs.accessSync(sqliteCli, fs.constants.X_OK);
    usable = fs.statSync(sqliteCli).isFile();
  } catch {}
  if (!usable) {
    fail(`Neither better-sqlite3 (${reason}) nor ${sqliteCli} can check the database copy here. Run: npm install, then retry`);
  }
  return { name: sqliteCli, check: checkWithSqliteCli };
}

function checkWithSqliteCli(file) {
  // -init /dev/null: never run the user's ~/.sqliterc against the copy.
  const result = spawnSync(sqliteCli, [
    '-batch', '-bail', '-init', '/dev/null', file,
    "PRAGMA quick_check; SELECT 'foreign_key_violations=' || count(*) FROM pragma_foreign_key_check;",
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${sqliteCli} exited ${result.status}`);
  const lines = result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  const match = /^foreign_key_violations=(\d+)$/.exec(lines.pop() ?? '');
  if (!match) throw new Error('unexpected sqlite3 output');
  return { quickCheck: lines.join('; '), foreignKeyViolations: Number(match[1]) };
}

try {
  if (inspectOnly) inspect();
  else if (guardIsAbsent()) {
    // Nothing blocks a start, so there is nothing to recover (a teammate
    // used to see "refused … Original guard retained" here).
    console.log('ℹ️  No shutdown safety guard: nothing to recover.');
    console.log('    Next: ./start.sh');
  } else await recover();
} catch (error) {
  console.error(`❌ Shutdown recovery refused: ${String(error?.message ?? error)}`);
  console.error(`    Original guard retained: ${guardPath}`);
  process.exitCode = 1;
}
