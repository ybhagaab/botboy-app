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
 * Architecture (Apple Silicon): macOS starts a shell-script app, and a
 * compiled launcher with no arm64 slice, under Rosetta, and every child
 * inherits that. So on Apple Silicon hardware (never judged by
 * process.arch, which lies under Rosetta) the bundle gets
 * LSArchitecturePriority [arm64, x86_64] in Info.plist, the compiled launcher
 * is built per slice (arm64 first, x86_64 best effort) and joined with lipo,
 * and the shell fallback re-executes itself natively. start.sh's own early
 * re-exec is the guaranteed layer; these are the layers around it.
 *
 * Usage:
 *   node scripts/make-app-bundle.mjs                    # /Applications/BotBoy.app
 *   node scripts/make-app-bundle.mjs --dest ~/Applications/BotBoy.app
 *   --no-register         skip the lsregister refresh
 *   --bundle-id <id>      bundle identifier (tests; default com.botboy.tracker)
 *   --launcher-only       rebuild only the compiled launcher of an existing
 *                         bundle; on failure the executable is left untouched
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectSwiftToolchain, isMainModule, swiftSdkArgs } from './bootstrap-deps.mjs';

export { isMainModule };

const PROJ_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = 'BotBoy';
const DEFAULT_BUNDLE_ID = 'com.botboy.tracker';

// Absolute system tools. lipo, swiftc and git are Xcode shims that raise the
// macOS install dialog on a Mac without Command Line Tools, so lipo and
// codesign are reached only after detectSwiftToolchain succeeded, through
// `xcrun --find`. The BOTBOY_TEST_* overrides exist for tests.
const SYSCTL_BIN = process.env.BOTBOY_TEST_SYSCTL_BIN || '/usr/sbin/sysctl';
const FILE_BIN = process.env.BOTBOY_TEST_FILE_BIN || '/usr/bin/file';
const XCRUN_BIN = process.env.BOTBOY_TEST_XCRUN_BIN || '/usr/bin/xcrun';
const LSREGISTER_BIN =
  process.env.BOTBOY_TEST_LSREGISTER_BIN ||
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

const ARM64_TARGET = 'arm64-apple-macosx12.0';
// 12.0 fails at link time for x86_64 on the current toolchain.
const X86_64_TARGET = 'x86_64-apple-macosx13.0';
const ARM64_TIMEOUT_MS = 120_000;
const X86_64_TIMEOUT_MS = 60_000;

