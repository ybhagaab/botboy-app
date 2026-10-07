/**
 * Stored definition of one user-added MCP server (MCP_REMOTE_TRANSPORTS_PLAN.md
 * MR1). Pure: no I/O. The manager owns persistence and Keychain access.
 *
 * Two kinds share one row (`mcp_servers.kind = 'custom'`):
 *   - local:  a command BotBoy launches as a stdio child (transport `stdio`);
 *   - remote: an HTTPS endpoint (transport `http`, `sse`, or `auto`, which
 *     tries Streamable HTTP first and falls back to legacy SSE).
 *
 * Every env and header VALUE lives in the macOS Keychain (owner decision
 * MD4). The row keeps names, a secret flag, and whether a value is saved.
 * The model may read non-secret values and every other field; secret values
 * are typed by the owner on the review card and are never returned.
 *
 * Review (owner rule MD7): an assistant edit needs the owner's Start again
 * only when the server's identity changes: the command or its arguments for
 * a local server, or the origin (scheme, host, port) for a remote one.
 */

import fs from 'node:fs';
import path from 'node:path';

export type CustomMcpTransport = 'stdio' | 'http' | 'sse' | 'auto';
export type CustomMcpOrigin = 'user' | 'assistant';
export type CustomValueKind = 'env' | 'header';

export interface CustomValueEntry {
  name: string;
  secret: boolean;
  /** A value is saved in Keychain. */
  hasValue: boolean;
  /** Start waits until this value is saved. */
  required: boolean;
  /**
   * Header format with one `{value}` slot, e.g. `Bearer {value}`, so the
   * owner types only the key. Headers only.
   */
  template?: string;
  description?: string;
}

export interface CustomServerAbout {
  publisher?: string;
  description?: string;
  /** Where the definition came from, e.g. `registry:io.github.x/y`, `aim:andes-mcp`, a docs URL. */
  source?: string;
  website?: string;
}

export interface CustomServerConfig {
  version: 2;
  transport: CustomMcpTransport;
  /** Local servers only. */
  command: string;
  args: string[];
  /** Remote servers only. */
  url: string;
  env: CustomValueEntry[];
  headers: CustomValueEntry[];
  /** The transport an `auto` server answered on last time. */
  detectedTransport?: 'http' | 'sse';
  about: CustomServerAbout;
  origin: CustomMcpOrigin;
  reviewed: boolean;
  /**
   * Version-1 rows stored env values inline. Kept only until the manager
   * moves them into Keychain; never written by version 2 code paths.
   */
  legacyEnv?: Record<string, string>;
}

/** What one create or update asks for, after validation. */
export interface NormalizedCustomServerInput {
  name: string;
  transport: CustomMcpTransport;
  command: string;
  args: string[];
  url: string;
  env: CustomValueEntry[];
  headers: CustomValueEntry[];
  about: CustomServerAbout;
  /** Non-empty values to save, keyed by `valueKey`. */
  values: Map<string, string>;
}

/** Mask the owner UI shows for a saved secret; sending it back keeps the value. */
export const KEEP_SECRET_MASK = '••••••••';

export const MCP_SERVER_CARD_ID_PATTERN = /^custom-[a-z0-9][a-z0-9-]{0,79}$/;

export function mcpServerCardMarker(serverId: string): string {
  return `[[mcp-server:${serverId}]]`;
}

/** Chat tools whose success receipt names a server the owner should see as a card. */
const CARD_TOOLS = new Set(['mcp_add_custom_server', 'mcp_update_custom_server']);

/** The server a successful add/update receipt names, or null. */
export function mcpServerIdFromToolResult(toolName: string, content: unknown): string | null {
  if (!CARD_TOOLS.has(toolName) || typeof content !== 'string') return null;
  try {
    const parsed = JSON.parse(content);
    return parsed?.ok === true && typeof parsed.serverId === 'string' && MCP_SERVER_CARD_ID_PATTERN.test(parsed.serverId)
      ? parsed.serverId
      : null;
  } catch {
    return null;
  }
}

