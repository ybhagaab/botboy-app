/**
 * Code-owned registry for built-in MCP profiles, plus the shared definition
 * contract for every managed server.
 *
 * Built-in profiles: one registry entry declares how a profile launches,
 * which fixed setup actions exist, which safety policies apply, how storage
 * seeds it, and what the Connections UI shows. Their commands never come
 * from users, the database, or the browser.
 *
 * User-added servers: the local user supplies the command through the
 * loopback-only management API, and buildCustomServerDefinition() converts
 * the stored row into the same definition contract with a closed policy —
 * no agent tool access, no model-visible descriptors, and no shell.
 */

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  BuiltInMcpProfileId,
  McpSetupActionOutcome,
  McpSetupActionResult,
  SqlContextMcpConfig,
} from './mcp-types.js';

export const SQL_CONTEXT_PROFILE_ID = 'sql-context' as const;
export const GRASP_PROFILE_ID = 'grasp-m365' as const;
export const SLACK_MCP_PROFILE_ID = 'slack' as const;
export const SHAREPOINT_MCP_PROFILE_ID = 'sharepoint' as const;

/**
 * The SharePoint read tools BotBoy's own code paths use: the background
 * document sync (sharepoint-docs-brain R1.2) plus URL resolution and search
 * for chat. Compatibility requires these; the two phase-2 comment-read tools
 * are deliberately NOT required so a slightly older server still passes —
 * they are simply read-classified in mcp-policy when present.
 */
export const SHAREPOINT_MCP_REQUIRED_TOOLS = Object.freeze([
  'sharepoint_list_sites',
  'sharepoint_list_libraries',
  'sharepoint_list_files',
  'sharepoint_list_shared_with_me',
  'sharepoint_read_file',
  'sharepoint_resolve_url',
  'sharepoint_search',
] as const);

/**
 * The Slack read tools BotBoy's own code paths use (ingestion transport,
 * channel picker, fetch_slack chat tool). This is a scoping list, not a
 * trust boundary: the server's remaining tools (message posting, uploads,
 * channel management) are simply not wired into BotBoy features yet — a
 * guided write framework will add them as first-class actions later.
 */
export const SLACK_MCP_READ_TOOLS = Object.freeze([
  'search',
  'batch_get_conversation_history',
  'batch_get_thread_replies',
  'batch_get_user_info',
  'batch_get_channel_info',
  'get_channel_sections',
  'list_channels',
  'download_file_content',
] as const);

/** Row kind for user-added MCP servers. They are not registry entries. */
export const CUSTOM_MCP_KIND = 'custom' as const;

/** Identifier prefix for user-added MCP servers. */
export const CUSTOM_MCP_ID_PREFIX = 'custom-' as const;

/** Shared default SQL configuration used by the manager and storage seeding. */
export const DEFAULT_SQL_CONTEXT_CONFIG: SqlContextMcpConfig = {
  enabled: false,
  authMethod: 'iam',
  host: '',
  port: 5439,
  database: '',
  username: '',
  clusterId: '',
  secretId: '',
  awsRegion: 'us-east-1',
  awsProfile: '',
  sslMode: 'verify-full',
  sslCaPath: '',
  sslCertPath: '',
  sslKeyPath: '',
  contextSource: 'none',
  contextValue: '',
};

/** A fixed, code-owned subprocess action such as `grasp-mcp login`. */
export interface McpSetupActionDefinition {
  id: string;
  args: readonly string[];
  timeoutMs: number;
  messages: { completed: string; failed: string; timedOut: string };
}

/**
 * One approved interactive setup command for the embedded terminal. The
 * argument vector is code-owned; the browser selects only the identifier.
 * The command runs under a pseudo-terminal so PIN prompts, security-key
 * touches, and browser hand-offs behave exactly as in a normal terminal.
 */
export interface McpTerminalCommandDefinition {
  id: string;
  title: string;
  description: string;
  /** First entry is the executable name; discovery resolves it safely. */
  argv: readonly string[];
  timeoutMs: number;
  /** Reject the command while the MCP server is enabled or running. */
  requiresStopped: boolean;
}

/** One rendered step on the generic managed-profile settings page. */
export interface McpProfileGuideStep {
  title: string;
  description: string;
  /** Approved terminal command shown to the user. Display only. */
  command?: string;
  /** Setup action button bound to a registry-declared action id. */
  action?: { id: string; label: string; pendingLabel: string; icon: string };
  /** Render the start / test / stop lifecycle button row. */
  lifecycle?: boolean;
}

