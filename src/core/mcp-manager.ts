import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpSecretStore } from './mcp-secret-store.js';
import { createMcpSecretStore } from './mcp-secret-store.js';
import { classifyMcpTool, validateMcpToolCall } from './mcp-policy.js';
import {
  buildCustomServerDefinition,
  CUSTOM_MCP_ID_PREFIX,
  CUSTOM_MCP_KIND,
  DEFAULT_SQL_CONTEXT_CONFIG,
  executeProfileSetupAction,
  getBuiltInMcpProfile,
  getSetupActionDefinition,
  getTerminalCommandDefinition,
  isBuiltInMcpProfileId,
  pathValueWithFallbackDirectories,
  resolveCommandExecutable,
  resolveDefinitionExecutable,
  sanitizeMcpError,
  SQL_CONTEXT_PROFILE_ID,
  type McpServerDefinition,
} from './mcp-profiles.js';
import { createMcpTerminalEngine } from './mcp-terminal.js';
import type {
  BuiltInMcpProfileId,
  McpCallOptions,
  McpCallResult,
  McpManager,
  McpProfileSnapshot,
  McpProfileTestResult,
  McpServerSnapshot,
  McpServerState,
  McpSetupAction,
  McpSetupActionResult,
  McpToolDescriptor,
  SqlAuthMethod,
  SqlContextMcpConfig,
  SqlContextMcpConfigInput,
  SqlContextMcpConfigView,
  SqlContextSource,
  SqlSslMode,
} from './mcp-types.js';

const require = createRequire(import.meta.url);
const SQL_SERVER_ID = SQL_CONTEXT_PROFILE_ID;

const HEALTH_INTERVAL_MS = 60_000;
const AWS_ENV_KEYS = [
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION',
  'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_SESSION_NAME',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
];

const DEFAULT_SQL_CONFIG: SqlContextMcpConfig = DEFAULT_SQL_CONTEXT_CONFIG;

interface McpServerRow {
  id: string;
  kind: string;
  display_name: string;
  enabled: number;
  config_json: string;
  state: McpServerState;
  server_version: string | null;
  tools_json: string;
  pid: number | null;
  restart_count: number;
  last_error: string | null;
  last_started_at: string | null;
  last_healthy_at: string | null;
  updated_at: string;
}

interface RuntimeState {
  client: Client;
  transport: StdioClientTransport;
  expectedClose: boolean;
  tools: McpToolDescriptor[];
  stderrTail: string[];
  callQueue: Promise<void>;
  pendingCalls: number;
  inFlightCalls: number;
}

interface InternalMcpCallOptions extends McpCallOptions {
  expectedRuntime?: RuntimeState;
  skipIfBusy?: boolean;
}

class RuntimeBusyError extends Error {
  constructor(serverId: string) {
    super(`MCP server '${serverId}' is busy`);
    this.name = 'RuntimeBusyError';
  }
}

function cleanString(value: unknown, label: string, max = 1024): string {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const cleaned = value.trim();
  if (cleaned.length > max) throw new Error(`${label} is too long`);
  if (cleaned.includes('\0')) throw new Error(`${label} contains a null byte`);
  return cleaned;
}

function parseEnum<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`${label} must be one of: ${values.join(', ')}`);
  }
  return value as T;
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseSqlConfig(raw: string | null | undefined): SqlContextMcpConfig {
  let parsed: Partial<SqlContextMcpConfig> = {};
  try { parsed = JSON.parse(raw || '{}'); } catch { /* use defaults */ }
  return { ...DEFAULT_SQL_CONFIG, ...parsed };
}

function serializeSqlConfig(input: SqlContextMcpConfig): string {
  return JSON.stringify(input);
}

function normalizeSqlConfig(
  current: SqlContextMcpConfig,
  input: SqlContextMcpConfigInput,
): SqlContextMcpConfig {
  const next: SqlContextMcpConfig = { ...current };
  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    next.enabled = input.enabled;
  }
  if ('authMethod' in input) next.authMethod = parseEnum<SqlAuthMethod>(input.authMethod, ['direct', 'iam', 'secrets_manager'], 'authMethod');
  if ('host' in input) next.host = cleanString(input.host, 'host', 512);
  if ('port' in input) {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be an integer from 1 to 65535');
    next.port = port;
  }
  if ('database' in input) next.database = cleanString(input.database, 'database', 256);
  if ('username' in input) next.username = cleanString(input.username, 'username', 256);
  if ('clusterId' in input) next.clusterId = cleanString(input.clusterId, 'clusterId', 256);
  if ('secretId' in input) next.secretId = cleanString(input.secretId, 'secretId', 1024);
  if ('awsRegion' in input) next.awsRegion = cleanString(input.awsRegion, 'awsRegion', 128);
  if ('awsProfile' in input) next.awsProfile = cleanString(input.awsProfile, 'awsProfile', 256);
  if ('sslMode' in input) next.sslMode = parseEnum<SqlSslMode>(input.sslMode, ['disable', 'require', 'verify-ca', 'verify-full'], 'sslMode');
  if ('sslCaPath' in input) next.sslCaPath = cleanString(input.sslCaPath, 'sslCaPath', 2048);
  if ('sslCertPath' in input) next.sslCertPath = cleanString(input.sslCertPath, 'sslCertPath', 2048);
  if ('sslKeyPath' in input) next.sslKeyPath = cleanString(input.sslKeyPath, 'sslKeyPath', 2048);
  if ('contextSource' in input) next.contextSource = parseEnum<SqlContextSource>(input.contextSource, ['none', 'directory', 'file', 's3', 'url'], 'contextSource');
  if ('contextValue' in input) next.contextValue = cleanString(input.contextValue, 'contextValue', 4096);

  if (/^https?:\/\//i.test(next.host)) throw new Error('host must be a hostname, not a URL');
  if (next.host && /[\s/]/.test(next.host)) throw new Error('host contains invalid characters');
  if (next.awsRegion && !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(next.awsRegion)) throw new Error('awsRegion is not a valid AWS region name');
  if (next.awsProfile && !/^[a-zA-Z0-9_.@+-]{1,256}$/.test(next.awsProfile)) throw new Error('awsProfile contains invalid characters');
  if (next.contextSource === 'url' && next.contextValue && !/^https:\/\//i.test(next.contextValue)) {
    throw new Error('Schema context URL must use HTTPS');
  }
  if (next.contextSource === 's3' && next.contextValue && !/^s3:\/\/[a-zA-Z0-9._-]+\/.*/.test(next.contextValue)) {
    throw new Error('Schema context S3 value must be an s3://bucket/prefix URI');
  }
  if (['directory', 'file'].includes(next.contextSource) && next.contextValue) {
    next.contextValue = expandHome(next.contextValue);
    if (!path.isAbsolute(next.contextValue)) throw new Error('Local schema context paths must be absolute');
  }
  if (next.contextSource !== 'none' && !next.contextValue) {
    throw new Error('contextValue is required for the selected schema context source');
  }
  return next;
}