/**
 * Every server BotBoy added or changed in a turn shows as its chat card
 * (app.js expands `[[mcp-server:<id>]]`); a marker the reply left out is
 * appended, so the owner always sees what to review and start.
 */
export function withMcpServerCards(content: string, serverIds: Iterable<string>): string {
  const missing = [...new Set(serverIds)].map(mcpServerCardMarker).filter(marker => !content.includes(marker));
  return missing.length ? `${content.trimEnd()}\n\n${missing.join('\n')}` : content;
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,75}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,71}$/;
const MAX_ENTRIES = 64;
const MAX_HEADERS = 32;
const MAX_VALUE_CHARS = 8192;

/** Headers the transport owns. A definition may not set them. */
const RESERVED_HEADERS = new Set([
  'host', 'content-length', 'content-type', 'accept', 'connection', 'transfer-encoding',
  'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'upgrade', 'te', 'trailer',
  'keep-alive', 'proxy-connection', 'origin', 'referer', 'cookie2',
]);

/** Header names that always carry a credential. */
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key', 'x-auth-token']);

/**
 * Word parts that mark a credential. Matching is on whole parts of the name
 * (split at `_`, `-`, `.`, and camelCase), so `KEYCHAIN_DIR` is not a secret
 * while `OPENAI_API_KEY` and `accessToken` are.
 */
const SECRET_NAME_PARTS = new Set([
  'key', 'apikey', 'token', 'secret', 'password', 'passwd', 'pwd', 'passphrase',
  'cookie', 'cookies', 'credential', 'credentials', 'pat', 'bearer', 'authorization', 'jwt',
]);

export function looksSecret(name: string): boolean {
  if (SECRET_HEADERS.has(name.toLowerCase())) return true;
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map(part => part.toLowerCase())
    .filter(Boolean);
  return parts.some(part => SECRET_NAME_PARTS.has(part));
}

/** Keychain account name for one value of one server. */
export function valueKey(kind: CustomValueKind, name: string): string {
  return `${kind}-${name}`;
}

/** What the owner must review again when it changes (owner rule MD7). */
export function customServerIdentity(config: Pick<CustomServerConfig, 'transport' | 'command' | 'args' | 'url'>): string {
  if (config.transport === 'stdio') return `stdio|${config.command}|${JSON.stringify(config.args)}`;
  try {
    return `remote|${new URL(config.url).origin}`;
  } catch {
    return `remote|${config.url}`;
  }
}

export function isRemoteTransport(transport: CustomMcpTransport): boolean {
  return transport !== 'stdio';
}

function cleanText(value: unknown, label: string, max: number): string {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const cleaned = value.trim();
  if (cleaned.length > max) throw new Error(`${label} is too long (at most ${max} characters)`);
  if (cleaned.includes('\0')) throw new Error(`${label} contains a null byte`);
  return cleaned;
}

function boundedOptional(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\0/g, '').trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** `${env:X}`, `${input:x}`, `<TOKEN>`, `{api_key}`, `YOUR_KEY_HERE`, a saved-secret mask. */
const WHOLE_PLACEHOLDER = /^(?:\$\{[^}]{0,200}\}|<[^<>]{1,200}>|\{[^{}]{1,200}\}|•+|\*{3,}|x{4,})$/i;
const WORD_PLACEHOLDER = /^(?:your[\s_-].*|replace[\s_-]?(?:me|with.*)|changeme|change[\s_-]me|todo|tbd|placeholder)$/i;
/** One placeholder inside a longer value, e.g. `Bearer {smithery_api_key}`. */
const EMBEDDED_PLACEHOLDER = /\$\{[^}]{1,200}\}|<[^<>]{1,200}>|\{[^{}]{1,200}\}/g;

export function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed || trimmed === KEEP_SECRET_MASK || WHOLE_PLACEHOLDER.test(trimmed) || WORD_PLACEHOLDER.test(trimmed);
}

