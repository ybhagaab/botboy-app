import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type LlmUsageWorkload = 'interactive' | 'background' | 'system' | 'unattributed';
export type LlmUsageAttemptReason = 'initial' | 'auth_retry' | 'stream_retry' | 'fallback' | 'health_probe';
export type LlmUsageAttemptStatus = 'running' | 'completed' | 'partial' | 'failed' | 'interrupted';

export interface LlmUsageContext {
  operationId?: string;
  workload: LlmUsageWorkload;
  retryReason?: 'stream_retry';
}

export interface NormalizedLlmUsageContext {
  operationId: string;
  workload: LlmUsageWorkload;
  retryReason?: 'stream_retry';
}

export interface ParsedProviderUsage {
  reported: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}

export interface LlmAttemptMetadata {
  endpointKey: 'ecs' | 'ollama';
  apiMode: string;
  model: string;
  stream: boolean;
  requestBytes: number;
  imageCount: number;
  attemptReason: LlmUsageAttemptReason;
}

export interface LlmAttemptHandle {
  readonly attemptId: string;
  readonly operationId: string;
  readonly attemptOrdinal: number;
  readonly persisted: boolean;
}

export interface LlmAttemptCompletion {
  status?: 'completed' | 'partial';
  httpStatus?: number;
  usage: ParsedProviderUsage;
}

export interface LlmAttemptFailure {
  status?: 'failed' | 'partial';
  httpStatus?: number;
  errorClass: string;
  usage?: ParsedProviderUsage;
}

export interface LlmUsageModelDay {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  attempts: number;
  reportedAttempts: number;
  unknownAttempts: number;
  interactiveAttempts: number;
  backgroundAttempts: number;
  systemAttempts: number;
  unattributedAttempts: number;
}

export interface LlmUsageDailyResponse {
  timeZone: string;
  requestedDays: number;
  retention: 'indefinite';
  days: Array<{ date: string; models: LlmUsageModelDay[] }>;
  coverage: {
    attempts: number;
    runningAttempts: number;
    reportedAttempts: number;
    unknownAttempts: number;
    failedAttempts: number;
    partialAttempts: number;
    interruptedAttempts: number;
    unattributedAttempts: number;
    unrecordedAttemptsSinceBoot: number;
  };
}

export interface LlmUsageService {
  normalizeContext(context?: LlmUsageContext, defaultWorkload?: LlmUsageWorkload): NormalizedLlmUsageContext;
  beginAttempt(context: NormalizedLlmUsageContext, metadata: LlmAttemptMetadata): LlmAttemptHandle;
  completeAttempt(handle: LlmAttemptHandle, completion: LlmAttemptCompletion): void;
  failAttempt(handle: LlmAttemptHandle, failure: LlmAttemptFailure): void;
  dailyUsage(options: { days: number; timeZone: string; now?: Date }): LlmUsageDailyResponse;
  getUnrecordedAttemptsSinceBoot(): number;
}

const EMPTY_USAGE: ParsedProviderUsage = Object.freeze({
  reported: false,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
});

export function emptyProviderUsage(): ParsedProviderUsage {
  return { ...EMPTY_USAGE };
}

export function createLlmUsageOperationId(): string {
  return `lluop_${randomUUID()}`;
}

export function normalizeLlmUsageContext(
  context?: LlmUsageContext,
  defaultWorkload: LlmUsageWorkload = 'unattributed',
): NormalizedLlmUsageContext {
  const allowed: LlmUsageWorkload[] = ['interactive', 'background', 'system', 'unattributed'];
  const workload = context && allowed.includes(context.workload) ? context.workload : defaultWorkload;
  const operationId = context?.operationId?.trim().slice(0, 160) || createLlmUsageOperationId();
  return {
    operationId,
    workload,
    ...(context?.retryReason === 'stream_retry' ? { retryReason: 'stream_retry' as const } : {}),
  };
}

