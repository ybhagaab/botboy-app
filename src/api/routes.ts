/**
 * REST API — composition root for the Local App's Express routes.
 *
 * Each domain lives in its own router under ./routers/ and receives the same
 * `RouterDeps` object. Domain paths are disjoint at their complete route
 * patterns (the analytics dashboard and data-room routers intentionally share
 * `/analytics` only as a namespace), so mount order below cannot change
 * matching; order-sensitive registrations live *within* a single module
 * (see routers/nodes.ts and routers/files.ts).
 */

import { Router } from 'express';
import type { RouterDeps } from './routers/deps.js';
import { createPipelineRouter } from './routers/pipeline.js';
import { createNodesRouter } from './routers/nodes.js';
import { createItemsRouter } from './routers/items.js';
import { createChatRouter } from './routers/chat.js';
import { createDashboardRouter, createDashboardState } from './routers/dashboard.js';
import { createFilesRouter } from './routers/files.js';
import { createAgentRouter } from './routers/agent.js';
import { createSlackRouter } from './routers/slack.js';
import { createLocalFoldersRouter } from './routers/local-folders.js';
import { createGraspSyncRouter } from './routers/grasp-sync.js';
import { createGmailSyncRouter } from './routers/gmail-sync.js';
import { createSharePointSyncRouter } from './routers/sharepoint-sync.js';
import { createMcpRouter } from './routers/mcp.js';
import { createAnalyticsRouter } from './routers/analytics.js';
import { createAnalyticsDataRoomRouter } from './routers/analytics-data-room.js';
import { createAnalyticsImportInboxRouter } from './routers/analytics-import-inbox.js';
import { createLessonsRouter } from './routers/lessons.js';
import { createWorkspaceRouter } from './routers/workspace.js';
import { createProductDocumentsRouter } from './routers/product-documents.js';
import { createDocumentsRouter } from './routers/documents.js';
import { createVisualAssetsRouter } from './routers/visual-assets.js';
import { createLlmUsageRouter } from './routers/llm-usage.js';
import { createAiModelRouter } from './routers/ai-model.js';
import { createCaptureHealthRouter } from './routers/capture-health.js';

export type { RouterDeps } from './routers/deps.js';

export function createRouter(deps: RouterDeps): Router {
  const router = Router();

  // Shared monotonic refresh counter: bumped by /dashboard/refresh and
  // /chat/agent-message, polled by the UI via /dashboard/version.
  const dashboardState = createDashboardState();

  router.use(createPipelineRouter(deps));
  router.use(createNodesRouter(deps));
  router.use(createItemsRouter(deps));
  router.use(createChatRouter(deps, dashboardState));
  router.use(createDashboardRouter(
    dashboardState,
    deps.db,
    deps.chatTerminal,
    deps.aiModelSettings
      ? () => ({ version: deps.aiModelSettings!.version(), state: deps.aiModelSettings!.state() })
      : undefined,
    deps.captureHealth
      ? () => ({ version: deps.captureHealth!.version(), issues: deps.captureHealth!.issues().length })
      : undefined,
  ));
  router.use(createCaptureHealthRouter(deps));
  router.use(createFilesRouter(deps));
  router.use(createAgentRouter(deps));
  router.use(createSlackRouter(deps));
  router.use(createLocalFoldersRouter(deps));
  router.use(createGraspSyncRouter(deps));
  router.use(createGmailSyncRouter(deps));
  router.use(createSharePointSyncRouter(deps));
  router.use(createMcpRouter(deps));
  router.use(createAnalyticsRouter(deps, dashboardState));
  router.use(createAnalyticsDataRoomRouter(deps));
  router.use(createAnalyticsImportInboxRouter(deps));
  router.use(createLessonsRouter(deps));
  router.use(createWorkspaceRouter(deps));
  router.use(createProductDocumentsRouter(deps));
  router.use(createVisualAssetsRouter(deps));
  router.use(createLlmUsageRouter(deps));
  router.use(createAiModelRouter(deps));
  // Workbench paths (/projects/:id/documents, /documents/*) are disjoint from
  // /product-documents — the writing workspace stays untouched.
  router.use(createDocumentsRouter(deps));

  return router;
}
