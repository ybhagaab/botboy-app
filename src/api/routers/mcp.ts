import { Router, Request, Response } from 'express';
import type { McpProfileSnapshot, McpServerSnapshot } from '../../core/mcp-types.js';
import {
  CUSTOM_MCP_KIND,
  getBuiltInMcpProfile,
} from '../../core/mcp-profiles.js';
import { paramStr, type RouterDeps } from './deps.js';

/** Lifecycle actions every managed profile supports through the generic route. */
const PROFILE_LIFECYCLE_ACTIONS = new Set(['check', 'start', 'stop', 'test']);

const MAX_TOOL_DESCRIPTION_CHARS = 500;

/**
 * Server-authored descriptors reach the browser only for profiles that allow
 * it and for user-added servers, where the user reviews their own tools.
 * Model-visible status stays registry-gated inside the tool executor.
 */
function exposesToolDescriptors(server: McpServerSnapshot): boolean {
  if (server.kind === CUSTOM_MCP_KIND) return true;
  return getBuiltInMcpProfile(server.id)?.policy.exposeToolDescriptors === true;
}

function publicServer(server: McpServerSnapshot | null | undefined): Record<string, unknown> {
  if (!server) return {};
  // Package, command, arguments, transport, PID, and child environment are
  // native implementation details and are intentionally absent from this API.
  // Server-authored tool descriptors are exposed only when the registry
  // profile allows it.
  return {
    id: server.id,
    kind: server.kind,
    displayName: server.displayName,
    enabled: server.enabled,
    configured: server.configured,
    state: server.state,
    tools: exposesToolDescriptors(server) ? server.tools : [],
    restartCount: server.restartCount,
    lastError: server.lastError,
    lastStartedAt: server.lastStartedAt,
    lastHealthyAt: server.lastHealthyAt,
    updatedAt: server.updatedAt,
  };
}

/** Synthesized Connections copy for user-added servers. */
function customServerGuide(profile: McpProfileSnapshot): Record<string, unknown> {
  return {
    breadcrumb: profile.displayName,
    pageSubtitle: 'A user-added local MCP server. BotBoy manages the process; reads run freely and writes need your explicit request in chat.',
    setupHeading: {
      title: 'Server lifecycle',
      subtitle: 'BotBoy starts, supervises, and stops the command you configured.',
    },
    steps: [],
    nextActions: {
      default: 'Start the server. Then test the MCP protocol connection.',
      notInstalled: 'The command was not found. Edit the configuration or install the command. Then select Check installation.',
      starting: 'Wait for the local MCP server to start.',
      failed: 'Stop the server. Review the command, arguments, and environment. Then start the server again.',
      runningUnchecked: 'Test the connection. The test uses MCP protocol operations only.',
      runningCompatible: 'The connection is healthy. Ask BotBoy to use its tools in chat.',
    },
    sidePanels: [{
      icon: 'shield',
      eyebrow: 'Agent boundary',
      title: 'Reads are free, writes need your request',
      body: 'BotBoy can call read tools of this server whenever they help. Tools that change data run only when you explicitly ask in chat, and every call is audited.',
    }],
    actionCopy: {
      check: { pending: 'Checking the command…', success: 'Command check completed.', failure: 'Could not check the command' },
      start: { pending: 'Starting the MCP server…', success: 'The MCP server started.', failure: 'Could not start the MCP server' },
      test: { pending: 'Testing the MCP connection…', success: 'The MCP protocol test passed.', failure: 'The MCP protocol test did not pass' },
      stop: { pending: 'Stopping the MCP server…', success: 'The MCP server stopped.', failure: 'Could not stop the MCP server' },
    },
    card: {
      dataHandling: 'Reads free, writes on request',
      notInstalledDetail: 'Command not found. Edit the configuration.',
      needsSetupDetail: 'Command not found. Edit the configuration.',
      readyDetail: 'User-added MCP server',
    },
  };
}

