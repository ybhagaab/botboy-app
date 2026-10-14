/**
 * Test helpers for BotBoy's private Python runtime (python-runtime.pin, scripts/python-runtime.sh, start.sh,
 * scripts/verify-python-runtime.mjs). Everything here is hermetic:
 *  - a "uv" tarball holds two shell scripts that behave like uv for the few commands BotBoy runs (--version, python
 *    install from a file:// mirror with its own hash check, python uninstall, cache prune/clean) and record each call;
 *  - a "CPython" tarball is a `python/` tree whose bin/python3 is a shell script that prints its version;
 *  - downloads come from node-runtime.testutil.ts › startDistServer (127.0.0.1 only, ephemeral port);
 *  - nothing here runs Apple's python3 or install_name_tool stand-ins, a real uv, osascript, open or lsregister.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './node-runtime.testutil.js';

export const TRIPLE_ARCH = { arm64: 'aarch64', x64: 'x86_64' } as const;
export type Chip = keyof typeof TRIPLE_ARCH;

export type FakePacked = { file: string; body: Buffer; sha256: string; bytes: number; name: string };

function pack(dir: string, root: string, top: string, name: string): FakePacked {
  const file = path.join(dir, name);
  const packed = spawnSync('/usr/bin/tar', ['-czf', file, '-C', root, top], { encoding: 'utf8' });
  if (packed.status !== 0) throw new Error(`tar failed: ${packed.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
  const body = fs.readFileSync(file);
  return { file, body, sha256: sha256(body), bytes: body.length, name };
}

export type FakePythonOptions = {
  version: string;
  build: string;
  chip: Chip;
  /** What bin/python3 prints for its version (default: the version). */
  versionOutput?: string;
  /** bin/python3 exits 1 for everything. */
  broken?: boolean;
  /** Incompressible padding, so a test can cut the file in the middle. */
  padBytes?: number;
};

