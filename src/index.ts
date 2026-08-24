/**
 * Personal Productivity Tracker — Main entry point.
 *
 * Wires all components together: monitors → event bus → dedup → classify → store.
 * Starts the Express API server and all background monitors.
 */

import express from 'express';
import http from 'node:http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createStorage } from './core/storage.js';
import { createMcpManager } from './core/mcp-manager.js';
import { createAnalyticsDashboardService } from './core/analytics-dashboard.js';
import { createAnalyticsScheduler } from './core/analytics-scheduler.js';
import { createDashboardPublisherService } from './core/analytics-publisher.js';
import { createNodeManager } from './core/node-manager.js';
import { createEventBus } from './core/event-bus.js';
import { createDeduplicator } from './core/deduplicator.js';
import { createEmbeddingProvider } from './core/embedding-provider.js';
import { createClassifier } from './core/classifier.js';
import { createScreenshotStore } from './core/screenshot-store.js';
import { createDocumentParser } from './core/document-parser.js';
import { createAcpClient } from './core/acp-client.js';
import { createInferenceProviderFromEnv } from './core/inference-provider.js';
import { createConversationManager } from './core/conversation-manager.js';
import { createPromptManager } from './core/prompt-manager.js';
import { createToolExecutor } from './core/tool-executor.js';
import { createChatInterface } from './core/chat-interface.js';
import { createMidwaySentinel } from './core/midway-sentinel.js';
import { createBrowserMonitor } from './monitors/browser-monitor.js';
import { createAppMonitor } from './monitors/app-monitor.js';
import { createClipboardMonitor } from './monitors/clipboard-monitor.js';
import { createSlackMonitor } from './monitors/slack-monitor.js';
import { loadEnv as loadSlackEnv } from './monitors/slack-monitor.js';
import { createFilesystemMonitor } from './monitors/filesystem-monitor.js';
import { createGraspSync, createBrowserEmailCaptureGate, isBrowserEmailItem } from './monitors/grasp-sync.js';
import { createRouter } from './api/routes.js';
import { createProfileRegistry } from './product-manager/profile-registry.js';
import { createWritingConfigStore } from './product-manager/writing-config.js';
import { createContextResolver } from './product-manager/context-resolver.js';
import { createGlossaryResolver } from './product-manager/glossary-resolver.js';
import { createSteBundleLoader } from './product-manager/ste-bundle.js';
import { createSteChecker } from './product-manager/ste-checker.js';
import { createDocumentValidator } from './product-manager/document-validator.js';
import { createProductDocumentService } from './product-manager/document-service.js';
import { createProductDocumentStore } from './product-manager/product-document-store.js';
import { withProductDocumentChatTools } from './product-manager/chat-tools.js';
import { createAgent } from './core/agent.js';
import type { AgentOrchestrator } from './core/agent.js';
import { createContextSync } from './core/context-sync.js';
import type { TieredContextManager } from './core/context-sync.js';
import type { BackgroundProcessor } from './core/background-processor.js';
import { v4 as uuid } from 'uuid';
import { createClassificationPipeline } from './core/classification-pipeline.js';
import { createSubagentDelegator } from './core/subagent-delegator.js';
import { createItemDeduplicator } from './core/item-deduplicator.js';
import { createDescriptionGenerator } from './core/description-generator.js';
import { createSubagentOrchestrator } from './core/subagent-orchestrator.js';
import { createBackgroundProcessor } from './core/background-processor.js';
import type { RawWorkItem } from './core/types.js';
import { generateFallbackSummary } from './core/summary-generator.js';
// ── lossless-capture-brain-pipeline ──
import { createContentStore, refToColumns } from './core/content-store.js';
import { createFailureRecorder } from './core/failures.js';
import { createVisionOcrEngine } from './core/ocr-engine.js';
import { createExtractor } from './core/extractor.js';
import { createBatcher } from './core/batcher.js';
import { createBrainStore } from './core/brain-store.js';
import { createLibrarian } from './core/librarian.js';
import { createBrainUpdater } from './core/brain-updater.js';
import { createReconciler } from './core/reconciler.js';
import { createProjectOrganizer } from './core/project-organizer.js';
import { createChannelDigester } from './core/channel-digest.js';
import { syncNodesFromProjects } from './core/node-projection.js';
import { createPipelineOrchestrator } from './core/pipeline-orchestrator.js';
import { createProjectRelationsEngine } from './core/project-relations.js';
import { adaptSendPrompt } from './core/pipeline-llm.js';
import { createBackfiller } from './core/backfill.js';
import { checkDependencies } from './core/deps-check.js';
import { initToolchain } from './core/toolchain.js';
import { createChatTerminalService } from './core/chat-terminal.js';
import { getSetting, setSetting } from './core/storage.js';
import { addLocalFolder, listLocalFolders } from './core/local-folders-config.js';
import { WebClient } from '@slack/web-api';
import { bootstrapFromEnv } from './core/slack-config.js';
import fs from 'fs';

const PORT = parseInt(process.env.PPT_PORT || '7778');
const HOST = process.env.PPT_HOST?.trim() || '127.0.0.1';

// Prevent unhandled rejections from crashing the process
process.on('unhandledRejection', (err: any) => {
  console.error('[UNHANDLED REJECTION]', err?.message || err);
});
process.on('uncaughtException', (err: any) => {
  console.error('[UNCAUGHT EXCEPTION]', err?.message || err);
});