/**
 * Split a header value such as `Bearer {token}` into a template the owner
 * fills with just the key. Returns null when the value has no single slot.
 */
export function headerTemplateOf(value: string): string | null {
  const trimmed = value.trim();
  if (isPlaceholderValue(trimmed)) return null;
  const slots = trimmed.match(EMBEDDED_PLACEHOLDER);
  if (!slots || slots.length !== 1) return null;
  return trimmed.replace(slots[0], '{value}');
}

/** The header the server receives for a saved value. */
export function renderHeaderValue(entry: Pick<CustomValueEntry, 'template'>, value: string): string {
  if (!entry.template) return value;
  const prefix = entry.template.split('{value}')[0];
  // A pasted full value ("Bearer abc") is sent as typed.
  if (prefix && value.toLowerCase().startsWith(prefix.toLowerCase())) return value;
  return entry.template.replace('{value}', value);
}

function normalizeTransport(value: unknown): CustomMcpTransport | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error('transport must be a string');
  const key = value.trim().toLowerCase().replace(/[\s_]/g, '-');
  if (key === 'stdio' || key === 'local' || key === 'command') return 'stdio';
  if (key === 'http' || key === 'https' || key === 'streamable-http' || key === 'streamablehttp' || key === 'streamable') return 'http';
  if (key === 'sse' || key === 'http-sse' || key === 'http+sse') return 'sse';
  if (key === 'auto' || key === 'remote' || key === 'url') return 'auto';
  throw new Error(`transport '${value.slice(0, 40)}' is not supported; use stdio for a local command, or http, sse, or auto for a remote URL`);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Validate a remote MCP endpoint URL. Throws an owner-readable error. */
export function validateRemoteUrl(value: unknown): string {
  const raw = cleanText(value, 'url', 2048);
  if (!raw) throw new Error('url is required for a remote MCP server');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`url '${raw.slice(0, 80)}' is not a valid web address`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('url must start with https://');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw new Error('url must use https:// (plain http:// is allowed only for a server on this Mac)');
  }
  if (parsed.username || parsed.password) {
    throw new Error('url must not carry a user name or password; put credentials in a header the owner fills on the card');
  }
  for (const name of parsed.searchParams.keys()) {
    if (looksSecret(name)) {
      throw new Error(`url carries a credential in its query (${name}); use the server's header option so BotBoy can keep the key in Keychain`);
    }
  }
  parsed.hash = '';
  return parsed.toString();
}

/** Split `npx -y pkg` typed as one command into command + arguments. */
function splitCommand(command: string): { command: string; extraArgs: string[] } {
  if (!/\s/.test(command)) return { command, extraArgs: [] };
  if (path.isAbsolute(command)) {
    try {
      if (fs.statSync(command).isFile()) return { command, extraArgs: [] };
    } catch { /* not an existing file: split below */ }
  }
  const [first, ...rest] = command.split(/\s+/).filter(Boolean);
  return { command: first, extraArgs: rest };
}

