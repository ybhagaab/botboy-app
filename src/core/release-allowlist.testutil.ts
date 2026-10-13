/**
 * Test helper: the files `scripts/release.sh` would ship to botboy-app, read
 * from its PATHS allowlist. Tests and fakes are excluded so the no-credential
 * scans look only at runtime code and docs.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function releaseAllowlist(): string[] {
  const script = fs.readFileSync(path.join(PACKAGE_ROOT, 'scripts', 'release.sh'), 'utf8');
  const block = script.match(/^PATHS=\(\n([\s\S]*?)^\)/m);
  if (!block) throw new Error('release.sh PATHS block not found');
  return block[1].split('\n')
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

export function releaseFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(PACKAGE_ROOT, rel);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { return; }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        walk(path.join(rel, name));
      }
      return;
    }
    if (/\.(test|fake)\.ts$|\.testutil\.ts$/.test(rel)) return;
    if (/\.(png|jpe?g|gif|webp|ico|icns|node|dylib|wasm|ttf|woff2?)$/i.test(rel)) return;
    // Prebuilt native helpers are extensionless Mach-O files; the credential scans must not read them as text.
    if (/^native\/[^/]+\/prebuilt\//.test(rel)) return;
    out.push(rel);
  };
  for (const entry of releaseAllowlist()) walk(entry);
  return out;
}
