#!/usr/bin/env node
/**
 * Generate /Applications/BotBoy.app — the macOS launcher that gives BotBoy a
 * real name and icon in Finder / Launchpad / Spotlight / the Dock.
 *
 * Why this script exists: the original bundle was hand-made in March 2026 and
 * lived only on one machine — untracked, unreproducible, and pointing at a
 * hardcoded repo path. This regenerates it from committed assets
 * (src/ui/botboy_icon_512.png) so it survives a fresh clone or a moved repo.
 *
 * The bundle's executable runs `start.sh --foreground`, so the app process
 * lives as long as the tracker: the dock icon stays put while BotBoy runs and
 * quitting the app shuts the server down gracefully.
 *
 * Usage:
 *   node scripts/make-app-bundle.mjs                    # /Applications/BotBoy.app
 *   node scripts/make-app-bundle.mjs --dest ~/Applications/BotBoy.app
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const PROJ_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = 'BotBoy';

// Icon master. These PNGs are a tight crop of the robot in
// src/ui/botboy_logo.svg (rendered at 3x, whitespace trimmed) — the original
// art had so much padding that the robot looked tiny in the Dock. Prefer the
// 1024 master so iconutil gets a real 512x512@2x instead of an upscale.
const ICON_SRC = [
  path.join(PROJ_DIR, 'src', 'ui', 'botboy_icon_1024.png'),
  path.join(PROJ_DIR, 'src', 'ui', 'botboy_icon_512.png'),
].find((p) => fs.existsSync(p)) ?? path.join(PROJ_DIR, 'src', 'ui', 'botboy_icon_512.png');

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const destArg = arg('--dest');
const DEST = destArg
  ? path.resolve(destArg.replace(/^~/, os.homedir()))
  : `/Applications/${APP_NAME}.app`;

if (process.platform !== 'darwin') {
  console.error('This bundle generator is macOS-only.');
  process.exit(1);
}
if (!fs.existsSync(ICON_SRC)) {
  console.error(`Missing icon source: ${ICON_SRC}`);
  process.exit(1);
}

// ── 1. icon: PNG → .iconset → .icns ──────────────────────────────────────────
// iconutil requires the full ladder of sizes; sips generates each from the 512.
const tmpIconset = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-icon-')) + `/${APP_NAME}.iconset`;
fs.mkdirSync(tmpIconset, { recursive: true });

const variants = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
];
for (const [size, name] of variants) {
  execFileSync('sips', ['-z', String(size), String(size), ICON_SRC, '--out', path.join(tmpIconset, name)], { stdio: 'ignore' });
}

const contents = path.join(DEST, 'Contents');
const macos = path.join(contents, 'MacOS');
const resources = path.join(contents, 'Resources');
fs.mkdirSync(macos, { recursive: true });
fs.mkdirSync(resources, { recursive: true });

execFileSync('iconutil', ['-c', 'icns', tmpIconset, '-o', path.join(resources, `${APP_NAME}.icns`)], { stdio: 'inherit' });
fs.rmSync(path.dirname(tmpIconset), { recursive: true, force: true });

// ── 2. Info.plist ────────────────────────────────────────────────────────────
// LSUIElement=0 keeps it a normal (dock-visible) app; NSHighResolutionCapable
// stops macOS from rendering the icon/window blurry on Retina.
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundleIconFile</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>com.botboy.tracker</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.1</string>
  <key>CFBundleShortVersionString</key><string>1.1</string>
  <key>LSUIElement</key><false/>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict>
</plist>
`;
fs.writeFileSync(path.join(contents, 'Info.plist'), plist);

// ── 3. launcher ──────────────────────────────────────────────────────────────
// Compile the AppKit launcher (native/botboy-launcher/main.swift). A real GUI
// process is what keeps BotBoy's icon in the Dock while the tracker runs — a
// shell-script bundle is never registered as a running app (verified: zero
// `lsappinfo` entries), so its icon disappears the moment the script exits.
// The repo path is injected here, so re-run this script if the repo moves.
const launcherPath = path.join(macos, APP_NAME);
const swiftSrc = path.join(PROJ_DIR, 'native', 'botboy-launcher', 'main.swift');
const startSh = path.join(PROJ_DIR, 'start.sh');

let builtNative = false;
if (fs.existsSync(swiftSrc)) {
  try {
    execFileSync('which', ['swiftc'], { stdio: 'ignore' });
    // Inject START_SCRIPT as a compile-time constant.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-launcher-'));
    const shim = path.join(tmpDir, 'start_script.swift');
    fs.writeFileSync(shim, `let START_SCRIPT = ${JSON.stringify(startSh)}\n`);
    execFileSync('swiftc', ['-O', shim, swiftSrc, '-o', launcherPath], { stdio: 'inherit' });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    builtNative = true;
  } catch (err) {
    console.warn(`⚠️  Could not build the native launcher (${err.message.split('\n')[0]}).`);
  }
}

if (!builtNative) {
  // Fallback: shell launcher. Starts the tracker correctly, but macOS won't
  // keep a Dock icon for it. Install Xcode CLT (`xcode-select --install`) and
  // re-run for the full experience.
  console.warn('⚠️  Falling back to the shell launcher — no persistent Dock icon.');
  fs.writeFileSync(launcherPath, `#!/bin/bash
# Generated by scripts/make-app-bundle.mjs — do not edit by hand.
START_SH=${JSON.stringify(startSh)}
if [ ! -x "$START_SH" ]; then
  osascript -e 'display alert "BotBoy" message "Launcher is stale: start.sh not found. Re-run: npm run app:bundle"' >/dev/null 2>&1
  exit 1
fi
exec "$START_SH" --foreground
`);
}
fs.chmodSync(launcherPath, 0o755);

// ── 4. refresh LaunchServices so Finder/Dock pick up the new icon ────────────
// Without this the OS happily serves a stale cached icon.
fs.utimesSync(DEST, new Date(), new Date());
try {
  execFileSync(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', DEST],
    { stdio: 'ignore' },
  );
} catch {
  console.warn('⚠️  lsregister refresh failed — the icon may be cached until logout.');
}

console.log(`✅ Built ${DEST}`);
console.log(`   launcher → ${builtNative ? 'native AppKit (persistent Dock icon)' : 'shell script (no Dock icon)'}`);
console.log(`   runs     → ${startSh} --foreground`);
console.log(`   icon     → ${ICON_SRC}`);