function parseValueMap(
  value: unknown,
  kind: CustomValueKind,
): Array<{ name: string; value: string }> {
  if (value == null) return [];
  const label = kind === 'env' ? 'env' : 'headers';
  // Accept both {NAME: value} and [{name, value}] shapes.
  const pairs: Array<{ name: string; value: unknown }> = Array.isArray(value)
    ? value.map((item) => {
      const record = plainObject(item);
      if (!record) throw new Error(`${label} entries must be objects with name and value`);
      return { name: String(record.name ?? ''), value: record.value ?? '' };
    })
    : (() => {
      const record = plainObject(value);
      if (!record) throw new Error(`${label} must be an object of name to value`);
      return Object.entries(record).map(([name, item]) => ({ name, value: item }));
    })();
  const limit = kind === 'env' ? MAX_ENTRIES : MAX_HEADERS;
  if (pairs.length > limit) throw new Error(`${label} accepts at most ${limit} entries`);
  const seen = new Set<string>();
  return pairs.map(({ name, value: item }) => {
    const pattern = kind === 'env' ? ENV_NAME_PATTERN : HEADER_NAME_PATTERN;
    if (!pattern.test(name)) {
      throw new Error(`${kind === 'env' ? 'env variable' : 'header'} name '${String(name).slice(0, 40)}' is not valid`);
    }
    if (kind === 'header' && RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new Error(`header ${name} is set by BotBoy itself and cannot be configured`);
    }
    const dedupe = kind === 'header' ? name.toLowerCase() : name;
    if (seen.has(dedupe)) throw new Error(`${label} lists ${name} twice`);
    seen.add(dedupe);
    if (item != null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new Error(`${kind === 'env' ? 'env variable' : 'header'} ${name} must be a string`);
    }
    const text = item == null ? '' : String(item);
    if (text.length > MAX_VALUE_CHARS) throw new Error(`${kind === 'env' ? 'env variable' : 'header'} ${name} is too long`);
    if (text.includes('\0')) throw new Error(`${kind === 'env' ? 'env variable' : 'header'} ${name} contains a null byte`);
    if (kind === 'header' && /[\r\n]/.test(text)) throw new Error(`header ${name} must be one line`);
    return { name, value: text };
  });
}

function parseNameList(value: unknown, label: string): Set<string> {
  if (value == null) return new Set();
  if (!Array.isArray(value)) throw new Error(`${label} must be a list of names`);
  return new Set(value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean));
}

