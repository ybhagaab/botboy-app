/**
 * The owner's own Slack app client for Sign in with Slack (D6).
 *
 * BotBoy ships no Slack client (repos-and-releases.md, D12): every install
 * saves its own Slack app's Client ID and Client Secret here. The user token
 * that sign-in produces is NOT stored here; it goes through the existing
 * token path (`.env` › SLACK_USER_TOKEN via local-env.ts), so the monitor,
 * token status, and the doctor keep one reader.
 *
 * Same boundary as gmail.json:
 *   - Stored only in ~/.personal-productivity-tracker/slack.json (0600, atomic
 *     temp-write + rename). Never SQLite, never process.env, never a browser
 *     response: the public view carries only the client ID's last characters.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export const SLACK_CREDENTIALS_FILE = 'slack.json';
const SCHEMA_VERSION = 1;

/** Slack app client IDs are two digit groups joined by a dot. */
const CLIENT_ID_PATTERN = /^\d+\.\d+$/;
const CLIENT_SECRET_PATTERN = /^[0-9a-f]{32}$/i;

export type SlackRedirectMode = 'http_loopback' | 'https_paste';
export type SlackConnectedVia = 'oauth' | 'token';

export interface StoredSlackCredentials {
  schema: typeof SCHEMA_VERSION;
  client?: { clientId: string; clientSecret: string };
  redirectMode: SlackRedirectMode;
  connectedVia?: SlackConnectedVia;
  identity?: { user: string; team: string };
}

export interface SlackClientPublicView {
  configured: boolean;
  clientIdSuffix: string | null;
  redirectMode: SlackRedirectMode;
  connectedVia: SlackConnectedVia | null;
  identity: { user: string; team: string } | null;
}

export class SlackCredentialInputError extends Error {
  constructor(message: string, readonly field: 'clientId' | 'clientSecret' | 'redirectMode') {
    super(message);
    this.name = 'SlackCredentialInputError';
  }
}

/** Validated owner input; the message names the field and never echoes the value. */
export function validateSlackClient(input: { clientId?: unknown; clientSecret?: unknown }): { clientId: string; clientSecret: string } {
  const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : '';
  const clientSecret = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : '';
  if (!clientId || clientId.length > 64 || !CLIENT_ID_PATTERN.test(clientId)) {
    throw new SlackCredentialInputError('clientId: paste the Client ID from your Slack app’s Basic Information page (digits, a dot, digits).', 'clientId');
  }
  if (!CLIENT_SECRET_PATTERN.test(clientSecret)) {
    throw new SlackCredentialInputError('clientSecret: paste the Client Secret from the same page (32 letters and digits).', 'clientSecret');
  }
  return { clientId, clientSecret };
}

export function isSlackRedirectMode(value: unknown): value is SlackRedirectMode {
  return value === 'http_loopback' || value === 'https_paste';
}

function empty(): StoredSlackCredentials {
  return { schema: SCHEMA_VERSION, redirectMode: 'http_loopback' };
}

function readStored(file: string): StoredSlackCredentials {
  let raw: string;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return empty();
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return empty();
  }
  let value: any;
  try { value = JSON.parse(raw); } catch {
    console.warn('[Slack] Ignoring an unreadable Slack app file; saving the client again replaces it.');
    return empty();
  }
  if (value?.schema !== SCHEMA_VERSION) return empty();
  const text = (entry: unknown) => (typeof entry === 'string' ? entry.trim() : '');
  const out = empty();
  const clientId = text(value.client?.clientId);
  const clientSecret = text(value.client?.clientSecret);
  if (CLIENT_ID_PATTERN.test(clientId) && CLIENT_SECRET_PATTERN.test(clientSecret)) out.client = { clientId, clientSecret };
  if (isSlackRedirectMode(value.redirectMode)) out.redirectMode = value.redirectMode;
  if (value.connectedVia === 'oauth' || value.connectedVia === 'token') out.connectedVia = value.connectedVia;
  if (value.identity && typeof value.identity === 'object') {
    out.identity = { user: text(value.identity.user).slice(0, 120), team: text(value.identity.team).slice(0, 120) };
  }
  return out;
}

function writeStored(file: string, value: StoredSlackCredentials): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
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
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

export interface SlackCredentialStore {
  readonly file: string;
  read(): StoredSlackCredentials;
  publicView(): SlackClientPublicView;
  saveClient(client: { clientId: string; clientSecret: string }): StoredSlackCredentials;
  setRedirectMode(mode: SlackRedirectMode): StoredSlackCredentials;
  recordConnection(via: SlackConnectedVia, identity: { user: string; team: string } | null): StoredSlackCredentials;
}

export function createSlackCredentialStore(deps: { privateRoot?: string } = {}): SlackCredentialStore {
  const privateRoot = deps.privateRoot ?? path.join(os.homedir(), '.personal-productivity-tracker');
  const file = path.join(privateRoot, SLACK_CREDENTIALS_FILE);
  let cached: StoredSlackCredentials | null = null;
  const current = () => (cached ??= readStored(file));
  const persist = (next: StoredSlackCredentials) => { writeStored(file, next); cached = next; return next; };
  return {
    file,
    read: current,
    publicView() {
      const stored = current();
      return {
        configured: Boolean(stored.client),
        clientIdSuffix: stored.client ? `…${stored.client.clientId.slice(-6)}` : null,
        redirectMode: stored.redirectMode,
        connectedVia: stored.connectedVia ?? null,
        identity: stored.identity ?? null,
      };
    },
    saveClient(client) {
      return persist({ ...current(), client: { clientId: client.clientId, clientSecret: client.clientSecret } });
    },
    setRedirectMode(mode) {
      return persist({ ...current(), redirectMode: mode });
    },
    recordConnection(via, identity) {
      const next: StoredSlackCredentials = { ...current(), connectedVia: via };
      if (identity) next.identity = identity; else delete next.identity;
      return persist(next);
    },
  };
}
