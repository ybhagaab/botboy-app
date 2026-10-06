/**
 * The Gmail connection's secrets: a Google OAuth client (Desktop app) and the
 * refresh token Google issued for one account.
 *
 * Two client slots (GMAIL_CHAT_TOOLS_PLAN.md §7):
 *   - `teamClient`: BotBoy's shared client from the owner-issued credential
 *     file (scripts/import-credentials.sh stages it; the server applies it at
 *     boot). Teammates only choose Connect.
 *   - `client`: the owner's own client from Connections → Gmail → Advanced.
 *     It wins over the team client and is never overwritten by an import.
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
  /** The owner's own client (Advanced). Wins over `teamClient`. */
  client?: StoredGmailClient;
  /** BotBoy's shared client from the owner-issued credential file. */
  teamClient?: StoredGmailClient;
  connection?: StoredGmailConnection;
}

export type GmailClientSource = 'own' | 'team';

/** The client BotBoy signs in and refreshes with: the own client, else the team client. */
export function activeGmailClient(stored: StoredGmailCredentials): { client: StoredGmailClient; source: GmailClientSource } | null {
  if (stored.client) return { client: stored.client, source: 'own' };
  if (stored.teamClient) return { client: stored.teamClient, source: 'team' };
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

function readStored(file: string): StoredGmailCredentials {
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
  const teamClient = parseClient(value.teamClient);
  if (teamClient) out.teamClient = teamClient;
  const connection = value.connection;
  if (activeGmailClient(out) && connection && text(connection.refreshToken) && text(connection.accountEmail)) {
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
function keepGrantFor(previous: StoredGmailCredentials, next: StoredGmailCredentials): StoredGmailCredentials {
  if (!previous.connection) return next;
  const before = activeGmailClient(previous)?.client.clientId;
  const after = activeGmailClient(next)?.client.clientId;
  return before && before === after ? { ...next, connection: previous.connection } : next;
}

export interface GmailCredentialStore {
  read(): StoredGmailCredentials;
  /** Saves the owner's own client; the grant rule decides whether the connection stays. */
  saveClient(client: { clientId: string; clientSecret: string }, now?: Date): StoredGmailCredentials;
  /** Saves BotBoy's shared client; an own client stays active. */
  saveTeamClient(client: { clientId: string; clientSecret: string }, now?: Date): StoredGmailCredentials;
  /** Removes the own client; the team client (if any) becomes active. */
  removeOwnClient(): StoredGmailCredentials;
  saveConnection(connection: Omit<StoredGmailConnection, 'connectedAt'>, now?: Date): StoredGmailCredentials;
  clearConnection(): StoredGmailCredentials;
  clearAll(): void;
  readonly file: string;
  readonly privateRoot: string;
}

export function createGmailCredentialStore(deps: { privateRoot?: string } = {}): GmailCredentialStore {
  const privateRoot = deps.privateRoot ?? path.join(os.homedir(), '.personal-productivity-tracker');
  const file = path.join(privateRoot, GMAIL_CREDENTIALS_FILE);
  let cached: StoredGmailCredentials | null = null;

  function current(): StoredGmailCredentials {
    if (!cached) cached = readStored(file);
    return cached;
  }

  function persist(next: StoredGmailCredentials): StoredGmailCredentials {
    if (!next.client && !next.teamClient && !next.connection) fs.rmSync(file, { force: true });
    else writeStored(file, next);
    cached = next;
    return next;
  }

  return {
    file,
    privateRoot,
    read: current,
    saveClient(client, now = new Date()) {
      const previous = current();
      return persist(keepGrantFor(previous, {
        schemaVersion: SCHEMA_VERSION,
        client: { ...client, savedAt: now.toISOString() },
        ...(previous.teamClient ? { teamClient: previous.teamClient } : {}),
      }));
    },
    saveTeamClient(client, now = new Date()) {
      const previous = current();
      return persist(keepGrantFor(previous, {
        schemaVersion: SCHEMA_VERSION,
        ...(previous.client ? { client: previous.client } : {}),
        teamClient: { ...client, savedAt: now.toISOString() },
      }));
    },
    removeOwnClient() {
      const previous = current();
      return persist(keepGrantFor(previous, {
        schemaVersion: SCHEMA_VERSION,
        ...(previous.teamClient ? { teamClient: previous.teamClient } : {}),
      }));
    },
    saveConnection(connection, now = new Date()) {
      const previous = current();
      if (!activeGmailClient(previous)) throw new Error('Save the Google OAuth client before connecting.');
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

// ── BotBoy's shared client, staged by the credential-file import ──────────

/**
 * scripts/import-credentials.sh writes BotBoy's shared Google client here
 * (0600) from the optional `BOTBOY_GMAIL_OAUTH_CLIENT_ID` / `_SECRET` lines.
 * The server applies it once at boot and deletes it
 * (gmail-connection.ts › applyStagedTeamClient), so `gmail.json` keeps one
 * writer and the store's in-memory copy never goes stale.
 */
export const GMAIL_TEAM_CLIENT_INBOX = 'gmail-team-client.json';

export type StagedGmailTeamClient =
  | { status: 'none' }
  | { status: 'invalid'; reason: string }
  | { status: 'ready'; client: { clientId: string; clientSecret: string } };

export function readStagedTeamClient(privateRoot: string): StagedGmailTeamClient {
  const file = path.join(privateRoot, GMAIL_TEAM_CLIENT_INBOX);
  let raw: string;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return { status: 'invalid', reason: 'not a regular file' };
    if (stat.size > 4096) return { status: 'invalid', reason: 'unexpected size' };
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? { status: 'none' }
      : { status: 'invalid', reason: 'unreadable' };
  }
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: 'invalid', reason: 'not JSON' };
  }
  if (value?.schemaVersion !== SCHEMA_VERSION) return { status: 'invalid', reason: 'unknown schema' };
  try {
    return { status: 'ready', client: validateGmailClient({ clientId: value.clientId, clientSecret: value.clientSecret }) };
  } catch (error) {
    return { status: 'invalid', reason: error instanceof GmailCredentialInputError ? `bad ${error.field}` : 'invalid client' };
  }
}

export function removeStagedTeamClient(privateRoot: string): void {
  fs.rmSync(path.join(privateRoot, GMAIL_TEAM_CLIENT_INBOX), { force: true });
}