function parseAbout(value: unknown): CustomServerAbout {
  const record = plainObject(value) ?? {};
  const website = boundedOptional(record.website, 2048);
  return {
    ...(boundedOptional(record.publisher, 120) ? { publisher: boundedOptional(record.publisher, 120) } : {}),
    ...(boundedOptional(record.description, 600) ? { description: boundedOptional(record.description, 600) } : {}),
    ...(boundedOptional(record.source, 300) ? { source: boundedOptional(record.source, 300) } : {}),
    ...(website && /^https?:\/\//i.test(website) ? { website } : {}),
  };
}

/**
 * Validate one create or update. `previous` is the stored definition for an
 * update: omitted fields keep their values, and secret values stay saved
 * while their name stays listed.
 *
 * Assistant definitions never carry secret values: the owner types them on
 * the review card. A non-placeholder value for a secret name is refused with
 * the next action, so the model asks instead of storing what it was told.
 */
export function normalizeCustomServerInput(
  input: unknown,
  options: { origin: CustomMcpOrigin; previous?: CustomServerConfig | null; previousName?: string },
): NormalizedCustomServerInput {
  const record = plainObject(input);
  if (!record) throw new Error('The server definition must be a JSON object');
  const previous = options.previous ?? null;

  const nameInput = cleanText(record.name, 'name', 80);
  const name = nameInput || options.previousName || '';
  if (!name) throw new Error('name is required');

  const explicitTransport = normalizeTransport(record.transport ?? record.type);
  const commandInput = cleanText(record.command, 'command', 1024);
  const urlInput = cleanText(record.url ?? record.serverUrl ?? record.httpUrl, 'url', 2048);
  if (commandInput && urlInput) {
    throw new Error('Give either a command (a local server) or a url (a remote server), not both');
  }
  let transport: CustomMcpTransport;
  if (explicitTransport === 'stdio' || commandInput) transport = 'stdio';
  else if (urlInput || explicitTransport) transport = explicitTransport ?? 'auto';
  else if (previous) transport = previous.transport;
  else throw new Error('command is required for a local server, or url for a remote server');
  if (commandInput && explicitTransport && explicitTransport !== 'stdio') {
    throw new Error(`transport ${explicitTransport} needs a url; a command runs as a local stdio server`);
  }

  const explicitSecrets = parseNameList(record.secret ?? record.secrets, 'secret');
  const requiredNames = record.required === undefined ? null : parseNameList(record.required, 'required');

  let command = '';
  let args: string[] = [];
  let url = '';
  if (transport === 'stdio') {
    const rawCommand = commandInput || (previous?.transport === 'stdio' ? previous.command : '');
    if (!rawCommand) throw new Error('command is required');
    const split = splitCommand(rawCommand);
    command = split.command;
    if (command.includes(path.sep) && !path.isAbsolute(command)) {
      throw new Error('command must be an executable name or an absolute path');
    }
    if (record.args !== undefined && !Array.isArray(record.args)) throw new Error('args must be an array of strings');
    const rawArgs = Array.isArray(record.args)
      ? record.args
      : commandInput ? [] : (previous?.transport === 'stdio' ? previous.args : []);
    const allArgs = [...split.extraArgs, ...rawArgs];
    if (allArgs.length > 64) throw new Error('args accepts at most 64 entries');
    args = allArgs.map((value, index) => {
      if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`args[${index}] must be a string`);
      return cleanText(String(value), `args[${index}]`, 2048);
    });
  } else {
    url = validateRemoteUrl(urlInput || (previous && isRemoteTransport(previous.transport) ? previous.url : ''));
  }

  const values = new Map<string, string>();
  const buildEntries = (kind: CustomValueKind, provided: unknown): CustomValueEntry[] => {
    const previousEntries = previous ? (kind === 'env' ? previous.env : previous.headers) : [];
    if (provided === undefined) return previousEntries.map(entry => ({ ...entry }));
    return parseValueMap(provided, kind).map(({ name: entryName, value }) => {
      const prior = previousEntries.find(entry => (kind === 'header' ? entry.name.toLowerCase() === entryName.toLowerCase() : entry.name === entryName));
      const template = kind === 'header' ? headerTemplateOf(value) : null;
      const secret = explicitSecrets.has(entryName) || looksSecret(entryName) || Boolean(prior?.secret);
      const placeholder = template !== null || isPlaceholderValue(value);
      if (secret && !placeholder && options.origin === 'assistant') {
        throw new Error(`${entryName} is a secret: leave its value empty and ask the owner to type it into the server's card. Do not repeat the value in chat.`);
      }
      if (!placeholder) values.set(valueKey(kind, entryName), value);
      const required = requiredNames ? requiredNames.has(entryName) : (prior?.required ?? secret);
      return {
        name: entryName,
        secret,
        hasValue: placeholder ? Boolean(prior?.hasValue) : true,
        required,
        ...(template ? { template } : prior?.template ? { template: prior.template } : {}),
        ...(prior?.description ? { description: prior.description } : {}),
      };
    });
  };
  const env = buildEntries('env', record.env);
  const headers = transport === 'stdio' ? [] : buildEntries('header', record.headers);
  if (transport === 'stdio' && record.headers !== undefined && plainObject(record.headers) && Object.keys(record.headers as object).length) {
    throw new Error('headers apply to remote servers only; a local server takes env variables');
  }

  return {
    name,
    transport,
    command,
    args,
    url,
    env,
    headers,
    about: record.about !== undefined ? parseAbout(record.about) : (previous?.about ?? {}),
    values,
  };
}

function parseEntries(value: unknown, kind: CustomValueKind): CustomValueEntry[] {
  if (!Array.isArray(value)) return [];
  const pattern = kind === 'env' ? ENV_NAME_PATTERN : HEADER_NAME_PATTERN;
  return value.flatMap((item) => {
    const record = plainObject(item);
    if (!record || typeof record.name !== 'string' || !pattern.test(record.name)) return [];
    return [{
      name: record.name,
      secret: record.secret === true,
      hasValue: record.hasValue === true,
      required: record.required === true,
      ...(kind === 'header' && typeof record.template === 'string' && record.template.includes('{value}') ? { template: record.template.slice(0, 500) } : {}),
      ...(typeof record.description === 'string' ? { description: record.description.slice(0, 300) } : {}),
    }];
  });
}

