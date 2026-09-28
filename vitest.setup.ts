import { createRequire } from 'node:module';
import { Server as TlsServer } from 'node:tls';
import { afterAll } from 'vitest';

const require = createRequire(import.meta.url);
const SupertestTest = require('supertest/lib/test.js') as {
  prototype: {
    serverAddress(app: any, requestPath: string): string;
  };
};
const originalServerAddress = SupertestTest.prototype.serverAddress;

/**
 * Supertest 7 starts function-backed apps with hostless `listen(0)` and then
 * always connects to 127.0.0.1. On macOS Node commonly binds that server to
 * IPv6 `::`; an unrelated IPv4-only local service may already own the same
 * numeric port, causing the request to hit that process (observed as Kiro
 * WebSocket 426 responses). Keep Supertest's synchronous ephemeral bind, but
 * connect through the address family that server actually owns.
 */
function familyAwareServerAddress(this: any, app: any, requestPath: string): string {
  let address = app.address();
  if (!address) {
    this._server = app.listen(0);
    address = app.address();
  }
  if (!address || typeof address === 'string') {
    throw new Error('Supertest temporary server did not expose an IP address.');
  }
  const ipv6 = address.family === 'IPv6' || address.family === 6 || String(address.address).includes(':');
  const host = ipv6 ? '[::1]' : '127.0.0.1';
  const protocol = app instanceof TlsServer ? 'https' : 'http';
  return `${protocol}://${host}:${address.port}${requestPath}`;
}

SupertestTest.prototype.serverAddress = familyAwareServerAddress;

afterAll(() => {
  if (SupertestTest.prototype.serverAddress === familyAwareServerAddress) {
    SupertestTest.prototype.serverAddress = originalServerAddress;
  }
});