/** Ensure the agent workspace has symlinks to the actual source code + config */
function ensureAgentWorkspace() {
  const home = process.env.HOME || '';
  const wsDir = path.join(home, '.personal-productivity-tracker', 'workspace');
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  // Ensure workspace dirs exist
  for (const d of [wsDir, path.join(wsDir, '.kiro', 'context'), path.join(wsDir, '.kiro', 'agents'), path.join(wsDir, '.productivity-agent')]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // Symlink src/ and dist/ so the agent can read/write code
  for (const dir of ['src', 'dist']) {
    const link = path.join(wsDir, dir);
    const target = path.join(projectDir, dir);
    try {
      const existing = fs.readlinkSync(link);
      if (existing !== target) { fs.unlinkSync(link); fs.symlinkSync(target, link); }
    } catch {
      try { fs.unlinkSync(link); } catch {}
      try { fs.symlinkSync(target, link); } catch (e) { console.warn(`⚠️  Could not symlink ${dir}:`, (e as Error).message); }
    }
  }

  // Copy SYSTEM.md and agent config to workspace if source is newer
  const copies: [string, string][] = [
    [path.join(projectDir, '.kiro', 'context', 'SYSTEM.md'), path.join(wsDir, '.kiro', 'context', 'SYSTEM.md')],
    [path.join(projectDir, '.kiro', 'agents', 'ppt-agent.json'), path.join(wsDir, '.kiro', 'agents', 'ppt-agent.json')],
    [path.join(projectDir, '.kiro', 'agents', 'ppt-agent.json'), path.join(home, '.kiro', 'cli-agents', 'ppt-agent.json')],
    [path.join(projectDir, '..', '.kiro', 'settings', 'mcp.json'), path.join(wsDir, '.kiro', 'settings', 'mcp.json')],
  ];
  for (const [src, dst] of copies) {
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const srcStat = fs.statSync(src);
      let dstMtime = 0;
      try { dstMtime = fs.statSync(dst).mtimeMs; } catch {}
      if (srcStat.mtimeMs > dstMtime) fs.copyFileSync(src, dst);
    } catch {}
  }

  console.log('✅ Agent workspace ready (symlinks + config synced)');
}

