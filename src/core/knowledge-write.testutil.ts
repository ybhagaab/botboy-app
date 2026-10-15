/**
 * A harness for the Knowledge library's write path (tests only): a real library service on a temp folder with a space in its
 * name, a real journal, a real changes store, the real guide check and drafter driven by a scripted fake LlmClient, and a
 * tool-execution context like chat.ts builds. Synthetic content only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerCaptureExcludedRoots } from './capture-exclusions.js';
import { createGuideCheck, type CheckItem } from './knowledge-check.js';
import { createKnowledgeChangeStore, type KnowledgeChangeStore } from './knowledge-changes.js';
import { createGuideDrafter } from './knowledge-draft.js';
import { SHOP_GUIDE, sampleLibraryFiles, writeTree } from './knowledge-fixtures.testutil.js';
import { createKnowledgeHistory, type KnowledgeHistory } from './knowledge-history.js';
import { createKnowledgeLibrary, type KnowledgeLibrary } from './knowledge-library.js';
import { canonicalRootOrNull, emptyKnowledgeState, knowledgeExcludedRoots, writeKnowledgeState } from './knowledge-root.js';
import { ROOT_GUIDE_SEED, buildGuideDraft } from './knowledge-templates.js';
import { createKnowledgeWriter, type KnowledgeWriter, type WriterReply } from './knowledge-write.js';
import type { ChatCompletionRequest, ChatCompletionResponse, LlmClient } from './llm-client.js';
import { registerWriteProtectedRoots } from './protected-local-resources.js';
import { createStorage, type StorageLayer } from './storage.js';
import type { ToolExecutionContext } from './tool-executor.js';

export type Verdict = { items?: Array<Record<string, unknown>>; summaryUpdate?: { purpose?: string; bullets?: string[] }; suspiciousDirective?: boolean };

export interface Harness {
  base: string;
  root: string;
  home: string;
  storage: StorageLayer;
  library: KnowledgeLibrary;
  history: KnowledgeHistory;
  changes: KnowledgeChangeStore;
  writer: KnowledgeWriter;
  /** Every request the guide check and the drafter sent. */
  llmCalls: ChatCompletionRequest[];
  /** Queue verdicts for the next check calls; an empty queue answers "nothing to fix". */
  queue(...verdicts: Array<Verdict | Error | { raw: string; finishReason?: ChatCompletionResponse['finishReason'] }>): void;
  /** Make the model unavailable (no client). */
  setClient(client: LlmClient | null): void;
  /** Bring the scripted model back after `setClient(null)`. */
  useFakeModel(): void;
  /** What the drafter returns (default: a template-shaped guide for the files it is given). */
  draftGuide?: (request: ChatCompletionRequest) => string | null;
  /** Move the shared clock of the journal, the changes store and the writer forward (the 10-minute sweeps, the 14-day expiry). */
  advance(ms: number): void;
  abs(rel: string): string;
  read(rel: string): string;
  exists(rel: string): boolean;
  put(rel: string, text: string): void;
  /** A live owner turn with the message, the way chat.ts builds the context; extra fields override. */
  turn(message: string, extra?: Partial<ToolExecutionContext>): ToolExecutionContext;
  /** Deliver the rules of a (set, file) like the injected write block or a guide_not_read round: returns the digest to send. */
  rules(context: ToolExecutionContext, setId: string, file?: string): Promise<string>;
  /** write() with rules delivered first (unless rulesSha256 is given) and ownerRequested true by default. */
  write(context: ToolExecutionContext, args: Record<string, unknown>, tool?: 'knowledge_write' | 'knowledge_propose'): Promise<WriterReply>;
  createSet(context: ToolExecutionContext, args: Record<string, unknown>): Promise<WriterReply>;
  close(): void;
}

const response = (content: string, finishReason: ChatCompletionResponse['finishReason'] = 'stop'): ChatCompletionResponse => ({
  content, toolCalls: null, finishReason, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } as ChatCompletionResponse['usage'],
});

export const SHOP_FILES = {
  'GUIDE.md': ROOT_GUIDE_SEED,
  'shop-data/GUIDE.md': SHOP_GUIDE,
  'shop-data/orders.md': '# Orders\n\nVersion one of the context file.\n\n## Filters\n\n- Always filter by channel.\n',
  'shop-data/orders_analysis.md': '# Analysis\n\nMethodology only.\n',
  'shop-data/ORDERS_TABLE_REFERENCE.md': '# Table reference\n\nColumns.\n',
  'shop-data/SHOP_PRODUCT_GUIDE.md': '# Product guide\n\nFlows.\n',
};

