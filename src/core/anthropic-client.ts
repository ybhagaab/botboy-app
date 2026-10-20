/**
 * Anthropic (Claude) Messages client (design v3 D1, D6, D7, D9, D10 client half).
 *
 * A full `LlmClient` over the native Messages API, so everything above it (chat loop, organizer, visual inspector,
 * usage accounting, data locality) is unchanged. It owns I/O, retries, health, timing and usage rows; the pure
 * request/stream mapping is `anthropic-messages.ts`, the schema seam `anthropic-schema.ts`, the error table
 * `anthropic-errors.ts`, and the only conversation state (the thinking ledger and the withheld-tools memory) is
 * `anthropic-replay-guard.ts`.
 *
 * Rules this file keeps:
 *   - The key goes only to the configured endpoint (`ANTHROPIC_API_ENDPOINT` in production), in `x-api-key`, built
 *     by `anthropicRequestHeaders` from a value that passes the key shape. A route's `endpoint` or `headers` are ignored.
 *   - Provider text passes `redactProviderSecrets` before any throw or log; a non-JSON error body is never shown.
 *   - One SSE path serves `chatCompletionStream` and `chatCompletion`.
 *   - No `temperature` and no beta header in production (the recovery retry's opt-in is off by default).
 *   - Health: every 4xx except 401 is request-specific and never marks health; a request that carries a `route`
 *     never marks health for any error class (like the OpenAI-compatible client); provider issues are recorded
 *     at call level whatever the route; rate limits, overload and spend limits never touch health or fallback.
 */
import {
  LlmPayloadTooLargeError,
  LlmProviderOverloadedError,
  LlmQuotaExhaustedError,
  LlmRateLimitedError,
  abortableDelay,
  isLlmPayloadTooLargeError,
  isLlmProviderLimitError,
  redactProviderSecrets,
  serializeProviderRequest,
  validateStrictResponseFormat,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type LlmClient,
  type LlmConfig,
  type LlmProviderIssue,
  type PrimaryRequestPreflight,
  type ProviderRequestSize,
  type StreamChunk,
  type StreamResult,
} from './llm-client.js';
import type { AcpChatMessage, AcpResponse } from './types.js';
import { logLlmPrompt } from './llm-prompt-log.js';
import {
  createNoopLlmUsageService,
  emptyProviderUsage,
  type LlmAttemptHandle,
  type LlmUsageAttemptReason,
  type LlmUsageContext,
  type LlmUsageService,
  type NormalizedLlmUsageContext,
} from './llm-usage.js';
import {
  ANTHROPIC_API_ENDPOINT,
  anthropicRequestHeaders,
  deriveProfile,
  type AnthropicModelProfile,
} from './anthropic-models.js';
import {
  AnthropicApiError,
  classifyAnthropicHttpError,
  isAnthropicApiError,
  type AnthropicErrorClassification,
} from './anthropic-errors.js';
import {
  buildAnthropicBody,
  convertHistory,
  createAnthropicStreamReducer,
  createSseFrameParser,
  isAnthropicHistoryError,
  measureAnthropicRequest,
  resolveWireTools,
  thinkingLevelOf,
  toLlmUsage,
  unknownAnthropicProfile,
  type AnthropicRequestBody,
  type BuiltBody,
  type ConvertedHistory,
} from './anthropic-messages.js';
import { isAnthropicSchemaError } from './anthropic-schema.js';
import { bodyHasThinking, createReplayGuard, type GuardEvaluation, type ReplayGuard } from './anthropic-replay-guard.js';

/** Idle silence that aborts a stream. Just under the 300 s undici documents for its own header and body timeouts, so BotBoy's typed "aborted" error (which chat retries once) wins over a raw socket error. */
export const ANTHROPIC_STREAM_IDLE_TIMEOUT_MS = 280_000;
// The same bounds as the OpenAI loop in llm-client.ts: three resends, a requested wait above 20 s ends the loop at once.
const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_MAX_WAIT_MS = 20_000;
const RATE_LIMIT_DEFAULT_WAIT_MS = 2_000;
/** Anthropic accepts 32 MB per request (S9); BotBoy's own 5.5 MB gate normally fires first. */
const REMOTE_REQUEST_LIMIT_BYTES = 32_000_000;
const PROBE_TIMEOUT_MS = 10_000;
const FALLBACK_MAX_REQUEST_BYTES = 5_500_000;
const BETA_HEADER = 'anthropic-beta';
const BINDING_BETA = 'thinking-binding-controls-2026-08-01';