/** A real .tar.gz shaped like python-build-standalone's install_only_stripped file: a `python/` tree. */
export function fakePythonTarball(dir: string, options: FakePythonOptions): FakePacked {
  const minor = options.version.split('.').slice(0, 2).join('.');
  const root = fs.mkdtempSync(path.join(dir, 'py-tree-'));
  const top = path.join(root, 'python');
  fs.mkdirSync(path.join(top, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(top, 'lib', `python${minor}`, 'site-packages'), { recursive: true });
  const shown = options.versionOutput ?? options.version;
  const body = options.broken
    ? '#!/bin/sh\nexit 1\n'
    // `-I -c <code>`: the version (BotBoy's smoke and the doctor); `-V`: Python <version>.
    : `#!/bin/sh\ncase "$1" in\n  -V|--version) echo "Python ${shown}" ;;\n  *) echo '${shown}' ;;\nesac\n`;
  fs.writeFileSync(path.join(top, 'bin', `python${minor}`), body, { mode: 0o755 });
  fs.symlinkSync(`python${minor}`, path.join(top, 'bin', 'python3'));
  fs.symlinkSync(`python${minor}`, path.join(top, 'bin', 'python'));
  fs.writeFileSync(path.join(top, 'lib', `python${minor}`, 'os.py'), '# fake\n');
  if (options.padBytes) fs.writeFileSync(path.join(top, 'pad.bin'), randomBytes(options.padBytes));
  const name = `cpython-${options.version}+${options.build}-${TRIPLE_ARCH[options.chip]}-apple-darwin-install_only_stripped.tar.gz`;
  return pack(dir, root, 'python', name);
}

export type FakeUvOptions = {
  version: string;
  chip: Chip;
  /** The SHA-256 this uv "has built in" for the CPython file: its python install refuses any other (like uv). */
  pythonSha256: string;
  /** The CPython version and build it knows. */
  pythonVersion: string;
  pythonBuild: string;
  /** What `uv --version` prints (default: uv <version> (fake)). */
  versionOutput?: string;
  /** Every call is appended here: `uv <args> | env=<selected variables>`. */
  callLog: string;
  /** The `uv python install` step sleeps this many seconds first. */
  installDelaySeconds?: number;
  padBytes?: number;
};

/**
 * A real .tar.gz shaped like uv's release file: `uv-<triple>-apple-darwin/{uv,uvx}`. The scripts run with
 * PATH=/bin:/usr/sbin:/sbin (BotBoy's install step), so they name /usr/bin tools by absolute path.
 */
export function fakeUvTarball(dir: string, options: FakeUvOptions): FakePacked {
  const triple = TRIPLE_ARCH[options.chip];
  const topName = `uv-${triple}-apple-darwin`;
  const root = fs.mkdtempSync(path.join(dir, 'uv-tree-'));
  const top = path.join(root, topName);
  fs.mkdirSync(top, { recursive: true });
  const minor = options.pythonVersion.split('.').slice(0, 2).join('.');
  const key = `cpython-${options.pythonVersion}-macos-${triple}-none`;
  const minorKey = `cpython-${minor}-macos-${triple}-none`;
  const file = `cpython-${options.pythonVersion}+${options.pythonBuild}-${triple}-apple-darwin-install_only_stripped.tar.gz`;
  const shown = options.versionOutput ?? `uv ${options.version} (fake)`;
  const uv = `#!/bin/sh
log='${options.callLog}'
echo "uv $* | env PATH=$PATH HOME=$HOME UV_NO_CACHE=\${UV_NO_CACHE-} UV_NO_CONFIG=\${UV_NO_CONFIG-} UV_CACHE_DIR=\${UV_CACHE_DIR-} UV_PYTHON_INSTALL_DIR=\${UV_PYTHON_INSTALL_DIR-} UV_PYTHON_INSTALL_MIRROR=\${UV_PYTHON_INSTALL_MIRROR-} UV_MANAGED_PYTHON=\${UV_MANAGED_PYTHON-} UV_PYTHON_DOWNLOADS=\${UV_PYTHON_DOWNLOADS-} UV_TOOL_DIR=\${UV_TOOL_DIR-} UV_TOOL_BIN_DIR=\${UV_TOOL_BIN_DIR-} UV_PYTHON_BIN_DIR=\${UV_PYTHON_BIN_DIR-} install_name_tool=$(command -v install_name_tool || echo none)" >> "$log"
case "$1" in
  --version) echo '${shown}'; exit 0 ;;
  python)
    case "$2" in
      install)
        ${options.installDelaySeconds ? `sleep ${options.installDelaySeconds}` : ':'}
        [ "$3" = '${key}' ] || { echo "error: no download for $3" >&2; exit 2; }
        # Like the real uv: an install initializes the user's cache unless UV_NO_CACHE says not to.
        [ -n "\${UV_NO_CACHE:-}" ] || mkdir -p "$HOME/.cache/uv"
        mirror="\${UV_PYTHON_INSTALL_MIRROR#file://}"
        mirror="$(printf '%s' "$mirror" | /usr/bin/perl -pe 's/%([0-9A-Fa-f]{2})/chr(hex($1))/ge')"
        src="$mirror/${options.pythonBuild}/${file}"
        [ -f "$src" ] || { echo "error: Failed to download $src" >&2; exit 1; }
        got="$(/usr/bin/shasum -a 256 "$src" | /usr/bin/awk '{ print $1 }')"
        [ "$got" = '${options.pythonSha256}' ] || { echo "error: Hash mismatch for \`${key}\` Expected: ${options.pythonSha256} Computed: $got" >&2; exit 1; }
        dest="$UV_PYTHON_INSTALL_DIR"
        mkdir -p "$dest/.temp" || exit 1
        tmp="$dest/.temp/unpack-$$"
        rm -rf "$tmp"; mkdir -p "$tmp" || exit 1
        /usr/bin/tar -xzf "$src" -C "$tmp" || exit 1
        rm -rf "$dest/${key}"
        mv "$tmp/python" "$dest/${key}" || exit 1
        rm -rf "$tmp"
        printf '[externally-managed]\\nError=This Python installation is managed by uv and should not be modified.\\n' > "$dest/${key}/lib/python${minor}/EXTERNALLY-MANAGED"
        rm -f "$dest/${minorKey}"
        ln -s "$dest/${key}" "$dest/${minorKey}"
        echo "Installed Python ${options.pythonVersion}" >&2
        exit 0 ;;
      uninstall)
        target="$UV_PYTHON_INSTALL_DIR/$3"
        [ -d "$target" ] || { echo "error: $3 is not installed" >&2; exit 1; }
        rm -rf "$target"
        echo "Uninstalled $3" >&2
        exit 0 ;;
    esac ;;
  cache)
    case "$2" in
      prune) echo "Pruning cache at: $UV_CACHE_DIR" >&2; [ -n "\${BOTBOY_FAKE_UV_PRUNE_DELETES:-}" ] && rm -rf "$UV_CACHE_DIR/$BOTBOY_FAKE_UV_PRUNE_DELETES"; exit 0 ;;
      clean) echo "Clearing cache at: $UV_CACHE_DIR" >&2; rm -rf "$UV_CACHE_DIR"; exit 0 ;;
    esac ;;
esac
echo "fake uv: $*"
exit 0
`;
  fs.writeFileSync(path.join(top, 'uv'), uv, { mode: 0o755 });
  fs.writeFileSync(path.join(top, 'uvx'), `#!/bin/sh\necho "uvx $* | env UV_NO_CACHE=\${UV_NO_CACHE-} UV_MANAGED_PYTHON=\${UV_MANAGED_PYTHON-}" >> '${options.callLog}'\ncase "$1" in --version) echo 'uvx ${options.version} (fake)' ;; *) echo "fake uvx $*" ;; esac\n`, { mode: 0o755 });
  if (options.padBytes) fs.writeFileSync(path.join(top, 'pad.bin'), randomBytes(options.padBytes));
  return pack(dir, root, topName, `${topName}.tar.gz`);
}

export type PyPinOptions = {
  uvVersion?: string;
  pythonVersion?: string;
  pythonBuild?: string;
  eol?: string;
  uv?: Partial<Record<Chip, { sha256: string; bytes: number } | null>>;
  python?: Partial<Record<Chip, { sha256: string; bytes: number } | null>>;
  extra?: string[];
};

/** The text of a python-runtime.pin. */
export function pyPinText(options: PyPinOptions = {}): string {
  const lines = [
    '# test pin',
    'schema=1',
    `uv.version=${options.uvVersion ?? '0.13.0'}`,
  ];
  for (const chip of ['arm64', 'x64'] as const) {
    const entry = options.uv?.[chip];
    if (entry) lines.push(`uv.darwin-${chip}.sha256=${entry.sha256}`, `uv.darwin-${chip}.bytes=${entry.bytes}`);
  }
  lines.push(
    `python.version=${options.pythonVersion ?? '3.13.16'}`,
    `python.build=${options.pythonBuild ?? '20261009'}`,
    `python.eol=${options.eol ?? '2099-10-31'}`,
  );
  for (const chip of ['arm64', 'x64'] as const) {
    const entry = options.python?.[chip];
    if (entry) lines.push(`python.darwin-${chip}.sha256=${entry.sha256}`, `python.darwin-${chip}.bytes=${entry.bytes}`);
  }
  lines.push(...(options.extra ?? []));
  return `${lines.join('\n')}\n`;
}

/** The URL paths start.sh asks for, under the GitHub stand-in. */
export const uvPath = (version: string, chip: Chip) => `/astral-sh/uv/releases/download/${version}/uv-${TRIPLE_ARCH[chip]}-apple-darwin.tar.gz`;
export const pythonPath = (version: string, build: string, chip: Chip) => `/astral-sh/python-build-standalone/releases/download/${build}/cpython-${version}%2B${build}-${TRIPLE_ARCH[chip]}-apple-darwin-install_only_stripped.tar.gz`;
