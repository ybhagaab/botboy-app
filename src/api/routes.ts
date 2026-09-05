/**
 * REST API — composition root for the Local App's Express routes.
 *
 * Each domain lives in its own router under ./routers/ and receives the same
 * `RouterDeps` object. All route paths are prefix-disjoint across modules
 * (/pipeline, /nodes, /items+/search+/connections, /chat, /dashboard+/logs,
 * /files, /agent, /slack, /local-folders), so mount order below cannot change
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
import { createSharePointSyncRouter } from './routers/sharepoint-sync.js';
import { createMcpRouter } from './routers/mcp.js';
import { createAnalyticsRouter } from './routers/analytics.js';
import { createLessonsRouter } from './routers/lessons.js';
import { createWorkspaceRouter } from './routers/workspace.js';
import { createProductDocumentsRouter } from './routers/product-documents.js';
import { createDocumentsRouter } from './routers/documents.js';

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
  router.use(createDashboardRouter(dashboardState, deps.db, deps.chatTerminal));
  router.use(createFilesRouter(deps));
  router.use(createAgentRouter(deps));
  router.use(createSlackRouter(deps));
  router.use(createLocalFoldersRouter(deps));
  router.use(createGraspSyncRouter(deps));
  router.use(createSharePointSyncRouter(deps));
  router.use(createMcpRouter(deps));
  router.use(createAnalyticsRouter(deps));
  router.use(createLessonsRouter(deps));
  router.use(createWorkspaceRouter(deps));
  router.use(createProductDocumentsRouter(deps));
  // Workbench paths (/projects/:id/documents, /documents/*) are disjoint from
  // /product-documents — the writing workspace stays untouched.
  router.use(createDocumentsRouter(deps));

  return router;
}
