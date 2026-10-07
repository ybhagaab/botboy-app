/**
 * Database-open marker: lets the launcher prove that a failed start never
 * reached tracker.db.
 *
 * start.sh passes a fresh one-time path in PPT_DB_OPEN_MARKER to each server
 * it spawns. index.ts › main writes the marker durably immediately before the
 * first tracker.db open, and a failed write throws before the database opens.
 * A startup child that exits without its marker therefore never opened the
 * database, and its failed start needs no shutdown guard
 * (start.sh › stop_startup_child › child_never_reached_database). Teammate
 * starts that crashed at import (npm 12 skipping native builds, 2026-10-07)
 * used to leave a guard that only --recover-shutdown could clear.
 *
 * The marker's contents are evidence for people; the launcher decides on its
 * presence alone.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The launcher names markers `ppt-db-open-<uuid>.json`. */
const MARKER_NAME = /^ppt-db-open-[A-Za-z0-9-]{8,64}\.json$/;

/**
 * Write the marker at `markerPath` (from PPT_DB_OPEN_MARKER). Returns false
 * when no path is set (BotBoy was not started by the launcher). Throws when
 * the path is malformed or the marker cannot be written durably; the caller
 * must not open the database then.
 */
export function writeDatabaseOpenMarker(
  markerPath: string | undefined,
  pid: number = process.pid,
  now: Date = new Date(),
): boolean {
  if (markerPath === undefined || markerPath === '') return false;
  if (!path.isAbsolute(markerPath) || !MARKER_NAME.test(path.basename(markerPath))) {
    throw new Error('PPT_DB_OPEN_MARKER must be an absolute path ending in ppt-db-open-<id>.json');
  }
  const temporary = `${markerPath}.${pid}.tmp`;
  fs.rmSync(temporary, { force: true });
  // `wx`: never follow or reuse a file someone else placed at this name.
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, pid, writtenAt: now.toISOString() })}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, markerPath);
  return true;
}
