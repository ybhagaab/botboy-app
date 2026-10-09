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
import type { AiModelSettingsService } from '../../core/ai-model-settings.js';
import type { LlmUsageService } from '../../core/llm-usage.js';
import type { ToolExecutor } from '../../core/tool-executor.js';
import type { PromptManager } from '../../core/prompt-manager.js';
import type { ConversationManager } from '../../core/conversation-manager.js';
import type { McpManager } from '../../core/mcp-types.js';
import type { GraspSync } from '../../monitors/grasp-sync.js';
import type { GmailSyncs } from '../../monitors/gmail-sync.js';
import type { GmailConnection } from '../../core/gmail-connection.js';
import type { GmailCompose } from '../../core/gmail-compose.js';
import type { SharePointSync } from '../../monitors/sharepoint-sync.js';
import type { AnalyticsDashboardService, DashboardPublisherService } from '../../core/analytics-types.js';
import type { AnalyticsScheduler } from '../../core/analytics-scheduler.js';
import type { AnalyticsDataRoomCatalogReader } from '../../core/analytics-data-room-service.js';
import type { AnalyticsImportInbox } from '../../core/analytics-import-inbox.js';
import type { AnalyticsImportSemanticProposalService } from '../../core/analytics-import-semantic-proposal.js';
import type { AnalyticsImportPromotionService } from '../../core/analytics-import-promotion.js';
import type { AnalyticsAnswerService } from '../../core/analytics-data-room-answer.js';
import type { ProductDocumentService, WritingConfigStore } from '../../product-manager/types.js';
import type { ProductDocumentPublicationService } from '../../product-manager/product-document-publications.js';
import type { ChatTerminalService } from '../../core/chat-terminal.js';
import type { ContentStore } from '../../core/content-store.js';
import type { DocumentParser } from '../../core/document-parser.js';
import type { EtlOnboardingService } from '../../core/etl-onboarding.js';
import type { VisualAssetRegistry } from '../../core/visual-assets.js';
import type { VisualInspector } from '../../core/visual-inspector.js';
import type { ProjectArtifactService } from '../../core/project-artifacts.js';
import type { ShutdownRuntimeContext } from '../../core/shutdown-coordinator.js';
import type { DocumentReads } from '../../core/document-reads.js';
import type { FolderImportScheduler } from '../../monitors/folder-import-scheduler.js';
import type { StorageUsageService } from '../../core/storage-usage.js';
import type { CaptureHealth } from '../../core/capture-health.js';
import type { ChatJobStore } from '../../core/chat-jobs.js';
import type { ContinuationBridge } from '../../core/chat-continuations.js';

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
  /** Long-document reads into project brains (document-reads.ts). */
  documentReads?: DocumentReads;
  projectRelations?: ProjectRelationsEngine;
  channelDigester?: ChannelDigester;
  // Chat streaming loop deps (previously accessed via `(deps as any)`)
  llmClient?: LlmClient;
  /** Settings → AI model: model connections, background role choices, chat model catalog, live status. */
  aiModelSettings?: AiModelSettingsService;
  llmUsageService?: LlmUsageService;
  toolExecutor?: ToolExecutor;
  promptManager?: PromptManager;
  conversationManager?: ConversationManager;
  mcpManager?: McpManager;
  graspSync?: GraspSync;
  /** Gmail API mail sync and its OAuth connection (non-Amazon accounts). */
  gmailSync?: GmailSyncs;
  gmailConnection?: GmailConnection;
  /** Drafts and sends (chat tools + the chat draft card's owner buttons). */
  gmailCompose?: GmailCompose;
  /** Origin the dashboard is served on (http://localhost:<port>); OAuth callbacks redirect here. */
  dashboardOrigin?: string;
  sharePointSync?: SharePointSync;
  analyticsService?: AnalyticsDashboardService;
  analyticsScheduler?: AnalyticsScheduler;
  /** R1 read-only shared dataset/version catalog. */
  analyticsDataRoom?: AnalyticsDataRoomCatalogReader;
  /** R6 owner-only immutable workbook intake and bounded preview; no dataset writer authority. */
  analyticsImportInbox?: AnalyticsImportInbox;
  /** R6.2 background complete-profile/context/inference proposal; no Data Room writer authority. */
  analyticsImportSemantic?: AnalyticsImportSemanticProposalService;
  /** R6.2 exact owner approval and narrow import promotion coordinator. */
  analyticsImportPromotion?: AnalyticsImportPromotionService;
  /** R2 deterministic room→SQL→ETL answer composite. */
  analyticsAnswerService?: AnalyticsAnswerService;
  dashboardPublisher?: DashboardPublisherService;
  productDocumentService?: ProductDocumentService;
  productDocumentPublications?: ProductDocumentPublicationService;
  writingConfigStore?: WritingConfigStore;
  chatTerminal?: ChatTerminalService;
  /** Evidence content reads (document workbench reader). */
  contentStore?: ContentStore;
  /** Sheet-scoped xlsx deep reads (xlsx-deep-reads X1). */
  documentParser?: DocumentParser;
  /** ETL preset onboarding (etl-analytics A3): status + generate trigger. */
  etlOnboarding?: EtlOnboardingService;
  /** Immutable local visuals and question-directed inspection. */
  visualAssets?: VisualAssetRegistry;
  visualInspector?: VisualInspector;
  projectArtifacts?: ProjectArtifactService;
  /** Process-local admission/abort/work registry for bounded shutdown. */
  shutdown?: ShutdownRuntimeContext;
  /** Post-ready local-folder imports: status, big-file review, decisions. */
  folderImports?: FolderImportScheduler;
  /** Local folders storage card (du-measured, cached). */
  storageUsage?: StorageUsageService;
  /** Outcome-level capture health per source (Slack, SharePoint, Outlook). */
  captureHealth?: CaptureHealth;
  /** Owner jobs and their watched ETL runs (chat-jobs.ts). */
  chatJobs?: ChatJobStore;
  /** Continuation turns: secret, live hub, runner (chat-continuations.ts). */
  chatContinuations?: ContinuationBridge;
}

/** Express 5 params can be string[]; normalize to a single string. */
export function paramStr(val: string | string[]): string {
  return Array.isArray(val) ? val[0] : val;
}

/** Rough prose-token estimate used for chat summary logging. */
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}
