/**
 * Safe writer for the local settings file ~/.personal-productivity-tracker/.env.
 *
 * The dashboard saves per-user secrets (for example the Slack user token)
 * through this helper so teammates never hand-edit dotfiles. Writes are
 * whole-file atomic (temp file + rename), preserve every unrelated line, and
 * keep the file private (0600). Values are data, never shell-interpolated —
 * the launcher and loadEnv() both parse this file as plain KEY=value lines.
 */

import fs from 'fs';
import path from 'path';

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function localEnvFilePath(): string {
  return path.join(process.env.HOME || '', '.personal-productivity-tracker', '.env');
}

/** Insert or replace one KEY=value line, preserving all other content. */
export function upsertLocalEnvValue(key: string, value: string): void {
  if (!ENV_KEY_PATTERN.test(key)) throw new Error(`Invalid env key: ${key}`);
  if (/[\r\n]/.test(value)) throw new Error('Env values must be single-line');
  const filePath = localEnvFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let lines: string[] = [];
  try {
    lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  } catch { /* first write creates the file */ }

  const assignment = `${key}=${value}`;
  const keyPrefix = new RegExp(`^${key}=`);
  let replaced = false;
  const next = lines.map((line) => {
    if (!replaced && keyPrefix.test(line)) {
      replaced = true;
      return assignment;
    }
    return line;
  });
  if (!replaced) {
    while (next.length > 0 && next[next.length - 1].trim() === '') next.pop();
    next.push(assignment, '');
  }

  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, next.join('\n'), { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on existing files */ }
}

/** Read one value from the settings file (without process.env fallback). */
export function readLocalEnvValue(key: string): string | undefined {
  try {
    const lines = fs.readFileSync(localEnvFilePath(), 'utf-8').split('\n');
    for (const line of lines) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match && match[1] === key) return match[2].trim();
    }
  } catch { /* missing file = unset */ }
  return undefined;
}