export interface AnthropicClientOptions {
  /** The owner's key. Held only here, used only to build request headers. */
  apiKey: string;
  /** The connection's model profiles by id, read per call so a refreshed list applies at once. */
  profiles: () => ReadonlyMap<string, AnthropicModelProfile>;
  /** Top-level prompt caching for interactive calls that send tools (D8). Default on. */
  promptCaching?: boolean;
  /** Effort for `think: true` calls that name none. Default 'low'. */
  defaultEffort?: 'low' | 'high' | 'max';
  /** Optional recovery step: retry once with the documented `drop_block` control before stripping everything. */
  recoveryDropBlockFirst?: boolean;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  guard?: ReplayGuard;
  /** Called (fire and forget) when an answer says the model list is stale: a thinking-type 400, a 404 on a model. */
  onModelsStale?: (reason: string) => void;
}

interface Prepared {
  url: string;
  model: string;
  profile: AnthropicModelProfile;
  history: ConvertedHistory;
  built: BuiltBody;
  evaluation: GuardEvaluation;
  body: AnthropicRequestBody;
  bodyStr: string;
  size: ProviderRequestSize;
  /** The recovery step this body was built for (initial, drop_block, strip). */
  step: 'initial' | 'drop_block' | 'strip';
}

interface SentRequest {
  response: Response;
  handle: LlmAttemptHandle;
  prepared: Prepared;
}

function usageErrorClass(error: unknown, fallback = 'Error'): string {
  const value = error instanceof Error ? error.name : (typeof error === 'string' ? error : typeof error);
  return String(value || fallback).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || fallback;
}

function safeInputBudget(contextWindow: number, maxCompletionTokens: number): number {
  const completionReserve = Math.min(maxCompletionTokens, Math.floor(contextWindow / 2));
  const serializationReserve = Math.min(4_096, Math.max(1_024, Math.floor(contextWindow * 0.02)));
  return Math.max(1_024, contextWindow - completionReserve - serializationReserve);
}