/** Status-dependent "next safe action" copy for the generic profile page. */
export interface McpProfileNextActions {
  default: string;
  notInstalled?: string;
  starting?: string;
  failed?: string;
  runningUnchecked?: string;
  runningIncompatible?: string;
  runningCompatible?: string;
}

export interface McpProfileActionCopy {
  pending: string;
  success: string;
  failure: string;
  /** Optional override when a compatibility test finds missing tools. */
  incompatible?: string;
}

/** All code-owned copy the dashboard needs to render a profile generically. */
export interface McpProfileUi {
  breadcrumb: string;
  pageSubtitle: string;
  setupHeading: { title: string; subtitle: string };
  steps: readonly McpProfileGuideStep[];
  nextActions: McpProfileNextActions;
  sidePanels: readonly { icon: string; eyebrow: string; title: string; body: string }[];
  actionCopy: Readonly<Record<string, McpProfileActionCopy>>;
  card: { dataHandling: string; notInstalledDetail?: string; needsSetupDetail: string; readyDetail: string };
}

export type McpLaunchDefinition =
  | { type: 'sql-context-package' }
  | { type: 'local-executable'; executableName: string; args: readonly string[] }
  | {
    /** User-added server. The user supplied the command through the local UI. */
    type: 'custom-command';
    command: string;
    args: readonly string[];
    env: Readonly<Record<string, string>>;
  };

export interface McpServerPolicy {
  /** Expose server-authored tool descriptors through generic status APIs. */
  exposeToolDescriptors: boolean;
  /** Replace raw process/protocol errors with fixed safe messages. */
  redactErrors: boolean;
  /** Discard child stderr instead of logging a bounded tail. */
  discardStderr: boolean;
  /** Allow POST /mcp/servers/:id/tools/:tool for policy-approved tools. */
  allowGenericToolCalls: boolean;
  /** Allow POST /mcp/servers/:id/restart. */
  allowGenericRestart: boolean;
}

/**
 * The launch-and-policy contract the manager operates on. Registry profiles
 * satisfy it directly; user-added servers are converted from their stored
 * configuration through buildCustomServerDefinition().
 */
export interface McpServerDefinition {
  id: string;
  kind: string;
  displayName: string;
  /** Short name used inside sanitized error messages. */
  shortName: string;
  packageVersion: string;
  launch: McpLaunchDefinition;
  setupActions: readonly McpSetupActionDefinition[];
  /** Approved interactive commands for the embedded setup terminal. */
  terminalCommands: readonly McpTerminalCommandDefinition[];
  requiredTools: readonly string[];
  policy: McpServerPolicy;
}

export interface BuiltInMcpProfile extends McpServerDefinition {
  id: BuiltInMcpProfileId;
  kind: BuiltInMcpProfileId;
  launch:
    | { type: 'sql-context-package' }
    | { type: 'local-executable'; executableName: string; args: readonly string[] };
  /** Non-secret configuration seeded into the mcp_servers row. */
  seedConfigJson: string;
  ui: McpProfileUi;
}

const GRASP_INSTALL_COMMAND =
  'toolbox --registry s3://buildertoolbox-registry-grasp-tools-us-west-2/tools.json install grasp-mcp';
const GRASP_INITIALIZE_COMMAND = 'grasp-mcp config initialize';
const GRASP_MIDWAY_COMMAND = 'mwinit';
const GRASP_AUTHORIZE_COMMAND = 'grasp-mcp login';