function publicProfile(profile: McpProfileSnapshot | null | undefined): Record<string, unknown> {
  if (!profile) return {};
  const registered = getBuiltInMcpProfile(profile.id);
  const custom = profile.kind === CUSTOM_MCP_KIND;
  return {
    ...publicServer(profile),
    installationState: profile.installationState,
    compatibilityState: profile.compatibilityState,
    requiredTools: profile.requiredTools,
    missingTools: profile.missingTools,
    needsReview: profile.needsReview === true,
    // Registry profiles expose code-classified names and risks only. Custom
    // servers additionally show bounded descriptions for user review.
    tools: profile.tools.map(tool => custom
      ? {
        name: tool.name,
        risk: tool.risk,
        description: typeof tool.description === 'string' ? tool.description.slice(0, MAX_TOOL_DESCRIPTION_CHARS) : undefined,
      }
      : { name: tool.name, risk: tool.risk }),
    // Code-owned UI contract: setup guide, copy, and available actions.
    guide: registered ? registered.ui : custom ? customServerGuide(profile) : undefined,
    setupActions: registered ? registered.setupActions.map(action => action.id) : [],
    terminalCommands: registered
      ? registered.terminalCommands.map(command => ({
        id: command.id,
        title: command.title,
        description: command.description,
        requiresStopped: command.requiresStopped,
      }))
      : [],
    settingsPage: registered?.launch.type === 'sql-context-package' ? 'sql-config' : 'managed-profile',
    custom,
  };
}

function acceptsJsonSameOrigin(req: Request, res: Response): boolean {
  if (!req.is('application/json')) {
    res.status(415).json({ error: 'This action requires an application/json request body' });
    return false;
  }

  const origin = req.get('origin');
  if (origin) {
    const host = req.get('host');
    let sameOrigin = false;
    try {
      sameOrigin = Boolean(host)
        && new URL(origin).origin === new URL(`${req.protocol}://${host}`).origin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      res.status(403).json({ error: 'Cross-origin MCP management requests are not allowed' });
      return false;
    }
  }
  return true;
}

function acceptsEmptyObject(req: Request, res: Response): boolean {
  if (!acceptsJsonSameOrigin(req, res)) return false;
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length > 0) {
    res.status(400).json({ error: 'This action requires an empty JSON object' });
    return false;
  }
  return true;
}

function acceptsJsonObjectBody(req: Request, res: Response): boolean {
  if (!acceptsJsonSameOrigin(req, res)) return false;
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    res.status(400).json({ error: 'This request requires a JSON object body' });
    return false;
  }
  return true;
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const address = value.split('%', 1)[0].toLowerCase();
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

function acceptsLoopbackRequest(req: Request, res: Response): boolean {
  if (isLoopbackAddress(req.socket.remoteAddress) && isLoopbackAddress(req.socket.localAddress)) return true;
  res.status(403).json({ error: 'MCP profile actions are available only through the local BotBoy API' });
  return false;
}

function safeProfileRouteError(
  policy: { shortName: string; redactErrors: boolean },
  error: unknown,
): { status: number; message: string } {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (!policy.redactErrors) {
    const status = /not installed|not found|unknown/i.test(message) ? 409
      : /stop|running|busy|already|shutting down/i.test(message) ? 409 : 502;
    return { status, message: message || 'The MCP profile action failed.' };
  }
  if (/not installed/i.test(message)) return { status: 409, message: `${policy.shortName} is not installed.` };
  if (/disabled/i.test(message)) return { status: 409, message: `The ${policy.shortName} profile is disabled.` };
  if (/finish the setup terminal/i.test(message)) {
    // Code-owned guard message; safe to return verbatim.
    return { status: 409, message: 'Finish the setup terminal session before this action.' };
  }
  if (/stop|running|busy|already/i.test(message)) {
    return { status: 409, message: `Stop the ${policy.shortName} server before this action.` };
  }
  return { status: 502, message: `The ${policy.shortName} action failed. Use the terminal guidance and try again.` };
}

/** Route-level policy view for one profile id, registry or custom. */
function routePolicyFor(profile: McpProfileSnapshot): { shortName: string; redactErrors: boolean } {
  const registered = getBuiltInMcpProfile(profile.id);
  if (registered) return { shortName: registered.shortName, redactErrors: registered.policy.redactErrors };
  return { shortName: profile.displayName, redactErrors: false };
}

