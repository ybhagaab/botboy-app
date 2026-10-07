export type McpServerState =
  | 'needs_configuration'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'failed';

/**
 * Every managed MCP is declared once in the code-owned registry
 * (mcp-profiles.ts). Adding a new MCP means adding its id here and one
 * registry entry there; storage seeding, manager lifecycle, API routes,
 * agent policy, and the Connections UI all read the registry.
 */
export const BUILT_IN_MCP_PROFILE_IDS = ['sql-context', 'grasp-m365', 'slack', 'sharepoint', 'a2-analytics'] as const;
export type BuiltInMcpProfileId = (typeof BUILT_IN_MCP_PROFILE_IDS)[number];
export type McpInstallationState = 'unchecked' | 'not_installed' | 'installed';
export type McpCompatibilityState = 'unchecked' | 'compatible' | 'incompatible';
/** Registry-declared setup action id, validated against the profile at runtime. */
export type McpSetupAction = string;
export type McpSetupActionOutcome = 'completed' | 'failed' | 'timed_out';

export type McpToolRisk = 'read' | 'write' | 'publish' | 'unknown';

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  risk: McpToolRisk;
}

export interface McpServerSnapshot {
  id: string;
  kind: string;
  displayName: string;
  enabled: boolean;
  configured: boolean;
  state: McpServerState;
  serverVersion?: string;
  packageVersion: string;
  tools: McpToolDescriptor[];
  pid?: number;
  restartCount: number;
  lastError?: string;
  lastStartedAt?: string;
  lastHealthyAt?: string;
  updatedAt: string;
}

export interface McpProfileSnapshot extends McpServerSnapshot {
  installationState: McpInstallationState;
  compatibilityState: McpCompatibilityState;
  requiredTools: string[];
  missingTools: string[];
  /**
   * True when the assistant wrote this configuration and the user has not
   * confirmed it yet. An unreviewed server cannot start until the user
   * presses Start on its card in chat or on its connection page.
   */
  needsReview?: boolean;
  /** User-added servers only. */
  custom?: CustomMcpProfileFacts;
}

/** Who last wrote a custom server definition. */
export type CustomMcpServerOrigin = 'user' | 'assistant';

export interface McpSetupActionResult {
  action: McpSetupAction;
  outcome: McpSetupActionOutcome;
  message: string;
  completedAt: string;
}

export interface McpProfileTestResult {
  profileId: string;
  compatibilityState: McpCompatibilityState;
  discoveredToolCount: number;
  requiredTools: string[];
  missingTools: string[];
  message: string;
}

export type CustomMcpTransportName = 'stdio' | 'http' | 'sse' | 'auto';

/**
 * Definition of one user-added MCP server, as the owner's form, the REST API,
 * or BotBoy's chat tools send it. A local server gives `command` (+ `args`,
 * `env`); a remote one gives `url` (+ `type`/`transport`, `headers`). The
 * shapes mirror common MCP client config, so a pasted snippet maps field for
 * field. Validation lives in mcp-custom-config.ts › normalizeCustomServerInput.
 */
export interface CustomMcpServerInput {
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  transport?: string;
  headers?: Record<string, string>;
  /** Names whose values are secret (also inferred from names like *_TOKEN). */
  secret?: string[];
  /** Names that must have a value before Start. Defaults to the secret names. */
  required?: string[];
  about?: { publisher?: string; description?: string; source?: string; website?: string };
}

/** One env variable or header of a custom server. Secret values are never included. */
export interface CustomMcpValueView {
  name: string;
  secret: boolean;
  required: boolean;
  /** A value is saved (in Keychain). */
  saved: boolean;
  /** The saved value, for non-secret entries only. */
  value?: string;
  /** Header format such as `Bearer {value}`; the owner types only the key. */
  template?: string;
  description?: string;
}

/** Everything about a custom server except secret values. */
export interface CustomMcpServerConfigView {
  id: string;
  name: string;
  transport: CustomMcpTransportName;
  command: string;
  args: string[];
  url: string;
  env: CustomMcpValueView[];
  headers: CustomMcpValueView[];
  detectedTransport?: 'http' | 'sse';
  about: { publisher?: string; description?: string; source?: string; website?: string };
  origin: CustomMcpServerOrigin;
  reviewed: boolean;
  /** Required values not saved yet (`API_KEY`, `header Authorization`). */
  missingValues: string[];
}

