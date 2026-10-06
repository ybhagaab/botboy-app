/**
 * The Gmail connection's secrets: the owner's own Google OAuth client and the
 * refresh token Google issued for one account.
 *
 * The active client (GMAIL_CHAT_TOOLS_PLAN.md D11, D12):
 *   - `client`: the owner's own Desktop app client from Connections → Gmail,
 *     when saved. Every shipped install uses this one.
 *   - otherwise a built-in client (gmail-builtin-client.ts) when that slot is
 *     filled; source `'team'` names it. The slot ships empty (D12), so
 *     `usableBuiltInClient` returns null and the own client is the only path.
 * A `teamClient` slot from the retired credential-file delivery is ignored and
 * dropped on the next write.
 * One grant rule covers every change: the connection survives only while the
 * active client keeps its ID (Google binds a refresh token to the client ID,
 * so a new secret for the same ID keeps working).
 *
 * Same boundary as Settings → AI model keys (ai-model-settings.ts):
 *   - Stored only in ~/.personal-productivity-tracker/gmail.json (0600, atomic,
 *     schema-versioned). Never SQLite (query_db can read the database), never
 *     process.env (model-run shells inherit it), never a browser response.
 *   - The model-command Seatbelt profile denies that directory to every
 *     model-run process; in-process file tools refuse links into it.
 *   - Owner-facing text shows only the client ID's last characters and the
 *     account email.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { BOTBOY_GOOGLE_CLIENT } from './gmail-builtin-client.js';

export const GMAIL_CREDENTIALS_FILE = 'gmail.json';
const SCHEMA_VERSION = 1;

/** Google OAuth client IDs end with this domain (Cloud Console → Clients). */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{4,200}\.apps\.googleusercontent\.com$/;
const CLIENT_SECRET_PATTERN = /^[A-Za-z0-9._~+/=-]{8,200}$/;

export interface StoredGmailClient {
  clientId: string;
  clientSecret: string;
  savedAt: string;
}

export interface StoredGmailConnection {
  refreshToken: string;
  accountEmail: string;
  scope: string;
  connectedAt: string;
}

export interface StoredGmailCredentials {
  schemaVersion: typeof SCHEMA_VERSION;
  /** The owner's own client (Advanced). Wins over the built-in client. */
  client?: StoredGmailClient;
  connection?: StoredGmailConnection;
}

/** `'own'` = the client saved in Connections → Gmail; `'team'` = a built-in client, when that slot is filled. */
export type GmailClientSource = 'own' | 'team';

export type BuiltInGmailClient = Readonly<{ clientId: string; clientSecret: string }>;

/**
 * A built-in client only when both values are set. The shipped slot is empty
 * (D12), so this is null on every install unless a private build fills it.
 */
export function usableBuiltInClient(client: BuiltInGmailClient | null | undefined): BuiltInGmailClient | null {
  return client && client.clientId.trim() && client.clientSecret.trim() ? client : null;
}

/** The client BotBoy signs in and refreshes with: the own client, else the built-in one. */
export function activeGmailClient(
  stored: StoredGmailCredentials,
  builtIn: BuiltInGmailClient | null,
): { client: StoredGmailClient; source: GmailClientSource } | null {
  if (stored.client) return { client: stored.client, source: 'own' };
  if (builtIn) return { client: { clientId: builtIn.clientId, clientSecret: builtIn.clientSecret, savedAt: '' }, source: 'team' };
  return null;
}

export class GmailCredentialInputError extends Error {
  constructor(message: string, readonly field: 'clientId' | 'clientSecret') {
    super(message);
    this.name = 'GmailCredentialInputError';
  }
}

/** Validated owner input; throws an owner-safe message that never echoes the value. */
export function validateGmailClient(input: { clientId?: unknown; clientSecret?: unknown }): { clientId: string; clientSecret: string } {
  const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : '';
  const clientSecret = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : '';
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    throw new GmailCredentialInputError('The client ID should end with .apps.googleusercontent.com (Google Cloud → Clients → your Desktop app client).', 'clientId');
  }
  if (!CLIENT_SECRET_PATTERN.test(clientSecret)) {
    throw new GmailCredentialInputError('Paste the client secret shown next to that client ID (it usually starts with GOCSPX-).', 'clientSecret');
  }
  return { clientId, clientSecret };
}

/** `…abcd.apps.googleusercontent.com` → `…abcd` for owner-facing status. */
export function clientIdSuffix(clientId: string): string {
  const head = clientId.replace(/\.apps\.googleusercontent\.com$/, '');
  return `…${head.slice(-6)}`;
}