export function createAnthropicLlmClient(
  config: LlmConfig,
  options: AnthropicClientOptions,
  usageService?: LlmUsageService,
): LlmClient {
  const usage = usageService ?? createNoopLlmUsageService();
  const endpoint = (config.ecs.endpoint || ANTHROPIC_API_ENDPOINT).replace(/\/+$/, '');
  const defaultModel = config.ecs.model;
  const guard = options.guard ?? createReplayGuard(options.recoveryDropBlockFirst === undefined ? {} : { recoveryDropBlockFirst: options.recoveryDropBlockFirst });
  const sleep = options.sleep ?? abortableDelay;
  const promptCaching = options.promptCaching !== false;
  const configuredMaximum = Number(config.maxRequestBytes ?? process.env.BOTBOY_LLM_MAX_REQUEST_BYTES ?? FALLBACK_MAX_REQUEST_BYTES);
  const maximumRequestBytes = Number.isFinite(configuredMaximum) && configuredMaximum > 0 ? Math.floor(configuredMaximum) : FALLBACK_MAX_REQUEST_BYTES;
  const idleMs = config.streamIdleTimeoutMs ?? ANTHROPIC_STREAM_IDLE_TIMEOUT_MS;
  const doFetch = (input: string, init: RequestInit) => (options.fetchImpl ?? globalThis.fetch)(input, init);

  let healthy = false;
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let providerIssue: LlmProviderIssue | undefined;

  const noteIssue = (code: LlmProviderIssue['code'], httpStatus: number) => {
    providerIssue = { code, httpStatus, at: new Date().toISOString() };
  };

  const profileFor = (model: string): AnthropicModelProfile => options.profiles().get(model) ?? unknownAnthropicProfile(model);
  const modelOf = (request: ChatCompletionRequest) => request.route?.model ?? request.model ?? defaultModel;

  // ── Health (free probe) ──

  async function probe(): Promise<boolean> {
    try {
      const response = await doFetch(`${endpoint}/v1/models?limit=1`, {
        headers: anthropicRequestHeaders(options.apiKey),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      // The probe can report a rejected key but never clears one: a key may list models yet be refused
      // generation. Only a successful generation clears a credential issue.
      if (response.status === 401 || response.status === 403) noteIssue('auth_rejected', response.status);
      // An account limit or provider capacity is not an endpoint failure: it must not pause background work.
      if (response.status === 429 || response.status === 529) return true;
      return response.ok;
    } catch {
      return false;
    }
  }

  async function runHealthCheck(): Promise<void> {
    healthy = await probe();
  }

  // ── Building one request ──

  function prepare(
    request: ChatCompletionRequest,
    context: NormalizedLlmUsageContext,
    settings: { remember: boolean; step?: Prepared['step']; stripped?: boolean },
  ): Prepared {
    const model = modelOf(request);
    const profile = profileFor(model);
    const effective = deriveProfile(profile);
    const history = convertHistory(request.messages, { contextWindow: profile.contextWindow });
    const wireTools = resolveWireTools(request.tools, history.toolNames, guard, { remember: settings.remember });
    const level = thinkingLevelOf(request, options.defaultEffort ?? 'low');
    const interactive = context.workload === 'interactive';
    if (request.responseFormat?.type === 'json_schema') validateStrictResponseFormat(request.responseFormat);
    const step = settings.step ?? 'initial';
    const built = buildAnthropicBody({
      model,
      profile,
      history,
      wireTools,
      level,
      maxTokens: request.maxTokens ?? config.defaults.maxCompletionTokens,
      // Summaries are for the chat panel's thinking block: interactive, thinking on, and Settings → AI model →
      // Show model thinking on (request.showThinking). Everything else skips the text (same billing, faster
      // first token).
      display: interactive && level !== 'off' && request.showThinking === true ? 'summarized' : 'omitted',
      responseFormat: request.responseFormat,
      cache: promptCaching && interactive,
      stream: true,
      ...(step === 'drop_block' ? { binding: 'drop_block' as const } : {}),
    });
    const evaluation = guard.evaluate({
      system: built.body.system,
      tools: built.body.tools,
      messages: built.body.messages,
      edited: history.edited,
      enforce: effective.prefixCheck,
    });
    const body: AnthropicRequestBody = evaluation.drops.length > 0 ? { ...built.body, messages: evaluation.messages } : built.body;
    if (evaluation.drops.length > 0) {
      const count = evaluation.drops.reduce((sum, drop) => sum + drop.blocks, 0);
      const causes = [...new Set(evaluation.drops.map(drop => drop.cause))].join(', ');
      console.log(`[Anthropic] replay guard: dropped ${count} earlier thinking block(s) in ${evaluation.drops.length} message(s) before sending (cause: ${causes}); the answer may use more tokens.`);
    }
    if (evaluation.editedKept.length > 0) {
      console.log(`[Anthropic] replay guard: ${evaluation.editedKept.length} message(s) were edited in place and kept their thinking (SAME_MESSAGE_EDIT=${guard.sameMessageEdit}).`);
    }
    const { bodyStr, size } = serializeProviderRequest(body, maximumRequestBytes, request.payloadConstraint, measureAnthropicRequest);
    return { url: `${endpoint}/v1/messages`, model, profile, history, built, evaluation, body, bodyStr, size, step };
  }

  // ── Sending with the bounded 429 / 529 loop ──

  function attemptReason(context: NormalizedLlmUsageContext): LlmUsageAttemptReason {
    return context.retryReason === 'stream_retry' ? 'stream_retry' : 'initial';
  }

  /** The typed error for one non-2xx answer; records the provider issue. */
  function typedError(classification: AnthropicErrorClassification, size: ProviderRequestSize, requestedWait?: number): Error {
    if (classification.issue) noteIssue(classification.issue, classification.status);
    if (classification.kind === 'quota_exhausted') {
      return new LlmQuotaExhaustedError('anthropic', { message: classification.message, nextAction: classification.nextAction });
    }
    if (classification.kind === 'rate_limited') return new LlmRateLimitedError(requestedWait);
    if (classification.kind === 'overloaded') return new LlmProviderOverloadedError(requestedWait);
    if (classification.kind === 'payload_too_large') {
      return new LlmPayloadTooLargeError(size, REMOTE_REQUEST_LIMIT_BYTES, { source: 'remote', httpStatus: classification.status, providerMessage: classification.providerMessage });
    }
    return new AnthropicApiError(classification);
  }

  async function sendOnce(prepared: Prepared, context: NormalizedLlmUsageContext, signal: AbortSignal | undefined): Promise<SentRequest & { classification?: AnthropicErrorClassification }> {
    const headers: Record<string, string> = {
      ...anthropicRequestHeaders(options.apiKey, { json: true }),
      ...(prepared.step === 'drop_block' ? { [BETA_HEADER]: BINDING_BETA } : {}),
    };
    const handle = usage.beginAttempt(context, {
      endpointKey: 'ecs',
      provider: config.providerId ?? 'anthropic',
      apiMode: 'messages',
      model: prepared.model,
      stream: true,
      requestBytes: prepared.size.bodyBytes,
      imageCount: prepared.size.imageCount,
      attemptReason: attemptReason(context),
    });
    let response: Response;
    try {
      response = await doFetch(prepared.url, { method: 'POST', headers, body: prepared.bodyStr, ...(signal ? { signal } : {}) });
    } catch (error) {
      usage.failAttempt(handle, { errorClass: usageErrorClass(error, 'FetchError'), usage: emptyProviderUsage() });
      // A cancellation is control flow and keeps its identity; any other transport error is rethrown with secrets removed.
      if (signal?.aborted) throw error;
      const clean = new Error(redactProviderSecrets(error instanceof Error ? error.message : String(error)));
      clean.name = error instanceof Error ? error.name : 'Error';
      throw clean;
    }
    if (response.ok) return { response, handle, prepared };
    const text = await response.text().catch(() => '');
    const classification = classifyAnthropicHttpError(response.status, response.headers, text);
    usage.failAttempt(handle, { httpStatus: response.status, errorClass: `HTTP_${response.status}`, usage: emptyProviderUsage() });
    return { response, handle, prepared, classification };
  }

  /** One logical send: the bounded 429 / 529 loop, each resend its own usage attempt in the same operation. */
  async function sendWithRetries(prepared: Prepared, context: NormalizedLlmUsageContext, signal: AbortSignal | undefined): Promise<SentRequest> {
    let retries = 0;
    for (;;) {
      const sent = await sendOnce(prepared, context, signal);
      const classification = sent.classification;
      if (!classification) {
        providerIssue = undefined;
        return sent;
      }
      if (classification.refreshModels) {
        try { options.onModelsStale?.(classification.kind); } catch { /* a stale-list hint must never break a request */ }
      }
      if (classification.retry === 'bounded') {
        const requested = classification.retryAfterMs;
        const wait = requested ?? RATE_LIMIT_DEFAULT_WAIT_MS * 2 ** retries;
        if (retries >= RATE_LIMIT_MAX_RETRIES || wait > RATE_LIMIT_MAX_WAIT_MS) throw typedError(classification, prepared.size, requested);
        retries += 1;
        await sleep(wait, signal);
        continue;
      }
      throw typedError(classification, prepared.size);
    }
  }

  const isThinkingReplayError = (error: unknown) =>
    isAnthropicApiError(error) && error.classification.requestCause === 'thinking_replay';

  /**
   * The send, with the two documented thinking-block 400s recovered ONCE per request (D3 item 5): when the sent
   * body held a thinking block, forget every thinking block of the history for good and resend. Optionally a
   * `drop_block` retry comes first. The resend is a second attempt row; a second such 400 is the typed error.
   */
  async function sendRecovering(
    request: ChatCompletionRequest,
    context: NormalizedLlmUsageContext,
    first: Prepared,
    signal: AbortSignal | undefined,
  ): Promise<SentRequest> {
    let prepared = first;
    let dropBlockTried = false;
    let stripped = false;
    for (;;) {
      try {
        return await sendWithRetries(prepared, context, signal);
      } catch (error) {
        const sentThinking = bodyHasThinking(prepared.body.messages);
        const replayError = isThinkingReplayError(error);
        // The optional drop_block step failing for ANY 400 (the field or the beta refused) falls through to strip-all.
        const dropBlockRefused = prepared.step === 'drop_block' && isAnthropicApiError(error) && error.classification.status === 400;
        if (stripped || (!replayError && !dropBlockRefused) || !sentThinking) throw error;
        const adaptiveThinking = prepared.body.thinking?.type === 'adaptive';
        if (replayError && guard.recoveryDropBlockFirst && !dropBlockTried && adaptiveThinking) {
          dropBlockTried = true;
          console.log('[Anthropic] replay guard: the API rejected earlier reasoning; retrying once with drop_block.');
          prepared = prepare(request, context, { remember: true, step: 'drop_block' });
          continue;
        }
        stripped = true;
        const forgotten = guard.stripAll(first.history.messages);
        console.log(`[Anthropic] replay guard: the API rejected earlier reasoning; BotBoy removed it (${forgotten} block(s)) and retried once. Reasoning from earlier steps is lost from here on.`);
        prepared = prepare(request, context, { remember: true, step: 'strip' });
      }
    }
  }

  // ── Streaming (one path for stream and non-stream) ──

  function isLocalFailure(error: unknown): boolean {
    return isAnthropicHistoryError(error) || isAnthropicSchemaError(error);
  }

  /** Route-less calls mark health for server errors and transport failures only (L15); every 4xx is request-specific. */
  function marksHealth(error: unknown): boolean {
    if (isLocalFailure(error) || isLlmPayloadTooLargeError(error) || isLlmProviderLimitError(error)) return false;
    // 5xx answers, and a rejected key (a route-less 401 pauses background work at once, like the OpenAI client; the 30 s probe would anyway).
    if (isAnthropicApiError(error)) return error.classification.marksHealth || error.classification.kind === 'auth_rejected';
    return true;
  }

  async function* streamCore(
    request: ChatCompletionRequest,
    settings: { healthNeutral: boolean },
  ): AsyncGenerator<StreamChunk, StreamResult, undefined> {
    const context = usage.normalizeContext(request.usageContext);
    const controller = new AbortController();
    const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (idleMs > 0) {
        // 'aborted' on purpose: chat's transient-error detector retries such a stream once.
        idleTimer = setTimeout(() => controller.abort(new Error(`LLM stream aborted: no data received for ${idleMs}ms`)), idleMs);
      }
    };
    const clearIdleTimer = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; };

    let sent: SentRequest | undefined;
    let attemptClosed = false;
    let lastUsage = emptyProviderUsage();
    const closeFailed = (error: unknown, status: 'failed' | 'partial' = 'partial') => {
      if (attemptClosed || !sent) return;
      attemptClosed = true;
      usage.failAttempt(sent.handle, { status, httpStatus: sent.response.status, errorClass: usageErrorClass(error, 'StreamError'), usage: lastUsage });
    };
    try {
      const first = prepare(request, context, { remember: true });
      logLlmPrompt({
        url: first.url, model: first.model, apiMode: 'messages', stream: true, request: first.body,
        bodyChars: first.size.bodyChars, bodyBytes: first.size.bodyBytes, imageCount: first.size.imageCount, imageChars: first.size.imageChars,
      });
      resetIdleTimer(); // also covers time to first byte (prefill)
      sent = await sendRecovering(request, context, first, signal);
      const { response, handle, prepared } = sent;
      if (!response.body) {
        closeFailed('MissingResponseBody');
        throw new Error('No response body for streaming');
      }
      if (!settings.healthNeutral) healthy = true;

      const toolsOffered = (request.tools?.length ?? 0) > 0;
      const reducer = createAnthropicStreamReducer({
        toolsOffered,
        normalizeJson: prepared.built.responseMode === 'json_object' || prepared.built.responseMode === 'schema_prompt',
      });
      const parser = createSseFrameParser();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let completed = false;
      const feed = function* (frames: ReturnType<typeof parser.push>): Generator<StreamChunk, void, undefined> {
        for (const frame of frames) {
          let event: unknown;
          try { event = JSON.parse(frame.data); } catch { continue; }
          try {
            yield* reducer.push(event);
          } catch (error) {
            // An `error` event after a 200: same table as an HTTP answer (limits and overload become their typed errors).
            if (isAnthropicApiError(error)) throw typedError(error.classification, prepared.size);
            throw error;
          }
          lastUsage = reducer.usage;
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          resetIdleTimer();
          if (value) yield* feed(parser.push(decoder.decode(value, { stream: true })));
          if (done) break;
        }
        yield* feed(parser.push(decoder.decode()));
        yield* feed(parser.flush());
        completed = true;
      } catch (error) {
        // A failure inside the read loop (an idle abort, a network reset, an `error` event) is named by its own
        // class; only a consumer that walks away reaches the finally below unnamed (as in the generic client).
        closeFailed(error);
        throw error;
      } finally {
        clearIdleTimer();
        try { reader.releaseLock(); } catch { /* released with the stream */ }
        if (!completed) closeFailed('StreamConsumerAbandoned');
      }

      const outcome = reducer.finish();
      lastUsage = outcome.usage;
      guard.record(prepared.evaluation, outcome.providerOutput);
      attemptClosed = true;
      usage.completeAttempt(handle, { status: outcome.finishReason === 'length' ? 'partial' : 'completed', httpStatus: response.status, usage: outcome.usage });
      const llmUsage = toLlmUsage(outcome.usage);
      yield { type: 'done', usage: llmUsage };
      return {
        content: outcome.content,
        reasoning: outcome.reasoning,
        toolCalls: outcome.toolCalls,
        usage: llmUsage,
        finishReason: outcome.finishReason,
        providerOutput: outcome.providerOutput,
      };
    } catch (error) {
      clearIdleTimer();
      closeFailed(error);
      throw error;
    } finally {
      clearIdleTimer();
      closeFailed('StreamConsumerAbandoned');
    }
  }

  /** Health bookkeeping and routing rules around one streamed call (shared by stream and non-stream). */
  async function* guarded(
    request: ChatCompletionRequest,
    settings: { healthNeutral: boolean },
  ): AsyncGenerator<StreamChunk, StreamResult, undefined> {
    try {
      return yield* streamCore(request, settings);
    } catch (error) {
      // External cancellation is local control flow: never health, never a retryable flap.
      if (request.signal?.aborted) throw error;
      if (!settings.healthNeutral && !request.route && marksHealth(error)) healthy = false;
      throw error;
    }
  }

  async function drain(request: ChatCompletionRequest, settings: { healthNeutral: boolean }): Promise<ChatCompletionResponse> {
    const generator = guarded(request, settings);
    let step = await generator.next();
    while (!step.done) step = await generator.next();
    const result = step.value;
    return {
      content: result.content,
      reasoning: result.reasoning || undefined,
      toolCalls: result.toolCalls.length > 0 ? result.toolCalls : null,
      usage: result.usage,
      finishReason: result.finishReason,
      ...(result.providerOutput ? { providerOutput: result.providerOutput } : {}),
    };
  }

  runHealthCheck().catch(() => {});
  if (config.healthCheckIntervalMs > 0) {
    healthTimer = setInterval(() => runHealthCheck().catch(() => {}), config.healthCheckIntervalMs);
  }

  const client: LlmClient = {
    getDefaultModel: () => defaultModel,
    getProviderId: () => config.providerId ?? 'anthropic',
    getAvailableModels: () => config.availableModels,
    getProviderIssue: () => providerIssue,

    preflightPrimary(request: ChatCompletionRequest): PrimaryRequestPreflight {
      // The same body builder as a send, without remembering tools or sending anything.
      const context = usage.normalizeContext(request.usageContext);
      const prepared = prepare(request, context, { remember: false });
      return {
        ...prepared.size,
        model: prepared.model,
        apiMode: 'messages',
        maximumBytes: maximumRequestBytes,
        remainingBytes: Math.max(0, maximumRequestBytes - prepared.size.bodyBytes),
      };
    },

    chatCompletionPrimary: request => drain(request, { healthNeutral: true }),
    getMaxRequestBytes: () => maximumRequestBytes,
    chatCompletion: request => drain(request, { healthNeutral: false }),
    chatCompletionStream: request => guarded(request, { healthNeutral: false }),

    async sendPrompt(prompt: string, usageContext?: LlmUsageContext): Promise<AcpResponse> {
      const response = await client.chatCompletion({
        messages: [{ role: 'user', content: prompt }],
        usageContext: usageContext ?? { workload: 'background' },
      });
      return { content: response.content };
    },
    async sendMessage(messages: AcpChatMessage[], usageContext?: LlmUsageContext): Promise<AcpResponse> {
      return client.sendPrompt(messages.map(message => message.content).join('\n'), usageContext ?? { workload: 'background' });
    },
    async initialize(): Promise<void> {},
    isAvailable: () => healthy,
    getActiveEndpoint: () => (healthy ? 'ecs' : 'none'),
    getActiveModel: () => (healthy ? defaultModel : undefined),
    getDialect: () => 'openai',
    getApiMode: () => 'messages',
    getMaxCompletionTokens: () => config.defaults.maxCompletionTokens,
    getContextWindow: () => config.ecs.maxContextTokens,
    getContextBudgetTokens: () => Math.max(1_024, Math.min(
      config.defaults.contextBudgetTokens,
      safeInputBudget(config.ecs.maxContextTokens, config.defaults.maxCompletionTokens),
    )),
    async healthCheck(): Promise<boolean> {
      await runHealthCheck();
      return healthy;
    },
    close(): void {
      if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    },
  };
  return client;
}
