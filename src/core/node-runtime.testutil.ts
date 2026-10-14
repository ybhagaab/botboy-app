/**
 * Test helpers for BotBoy's private Node runtime (node-runtime.pin, scripts/node-runtime.sh, start.sh,
 * scripts/verify-node-runtime.mjs). Everything here is hermetic:
 *  - a "Node" tarball is a few shell scripts, never a real Node;
 *  - the download server binds 127.0.0.1 only, on an ephemeral port, and is closed by the test;
 *  - nothing here names a real remote, a browser, osascript, open or lsregister.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export type FakeTarballOptions = {
  version: string;
  arch: 'arm64' | 'x64';
  /** The text `bin/node --version` prints; defaults to v<version>. A wrong one makes the smoke test fail. */
  versionOutput?: string;
  /** Leave `bin/npm` out of the tarball. */
  withoutNpm?: boolean;
  /** `bin/node` exits 1 for everything (an unpacked Node that does not run). */
  brokenNode?: boolean;
  /** Extra bytes so a test can make the file big enough to cut in the middle. */
  padBytes?: number;
};

export type FakeTarball = { file: string; body: Buffer; sha256: string; bytes: number; name: string; topDir: string };

/** A real .tar.gz holding a fake `node-v<version>-darwin-<arch>/` tree. */
export function fakeNodeTarball(dir: string, options: FakeTarballOptions): FakeTarball {
  const topDir = `node-v${options.version}-darwin-${options.arch}`;
  const root = fs.mkdtempSync(path.join(dir, 'tree-'));
  const top = path.join(root, topDir);
  fs.mkdirSync(path.join(top, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(top, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
  const shown = options.versionOutput ?? `v${options.version}`;
  // `node --version` and the smoke's `node -e ... process.stdout.write(process.version)` both print the version.
  const nodeBody = options.brokenNode
    ? '#!/bin/sh\nexit 1\n'
    : `#!/bin/sh\ncase "$1" in\n  --version) echo '${shown}' ;;\n  -e) printf '%s' '${shown}' ;;\n  *) echo "fake node ${shown} $*" ;;\nesac\n`;
  fs.writeFileSync(path.join(top, 'bin', 'node'), nodeBody, { mode: 0o755 });
  if (!options.withoutNpm) {
    // Reports which `node` it finds first on PATH: how a test sees that npm's shebang resolves to this runtime.
    fs.writeFileSync(
      path.join(top, 'bin', 'npm'),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi\necho "npm-called $* node=$(command -v node) path1=${PATH%%:*}"\nexit 0\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(top, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '// fake npm\n');
  }
  fs.writeFileSync(path.join(top, 'LICENSE'), 'fake\n');
  if (options.padBytes) fs.writeFileSync(path.join(top, 'pad.bin'), randomBytes(options.padBytes)); // incompressible, so the tarball really is that big
  const name = `${topDir}.tar.gz`;
  const file = path.join(dir, name);
  const packed = spawnSync('/usr/bin/tar', ['-czf', file, '-C', root, topDir], { encoding: 'utf8' });
  if (packed.status !== 0) throw new Error(`tar failed: ${packed.stderr}`);
  fs.rmSync(root, { recursive: true, force: true });
  const body = fs.readFileSync(file);
  return { file, body, sha256: sha256(body), bytes: body.length, name, topDir };
}

export type PinOptions = {
  version: string;
  line?: number;
  eol?: string;
  minMacos?: string;
  arm64?: { sha256: string; bytes: number } | null;
  x64?: { sha256: string; bytes: number } | null;
  extra?: string[];
};

/** The text of a node-runtime.pin. */
export function pinText(options: PinOptions): string {
  const lines = [
    '# test pin',
    'schema=1',
    `version=${options.version}`,
    `line=${options.line ?? Number(options.version.split('.')[0])}`,
    `eol=${options.eol ?? '2099-04-30'}`,
    `min_macos=${options.minMacos ?? '11.0'}`,
  ];
  if (options.arm64) lines.push(`darwin-arm64.sha256=${options.arm64.sha256}`, `darwin-arm64.bytes=${options.arm64.bytes}`);
  if (options.x64) lines.push(`darwin-x64.sha256=${options.x64.sha256}`, `darwin-x64.bytes=${options.x64.bytes}`);
  lines.push(...(options.extra ?? []));
  return `${lines.join('\n')}\n`;
}

export type DistFile = {
  body: Buffer;
  /** Status to answer with instead of 200/206. */
  status?: number;
  /** Close the connection after this many body bytes of a response... */
  cutAfter?: number;
  /** ...for the first N matching requests only (default: every request). */
  cutTimes?: number;
  /** Ignore Range headers and always send the whole body with 200. */
  ignoreRange?: boolean;
  /** Wait before answering. */
  delayMs?: number;
  /** What a HEAD request reports as Content-Length, without keeping a body that big (default: the body's length). */
  headLength?: number;
};

export type DistRequest = { method: string; url: string; range: string | null };

/** A tiny nodejs.org stand-in on 127.0.0.1 (never any other interface): GET, HEAD, Range, cut-offs, error statuses. */
export async function startDistServer(files: Record<string, DistFile>) {
  const requests: DistRequest[] = [];
  const cuts = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    const method = req.method ?? 'GET';
    const range = typeof req.headers.range === 'string' ? req.headers.range : null;
    requests.push({ method, url, range });
    const file = files[url];
    const respond = () => {
      if (!file) {
        res.writeHead(404, { 'Content-Length': 0 });
        res.end();
        return;
      }
      if (file.status && file.status !== 200) {
        res.writeHead(file.status, { 'Content-Length': 0 });
        res.end();
        return;
      }
      let start = 0;
      let status = 200;
      const match = range && !file.ignoreRange ? /^bytes=(\d+)-$/.exec(range) : null;
      if (match) {
        start = Number(match[1]);
        if (start >= file.body.length) {
          res.writeHead(416, { 'Content-Range': `bytes */${file.body.length}`, 'Content-Length': 0 });
          res.end();
          return;
        }
        status = 206;
      }
      const slice = file.body.subarray(start);
      const headers: Record<string, string | number> = { 'Content-Length': method === 'HEAD' && file.headLength !== undefined ? file.headLength : slice.length, 'Content-Type': 'application/octet-stream', 'Accept-Ranges': file.ignoreRange ? 'none' : 'bytes' };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${file.body.length - 1}/${file.body.length}`;
      res.writeHead(status, headers);
      if (method === 'HEAD') {
        res.end();
        return;
      }
      const seen = cuts.get(url) ?? 0;
      if (file.cutAfter !== undefined && seen < (file.cutTimes ?? Infinity)) {
        cuts.set(url, seen + 1);
        res.write(slice.subarray(0, file.cutAfter), () => req.socket.destroy());
        return;
      }
      res.end(slice);
    };
    if (file?.delayMs) setTimeout(respond, file.delayMs);
    else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/** SHASUMS256.txt in nodejs.org's format. */
export function shasums(entries: { name: string; sha256: string }[]): Buffer {
  return Buffer.from(entries.map((entry) => `${entry.sha256}  ${entry.name}`).join('\n') + '\n');
}

export function tempDir(prefix = 'botboy-node-runtime-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
