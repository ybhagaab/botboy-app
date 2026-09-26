import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_APP_PORT = 7778;
const DEFAULT_CDP_PORT = 9222;

function validPort(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback;
}

export function protectedLocalPorts(options: { appPort?: number; cdpPort?: number } = {}): ReadonlySet<number> {
  return new Set([
    validPort(options.appPort ?? process.env.PPT_PORT, DEFAULT_APP_PORT),
    validPort(options.cdpPort, DEFAULT_CDP_PORT),
  ]);
}

function normalizedHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '').split('%')[0];
}

export function isLoopbackAddress(value: string): boolean {
  const address = normalizedHost(value);
  if (address === 'localhost' || address.endsWith('.localhost')) return true;
  if (address === '::1' || address === '0:0:0:0:0:0:0:1' || address === '::' || address === '0.0.0.0') return true;
  if (address.startsWith('::ffff:')) return isLoopbackAddress(address.slice('::ffff:'.length));
  if (isIP(address) === 4) return address.split('.')[0] === '127';
  return false;
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/**
 * Resolve the destination before allowing a model-controlled HTTP navigation.
 * Only BotBoy's own listener and the debug-Chrome control port are protected;
 * ordinary external pages and unrelated local development ports remain usable.
 */
export async function isProtectedLocalHttpUrl(
  value: string | URL,
  options: { appPort?: number; cdpPort?: number } = {},
): Promise<boolean> {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!protectedLocalPorts(options).has(effectivePort(url))) return false;
  const host = normalizedHost(url.hostname);
  if (isLoopbackAddress(host)) return true;
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    return addresses.some(result => isLoopbackAddress(result.address));
  } catch {
    // Let the actual browser/fetch surface an unresolved external host. A
    // failed lookup is never treated as proof that a local address is safe.
    return true;
  }
}

function sandboxLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface ModelCommandSandboxOptions {
  appPort?: number;
  cdpPort?: number;
  privateRoot?: string;
  filesDir?: string;
  shell?: string;
}

interface ModelSandboxBoundary {
  filesDir: string;
  profile: string;
}

function modelSandboxBoundary(options: ModelCommandSandboxOptions): ModelSandboxBoundary {
  const appPort = validPort(options.appPort ?? process.env.PPT_PORT, DEFAULT_APP_PORT);
  const cdpPort = validPort(options.cdpPort, DEFAULT_CDP_PORT);
  const privateRoot = path.resolve(options.privateRoot ?? path.join(os.homedir(), '.personal-productivity-tracker'));
  const filesDir = path.resolve(options.filesDir ?? path.join(privateRoot, 'files'));
  if (filesDir !== privateRoot && !filesDir.startsWith(`${privateRoot}${path.sep}`)) {
    throw new Error('Model command files directory must remain inside BotBoy private storage.');
  }
  return {
    filesDir,
    profile: [
      '(version 1)',
      '(allow default)',
      `(deny network-outbound (remote ip "localhost:${appPort}"))`,
      `(deny network-outbound (remote ip "localhost:${cdpPort}"))`,
      '(deny appleevent-send)',
      `(deny file-read* file-write* (subpath ${sandboxLiteral(privateRoot)}))`,
      `(allow file-read* file-write* (subpath ${sandboxLiteral(filesDir)}))`,
    ].join(' '),
  };
}

export function modelProcessSandboxInvocation(
  executable: string,
  args: string[],
  options: ModelCommandSandboxOptions = {},
): { executable: '/usr/bin/sandbox-exec'; args: string[]; filesDir: string; profile: string } {
  const boundary = modelSandboxBoundary(options);
  return {
    executable: '/usr/bin/sandbox-exec',
    args: ['-p', boundary.profile, executable, ...args],
    ...boundary,
  };
}

/**
 * Every model-authored shell runs under one non-waivable macOS Seatbelt
 * profile. Descendants cannot call BotBoy/CDP, automate native UI, or read or
 * mutate BotBoy's private state; the intentional files workspace remains
 * available, including its owner-created source/build links.
 */
export function modelCommandSandboxInvocation(
  command: string,
  options: ModelCommandSandboxOptions = {},
): { executable: '/usr/bin/sandbox-exec'; args: string[]; filesDir: string; profile: string } {
  return modelProcessSandboxInvocation(options.shell ?? '/bin/zsh', ['-lc', command], options);
}