function missingConfiguration(config: SqlContextMcpConfig, passwordConfigured: boolean): string[] {
  const missing: string[] = [];
  if (config.authMethod === 'secrets_manager') {
    if (!config.secretId) missing.push('Secrets Manager secret');
  } else {
    if (!config.host) missing.push('database host');
    if (!config.database) missing.push('database name');
    if (!config.username) missing.push('database user');
    if (config.authMethod === 'iam' && !config.clusterId) missing.push('Redshift cluster id');
    if (config.authMethod === 'direct' && !passwordConfigured) missing.push('database password');
  }
  return missing;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function truncateError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? 'Unknown MCP error');
  return text.slice(0, 2000);
}

/** Apply the profile's error policy: redact to safe fixed text, or truncate. */
function describeProfileError(profile: McpServerDefinition | null, value: unknown): string {
  if (profile?.policy.redactErrors) return sanitizeMcpError(profile, value);
  return truncateError(value);
}

/** Parsed non-secret configuration for one user-added MCP server row. */
function parseCustomConfig(raw: string | null | undefined): {
  command: string;
  args: string[];
  env: Record<string, string>;
  origin: 'user' | 'assistant';
  reviewed: boolean;
} {
  let parsed: unknown = {};
  try { parsed = JSON.parse(raw || '{}'); } catch { /* fall through to defaults */ }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const command = typeof record.command === 'string' ? record.command : '';
  const args = Array.isArray(record.args) ? record.args.filter((value): value is string => typeof value === 'string') : [];
  const env: Record<string, string> = {};
  if (record.env && typeof record.env === 'object' && !Array.isArray(record.env)) {
    for (const [key, value] of Object.entries(record.env as Record<string, unknown>)) {
      if (typeof value === 'string') env[key] = value;
    }
  }
  // Rows written before review tracking default to user-authored, reviewed.
  const origin = record.origin === 'assistant' ? 'assistant' as const : 'user' as const;
  const reviewed = typeof record.reviewed === 'boolean' ? record.reviewed : true;
  return { command, args, env, origin, reviewed };
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate one user-supplied custom-server definition. Throws on bad shape. */
function validateCustomServerInput(input: unknown): { name: string; command: string; args: string[]; env: Record<string, string> } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('The server definition must be a JSON object');
  }
  const record = input as Record<string, unknown>;
  const name = cleanString(record.name, 'name', 80);
  if (!name) throw new Error('name is required');
  const command = cleanString(record.command, 'command', 1024);
  if (!command) throw new Error('command is required');
  if (/\s/.test(command)) {
    throw new Error('command must be one executable name or one absolute path; put flags in arguments');
  }
  if (command.includes(path.sep) && !path.isAbsolute(command)) {
    throw new Error('command must be an executable name or an absolute path');
  }

  if (record.args !== undefined && !Array.isArray(record.args)) throw new Error('args must be an array of strings');
  const rawArgs = Array.isArray(record.args) ? record.args : [];
  if (rawArgs.length > 64) throw new Error('args accepts at most 64 entries');
  const args = rawArgs.map((value, index) => cleanString(value, `args[${index}]`, 2048));

  if (record.env !== undefined && (typeof record.env !== 'object' || record.env === null || Array.isArray(record.env))) {
    throw new Error('env must be an object of string values');
  }
  const env: Record<string, string> = {};
  const rawEnv = (record.env ?? {}) as Record<string, unknown>;
  const envEntries = Object.entries(rawEnv);
  if (envEntries.length > 64) throw new Error('env accepts at most 64 variables');
  for (const [key, value] of envEntries) {
    if (!ENV_KEY_PATTERN.test(key) || key.length > 128) throw new Error(`env variable name '${key.slice(0, 40)}' is not valid`);
    if (typeof value !== 'string') throw new Error(`env variable ${key} must be a string`);
    if (value.length > 8192) throw new Error(`env variable ${key} is too long`);
    if (value.includes('\0')) throw new Error(`env variable ${key} contains a null byte`);
    env[key] = value;
  }
  return { name, command, args, env };
}

function parseTools(raw: string): McpToolDescriptor[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function extractResult(result: any): { text: string; isError: boolean; structuredContent?: Record<string, unknown> } {
  if (result && 'toolResult' in result) {
    return { text: JSON.stringify(result.toolResult), isError: false };
  }
  const content = Array.isArray(result?.content) ? result.content : [];
  const pieces: string[] = [];
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') pieces.push(part.text);
    else if (part?.type === 'resource_link') pieces.push(`[Resource: ${part.name ?? part.uri}] ${part.uri ?? ''}`);
    else if (part?.type) pieces.push(`[Unsupported MCP content: ${part.type}]`);
  }
  // Transport stays LOSSLESS. A mid-payload cut here corrupted tool JSON for
  // programmatic consumers (the GRASP mail sync hit it on a 663K email,
  // 2026-08-17). Bounding for the model's context happens at the agent
  // boundary (tool-executor mcp_call_tool), never inside the transport.
  return {
    text: pieces.join('\n\n'),
    isError: result?.isError === true,
    structuredContent: result?.structuredContent,
  };
}