const PROFILES: Readonly<Record<BuiltInMcpProfileId, BuiltInMcpProfile>> = Object.freeze({
  'sql-context': Object.freeze({
    id: SQL_CONTEXT_PROFILE_ID,
    kind: SQL_CONTEXT_PROFILE_ID,
    displayName: 'SQL / Redshift',
    shortName: 'SQL MCP',
    packageVersion: '1.3.1',
    launch: Object.freeze({ type: 'sql-context-package' as const }),
    setupActions: Object.freeze([]),
    terminalCommands: Object.freeze([]),
    requiredTools: Object.freeze(['connection_status']),
    policy: Object.freeze({
      exposeToolDescriptors: true,
      redactErrors: false,
      discardStderr: false,
      allowGenericToolCalls: true,
      allowGenericRestart: true,
    }),
    seedConfigJson: JSON.stringify(DEFAULT_SQL_CONTEXT_CONFIG),
    ui: Object.freeze({
      breadcrumb: 'SQL analytics',
      pageSubtitle: 'A managed, read-only Redshift connection.',
      setupHeading: { title: 'Redshift connection', subtitle: 'Only connection choices are configurable; BotBoy manages the MCP process.' },
      steps: Object.freeze([]),
      nextActions: { default: 'Configure the Redshift connection, then test it.' },
      sidePanels: Object.freeze([]),
      actionCopy: Object.freeze({}),
      card: {
        dataHandling: 'Read-only queries',
        needsSetupDetail: 'Configure Redshift and schema context',
        readyDetail: 'Managed Redshift analytics connection',
      },
    }),
  }),
  'grasp-m365': Object.freeze({
    id: GRASP_PROFILE_ID,
    kind: GRASP_PROFILE_ID,
    displayName: 'Amazon Microsoft 365 through GRASP',
    shortName: 'GRASP MCP',
    packageVersion: 'built-in',
    launch: Object.freeze({
      type: 'local-executable' as const,
      executableName: 'grasp-mcp',
      // The stdio transport is the CLI default; `serve` accepts no quiet flag.
      args: Object.freeze(['serve'] as const),
    }),
    setupActions: Object.freeze([
      Object.freeze({
        id: 'initialize',
        // --overwrite keeps the action idempotent when environments exist.
        args: Object.freeze(['config', 'initialize', '--overwrite']),
        timeoutMs: 60_000,
        messages: Object.freeze({
          completed: 'GRASP initialization completed.',
          failed: `GRASP initialization did not complete. Use the setup terminal or run '${GRASP_INITIALIZE_COMMAND}' in a terminal.`,
          timedOut: `GRASP initialization timed out. Use the setup terminal or run '${GRASP_INITIALIZE_COMMAND}' in a terminal.`,
        }),
      }),
      Object.freeze({
        id: 'authorize',
        args: Object.freeze(['login']),
        timeoutMs: 10 * 60_000,
        messages: Object.freeze({
          completed: 'The GRASP login command completed. Start and test the MCP server next.',
          failed: `The GRASP login command did not complete. Use the setup terminal or run '${GRASP_AUTHORIZE_COMMAND}' in a terminal.`,
          timedOut: `The GRASP login command timed out. Use the setup terminal or run '${GRASP_AUTHORIZE_COMMAND}' in a terminal.`,
        }),
      }),
    ]),
    terminalCommands: Object.freeze([
      Object.freeze({
        id: 'install',
        title: 'Install GRASP',
        description: 'Installs the grasp-mcp tool through Amazon Toolbox.',
        argv: Object.freeze(['toolbox', '--registry', 's3://buildertoolbox-registry-grasp-tools-us-west-2/tools.json', 'install', 'grasp-mcp']),
        timeoutMs: 10 * 60_000,
        requiresStopped: false,
      }),
      Object.freeze({
        id: 'midway',
        title: 'Refresh Midway',
        description: 'Prompts for your Midway PIN and your security-key touch.',
        argv: Object.freeze(['mwinit']),
        timeoutMs: 5 * 60_000,
        requiresStopped: false,
      }),
      Object.freeze({
        id: 'initialize',
        title: 'Initialize GRASP',
        description: 'Creates or overwrites the GRASP environments.',
        argv: Object.freeze(['grasp-mcp', 'config', 'initialize', '--overwrite']),
        timeoutMs: 2 * 60_000,
        requiresStopped: true,
      }),
      Object.freeze({
        id: 'authorize',
        title: 'Authorize Personal Access',
        description: 'Starts the GRASP browser login flow for your own account.',
        argv: Object.freeze(['grasp-mcp', 'login']),
        timeoutMs: 10 * 60_000,
        requiresStopped: false,
      }),
    ]),
    requiredTools: Object.freeze([
      'get_profile',
      'list_mail_folders',
      'get_emails',
      'get_email_details',
      'get_calendar_events',
    ]),
    policy: Object.freeze({
      exposeToolDescriptors: true,
      redactErrors: true,
      discardStderr: true,
      allowGenericToolCalls: true,
      allowGenericRestart: false,
    }),
    seedConfigJson: '{}',
    ui: Object.freeze({
      breadcrumb: 'GRASP',
      pageSubtitle: 'Use local Personal Access. GRASP controls the login flow, and BotBoy stores no GRASP credentials.',
      setupHeading: { title: 'Local setup', subtitle: 'Run the fixed steps for your own Amazon account.' },
      steps: Object.freeze([
        {
          title: 'Install GRASP',
          description: 'Run this approved Toolbox command in a terminal. BotBoy does not run installation commands.',
          command: GRASP_INSTALL_COMMAND,
        },
        {
          title: 'Initialize GRASP',
          description: 'Run the fixed initialization action. If the action does not complete, use this terminal command.',
          command: GRASP_INITIALIZE_COMMAND,
          action: { id: 'initialize', label: 'Initialize', pendingLabel: 'Initializing…', icon: 'settings' },
        },
        {
          title: 'Refresh Midway',
          description: 'Run this command in a terminal if GRASP asks for a current Midway session.',
          command: GRASP_MIDWAY_COMMAND,
        },
        {
          title: 'Authorize Personal Access',
          description: 'GRASP opens and controls the browser login flow. A completed command does not prove access to Mail, Calendar, or Files.',
          command: GRASP_AUTHORIZE_COMMAND,
          action: { id: 'authorize', label: 'Authorize', pendingLabel: 'Authorizing…', icon: 'link' },
        },
        {
          title: 'Start and test',
          description: 'BotBoy starts the fixed grasp-mcp serve process. The test uses initialize, ping, and tool discovery. It does not call a Microsoft 365 data tool.',
          lifecycle: true,
        },
      ]),
      nextActions: {
        default: 'For first use, initialize GRASP, refresh Midway, and authorize your account. Then start the server.',
        notInstalled: 'Run the approved install command in a terminal. Then select Check installation.',
        starting: 'Wait for the local MCP server to start.',
        failed: 'Stop the server. Review the setup sequence. Then start the server again.',
        runningUnchecked: 'Test compatibility. The test uses MCP protocol operations only.',
        runningIncompatible: 'Stop the server and update the local GRASP installation before you test again.',
        runningCompatible: 'The connection is ready. Ask BotBoy about your mail, calendar, or files in chat.',
      },
      sidePanels: Object.freeze([
        {
          icon: 'shield',
          eyebrow: 'Data boundary',
          title: 'Reads are free, writes need your request',
          body: 'BotBoy can read your mail, calendar, and files through audited tools. Actions that send, create, or change anything run only when you explicitly ask in chat.',
        },
      ]),
      actionCopy: Object.freeze({
        check: { pending: 'Checking the GRASP installation…', success: 'GRASP installation check completed.', failure: 'Could not check the GRASP installation' },
        initialize: { pending: 'Running GRASP initialization…', success: 'GRASP initialization completed.', failure: 'GRASP initialization did not complete' },
        authorize: { pending: 'Opening the GRASP login flow…', success: 'The GRASP login command completed.', failure: 'The GRASP login command did not complete' },
        start: { pending: 'Starting the GRASP MCP server…', success: 'The GRASP MCP server started.', failure: 'Could not start the GRASP MCP server' },
        test: {
          pending: 'Testing MCP compatibility…',
          success: 'GRASP MCP compatibility passed.',
          failure: 'The GRASP MCP compatibility test did not pass',
          incompatible: 'The GRASP MCP server is running, but required tools are absent.',
        },
        stop: { pending: 'Stopping the GRASP MCP server…', success: 'The GRASP MCP server stopped.', failure: 'Could not stop the GRASP MCP server' },
      }),
      card: {
        dataHandling: 'Reads free, writes on request',
        notInstalledDetail: 'Install GRASP, then use its local login flow',
        needsSetupDetail: 'Install GRASP, then use its local login flow',
        readyDetail: 'Personal Access for your own Amazon Microsoft 365 account',
      },
    }),
  }),
  slack: Object.freeze({
    id: SLACK_MCP_PROFILE_ID,
    kind: SLACK_MCP_PROFILE_ID,
    displayName: 'Amazon Slack through AI Community MCP',
    shortName: 'Slack MCP',
    packageVersion: 'built-in',
    launch: Object.freeze({
      type: 'local-executable' as const,
      executableName: 'ai-community-slack-mcp',
      args: Object.freeze([] as const),
    }),
    setupActions: Object.freeze([]),
    // Listed in true dependency order: the AIM CLI must exist before
    // `aim mcp install` can run, and Midway only matters once the server
    // binary is present.
    terminalCommands: Object.freeze([
      Object.freeze({
        id: 'update-toolbox',
        title: 'Install/update Toolbox + AIM',
        description: 'Installs the AIM CLI through Amazon Toolbox (or updates it). Required before the Slack MCP can be installed.',
        argv: Object.freeze(['toolbox', 'install', 'aim']),
        timeoutMs: 10 * 60_000,
        requiresStopped: false,
      }),
      Object.freeze({
        id: 'install',
        title: 'Install the Slack MCP',
        description: 'Installs ai-community-slack-mcp through the AIM CLI (Amazon Toolbox).',
        argv: Object.freeze(['aim', 'mcp', 'install', 'ai-community-slack-mcp']),
        timeoutMs: 10 * 60_000,
        requiresStopped: false,
      }),
      Object.freeze({
        id: 'midway',
        title: 'Refresh Midway',
        description: 'Prompts for your Midway PIN and your security-key touch. The Slack MCP authenticates with your Amazon session.',
        argv: Object.freeze(['mwinit']),
        timeoutMs: 5 * 60_000,
        requiresStopped: false,
      }),
    ]),
    requiredTools: SLACK_MCP_READ_TOOLS,
    policy: Object.freeze({
      exposeToolDescriptors: true,
      redactErrors: true,
      discardStderr: true,
      allowGenericToolCalls: true,
      allowGenericRestart: true,
    }),
    seedConfigJson: '{}',
    ui: Object.freeze({
      breadcrumb: 'Slack',
      pageSubtitle: 'The AI Community Slack MCP authenticates with your local Amazon session. BotBoy stores no Slack tokens.',
      setupHeading: { title: 'Local setup', subtitle: 'Install once through Toolbox, keep Midway fresh, and BotBoy manages the server process.' },
      steps: Object.freeze([
        {
          title: 'Install the Slack MCP',
          description: 'Run the approved AIM install command. It registers the ai-community-slack-mcp executable through Amazon Toolbox.',
          command: 'aim mcp install ai-community-slack-mcp',
        },
        {
          title: 'Refresh Midway',
          description: 'The server authenticates with your Amazon session. Run this when Slack tools report an expired session.',
          command: 'mwinit',
        },
        {
          title: 'Start and test',
          description: 'BotBoy starts the fixed ai-community-slack-mcp process. The test checks the read tools BotBoy uses for capture, the channel picker, and chat.',
          lifecycle: true,
        },
      ]),
      nextActions: {
        default: 'Install the Slack MCP through Toolbox, then start the server.',
        notInstalled: 'Run the approved install command in a terminal. Then select Check installation.',
        starting: 'Wait for the local MCP server to start.',
        failed: 'Stop the server, refresh Midway, and start it again.',
        runningUnchecked: 'Test compatibility. The test uses MCP protocol operations only.',
        runningIncompatible: 'Stop the server and update the local Slack MCP installation before you test again.',
        runningCompatible: 'The connection is ready. Slack capture, the channel picker, and chat lookups now run through this server.',
      },
      sidePanels: Object.freeze([
        {
          icon: 'shield',
          eyebrow: 'Data boundary',
          title: 'Reads are free, writes need your request',
          body: 'BotBoy reads conversations, threads, people, and files through audited tools. Actions that post, upload, or change anything in Slack are not wired up yet; a guided write framework will add them as explicit, owner-driven actions.',
        },
        {
          icon: 'refresh',
          eyebrow: 'Continuity',
          title: 'No tokens to rotate',
          body: 'Authentication rides your Amazon Midway session. When it expires, capture pauses losslessly and resumes after mwinit — nothing is missed, and no Slack app or OAuth token is involved.',
        },
      ]),
      actionCopy: Object.freeze({
        check: { pending: 'Checking the Slack MCP installation…', success: 'Slack MCP installation check completed.', failure: 'Could not check the Slack MCP installation' },
        start: { pending: 'Starting the Slack MCP server…', success: 'The Slack MCP server started.', failure: 'Could not start the Slack MCP server' },
        test: {
          pending: 'Testing MCP compatibility…',
          success: 'Slack MCP compatibility passed.',
          failure: 'The Slack MCP compatibility test did not pass',
          incompatible: 'The Slack MCP server is running, but required read tools are absent.',
        },
        stop: { pending: 'Stopping the Slack MCP server…', success: 'The Slack MCP server stopped.', failure: 'Could not stop the Slack MCP server' },
      }),
      card: {
        dataHandling: 'Reads free, writes on request',
        notInstalledDetail: 'Install through Toolbox: aim mcp install ai-community-slack-mcp',
        needsSetupDetail: 'Install the Slack MCP, then start the managed server',
        readyDetail: 'Slack capture, channel picker, and chat lookups through your Amazon session',
      },
    }),
  }),
  sharepoint: Object.freeze({
    id: SHAREPOINT_MCP_PROFILE_ID,
    kind: SHAREPOINT_MCP_PROFILE_ID,
    displayName: 'Amazon SharePoint & OneDrive',
    shortName: 'SharePoint MCP',
    packageVersion: 'built-in',
    launch: Object.freeze({
      type: 'local-executable' as const,
      executableName: 'amazon-sharepoint-mcp',
      args: Object.freeze([] as const),
    }),
    setupActions: Object.freeze([]),
    // Same dependency order as the Slack profile: AIM CLI first, then the
    // server install, then Midway freshness.
    terminalCommands: Object.freeze([
      Object.freeze({
        id: 'update-toolbox',
        title: 'Install/update Toolbox + AIM',
        description: 'Installs the AIM CLI through Amazon Toolbox (or updates it). Required before the SharePoint MCP can be installed.',
        argv: Object.freeze(['toolbox', 'install', 'aim']),
        timeoutMs: 10 * 60_000,
        requiresStopped: false,
      }),
      Object.freeze({
        id: 'install',
        title: 'Install the SharePoint MCP',
        description: 'Installs amazon-sharepoint-mcp through the AIM CLI (Amazon Toolbox).',
        argv: Object.freeze(['aim', 'mcp', 'install', 'amazon-sharepoint-mcp']),
        timeoutMs: 10 * 60_000,
        requiresStopped: false,
      }),
      Object.freeze({
        id: 'midway',
        title: 'Refresh Midway',
        description: 'Prompts for your Midway PIN and your security-key touch. The SharePoint MCP authenticates with your Amazon session.',
        argv: Object.freeze(['mwinit']),
        timeoutMs: 5 * 60_000,
        requiresStopped: false,
      }),
    ]),
    requiredTools: SHAREPOINT_MCP_REQUIRED_TOOLS,
    policy: Object.freeze({
      exposeToolDescriptors: true,
      redactErrors: true,
      discardStderr: true,
      allowGenericToolCalls: true,
      allowGenericRestart: true,
    }),
    seedConfigJson: '{}',
    ui: Object.freeze({
      breadcrumb: 'SharePoint',
      pageSubtitle: 'The Amazon SharePoint MCP authenticates with your local Midway session. BotBoy stores no SharePoint credentials.',
      setupHeading: { title: 'Local setup', subtitle: 'Install once through Toolbox, keep Midway fresh, and BotBoy manages the server process.' },
      steps: Object.freeze([
        {
          title: 'Install the SharePoint MCP',
          description: 'Run the approved AIM install command. It registers the amazon-sharepoint-mcp executable through Amazon Toolbox.',
          command: 'aim mcp install amazon-sharepoint-mcp',
        },
        {
          title: 'Refresh Midway',
          description: 'The server authenticates with your Amazon session. Run this when SharePoint tools report an expired session.',
          command: 'mwinit',
        },
        {
          title: 'Start and test',
          description: 'BotBoy starts the fixed amazon-sharepoint-mcp process. The test checks the read tools the document sync and chat use. It does not call a SharePoint data tool.',
          lifecycle: true,
        },
      ]),
      nextActions: {
        default: 'Install the SharePoint MCP through Toolbox, then start the server.',
        notInstalled: 'Run the approved install command in a terminal. Then select Check installation.',
        starting: 'Wait for the local MCP server to start.',
        failed: 'Stop the server, refresh Midway, and start it again.',
        runningUnchecked: 'Test compatibility. The test uses MCP protocol operations only.',
        runningIncompatible: 'Stop the server and update the local SharePoint MCP installation before you test again.',
        runningCompatible: 'The connection is ready. Pick sync sources below, or ask BotBoy about your SharePoint documents in chat.',
      },
      sidePanels: Object.freeze([
        {
          icon: 'shield',
          eyebrow: 'Data boundary',
          title: 'Reads are free, changes are locked',
          body: 'BotBoy reads sites, libraries, documents, and comments through audited tools. Deleting, restructuring, and site administration are blocked outright, and document writes stay locked until their guided approval flows ship.',
        },
        {
          icon: 'refresh',
          eyebrow: 'Continuity',
          title: 'No tokens to rotate',
          body: 'Authentication rides your Amazon Midway session. When it expires, the document sync pauses losslessly and resumes after mwinit — nothing is missed, and BotBoy stores no SharePoint credential.',
        },
      ]),
      actionCopy: Object.freeze({
        check: { pending: 'Checking the SharePoint MCP installation…', success: 'SharePoint MCP installation check completed.', failure: 'Could not check the SharePoint MCP installation' },
        start: { pending: 'Starting the SharePoint MCP server…', success: 'The SharePoint MCP server started.', failure: 'Could not start the SharePoint MCP server' },
        test: {
          pending: 'Testing MCP compatibility…',
          success: 'SharePoint MCP compatibility passed.',
          failure: 'The SharePoint MCP compatibility test did not pass',
          incompatible: 'The SharePoint MCP server is running, but required read tools are absent.',
        },
        stop: { pending: 'Stopping the SharePoint MCP server…', success: 'The SharePoint MCP server stopped.', failure: 'Could not stop the SharePoint MCP server' },
      }),
      card: {
        dataHandling: 'Reads free, writes locked',
        notInstalledDetail: 'Install through Toolbox: aim mcp install amazon-sharepoint-mcp',
        needsSetupDetail: 'Install the SharePoint MCP, then start the managed server',
        readyDetail: 'Document sync from shared-with-me, OneDrive, and team libraries through your Amazon session',
      },
    }),
  }),
});

