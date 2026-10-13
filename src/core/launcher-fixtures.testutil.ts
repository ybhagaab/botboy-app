/**
 * Fixtures for the BotBoy.app launcher tests (launcher-prebuilt, launcher-migration,
 * launcher-app-bundle, make-app-bundle): a fixture "prebuilt launcher" (a tiny
 * program that speaks the launcher's print-target protocol) with a manifest whose
 * hashes match, bodies that misbehave in the ways a real launcher could on an
 * unseen Mac (unsupported CPU, killed by macOS, wrong output, hang), and the
 * two older per-Mac launcher formats (a compiled one that embeds the folder as a
 * NUL-terminated string, a script that embeds it as START_SH='...').
 *
 * Nothing here runs the real launcher, touches /Applications/BotBoy.app, or reads
 * the real HOME: every test sets HOME to a folder of its own.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const LAUNCHER_SOURCE = '// fixture launcher source\nprint("launcher")\n';

export type LauncherKind = 'ok' | 'self-kill' | 'wrong-target' | 'hang' | 'bad-cpu' | 'ignores-hook' | 'exit-2';

/** A shell script that implements the print-target protocol like the real launcher; the others break it on purpose. */
export function launcherBody(kind: LauncherKind = 'ok'): Buffer {
  const protocol = [
    '#!/bin/sh',
    'if [ "$BOTBOY_APP_PRINT_TARGET" = "1" ]; then',
    '  if [ -n "$BOTBOY_APP_START_SCRIPT" ] && [ -x "$BOTBOY_APP_START_SCRIPT" ]; then echo "target=$BOTBOY_APP_START_SCRIPT"; exit 0; fi',
    '  echo "target=none (fixture)"; exit 3',
    'fi',
    'exit 0',
    '',
  ].join('\n');
  switch (kind) {
    case 'ok':
      return Buffer.from(protocol);
    case 'self-kill':
      return Buffer.from('#!/bin/sh\nkill -9 $$\n');
    case 'wrong-target':
      return Buffer.from('#!/bin/sh\necho "target=/somewhere/else/start.sh"\nexit 0\n');
    case 'hang':
      return Buffer.from('#!/bin/sh\nexec sleep 60\n');
    case 'ignores-hook':
      // An older launcher without the hook would start the app; this one just exits quietly.
      return Buffer.from('#!/bin/sh\nexit 0\n');
    case 'exit-2':
      return Buffer.from('#!/bin/sh\necho "usage: launcher" >&2\nexit 2\n');
    case 'bad-cpu': {
      // A 32-byte Mach-O header with a CPU type no kernel can run: the kernel itself refuses to start it.
      const header = Buffer.alloc(32);
      header.writeUInt32LE(0xfeedfacf, 0);
      header.writeUInt32LE(0x99, 4);
      header.writeUInt32LE(3, 8);
      header.writeUInt32LE(2, 12);
      return header;
    }
    default:
      return Buffer.from(protocol);
  }
}

/** A manifest entry for a fixture launcher, in the shape scripts/native-prebuilt.mjs validates. */
export function launcherEntry(body: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    source: { sha256: sha256(LAUNCHER_SOURCE) },
    binary: { sha256: sha256(body), bytes: body.length },
    archs: ['arm64', 'x86_64'],
    minMacos: '13.0',
    signature: { kind: 'adhoc', identifier: 'com.botboy.tracker' },
    toolchain: { swift: 'Apple Swift version 6.4 (swiftlang-6.4.0.34.1 clang-2100.3.34.1)', sdk: 'macosx27.0 (26A425)', ld: '27037.1' },
    builtAt: '2026-10-13',
    launcherVersion: 2,
    ...overrides,
  };
}

export type ArtifactOptions = {
  kind?: LauncherKind;
  /** Write the manifest (default), leave it out, or write one that fails validation. */
  manifest?: 'valid' | 'missing' | 'invalid';
  withBinary?: boolean;
  /** Change the file after the manifest was written, so its hash no longer matches. */
  corrupt?: boolean;
  minMacos?: string;
  launcherVersion?: number;
};

/**
 * Write the fixture launcher, its source and the manifest under `packageDir/native`.
 * Returns the binary's path and bytes.
 */