/** Owner-entered values for existing entries. An empty string clears the value. */
export interface CustomMcpServerValuesInput {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

/** The custom-server facts a connection page or card shows. */
export interface CustomMcpProfileFacts {
  transport: CustomMcpTransportName;
  /** Host the calls go to, for remote servers. */
  endpointHost?: string;
  detectedTransport?: 'http' | 'sse';
  about: { publisher?: string; description?: string; source?: string; website?: string };
  missingValues: string[];
}

export type McpTerminalSessionStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'stopped';

/** Safe view of one embedded setup-terminal session. Output is not included. */
export interface McpTerminalSessionView {
  id: string;
  profileId: string;
  commandId: string;
  title: string;
  status: McpTerminalSessionStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}

export interface McpCallResult {
  serverId: string;
  toolName: string;
  text: string;
  isError: boolean;
  durationMs: number;
  structuredContent?: Record<string, unknown>;
}

export type SqlAuthMethod = 'direct' | 'iam' | 'secrets_manager';
export type SqlSslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';
export type SqlContextSource = 'none' | 'directory' | 'file' | 's3' | 'url';

/** Persisted configuration. Secrets are deliberately absent. */
export interface SqlContextMcpConfig {
  enabled: boolean;
  authMethod: SqlAuthMethod;
  host: string;
  port: number;
  database: string;
  username: string;
  clusterId: string;
  secretId: string;
  awsRegion: string;
  awsProfile: string;
  sslMode: SqlSslMode;
  sslCaPath: string;
  sslCertPath: string;
  sslKeyPath: string;
  contextSource: SqlContextSource;
  contextValue: string;
}

export interface SqlContextMcpConfigInput extends Partial<SqlContextMcpConfig> {
  password?: string;
  clearPassword?: boolean;
}

export interface SqlContextMcpConfigView extends SqlContextMcpConfig {
  configured: boolean;
  passwordConfigured: boolean;
}

export interface McpCallOptions {
  source?: 'api' | 'agent' | 'dashboard' | 'health';
  /**
   * Idle window, not a cap: every progress notification from the server
   * restarts it, so a call that keeps reporting (sql-context sends progress
   * every 30 s) runs as long as it needs. A server that never reports progress
   * gets exactly this long.
   */
  timeoutMs?: number;
  /** Cancels the call, including a queued one; the server is told to stop the work. */
  signal?: AbortSignal;
  /**
   * Fail fast with a busy error instead of queueing behind an in-flight call
   * on the same serialized server. Used by dashboard picker routes so a
   * long-running download (e.g. a SharePoint large-file transfer) surfaces
   * as "sync busy, try again" rather than a hung request.
   */
  skipIfBusy?: boolean;
  /**
   * Confirms an explicit owner request for a write-classified tool call.
   * Read-classified calls do not require it.
   */
  ownerApproved?: boolean;
  /**
   * INTERNAL ONLY: set exclusively by BotBoy's purpose-built guided write
   * flows (tool-executor SharePoint tools), which re-verify live server
   * state before writing. Never populated from model-supplied arguments —
   * the model-facing mcp_call_tool constructs its options without it.
   * Waives the SharePoint blocked-set for the three guided write tools
   * only, and only together with ownerApproved.
   */
  guidedFlow?: boolean;
}

export interface McpManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  listServers(): Promise<McpServerSnapshot[]>;
  getServer(serverId: string): Promise<McpServerSnapshot | null>;
  listProfiles(): Promise<McpProfileSnapshot[]>;
  getProfile(profileId: string): Promise<McpProfileSnapshot | null>;
  checkProfile(profileId: string): Promise<McpProfileSnapshot>;
  runSetupAction(profileId: string, action: McpSetupAction): Promise<McpSetupActionResult>;
  startProfile(profileId: string): Promise<McpProfileSnapshot>;
  stopProfile(profileId: string): Promise<McpProfileSnapshot>;
  testProfile(profileId: string): Promise<McpProfileTestResult>;
  createCustomServer(input: CustomMcpServerInput, options?: { origin?: CustomMcpServerOrigin }): Promise<McpProfileSnapshot>;
  /**
   * Omitted fields keep their values; env/headers maps replace the set of
   * names, keeping saved secret values for names that stay. An assistant
   * edit needs the owner's review again only when the identity changes
   * (command or arguments; remote origin).
   */
  updateCustomServer(serverId: string, input: CustomMcpServerInput, options?: { origin?: CustomMcpServerOrigin }): Promise<McpProfileSnapshot>;
  deleteCustomServer(serverId: string): Promise<void>;
  getCustomServerConfig(serverId: string): Promise<CustomMcpServerConfigView | null>;
  /** Owner-entered values (owner UI only). A running server restarts with them. */
  setCustomServerValues(serverId: string, values: CustomMcpServerValuesInput): Promise<CustomMcpServerConfigView>;
  /** User confirmation for an assistant-written definition. User surfaces only. */
  approveCustomServer(serverId: string): Promise<McpProfileSnapshot>;
  startTerminalSession(profileId: string, commandId: string): Promise<McpTerminalSessionView>;
  getTerminalSession(profileId: string): McpTerminalSessionView | null;
  writeTerminalInput(profileId: string, sessionId: string, data: string): void;
  stopTerminalSession(profileId: string, sessionId: string): void;
  subscribeTerminal(
    profileId: string,
    sessionId: string,
    onChunk: (chunk: string) => void,
    onEnd: (session: McpTerminalSessionView) => void,
  ): () => void;
  getSqlContextConfig(): Promise<SqlContextMcpConfigView>;
  updateSqlContextConfig(input: SqlContextMcpConfigInput): Promise<SqlContextMcpConfigView>;
  restart(serverId: string): Promise<McpServerSnapshot>;
  testConnection(serverId?: string): Promise<McpCallResult>;
  callTool(serverId: string, toolName: string, args: Record<string, unknown>, options?: McpCallOptions): Promise<McpCallResult>;
}
