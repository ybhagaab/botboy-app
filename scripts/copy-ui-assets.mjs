import { copyFileSync, cpSync, mkdirSync, readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Copy ONLY when bytes differ. The served UI dir's mtimes ARE the uiVersion
// stamp (/api/dashboard/version → open tabs auto-reload on change), so an
// unconditional copy would reload every open tab on every build — including
// server-only builds that touched no UI file (confirmed live 2026-09-03).
function copyIfChanged(src, dest) {
  try {
    if (existsSync(dest) && readFileSync(src).equals(readFileSync(dest))) return false;
  } catch {
    // Unreadable destination — fall through to a fresh copy.
  }
  copyFileSync(src, dest);
  return true;
}

const root = process.cwd();
const sourceUi = join(root, 'src', 'ui');
const destinationUi = join(root, 'dist', 'ui');
const destinationVendor = join(destinationUi, 'vendor');
const sourceProductManagerConfig = join(root, 'src', 'product-manager', 'config');
const destinationProductManagerConfig = join(root, 'dist', 'product-manager', 'config');
const uiAssetPattern = /\.(?:html|js|css|svg|png|ico|webmanifest|json)$/;

mkdirSync(destinationUi, { recursive: true });
let copied = 0;
for (const filename of readdirSync(sourceUi)) {
  if (uiAssetPattern.test(filename)) {
    if (copyIfChanged(join(sourceUi, filename), join(destinationUi, filename))) copied++;
  }
}

mkdirSync(destinationVendor, { recursive: true });
const vendorAssets = [
  ['vega/build/vega.min.js', 'vega.min.js'],
  ['vega-lite/build/vega-lite.min.js', 'vega-lite.min.js'],
  ['vega-embed/build/vega-embed.min.js', 'vega-embed.min.js'],
];
for (const [modulePath, filename] of vendorAssets) {
  if (copyIfChanged(join(root, 'node_modules', modulePath), join(destinationVendor, filename))) copied++;
}

mkdirSync(destinationProductManagerConfig, { recursive: true });
cpSync(sourceProductManagerConfig, destinationProductManagerConfig, {
  recursive: true,
  force: true,
});

// Stamp the commit this build came from. start.sh compares the stamp with
// git HEAD to rebuild automatically after a git pull — without it, pulled
// fixes silently never activate because dist/ is stale rather than missing.
try {
  const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  writeFileSync(join(root, 'dist', '.build-commit'), `${hash}\n`);
} catch {
  // No git (tarball install) — start.sh falls back to missing-file detection.
}

console.log(`UI assets: ${copied} file(s) changed (byte-identical files skipped to keep uiVersion honest); product-manager runtime config synced`);
