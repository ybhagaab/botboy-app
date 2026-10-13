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
 * GENERIC LAUNCHER. The executable embeds no path. It reads the BotBoy folder it
 * opens from ~/.personal-productivity-tracker/app-checkout.v1 at run time, so one
 * fixed file serves every checkout and follows a folder that moves (start.sh
 * re-points the file). This script writes the file when it creates or upgrades
 * the bundle. Info.plist carries BotBoyLauncherVersion (the marker that tells a
 * generic launcher from an older per-Mac one).
 *
 * Launcher tiers (chooseLauncher), the first that passes its checks wins:
 *   1. PREBUILT universal launcher shipped in native/botboy-launcher/prebuilt
 *      (scripts/native-prebuilt.mjs): nothing is compiled, no developer tools.
 *   2. Compiled on this Mac from native/botboy-launcher/main.swift (needs the
 *      Xcode Command Line Tools).
 *   3. A shell script that reads the same file. It starts BotBoy correctly, but
 *      macOS keeps no Dock icon for it; it is never put in place of a working
 *      native launcher.
 * A candidate is checked before it replaces anything: its SHA-256 against the
 * manifest (tier 1), its code signature, and an execution smoke (it is RUN with
 * BOTBOY_APP_PRINT_TARGET=1, which prints the folder it would open and exits
 * before any application object exists) natively and under each architecture
 * this Mac can run, with stdin ignored and a time limit. Any failure falls to the next tier.
 *
 * Installing (installLauncher): check the candidate in a private work folder (never inside the
 * bundle: running a program from inside a *.app makes macOS assess and may register it), stage
 * `BotBoy.botboy-new` and `Info.plist.botboy-new` beside their targets, copy the current
 * pair to ~/.personal-productivity-tracker/app-launcher-backup (latest only),
 * record the folder (outside the bundle), then swap by rename: Info.plist first,
 * then the executable (a new inode, so a running copy of the old launcher keeps
 * its own file). A half-finished swap is repaired by the next run (a launcher that
 * still embeds a path counts as old whatever its Info.plist says). The installed
 * pair is read back (same bytes as the candidate that was run, valid Info.plist with the
 * version and architecture key); any mismatch restores the backup (copy to a staged name
 * beside the target, then rename: safe across volumes). The installer never runs anything
 * from inside the bundle.
 * Every failure removes the staged files, leaves the working launcher in place,
 * and ends with `reason=<code>` on stdout for start.sh.
 *
 * Architecture (Apple Silicon): macOS starts a shell-script app, and a
 * compiled launcher with no arm64 slice, under Rosetta, and every child
 * inherits that. So on Apple Silicon hardware (never judged by
 * process.arch, which lies under Rosetta) the bundle gets
 * LSArchitecturePriority [arm64, x86_64] in Info.plist. start.sh's own early
 * re-exec is the guaranteed layer; these are the layers around it.
 *
 * Usage:
 *   node scripts/make-app-bundle.mjs                    # /Applications/BotBoy.app
 *   node scripts/make-app-bundle.mjs --dest ~/Applications/BotBoy.app
 *   --no-register         skip the lsregister refresh
 *   --bundle-id <id>      bundle identifier (tests; default com.botboy.tracker)
 *   --launcher-only       upgrade only the launcher of an existing bundle
 *                         (executable + Info.plist + the recorded folder); on any
 *                         failure the current launcher is left working
 *
 * Test hooks (production never sets them): BOTBOY_TEST_HW_ARM64,
 * BOTBOY_TEST_NATIVE_ROOT (a folder holding native/ fixtures), BOTBOY_TEST_XCODE_SELECT_BIN,
 * BOTBOY_TEST_XCRUN_BIN, BOTBOY_TEST_FILE_BIN, BOTBOY_TEST_SYSCTL_BIN,
 * BOTBOY_TEST_LSREGISTER_BIN, BOTBOY_TEST_PLISTBUDDY_BIN, BOTBOY_TEST_CODESIGN_BIN,
 * BOTBOY_TEST_SW_VERS_BIN, BOTBOY_TEST_ARCH_BIN, and BOTBOY_TEST_BUNDLE_FAIL_AT
 * (before_swap | after_plist | after_exe | readback | restore, joined with +: fail there on purpose).
 * HOME decides where the recorded folder and the backup go: a test must set it.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectSwiftToolchain, isMainModule, swiftSdkArgs } from './bootstrap-deps.mjs';