function sqlEnvironment(config: SqlContextMcpConfig, password: string | null): Record<string, string> {
  const env = getDefaultEnvironment();
  for (const key of AWS_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  const values: Record<string, string> = {
    SQL_AUTH_METHOD: config.authMethod,
    SQL_PORT: String(config.port),
    SQL_AWS_REGION: config.awsRegion,
    SQL_SSL_MODE: config.sslMode,
  };
  if (config.host) values.SQL_HOST = config.host;
  if (config.database) values.SQL_DATABASE = config.database;
  if (config.username) values.SQL_USER = config.username;
  if (password && config.authMethod === 'direct') values.SQL_PASSWORD = password;
  if (config.clusterId) values.SQL_CLUSTER_ID = config.clusterId;
  if (config.secretId) values.SQL_SECRET_ID = config.secretId;
  if (config.awsProfile) values.SQL_AWS_PROFILE = config.awsProfile;
  if (config.sslCaPath) values.SQL_SSL_CA = expandHome(config.sslCaPath);
  if (config.sslCertPath) values.SQL_SSL_CERT = expandHome(config.sslCertPath);
  if (config.sslKeyPath) values.SQL_SSL_KEY = expandHome(config.sslKeyPath);
  if (config.contextSource === 'directory') values.SQL_CONTEXT_DIR = config.contextValue;
  if (config.contextSource === 'file') values.SQL_CONTEXT_FILE = config.contextValue;
  if (config.contextSource === 's3') values.SQL_CONTEXT_S3 = config.contextValue;
  if (config.contextSource === 'url') values.SQL_CONTEXT_URL = config.contextValue;
  return { ...env, ...values };
}

export function createMcpManager(options: {
  db: Database.Database;
  secretStore?: McpSecretStore;
  healthIntervalMs?: number;
}): McpManager {
  const db = options.db;
  const secretStore = options.secretStore ?? createMcpSecretStore();
  const runtimes = new Map<string, RuntimeState>();
  const startLocks = new Map<string, Promise<void>>();
  const setupLocks = new Map<string, Promise<McpSetupActionResult>>();
  const setupAbortControllers = new Map<string, AbortController>();
  const terminalEngine = createMcpTerminalEngine();
  const profileLocks = new Map<string, Promise<void>>();
  const restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const consecutiveFailures = new Map<string, number>();
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let active = false;
  let stopping = false;
  let stopPromise: Promise<void> | null = null;
  let healthOperation: Promise<void> | null = null;

  const selectServer = db.prepare('SELECT * FROM mcp_servers WHERE id = ?');

  function row(serverId: string): McpServerRow | null {
    return (selectServer.get(serverId) as McpServerRow | undefined) ?? null;
  }

  /**
   * Resolve the launch-and-policy definition for one server id. Registry
   * profiles come from code; custom servers come from their stored row.
   */
  function definitionFor(serverId: string): McpServerDefinition | null {
    const registered = getBuiltInMcpProfile(serverId);
    if (registered) return registered;
    const server = row(serverId);
    if (!server || server.kind !== CUSTOM_MCP_KIND) return null;
    const config = parseCustomConfig(server.config_json);
    return buildCustomServerDefinition({
      id: server.id,
      displayName: server.display_name,
      command: config.command,
      args: config.args,
      env: config.env,
    });
  }

  async function withProfileLock<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    if (stopping) throw new Error('The managed MCP runtime is shutting down.');
    const previous = profileLocks.get(profileId);
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    profileLocks.set(profileId, lock);
    try {
      if (previous) await previous;
      if (stopping) throw new Error('The managed MCP runtime is shutting down.');
      return await operation();
    } finally {
      release();
      if (profileLocks.get(profileId) === lock) profileLocks.delete(profileId);
    }
  }

  function updateState(
    serverId: string,
    state: McpServerState,
    values: { error?: string | null; pid?: number | null; version?: string | null; tools?: McpToolDescriptor[]; healthy?: boolean } = {},
  ): void {
    const current = row(serverId);
    if (!current) return;
    db.prepare(`
      UPDATE mcp_servers SET
        state = ?,
        last_error = ?,
        pid = ?,
        server_version = ?,
        tools_json = ?,
        last_healthy_at = CASE WHEN ? THEN datetime('now') ELSE last_healthy_at END,
        last_started_at = CASE WHEN ? = 'running' THEN COALESCE(last_started_at, datetime('now')) ELSE last_started_at END,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      state,
      values.error === undefined ? current.last_error : values.error,
      values.pid === undefined ? current.pid : values.pid,
      values.version === undefined ? current.server_version : values.version,
      JSON.stringify(values.tools ?? parseTools(current.tools_json)),
      values.healthy ? 1 : 0,
      state,
      serverId,
    );
  }

  async function passwordConfigured(): Promise<boolean> {
    return secretStore.has(SQL_SERVER_ID, 'password');
  }

  async function configView(): Promise<SqlContextMcpConfigView> {
    const server = row(SQL_SERVER_ID);
    if (!server) throw new Error('Native SQL MCP definition is missing');
    const config = parseSqlConfig(server.config_json);
    const hasPassword = await passwordConfigured();
    return {
      ...config,
      enabled: server.enabled === 1,
      configured: missingConfiguration(config, hasPassword).length === 0,
      passwordConfigured: hasPassword,
    };
  }

  async function profileConfigured(profile: McpServerDefinition | null, server: McpServerRow): Promise<boolean> {
    if (!profile) return false;
    if (profile.launch.type === 'sql-context-package') {
      return missingConfiguration(parseSqlConfig(server.config_json), await passwordConfigured()).length === 0;
    }
    return Boolean(await resolveDefinitionExecutable(profile));
  }

  async function snapshot(server: McpServerRow): Promise<McpServerSnapshot> {
    const profile = definitionFor(server.id);
    const kind = profile?.kind ?? server.kind;
    return {
      id: server.id,
      kind,
      displayName: profile?.displayName ?? server.display_name,
      enabled: server.enabled === 1,
      configured: await profileConfigured(profile, server),
      state: server.state,
      serverVersion: server.server_version ?? undefined,
      packageVersion: profile?.packageVersion ?? 'unknown',
      // Risk labels reflect the CURRENT policy, not the policy at discovery
      // time, so stored descriptors never pin an outdated classification.
      tools: parseTools(server.tools_json).map(tool => ({ ...tool, risk: classifyMcpTool(kind, tool.name) })),
      pid: server.pid ?? undefined,
      restartCount: server.restart_count,
      lastError: server.last_error
        ? profile?.policy.redactErrors ? sanitizeMcpError(profile, server.last_error) : server.last_error
        : undefined,
      lastStartedAt: server.last_started_at ?? undefined,
      lastHealthyAt: server.last_healthy_at ?? undefined,
      updatedAt: server.updated_at,
    };
  }

  async function profileSnapshot(server: McpServerRow): Promise<McpProfileSnapshot> {
    const profile = definitionFor(server.id);
    if (!profile) throw new Error(`Unknown MCP profile: ${server.id}`);
    const base = await snapshot(server);
    const installationState = profile.launch.type === 'local-executable' || profile.launch.type === 'custom-command'
      ? await resolveDefinitionExecutable(profile) ? 'installed' : 'not_installed'
      : 'installed';
    const toolNames = new Set(base.tools.map(tool => tool.name));
    const missingTools = profile.requiredTools.filter(name => !toolNames.has(name));
    const compatibilityState = base.tools.length === 0
      ? 'unchecked'
      : missingTools.length > 0 ? 'incompatible' : 'compatible';
    const needsReview = server.kind === CUSTOM_MCP_KIND
      ? !parseCustomConfig(server.config_json).reviewed
      : false;
    return {
      ...base,
      installationState,
      compatibilityState,
      requiredTools: [...profile.requiredTools],
      missingTools,
      needsReview,
    };
  }

  async function closeRuntime(serverId: string): Promise<void> {
    const runtime = runtimes.get(serverId);
    if (!runtime) return;
    runtime.expectedClose = true;
    runtimes.delete(serverId);
    try { await runtime.client.close(); } catch { /* process may already be gone */ }
  }

  function scheduleRestart(serverId: string, reason: string): void {
    if (!active || restartTimers.has(serverId)) return;
    const server = row(serverId);
    if (!server || server.enabled !== 1) return;
    const failures = (consecutiveFailures.get(serverId) ?? 0) + 1;
    consecutiveFailures.set(serverId, failures);
    const delay = Math.min(60_000, 1000 * (2 ** Math.min(failures - 1, 6)));
    db.prepare(`
      UPDATE mcp_servers SET restart_count = restart_count + 1,
        state = 'failed', last_error = ?, pid = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(reason.slice(0, 2000), serverId);
    const timer = setTimeout(() => {
      restartTimers.delete(serverId);
      void startServer(serverId).catch((error) => {
        scheduleRestart(serverId, describeProfileError(definitionFor(serverId), error));
      });
    }, delay);
    restartTimers.set(serverId, timer);
  }

  async function startServer(serverId: string): Promise<void> {
    const existingLock = startLocks.get(serverId);
    if (existingLock) return existingLock;
    const operation = (async () => {
      const server = row(serverId);
      if (!server) throw new Error(`Unknown MCP server: ${serverId}`);
      const profile = definitionFor(serverId);
      if (!profile) throw new Error(`Unknown MCP profile: ${serverId}`);
      if (server.enabled !== 1) {
        updateState(serverId, 'stopped', { error: null, pid: null });
        return;
      }

      let transport: StdioClientTransport;
      if (profile.launch.type === 'sql-context-package') {
        const config = parseSqlConfig(server.config_json);
        const password = await secretStore.get(SQL_SERVER_ID, 'password');
        const missing = missingConfiguration(config, password !== null);
        if (missing.length) {
          updateState(serverId, 'needs_configuration', { error: `Missing ${missing.join(', ')}`, pid: null });
          return;
        }
        const entry = require.resolve('sql-context-presets-mcp/dist/index.js');
        transport = new StdioClientTransport({
          command: process.execPath,
          args: [entry],
          env: sqlEnvironment(config, password),
          cwd: path.dirname(entry),
          stderr: 'pipe',
        });
      } else {
        const executable = await resolveDefinitionExecutable(profile);
        if (!executable) {
          const reason = profile.launch.type === 'custom-command'
            ? `Command not found: ${profile.launch.command}`
            : `${profile.shortName} is not installed.`;
          db.prepare(`
            UPDATE mcp_servers SET enabled = 0, state = 'needs_configuration',
              last_error = ?, pid = NULL, updated_at = datetime('now')
            WHERE id = ?
          `).run(reason, serverId);
          return;
        }
        // User-declared environment variables extend the sanitized default
        // environment. The user supplied both the command and its variables
        // through the local, loopback-only UI; no shell ever runs.
        const childEnv = profile.launch.type === 'custom-command'
          ? { ...getDefaultEnvironment(), ...profile.launch.env }
          : getDefaultEnvironment();
        // AIM launch wrappers exec `aim …` from the child, so the child PATH
        // must resolve the toolchain even under a minimal-PATH launch.
        childEnv.PATH = pathValueWithFallbackDirectories(childEnv.PATH ?? process.env.PATH);
        transport = new StdioClientTransport({
          command: executable,
          args: [...profile.launch.args],
          env: childEnv,
          stderr: 'pipe',
        });
      }

      if (!active || row(serverId)?.enabled !== 1) {
        updateState(serverId, 'stopped', { error: null, pid: null });
        return;
      }

      await closeRuntime(serverId);
      if (!active || stopping || row(serverId)?.enabled !== 1) {
        updateState(serverId, 'stopped', { error: null, pid: null });
        return;
      }
      const pendingRestart = restartTimers.get(serverId);
      if (pendingRestart) { clearTimeout(pendingRestart); restartTimers.delete(serverId); }
      updateState(serverId, 'starting', { error: null, pid: null });

      const client = new Client({ name: 'botboy-managed-mcp', version: '1.0.0' }, { capabilities: {} });
      const runtime: RuntimeState = {
        client,
        transport,
        expectedClose: false,
        tools: [],
        stderrTail: [],
        callQueue: Promise.resolve(),
        pendingCalls: 0,
        inFlightCalls: 0,
      };
      runtimes.set(serverId, runtime);

      if (profile.policy.discardStderr) {
        // Drain and discard diagnostics. Login and process output can
        // contain authorization material and must not reach logs or storage.
        transport.stderr?.on('data', () => {});
      } else {
        transport.stderr?.on('data', (chunk: Buffer | string) => {
          const lines = String(chunk).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
          runtime.stderrTail.push(...lines);
          runtime.stderrTail = runtime.stderrTail.slice(-20);
          for (const line of lines) console.log(`[MCP:${serverId}] ${line.slice(0, 500)}`);
        });
      }
      client.onerror = (error) => {
        const message = describeProfileError(profile, error);
        console.warn(`[MCP:${serverId}] protocol error: ${message}`);
        updateState(serverId, 'degraded', { error: message });
      };
      client.onclose = () => {
        const expected = runtime.expectedClose;
        if (runtimes.get(serverId) === runtime) runtimes.delete(serverId);
        if (!expected) {
          const reason = profile.policy.redactErrors
            ? `${profile.shortName} process closed unexpectedly.`
            : runtime.stderrTail.at(-1) || 'MCP process closed unexpectedly';
          scheduleRestart(serverId, reason);
        }
      };

      try {
        await client.connect(transport, { timeout: 30_000 });
        const listed = await client.listTools(undefined, { timeout: 15_000 });
        runtime.tools = listed.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
          risk: classifyMcpTool(profile.kind, tool.name),
        }));
        if (!active || row(serverId)?.enabled !== 1 || runtimes.get(serverId) !== runtime) {
          runtime.expectedClose = true;
          if (runtimes.get(serverId) === runtime) runtimes.delete(serverId);
          try { await client.close(); } catch {}
          updateState(serverId, 'stopped', { error: null, pid: null });
          return;
        }
        const version = client.getServerVersion();
        updateState(serverId, 'running', {
          error: null,
          pid: transport.pid,
          version: version ? `${version.name}@${version.version}` : null,
          tools: runtime.tools,
        });
        consecutiveFailures.set(serverId, 0);
      } catch (error) {
        const interrupted = !active || row(serverId)?.enabled !== 1 || runtime.expectedClose;
        runtime.expectedClose = true;
        runtimes.delete(serverId);
        try { await client.close(); } catch {}
        if (interrupted) {
          updateState(serverId, 'stopped', { error: null, pid: null });
          return;
        }
        const message = describeProfileError(profile, error);
        updateState(serverId, 'failed', { error: message, pid: null });
        throw new Error(`Could not start ${profile.displayName}: ${message}`);
      }
    })();
    startLocks.set(serverId, operation);
    try { await operation; } finally { startLocks.delete(serverId); }
  }

  async function ensureReady(serverId: string): Promise<RuntimeState> {
    const server = row(serverId);
    if (!server) throw new Error(`Unknown MCP server: ${serverId}`);
    if (server.enabled !== 1) throw new Error(`${server.display_name} is disabled`);
    let runtime = runtimes.get(serverId);
    if (!runtime) {
      await startServer(serverId);
      runtime = runtimes.get(serverId);
    }
    if (!runtime) {
      const refreshed = row(serverId);
      throw new Error(refreshed?.last_error || `${server.display_name} is unavailable`);
    }
    return runtime;
  }

  function runtimeBusy(runtime: RuntimeState): boolean {
    return runtime.pendingCalls > 0 || runtime.inFlightCalls > 0;
  }

  async function queueRuntimeCall<T>(
    serverId: string,
    runtime: RuntimeState,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previousCall = runtime.callQueue;
    let releaseCall!: () => void;
    runtime.pendingCalls += 1;
    runtime.callQueue = new Promise<void>((resolve) => { releaseCall = resolve; });

    try {
      await previousCall;
      if (runtime.expectedClose || runtimes.get(serverId) !== runtime) {
        throw new Error(`MCP server '${serverId}' runtime changed before the queued call could start`);
      }
      runtime.inFlightCalls += 1;
      try {
        return await operation();
      } finally {
        runtime.inFlightCalls -= 1;
      }
    } finally {
      runtime.pendingCalls -= 1;
      releaseCall();
    }
  }

  async function invokeTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: InternalMcpCallOptions = {},
  ): Promise<McpCallResult> {
    const server = row(serverId);
    if (!server) throw new Error(`Unknown MCP server: ${serverId}`);
    const profile = definitionFor(serverId);
    if (!profile) throw new Error(`Unknown MCP profile: ${serverId}`);
    const risk = classifyMcpTool(profile.kind, toolName);
    const callId = randomUUID();
    const started = Date.now();
    const inputHash = sha256(JSON.stringify(args));

    try {
      const validatedArgs = validateMcpToolCall(profile.kind, toolName, args, {
        ownerApproved: options.ownerApproved === true,
        guidedFlow: options.guidedFlow === true,
      });
      const runtime = options.expectedRuntime ?? await ensureReady(serverId);
      if (runtime.expectedClose || runtimes.get(serverId) !== runtime) {
        throw new Error(`MCP server '${serverId}' runtime changed before the call could be queued`);
      }
      if (options.skipIfBusy && runtimeBusy(runtime)) throw new RuntimeBusyError(serverId);
      if (!runtime.tools.some(tool => tool.name === toolName)) {
        throw new Error(`MCP server '${serverId}' does not expose tool '${toolName}'`);
      }
      db.prepare(`
        INSERT INTO mcp_tool_calls
          (id, server_id, tool_name, risk, source, arguments_sha256, status)
        VALUES (?, ?, ?, ?, ?, ?, 'running')
      `).run(callId, serverId, toolName, risk, options.source ?? 'api', inputHash);

      const response = await queueRuntimeCall(serverId, runtime, () => runtime.client.callTool(
        { name: toolName, arguments: validatedArgs },
        undefined,
        { timeout: options.timeoutMs ?? 60_000 },
      ));
      const extracted = extractResult(response);
      const durationMs = Date.now() - started;
      db.prepare(`
        UPDATE mcp_tool_calls SET status = ?, result_chars = ?, duration_ms = ?,
          error = ?, completed_at = datetime('now') WHERE id = ?
      `).run(
        extracted.isError ? 'failed' : 'completed',
        extracted.text.length,
        durationMs,
        extracted.isError ? extracted.text.slice(0, 2000) : null,
        callId,
      );
      return {
        serverId,
        toolName,
        text: extracted.text,
        isError: extracted.isError,
        durationMs,
        structuredContent: extracted.structuredContent,
      };
    } catch (error) {
      if (error instanceof RuntimeBusyError) throw error;
      const durationMs = Date.now() - started;
      const message = truncateError(error);
      const status = /blocked|not approved|read-only|not allowed|explicit owner request/i.test(message) ? 'blocked' : 'failed';
      db.prepare(`
        INSERT INTO mcp_tool_calls
          (id, server_id, tool_name, risk, source, arguments_sha256, status, duration_ms, error, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, duration_ms = excluded.duration_ms,
          error = excluded.error, completed_at = excluded.completed_at
      `).run(callId, serverId, toolName, risk, options.source ?? 'api', inputHash, status, durationMs, message);
      throw new Error(message);
    }
  }

  async function checkConnection(
    serverId: string = SQL_SERVER_ID,
    options: Pick<InternalMcpCallOptions, 'expectedRuntime' | 'skipIfBusy'> = {},
  ): Promise<McpCallResult> {
    const result = await invokeTool(serverId, 'connection_status', {}, {
      source: 'health',
      timeoutMs: 30_000,
      ...options,
    });
    if (result.isError || !/^Connected(?:\n|$)/.test(result.text)) {
      updateState(serverId, 'degraded', { error: result.text.slice(0, 2000) || 'Database connection check failed' });
    } else {
      const current = row(serverId);
      updateState(serverId, 'running', {
        error: null,
        pid: runtimes.get(serverId)?.transport.pid ?? current?.pid ?? null,
        healthy: true,
      });
    }
    return result;
  }

  async function checkConnectionIfIdle(serverId: string, runtime: RuntimeState): Promise<boolean> {
    try {
      await checkConnection(serverId, { expectedRuntime: runtime, skipIfBusy: true });
      return true;
    } catch (error) {
      if (error instanceof RuntimeBusyError) return false;
      throw error;
    }
  }

  async function healthTick(): Promise<void> {
    if (!active || stopping) return;
    if (healthOperation) return healthOperation;
    const operation = (async () => {
      for (const server of db.prepare('SELECT * FROM mcp_servers WHERE enabled = 1').all() as McpServerRow[]) {
        if (!active) break;
        let checkedRuntime: RuntimeState | undefined;
        try {
          const runtime = await ensureReady(server.id);
          checkedRuntime = runtime;
          if (runtimeBusy(runtime)) continue;

          await queueRuntimeCall(server.id, runtime, () => runtime.client.ping({ timeout: 10_000 }));
          if (runtimes.get(server.id) !== runtime || runtime.expectedClose || runtimeBusy(runtime)) continue;

          if (server.id === SQL_SERVER_ID) {
            const checked = await checkConnectionIfIdle(server.id, runtime);
            if (!checked) continue;
          } else {
            updateState(server.id, 'running', { error: null, pid: runtime.transport.pid, healthy: true });
          }
        } catch (error) {
          const currentRuntime = runtimes.get(server.id);
          if (currentRuntime !== checkedRuntime) continue;
          if (currentRuntime && runtimeBusy(currentRuntime)) {
            const message = describeProfileError(definitionFor(server.id), error);
            console.warn(`[MCP:${server.id}] health probe failed while calls are pending; deferring restart: ${message}`);
            continue;
          }
          await closeRuntime(server.id);
          scheduleRestart(server.id, describeProfileError(definitionFor(server.id), error));
        }
      }
    })();
    healthOperation = operation;
    try {
      await operation;
    } finally {
      if (healthOperation === operation) healthOperation = null;
    }
  }

  function requireProfileRow(profileId: string): McpServerRow {
    const profile = definitionFor(profileId);
    if (!profile) throw new Error(`Unknown MCP profile: ${profileId}`);
    const server = row(profileId);
    if (!server) throw new Error(`Managed MCP profile is missing: ${profileId}`);
    return server;
  }

  async function checkProfileInternal(profileId: string): Promise<McpProfileSnapshot> {
    const server = requireProfileRow(profileId);
    const profile = definitionFor(profileId);
    if (profile && (profile.launch.type === 'local-executable' || profile.launch.type === 'custom-command')) {
      const executable = await resolveDefinitionExecutable(profile);
      const absenceReason = profile.launch.type === 'custom-command'
        ? `Command not found: ${profile.launch.command}`
        : `${profile.shortName} is not installed.`;
      if (!executable && !runtimes.has(profileId)) {
        updateState(profileId, 'needs_configuration', { error: absenceReason, pid: null });
      } else if (executable && server.state === 'needs_configuration' && server.enabled !== 1) {
        updateState(profileId, 'stopped', { error: null, pid: null });
      }
    }
    return profileSnapshot(requireProfileRow(profileId));
  }

  async function runSetupActionInternal(
    profileId: string,
    action: McpSetupAction,
  ): Promise<McpSetupActionResult> {
    const profile = definitionFor(profileId);
    const server = requireProfileRow(profileId);
    const definition = profile ? getSetupActionDefinition(profile, action) : null;
    if (!profile || !definition || profile.launch.type !== 'local-executable') {
      throw new Error(`Setup action '${action}' is not available for ${profileId}`);
    }
    if (server.enabled === 1 || startLocks.has(profileId) || runtimes.has(profileId)
      || ['starting', 'running', 'degraded'].includes(server.state)) {
      throw new Error(`Stop the ${profile.shortName} server before this action.`);
    }
    if (setupLocks.has(profileId)) throw new Error(`A ${profile.shortName} setup action is already running.`);
    if (terminalSessionRunning(profileId)) throw new Error('Finish the setup terminal session before this action.');

    const controller = new AbortController();
    setupAbortControllers.set(profileId, controller);
    const operation = (async () => {
      const executable = await resolveDefinitionExecutable(profile);
      if (stopping || controller.signal.aborted) throw new Error('The managed MCP runtime is shutting down.');
      if (!executable) {
        updateState(profileId, 'needs_configuration', { error: `${profile.shortName} is not installed.`, pid: null });
        throw new Error(`${profile.shortName} is not installed.`);
      }
      return executeProfileSetupAction(executable, definition, controller.signal);
    })();
    setupLocks.set(profileId, operation);

    try {
      const result = await operation;
      if (!stopping) {
        updateState(profileId, 'stopped', {
          error: result.outcome === 'completed' ? null : result.message,
          pid: null,
        });
      }
      return result;
    } finally {
      setupLocks.delete(profileId);
      if (setupAbortControllers.get(profileId) === controller) setupAbortControllers.delete(profileId);
    }
  }

  async function startProfileInternal(profileId: string): Promise<McpProfileSnapshot> {
    requireProfileRow(profileId);
    const profile = definitionFor(profileId);
    if (!profile) throw new Error(`Unknown MCP profile: ${profileId}`);
    if (setupLocks.has(profileId)) throw new Error(`A ${profile.shortName} setup action is already running.`);
    if (terminalSessionRunning(profileId)) throw new Error('Finish the setup terminal session before this action.');
    if (profile.kind === CUSTOM_MCP_KIND) {
      const customRow = requireCustomRow(profileId);
      if (!parseCustomConfig(customRow.config_json).reviewed) {
        throw new Error('This server configuration needs your review. Open its connection page and press Start.');
      }
    }
    if (profile.launch.type === 'local-executable' || profile.launch.type === 'custom-command') {
      const executable = await resolveDefinitionExecutable(profile);
      if (stopping || !active) throw new Error('The managed MCP runtime is shutting down.');
      if (!executable) {
        const reason = profile.launch.type === 'custom-command'
          ? `Command not found: ${profile.launch.command}`
          : `${profile.shortName} is not installed.`;
        db.prepare(`
          UPDATE mcp_servers SET enabled = 0, state = 'needs_configuration',
            last_error = ?, pid = NULL, updated_at = datetime('now')
          WHERE id = ?
        `).run(reason, profileId);
        throw new Error(reason);
      }
    }
    if (stopping || !active) throw new Error('The managed MCP runtime is shutting down.');
    db.prepare(`
      UPDATE mcp_servers SET enabled = 1, state = 'stopped',
        last_error = NULL, updated_at = datetime('now') WHERE id = ?
    `).run(profileId);
    await startServer(profileId);
    if (!runtimes.has(profileId)) throw new Error(`${profile.displayName} is unavailable.`);
    return profileSnapshot(requireProfileRow(profileId));
  }

  async function stopProfileInternal(profileId: string): Promise<McpProfileSnapshot> {
    requireProfileRow(profileId);
    const pendingRestart = restartTimers.get(profileId);
    if (pendingRestart) clearTimeout(pendingRestart);
    restartTimers.delete(profileId);
    consecutiveFailures.delete(profileId);
    db.prepare(`
      UPDATE mcp_servers SET enabled = 0, state = 'stopped',
        last_error = NULL, pid = NULL, updated_at = datetime('now') WHERE id = ?
    `).run(profileId);
    await closeRuntime(profileId);
    const pendingStart = startLocks.get(profileId);
    if (pendingStart) await pendingStart.catch(() => {});
    await closeRuntime(profileId);
    updateState(profileId, 'stopped', { error: null, pid: null });
    return profileSnapshot(requireProfileRow(profileId));
  }

  async function testProfileInternal(profileId: string): Promise<McpProfileTestResult> {
    const profile = definitionFor(profileId);
    if (!profile) throw new Error(`Unknown MCP profile: ${profileId}`);
    const runtime = await ensureReady(profileId);
    const listed = await queueRuntimeCall(profileId, runtime, async () => {
      await runtime.client.ping({ timeout: 10_000 });
      return runtime.client.listTools(undefined, { timeout: 15_000 });
    });
    runtime.tools = listed.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      risk: classifyMcpTool(profile.kind, tool.name),
    }));
    updateState(profileId, 'running', {
      error: null,
      pid: runtime.transport.pid,
      tools: runtime.tools,
      healthy: true,
    });
    const names = new Set(runtime.tools.map(tool => tool.name));
    const missingTools = profile.requiredTools.filter(name => !names.has(name));
    const compatibilityState = missingTools.length ? 'incompatible' : 'compatible';
    return {
      profileId,
      compatibilityState,
      discoveredToolCount: runtime.tools.length,
      requiredTools: [...profile.requiredTools],
      missingTools,
      message: missingTools.length
        ? `The ${profile.shortName} server is running, but required tools are absent.`
        : profile.requiredTools.length
          ? `The ${profile.shortName} server is running and exposes the required tools.`
          : `The ${profile.shortName} server is running and answered the protocol test.`,
    };
  }

  /** Generate a stable, collision-free id for one user-added server. */
  function customServerId(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server';
    let candidate = `${CUSTOM_MCP_ID_PREFIX}${slug}`;
    let suffix = 2;
    while (row(candidate) || isBuiltInMcpProfileId(candidate)) {
      candidate = `${CUSTOM_MCP_ID_PREFIX}${slug}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  function requireCustomRow(serverId: string): McpServerRow {
    const server = row(serverId);
    if (!server || server.kind !== CUSTOM_MCP_KIND) {
      throw new Error(`Unknown custom MCP server: ${serverId}`);
    }
    return server;
  }

  function assertCustomServerIdle(server: McpServerRow): void {
    if (server.enabled === 1 || startLocks.has(server.id) || runtimes.has(server.id)
      || ['starting', 'running', 'degraded'].includes(server.state)) {
      throw new Error(`Stop the ${server.display_name} server before this action.`);
    }
  }

  async function createCustomServerInternal(
    input: unknown,
    origin: 'user' | 'assistant',
  ): Promise<McpProfileSnapshot> {
    const validated = validateCustomServerInput(input);
    const serverId = customServerId(validated.name);
    const definition = buildCustomServerDefinition({
      id: serverId,
      displayName: validated.name,
      command: validated.command,
      args: validated.args,
      env: validated.env,
    });
    const executable = await resolveDefinitionExecutable(definition);
    db.prepare(`
      INSERT INTO mcp_servers (id, kind, display_name, enabled, config_json, state, last_error)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `).run(
      serverId,
      CUSTOM_MCP_KIND,
      validated.name,
      // Assistant-written definitions stay unreviewed until the user starts
      // the server from the dashboard. Review gates the first launch.
      JSON.stringify({ ...validated, origin, reviewed: origin === 'user' }),
      executable ? 'stopped' : 'needs_configuration',
      executable ? null : `Command not found: ${validated.command}`,
    );
    return profileSnapshot(requireCustomRow(serverId));
  }

  async function updateCustomServerInternal(
    serverId: string,
    input: unknown,
    origin: 'user' | 'assistant',
  ): Promise<McpProfileSnapshot> {
    const server = requireCustomRow(serverId);
    assertCustomServerIdle(server);
    const validated = validateCustomServerInput(input);
    const definition = buildCustomServerDefinition({
      id: serverId,
      displayName: validated.name,
      command: validated.command,
      args: validated.args,
      env: validated.env,
    });
    const executable = await resolveDefinitionExecutable(definition);
    // Stale descriptors from the previous command would be misleading, so
    // discovery state resets with the configuration. An assistant edit also
    // resets the review state; a user edit is its own approval.
    db.prepare(`
      UPDATE mcp_servers SET display_name = ?, config_json = ?, state = ?,
        last_error = ?, tools_json = '[]', server_version = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      validated.name,
      JSON.stringify({ ...validated, origin, reviewed: origin === 'user' }),
      executable ? 'stopped' : 'needs_configuration',
      executable ? null : `Command not found: ${validated.command}`,
      serverId,
    );
    return profileSnapshot(requireCustomRow(serverId));
  }

  async function approveCustomServerInternal(serverId: string): Promise<McpProfileSnapshot> {
    const server = requireCustomRow(serverId);
    const config = parseCustomConfig(server.config_json);
    if (!config.reviewed) {
      db.prepare(`
        UPDATE mcp_servers SET config_json = ?, updated_at = datetime('now') WHERE id = ?
      `).run(JSON.stringify({ ...config, reviewed: true }), serverId);
    }
    return profileSnapshot(requireCustomRow(serverId));
  }

  async function deleteCustomServerInternal(serverId: string): Promise<void> {
    const server = requireCustomRow(serverId);
    assertCustomServerIdle(server);
    const pendingRestart = restartTimers.get(serverId);
    if (pendingRestart) clearTimeout(pendingRestart);
    restartTimers.delete(serverId);
    consecutiveFailures.delete(serverId);
    db.transaction(() => {
      db.prepare('DELETE FROM mcp_tool_calls WHERE server_id = ?').run(serverId);
      db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(serverId);
    })();
  }

  /** Child environment for embedded setup-terminal commands. */
  function terminalEnvironment(): Record<string, string> {
    const base = getDefaultEnvironment();
    return {
      ...base,
      PATH: pathValueWithFallbackDirectories(base.PATH ?? process.env.PATH),
      TERM: 'xterm-256color',
    };
  }

  function terminalSessionRunning(profileId: string): boolean {
    return terminalEngine.sessionFor(profileId)?.status === 'running';
  }

  async function startTerminalSessionInternal(profileId: string, commandId: string) {
    const profile = definitionFor(profileId);
    const server = requireProfileRow(profileId);
    const command = profile ? getTerminalCommandDefinition(profile, commandId) : null;
    if (!profile || !command) throw new Error(`Terminal command '${commandId}' is not available for ${profileId}`);
    if (stopping || !active) throw new Error('The managed MCP runtime is shutting down.');
    if (setupLocks.has(profileId)) throw new Error(`A ${profile.shortName} setup action is already running.`);
    if (command.requiresStopped && (server.enabled === 1 || startLocks.has(profileId) || runtimes.has(profileId)
      || ['starting', 'running', 'degraded'].includes(server.state))) {
      throw new Error(`Stop the ${profile.shortName} server before this action.`);
    }
    const executable = await resolveCommandExecutable(command.argv[0]);
    if (stopping || !active) throw new Error('The managed MCP runtime is shutting down.');
    if (!executable) {
      throw new Error(`Command not found: ${command.argv[0]}. Install it, then try again.`);
    }
    return terminalEngine.start({
      profileId,
      commandId: command.id,
      title: command.title,
      executable,
      args: command.argv.slice(1),
      env: terminalEnvironment(),
      timeoutMs: command.timeoutMs,
    });
  }

  function requireOwnedTerminalSession(profileId: string, sessionId: string) {
    const session = terminalEngine.get(sessionId);
    if (!session || session.profileId !== profileId) throw new Error('Unknown terminal session');
    return session;
  }

  async function stopManager(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      active = false;
      if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
      for (const timer of restartTimers.values()) clearTimeout(timer);
      restartTimers.clear();
      for (const controller of setupAbortControllers.values()) controller.abort();
      terminalEngine.shutdown();

      // Remove published runtimes before draining queued work. Closing the
      // clients interrupts profile tests and health probes that could otherwise
      // wait behind a call while shutdown waits for their profile lock.
      const runtimeClosures = [...runtimes.keys()].map(serverId => closeRuntime(serverId));
      await Promise.allSettled([
        ...runtimeClosures,
        ...setupLocks.values(),
        ...startLocks.values(),
        ...profileLocks.values(),
        ...(healthOperation ? [healthOperation] : []),
      ]);
      await Promise.allSettled([...startLocks.values()]);
      await Promise.all([...runtimes.keys()].map(serverId => closeRuntime(serverId)));
      db.prepare(`
        UPDATE mcp_servers SET state = CASE WHEN enabled = 1 THEN 'stopped' ELSE state END,
          pid = NULL, updated_at = datetime('now')
        WHERE state IN ('starting','running','degraded') OR pid IS NOT NULL
      `).run();
    })();
    return stopPromise;
  }

  return {
    async start(): Promise<void> {
      if (active && !stopping) return;
      if (stopPromise) {
        await stopPromise;
        stopPromise = null;
      }
      stopping = false;
      active = true;
      const enabled = db.prepare('SELECT id FROM mcp_servers WHERE enabled = 1').all() as { id: string }[];
      for (const server of enabled) {
        if (!active || stopping) break;
        try {
          await startServer(server.id);
          const runtime = runtimes.get(server.id);
          if (runtime && server.id === SQL_SERVER_ID) void checkConnectionIfIdle(server.id, runtime).catch((error) => {
            updateState(server.id, 'degraded', { error: truncateError(error) });
          });
        } catch (error) {
          scheduleRestart(server.id, describeProfileError(definitionFor(server.id), error));
        }
      }
      if (!active || stopping) return;
      healthTimer = setInterval(() => { void healthTick(); }, options.healthIntervalMs ?? HEALTH_INTERVAL_MS);
      healthTimer.unref?.();
    },

    stop: stopManager,

    async listServers(): Promise<McpServerSnapshot[]> {
      const servers = db.prepare('SELECT * FROM mcp_servers ORDER BY display_name').all() as McpServerRow[];
      return Promise.all(servers.map(server => snapshot(server)));
    },

    async getServer(serverId: string): Promise<McpServerSnapshot | null> {
      const server = row(serverId);
      return server ? snapshot(server) : null;
    },

    async listProfiles(): Promise<McpProfileSnapshot[]> {
      // Registry profiles first, then user-added servers alphabetically.
      const servers = db.prepare(`
        SELECT * FROM mcp_servers
        ORDER BY CASE WHEN kind = '${CUSTOM_MCP_KIND}' THEN 1 ELSE 0 END, display_name
      `).all() as McpServerRow[];
      const known = servers.filter(server => definitionFor(server.id) !== null);
      return Promise.all(known.map(server => profileSnapshot(server)));
    },

    async getProfile(profileId: string): Promise<McpProfileSnapshot | null> {
      const profile = definitionFor(profileId);
      const server = row(profileId);
      return profile && server ? profileSnapshot(server) : null;
    },

    checkProfile: (profileId) => withProfileLock(profileId, () => checkProfileInternal(profileId)),
    runSetupAction: (profileId, action) => withProfileLock(
      profileId,
      () => runSetupActionInternal(profileId, action),
    ),
    startProfile: (profileId) => withProfileLock(profileId, () => startProfileInternal(profileId)),
    stopProfile: (profileId) => withProfileLock(profileId, () => stopProfileInternal(profileId)),
    testProfile: (profileId) => withProfileLock(profileId, () => testProfileInternal(profileId)),

    startTerminalSession: (profileId, commandId) => withProfileLock(
      profileId,
      () => startTerminalSessionInternal(profileId, commandId),
    ),
    getTerminalSession: (profileId) => terminalEngine.sessionFor(profileId),
    writeTerminalInput: (profileId, sessionId, data) => {
      requireOwnedTerminalSession(profileId, sessionId);
      terminalEngine.write(sessionId, data);
    },
    stopTerminalSession: (profileId, sessionId) => {
      requireOwnedTerminalSession(profileId, sessionId);
      terminalEngine.stop(sessionId);
    },
    subscribeTerminal: (profileId, sessionId, onChunk, onEnd) => {
      requireOwnedTerminalSession(profileId, sessionId);
      return terminalEngine.subscribe(sessionId, onChunk, onEnd);
    },

    createCustomServer: (input, options) => createCustomServerInternal(input, options?.origin ?? 'user'),
    updateCustomServer: (serverId, input, options) => withProfileLock(
      serverId,
      () => updateCustomServerInternal(serverId, input, options?.origin ?? 'user'),
    ),
    deleteCustomServer: (serverId) => withProfileLock(serverId, () => deleteCustomServerInternal(serverId)),
    approveCustomServer: (serverId) => withProfileLock(serverId, () => approveCustomServerInternal(serverId)),

    async getCustomServerConfig(serverId: string) {
      const server = row(serverId);
      if (!server || server.kind !== CUSTOM_MCP_KIND) return null;
      const config = parseCustomConfig(server.config_json);
      return {
        id: server.id,
        name: server.display_name,
        command: config.command,
        args: config.args,
        env: config.env,
        origin: config.origin,
        reviewed: config.reviewed,
      };
    },

    getSqlContextConfig: configView,

    async updateSqlContextConfig(input: SqlContextMcpConfigInput): Promise<SqlContextMcpConfigView> {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuration must be an object');
      const server = row(SQL_SERVER_ID);
      if (!server) throw new Error('Native SQL MCP definition is missing');
      const next = normalizeSqlConfig(parseSqlConfig(server.config_json), input);

      if (input.password !== undefined) {
        if (typeof input.password !== 'string') throw new Error('password must be a string');
        if (input.password.length > 4096) throw new Error('password is too long');
        if (!input.password) throw new Error('password cannot be empty; use clearPassword to remove it');
        await secretStore.set(SQL_SERVER_ID, 'password', input.password);
      }
      if (input.clearPassword === true) await secretStore.delete(SQL_SERVER_ID, 'password');
      const hasPassword = await passwordConfigured();
      const missing = missingConfiguration(next, hasPassword);
      if (next.enabled && missing.length) throw new Error(`Cannot enable SQL MCP: missing ${missing.join(', ')}`);

      db.prepare(`
        UPDATE mcp_servers SET enabled = ?, config_json = ?,
          state = ?, last_error = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(next.enabled ? 1 : 0, serializeSqlConfig(next), next.enabled ? 'stopped' : 'needs_configuration', SQL_SERVER_ID);

      if (next.enabled) {
        try { await startServer(SQL_SERVER_ID); }
        catch (error) { console.warn(`[MCP:${SQL_SERVER_ID}] saved config but start failed: ${truncateError(error)}`); }
      } else {
        await closeRuntime(SQL_SERVER_ID);
        updateState(SQL_SERVER_ID, missing.length ? 'needs_configuration' : 'stopped', { error: null, pid: null });
      }
      return configView();
    },

    async restart(serverId: string): Promise<McpServerSnapshot> {
      const profile = definitionFor(serverId);
      if (profile && !profile.policy.allowGenericRestart) {
        throw new Error(`Use the fixed ${profile.shortName} start and stop actions.`);
      }
      const server = row(serverId);
      if (!server) throw new Error(`Unknown MCP server: ${serverId}`);
      if (server.enabled !== 1) throw new Error(`${server.display_name} is disabled`);
      await closeRuntime(serverId);
      await startServer(serverId);
      const refreshed = row(serverId);
      if (!refreshed) throw new Error(`Unknown MCP server: ${serverId}`);
      return snapshot(refreshed);
    },

    testConnection: checkConnection,
    callTool: invokeTool,
  };
}
