import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE_PREFIX = 'com.botboy.mcp';

export interface McpSecretStore {
  get(serverId: string, key: string): Promise<string | null>;
  set(serverId: string, key: string, value: string): Promise<void>;
  delete(serverId: string, key: string): Promise<void>;
  has(serverId: string, key: string): Promise<boolean>;
}

function assertKey(value: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

function serviceName(serverId: string): string {
  assertKey(serverId, 'MCP server id');
  return `${KEYCHAIN_SERVICE_PREFIX}.${serverId}`;
}

/**
 * Store MCP credentials in the login Keychain. BotBoy is a macOS application;
 * refusing an insecure plaintext fallback is intentional.
 */
export function createMcpSecretStore(): McpSecretStore {
  function ensureMacOs(): void {
    if (process.platform !== 'darwin') {
      throw new Error('Secure MCP credential storage requires macOS Keychain');
    }
  }

  return {
    async get(serverId: string, key: string): Promise<string | null> {
      ensureMacOs();
      assertKey(key, 'secret key');
      try {
        const { stdout } = await execFileAsync(
          '/usr/bin/security',
          ['find-generic-password', '-s', serviceName(serverId), '-a', key, '-w'],
          { encoding: 'utf8', maxBuffer: 64 * 1024 },
        );
        return stdout.replace(/[\r\n]+$/, '');
      } catch (error: any) {
        // security exits 44 when the item is absent. Treat any not-found form
        // as missing, but surface Keychain access/interaction failures.
        const detail = `${error?.stderr ?? ''} ${error?.message ?? ''}`;
        if (error?.code === 44 || /could not be found|item not found/i.test(detail)) return null;
        throw new Error(`Could not read MCP credential from Keychain: ${detail.trim()}`);
      }
    },

    async set(serverId: string, key: string, value: string): Promise<void> {
      ensureMacOs();
      assertKey(key, 'secret key');
      if (!value) throw new Error('Credential cannot be empty');
      try {
        // The security CLI has no stdin mode for add-generic-password. execFile
        // avoids shell interpolation and BotBoy never logs this argument.
        await execFileAsync(
          '/usr/bin/security',
          ['add-generic-password', '-U', '-s', serviceName(serverId), '-a', key, '-w', value],
          { encoding: 'utf8', maxBuffer: 64 * 1024 },
        );
      } catch (error: any) {
        const detail = `${error?.stderr ?? ''} ${error?.message ?? ''}`.trim();
        throw new Error(`Could not save MCP credential to Keychain: ${detail}`);
      }
    },

    async delete(serverId: string, key: string): Promise<void> {
      ensureMacOs();
      assertKey(key, 'secret key');
      try {
        await execFileAsync(
          '/usr/bin/security',
          ['delete-generic-password', '-s', serviceName(serverId), '-a', key],
          { encoding: 'utf8', maxBuffer: 64 * 1024 },
        );
      } catch (error: any) {
        const detail = `${error?.stderr ?? ''} ${error?.message ?? ''}`;
        if (error?.code === 44 || /could not be found|item not found/i.test(detail)) return;
        throw new Error(`Could not delete MCP credential from Keychain: ${detail.trim()}`);
      }
    },

    async has(serverId: string, key: string): Promise<boolean> {
      return (await this.get(serverId, key)) !== null;
    },
  };
}