/**
 * Read one stored row. Version-1 rows (`env` as an object of values) parse as
 * local servers whose values wait in `legacyEnv` for the Keychain move.
 * Rows written before review tracking count as user-authored and reviewed.
 */
export function parseCustomConfig(raw: string | null | undefined): CustomServerConfig {
  let parsed: unknown = {};
  try { parsed = JSON.parse(raw || '{}'); } catch { /* defaults below */ }
  const record = plainObject(parsed) ?? {};
  const origin: CustomMcpOrigin = record.origin === 'assistant' ? 'assistant' : 'user';
  const reviewed = typeof record.reviewed === 'boolean' ? record.reviewed : true;
  const about = parseAbout(record.about);
  if (record.version === 2) {
    let transport: CustomMcpTransport = 'stdio';
    try { transport = normalizeTransport(record.transport) ?? 'stdio'; } catch { transport = 'stdio'; }
    const legacyRecord = plainObject(record.legacyEnv);
    const legacyEnv = legacyRecord
      ? Object.fromEntries(Object.entries(legacyRecord).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : undefined;
    return {
      version: 2,
      transport,
      command: typeof record.command === 'string' ? record.command : '',
      args: Array.isArray(record.args) ? record.args.filter((value): value is string => typeof value === 'string') : [],
      url: typeof record.url === 'string' ? record.url : '',
      env: parseEntries(record.env, 'env'),
      headers: parseEntries(record.headers, 'header'),
      ...(record.detectedTransport === 'http' || record.detectedTransport === 'sse' ? { detectedTransport: record.detectedTransport } : {}),
      about,
      origin,
      reviewed,
      ...(legacyEnv && Object.keys(legacyEnv).length ? { legacyEnv } : {}),
    };
  }
  // Version 1: { name, command, args, env: {NAME: value}, origin, reviewed }.
  const legacyEnv: Record<string, string> = {};
  const envRecord = plainObject(record.env);
  if (envRecord) {
    for (const [key, value] of Object.entries(envRecord)) {
      if (typeof value === 'string' && ENV_NAME_PATTERN.test(key)) legacyEnv[key] = value;
    }
  }
  return {
    version: 2,
    transport: 'stdio',
    command: typeof record.command === 'string' ? record.command : '',
    args: Array.isArray(record.args) ? record.args.filter((value): value is string => typeof value === 'string') : [],
    url: '',
    env: Object.keys(legacyEnv).map(name => ({ name, secret: looksSecret(name), hasValue: true, required: false })),
    headers: [],
    about,
    origin,
    reviewed,
    ...(Object.keys(legacyEnv).length ? { legacyEnv } : {}),
  };
}

export function serializeCustomConfig(config: CustomServerConfig): string {
  return JSON.stringify({
    version: 2,
    transport: config.transport,
    command: config.command,
    args: config.args,
    url: config.url,
    env: config.env,
    headers: config.headers,
    ...(config.detectedTransport ? { detectedTransport: config.detectedTransport } : {}),
    about: config.about,
    origin: config.origin,
    reviewed: config.reviewed,
    ...(config.legacyEnv && Object.keys(config.legacyEnv).length ? { legacyEnv: config.legacyEnv } : {}),
  });
}

/** Required values not saved yet, as owner-facing names (`header Authorization`, `API_KEY`). */
export function missingRequiredValues(config: Pick<CustomServerConfig, 'env' | 'headers' | 'legacyEnv'>): string[] {
  return [
    ...config.env.filter(entry => entry.required && !entry.hasValue && !(config.legacyEnv && entry.name in config.legacyEnv)).map(entry => entry.name),
    ...config.headers.filter(entry => entry.required && !entry.hasValue).map(entry => `header ${entry.name}`),
  ];
}

/** Host the calls go to, for owner-facing copy. */
export function remoteHost(config: Pick<CustomServerConfig, 'url'>): string {
  try { return new URL(config.url).host; } catch { return ''; }
}