/** Fail-open default for direct tests and legacy construction without storage. */
export function createNoopLlmUsageService(): LlmUsageService {
  return {
    normalizeContext: normalizeLlmUsageContext,
    beginAttempt(context): LlmAttemptHandle {
      return Object.freeze({
        attemptId: `llua_${randomUUID()}`,
        operationId: context.operationId,
        attemptOrdinal: 0,
        persisted: false,
      });
    },
    completeAttempt(): void {},
    failAttempt(): void {},
    dailyUsage({ days, timeZone }): LlmUsageDailyResponse {
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('days must be an integer from 1 to 365');
      if (!isValidIanaTimeZone(timeZone)) throw new Error('timeZone must be a valid IANA time zone');
      return {
        timeZone,
        requestedDays: days,
        retention: 'indefinite',
        days: [],
        coverage: {
          attempts: 0,
          runningAttempts: 0,
          reportedAttempts: 0,
          unknownAttempts: 0,
          failedAttempts: 0,
          partialAttempts: 0,
          interruptedAttempts: 0,
          unattributedAttempts: 0,
          unrecordedAttemptsSinceBoot: 0,
        },
      };
    },
    getUnrecordedAttemptsSinceBoot: () => 0,
  };
}

export function isValidIanaTimeZone(value: string): boolean {
  if (!value || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function safeErrorClass(error: unknown): string {
  const raw = error instanceof Error ? error.name : typeof error;
  return String(raw || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error';
}

function nonNegativeOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function normalizedUsage(usage: ParsedProviderUsage | undefined): ParsedProviderUsage {
  if (!usage?.reported) return emptyProviderUsage();
  const inputTokens = nonNegativeOrNull(usage.inputTokens);
  const outputTokens = nonNegativeOrNull(usage.outputTokens);
  const reportedTotal = nonNegativeOrNull(usage.totalTokens);
  return {
    reported: true,
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    cacheReadTokens: nonNegativeOrNull(usage.cacheReadTokens),
    cacheWriteTokens: nonNegativeOrNull(usage.cacheWriteTokens),
    reasoningTokens: nonNegativeOrNull(usage.reasoningTokens),
  };
}

function localDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = new Map(parts.map(part => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

function precedingDateKeys(todayKey: string, days: number): string[] {
  const cursor = new Date(`${todayKey}T12:00:00.000Z`);
  const keys: string[] = [];
  for (let index = 0; index < days; index += 1) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return keys;
}

interface UsageRow {
  model: string;
  workload: LlmUsageWorkload;
  started_at: string;
  status: LlmUsageAttemptStatus;
  usage_reported: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
}

interface TokenAccumulator {
  value: number;
  seen: boolean;
}

interface ModelAccumulator {
  model: string;
  input: TokenAccumulator;
  output: TokenAccumulator;
  total: TokenAccumulator;
  cacheRead: TokenAccumulator;
  cacheWrite: TokenAccumulator;
  reasoning: TokenAccumulator;
  attempts: number;
  reportedAttempts: number;
  unknownAttempts: number;
  interactiveAttempts: number;
  backgroundAttempts: number;
  systemAttempts: number;
  unattributedAttempts: number;
}

function tokenAccumulator(): TokenAccumulator {
  return { value: 0, seen: false };
}

function modelAccumulator(model: string): ModelAccumulator {
  return {
    model,
    input: tokenAccumulator(),
    output: tokenAccumulator(),
    total: tokenAccumulator(),
    cacheRead: tokenAccumulator(),
    cacheWrite: tokenAccumulator(),
    reasoning: tokenAccumulator(),
    attempts: 0,
    reportedAttempts: 0,
    unknownAttempts: 0,
    interactiveAttempts: 0,
    backgroundAttempts: 0,
    systemAttempts: 0,
    unattributedAttempts: 0,
  };
}

function addToken(accumulator: TokenAccumulator, value: number | null): void {
  if (value === null || !Number.isFinite(value)) return;
  accumulator.value += value;
  accumulator.seen = true;
}

function tokenValue(accumulator: TokenAccumulator): number | null {
  return accumulator.seen ? accumulator.value : null;
}

export function createLlmUsageService(
  db: Database.Database,
  options: { primaryProvider: string },
): LlmUsageService {
  let unrecordedAttemptsSinceBoot = 0;
  const failedTerminalizationIds = new Set<string>();

  const nextOrdinal = db.prepare(`
    SELECT COALESCE(MAX(attempt_ordinal), 0) + 1 AS ordinal
    FROM llm_usage_attempts
    WHERE operation_id = ?
  `);
  const insertAttempt = db.prepare(`
    INSERT INTO llm_usage_attempts (
      id, operation_id, attempt_ordinal, workload, attempt_reason,
      provider, endpoint_key, api_mode, model, stream,
      started_at, status, usage_reported, request_bytes, image_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?, ?)
  `);
  const beginTransaction = db.transaction((
    context: NormalizedLlmUsageContext,
    metadata: LlmAttemptMetadata,
    attemptId: string,
    startedAt: string,
  ): number => {
    const ordinal = Number((nextOrdinal.get(context.operationId) as { ordinal: number }).ordinal);
    const provider = metadata.endpointKey === 'ollama' ? 'ollama' : options.primaryProvider;
    insertAttempt.run(
      attemptId,
      context.operationId,
      ordinal,
      context.workload,
      metadata.attemptReason,
      provider,
      metadata.endpointKey,
      metadata.apiMode,
      metadata.model,
      metadata.stream ? 1 : 0,
      startedAt,
      Math.max(0, Math.floor(metadata.requestBytes)),
      Math.max(0, Math.floor(metadata.imageCount)),
    );
    return ordinal;
  });

  const finishAttempt = db.prepare(`
    UPDATE llm_usage_attempts
    SET completed_at = ?, status = ?, http_status = ?, usage_reported = ?,
        input_tokens = ?, output_tokens = ?, total_tokens = ?,
        cache_read_tokens = ?, cache_write_tokens = ?, reasoning_tokens = ?,
        error_class = ?
    WHERE id = ? AND status = 'running'
  `);

  try {
    db.prepare(`
      UPDATE llm_usage_attempts
      SET status = 'interrupted', completed_at = ?, error_class = 'process_restart'
      WHERE status = 'running'
    `).run(new Date().toISOString());
  } catch (error) {
    unrecordedAttemptsSinceBoot += 1;
    console.warn(`[LLM Usage] stale-attempt reconciliation failed (${safeErrorClass(error)})`);
  }

  function normalizeContext(
    context?: LlmUsageContext,
    defaultWorkload: LlmUsageWorkload = 'unattributed',
  ): NormalizedLlmUsageContext {
    return normalizeLlmUsageContext(context, defaultWorkload);
  }

  function beginAttempt(
    context: NormalizedLlmUsageContext,
    metadata: LlmAttemptMetadata,
  ): LlmAttemptHandle {
    const attemptId = `llua_${randomUUID()}`;
    try {
      const attemptOrdinal = beginTransaction(context, metadata, attemptId, new Date().toISOString());
      return Object.freeze({ attemptId, operationId: context.operationId, attemptOrdinal, persisted: true });
    } catch (error) {
      unrecordedAttemptsSinceBoot += 1;
      console.warn(`[LLM Usage] attempt insert failed (${safeErrorClass(error)})`);
      return Object.freeze({ attemptId, operationId: context.operationId, attemptOrdinal: 0, persisted: false });
    }
  }

  function terminalize(
    handle: LlmAttemptHandle,
    status: Exclude<LlmUsageAttemptStatus, 'running' | 'interrupted'>,
    httpStatus: number | undefined,
    usageInput: ParsedProviderUsage | undefined,
    errorClass: string | null,
  ): void {
    if (!handle.persisted || failedTerminalizationIds.has(handle.attemptId)) return;
    const usage = normalizedUsage(usageInput);
    try {
      finishAttempt.run(
        new Date().toISOString(),
        status,
        Number.isInteger(httpStatus) ? httpStatus : null,
        usage.reported ? 1 : 0,
        usage.inputTokens,
        usage.outputTokens,
        usage.totalTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
        usage.reasoningTokens,
        errorClass,
        handle.attemptId,
      );
    } catch (error) {
      failedTerminalizationIds.add(handle.attemptId);
      unrecordedAttemptsSinceBoot += 1;
      console.warn(`[LLM Usage] attempt finalization failed (${safeErrorClass(error)})`);
    }
  }

  function completeAttempt(handle: LlmAttemptHandle, completion: LlmAttemptCompletion): void {
    terminalize(handle, completion.status ?? 'completed', completion.httpStatus, completion.usage, null);
  }

  function failAttempt(handle: LlmAttemptHandle, failure: LlmAttemptFailure): void {
    terminalize(
      handle,
      failure.status ?? 'failed',
      failure.httpStatus,
      failure.usage,
      String(failure.errorClass || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'Error',
    );
  }

  function dailyUsage({ days, timeZone, now = new Date() }: { days: number; timeZone: string; now?: Date }): LlmUsageDailyResponse {
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('days must be an integer from 1 to 365');
    if (!isValidIanaTimeZone(timeZone)) throw new Error('timeZone must be a valid IANA time zone');

    const todayKey = localDateKey(now, timeZone);
    const requestedKeys = precedingDateKeys(todayKey, days);
    const requestedSet = new Set(requestedKeys);
    const earliestKey = requestedKeys[requestedKeys.length - 1];
    const envelopeStart = new Date(`${earliestKey}T00:00:00.000Z`);
    envelopeStart.setUTCDate(envelopeStart.getUTCDate() - 1);
    const envelopeEnd = new Date(`${todayKey}T00:00:00.000Z`);
    envelopeEnd.setUTCDate(envelopeEnd.getUTCDate() + 2);

    const rows = db.prepare(`
      SELECT model, workload, started_at, status, usage_reported,
             input_tokens, output_tokens, total_tokens,
             cache_read_tokens, cache_write_tokens, reasoning_tokens
      FROM llm_usage_attempts
      WHERE started_at >= ? AND started_at < ?
      ORDER BY started_at ASC
    `).all(envelopeStart.toISOString(), envelopeEnd.toISOString()) as UsageRow[];

    const grouped = new Map<string, Map<string, ModelAccumulator>>();
    const coverage = {
      attempts: 0,
      runningAttempts: 0,
      reportedAttempts: 0,
      unknownAttempts: 0,
      failedAttempts: 0,
      partialAttempts: 0,
      interruptedAttempts: 0,
      unattributedAttempts: 0,
      unrecordedAttemptsSinceBoot,
    };

    for (const row of rows) {
      const startedAt = new Date(row.started_at);
      if (Number.isNaN(startedAt.getTime())) continue;
      const date = localDateKey(startedAt, timeZone);
      if (!requestedSet.has(date)) continue;

      coverage.attempts += 1;
      if (row.status === 'running') {
        coverage.runningAttempts += 1;
        continue;
      }

      let models = grouped.get(date);
      if (!models) {
        models = new Map();
        grouped.set(date, models);
      }
      let model = models.get(row.model);
      if (!model) {
        model = modelAccumulator(row.model);
        models.set(row.model, model);
      }

      model.attempts += 1;
      if (row.usage_reported) {
        model.reportedAttempts += 1;
        coverage.reportedAttempts += 1;
      } else {
        model.unknownAttempts += 1;
        coverage.unknownAttempts += 1;
      }
      if (row.workload === 'interactive') model.interactiveAttempts += 1;
      if (row.workload === 'background') model.backgroundAttempts += 1;
      if (row.workload === 'system') model.systemAttempts += 1;
      if (row.workload === 'unattributed') {
        model.unattributedAttempts += 1;
        coverage.unattributedAttempts += 1;
      }
      if (row.status === 'failed') coverage.failedAttempts += 1;
      if (row.status === 'partial') coverage.partialAttempts += 1;
      if (row.status === 'interrupted') coverage.interruptedAttempts += 1;

      addToken(model.input, row.input_tokens);
      addToken(model.output, row.output_tokens);
      addToken(model.total, row.total_tokens);
      addToken(model.cacheRead, row.cache_read_tokens);
      addToken(model.cacheWrite, row.cache_write_tokens);
      addToken(model.reasoning, row.reasoning_tokens);
    }

    const responseDays = requestedKeys.flatMap(date => {
      const models = grouped.get(date);
      if (!models) return [];
      const rendered = [...models.values()].map(model => ({
        model: model.model,
        inputTokens: tokenValue(model.input),
        outputTokens: tokenValue(model.output),
        totalTokens: tokenValue(model.total),
        cacheReadTokens: tokenValue(model.cacheRead),
        cacheWriteTokens: tokenValue(model.cacheWrite),
        reasoningTokens: tokenValue(model.reasoning),
        attempts: model.attempts,
        reportedAttempts: model.reportedAttempts,
        unknownAttempts: model.unknownAttempts,
        interactiveAttempts: model.interactiveAttempts,
        backgroundAttempts: model.backgroundAttempts,
        systemAttempts: model.systemAttempts,
        unattributedAttempts: model.unattributedAttempts,
      })).sort((a, b) => (b.totalTokens ?? -1) - (a.totalTokens ?? -1) || a.model.localeCompare(b.model));
      return [{ date, models: rendered }];
    });

    return { timeZone, requestedDays: days, retention: 'indefinite', days: responseDays, coverage };
  }

  return {
    normalizeContext,
    beginAttempt,
    completeAttempt,
    failAttempt,
    dailyUsage,
    getUnrecordedAttemptsSinceBoot: () => unrecordedAttemptsSinceBoot,
  };
}
