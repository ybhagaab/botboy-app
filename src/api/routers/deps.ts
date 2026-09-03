/**
 * Shared dependency contract for all API sub-routers.
 *
 * `createRouter` (routes.ts) receives one `RouterDeps` object from index.ts
 * and passes it to every domain router. Everything except `nodeManager` is
 * optional — routers degrade to 503/empty responses when a dep is absent,
 * which is what the HTTP tests rely on.
 */

import type Database from 'better-sqlite3';
import type { NodeManager } from '../../core/node-manager.js';
import type { ChatInterface } from '../../core/chat-interface.js';
import type { ScreenshotStore } from '../../core/screenshot-store.js';
import type { AgentOrchestrator } from '../../core/agent.js';
import type { BackgroundProcessor } from '../../core/background-processor.js';
import type { SlackMonitor } from '../../monitors/slack-monitor.js';
import type { FilesystemMonitor } from '../../monitors/filesystem-monitor.js';
import type { WebClient } from '@slack/web-api';
import type { FailureRecorder } from '../../core/failures.js';
import type { BrainStore } from '../../core/brain-store.js';
import type { PipelineOrchestrator } from '../../core/pipeline-orchestrator.js';
import type { ProjectRelationsEngine } from '../../core/project-relations.js';
import type { ChannelDigester } from '../../core/channel-digest.js';
import type { LlmClient } from '../../core/llm-client.js';
import type { ToolExecutor } from '../../core/tool-executor.js';
import type { PromptManager } from '../../core/prompt-manager.js';
import type { ConversationManager } from '../../core/conversation-manager.js';
import type { McpManager } from '../../core/mcp-types.js';
import type { GraspSync } from '../../monitors/grasp-sync.js';
import type { SharePointSync } from '../../monitors/sharepoint-sync.js';
import type { AnalyticsDashboardService, DashboardPublisherService } from '../../core/analytics-types.js';
import type { ProductDocumentService, WritingConfigStore } from '../../product-manager/types.js';
import type { ChatTerminalService } from '../../core/chat-terminal.js';
import type { ContentStore } from '../../core/content-store.js';
import type { DocumentParser } from '../../core/document-parser.js';
import type { EtlOnboardingService } from '../../core/etl-onboarding.js';

export interface RouterDeps {
  nodeManager: NodeManager;
  chatInterface?: ChatInterface;
  screenshotStore?: ScreenshotStore;
  agent?: AgentOrchestrator;
  backgroundProcessor?: BackgroundProcessor;
  slackMonitor?: SlackMonitor;
  slackWebClient?: WebClient;
  filesystemMonitor?: FilesystemMonitor;
  db?: Database.Database;
  failures?: FailureRecorder;
  brainStore?: BrainStore;
  pipelineOrchestrator?: PipelineOrchestrator;
  projectRelations?: ProjectRelationsEngine;
  channelDigester?: ChannelDigester;
  // Chat streaming loop deps (previously accessed via `(deps as any)`)
  llmClient?: LlmClient;
  toolExecutor?: ToolExecutor;
  promptManager?: PromptManager;
  conversationManager?: ConversationManager;
  mcpManager?: McpManager;
  graspSync?: GraspSync;
  sharePointSync?: SharePointSync;
  analyticsService?: AnalyticsDashboardService;
  dashboardPublisher?: DashboardPublisherService;
  productDocumentService?: ProductDocumentService;
  writingConfigStore?: WritingConfigStore;
  chatTerminal?: ChatTerminalService;
  /** Evidence content reads (document workbench reader). */
  contentStore?: ContentStore;
  /** Sheet-scoped xlsx deep reads (xlsx-deep-reads X1). */
  documentParser?: DocumentParser;
  /** ETL preset onboarding (etl-analytics A3): status + generate trigger. */
  etlOnboarding?: EtlOnboardingService;
}

/** Express 5 params can be string[]; normalize to a single string. */
export function paramStr(val: string | string[]): string {
  return Array.isArray(val) ? val[0] : val;
}

/** Rough prose-token estimate used for chat summary logging. */
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}