function readStored(file: string, builtIn: BuiltInGmailClient | null): StoredGmailCredentials {
  let raw: string;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return { schemaVersion: SCHEMA_VERSION };
    // Self-heal permissions: the tokens must never be readable by other users.
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { schemaVersion: SCHEMA_VERSION };
  }
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    console.warn('[Gmail] Ignoring an unreadable Gmail credentials file; saving the client again replaces it.');
    return { schemaVersion: SCHEMA_VERSION };
  }
  if (value?.schemaVersion !== SCHEMA_VERSION) {
    console.warn('[Gmail] Ignoring a Gmail credentials file with an unknown schema; saving the client again replaces it.');
    return { schemaVersion: SCHEMA_VERSION };
  }
  const text = (entry: unknown) => (typeof entry === 'string' && entry.trim() ? entry.trim() : '');
  const parseClient = (entry: any): StoredGmailClient | undefined => (entry && text(entry.clientId) && text(entry.clientSecret)
    ? { clientId: text(entry.clientId), clientSecret: text(entry.clientSecret), savedAt: text(entry.savedAt) }
    : undefined);
  const out: StoredGmailCredentials = { schemaVersion: SCHEMA_VERSION };
  const client = parseClient(value.client);
  if (client) out.client = client;
  // A legacy `teamClient` (credential-file delivery) is not read: the
  // built-in client took its place, and the next write drops it.
  const connection = value.connection;
  if (activeGmailClient(out, builtIn) && connection && text(connection.refreshToken) && text(connection.accountEmail)) {
    out.connection = {
      refreshToken: text(connection.refreshToken),
      accountEmail: text(connection.accountEmail).toLowerCase(),
      scope: text(connection.scope),
      connectedAt: text(connection.connectedAt),
    };
  }
  return out;
}

function writeStored(file: string, value: StoredGmailCredentials): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    // 'wx': create new only, never through a pre-existing file or link.
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    // Never leave a stray copy of a token behind a failed save.
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * The one grant rule. `next` carries no connection; the previous one is kept
 * only when the active client ID is unchanged.
 */
function keepGrantFor(previous: StoredGmailCredentials, next: StoredGmailCredentials, builtIn: BuiltInGmailClient | null): StoredGmailCredentials {
  if (!previous.connection) return next;
  const before = activeGmailClient(previous, builtIn)?.client.clientId;
  const after = activeGmailClient(next, builtIn)?.client.clientId;
  return before && before === after ? { ...next, connection: previous.connection } : next;
}

export interface GmailCredentialStore {
  read(): StoredGmailCredentials;
  /** Saves the owner's own client; the grant rule decides whether the connection stays. */
  saveClient(client: { clientId: string; clientSecret: string }, now?: Date): StoredGmailCredentials;
  /** Removes the own client; a built-in client, if the slot is filled, becomes active. */
  removeOwnClient(): StoredGmailCredentials;
  saveConnection(connection: Omit<StoredGmailConnection, 'connectedAt'>, now?: Date): StoredGmailCredentials;
  clearConnection(): StoredGmailCredentials;
  clearAll(): void;
  readonly file: string;
  readonly privateRoot: string;
  /** The usable built-in client, or null (always null for the shipped, empty slot). */
  readonly builtInClient: BuiltInGmailClient | null;
}

export function createGmailCredentialStore(deps: { privateRoot?: string; builtInClient?: BuiltInGmailClient | null } = {}): GmailCredentialStore {
  const privateRoot = deps.privateRoot ?? path.join(os.homedir(), '.personal-productivity-tracker');
  const file = path.join(privateRoot, GMAIL_CREDENTIALS_FILE);
  // Tests pass a fake client or null; installs use the shipped slot, which is empty (D12).
  const builtIn = usableBuiltInClient(deps.builtInClient === undefined ? BOTBOY_GOOGLE_CLIENT : deps.builtInClient);
  let cached: StoredGmailCredentials | null = null;

  function current(): StoredGmailCredentials {
    if (!cached) cached = readStored(file, builtIn);
    return cached;
  }

  function persist(next: StoredGmailCredentials): StoredGmailCredentials {
    if (!next.client && !next.connection) fs.rmSync(file, { force: true });
    else writeStored(file, next);
    cached = next;
    return next;
  }

  return {
    file,
    privateRoot,
    builtInClient: builtIn,
    read: current,
    saveClient(client, now = new Date()) {
      const previous = current();
      return persist(keepGrantFor(previous, {
        schemaVersion: SCHEMA_VERSION,
        client: { ...client, savedAt: now.toISOString() },
      }, builtIn));
    },
    removeOwnClient() {
      return persist(keepGrantFor(current(), { schemaVersion: SCHEMA_VERSION }, builtIn));
    },
    saveConnection(connection, now = new Date()) {
      const previous = current();
      if (!activeGmailClient(previous, builtIn)) throw new Error('Save the Google OAuth client before connecting.');
      return persist({ ...previous, connection: { ...connection, connectedAt: now.toISOString() } });
    },
    clearConnection() {
      const previous = current();
      const { connection: _dropped, ...rest } = previous;
      return persist(rest);
    },
    clearAll() {
      persist({ schemaVersion: SCHEMA_VERSION });
    },
  };
}

// ── Retired: the shared client staged by an older credential-file import ──

/**
 * An importer from before D11 wrote BotBoy's shared Google client here from the
 * `BOTBOY_GMAIL_OAUTH_CLIENT_*` lines. That delivery is retired (each install
 * saves its own client, D12), so the server only deletes a leftover file at
 * boot (gmail-connection.ts › retireStagedTeamClient); it is never read.
 */
export const GMAIL_TEAM_CLIENT_INBOX = 'gmail-team-client.json';

/** Deletes a leftover staged file (or a link planted there); true when one existed. */
export function removeStagedTeamClient(privateRoot: string): boolean {
  const file = path.join(privateRoot, GMAIL_TEAM_CLIENT_INBOX);
  try {
    if (fs.lstatSync(file).isDirectory()) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