export function writeLauncherArtifacts(packageDir: string, options: ArtifactOptions = {}) {
  const body = launcherBody(options.kind ?? 'ok');
  const binary = path.join(packageDir, 'native', 'botboy-launcher', 'prebuilt', 'botboy-launcher');
  const source = path.join(packageDir, 'native', 'botboy-launcher', 'main.swift');
  const manifest = path.join(packageDir, 'native', 'prebuilt-manifest.json');
  for (const file of [binary, source, manifest]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(source, LAUNCHER_SOURCE);
  if (options.withBinary !== false) {
    fs.writeFileSync(binary, body, { mode: 0o755 });
    fs.chmodSync(binary, 0o755);
  }
  const entry = launcherEntry(body, {
    ...(options.minMacos ? { minMacos: options.minMacos } : {}),
    ...(options.launcherVersion ? { launcherVersion: options.launcherVersion } : {}),
  });
  if ((options.manifest ?? 'valid') === 'valid') {
    fs.writeFileSync(manifest, JSON.stringify({ schema: 1, artifacts: { botboyLauncher: entry } }, null, 2));
  } else if (options.manifest === 'invalid') {
    fs.writeFileSync(manifest, '{ "schema": 1, "artifacts": { "botboyLauncher": { } } }');
  }
  if (options.corrupt) fs.appendFileSync(binary, '# changed after the manifest\n');
  return { binary, source, manifest, body };
}

/** The older compiled launcher: the folder's start.sh as its own NUL-terminated string among other data. */
export function legacyCompiledBytes(startSh: string): Buffer {
  return Buffer.concat([
    Buffer.from('\u0000BotBoy launcher fixture\u0000'),
    Buffer.from(startSh, 'utf8'),
    Buffer.from('\u0000--foreground\u0000--open-window\u0000'),
  ]);
}

/** The older script launcher exactly as scripts/make-app-bundle.mjs used to write it. */
export function legacyScriptText(startSh: string): string {
  const quoted = `'${startSh.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/bash\n# Generated by scripts/make-app-bundle.mjs — do not edit by hand.\nSTART_SH=${quoted}\nif [ ! -x "$START_SH" ]; then\n  osascript -e 'display alert "BotBoy" message "Launcher is stale: start.sh not found. Re-run: npm run app:bundle"' >/dev/null 2>&1\n  exit 1\nfi\nexec "$START_SH" --foreground\n`;
}

/** A generic compiled launcher stand-in: no path inside, same protocol as the fixture prebuilt. */
export function genericCompiledBytes(): Buffer {
  return launcherBody('ok');
}

export const FILE_FAT = 'Mach-O universal binary with 2 architectures: [x86_64:Mach-O 64-bit executable x86_64] [arm64:Mach-O 64-bit executable arm64]';
export const FILE_ARM = 'Mach-O 64-bit executable arm64';
export const FILE_INTEL = 'Mach-O 64-bit executable x86_64';
export const FILE_SCRIPT = 'Bourne-Again shell script text executable, Unicode text, UTF-8 text';

/** An Info.plist the way the bundle builder writes it, with the keys a test wants present. */
export function bundlePlist(options: { version?: number | null; minimum?: string; priority?: 'none' | 'arm64-first' | 'x86-first' } = {}): string {
  const priority = options.priority === 'arm64-first'
    ? '  <key>LSArchitecturePriority</key>\n  <array>\n    <string>arm64</string>\n    <string>x86_64</string>\n  </array>\n'
    : options.priority === 'x86-first'
      ? '  <key>LSArchitecturePriority</key>\n  <array>\n    <string>x86_64</string>\n    <string>arm64</string>\n  </array>\n'
      : '';
  const version = options.version === null || options.version === undefined ? '' : `  <key>BotBoyLauncherVersion</key><string>${options.version}</string>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>BotBoy</string>
  <key>CFBundleExecutable</key><string>BotBoy</string>
  <key>CFBundleIdentifier</key><string>com.botboy.tracker</string>
  <key>LSMinimumSystemVersion</key><string>${options.minimum ?? '12.0'}</string>
${version}${priority}</dict>
</plist>
`;
}

export type ArchRun = 'pass' | 'exit-1' | 'self-kill' | 'wrong-target';
export type ArchBehavior = {
  /** Does `arch -<name> /usr/bin/true` succeed, that is, can this Mac run that architecture? Default true. */
  answers?: boolean;
  /** What a program run under it does. Default 'pass': the program really runs. */
  runs?: ArchRun;
};

/**
 * A recording stand-in for /usr/bin/arch (the BOTBOY_TEST_ARCH_BIN hook), so a launcher can pass natively
 * and still fail under ONE architecture, which no fixture program can do by itself (every fixture
 * behaves the same under `arch`). Per architecture:
 *  - `answers: false` is a Mac that cannot run it (no Rosetta): the `/usr/bin/true` probe and any program fail;
 *  - `runs` is what a program does under it: 'pass' runs it for real, 'exit-1' and 'wrong-target' give an
 *    answer the smoke does not accept, 'self-kill' dies by SIGKILL (what macOS does to a launcher it refuses).
 * `calls()` lists every invocation as `arch <args>`; `runs()` leaves out the `/usr/bin/true` probes.
 */
export function stubArch(root: string, behavior: Partial<Record<'arm64' | 'x86_64', ArchBehavior>> = {}) {
  const dir = path.join(root, 'arch-stub');
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  const settings = (name: 'arm64' | 'x86_64') => ({ answers: behavior[name]?.answers === false ? 0 : 1, runs: behavior[name]?.runs ?? 'pass' });
  const arm64 = settings('arm64');
  const x86 = settings('x86_64');
  const file = path.join(dir, 'arch');
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `echo "arch $*" >> '${log}'`,
    'flag="$1"; shift',
    'case "$flag" in',
    `  -arm64) answers=${arm64.answers}; runs=${arm64.runs};;`,
    `  -x86_64) answers=${x86.answers}; runs=${x86.runs};;`,
    '  *) echo "arch: unknown option $flag" >&2; exit 2;;',
    'esac',
    'if [ "$answers" != 1 ]; then echo "arch: posix_spawnp: $1: Bad CPU type in executable" >&2; exit 1; fi',
    'if [ "$1" = /usr/bin/true ]; then exit 0; fi',
    'case "$runs" in',
    '  pass) exec "$@";;',
    '  exit-1) exit 1;;',
    '  self-kill) kill -9 $$;;',
    '  wrong-target) echo "target=/somewhere/else/start.sh"; exit 0;;',
    'esac',
    'exit 3',
    '',
  ].join('\n'), { mode: 0o755 });
  const lines = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return {
    file,
    env: { BOTBOY_TEST_ARCH_BIN: file } as Record<string, string>,
    calls: lines,
    runs: () => lines().filter((line) => !line.endsWith(' /usr/bin/true')),
    reset: () => fs.writeFileSync(log, ''),
  };
}