export { isMainModule };

// scripts/native-prebuilt.mjs holds the manifest, the launcher checks and the recorded-folder
// writer. It is part of every release; if it is missing (a damaged folder) this script says so
// and changes nothing, rather than carrying a second copy of the checks.
let prebuilt = null;
try {
  prebuilt = await import('./native-prebuilt.mjs');
} catch {
  prebuilt = null;
}

const PROJ_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = 'BotBoy';
const DEFAULT_BUNDLE_ID = 'com.botboy.tracker';
/** BotBoyLauncherVersion of every generic launcher; a test pins it to native-prebuilt.mjs › LAUNCHER_VERSION. */
export const GENERIC_LAUNCHER_VERSION = prebuilt?.LAUNCHER_VERSION ?? 2;
const COMPILED_MINIMUM_MACOS = '12.0';
const STAGED_SUFFIX = '.botboy-new';
const RESTORE_SUFFIX = '.botboy-restore';

// Absolute system tools. lipo, swiftc and git are Xcode shims that raise the
// macOS install dialog on a Mac without Command Line Tools, so lipo is reached
// only after detectSwiftToolchain succeeded, through `xcrun --find`. The
// BOTBOY_TEST_* overrides exist for tests.
const SYSCTL_BIN = process.env.BOTBOY_TEST_SYSCTL_BIN || '/usr/sbin/sysctl';
const FILE_BIN = process.env.BOTBOY_TEST_FILE_BIN || '/usr/bin/file';
const XCRUN_BIN = process.env.BOTBOY_TEST_XCRUN_BIN || '/usr/bin/xcrun';
const PLISTBUDDY_BIN = process.env.BOTBOY_TEST_PLISTBUDDY_BIN || '/usr/libexec/PlistBuddy';
const PLUTIL_BIN = '/usr/bin/plutil';
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
 * BotBoyLauncherVersion marks a generic launcher (absent: an older per-Mac one);
 * `launcherVersion: null` omits it. LSMinimumSystemVersion is 13.0 for the
 * prebuilt launcher and 12.0 for the others.
 */
