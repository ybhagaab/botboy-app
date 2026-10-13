/**
 * Test hygiene, run level. The per-file half is vitest.no-ui-tools.setup.ts (read its header first).
 *
 * One folder per vitest RUN holds every test file's stub tools (`osascript`, `open`, `lsregister`). It
 * outlives the files, so a process that outlives its test file still finds a stub first on its PATH instead
 * of the real tool, and the main process removes it once, here, when the run ends. Nothing that runs in a
 * worker can be trusted to clean up: vitest ends its workers with a signal, so an exit handler never runs
 * (before the stubs moved here, every test file left a folder behind: 761 in a day of runs).
 *
 * The folder's name carries this process's PID. A run that is killed outright never reaches the teardown;
 * the next run removes folders whose process is gone (a folder of a run that is still going is left alone).
 *
 * The setup file finds the folder through BOTBOY_TEST_UI_STUBS_RUN_DIR, which vitest passes to its workers
 * (the environment of this process when a worker starts). Without it (another vitest config, or the setup
 * file used alone) each test file keeps its own folder and removes it when the file ends.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RUN_DIR_ENV = 'BOTBOY_TEST_UI_STUBS_RUN_DIR';
export const RUN_DIR_PREFIX = 'botboy-test-ui-stubs-run-';

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and belongs to someone else. Only ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Remove run folders in the temp directory whose vitest process no longer exists. */
export function sweepStaleRunFolders(tmp = os.tmpdir()): string[] {
  const removed: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(tmp);
  } catch {
    return removed;
  }
  for (const name of names) {
    const match = name.startsWith(RUN_DIR_PREFIX) ? /^(\d+)-/.exec(name.slice(RUN_DIR_PREFIX.length)) : null;
    if (!match || processIsRunning(Number(match[1]))) continue;
    try {
      fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // the next run tries again
    }
  }
  return removed;
}

/** vitest globalSetup: create this run's folder and return the teardown that removes it. */
export default function setup(): () => void {
  sweepStaleRunFolders();
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), `${RUN_DIR_PREFIX}${process.pid}-`));
  process.env[RUN_DIR_ENV] = folder;
  return () => {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      // the next run's sweep removes it once this process is gone
    }
    if (process.env[RUN_DIR_ENV] === folder) delete process.env[RUN_DIR_ENV];
  };
}