/**
 * Recording stand-ins for the macOS tools that show UI or register apps (osascript, open, lsregister)
 * and for xattr, in a folder of their own, plus the environment that puts them first and points the
 * BOTBOY_TEST_* hooks at them. Spread `env` into every child environment of a launcher or bundle test;
 * `calls()` lists what reached a stub, and a test that did not expect a call asserts it is empty.
 * (vitest.no-ui-tools.setup.ts is the net underneath: it fails any test file that reaches the real
 * tools or its own stubs. These are the test's own, so a test can ASSERT that the alert was shown.)
 */
export function stubUiTools(root: string) {
  const dir = path.join(root, 'ui-stubs');
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  for (const name of ['osascript', 'open', 'lsregister']) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
  }
  // xattr: the download flag is never present, and clearing it succeeds.
  fs.writeFileSync(
    path.join(dir, 'xattr'),
    `#!/bin/sh\necho "xattr $*" >> '${log}'\ncase "$1" in -p) echo "xattr: No such xattr: com.apple.quarantine" >&2; exit 1;; esac\nexit 0\n`,
    { mode: 0o755 },
  );
  return {
    dir,
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      BOTBOY_TEST_LSREGISTER_BIN: path.join(dir, 'lsregister'),
      BOTBOY_TEST_XATTR_BIN: path.join(dir, 'xattr'),
    } as Record<string, string>,
    /** Calls that reached osascript, open or lsregister (xattr is only a stub for the download flag, not UI). */
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter((line) => /^(osascript|open|lsregister)\b/.test(line)),
    /** Every recorded call, xattr included. */
    allCalls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
    reset: () => fs.writeFileSync(log, ''),
  };
}