export function renderInfoPlist({
  appleSilicon = false,
  bundleId = DEFAULT_BUNDLE_ID,
  launcherVersion = GENERIC_LAUNCHER_VERSION,
  minimumSystemVersion = COMPILED_MINIMUM_MACOS,
} = {}) {
  const priority = appleSilicon
    ? `  <key>LSArchitecturePriority</key>
  <array>
    <string>arm64</string>
    <string>x86_64</string>
  </array>
`
    : '';
  const version = launcherVersion === null || launcherVersion === undefined
    ? ''
    : `  <key>BotBoyLauncherVersion</key><string>${launcherVersion}</string>\n`;
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
  <key>LSMinimumSystemVersion</key><string>${minimumSystemVersion}</string>
${version}${priority}</dict>
</plist>
`;
}

/**
 * The shell fallback launcher (tier 3). GENERIC like the native one: it reads the
 * BotBoy folder from ~/.personal-productivity-tracker/app-checkout.v1 (the same
 * rules: file at most 8 KB, `checkout=` absolute, under 4096 characters, no
 * control characters, <checkout>/start.sh executable) and honors the same test
 * hooks (BOTBOY_APP_START_SCRIPT, BOTBOY_APP_PRINT_TARGET). It starts the
 * tracker correctly, but macOS does not keep a Dock icon for it. On Apple
 * Silicon it also re-executes itself natively when macOS started it translated
 * (guard BOTBOY_APP_REEXEC; the probe runs first and execfail keeps a failed
 * exec from ending the script).
 */
export function renderShellLauncher({ appleSilicon = false } = {}) {
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
# Generic: opens the BotBoy folder recorded in ~/.personal-productivity-tracker/app-checkout.v1
# (start.sh keeps it current, so this app follows the folder if it moves).
START_SH=""
case "\${BOTBOY_APP_START_SCRIPT:-}" in
  /*) START_SH="$BOTBOY_APP_START_SCRIPT" ;;
  *)
    RECORD="\${HOME:-}/.personal-productivity-tracker/app-checkout.v1"
    if [ -f "$RECORD" ] && [ "$(wc -c < "$RECORD" 2>/dev/null | tr -d ' ')" -le 8192 ] 2>/dev/null; then
      CHECKOUT="$(sed -n 's/^checkout=//p' "$RECORD" | head -n 1)"
      case "$CHECKOUT" in
        *[[:cntrl:]]*) ;;
        /*) [ "\${#CHECKOUT}" -lt 4096 ] && START_SH="$CHECKOUT/start.sh" ;;
      esac
    fi
    ;;
esac
if [ "\${BOTBOY_APP_PRINT_TARGET:-}" = "1" ]; then
  if [ -n "$START_SH" ] && [ -f "$START_SH" ] && [ -x "$START_SH" ]; then
    echo "target=$START_SH"
    exit 0
  fi
  echo "target=none (no usable start.sh)"
  exit 3
fi
${reexec}if [ -z "$START_SH" ] || [ ! -f "$START_SH" ] || [ ! -x "$START_SH" ]; then
  osascript -e 'display alert "BotBoy launcher is stale" message "BotBoy could not find its folder. Open Terminal, go to your BotBoy folder (for example: cd ~/botboy-app) and run ./start.sh. That reconnects this app."' >/dev/null 2>&1
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

function isExecutableFile(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function removeQuietly(...files) {
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // nothing more can be done
    }
  }
}

function plistValue(plist, keyPath) {
  try {
    return String(run(PLISTBUDDY_BIN, ['-c', `Print :${keyPath}`, plist])).trim();
  } catch {
    return '';
  }
}

function compileSlice({ swiftc, swiftSrc, out, target, timeout }) {
  const args = [...swiftSdkArgs(), '-O', ...(target ? ['-target', target] : []), swiftSrc, '-o', out];
  run(swiftc, args, { timeout });
}

/**
 * Compile the generic launcher source into `workDir` (tier 2). Returns
 * { ok, plan, binary, notes }. Every failure is caught: a launcher that did not
 * build never throws.
 */
export function buildLauncher({ swiftc, appleSilicon, hasExistingLauncher, workDir, swiftSrc }) {
  const notes = [];
  const out = (name) => path.join(workDir, name);
  const results = { arm64: false, x86_64: false, plain: false };
  if (!appleSilicon) {
    try {
      compileSlice({ swiftc, swiftSrc, out: out('BotBoy'), target: null, timeout: ARM64_TIMEOUT_MS });
      results.plain = true;
    } catch (error) {
      notes.push(`Could not build the native launcher (${firstLine(error)}).`);
    }
    const plan = planLauncherBuild({ appleSilicon, plain: results.plain, hasExistingLauncher });
    return { ok: plan.action === 'install', plan, binary: results.plain ? out('BotBoy') : null, notes: [...notes, ...plan.notes] };
  }
  try {
    compileSlice({ swiftc, swiftSrc, out: out('BotBoy-arm64'), target: ARM64_TARGET, timeout: ARM64_TIMEOUT_MS });
    results.arm64 = true;
  } catch (error) {
    notes.push(`The arm64 launcher slice did not build (${firstLine(error)}).`);
  }
  if (results.arm64) {
    try {
      compileSlice({ swiftc, swiftSrc, out: out('BotBoy-x86_64'), target: X86_64_TARGET, timeout: X86_64_TIMEOUT_MS });
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

// ── choosing and checking a launcher ────────────────────────────────────────

/** Copy `from` to `to` (mode 0755), replacing a leftover; throws on failure. */
function stageCopy(from, to) {
  removeQuietly(to);
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o755);
}

/** Copy a checked candidate into the bundle under its staged name and prove the copy is byte-identical. */
function stageInto(candidate, stagedPath) {
  stageCopy(candidate, stagedPath);
  if (prebuilt.sha256File(stagedPath) !== prebuilt.sha256File(candidate)) throw new Error('the staged copy differs from the checked one');
}

/**
 * The checks every native candidate passes BEFORE it goes near the bundle: bytes equal to the
 * manifest's (when one is given), no download flag, a valid ad-hoc signature, and the execution
 * smoke (BOTBOY_APP_PRINT_TARGET=1: it prints the folder it would open and exits before any
 * application object exists) natively and under each architecture this Mac can run.
 * The candidate lives in a private work folder, never inside a *.app: running an executable
 * from inside an application bundle makes macOS assess and sometimes register that bundle.
 * { ok } or { ok: false, reason, detail }.
 */
function checkCandidate({ file, startSh, expectedSha }) {
  if (expectedSha && prebuilt.sha256File(file) !== expectedSha) {
    return { ok: false, reason: 'launcher_corrupt', detail: 'the copy does not match the manifest' };
  }
  if (prebuilt.quarantineState(file) !== 'none' && prebuilt.clearQuarantine(file) !== 'none') {
    return { ok: false, reason: 'launcher_quarantined', detail: 'macOS marked the launcher as downloaded and the mark could not be cleared' };
  }
  if (!prebuilt.codesignVerifies(file)) {
    return { ok: false, reason: 'launcher_codesign_failed', detail: 'the code signature does not verify' };
  }
  const smoke = prebuilt.smokeLauncherEverywhere(file, { startScript: startSh });
  if (!smoke.ok) return { ok: false, reason: 'launcher_smoke_failed', detail: smoke.detail };
  return { ok: true };
}

/**
 * Pick, check and stage the launcher to install: prebuilt, then compiled from the generic
 * source, then the shell script. Every candidate is built or copied into `workDir` and checked
 * THERE; only a candidate that passed is copied to `stagedPath` (beside its destination, so the
 * later swap is a rename). A candidate that fails is dropped and the next tier is tried; a
 * working native launcher is never replaced by the script. Returns { ok: true, tier, arch,
 * launcherVersion, minimumSystemVersion, notes } or { ok: false, reason, detail, notes } where
 * reason is the FIRST tier's failure (the most useful one for the owner).
 */
export function chooseLauncher({ stagedPath, startSh, appleSilicon, hasExistingNative, workDir, swiftSrc, root, osVersion }) {
  const notes = [];
  let first = null;
  const remember = (reason, detail) => {
    if (!first) first = { reason, detail };
  };
  const failure = (error) => (isPermissionError(error) ? 'app_not_writable' : 'stage_failed');
  if (!isExecutableFile(startSh)) {
    return { ok: false, reason: 'start_script_missing', detail: 'start.sh is missing or not executable in this folder', notes };
  }

  // Tier 1: the prebuilt launcher.
  const usable = prebuilt.launcherPrebuiltUsable({ root, startScript: startSh, osVersion, smoke: false });
  if (!usable.ok) {
    remember(usable.reason, usable.detail);
    notes.push(`The prebuilt launcher is not usable here (${usable.detail}).`);
  } else {
    try {
      const candidate = path.join(workDir, 'candidate-prebuilt');
      stageCopy(usable.file, candidate);
      const checked = checkCandidate({ file: candidate, startSh, expectedSha: usable.entry.binary.sha256 });
      if (checked.ok) {
        stageInto(candidate, stagedPath);
        return {
          ok: true,
          tier: 'prebuilt',
          arch: 'universal',
          launcherVersion: usable.entry.launcherVersion,
          minimumSystemVersion: usable.entry.minMacos,
          notes,
        };
      }
      remember(checked.reason, checked.detail);
      notes.push(`The prebuilt launcher failed its check (${checked.detail}).`);
    } catch (error) {
      remember(failure(error), firstLine(error));
      notes.push(`The prebuilt launcher could not be staged (${firstLine(error)}).`);
    }
    removeQuietly(stagedPath);
  }

  // Tier 2: compile the generic source on this Mac.
  if (!fs.existsSync(swiftSrc)) {
    remember('no_toolchain', 'no launcher source and no prebuilt launcher');
  } else {
    const toolchain = detectSwiftToolchain();
    if (!toolchain.ok) {
      remember('no_toolchain', 'no Swift compiler (install the Xcode Command Line Tools with `xcode-select --install` to build one)');
      notes.push('No Swift compiler (install Xcode Command Line Tools with `xcode-select --install` for a persistent Dock icon).');
    } else {
      const built = buildLauncher({ swiftc: toolchain.swiftc, appleSilicon, hasExistingLauncher: hasExistingNative, workDir, swiftSrc });
      notes.push(...built.notes);
      if (built.ok) {
        try {
          const checked = checkCandidate({ file: built.binary, startSh, expectedSha: null });
          if (checked.ok) {
            stageInto(built.binary, stagedPath);
            return { ok: true, tier: 'compiled', arch: built.plan.arch, launcherVersion: GENERIC_LAUNCHER_VERSION, minimumSystemVersion: COMPILED_MINIMUM_MACOS, notes };
          }
          remember(checked.reason, checked.detail);
          notes.push(`The launcher built on this Mac failed its check (${checked.detail}).`);
        } catch (error) {
          remember(failure(error), firstLine(error));
        }
        removeQuietly(stagedPath);
      } else {
        remember('compile_failed', built.notes[0] ?? 'the launcher did not build');
      }
    }
  }

  // Tier 3: the shell script, never in place of a working native launcher.
  if (hasExistingNative) {
    notes.push('The existing native launcher stays in place.');
    return { ok: false, ...(first ?? { reason: 'no_launcher_available', detail: 'no launcher could be built' }), notes };
  }
  try {
    const candidate = path.join(workDir, 'candidate-script');
    removeQuietly(candidate);
    fs.writeFileSync(candidate, renderShellLauncher({ appleSilicon }), { mode: 0o755 });
    fs.chmodSync(candidate, 0o755);
    const smoke = prebuilt.smokeLauncherEverywhere(candidate, { startScript: startSh });
    if (smoke.ok) {
      stageInto(candidate, stagedPath);
      notes.push('Falling back to the shell launcher: it starts BotBoy natively but macOS keeps no Dock icon for it.');
      return { ok: true, tier: 'script', arch: 'script', launcherVersion: GENERIC_LAUNCHER_VERSION, minimumSystemVersion: COMPILED_MINIMUM_MACOS, notes };
    }
    remember('launcher_smoke_failed', `shell launcher: ${smoke.detail}`);
  } catch (error) {
    remember(failure(error), firstLine(error));
  }
  removeQuietly(stagedPath);
  return { ok: false, ...(first ?? { reason: 'no_launcher_available', detail: 'no launcher could be built' }), notes };
}

function isPermissionError(error) {
  return error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EROFS';
}

// ── installing ──────────────────────────────────────────────────────────────

export function backupDirectory(home = os.homedir()) {
  return path.join(home, '.personal-productivity-tracker', 'app-launcher-backup');
}

/** Test hook: fail on purpose at one or more points of the install (BOTBOY_TEST_BUNDLE_FAIL_AT=readback+restore). */
function injectFailure(point) {
  if (String(process.env.BOTBOY_TEST_BUNDLE_FAIL_AT ?? '').split('+').includes(point)) {
    const error = new Error(`injected failure at ${point}`);
    error.code = 'EINJECTED';
    throw error;
  }
}

/**
 * Copy the current launcher pair to the backup folder (latest only), each file
 * through a temporary name and a rename. Returns { ok, files } where files lists
 * what was saved; { ok: false, detail } when a file that exists could not be saved.
 */
function backupBundle({ launcherPath, plistPath, home }) {
  const dir = backupDirectory(home);
  const files = [];
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const [source, name] of [[launcherPath, APP_NAME], [plistPath, 'Info.plist']]) {
      if (!fs.existsSync(source)) continue;
      const staged = path.join(dir, `${name}.tmp-${process.pid}`);
      fs.copyFileSync(source, staged);
      fs.chmodSync(staged, fs.statSync(source).mode & 0o777);
      fs.renameSync(staged, path.join(dir, name));
      files.push({ name, target: source });
    }
    return { ok: true, files, dir };
  } catch (error) {
    for (const name of [APP_NAME, 'Info.plist']) removeQuietly(path.join(dir, `${name}.tmp-${process.pid}`));
    return { ok: false, detail: firstLine(error), files, dir };
  }
}

/** Put the backed-up files back: a copy to a staged name beside the target, then a rename (safe across volumes). */
function restoreBackup(backup, order) {
  const problems = [];
  for (const name of order) {
    const entry = backup.files.find((file) => file.name === name);
    if (!entry) continue;
    const staged = `${entry.target}${RESTORE_SUFFIX}`;
    try {
      injectFailure('restore');
      fs.copyFileSync(path.join(backup.dir, name), staged);
      fs.chmodSync(staged, fs.statSync(path.join(backup.dir, name)).mode & 0o777);
      fs.renameSync(staged, entry.target);
    } catch (error) {
      removeQuietly(staged);
      problems.push(`${name}: ${firstLine(error)}`);
    }
  }
  return problems;
}

function registerBundle(dest, noRegister) {
  try {
    fs.utimesSync(dest, new Date(), new Date());
  } catch {
    // a bundle we may not touch is reported by the read-back
  }
  if (noRegister) return;
  try {
    execFileSync(LSREGISTER_BIN, ['-f', dest], { stdio: 'ignore' });
  } catch {
    console.warn('⚠️  lsregister refresh failed — the icon may be cached until logout.');
  }
}

/**
 * Read the installed pair back: the executable is byte-identical to the candidate that was run before the swap,
 * Info.plist is valid and carries the launcher version and the architecture key. Nothing is executed here: the
 * candidate's checks ran in a private folder, and running a program from inside a *.app makes macOS assess (and
 * sometimes register) the bundle. { ok } or { ok: false, detail }.
 */
function readBack({ launcherPath, plistPath, expectedSha, launcherVersion, appleSilicon }) {
  try {
    injectFailure('readback');
  } catch (error) {
    return { ok: false, detail: error.message };
  }
  if (prebuilt.sha256File(launcherPath) !== expectedSha) return { ok: false, detail: 'the installed launcher differs from the one that was checked' };
  if (!isExecutableFile(launcherPath)) return { ok: false, detail: 'the installed launcher is not executable' };
  // No codesign call here: at the name CFBundleExecutable gives it, codesign judges the whole unsealed bundle ("code has no
  // resources") instead of the file. The staged copy already passed `codesign --verify --strict` as a plain file, and the
  // same bytes were just compared by hash.
  const lint = (() => {
    try {
      run(PLUTIL_BIN, ['-lint', plistPath]);
      return true;
    } catch {
      return false;
    }
  })();
  if (!lint) return { ok: false, detail: 'Info.plist is not a valid property list' };
  if (plistValue(plistPath, 'CFBundleExecutable') !== APP_NAME) return { ok: false, detail: 'Info.plist does not name the executable' };
  if (String(launcherVersion ?? '') !== plistValue(plistPath, 'BotBoyLauncherVersion')) return { ok: false, detail: 'Info.plist does not carry the launcher version' };
  if (appleSilicon && plistValue(plistPath, 'LSArchitecturePriority:0') !== 'arm64') return { ok: false, detail: 'Info.plist does not prefer arm64' };
  return { ok: true };
}

/**
 * Put a launcher into the bundle at `dest`: choose and check one, back up the
 * current pair, record the folder, swap (Info.plist first, then the executable),
 * read back, and restore the backup (and refresh LaunchServices) on any failure.
 * The caller registers the bundle after a success. Returns
 * { ok: true, tier, arch, notes } or { ok: false, reason, detail, notes, kept }.
 * `kept` is true when a working native launcher stayed in place.
 */
export function installLauncher({ dest, startSh, appleSilicon, bundleId, noRegister, home = os.homedir(), root, osVersion }) {
  const contents = path.join(dest, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const launcherPath = path.join(macos, APP_NAME);
  const plistPath = path.join(contents, 'Info.plist');
  const stagedExe = `${launcherPath}${STAGED_SUFFIX}`;
  const stagedPlist = `${plistPath}${STAGED_SUFFIX}`;
  const swiftSrc = path.join(root, 'native', 'botboy-launcher', 'main.swift');
  const hasExistingNative = isNativeLauncher(launcherPath);
  const hadLauncher = fs.existsSync(launcherPath);
  const cleanup = () => removeQuietly(stagedExe, stagedPlist, `${launcherPath}${RESTORE_SUFFIX}`, `${plistPath}${RESTORE_SUFFIX}`);
  let workDir = null;
  const fail = (reason, detail, notes = [], extra = {}) => {
    cleanup();
    return { ok: false, reason, detail, notes, kept: hasExistingNative, existing: hadLauncher, ...extra };
  };
  try {
    fs.mkdirSync(macos, { recursive: true });
    cleanup(); // leftovers of a run that was killed half way
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-launcher-'));
  } catch (error) {
    return fail(isPermissionError(error) ? 'app_not_writable' : 'stage_failed', firstLine(error));
  }
  try {
    const chosen = chooseLauncher({ stagedPath: stagedExe, startSh, appleSilicon, hasExistingNative, workDir, swiftSrc, root, osVersion });
    if (!chosen.ok) return fail(chosen.reason, chosen.detail, chosen.notes);

    const expectedSha = prebuilt.sha256File(stagedExe);
    try {
      fs.writeFileSync(
        stagedPlist,
        renderInfoPlist({ appleSilicon, bundleId, launcherVersion: chosen.launcherVersion, minimumSystemVersion: chosen.minimumSystemVersion }),
      );
      run(PLUTIL_BIN, ['-lint', stagedPlist]);
    } catch (error) {
      return fail(isPermissionError(error) ? 'app_not_writable' : 'plist_invalid', firstLine(error), chosen.notes);
    }

    // Back up what is there now (nothing on a fresh create), then record the folder BEFORE the swap:
    // if recording fails nothing has changed, and a launcher that ignores the file keeps working.
    const backup = hadLauncher || fs.existsSync(plistPath) ? backupBundle({ launcherPath, plistPath, home }) : { ok: true, files: [], dir: backupDirectory(home) };
    if (!backup.ok) return fail('backup_failed', backup.detail, chosen.notes);
    const recorded = prebuilt.writeCheckoutFile(path.dirname(startSh), { home });
    if (!recorded.ok) return fail('checkout_file_failed', recorded.error, chosen.notes);

    let swapped = { plist: false, exe: false };
    const rollback = (reason, detail) => {
      const order = [];
      if (swapped.exe) order.push(APP_NAME);
      if (swapped.plist) order.push('Info.plist');
      const problems = restoreBackup(backup, order);
      if (!hadLauncher && swapped.exe) removeQuietly(launcherPath); // a fresh bundle without a launcher is "missing": the next start creates it
      if (!backup.files.some((file) => file.name === 'Info.plist') && swapped.plist) removeQuietly(plistPath);
      registerBundle(dest, noRegister);
      const extra = problems.length ? ` (restoring the backup also failed: ${problems.join('; ')}; the copies are in ${backup.dir})` : '';
      // A restore that failed is its own reason: the bundle is not as it was, and start.sh must not say it is.
      return fail(problems.length ? 'restore_failed' : reason, `${detail}${extra}`, chosen.notes, { restored: problems.length === 0 });
    };
    try {
      injectFailure('before_swap');
      fs.renameSync(stagedPlist, plistPath);
      swapped.plist = true;
      injectFailure('after_plist');
      fs.renameSync(stagedExe, launcherPath);
      swapped.exe = true;
      injectFailure('after_exe');
    } catch (error) {
      return rollback(isPermissionError(error) ? 'app_not_writable' : 'swap_failed', firstLine(error));
    }
    const checked = readBack({ launcherPath, plistPath, expectedSha, launcherVersion: chosen.launcherVersion, appleSilicon });
    if (!checked.ok) return rollback('readback_failed', checked.detail);
    return { ok: true, tier: chosen.tier, arch: chosen.arch, launcherVersion: chosen.launcherVersion, notes: chosen.notes, folder: recorded.checkout, backupDir: backup.dir, hadLauncher };
  } finally {
    cleanup();
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function launcherWords(result) {
  if (result.tier === 'prebuilt') return 'prebuilt universal launcher (no developer tools needed)';
  if (result.tier === 'compiled') return `launcher compiled on this Mac (${result.arch})`;
  return 'shell script (no Dock icon)';
}

/** Returns the process exit status. */
export function main(argv = process.argv.slice(2)) {
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    return i > -1 ? argv[i + 1] : undefined;
  };
  const noRegister = argv.includes('--no-register');
  const launcherOnly = argv.includes('--launcher-only');
  const bundleArg = arg('--bundle-id');
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
  if (!prebuilt) {
    console.error('scripts/native-prebuilt.mjs is missing from this BotBoy folder, so the launcher cannot be checked or installed. Run ./start.sh --update to restore it.');
    console.log('reason=native_prebuilt_module_missing');
    return 1;
  }
  const root = prebuilt.nativeRoot();
  const iconSrc = [
    path.join(PROJ_DIR, 'src', 'ui', 'botboy_icon_1024.png'),
    path.join(PROJ_DIR, 'src', 'ui', 'botboy_icon_512.png'),
  ].find((p) => fs.existsSync(p)) ?? path.join(PROJ_DIR, 'src', 'ui', 'botboy_icon_512.png');
  const contents = path.join(dest, 'Contents');
  const resources = path.join(contents, 'Resources');
  const plistPath = path.join(contents, 'Info.plist');
  const startSh = path.join(fs.realpathSync(PROJ_DIR), 'start.sh');
  // The bundle identifier of an existing bundle is kept unless one is given.
  const existingId = plistValue(plistPath, 'CFBundleIdentifier');
  const bundleId = bundleArg || existingId || DEFAULT_BUNDLE_ID;

  // A failed install: what happened, in one sentence, then the machine lines start.sh reads.
  const report = (result, verb, { machineLines }) => {
    for (const note of result.notes ?? []) console.warn(`⚠️  ${note}`);
    if (result.ok) return;
    const state = result.restored === false
      ? `the previous launcher could not be put back automatically; its copies are in ${backupDirectory()}`
      : (result.existing ? 'the existing launcher is untouched' : 'nothing was installed');
    console.error(`Launcher not ${verb} (${result.detail}); ${state}.`);
    if (!machineLines) return;
    console.log(`reason=${result.reason}`);
    console.log(`detail=${String(result.detail ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200)}`);
  };

  if (launcherOnly) {
    if (!fs.existsSync(contents)) {
      console.error(`--launcher-only needs an existing bundle: ${dest}`);
      console.log('reason=no_bundle');
      return 1;
    }
    const result = installLauncher({ dest, startSh, appleSilicon, bundleId, noRegister, root });
    report(result, 'upgraded', { machineLines: true });
    if (!result.ok) return 1;
    registerBundle(dest, noRegister);
    console.log(`✅ Upgraded the launcher in ${dest}: ${launcherWords(result)}`);
    console.log(`   opens    → ${result.folder}`);
    console.log(`   backup   → ${result.backupDir} (the launcher and Info.plist that were replaced)`);
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
  try {
    fs.mkdirSync(resources, { recursive: true });
    execFileSync('iconutil', ['-c', 'icns', tmpIconset, '-o', path.join(resources, `${APP_NAME}.icns`)], { stdio: 'inherit' });
  } finally {
    fs.rmSync(path.dirname(tmpIconset), { recursive: true, force: true });
  }

  // ── 2. Info.plist and launcher: one checked, reversible install ────────────
  const existingVersion = plistValue(plistPath, 'BotBoyLauncherVersion');
  const result = installLauncher({ dest, startSh, appleSilicon, bundleId, noRegister, root });
  let launcherKind;
  if (result.ok) {
    for (const note of result.notes) console.warn(`⚠️  ${note}`);
    launcherKind = launcherWords(result);
  } else if (result.kept) {
    // Never replace a working native launcher with the shell fallback: the plist is still refreshed
    // (a stale bundle gains the architecture key) and keeps the version marker it already had.
    report(result, 'replaced', { machineLines: false });
    try {
      fs.writeFileSync(plistPath, renderInfoPlist({ appleSilicon, bundleId, launcherVersion: existingVersion || null, minimumSystemVersion: plistValue(plistPath, 'LSMinimumSystemVersion') || COMPILED_MINIMUM_MACOS }));
    } catch (error) {
      console.error(`Could not refresh Info.plist (${firstLine(error)}).`);
    }
    registerBundle(dest, noRegister);
    launcherKind = 'existing native launcher kept (the rebuild did not succeed)';
  } else {
    report(result, 'installed', { machineLines: true });
    return 1;
  }
  if (result.ok) registerBundle(dest, noRegister);

  console.log(`✅ Built ${dest}`);
  console.log(`   launcher → ${launcherKind}`);
  console.log(`   opens    → ${result.folder ?? '(the folder recorded before)'} (recorded in ~/.personal-productivity-tracker/app-checkout.v1; start.sh keeps it current)`);
  console.log(`   icon     → ${iconSrc}`);
  console.log(`   arch     → ${appleSilicon ? 'LSArchitecturePriority arm64, x86_64' : 'no architecture priority (Intel Mac)'}`);
  return 0;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = main();
}
