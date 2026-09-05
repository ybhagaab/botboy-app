// ── Work Item Types ──

export type WorkItemType =
  | 'website_visit'
  | 'youtube_video'
  | 'pdf_download'
  | 'slack_message'
  | 'whatsapp_message'
  | 'email_read'
  | 'email_sent'
  | 'calendar_event'
  | 'document_online'
  | 'document_capture'
  | 'document_comment'
  | 'call_summary'
  | 'app_activity'
  | 'clipboard_capture'
  | 'generic_browser';

export type WorkItemSource = 'browser' | 'app' | 'manual' | 'clipboard' | 'slack' | 'filesystem' | 'grasp' | 'sharepoint';

// ── Raw Work Item (emitted by monitors before storage) ──

export interface RawWorkItem {
  type: WorkItemType;
  source: WorkItemSource;
  sourceApp: string;
  url?: string;
  title?: string;
  content?: string;
  /**
   * Complete raw page HTML (document.documentElement.outerHTML + same-origin
   * iframe documents) for browser captures. Stored losslessly via the
   * ContentStore next to the item; `content` remains the readable text used
   * for FTS/routing.
   */
  rawHtml?: string;
  screenshotPath?: string;
  accessibilitySnapshot?: AccessibilityNode;
  metadata: Record<string, string>;
  capturedAt: Date;
}

// ── Stored Work Item ──

export interface WorkItem {
  id: string;
  type: WorkItemType;
  source: WorkItemSource;
  sourceApp?: string;
  title?: string;
  summary?: string;
  url?: string;
  filePath?: string;
  contentHash?: string;
  screenshotPath?: string;
  visualContext?: string;
  metadata: Record<string, unknown>;
  parsedText?: string;
  capturedAt: Date;
  createdAt: Date;
}

// ── Node ──

export interface Node {
  id: string;
  title: string;
  description?: string;
  parentId: string | null;
  depth: number;
  status: 'active' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}


export interface NodeWorkItem {
  nodeId: string;
  workItemId: string;
  assignedBy: 'classifier' | 'manual';
  assignedAt: Date;
}

export interface NodeConnection {
  nodeIdA: string;
  nodeIdB: string;
  sharedWorkItemIds: string[];
}

// ── Classification ──

export interface ClassificationResult {
  assignments: { nodeId: string; confidence: number }[];
  unassigned: boolean;
}

export interface ClassificationRule {
  id: string;
  ruleText: string;
  createdBy: string;
  active: boolean;
  createdAt: Date;
}

// ── Chat ──

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  actionsPerformed?: ChatAction[];
  /** Image attachments on user messages: id + servable URL for thumbnails. */
  attachments?: { id: string; url: string }[];
  createdAt: Date;
}

export interface ChatAction {
  type: 'node_created' | 'node_updated' | 'classification_rule_added' | 'classification_rule_removed' | 'query_result';
  description: string;
  metadata?: Record<string, unknown>;
}

export interface ChatResponse {
  message: ChatMessage;
  actionsPerformed?: ChatAction[];
}

// ── Accessibility Tree ──

export interface AccessibilityNode {
  role: string;
  name?: string;
  children?: AccessibilityNode[];
  value?: string;
}

// ── Type-Specific Metadata ──

export interface YouTubeMetadata {
  videoTitle: string;
  channelName: string;
}

export interface SlackMessageMetadata {
  channelOrDm: string;
  recipientOrSender: string;
  direction: 'sent' | 'received' | 'observed';
  platform: 'browser' | 'native';
}

export interface WhatsAppMessageMetadata {
  conversationName: string;
}

export interface EmailMetadata {
  subject: string;
  sender?: string;
  recipients: string[];
  direction: 'read' | 'sent' | 'received';
  /** Canonical owner identity required before an email can support a task. */
  ownerEmail?: string;
  /** Structured addressing; browser read captures currently leave these unset. */
  toRecipients?: string[];
  ccRecipients?: string[];
  /** Deterministic capture-layer signal for a direct-To assignment. */
  directlyAddressedToOwner?: boolean;
}

export interface CallSummaryMetadata {
  participants: string[];
  callDate: string;
  duration?: number;
  sourceType: 'zoom' | 'email';
}

export interface DocumentMetadata {
  fileType: string;
  documentType?: 'google_docs' | 'google_sheets' | 'local';
}

