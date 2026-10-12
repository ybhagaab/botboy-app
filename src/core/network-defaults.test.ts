import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_NET_ATTEMPT_TIMEOUT_MS,
  MAX_NET_ATTEMPT_TIMEOUT_MS,
  MIN_NET_ATTEMPT_TIMEOUT_MS,
  NET_ATTEMPT_TIMEOUT_ENV,
  applyNetworkDefaults,
  wantedAttemptTimeoutMs,
} from './network-defaults.js';

/**
 * Node 20 gives each address 250 ms to finish its TCP handshake. On the owner's
 * Mac the handshake to Google takes ~310 ms, so every fetch to Google failed
 * with AggregateError ETIMEDOUT + EHOSTUNREACH at ~255 ms while curl worked
 * (Drive consent, Gmail refreshes, remote MCP servers). The server raises the
 * limit once at boot.
 */
describe('network defaults (connect attempt timeout)', () => {
  let original: number | undefined;
  let lines: string[];
  const log = (line: string) => { lines.push(line); };

  beforeEach(() => {
    lines = [];
    original = net.getDefaultAutoSelectFamilyAttemptTimeout?.();
    // Start every test from Node's own default.
    net.setDefaultAutoSelectFamilyAttemptTimeout?.(250);
  });
  afterEach(() => {
    if (original !== undefined) net.setDefaultAutoSelectFamilyAttemptTimeout(original);
  });

  it('raises Node’s 250 ms default to the configured value and logs one line without secrets', () => {
    const result = applyNetworkDefaults({ env: {}, log });
    expect(result).toEqual({ status: 'set', timeoutMs: DEFAULT_NET_ATTEMPT_TIMEOUT_MS, previousMs: 250 });
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(DEFAULT_NET_ATTEMPT_TIMEOUT_MS);
    expect(lines).toEqual(['[Net] connect attempt timeout 2000 ms (Node default 250)']);
  });

  it('keeps the boot value at or above one second (the invariant the maps record)', () => {
    expect(DEFAULT_NET_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
    expect(wantedAttemptTimeoutMs({}).ms).toBeGreaterThanOrEqual(1000);
  });

  it('honors BOTBOY_NET_ATTEMPT_TIMEOUT_MS exactly and clamps it to 250..10000 ms', () => {
    expect(NET_ATTEMPT_TIMEOUT_ENV).toBe('BOTBOY_NET_ATTEMPT_TIMEOUT_MS');
    applyNetworkDefaults({ env: { BOTBOY_NET_ATTEMPT_TIMEOUT_MS: '3500' }, log });
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(3500);
    expect(lines.at(-1)).toBe('[Net] connect attempt timeout 3500 ms (Node default 250; set by BOTBOY_NET_ATTEMPT_TIMEOUT_MS)');

    expect(wantedAttemptTimeoutMs({ BOTBOY_NET_ATTEMPT_TIMEOUT_MS: '10' })).toEqual({ ms: MIN_NET_ATTEMPT_TIMEOUT_MS, fromEnv: true });
    expect(wantedAttemptTimeoutMs({ BOTBOY_NET_ATTEMPT_TIMEOUT_MS: '99999' })).toEqual({ ms: MAX_NET_ATTEMPT_TIMEOUT_MS, fromEnv: true });
    // Not a plain number: the default applies and the value is not treated as an override.
    for (const junk of ['', 'abc', '12ms', '-5', '2e3', '1.5']) {
      expect(wantedAttemptTimeoutMs({ BOTBOY_NET_ATTEMPT_TIMEOUT_MS: junk })).toEqual({ ms: DEFAULT_NET_ATTEMPT_TIMEOUT_MS, fromEnv: false });
    }
  });

  it('never lowers a larger value the owner set (NODE_OPTIONS), but an explicit override wins', () => {
    net.setDefaultAutoSelectFamilyAttemptTimeout(5000);
    expect(applyNetworkDefaults({ env: {}, log })).toEqual({ status: 'kept', timeoutMs: 5000, previousMs: 5000 });
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(5000);
    expect(lines.at(-1)).toBe('[Net] connect attempt timeout 5000 ms (already set; BotBoy keeps it)');

    applyNetworkDefaults({ env: { BOTBOY_NET_ATTEMPT_TIMEOUT_MS: '1000' }, log });
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(1000);
  });

  it('is a harmless no-op on a Node that cannot set the timeout', () => {
    const before = net.getDefaultAutoSelectFamilyAttemptTimeout();
    expect(applyNetworkDefaults({ env: {}, net: {}, log })).toEqual({ status: 'unsupported' });
    expect(applyNetworkDefaults({ env: {}, net: { setDefaultAutoSelectFamilyAttemptTimeout: undefined as unknown as (value: number) => void }, log })).toEqual({ status: 'unsupported' });
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(before);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('cannot be changed on this Node');
  });

  it('works with a setter and no getter (older Node): sets the value, previous unknown', () => {
    const calls: number[] = [];
    const result = applyNetworkDefaults({ env: {}, net: { setDefaultAutoSelectFamilyAttemptTimeout: value => { calls.push(value); } }, log });
    expect(calls).toEqual([2000]);
    expect(result).toEqual({ status: 'set', timeoutMs: 2000, previousMs: null });
  });
});

/** The boot step only helps if it runs before anything opens a socket. */
describe('network defaults boot order', () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

  it('src/index.ts imports the boot module before every other import', () => {
    const imports = read('src/index.ts').split('\n').filter(line => /^import\s/.test(line));
    expect(imports[0]).toBe("import './core/network-defaults-boot.js';");
  });

  it('the boot module applies the defaults when it is imported', () => {
    const boot = read('src/core/network-defaults-boot.ts');
    expect(boot).toMatch(/import \{ applyNetworkDefaults \} from '\.\/network-defaults\.js';/);
    expect(boot).toMatch(/export const NETWORK_DEFAULTS = applyNetworkDefaults\(\);/);
  });
});