/** True on Apple Silicon hardware: `sysctl -n hw.optional.arm64` is exactly 1. */
export function hardwareIsAppleSilicon(run = execFileSync) {
  try {
    const answer = run(SYSCTL_BIN, ['-n', 'hw.optional.arm64'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return String(answer).trim() === '1';
  } catch {
    return false;
  }
}

/**
 * Info.plist. LSUIElement=0 keeps it a normal (dock-visible) app;
 * NSHighResolutionCapable stops macOS from rendering the icon/window blurry on
 * Retina. LSArchitecturePriority is written only on Apple Silicon hardware.
 */
export function renderInfoPlist({ appleSilicon = false, bundleId = DEFAULT_BUNDLE_ID } = {}) {
  const priority = appleSilicon
    ? `  <key>LSArchitecturePriority</key>
  <array>
    <string>arm64</string>
    <string>x86_64</string>
  </array>
`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundleIconFile</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.1</string>
  <key>CFBundleShortVersionString</key><string>1.1</string>
  <key>LSUIElement</key><false/>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
${priority}</dict>
</plist>
`;
}

/** A POSIX single-quoted string: safe for $, backticks, spaces and quotes. */
export function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell fallback launcher. It starts the tracker correctly, but macOS
 * does not keep a Dock icon for it. On Apple Silicon it also re-executes
 * itself natively when macOS started it translated (guard BOTBOY_APP_REEXEC;
 * the probe runs first and execfail keeps a failed exec from ending the script).
 */
export function renderShellLauncher(startSh, { appleSilicon = false } = {}) {
  const reexec = appleSilicon
    ? `# macOS starts a script app under Rosetta unless Info.plist prefers arm64.
# Continue natively once (guard: BOTBOY_APP_REEXEC).
if [ -z "\${BOTBOY_APP_REEXEC:-}" ] \\
  && [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ] \\
  && [ "$(/usr/sbin/sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ] \\
  && /usr/bin/arch -arm64 /usr/bin/true >/dev/null 2>&1; then
  export BOTBOY_APP_REEXEC=1
  shopt -s execfail
  exec /usr/bin/arch -arm64 /bin/bash "$0" "$@"
fi
`
    : '';
  return `#!/bin/bash
# Generated by scripts/make-app-bundle.mjs — do not edit by hand.
START_SH=${shellSingleQuote(startSh)}
${reexec}if [ ! -x "$START_SH" ]; then
  osascript -e 'display alert "BotBoy" message "Launcher is stale: start.sh not found. Re-run: npm run app:bundle"' >/dev/null 2>&1
  exit 1
fi
exec "$START_SH" --foreground
`;
}

/**
 * What to install from the slices that built. Apple Silicon: both slices give
 * a universal binary; arm64 alone ships thin with one note; without an arm64
 * slice nothing new ships (keep a working native launcher, else the shell
 * fallback). Intel: the plain build.
 */
export function planLauncherBuild({ appleSilicon = false, arm64 = false, x86_64 = false, plain = false, hasExistingLauncher = false } = {}) {
  const fallback = (note) => (hasExistingLauncher
    ? { action: 'keep-existing', arch: null, lipo: false, notes: [note, 'The existing native launcher stays in place.'] }
    : { action: 'script', arch: null, lipo: false, notes: [note, 'Falling back to the shell launcher: it starts BotBoy natively but macOS keeps no Dock icon for it.'] });
  if (!appleSilicon) {
    return plain ? { action: 'install', arch: 'native', lipo: false, notes: [] } : fallback('The native launcher did not build.');
  }
  if (arm64 && x86_64) return { action: 'install', arch: 'universal', lipo: true, notes: [] };
  if (arm64) {
    return {
      action: 'install',
      arch: 'arm64',
      lipo: false,
      notes: ['The x86_64 slice did not build; the launcher is arm64 only (fine on Apple Silicon).'],
    };
  }
  return fallback('The arm64 launcher did not build.');
}

function run(file, args, options = {}) {
  return execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options });
}

/** An Xcode tool's real path through xcrun (only after the toolchain check). */
function findTool(name) {
  try {
    const found = String(run(XCRUN_BIN, ['--find', name])).trim();
    if (found) return found;
  } catch {
    // fall through
  }
  return null;
}

function firstLine(error) {
  const text = String(error?.stderr || error?.message || error);
  return text.split('\n').map((line) => line.trim()).find(Boolean) || 'unknown error';
}

/** The Mach-O architectures of a file, from `file -b` (never lipo or otool). */
function machOArchs(file) {
  try {
    const description = String(run(FILE_BIN, ['-b', file])).trim();
    if (!description.startsWith('Mach-O')) return [];
    const listed = [...description.matchAll(/\[([a-z0-9_]+):/g)].map((match) => match[1]);
    return listed.length ? listed : [description.split(' ').pop()];
  } catch {
    return [];
  }
}

function hasArm64(archs) {
  return archs.includes('arm64') || archs.includes('arm64e');
}

function isNativeLauncher(file) {
  return fs.existsSync(file) && machOArchs(file).length > 0;
}

function compileSlice({ swiftc, shim, swiftSrc, out, target, timeout }) {
  const args = [...swiftSdkArgs(), '-O', ...(target ? ['-target', target] : []), shim, swiftSrc, '-o', out];
  run(swiftc, args, { timeout });
}

/**
 * Build the compiled launcher into `workDir`. Returns { ok, plan, binary, notes }.
 * Every failure is caught: a launcher that did not build never throws.
 */
export function buildLauncher({ swiftc, startSh, appleSilicon, hasExistingLauncher, workDir, swiftSrc }) {
  const notes = [];
  const shim = path.join(workDir, 'start_script.swift');
  fs.writeFileSync(shim, `let START_SCRIPT = ${JSON.stringify(startSh)}\n`);
  const out = (name) => path.join(workDir, name);
  const results = { arm64: false, x86_64: false, plain: false };
  if (!appleSilicon) {
    try {
      compileSlice({ swiftc, shim, swiftSrc, out: out('BotBoy'), target: null, timeout: ARM64_TIMEOUT_MS });
      results.plain = true;
    } catch (error) {
      notes.push(`Could not build the native launcher (${firstLine(error)}).`);
    }
    const plan = planLauncherBuild({ appleSilicon, plain: results.plain, hasExistingLauncher });
    return { ok: plan.action === 'install', plan, binary: results.plain ? out('BotBoy') : null, notes: [...notes, ...plan.notes] };
  }
  try {
    compileSlice({ swiftc, shim, swiftSrc, out: out('BotBoy-arm64'), target: ARM64_TARGET, timeout: ARM64_TIMEOUT_MS });
    results.arm64 = true;
  } catch (error) {
    notes.push(`The arm64 launcher slice did not build (${firstLine(error)}).`);
  }
  if (results.arm64) {
    try {
      compileSlice({ swiftc, shim, swiftSrc, out: out('BotBoy-x86_64'), target: X86_64_TARGET, timeout: X86_64_TIMEOUT_MS });
      results.x86_64 = true;
    } catch (error) {
      notes.push(`The x86_64 launcher slice did not build (${firstLine(error)}).`);
    }
  }
  let plan = planLauncherBuild({ appleSilicon, ...results, hasExistingLauncher });
  if (plan.action !== 'install') return { ok: false, plan, binary: null, notes: [...notes, ...plan.notes] };
  const codesign = findTool('codesign') || '/usr/bin/codesign';
  const sign = (file) => {
    run(codesign, ['--force', '--sign', '-', file]);
    run(codesign, ['--verify', '--strict', file]);
  };
  let binary = out('BotBoy-arm64');
  if (plan.lipo) {
    try {
      const lipo = findTool('lipo');
      if (!lipo) throw new Error('lipo not found');
      run(lipo, ['-create', '-output', out('BotBoy-universal'), out('BotBoy-arm64'), out('BotBoy-x86_64')]);
      sign(out('BotBoy-universal'));
      binary = out('BotBoy-universal');
    } catch (error) {
      notes.push(`Could not join the slices (${firstLine(error)}); shipping the arm64 launcher.`);
      plan = planLauncherBuild({ appleSilicon, arm64: true, x86_64: false, hasExistingLauncher });
    }
  }
  if (binary === out('BotBoy-arm64')) {
    try {
      sign(binary);
    } catch (error) {
      notes.push(`The arm64 launcher failed code signing (${firstLine(error)}).`);
      plan = planLauncherBuild({ appleSilicon, arm64: false, x86_64: false, hasExistingLauncher });
      return { ok: false, plan, binary: null, notes: [...notes, ...plan.notes] };
    }
  }
  const archs = machOArchs(binary);
  if (!hasArm64(archs) || (plan.arch === 'universal' && !archs.includes('x86_64'))) {
    notes.push(`The built launcher holds ${archs.join('+') || 'no recognizable'} slices; not installing it.`);
    plan = planLauncherBuild({ appleSilicon, arm64: false, x86_64: false, hasExistingLauncher });
    return { ok: false, plan, binary: null, notes: [...notes, ...plan.notes] };
  }
  return { ok: true, plan, binary, notes: [...notes, ...plan.notes] };
}

/** Copy next to the destination, then rename over it: the swap is atomic. */
function installBinary(binary, launcherPath) {
  const staged = `${launcherPath}.botboy-new`;
  try {
    fs.copyFileSync(binary, staged);
    fs.chmodSync(staged, 0o755);
    fs.renameSync(staged, launcherPath);
  } catch (error) {
    fs.rmSync(staged, { force: true });
    throw error;
  }
}

function registerBundle(dest, noRegister) {
  fs.utimesSync(dest, new Date(), new Date());
  if (noRegister) return;
  try {
    execFileSync(LSREGISTER_BIN, ['-f', dest], { stdio: 'ignore' });
  } catch {
    console.warn('⚠️  lsregister refresh failed — the icon may be cached until logout.');
  }
}

/** Returns the process exit status. */
export function main(argv = process.argv.slice(2)) {
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    return i > -1 ? argv[i + 1] : undefined;
  };
  const noRegister = argv.includes('--no-register');
  const launcherOnly = argv.includes('--launcher-only');
  const bundleId = arg('--bundle-id') || DEFAULT_BUNDLE_ID;
  const destArg = arg('--dest');
  const dest = destArg
    ? path.resolve(destArg.replace(/^~/, os.homedir()))
    : `/Applications/${APP_NAME}.app`;

  // Hardware, never process.arch (which says x64 under Rosetta).
  const appleSilicon = process.env.BOTBOY_TEST_HW_ARM64 !== undefined
    ? process.env.BOTBOY_TEST_HW_ARM64 === '1'
    : hardwareIsAppleSilicon();

  if (process.platform !== 'darwin') {
    console.error('This bundle generator is macOS-only.');
    return 1;
  }
  const iconSrc = [
    path.join(PROJ_DIR, 'src', 'ui', 'botboy_icon_1024.png'),
    path.join(PROJ_DIR, 'src', 'ui', 'botboy_icon_512.png'),
  ].find((p) => fs.existsSync(p)) ?? path.join(PROJ_DIR, 'src', 'ui', 'botboy_icon_512.png');
  const contents = path.join(dest, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  const launcherPath = path.join(macos, APP_NAME);
  const swiftSrc = path.join(PROJ_DIR, 'native', 'botboy-launcher', 'main.swift');
  const startSh = path.join(PROJ_DIR, 'start.sh');

  // Compile the AppKit launcher (native/botboy-launcher/main.swift). A real GUI
  // process is what keeps BotBoy's icon in the Dock while the tracker runs — a
  // shell-script bundle is never registered as a running app (verified: zero
  // `lsappinfo` entries), so its icon disappears the moment the script exits.
  // The repo path is injected here, so re-run this script if the repo moves.
  const compileLauncher = () => {
    if (!fs.existsSync(swiftSrc)) return { ok: false, plan: null, binary: null, notes: [`Missing ${swiftSrc}.`], workDir: null };
    const toolchain = detectSwiftToolchain();
    if (!toolchain.ok) {
      return {
        ok: false,
        plan: null,
        binary: null,
        notes: ['No Swift compiler (install Xcode Command Line Tools with `xcode-select --install` for a persistent Dock icon).'],
        workDir: null,
      };
    }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-launcher-'));
    const built = buildLauncher({
      swiftc: toolchain.swiftc,
      startSh,
      appleSilicon,
      hasExistingLauncher: isNativeLauncher(launcherPath),
      workDir,
      swiftSrc,
    });
    return { ...built, workDir };
  };

  if (launcherOnly) {
    if (!fs.existsSync(contents)) {
      console.error(`--launcher-only needs an existing bundle: ${dest}`);
      return 1;
    }
    const built = compileLauncher();
    try {
      for (const note of built.notes) console.warn(`⚠️  ${note}`);
      if (!built.ok) {
        console.error('Launcher not rebuilt; the existing executable is untouched.');
        return 1;
      }
      fs.mkdirSync(macos, { recursive: true });
      installBinary(built.binary, launcherPath);
    } catch (error) {
      console.error(`Launcher not installed (${firstLine(error)}); the existing executable is untouched.`);
      return 1;
    } finally {
      if (built.workDir) fs.rmSync(built.workDir, { recursive: true, force: true });
    }
    registerBundle(dest, noRegister);
    console.log(`✅ Rebuilt the ${built.plan.arch} launcher in ${dest}`);
    return 0;
  }

  if (!fs.existsSync(iconSrc)) {
    console.error(`Missing icon source: ${iconSrc}`);
    return 1;
  }

  // ── 1. icon: PNG → .iconset → .icns ────────────────────────────────────────
  // iconutil requires the full ladder of sizes; sips generates each size from the 1024 source image.
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
    execFileSync('sips', ['-z', String(size), String(size), iconSrc, '--out', path.join(tmpIconset, name)], { stdio: 'ignore' });
  }
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  execFileSync('iconutil', ['-c', 'icns', tmpIconset, '-o', path.join(resources, `${APP_NAME}.icns`)], { stdio: 'inherit' });
  fs.rmSync(path.dirname(tmpIconset), { recursive: true, force: true });

  // ── 2. Info.plist ──────────────────────────────────────────────────────────
  fs.writeFileSync(path.join(contents, 'Info.plist'), renderInfoPlist({ appleSilicon, bundleId }));

  // ── 3. launcher ────────────────────────────────────────────────────────────
  const built = compileLauncher();
  let launcherKind;
  try {
    for (const note of built.notes) console.warn(`⚠️  ${note}`);
    if (built.ok) {
      installBinary(built.binary, launcherPath);
      launcherKind = `native AppKit ${built.plan.arch} (persistent Dock icon)`;
    } else if (isNativeLauncher(launcherPath)) {
      // Never replace a working native launcher with the shell fallback.
      launcherKind = 'existing native launcher kept (the rebuild did not succeed)';
    } else {
      console.warn('⚠️  Falling back to the shell launcher — no persistent Dock icon.');
      fs.writeFileSync(launcherPath, renderShellLauncher(startSh, { appleSilicon }));
      launcherKind = 'shell script (no Dock icon)';
    }
  } finally {
    if (built.workDir) fs.rmSync(built.workDir, { recursive: true, force: true });
  }
  fs.chmodSync(launcherPath, 0o755);

  // ── 4. refresh LaunchServices so Finder/Dock pick up the new icon ──────────
  // Without this the OS happily serves a stale cached icon.
  registerBundle(dest, noRegister);

  console.log(`✅ Built ${dest}`);
  console.log(`   launcher → ${launcherKind}`);
  console.log(`   runs     → ${startSh} --foreground`);
  console.log(`   icon     → ${iconSrc}`);
  console.log(`   arch     → ${appleSilicon ? 'LSArchitecturePriority arm64, x86_64' : 'no architecture priority (Intel Mac)'}`);
  return 0;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = main();
}