export function isBuiltInMcpProfileId(value: string): value is BuiltInMcpProfileId {
  return Object.prototype.hasOwnProperty.call(PROFILES, value);
}

export function getBuiltInMcpProfile(value: string): BuiltInMcpProfile | null {
  return isBuiltInMcpProfileId(value) ? PROFILES[value] : null;
}

export function listBuiltInMcpProfiles(): BuiltInMcpProfile[] {
  return Object.values(PROFILES);
}

export function getSetupActionDefinition(
  profile: McpServerDefinition,
  actionId: string,
): McpSetupActionDefinition | null {
  return profile.setupActions.find(action => action.id === actionId) ?? null;
}

/**
 * Build the manager-facing definition for one user-added MCP server. The
 * policy keeps custom servers closed to the agent: tool descriptors stay out
 * of model-visible status, and generic tool calls remain blocked because the
 * tool policy classifies unknown kinds as unknown risk.
 */
export function buildCustomServerDefinition(input: {
  id: string;
  displayName: string;
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}): McpServerDefinition {
  return {
    id: input.id,
    kind: CUSTOM_MCP_KIND,
    displayName: input.displayName,
    shortName: input.displayName,
    packageVersion: 'user-defined',
    launch: {
      type: 'custom-command',
      command: input.command,
      args: input.args,
      env: input.env,
    },
    setupActions: [],
    terminalCommands: [],
    requiredTools: [],
    policy: {
      exposeToolDescriptors: true,
      redactErrors: false,
      discardStderr: false,
      allowGenericToolCalls: true,
      allowGenericRestart: true,
    },
  };
}