export function createMcpRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/mcp/servers', async (_req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    try {
      const servers = await deps.mcpManager.listServers();
      res.json({ servers: servers.map(publicServer) });
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? String(error) });
    }
  });

  router.get('/mcp/profiles', async (_req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    try {
      const profiles = await deps.mcpManager.listProfiles();
      res.json({ profiles: profiles.map(publicProfile) });
    } catch {
      res.status(500).json({ error: 'Could not load built-in MCP profiles' });
    }
  });

  // One generic surface serves every managed profile: registry entries and
  // user-added servers. Every request must originate from a loopback socket;
  // unknown ids resolve to 404 through the manager.
  router.use('/mcp/profiles/:profileId', (req: Request, res: Response, next) => {
    if (!acceptsLoopbackRequest(req, res)) return;
    next();
  });

  router.get('/mcp/profiles/:profileId', async (req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    const profileId = paramStr(req.params.profileId);
    try {
      const profile = await deps.mcpManager.getProfile(profileId);
      if (!profile) return res.status(404).json({ error: 'Unknown MCP profile' });
      res.json({ profile: publicProfile(profile) });
    } catch {
      res.status(500).json({ error: 'Could not load the MCP profile' });
    }
  });

  router.post('/mcp/profiles/:profileId/actions/:action', async (req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    const profileId = paramStr(req.params.profileId);
    const existing = await deps.mcpManager.getProfile(profileId).catch(() => null);
    if (!existing) return res.status(404).json({ error: 'Unknown MCP profile' });
    const registered = getBuiltInMcpProfile(profileId);
    const action = paramStr(req.params.action);
    const isSetupAction = registered ? registered.setupActions.some(definition => definition.id === action) : false;
    if (!PROFILE_LIFECYCLE_ACTIONS.has(action) && !isSetupAction) {
      return res.status(404).json({ error: 'Unknown MCP profile action' });
    }
    if (!acceptsEmptyObject(req, res)) return;
    const policy = routePolicyFor(existing);

    try {
      if (action === 'check') {
        const profile = await deps.mcpManager.checkProfile(profileId);
        return res.json({ profile: publicProfile(profile) });
      }
      if (action === 'start') {
        // A Start from this route is the local user acting in the dashboard.
        // That press is the review approval for an assistant-written
        // definition; the agent's tool path has no equivalent and stays
        // blocked by the manager gate.
        if (existing.kind === CUSTOM_MCP_KIND && existing.needsReview) {
          await deps.mcpManager.approveCustomServer(profileId);
        }
        const profile = await deps.mcpManager.startProfile(profileId);
        return res.json({ profile: publicProfile(profile) });
      }
      if (action === 'stop') {
        const profile = await deps.mcpManager.stopProfile(profileId);
        return res.json({ profile: publicProfile(profile) });
      }
      if (action === 'test') {
        const result = await deps.mcpManager.testProfile(profileId);
        const profile = await deps.mcpManager.getProfile(profileId);
        return res.status(result.compatibilityState === 'compatible' ? 200 : 409).json({
          result,
          profile: publicProfile(profile),
        });
      }
      const result = await deps.mcpManager.runSetupAction(profileId, action);
      const profile = await deps.mcpManager.getProfile(profileId);
      const status = result.outcome === 'completed' ? 200 : result.outcome === 'timed_out' ? 504 : 502;
      return res.status(status).json({ result, profile: publicProfile(profile) });
    } catch (error) {
      const safe = safeProfileRouteError(policy, error);
      res.status(safe.status).json({ error: safe.message });
    }
  });

  // ── Embedded setup terminal ──
  // Runs only registry-declared commands under a pseudo-terminal so
  // interactive authentication (Midway PIN, security-key touch, browser
  // login) completes inside BotBoy. The browser sends a command identifier,
  // never a command. Output streams over SSE and is never persisted.
  router.post('/mcp/profiles/:profileId/terminal', async (req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    if (!acceptsJsonObjectBody(req, res)) return;
    const profileId = paramStr(req.params.profileId);
    const commandId = typeof req.body.commandId === 'string' ? req.body.commandId : '';
    if (!commandId) return res.status(400).json({ error: 'commandId is required' });
    try {
      const session = await deps.mcpManager.startTerminalSession(profileId, commandId);
      res.status(201).json({ session });
    } catch (error: any) {
      const message = error?.message ?? String(error);
      const status = /not available|unknown/i.test(message) ? 404
        : /already running|finish the setup|stop the/i.test(message) ? 409
          : /not found/i.test(message) ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.get('/mcp/profiles/:profileId/terminal', (req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    const session = deps.mcpManager.getTerminalSession(paramStr(req.params.profileId));
    res.set('Cache-Control', 'no-store');
    res.json({ session });
  });

  router.get('/mcp/profiles/:profileId/terminal/:sessionId/stream', (req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    const profileId = paramStr(req.params.profileId);
    const sessionId = paramStr(req.params.sessionId);
    let unsubscribe: (() => void) | null = null;
    try {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (event: string, payload: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      unsubscribe = deps.mcpManager.subscribeTerminal(
        profileId,
        sessionId,
        chunk => send('output', { chunk }),
        session => { send('end', { session }); res.end(); },
      );
      const keepAlive = setInterval(() => { res.write(': keep-alive\n\n'); }, 15_000);
      keepAlive.unref?.();
      req.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe?.();
      });
    } catch (error: any) {
      unsubscribe?.();
      if (!res.headersSent) {
        res.status(404).json({ error: error?.message ?? String(error) });
      } else {
        res.end();
      }
    }
  });

  router.post('/mcp/profiles/:profileId/terminal/:sessionId/input', (req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    if (!acceptsJsonObjectBody(req, res)) return;
    const data = typeof req.body.data === 'string' ? req.body.data : '';
    try {
      deps.mcpManager.writeTerminalInput(paramStr(req.params.profileId), paramStr(req.params.sessionId), data);
      res.json({ ok: true });
    } catch (error: any) {
      const message = error?.message ?? String(error);
      res.status(/unknown/i.test(message) ? 404 : 409).json({ error: message });
    }
  });

  router.post('/mcp/profiles/:profileId/terminal/:sessionId/stop', (req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    if (!acceptsEmptyObject(req, res)) return;
    try {
      deps.mcpManager.stopTerminalSession(paramStr(req.params.profileId), paramStr(req.params.sessionId));
      res.json({ ok: true });
    } catch (error: any) {
      const message = error?.message ?? String(error);
      res.status(/unknown/i.test(message) ? 404 : 409).json({ error: message });
    }
  });

  // ── User-added MCP servers ──
  // The user owns these commands. Requests stay loopback-only and same-origin;
  // BotBoy validates shape, resolves the executable without a shell, and keeps
  // the agent blocked from the servers' tools.
  router.post('/mcp/servers', async (req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    if (!acceptsLoopbackRequest(req, res)) return;
    if (!acceptsJsonObjectBody(req, res)) return;
    try {
      const profile = await deps.mcpManager.createCustomServer(req.body);
      res.status(201).json({ profile: publicProfile(profile) });
    } catch (error: any) {
      res.status(400).json({ error: error?.message ?? String(error) });
    }
  });

  router.get('/mcp/servers/:id/config', async (req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    if (!acceptsLoopbackRequest(req, res)) return;
    try {
      const config = await deps.mcpManager.getCustomServerConfig(paramStr(req.params.id));
      if (!config) return res.status(404).json({ error: 'Unknown custom MCP server' });
      res.json({ config });
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? String(error) });
    }
  });

  router.put('/mcp/servers/:id/config', async (req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    if (!acceptsLoopbackRequest(req, res)) return;
    if (!acceptsJsonObjectBody(req, res)) return;
    const serverId = paramStr(req.params.id);
    if (getBuiltInMcpProfile(serverId)) {
      return res.status(403).json({ error: 'Built-in profiles are managed by BotBoy and cannot be edited here' });
    }
    try {
      const profile = await deps.mcpManager.updateCustomServer(serverId, req.body);
      res.json({ profile: publicProfile(profile) });
    } catch (error: any) {
      const message = error?.message ?? String(error);
      const status = /unknown custom/i.test(message) ? 404 : /stop the/i.test(message) ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.delete('/mcp/servers/:id', async (req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    if (!acceptsLoopbackRequest(req, res)) return;
    const serverId = paramStr(req.params.id);
    if (getBuiltInMcpProfile(serverId)) {
      return res.status(403).json({ error: 'Built-in profiles cannot be deleted' });
    }
    try {
      await deps.mcpManager.deleteCustomServer(serverId);
      res.json({ deleted: serverId });
    } catch (error: any) {
      const message = error?.message ?? String(error);
      const status = /unknown custom/i.test(message) ? 404 : /stop the/i.test(message) ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.get('/mcp/sql-context/config', async (_req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    try {
      const [config, server] = await Promise.all([
        deps.mcpManager.getSqlContextConfig(),
        deps.mcpManager.getServer('sql-context'),
      ]);
      res.json({ config, server: publicServer(server) });
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? String(error) });
    }
  });

  router.put('/mcp/sql-context/config', async (req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Configuration must be a JSON object' });
    }
    try {
      const config = await deps.mcpManager.updateSqlContextConfig(req.body);
      const server = await deps.mcpManager.getServer('sql-context');
      res.json({ config, server: publicServer(server) });
    } catch (error: any) {
      res.status(400).json({ error: error?.message ?? String(error) });
    }
  });

  router.post('/mcp/sql-context/test', async (_req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    try {
      const result = await deps.mcpManager.testConnection('sql-context');
      const server = await deps.mcpManager.getServer('sql-context');
      res.status(result.isError ? 502 : 200).json({ result, server: publicServer(server) });
    } catch (error: any) {
      const server = await deps.mcpManager.getServer('sql-context').catch(() => null);
      res.status(502).json({ error: error?.message ?? String(error), server: publicServer(server) });
    }
  });

  router.post('/mcp/servers/:id/restart', async (req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    const serverId = paramStr(req.params.id);
    const registered = getBuiltInMcpProfile(serverId);
    if (registered && !registered.policy.allowGenericRestart) {
      return res.status(403).json({ error: `Use the fixed ${registered.shortName} start and stop actions` });
    }
    try {
      const server = await deps.mcpManager.restart(serverId);
      res.json({ server: publicServer(server) });
    } catch (error: any) {
      res.status(400).json({ error: error?.message ?? String(error) });
    }
  });

  // A generic native call surface for every managed connection. McpManager
  // remains the policy boundary: reads run freely, write-classified tools
  // require the explicit ownerRequested flag from the local caller, and every
  // call is audited.
  router.post('/mcp/servers/:id/tools/:tool', async (req: Request, res: Response) => {
    if (!deps.mcpManager) return res.status(503).json({ error: 'Managed MCP runtime is unavailable' });
    if (!acceptsLoopbackRequest(req, res)) return;
    if (!acceptsJsonObjectBody(req, res)) return;
    const serverId = paramStr(req.params.id);
    const registered = getBuiltInMcpProfile(serverId);
    if (registered && !registered.policy.allowGenericToolCalls) {
      return res.status(403).json({ error: `${registered.shortName} data tools are not enabled in this release` });
    }
    const args = req.body?.arguments ?? {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return res.status(400).json({ error: 'arguments must be an object' });
    }
    try {
      const result = await deps.mcpManager.callTool(
        serverId,
        paramStr(req.params.tool),
        args,
        { source: 'api', ownerApproved: req.body?.ownerRequested === true },
      );
      res.status(result.isError ? 502 : 200).json({ result });
    } catch (error: any) {
      const message = error?.message ?? String(error);
      res.status(/explicit owner request/i.test(message) ? 403 : 400).json({ error: message });
    }
  });

  return router;
}
