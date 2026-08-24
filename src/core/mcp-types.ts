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
export const BUILT_IN_MCP_PROFILE_IDS = ['sql-context', 'grasp-m365', 'slack'] as const;
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
   * presses Start on its connection page.
   */
  needsReview?: boolean;
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

/**
 * User-supplied definition for one custom MCP server. The user owns the
 * command; BotBoy validates shape, resolves the executable without a shell,
 * and keeps the agent blocked from the server's tools.
 */
export interface CustomMcpServerInput {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface CustomMcpServerConfigView {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  origin: CustomMcpServerOrigin;
  reviewed: boolean;
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
  timeoutMs?: number;
  /**
   * Confirms an explicit owner request for a write-classified tool call.
   * Read-classified calls do not require it.
   */
  ownerApproved?: boolean;
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
  updateCustomServer(serverId: string, input: CustomMcpServerInput, options?: { origin?: CustomMcpServerOrigin }): Promise<McpProfileSnapshot>;
  deleteCustomServer(serverId: string): Promise<void>;
  getCustomServerConfig(serverId: string): Promise<CustomMcpServerConfigView | null>;
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