export function getTerminalCommandDefinition(
  profile: McpServerDefinition,
  commandId: string,
): McpTerminalCommandDefinition | null {
  return profile.terminalCommands.find(command => command.id === commandId) ?? null;
}

/**
 * Map raw errors to fixed safe messages for profiles that redact errors.
 * Raw process, protocol, and login output must not reach logs or APIs.
 */
export function sanitizeMcpError(profile: McpServerDefinition, value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? '');
  if (/not installed/i.test(text)) return `${profile.shortName} is not installed.`;
  if (/disabled/i.test(text)) return `The ${profile.shortName} profile is disabled.`;
  if (/busy|already running|must be stopped|shutting down/i.test(text)) {
    return `Stop the ${profile.shortName} server before this action.`;
  }
  return `${profile.shortName} is unavailable. Use Check installation or run the setup commands in a terminal.`;
}

async function verifyExecutableFile(candidate: string): Promise<string | null> {
  try {
    const resolved = await realpath(candidate);
    const file = await stat(resolved);
    if (!file.isFile()) return null;
    await access(resolved, fsConstants.X_OK);
    // Validate through the symbolic link, but return the original path.
    // Wrapper shims such as Amazon Toolbox dispatch on the invoked name:
    // executing the resolved multiplexer directly loses that name and the
    // wrapper refuses to run the tool.
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Code-owned fallback directories for executable discovery. BotBoy can start
 * from Finder or launchd with a minimal PATH, while tools such as Amazon
 * Toolbox live in fixed per-user locations. These directories make discovery
 * deterministic for every teammate regardless of shell configuration.
 *
 * ~/.aim/mcp-servers is where `aim mcp install` places its launch wrappers
 * (e.g. ai-community-slack-mcp). Without it, a successful install still shows
 * "not installed" because interactive shells are the only place that PATH
 * entry exists (post-mortem 2026-08-23: Slack MCP setup dead-ended for every
 * launch context that didn't inherit the user's shell rc).
 */
export const FALLBACK_EXECUTABLE_DIRECTORIES: readonly string[] = Object.freeze([
  path.join(os.homedir(), '.toolbox', 'bin'),
  path.join(os.homedir(), '.aim', 'mcp-servers'),
  '/usr/local/bin',
  '/opt/homebrew/bin',
]);

/**
 * Extend a PATH value with the fallback directories (idempotent). Child
 * processes need this too, not just discovery: the AIM wrapper scripts exec
 * `aim …` and the setup terminals run `toolbox`/`aim`, so both must resolve
 * even when BotBoy itself was launched with a minimal PATH.
 */
export function pathValueWithFallbackDirectories(pathValue: string | undefined): string {
  const entries = (pathValue ?? '').split(path.delimiter).filter(Boolean);
  for (const directory of FALLBACK_EXECUTABLE_DIRECTORIES) {
    if (!entries.includes(directory)) entries.push(directory);
  }
  return entries.join(path.delimiter);
}

async function searchPathForExecutable(
  executableName: string,
  pathValue = process.env.PATH ?? '',
): Promise<string | null> {
  const seen = new Set<string>();
  const directories = [
    ...pathValue.split(path.delimiter),
    ...FALLBACK_EXECUTABLE_DIRECTORIES,
  ];
  for (const directory of directories) {
    if (!directory || !path.isAbsolute(directory) || seen.has(directory)) continue;
    seen.add(directory);
    const resolved = await verifyExecutableFile(path.join(directory, executableName));
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Resolve a user-supplied command safely. A bare name is searched through
 * absolute PATH entries only. A path must be absolute. No shell runs, no
 * relative path is accepted, and the file must be a regular executable.
 */
export async function resolveCommandExecutable(
  command: string,
  pathValue = process.env.PATH ?? '',
): Promise<string | null> {
  if (!command) return null;
  if (command.includes(path.sep)) {
    if (!path.isAbsolute(command)) return null;
    return verifyExecutableFile(command);
  }
  return searchPathForExecutable(command, pathValue);
}

/**
 * Resolve the launch executable for any managed definition. SQL launches
 * through the pinned package entry point and does not resolve here.
 */
export async function resolveDefinitionExecutable(
  definition: McpServerDefinition,
  pathValue = process.env.PATH ?? '',
): Promise<string | null> {
  if (definition.launch.type === 'local-executable') {
    return searchPathForExecutable(definition.launch.executableName, pathValue);
  }
  if (definition.launch.type === 'custom-command') {
    return resolveCommandExecutable(definition.launch.command, pathValue);
  }
  return null;
}

/**
 * Run one fixed setup action as a supervised subprocess. Output is discarded,
 * timeout escalates SIGTERM then SIGKILL, and the promise resolves only after
 * the child has observably exited.
 */
export async function executeProfileSetupAction(
  executable: string,
  definition: McpSetupActionDefinition,
  signal?: AbortSignal,
): Promise<McpSetupActionResult> {
  const result = (outcome: McpSetupActionOutcome): McpSetupActionResult => ({
    action: definition.id,
    outcome,
    message: outcome === 'completed'
      ? definition.messages.completed
      : outcome === 'timed_out'
        ? definition.messages.timedOut
        : definition.messages.failed,
    completedAt: new Date().toISOString(),
  });
  if (signal?.aborted) return result('failed');

  return new Promise((resolve) => {
    let settled = false;
    let terminationOutcome: McpSetupActionOutcome | null = null;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;

    const child = spawn(executable, [...definition.args], {
      env: getDefaultEnvironment(),
      shell: false,
      stdio: 'ignore',
    });

    const clearForceTimer = () => {
      if (!forceTimer) return;
      clearTimeout(forceTimer);
      forceTimer = null;
    };

    const finish = (outcome: McpSetupActionOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearForceTimer();
      signal?.removeEventListener('abort', abort);
      resolve(result(outcome));
    };

    const terminate = (outcome: McpSetupActionOutcome) => {
      if (settled || terminationOutcome) return;
      terminationOutcome = outcome;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => { child.kill('SIGKILL'); }, 5_000);
      forceTimer.unref?.();
    };

    const abort = () => { terminate('failed'); };
    signal?.addEventListener('abort', abort, { once: true });

    const timeout = setTimeout(() => { terminate('timed_out'); }, definition.timeoutMs);
    timeout.unref?.();

    child.once('error', () => finish(terminationOutcome ?? 'failed'));
    child.once('exit', code => finish(terminationOutcome ?? (code === 0 ? 'completed' : 'failed')));
  });
}
