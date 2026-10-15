/**
 * A loopback HTTPS server with a SELF-SIGNED certificate: the stand-in for a TLS-inspecting proxy or security product
 * that replaces a provider's certificate with its own (Node then fails with DEPTH_ZERO_SELF_SIGNED_CERT).
 *
 * The key and certificate are made by `openssl` at run time in a private temp folder that is removed when the server
 * closes: no private key is ever committed (this folder ships to botboy-app, and a key literal in a test file would
 * too). It listens on 127.0.0.1 with an ephemeral port only. Where `openssl` is missing, or TLS verification is
 * switched off for the process, `canMakeSelfSignedCert()` is false and the tests that need it skip.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export function canMakeSelfSignedCert(): boolean {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') return false;
  return spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
}

export interface SelfSignedServer {
  /** https://127.0.0.1:<port> */
  readonly url: string;
  readonly requests: { method: string; path: string }[];
  close(): Promise<void>;
}

export async function startSelfSignedServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); },
): Promise<SelfSignedServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-tls-loopback-'));
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  if (made.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('openssl could not make a throwaway certificate');
  }
  const requests: SelfSignedServer['requests'] = [];
  const server = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (req, res) => {
    requests.push({ method: String(req.method), path: String(req.url) });
    handler(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `https://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        resolve();
      });
    }),
  };
}

/** A loopback port nothing listens on: a connect to it is refused at once (ECONNREFUSED). */
export async function closedLoopbackPort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