export interface IdeMetadata {
  projectName?: string;
  activeFilePath?: string;
}

export interface ClipboardMetadata {
  contentType: 'text' | 'url' | 'file_reference';
  originalContent: string;
}

// ── Embedding ──

export interface EmbeddingConfig {
  provider: 'ollama' | 'custom';
  model: string;
  endpoint: string;
  dimensions: number;
}

// ── ACP Client ──

export interface AcpChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AcpResponse {
  content: string;
  toolCalls?: AcpToolCall[];
}

export interface AcpToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

// ── Activity Log ──

export interface ActivityLogEntry {
  id?: number;
  level: 'info' | 'warn' | 'error';
  component: string;
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

// ── Manual Work Item Input ──

export interface ManualWorkItemInput {
  title: string;
  description?: string;
  url?: string;
  filePath?: string;
}


// ── Phase 2: Agent Brain Types ──

export interface ProcessingResult {
  processed: number;
  assigned: number;
  newNodes: string[];
  errors: string[];
  duration: number;
}

export interface ProcessingStatus {
  active: boolean;
  currentItem?: string;
  progress: { done: number; total: number };
  startedAt?: Date;
}

export interface ProcessOptions {
  batchSize?: number;
  useSubagents?: boolean;
  forceL2?: boolean;
}

export interface ClassificationDecision {
  itemId: string;
  summary: string;
  assignments: NodeAssignment[];
  newNodeSuggestion?: string;
  reasoning: string;
  method: 'embedding' | 'llm' | 'hybrid';
}

export interface NodeAssignment {
  nodeId: string;
  confidence: number;
  reason: string;
}

export interface BatchClassifyResult {
  itemId: string;
  summary: string;
  nodeIds: string[];
  reasoning: string;
}

export type ContextTier = 'L0' | 'L1' | 'L2';

export interface L0Entry {
  id: string;
  type: string;
  title: string;
  oneLiner: string;
}

export interface L1NodeContext {
  id: string;
  title: string;
  description: string;
  itemCount: number;
  recentItemSummaries: string[];
  keywords: string[];
}

export interface L2ItemDetail {
  id: string;
  type: string;
  title: string;
  fullContent: string;
  url?: string;
  metadata: Record<string, unknown>;
  capturedAt: string;
}

export interface AcpSession {
  sessionId: string;
  ready: boolean;
  messageIdCounter: number;
}


// ── Phase 3: Hierarchical Nodes Orchestration Types ──

export interface NodeTree {
  node: Node;
  children: NodeTree[];
  items: WorkItem[];
  totalItemCount: number;
}

export interface NodeWithChildren extends Node {
  children: NodeWithChildren[];
  directItemCount: number;
  totalItemCount: number;
}

export interface BackgroundRunResult {
  timestamp: Date;
  itemsFound: number;
  itemsProcessed: number;
  nodesCreated: number;
  hierarchyChanges: number;
  dedupActions: number;
  errors: string[];
  durationMs: number;
}

export interface HierarchyProposal {
  parentNodeId: string;
  proposedChildren: ProposedChildNode[];
  itemMoves: ItemMove[];
  parentDescription: string;
}

export interface ProposedChildNode {
  title: string;
  description: string;
  itemIds: string[];
}

export interface ItemMove {
  workItemId: string;
  fromNodeId: string;
  toNodeId: string;
}

export interface EnrichmentResult {
  itemId: string;
  parsedText: string;
  summary: string;
  contentType: 'webpage' | 'document' | 'code' | 'conversation';
}

export interface UIAdaptationContext {
  nodeTree: NodeTree;
  currentAppJs: string;
  currentIndexHtml: string;
  changeReason: string;
}

export interface UIChangeResult {
  appJsPatches: string[];
  indexHtmlPatches: string[];
  newComponents: string[];
  applied: boolean;
}

export interface DeduplicationResult {
  duplicatesFound: DuplicateGroup[];
  noiseItems: string[];
  mergeActions: Array<{ keepId: string; removeIds: string[] }>;
}

export interface DuplicateGroup {
  canonical: string;
  duplicates: string[];
  reason: 'same_url' | 'same_content_hash' | 'similar_title' | 'agent_detected';
  confidence: number;
}