export async function makeHarness(options: { files?: Record<string, string>; useSample?: boolean } = {}): Promise<Harness> {
  const storage = createStorage(':memory:');
  storage.initialize();
  const db = storage.getDb();
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-write-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  // Plain env handling, not vitest's: this file is compiled into dist by tsc, so it must not import the test runner.
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const root = path.join(base, 'Docs', 'BotBoy Knowledge');
  writeTree(root, options.files ?? (options.useSample ? sampleLibraryFiles() : SHOP_FILES));
  writeKnowledgeState(db, { ...emptyKnowledgeState(), root, analyticsDir: 'library' });
  registerWriteProtectedRoots(() => canonicalRootOrNull(db));
  registerCaptureExcludedRoots(() => knowledgeExcludedRoots(db));
  const library = createKnowledgeLibrary({ db });
  let clock = 1_800_000_000_000;
  const history = createKnowledgeHistory({ dir: path.join(base, 'state', 'knowledge-history'), root: () => canonicalRootOrNull(db), now: () => clock });
  const changes = createKnowledgeChangeStore(db, { now: () => clock });
  const llmCalls: ChatCompletionRequest[] = [];
  const queued: Array<Verdict | Error | { raw: string; finishReason?: ChatCompletionResponse['finishReason'] }> = [];
  let client: LlmClient | null = null;
  const harness = { draftGuide: undefined } as unknown as Harness;
  const fakeClient = {
    isAvailable: () => true, getContextBudgetTokens: () => 100_000, getMaxCompletionTokens: () => 16_384,
    chatCompletion: async (request: ChatCompletionRequest) => {
      llmCalls.push(request);
      const system = String(request.messages[0]?.content ?? '');
      if (system.startsWith('You write the GUIDE')) {
        const text = harness.draftGuide?.(request) ?? null;
        const user = String(request.messages[1]?.content ?? '');
        const files = [...user.matchAll(/^- ([^\s(]+)/gm)].map((match) => match[1]).filter((name) => /\.(md|txt)$/.test(name));
        const guide = text ?? buildGuideDraft({ kind: 'research', name: 'Drafted', description: 'Drafted set', files: files.map((name) => ({ name })) });
        return response(JSON.stringify({ guide }));
      }
      const next = queued.shift();
      if (next instanceof Error) throw next;
      if (next && 'raw' in next) return response(next.raw, next.finishReason ?? 'stop');
      return response(JSON.stringify({ items: [], ...(next ?? {}) }));
    },
  } as unknown as LlmClient;
  client = fakeClient;
  const check = createGuideCheck({ client: () => client });
  const drafter = createGuideDrafter({ client: () => client });
  const writer = createKnowledgeWriter({ db, library, history, check, drafter, changes, now: () => clock });
  Object.assign(harness, {
    base, root, home, storage, library, history, changes, writer, llmCalls,
    queue: (...verdicts: typeof queued) => { queued.push(...verdicts); },
    setClient: (next: LlmClient | null) => { client = next ?? null; },
    useFakeModel: () => { client = fakeClient; },
    advance: (ms: number) => { clock += ms; },
    abs: (rel: string) => path.join(root, ...rel.split('/')),
    read: (rel: string) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'),
    exists: (rel: string) => fs.existsSync(path.join(root, ...rel.split('/'))),
    put: (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, ...rel.split('/'))), { recursive: true }); fs.writeFileSync(path.join(root, ...rel.split('/')), text); library.invalidate(); },
    turn: (message: string, extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({ currentUserMessage: message, callerKind: 'interactive', ownerRequestId: 'req-1', ...extra }),
    async rules(context: ToolExecutionContext, setId: string, file = 'orders.md') {
      const payload = await writer.rulesPayloadFor(setId, file);
      if ('code' in payload) throw new Error(`rules unavailable: ${payload.code}`);
      const old = context.guidesDelivered ?? {};
      const delivery = payload.delivery;
      const previous = old[setId];
      context.guidesDelivered = { ...old, [setId]: previous && previous.rulesSha256 === delivery.rulesSha256
        ? { rulesSha256: delivery.rulesSha256, full: previous.full || delivery.full, whole: previous.whole || delivery.whole, files: [...new Set([...previous.files, ...delivery.files])] }
        : { ...delivery } };
      return payload.rulesSha256;
    },
    async write(context: ToolExecutionContext, args: Record<string, unknown>, tool: 'knowledge_write' | 'knowledge_propose' = 'knowledge_write') {
      const withRules = { ownerRequested: tool === 'knowledge_write', ...args } as Record<string, unknown>;
      // A new name (create, import, move) is delivered as a new target: the table and every entry, which covers the old name too.
      const delivered = ['create', 'import', 'move'].includes(String(withRules.mode)) ? '__new__.md' : String(withRules.file ?? 'orders.md');
      if (withRules.rulesSha256 === undefined) withRules.rulesSha256 = await harness.rules(context, String(withRules.set), delivered);
      return writer.write(withRules, context, tool);
    },
    async createSet(context: ToolExecutionContext, args: Record<string, unknown>) {
      const withRules = { ownerRequested: true, ...args } as Record<string, unknown>;
      if (withRules.rulesSha256 === undefined) withRules.rulesSha256 = await harness.rules(context, '/', 'GUIDE.md');
      return writer.createSet(withRules, context);
    },
    close() {
      registerWriteProtectedRoots(null);
      registerCaptureExcludedRoots(null);
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      storage.close();
    },
  });
  return harness;
}

/** A must_fix verdict item that breaks the shop guide's date guardrail, quoting the line the candidate adds. */
export const dateBreach = (quote: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tier: 'must_fix',
  rule: 'Do NOT add hardcoded dates, order ids, or time-specific metrics to the Context File or the Table Reference',
  problem: 'The new line names a specific date.', evidence: quote, fix: 'Describe the rule without the date.', ...extra,
});

export const items = (reply: WriterReply): CheckItem[] => (reply.items as CheckItem[] | undefined) ?? [];