// Shown while initialization runs. Self-contained (no static assets — those
// are wired up only after init) and self-recovering: it polls the version
// endpoint and reloads itself into the real dashboard the moment the app is
// ready. This page existing at all is what kills the "connection refused"
// startup window.
const BOOT_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>BotBoy — starting</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin:0; display:grid; place-items:center; min-height:100vh; background:#101014; color:#e8e6f2; font:15px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; }
  main { text-align:center; padding:32px; }
  .spin { width:34px; height:34px; margin:0 auto 18px; border:3px solid #2c2b36; border-top-color:#9d8cff; border-radius:50%; animation:r 0.9s linear infinite; }
  @keyframes r { to { transform:rotate(360deg); } }
  h1 { margin:0 0 6px; font-size:19px; font-weight:650; }
  p { margin:0; color:#8b8996; font-size:13px; }
</style></head>
<body><main>
  <div class="spin" aria-hidden="true"></div>
  <h1>BotBoy is starting</h1>
  <p>Connections and evidence stores are warming up — this page refreshes itself.<br><span id="t">0</span>s elapsed</p>
</main>
<script>
  const started = Date.now();
  setInterval(() => { document.getElementById('t').textContent = Math.round((Date.now() - started) / 1000); }, 1000);
  (async function poll() {
    try {
      const res = await fetch('/api/dashboard/version', { cache: 'no-store' });
      if (res.ok) { location.reload(); return; }
    } catch {}
    setTimeout(poll, 1200);
  })();
</script></body></html>`;

async function main() {
  console.log('🔍 Personal Productivity Tracker starting...');

  // ── Early port bind ──
  // Full initialization (MCP child processes, projections, backfill) can take
  // 30s+, and the launcher opens the dashboard window early in that span.
  // Binding the port FIRST means the window always finds a listener: it shows
  // the boot page instead of Chrome's connection-refused error (which never
  // recovers on its own), and the launcher's health check passes immediately
  // instead of racing a 20-second timeout against MCP startup.
  const bootStartedAt = Date.now();
  const bootHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if ((req.url ?? '').startsWith('/api/')) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ booting: true, uptimeMs: Date.now() - bootStartedAt }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(BOOT_PAGE_HTML);
  };
  const httpServer = http.createServer(bootHandler);
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(PORT, HOST, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });
  console.log(`✅ Port ${PORT} bound — boot page live while initialization continues`);

  // ── Storage ──
  const storage = createStorage();
  storage.initialize();
  const db = storage.getDb();

  console.log('✅ Database initialized');

  // ── Toolchain discovery ──
  // Resolve every external CLI tool BotBoy shells out to, persist the map,
  // and extend PATH so all child processes (run_command, parsers, OCR, MCP
  // launches) find their tools even when launched with a minimal PATH.
  try {
    const toolchain = await initToolchain(db);
    const found = toolchain.tools.filter((t) => t.path).length;
    const missingRequired = toolchain.tools.filter((t) => !t.path && t.requirement === 'required');
    console.log(
      `✅ Toolchain: ${found}/${toolchain.tools.length} tools resolved` +
        (toolchain.pathAdditions.length ? `, PATH += ${toolchain.pathAdditions.length} dir(s)` : ''),
    );
    if (missingRequired.length > 0) {
      console.warn(
        `⚠️  Missing required tools: ${missingRequired
          .map((t) => `${t.name} (${t.brewFormula ? `brew install ${t.brewFormula}` : t.installHint || 'see README'})`)
          .join(', ')} — run "npm run setup"`,
      );
    }
  } catch (e: any) {
    console.error(`⚠️  Toolchain discovery failed: ${e?.message ?? e}`);
  }

  // ── Native managed MCP runtime ──
  // Server commands and package details are built into BotBoy; only curated,
  // non-secret connection settings are persisted. Direct passwords live in
  // Supervised background startup (owner decision 2026-08-23): capture and
  // connection subsystems must not block the dashboard. Each task runs
  // detached but WATCHED — completion is logged with its duration, and an
  // outright crash of the startup task is logged AND posted into chat so it
  // can never fail silently. Subsystem-level failures already have their own
  // surfaces: MCP profile states land in mcp_servers with backoff restarts
  // (connection cards + mcp_status + the Midway sentinel), and Slack capture
  // self-heals on its 90s poll with its connected flag on the capture card.
  const startInBackground = (subsystem: string, task: () => Promise<void>, onReady: string) => {
    const startedAt = Date.now();
    void task().then(
      () => console.log(`${onReady} (${((Date.now() - startedAt) / 1000).toFixed(1)}s, background)`),
      (error: any) => {
        const detail = String(error?.message ?? error).slice(0, 300);
        console.error(`❌ ${subsystem} background startup failed: ${detail}`);
        try {
          const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          db.prepare('INSERT INTO chat_messages (id, role, content) VALUES (?, ?, ?)').run(
            id,
            'assistant',
            `⚠️ ${subsystem} did not start with the app (${detail}). The dashboard keeps working; check the Connections page or ask me to run a diagnosis.`,
          );
        } catch {}
      },
    );
  };

  // macOS Keychain through McpManager's secret store.
  const mcpManager = createMcpManager({ db });
  startInBackground('Managed MCP runtime', () => mcpManager.start(), '✅ Managed MCP runtime initialized');

  // Dashboards remain canonical in local SQLite. MCP query results are
  // persisted through this single service for API, agent, and scheduler use.
  const analyticsService = createAnalyticsDashboardService({ db, mcpManager });
  const dashboardPublisher = createDashboardPublisherService({ db, analyticsService });
  const analyticsScheduler = createAnalyticsScheduler({ db, analyticsService });

  // ── Agent workspace setup (symlinks, config sync) ──
  ensureAgentWorkspace();

  // ── Core components ──
  const nodeManager = createNodeManager(db);
  const eventBus = createEventBus();
  const dedup = createDeduplicator();
  const screenshotStore = createScreenshotStore();
  const documentParser = createDocumentParser();

  // ── Shared inference provider ──
  // One provider creates the single client used by chat, rolling summaries,
  // project routing, brain synthesis, reconciliation, organization, and the
  // optional legacy generative paths. Direct Bedrock is the current provider;
  // the future OIDC/JWT gateway plugs in here without changing consumers.
  // Shell settings override the documented local dotenv-style file.
  const localEnvFile = loadSlackEnv();
  const inferenceProvider = createInferenceProviderFromEnv({
    ...localEnvFile,
    ...process.env,
  });
  // limits.ts is intentionally dependency-light and reads this normalized
  // process value. Publish the provider's resolved value so settings loaded
  // from the local dotenv file cannot diverge from tool/prompt safety limits.
  process.env.BOTBOY_INFERENCE_MAX_CONTEXT_TOKENS = String(inferenceProvider.maxContextTokens);
  const llmClient = inferenceProvider.createClient();
  await llmClient.healthCheck().catch(() => {});
  console.log(
    `✅ LLM client ready (provider: ${inferenceProvider.id}, model: ${inferenceProvider.model}, active: ${llmClient.getActiveEndpoint()})`,
  );
  if (inferenceProvider.localFallbackEnabled) {
    console.warn('⚠️  Local LLM fallback is enabled; background output may use a different model when the primary provider is unavailable.');
  }

  // ── Conversation Manager + Prompt Manager + Tool Executor ──
  const conversationManager = createConversationManager(db);
  const promptManager = createPromptManager();

  // ── Native product-manager writing system ──
  const profileRegistry = createProfileRegistry();
  const writingConfigStore = createWritingConfigStore(db);
  const writingContextResolver = createContextResolver(documentParser);
  const glossaryResolver = createGlossaryResolver();
  const steBundleLoader = createSteBundleLoader();
  const steChecker = createSteChecker();
  const productDocumentValidator = createDocumentValidator({
    registry: profileRegistry,
    steChecker,
    steBundleLoader,
  });
  const productDocumentStore = createProductDocumentStore(db);
  const productDocumentService = createProductDocumentService({
    llmClient,
    promptManager,
    registry: profileRegistry,
    configStore: writingConfigStore,
    contextResolver: writingContextResolver,
    glossaryResolver,
    validator: productDocumentValidator,
    steBundleLoader,
    store: productDocumentStore,
  });
  const steReadiness = steBundleLoader.load();
  console.log(
    `✅ Product-manager writing system ready (${profileRegistry.listProfiles().length} profiles; STE bundle: ${steReadiness.ready ? 'approved' : steReadiness.available ? 'pending or invalid' : 'missing'})`,
  );

  // Brain store is created early so the chat agent's domain tools can read
  // and edit project brains through the same guarded path the UI uses.
  const brainStore = createBrainStore(db);
  // Chat-embedded interactive terminal: agent opens sessions as tool calls,
  // the user types/authenticates in the chat dock, output never persists.
  const chatTerminal = createChatTerminalService();
  // When a session ends and no agent turn is watching it (the turn already
  // finished), surface completion into chat so the outcome is never silent.
  // The chat UI picks the message up on its regular history poll.
  chatTerminal.setUnattendedEndListener((ended) => {
    try {
      const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const exit = ended.exitCode !== null ? ` (exit code ${ended.exitCode})` : '';
      const text = `🖥️ Terminal update: “${ended.title}” ended with status **${ended.status}**${exit}. Ask me to check the result if you want it verified.`;
      db.prepare('INSERT INTO chat_messages (id, role, content) VALUES (?, ?, ?)').run(id, 'assistant', text);
    } catch (e: any) {
      console.warn(`[ChatTerminal] Could not post session-end notification: ${e?.message ?? e}`);
    }
  });
  const baseToolExecutor = createToolExecutor(db, nodeManager, {
    brainStore,
    mcpManager,
    analyticsService,
    dashboardPublisher,
    chatTerminal,
  });
  const toolExecutor = withProductDocumentChatTools(baseToolExecutor, productDocumentService);

  // Backward-compat: llmClient implements sendPrompt() for components not yet migrated
  const acpClient = llmClient; // alias — same interface

  // ── Legacy classification plane (retired from the hot path, July 2026) ──
  // Embedding classifier, L0/L1/L2 context files, item dedup, node descriptions
  // and the background processor were replaced by the lossless pipeline below.
  // Set PPT_LEGACY=1 to construct them again (this re-enables the manual
  // /api/agent/background/run endpoint and the context-file auto-sync timer).
  const legacyEnabled = process.env.PPT_LEGACY === '1';
  let contextManager: TieredContextManager | undefined;
  let backgroundProcessor: BackgroundProcessor | undefined;
  let agent: AgentOrchestrator;
  if (legacyEnabled) {
    const embedder = createEmbeddingProvider();
    const classifier = createClassifier(db, embedder);
    const contextDir = path.join(process.env.HOME || '', '.personal-productivity-tracker', 'workspace', '.kiro', 'context');
    contextManager = createContextSync(db, nodeManager, contextDir);
    const pipeline = createClassificationPipeline(classifier, acpClient, contextManager);
    const delegator = createSubagentDelegator(acpClient);
    agent = createAgent(db, acpClient, nodeManager, contextManager, pipeline, delegator, llmClient, toolExecutor, promptManager, mcpManager);
    contextManager.startAutoSync(30000);
    const itemDeduplicator = createItemDeduplicator(db, acpClient);
    const descriptionGenerator = createDescriptionGenerator(acpClient, nodeManager);
    const subagentOrchestrator = createSubagentOrchestrator(db, acpClient, nodeManager, contextManager);
    backgroundProcessor = createBackgroundProcessor({
      db, acpClient, nodeManager,
      orchestrator: subagentOrchestrator,
      contextManager, deduplicator: itemDeduplicator,
      descriptionGenerator,
    });
    console.log('✅ Legacy plane active (embedding classifier, context sync, background processor)');
  } else {
    // Chat/tool-loop agent only — no embedding classifier, no context timer.
    agent = createAgent(db, acpClient, nodeManager, undefined, undefined, undefined, llmClient, toolExecutor, promptManager, mcpManager);
    console.log('ℹ️  Legacy classification plane disabled (set PPT_LEGACY=1 to enable)');
  }
  const chatInterface = createChatInterface(db, agent);
  // Midway sentinel: when a Midway-backed MCP (Slack, GRASP, AIM customs)
  // fails and the local session cookie is expired, it notifies the owner in
  // chat, opens mwinit in the chat terminal, and restarts the affected
  // profiles after re-auth. Disable with PPT_MIDWAY_SENTINEL=0.
  const midwaySentinel = createMidwaySentinel(
    { db, mcpManager, chatTerminal, agent },
    // Cookie-path override for testing the flow without touching the real jar.
    process.env.PPT_MIDWAY_COOKIE_PATH ? { cookiePath: process.env.PPT_MIDWAY_COOKIE_PATH } : {},
  );

  // ── lossless-capture-brain-pipeline: evidence + interpretation planes ──
  const contentStore = createContentStore(db);
  const failures = createFailureRecorder(db);
  const ocrEngine = createVisionOcrEngine();
  const extractor = createExtractor({ db, documentParser, ocrEngine, contentStore, failures });
  const batcher = createBatcher(db);
  const pipelineLlm = adaptSendPrompt(llmClient, {
    provider: inferenceProvider.id,
    model: inferenceProvider.model,
    temperature: 0.7,
  });
  const librarian = createLibrarian({ db, batcher, contentStore, brainStore, failures, llm: pipelineLlm });
  const brainUpdater = createBrainUpdater({ db, contentStore, brainStore, failures, llm: pipelineLlm });
  const reconciler = createReconciler({ db, batcher, contentStore, brainStore, failures, llm: pipelineLlm });
  const projectOrganizer = createProjectOrganizer({ db, brainStore, llm: pipelineLlm, failures });
  const channelDigester = createChannelDigester({ db, contentStore, brainStore, failures, llm: pipelineLlm });
  const projectRelations = createProjectRelationsEngine(db);
  const pipelineOrchestrator = createPipelineOrchestrator({ db, extractor, batcher, librarian, brainUpdater, reconciler, organizer: projectOrganizer, digester: channelDigester, brainStore, projectRelations });
  // Sibling links are derived data — refresh once at startup so the project
  // pages are current even before the first interpretation wave fires.
  try {
    const relations = projectRelations.recompute();
    console.log(`✅ Related projects: ${relations.pairs} sibling pair(s) detected`);
  } catch (e: any) {
    console.error(`⚠️  Related-projects pass failed: ${e?.message ?? e}`);
  }
  // Mirror existing areas/projects into the dashboard's node tree at startup so
  // the home dashboard shows the current organization immediately.
  try {
    const proj = syncNodesFromProjects(db);
    console.log(`✅ Node projection: ${proj.areaNodes} area node(s), ${proj.projectNodes} project node(s), ${proj.itemLinks} item links`);
  } catch (e: any) {
    console.error(`⚠️  Node projection failed: ${e?.message ?? e}`);
  }

  // One-time (idempotent) migration of legacy items into the lossless model.
  try {
    const bf = createBackfiller({ db, contentStore, brainStore, failures }).run();
    console.log(`✅ Backfill: migrated ${bf.itemsMigrated}, seeded ${bf.projectsSeeded} project(s), flagged ${bf.itemsFlaggedPartial} legacy-partial`);
  } catch (e: any) {
    console.error(`⚠️  Backfill failed: ${e?.message ?? e}`);
  }

  // Verify local extraction dependencies (never silently degrade — R13.4/R13.5).
  const deps = checkDependencies();
  if (!deps.ok) console.warn(`⚠️  ${deps.message}`);
  else console.log('✅ Local extraction dependencies available (parsing + OCR)');

  // ── Pipeline: event bus → dedup → classify → store ──
  eventBus.on(async (item: RawWorkItem) => {
    try {
    // Dedup check (in-memory for Slack cross-platform)
    if (dedup.isDuplicate(item)) return;
    dedup.register(item);

    // DB-level dedup for clipboard: skip if same content_hash exists in last hour.
    // captured_at is stored as ISO-8601 (`T`/`Z`), so normalize it before
    // comparing with SQLite's space-separated datetime() output. A lexical
    // comparison incorrectly treated any same-day ISO timestamp as recent.
    const contentHash = item.content ? Buffer.from(item.content).toString('base64').slice(0, 32) : null;
    if (contentHash && item.type === 'clipboard_capture') {
      const existing = db.prepare(
        `SELECT id FROM work_items WHERE content_hash = ? AND datetime(captured_at) > datetime('now', '-1 hour') LIMIT 1`
      ).get(contentHash);
      if (existing) return;
    }

    // Store work item
    const id = uuid();

    // URL-based dedup: if same URL captured in last 2 hours, ENRICH the
    // existing row instead of creating a duplicate. The old path only touched
    // parsed_text (capped at 10K) — a clipboard capture of a URL would then
    // permanently swallow the real page visit's full content (post-mortem
    // 2026-08-05: Pippin doc never landed). Now richer content refreshes the
    // lossless content columns + FTS and re-queues interpretation.
    if (item.url) {
      const existing = db.prepare(
        `SELECT id, title, type, source, source_app, content_bytes, metadata,
                process_state, project_id, batch_id
         FROM work_items
         WHERE url = ? AND datetime(captured_at) > datetime('now', '-2 hours')
         ORDER BY datetime(captured_at) DESC LIMIT 1`
      ).get(item.url) as any;
      if (existing) {
        // Terminal/assigned rows, valid retries of failed routing, and rows
        // currently being interpreted must not be mutated in place. A fresh
        // observation prevents stale model decisions from being applied to
        // changed evidence and gives route failures a normal retry path.
        const hasRouteRetryContent = existing.process_state === 'route_failed'
          && Boolean(item.content?.trim());
        const isInFlight = existing.process_state === 'extracted' && existing.batch_id != null;
        const canEnrichInPlace = existing.project_id == null
          && existing.process_state !== 'routed'
          && existing.process_state !== 'noise'
          && !hasRouteRetryContent
          && !isInFlight;
        if (canEnrichInPlace) {
          const newContent = item.content ?? '';
          const newContentBytes = Buffer.byteLength(newContent, 'utf8');
          const contentIsRicher = newContentBytes > (existing.content_bytes ?? 0);
          const hasUsableContent = newContent.trim().length > 0;
          const promotesSpecificType = hasUsableContent && (
            (existing.type === 'clipboard_capture' && item.type !== 'clipboard_capture')
            || (
              existing.source === 'browser'
              && item.source === 'browser'
              && (existing.type === 'website_visit' || existing.type === 'generic_browser')
              && item.type !== 'website_visit'
              && item.type !== 'generic_browser'
            )
          );
          // A real browser body is authoritative over a copied URL even when
          // it is shorter. Otherwise the row would be relabeled as a browser
          // capture while its primary content and FTS body remained the URL.
          const shouldReplacePrimary = contentIsRicher || promotesSpecificType;
          const newTitle = item.title && (!existing.title || promotesSpecificType) ? item.title : existing.title;
          const newType = promotesSpecificType ? item.type : existing.type;

          let persistedMeta: Record<string, unknown> = {};
          try { persistedMeta = JSON.parse(existing.metadata || '{}'); } catch {}
          const incomingMeta = { ...(item.metadata ?? {}) } as Record<string, unknown>;
          // Storage references are owned by ContentStore, never by monitor
          // metadata. Keep the persisted refs until a verified write succeeds.
          delete incomingMeta.rawHtml;
          delete incomingMeta.rawHtmlHistory;
          const meta: Record<string, unknown> = { ...persistedMeta, ...incomingMeta };
          let rawHtmlStored = false;

          // Keep the largest available HTML artifact, even when readable text
          // is not longer. Version replacement files so a failed DB update can
          // never leave the prior metadata hash pointing at overwritten bytes.
          if (item.rawHtml) {
            const previousRawHtml = persistedMeta.rawHtml && typeof persistedMeta.rawHtml === 'object'
              ? persistedMeta.rawHtml as { path?: unknown; sha256?: unknown; bytes?: unknown }
              : null;
            const previousBytes = typeof previousRawHtml?.bytes === 'number' ? previousRawHtml.bytes : -1;
            const previousRefExists = typeof previousRawHtml?.path === 'string'
              && typeof previousRawHtml?.sha256 === 'string'
              && previousBytes >= 0
              && fs.existsSync(previousRawHtml.path);
            const rawHtmlBytes = Buffer.byteLength(item.rawHtml, 'utf8');
            if (!previousRefExists || rawHtmlBytes > previousBytes) {
              try {
                const auxRef = contentStore.putAux(existing.id, `html-${uuid()}`, item.rawHtml);
                if (previousRawHtml) {
                  const history = Array.isArray(persistedMeta.rawHtmlHistory)
                    ? [...persistedMeta.rawHtmlHistory]
                    : [];
                  const previousSha = previousRawHtml.sha256;
                  if (!history.some((ref: any) => ref && ref.sha256 === previousSha)) {
                    history.push(previousRawHtml);
                  }
                  meta.rawHtmlHistory = history;
                }
                meta.rawHtml = { path: auxRef.filePath, sha256: auxRef.sha256, bytes: auxRef.byteLength };
                rawHtmlStored = true;
              } catch (e: any) { console.warn(`[Capture] raw html store failed: ${e?.message ?? e}`); }
            }
          }

          const requeuePrimary = shouldReplacePrimary
            && (
              existing.process_state === 'orphaned'
              || existing.process_state === 'extract_failed'
              || existing.process_state === 'route_failed'
            );
          const nextProcessState = requeuePrimary ? 'extracted' : existing.process_state;
          const nextBatchId = requeuePrimary ? null : existing.batch_id;

          if (shouldReplacePrimary) {
            // Use a versioned item key for file-backed replacements. The old
            // content remains checksum-valid if the subsequent DB update fails.
            const newRef = contentStore.put(`${existing.id}-${uuid()}`, newContent);
            const newCols = refToColumns(newRef);
            const updatePrimary = db.prepare(`
              UPDATE work_items SET title = ?, type = ?, source = ?, source_app = ?, content_hash = ?,
                summary = CASE WHEN ? THEN ? ELSE summary END,
                raw_text = ?, content_storage = ?, content_path = ?, content_sha256 = ?, content_bytes = ?,
                parsed_text = ?, metadata = ?, captured_at = ?, process_state = ?, batch_id = ?
              WHERE id = ?
            `);
            // Keep primary content and FTS all-or-nothing. If FTS is
            // unavailable, the previous DB representation remains intact and
            // the versioned content file is merely an unreferenced artifact.
            db.transaction(() => {
              updatePrimary.run(
                newTitle, newType,
                promotesSpecificType ? item.source : existing.source,
                promotesSpecificType ? item.sourceApp : existing.source_app,
                contentHash,
                promotesSpecificType ? 1 : 0,
                promotesSpecificType ? generateFallbackSummary(item) : null,
                newCols.raw_text, newCols.content_storage, newCols.content_path, newCols.content_sha256, newCols.content_bytes,
                newContent.slice(0, 15000), JSON.stringify(meta), item.capturedAt.toISOString(),
                nextProcessState, nextBatchId, existing.id,
              );
              db.prepare('DELETE FROM work_items_fts WHERE item_id = ?').run(existing.id);
              db.prepare('INSERT INTO work_items_fts (item_id, title, body) VALUES (?, ?, ?)')
                .run(existing.id, newTitle ?? '', newContent);
            })();
          } else if (rawHtmlStored) {
            // Preserve the richer primary text and lifecycle while attaching
            // the newly available, versioned auxiliary evidence.
            const updateMetadata = () => db.prepare(`
              UPDATE work_items SET title = ?, metadata = ?, captured_at = ?,
                process_state = ?, batch_id = ?
              WHERE id = ?
            `).run(
              newTitle, JSON.stringify(meta), item.capturedAt.toISOString(),
              nextProcessState, nextBatchId, existing.id,
            );
            if (newTitle !== existing.title) {
              db.transaction(() => {
                updateMetadata();
                db.prepare('UPDATE work_items_fts SET title = ? WHERE item_id = ?')
                  .run(newTitle ?? '', existing.id);
              })();
            } else {
              updateMetadata();
            }
          }
          return; // Skip creating a duplicate when in-place enrichment is safe.
        }
      }
    }

    // For emails: extract subject and sender from content to build a proper title
    let title = item.title ?? null;
    const content = item.content ?? '';
    // Browser-only repair: Outlook web scrapes often title as "Navigation
    // pane". Canonical GRASP mail arrives with correct title + metadata and
    // must not have its sender/subject overwritten from content lines.
    if (item.type === 'email_read' && item.source === 'browser' && content) {
      // Outlook often captures "Navigation pane" as title — fix from content
      const subjectMatch = content.match(/^Subject:\s*(.+)$/m);
      const fromMatch = content.match(/^From:\s*(.+)$/m);
      const realSubject = subjectMatch?.[1]?.trim();
      const sender = fromMatch?.[1]?.trim();

      // If Subject line is "Navigation pane" or generic, use From line as subject
      if (realSubject && !/^navigation pane$/i.test(realSubject)) {
        title = realSubject;
      } else if (sender) {
        title = sender;
      }

      // Build a summary from the email content if we don't have one
      if (!item.metadata?.summary && content.length > 50) {
        const lines = content.split('\n').filter(l => l.trim());
        const bodyStart = lines.findIndex(l => !l.startsWith('Subject:') && !l.startsWith('From:') && l.trim().length > 10);
        if (bodyStart >= 0) {
          const bodyPreview = lines.slice(bodyStart, bodyStart + 5).join(' ').slice(0, 300);
          item.metadata = { ...item.metadata, emailPreview: bodyPreview, sender: sender || '', subject: title || '' };
        }
      }
    }

    try {
      // Lossless storage: the FULL captured content goes into the ContentStore
      // (inline or blob), never truncated. `summary` is a short derived preview
      // only. Items needing local extraction (parse/OCR of a source file/image)
      // start as 'captured'; items whose text is already captured are 'extracted'
      // and immediately eligible for the librarian.
      const needsExtraction = Boolean(
        item.screenshotPath ||
        (item.url && item.url.startsWith('file://')) ||
        (item.metadata && typeof (item.metadata as any).filePath === 'string'),
      );
      const ref = contentStore.put(id, content);
      const cols = refToColumns(ref);
      const preview = content.slice(0, 500) || generateFallbackSummary(item);

      // Raw page HTML (browser captures): stored losslessly as an auxiliary
      // blob, referenced from metadata. The readable text above remains the
      // FTS/interpretation body.
      const metadata: Record<string, unknown> = { ...item.metadata };
      if (item.rawHtml) {
        try {
          const auxRef = contentStore.putAux(id, 'html', item.rawHtml);
          metadata.rawHtml = { path: auxRef.filePath, sha256: auxRef.sha256, bytes: auxRef.byteLength };
        } catch (e: any) { console.warn(`[Capture] raw html store failed: ${e?.message ?? e}`); }
      }

      db.prepare(`
        INSERT INTO work_items (id, type, source, source_app, title, summary, url, file_path, content_hash, screenshot_path,
          raw_text, content_storage, content_path, content_sha256, content_bytes,
          metadata, captured_at, process_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, item.type, item.source, item.sourceApp,
        title, preview,
        item.url ?? null,
        typeof item.metadata?.filePath === 'string' ? item.metadata.filePath : null,
        contentHash,
        item.screenshotPath ?? null,
        cols.raw_text, cols.content_storage, cols.content_path, cols.content_sha256, cols.content_bytes,
        JSON.stringify(metadata), item.capturedAt.toISOString(),
        needsExtraction ? 'captured' : 'extracted',
      );

      // Full-text search index over title + full content (no prefix).
      try {
        db.prepare('INSERT INTO work_items_fts (item_id, title, body) VALUES (?, ?, ?)')
          .run(id, title ?? '', content);
      } catch { /* FTS is best-effort; failure here must not lose the item */ }
    } catch (dbErr: any) {
      failures.record({ itemId: id, step: 'capture', message: `insert failed: ${dbErr.message}`, retryable: true });
      console.error(`[DB] Insert failed for ${item.source}/${item.type}: ${dbErr.message}`);
      return; // Don't crash — skip this item
    }

    // NOTE: no per-item embedding here (R10.1 — removes the local hot loop).
    // Routing into projects happens in the batched interpretation passes.
    } catch (outerErr: any) {
      console.error(`[EventBus] Handler error for ${item.source}/${item.type}: ${outerErr.message}`);
    }
  });

  // ── Monitors ──
  const browserMonitor = createBrowserMonitor();
  // Once canonical GRASP mail sync is live, browser-scraped email is a noisier
  // duplicate of the same messages — suppress ALL browser email capture at the
  // emit boundary (GRASP plan §17.5; user directive 2026-08-18). Every other
  // browser capture passes through untouched, and disabling the sync restores
  // browser email capture.
  const graspMailSupersedesBrowser = createBrowserEmailCaptureGate(db);
  browserMonitor.onWorkItem(item => {
    if (isBrowserEmailItem(item) && graspMailSupersedesBrowser()) return;
    eventBus.emit(item);
  });

  const appMonitor = createAppMonitor();
  appMonitor.onWorkItem(item => eventBus.emit(item));

  const clipboardMonitor = createClipboardMonitor();
  clipboardMonitor.onWorkItem(item => eventBus.emit(item));

  // ── Slack channel-config bootstrap (one-shot migration from env → app_settings) ──
  // Build a Slack WebClient up front so both the bootstrap and the API router
  // (task 5.2) share the same instance. The user token comes from process.env
  // first, falling back to the dotenv-style file that slack-monitor reads.
  const slackEnvFile = localEnvFile;
  const slackUserToken = process.env.SLACK_USER_TOKEN || slackEnvFile.SLACK_USER_TOKEN || '';
  const slackWebClient: WebClient | undefined = slackUserToken ? new WebClient(slackUserToken) : undefined;
  const slackWatchedEnv = process.env.SLACK_WATCHED_CHANNELS || slackEnvFile.SLACK_WATCHED_CHANNELS;
  if (slackWebClient) {
    try {
      const result = await bootstrapFromEnv(db, slackWebClient, slackWatchedEnv);
      console.log(
        `✅ Slack channel config: ${
          result.seeded
            ? `seeded (${result.ids.length} channels)`
            : `existing (${result.ids.length} channels)`
        }`,
      );
    } catch (err: any) {
      console.error(`⚠️  Slack channel config bootstrap failed: ${err?.message ?? err}`);
    }
  } else {
    console.log('⚠️  Skipping Slack channel-config bootstrap (no SLACK_USER_TOKEN)');
  }

  const slackMonitor = createSlackMonitor({ db, mcpManager });
  slackMonitor.onWorkItem(item => eventBus.emit(item));
  // The first poll walks all watched conversations through rate-limited Slack
  // APIs (~48s measured) — by far the largest boot cost, and pure background
  // work: capture starting late only delays evidence, never loses it.
  startInBackground('Slack capture', () => slackMonitor.start(), '✅ Slack capture online');

  // ── Filesystem monitor (chokidar-backed local folder ingestion) ──
  const filesystemMonitor = createFilesystemMonitor({ db, documentParser });
  filesystemMonitor.onWorkItem(item => eventBus.emit(item));

  // R12.2: seed default watched folders (Downloads/Desktop/Documents) on first
  // run only, guarded by a flag so the user can later disable/remove them.
  if (!getSetting<boolean>(db, 'local_folders.defaults_seeded')) {
    for (const name of ['Downloads', 'Desktop', 'Documents']) {
      try { addLocalFolder(db, { path: path.join(process.env.HOME || '', name) }); } catch { /* missing/dupe */ }
    }
    setSetting(db, 'local_folders.defaults_seeded', true);
    console.log('✅ Seeded default watched folders (Downloads/Desktop/Documents)');
  }

  await filesystemMonitor.start();

  // ── GRASP background sync (canonical Outlook mail + calendar every 30 min) ──
  // Read-only MCP calls; emitted items flow through the same capture handler
  // as every monitor and reach brain synthesis on the interpretation tick.
  const graspSync = createGraspSync({ db, mcpManager, emit: item => eventBus.emit(item) });

  // R12.3: one-time ingestion of pre-existing files per enabled folder. A
  // persistent per-folder marker prevents re-flooding on every boot.
  for (const folder of listLocalFolders(db, { enabledOnly: true })) {
    const key = `local_folders.backfilled.${folder.id}`;
    if (getSetting<boolean>(db, key)) continue;
    filesystemMonitor
      .backfill(folder.id)
      .then(() => setSetting(db, key, true))
      .catch((err) => console.warn(`[fs] initial backfill failed for ${folder.path}:`, err?.message ?? err));
  }

  // ── Express API ──
  const app = express();
  app.use(express.json());
  const routerDeps = {
    nodeManager,
    chatInterface,
    screenshotStore,
    agent,
    backgroundProcessor,
    slackMonitor,
    slackWebClient,
    filesystemMonitor,
    db,
    llmClient,
    toolExecutor,
    promptManager,
    conversationManager,
    failures,
    brainStore,
    pipelineOrchestrator,
    projectRelations,
    channelDigester,
    mcpManager,
    graspSync,
    analyticsService,
    dashboardPublisher,
    productDocumentService,
    writingConfigStore,
    chatTerminal,
  };
  app.use('/api', createRouter(routerDeps));

  // Serve static UI files
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const uiDir = path.resolve(__dirname, 'ui');
  app.use(express.static(uiDir, { etag: false, lastModified: false, maxAge: 0 }));
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    next();
  });
  app.get('/', (_req, res) => {
    res.sendFile(path.join(uiDir, 'index.html'));
  });

  // Initialization is complete — swap the boot handler for the real app on
  // the already-bound listener. Open boot pages reload themselves into the
  // dashboard on their next poll.
  httpServer.removeListener('request', bootHandler);
  httpServer.on('request', app);
  analyticsScheduler.start();
  console.log('✅ Durable analytics scheduler initialized');
  console.log(`✅ API server running on http://${HOST}:${PORT} — dashboard ready in ${((Date.now() - bootStartedAt) / 1000).toFixed(1)}s`);

  // Start monitors
  await browserMonitor.start();
  appMonitor.start();
  clipboardMonitor.start();
  console.log('✅ All monitors active');

  // Start the lossless-capture interpretation pipeline (extract → librarian →
  // brain-update → reconcile). This replaces the legacy background-processor
  // timer on the hot path (R10); the old processor stays constructed only for
  // the manual /api/agent/background/run endpoint and is NOT auto-started.
  pipelineOrchestrator.start();
  console.log('✅ Lossless pipeline active (extraction + batched interpretation)');

  graspSync.start();
  console.log('✅ GRASP sync scheduled (Outlook mail + calendar every 30 min)');

  if (process.env.PPT_MIDWAY_SENTINEL !== '0') {
    midwaySentinel.start();
    console.log('✅ Midway sentinel active (auto re-auth flow for session-backed MCPs)');
  }

  console.log(`🔍 Tracking your activity. Dashboard: http://${HOST}:${PORT}`);

  // Use one guarded path for both terminal interrupts and process termination.
  // The MCP manager stops its child processes before local storage closes.
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      console.log(`\n🔍 Shutting down after ${signal}...`);
      graspSync.stop();
      pipelineOrchestrator.stop();
      analyticsScheduler.stop();
      const serverClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      backgroundProcessor?.stop();
      browserMonitor.stop();
      appMonitor.stop();
      clipboardMonitor.stop();
      slackMonitor.stop();
      await filesystemMonitor.stop().catch(() => {});
      contextManager?.stopAutoSync();
      midwaySentinel.stop();
      chatTerminal.shutdown();
      await mcpManager.stop().catch((error) => console.warn('[MCP] shutdown failed:', error?.message ?? error));
      await serverClosed;
      llmClient.close();
      conversationManager.pruneOldSessions();
      storage.close();
      process.exit(0);
    })();
    return shutdownPromise;
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
