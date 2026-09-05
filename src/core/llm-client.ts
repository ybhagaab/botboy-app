/**
 * LLM Client — HTTP client for OpenAI-compatible APIs (vLLM / Ollama).
 * Replaces the kiro-cli ACP client with simple HTTP calls.
 * Supports failover: ECS primary → Ollama local fallback.
 */

import type { AcpResponse, AcpChatMessage } from './types.js';
import { signBedrockRequest } from './aws-sigv4.js';
import { logLlmPrompt } from './llm-prompt-log.js';

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Populated only when the provider reports a cache hit/write. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface StreamChunk {
  type: 'thinking' | 'content' | 'tool_call_start' | 'tool_call_args' | 'done';
  text?: string;
  toolCall?: { index: number; id?: string; name?: string; arguments?: string };
  usage?: Pick<LlmUsage, 'promptTokens' | 'completionTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>;
}

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: LlmUsage;
  finishReason: 'stop' | 'tool_calls' | 'length';
  /** Opaque Responses output items that must be replayed for stateless tool calls. */
  providerOutput?: unknown[];
}

export interface LlmClient {
  chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  chatCompletionStream(request: ChatCompletionRequest): AsyncGenerator<StreamChunk, StreamResult, undefined>;
  /** The primary (non-Ollama) endpoint's default model id — the anchor blessed overrides resolve against. */
  getDefaultModel(): string;
  sendPrompt(prompt: string): Promise<AcpResponse>; // backward compat
  sendMessage(messages: AcpChatMessage[]): Promise<AcpResponse>; // backward compat
  initialize(): Promise<void>; // no-op for backward compat
  isAvailable(): boolean;
  getActiveEndpoint(): 'ecs' | 'ollama' | 'none';
  /** Model associated with the currently healthy request endpoint. */
  getActiveModel?(): string | undefined;
  /** Server dialect of the ECS endpoint. Optional so lightweight test mocks stay valid. */
  getDialect?(): LlmDialect;
  /** Wire API used by the ECS endpoint. */
  getApiMode?(): LlmApiMode;
  /** Configured maximum completion budget for the active provider profile. */
  getMaxCompletionTokens?(): number;
  /** Configured ECS server context window (--max-model-len). Optional for the same reason. */
  getContextWindow?(): number;
  /**
   * Safe input-token budget for one pipeline prompt. This is clamped below the
   * active provider window so the configured completion allowance still fits.
   */
  getContextBudgetTokens?(): number;
  healthCheck(): Promise<boolean>;
  close(): void;
}

export interface ChatCompletionRequest {
  messages: LlmMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' } | { type: 'text' };
  think?: boolean; // enable thinking mode (default: false for speed)
  /**
   * Per-request reasoning-effort override for think:true calls. Takes
   * precedence over the endpoint's configured default so targeted flows
   * (document authoring/conformance) can run at maximum reasoning without
   * changing global chat latency. Ignored when think is not true.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Per-request model override (chat model picker, 2026-09-03). Must be a
   * FULL provider-qualified id from the blessed registry
   * (inference-provider › resolveBlessedModelId) — same family/profile as
   * the endpoint's default, so budgets and dialects are unchanged. Applies
   * to the OpenAI-compatible endpoint only; the Ollama fallback always
   * keeps its own local model.
   */
  model?: string;
}

export interface ChatCompletionResponse {
  content: string;
  reasoning?: string;
  toolCalls: ToolCall[] | null;
  usage: LlmUsage;
  finishReason: 'stop' | 'tool_calls' | 'length';
  /** Opaque Responses output items that must be replayed for stateless tool calls. */
  providerOutput?: unknown[];
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /**
   * Chain-of-thought from a prior assistant turn. Kimi-K3 was trained in
   * preserved-thinking mode: multi-turn/tool-call requests must replay the
   * assistant's reasoning verbatim (wire field `reasoning_content`). Stripped
   * from the wire for the qwen dialect.
   */
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /**
   * Complete opaque output from a prior Responses turn. With store:false,
   * OpenAI reasoning models require these items (including encrypted reasoning)
   * to be replayed alongside function_call_output items.
   */
  providerOutput?: unknown[];
  /**
   * Image data URLs riding a USER message (chat attachments 2026-09-05).
   * Emitted as vision content parts on OpenAI-shape dialects; callers keep
   * these on the CURRENT turn only — historical images are token-expensive
   * and are replaced upstream by a text note.
   */
  images?: string[];
}

/** Which model-family conventions the remote endpoint uses. */
export type LlmDialect = 'qwen' | 'kimi' | 'openai';

/** Remote OpenAI-compatible wire protocol. */
export type LlmApiMode = 'chat-completions' | 'responses';

/** Thinking-effort levels exposed through BotBoy's provider-neutral contract. */
export type ReasoningEffort = 'low' | 'high' | 'max';

export interface LlmAuthorizationRequest {
  url: string;
  method: 'GET' | 'POST';
  /** Exact serialized payload that will be sent, when the request has one. */
  body?: string;
}

/**
 * Asynchronous per-request authorization seam. Implementations may sign the
 * request, return a static bearer header, or refresh a short-lived OIDC/JWT
 * before returning headers. It is called again for every request and probe.
 *
 * An implementation that caches credentials may expose `invalidate()`; the
 * client calls it after an HTTP 401 and retries the request once with fresh
 * headers, so a revoked/rotated token heals without waiting for expiry.
 */
export type LlmRequestAuthorizer = ((
  request: LlmAuthorizationRequest,
) => Promise<Record<string, string>>) & { invalidate?: () => void };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmConfig {
  ecs: {
    endpoint: string; model: string; maxContextTokens: number; requestTimeoutMs: number; apiKey?: string;
    /** Chat Completions for vLLM/legacy Bedrock; Responses for Bedrock Mantle gpt-5.6 models (Terra, previously Luna). */
    apiMode?: LlmApiMode;
    /**
     * 'qwen' (default): chat_template_kwargs.enable_thinking gating, wire shape
     * unchanged from the original deployment.
     * 'kimi': Kimi-K3 semantics — no chat_template_kwargs (K3 always thinks),
     * top-level reasoning_effort, and reasoning_content round-tripped on
     * assistant messages (preserved-thinking mode).
     * 'openai': Responses-native OpenAI models; no model-specific Chat fields.
     */
    dialect?: LlmDialect;
    /** Effort for think:true calls on the kimi dialect (default 'max'). think:false always maps to 'low'. */
    reasoningEffort?: ReasoningEffort;
    /**
     * 'apiKey' (default): Bearer token — self-hosted vLLM behind the ALB.
     * 'sigv4': AWS SigV4 request signing — Bedrock's OpenAI-compatible
     * endpoint (e.g. https://bedrock-runtime.us-east-1.amazonaws.com/openai).
     * Credentials come from the AWS CLI's ambient login session.
     * Retained for callers that have not migrated to requestAuthorizer.
     */
    authMode?: 'apiKey' | 'sigv4';
    /** Preferred authorization path; overrides authMode/apiKey when supplied. */
    requestAuthorizer?: LlmRequestAuthorizer;
  };
  ollama: { endpoint: string; model: string; maxContextTokens: number; requestTimeoutMs: number };
  defaults: { temperature: number; maxCompletionTokens: number; contextBudgetTokens: number };
  healthCheckIntervalMs: number;
  fallbackEnabled: boolean;
  /**
   * Streaming idle watchdog: abort a stream when no bytes arrive for this many
   * ms (wedged socket after laptop sleep, silent ALB drop). There is
   * deliberately no absolute streaming deadline — long generations are
   * legitimate and produce bytes continuously. 0 disables. Default: 120000.
   */
  streamIdleTimeoutMs?: number;
}

interface Endpoint {
  name: 'ecs' | 'ollama';
  url: string;
  model: string;
  timeoutMs: number;
  healthy: boolean;
  retryCount: number;
  useOllamaApi: boolean;
  apiKey?: string;
  apiMode: LlmApiMode;
  dialect?: LlmDialect;
  reasoningEffort?: ReasoningEffort;
  authMode?: 'apiKey' | 'sigv4';
  requestAuthorizer?: LlmRequestAuthorizer;
}


/**
 * Kimi K2/K2.5 emit tool calls as TEXT using their own token markup rather
 * than the OpenAI `tool_calls` field (Bedrock's OpenAI-compatible surface does
 * not parse it for us):
 *
 *   <|tool_calls_section_begin|>
 *   <|tool_call_begin|>functions.write_file:0<|tool_call_argument_begin|>{"filename":"x.html","content":"..."}<|tool_call_end|>
 *   <|tool_calls_section_end|>
 *
 * Before this was handled, such calls were never executed — the markup landed
 * in the chat bubble as prose and the model then claimed the file was saved
 * (post-mortem 2026-08-05: "keeps failing to save html files").
 */
const KIMI_TOOL_CALL_RE =
  /<\|tool_call_begin\|>\s*(?:functions?\.)?([\w.\-]+?)(?::\d+)?\s*<\|tool_call_argument_begin\|>([\s\S]*?)(?:<\|tool_call_end\|>|$)/g;

/** Strip Kimi tool-call markup (and any trailing section markers) from prose. */
export function stripKimiToolMarkup(content: string): string {
  return content
    .replace(/<\|tool_calls_section_begin\|>[\s\S]*?(?:<\|tool_calls_section_end\|>|$)/g, '')
    .replace(KIMI_TOOL_CALL_RE, '')
    .replace(/<\|tool_calls_section_(?:begin|end)\|>/g, '')
    .replace(/<\|tool_call_(?:begin|end|argument_begin)\|>/g, '')
    .trim();
}

/** True once a stream's accumulated content has entered Kimi tool-call markup. */
function hasKimiToolMarkup(content: string): boolean {
  return content.includes('<|tool_call');
}

/** Parse tool calls from text content when vLLM doesn't populate tool_calls field */
function parseToolCallsFromText(content: string): ToolCall[] {
  const calls: ToolCall[] = [];

  // Pattern 0: Kimi token markup (checked first — most explicit format).
  KIMI_TOOL_CALL_RE.lastIndex = 0;
  for (const m of content.matchAll(KIMI_TOOL_CALL_RE)) {
    const name = m[1];
    const rawArgs = (m[2] || '').trim();
    if (!name) continue;
    let args = rawArgs || '{}';
    try {
      JSON.parse(args);
    } catch {
      // Truncated/oversized argument JSON: keep the raw text so the caller can
      // detect the failure and tell the model to retry smaller, rather than
      // silently executing the tool with no arguments.
      args = rawArgs;
    }
    calls.push({ id: `call_${Date.now()}_${calls.length}`, type: 'function', function: { name, arguments: args } });
  }
  if (calls.length > 0) return calls;

  // Pattern 1: <tools>{"name":"...","arguments":{...}}</tools>
  const toolsMatch = content.match(/<tools>([\s\S]*?)<\/tools>/);
  if (toolsMatch) {
    try {
      const parsed = JSON.parse(toolsMatch[1].trim());
      if (parsed.name) {
        calls.push({ id: `call_${Date.now()}_0`, type: 'function', function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments || {}) } });
      }
    } catch {}
  }

  // Pattern 2: <tool_call>{"name":"...","arguments":{...}}</tool_call>
  for (const m of content.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed.name) calls.push({ id: `call_${Date.now()}_${calls.length}`, type: 'function', function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments || {}) } });
    } catch {}
  }

  // Pattern 3: Qwen3.5 XML style: <tool_call>\n<function=name>\n<parameter=key>value</parameter>\n</function>\n</tool_call>
  if (calls.length === 0) {
    for (const m of content.matchAll(/<tool_call>\s*<function=(\w+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g)) {
      const name = m[1];
      const paramsBlock = m[2];
      const args: Record<string, string> = {};
      for (const p of paramsBlock.matchAll(/<parameter=(\w+)>([\s\S]*?)<\/parameter>/g)) {
        args[p[1]] = p[2].trim();
      }
      calls.push({ id: `call_${Date.now()}_${calls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    }
    // Also handle without </tool_call> wrapper
    if (calls.length === 0) {
      for (const m of content.matchAll(/<function=(\w+)>([\s\S]*?)<\/function>/g)) {
        const name = m[1];
        const paramsBlock = m[2];
        const args: Record<string, string> = {};
        for (const p of paramsBlock.matchAll(/<parameter=(\w+)>([\s\S]*?)<\/parameter>/g)) {
          args[p[1]] = p[2].trim();
        }
        calls.push({ id: `call_${Date.now()}_${calls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      }
    }
  }

  // Pattern 4: bare {"name":"tool_name","arguments":{...}} in text
  if (calls.length === 0) {
    for (const m of content.matchAll(/\{"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{[^}]*\})\s*\}/g)) {
      try {
        const name = m[1];
        const args = m[2];
        JSON.parse(args);
        calls.push({ id: `call_${Date.now()}_${calls.length}`, type: 'function', function: { name, arguments: args } });
      } catch {}
    }
  }

  return calls;
}

function parseProviderUsage(data: any): LlmUsage {
  const usage = data?.usage ?? {};
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const details = usage.prompt_tokens_details ?? usage.input_tokens_details ?? {};
  const cacheReadRaw = details.cached_tokens
    ?? usage.cache_read_input_tokens
    ?? usage.cacheReadInputTokens;
  const cacheWriteRaw = details.cache_write_tokens
    ?? usage.cache_creation_input_tokens
    ?? usage.cacheWriteInputTokens;
  const cacheReadTokens = Number(cacheReadRaw ?? 0) || 0;
  const cacheWriteTokens = Number(cacheWriteRaw ?? 0) || 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number(usage.total_tokens ?? (promptTokens + completionTokens)) || 0,
    ...(cacheReadRaw !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteRaw !== undefined ? { cacheWriteTokens } : {}),
  };
}

/**
 * Serialize messages for the Chat Completions wire. Module-scope and exported
 * for direct unit testing (chat image attachments, 2026-09-05) — it is pure:
 * everything it needs arrives as parameters.
 *
 * kimi: attach `reasoning_content` on assistant messages (K3 preserved-thinking
 * mode requires replaying prior reasoning verbatim) and normalize any camelCase
 * toolCalls/toolCallId leftovers to snake_case (see AGENT_FIX_LEARNINGS #3 —
 * vLLM silently drops unknown keys, which breaks tool-call chaining).
 * qwen: strip the client-side reasoningContent field so the wire shape stays
 * byte-identical to the original deployment; camelCase normalization applies
 * too (it fixes a latent agent.ts bug and matches what vLLM expects).
 */
export function toWireMessages(ep: Pick<Endpoint, 'dialect'>, messages: LlmMessage[]): any[] {
  return messages.map((m: any) => {
    const wire: any = { ...m };
    // snake_case normalization (OpenAI spec)
    if (wire.toolCalls && !wire.tool_calls) wire.tool_calls = wire.toolCalls;
    if (wire.toolCallId && !wire.tool_call_id) wire.tool_call_id = wire.toolCallId;
    delete wire.toolCalls;
    delete wire.toolCallId;
    // reasoning round-trip (kimi only)
    if (ep.dialect === 'kimi' && m.role === 'assistant' && wire.reasoningContent && !wire.reasoning_content) {
      wire.reasoning_content = wire.reasoningContent;
    }
    delete wire.reasoningContent;
    // Responses-only opaque state is never a Chat Completions message field.
    delete wire.providerOutput;
    // Vision (chat attachments): user images become content parts on the
    // Chat Completions wire; text-only messages keep the plain string.
    if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
      wire.content = [
        { type: 'text', text: String(m.content ?? '') },
        ...m.images.map((imageUrl: string) => ({ type: 'image_url', image_url: { url: imageUrl } })),
      ];
    }
    delete wire.images;
    return wire;
  });
}

/**
 * Serialize messages for the Responses API. Module-scope and exported for
 * direct unit testing (pure function of its input).
 */
export function toResponsesInput(messages: LlmMessage[]): { instructions?: string; input: any[] } {
  const instructions = messages
    .filter(message => message.role === 'system' && message.content)
    .map(message => message.content)
    .join('\n\n');
  const input: any[] = [];

  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const callId = message.toolCallId ?? (message as any).tool_call_id;
      if (!callId) throw new Error('Responses API tool messages require toolCallId');
      input.push({
        type: 'function_call_output',
        call_id: callId,
        output: message.content ?? '',
      });
      continue;
    }

    if (message.role === 'assistant' && Array.isArray(message.providerOutput) && message.providerOutput.length > 0) {
      // Responses with store:false are stateless. Replay the provider's full
      // output verbatim so encrypted reasoning remains bound to its function
      // call before the following function_call_output item.
      input.push(...message.providerOutput);
      continue;
    }

    if (message.content !== null && (message.role === 'user' || message.content !== '')) {
      // Vision (chat attachments): a user message carrying images becomes
      // content PARTS — input_text + one input_image per attachment.
      if (message.role === 'user' && message.images?.length) {
        input.push({
          role: 'user',
          content: [
            { type: 'input_text', text: message.content },
            ...message.images.map(imageUrl => ({ type: 'input_image', image_url: imageUrl })),
          ],
        });
      } else {
        input.push({ role: message.role, content: message.content });
      }
    }
    const toolCalls = message.toolCalls ?? (message as any).tool_calls;
    if (message.role === 'assistant' && toolCalls?.length) {
      for (const toolCall of toolCalls) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        });
      }
    }
  }

  return { ...(instructions ? { instructions } : {}), input };
}

export function createLlmClient(config: LlmConfig): LlmClient {
  const endpoints: Endpoint[] = [];

  // ECS endpoint (OpenAI-compatible vLLM)
  if (config.ecs.endpoint) {
    endpoints.push({
      name: 'ecs', url: config.ecs.endpoint, model: config.ecs.model,
      timeoutMs: config.ecs.requestTimeoutMs, healthy: false, retryCount: 0,
      useOllamaApi: false, apiKey: config.ecs.apiKey,
      apiMode: config.ecs.apiMode ?? 'chat-completions',
      dialect: config.ecs.dialect ?? 'qwen',
      reasoningEffort: config.ecs.reasoningEffort,
      authMode: config.ecs.authMode ?? 'apiKey',
      requestAuthorizer: config.ecs.requestAuthorizer,
    });
  }

  // Ollama endpoint (native API with think control)
  if (config.ollama.endpoint) {
    endpoints.push({
      name: 'ollama', url: config.ollama.endpoint, model: config.ollama.model,
      timeoutMs: config.ollama.requestTimeoutMs, healthy: false, retryCount: 0,
      useOllamaApi: true, apiMode: 'chat-completions',
    });
  }

  let healthTimer: ReturnType<typeof setInterval> | null = null;

  function getOrderedEndpoints(): Endpoint[] {
    const healthy = endpoints.filter(e => e.healthy);
    if (healthy.length > 0) return healthy;
    return endpoints; // try all if none known healthy
  }

  /**
   * Auth headers for an OpenAI-compatible request. A requestAuthorizer is
   * preferred and is invoked on every request so it can refresh short-lived
   * credentials. authMode/apiKey remain as backward-compatible fallbacks.
   */
  async function buildAuthHeaders(ep: Endpoint, url: string, method: 'GET' | 'POST', body?: string): Promise<Record<string, string>> {
    const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ep.requestAuthorizer) {
      const authorizedHeaders = await ep.requestAuthorizer({
        url,
        method,
        ...(body !== undefined ? { body } : {}),
      });
      return { ...baseHeaders, ...authorizedHeaders };
    }
    if (ep.authMode === 'sigv4') {
      return { ...baseHeaders, ...await signBedrockRequest(url, method, body) };
    }
    if (ep.apiKey) baseHeaders.Authorization = `Bearer ${ep.apiKey}`;
    return baseHeaders;
  }

  /**
   * POST with per-request authorization and a single 401 retry. When the
   * endpoint's authorizer caches credentials (OAuth client-credentials), a 401
   * means the cached token was revoked out-of-band; invalidate and re-send
   * once with freshly built headers. Bodies are pre-serialized because SigV4
   * signs the payload hash — the signed and sent bytes must be identical.
   */
  async function postWithAuthRetry(
    ep: Endpoint,
    url: string,
    bodyStr: string,
    init: { signal?: AbortSignal } = {},
  ): Promise<Response> {
    const send = async (): Promise<Response> => {
      const headers = await buildAuthHeaders(ep, url, 'POST', bodyStr);
      return fetch(url, { method: 'POST', headers, body: bodyStr, ...init });
    };
    let resp = await send();
    if (resp.status === 401 && typeof ep.requestAuthorizer?.invalidate === 'function') {
      ep.requestAuthorizer.invalidate();
      resp = await send();
    }
    return resp;
  }

  function remoteRequestUrl(ep: Endpoint): string {
    const base = ep.url.replace(/\/+$/, '');
    if (ep.apiMode === 'responses') {
      return base.endsWith('/responses') ? base : `${base}/responses`;
    }
    if (base.endsWith('/chat/completions')) return base;
    return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  }

  async function probeEndpoint(ep: Endpoint): Promise<boolean> {
    try {
      if (!ep.useOllamaApi && ep.apiMode === 'responses') {
        // Bedrock Mantle has no generic application health route. A tiny
        // Responses request verifies model access and bearer authentication.
        const url = remoteRequestUrl(ep);
        const body = JSON.stringify({
          model: ep.model,
          input: [{ role: 'user', content: 'ping' }],
          max_output_tokens: 16,
          reasoning: { effort: 'low' },
          store: false,
          stream: false,
        });
        const resp = await postWithAuthRetry(ep, url, body, { signal: AbortSignal.timeout(30000) });
        return resp.ok;
      }
      if (!ep.useOllamaApi && ep.apiMode === 'chat-completions' && new URL(ep.url).hostname.startsWith('bedrock-runtime.')) {
        // Legacy Bedrock's OpenAI-compat surface has no /health or /models
        // route, so probe with a minimal Chat Completions request regardless
        // of whether that endpoint uses SigV4 or an explicit bearer token.
        const url = remoteRequestUrl(ep);
        const body = JSON.stringify({ model: ep.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 });
        const headers = await buildAuthHeaders(ep, url, 'POST', body);
        const resp = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
        return resp.ok;
      }
      const url = ep.useOllamaApi ? `${ep.url}/api/tags` : `${ep.url}/health`;
      const headers = ep.useOllamaApi ? {} : await buildAuthHeaders(ep, url, 'GET');
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000), headers });
      return resp.ok;
    } catch { return false; }
  }

  async function runHealthCheck(): Promise<void> {
    for (const ep of endpoints) {
      ep.healthy = await probeEndpoint(ep);
    }
  }

  // Build request body for Ollama native API
  function buildOllamaBody(ep: Endpoint, req: ChatCompletionRequest): any {
    return {
      model: ep.model,
      messages: req.messages.map(m => ({ role: m.role, content: m.content || '' })),
      stream: false,
      think: req.think ?? false,
      keep_alive: '30m',
      options: { num_predict: req.maxTokens ?? config.defaults.maxCompletionTokens, temperature: req.temperature ?? config.defaults.temperature },
      ...(req.tools?.length ? { tools: req.tools } : {}),
      ...(req.responseFormat?.type === 'json_object' ? { format: 'json' } : {}),
    };
  }

  /** Dialect-specific request fields shared by streaming and non-streaming bodies. */
  function dialectFields(ep: Endpoint, req: ChatCompletionRequest): any {
    if (ep.dialect === 'kimi') {
      // K3 always thinks; effort is the knob. think:false (pipeline/structured
      // calls) maps to 'low' for speed — same intent as the Qwen enable_thinking
      // gate (#24). think:true uses the configured effort (default 'max').
      return { reasoning_effort: req.think === true ? (req.reasoningEffort ?? ep.reasoningEffort ?? 'max') : 'low' };
    }
    if (ep.dialect === 'openai') return {};
    // Qwen3.5: thinking off unless the caller opts in (unchanged behavior).
    return { chat_template_kwargs: { enable_thinking: req.think === true } };
  }

  // Build request body for OpenAI-compatible Chat Completions (vLLM).
  /** Blessed per-request override beats the endpoint default; Ollama never overrides. */
  function effectiveModel(ep: Endpoint, req: ChatCompletionRequest): string {
    return !ep.useOllamaApi && req.model ? req.model : ep.model;
  }

  function buildOpenAIBody(ep: Endpoint, req: ChatCompletionRequest): any {
    return {
      model: effectiveModel(ep, req),
      messages: toWireMessages(ep, req.messages),
      temperature: req.temperature ?? config.defaults.temperature,
      max_tokens: req.maxTokens ?? config.defaults.maxCompletionTokens,
      ...dialectFields(ep, req),
      ...(req.tools?.length ? { tools: req.tools } : {}),
      ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
      stream: false,
    };
  }

  function responsesReasoningEffort(ep: Endpoint, req: ChatCompletionRequest): 'low' | 'high' {
    if (req.think !== true) return 'low';
    const effort = req.reasoningEffort ?? ep.reasoningEffort;
    return effort === 'high' || effort === 'max' ? 'high' : 'low';
  }

  function buildResponsesBody(ep: Endpoint, req: ChatCompletionRequest, stream: boolean): any {
    const prompt = toResponsesInput(req.messages);
    return {
      model: effectiveModel(ep, req),
      ...prompt,
      max_output_tokens: req.maxTokens ?? config.defaults.maxCompletionTokens,
      reasoning: { effort: responsesReasoningEffort(ep, req) },
      // store:false disables server-side turn state. Request encrypted reasoning
      // so it can be replayed locally with function outputs on the next turn.
      include: ['reasoning.encrypted_content'],
      ...(req.tools?.length ? {
        tools: req.tools.map(tool => ({
          type: 'function',
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      } : {}),
      ...(req.responseFormat ? { text: { format: req.responseFormat } } : {}),
      store: false,
      stream,
    };
  }

  // Parse Ollama native response
  function parseOllamaResponse(data: any): ChatCompletionResponse {
    const msg = data.message || {};
    return {
      content: msg.content || '',
      reasoning: undefined,
      toolCalls: msg.tool_calls?.map((tc: any, i: number) => ({
        id: tc.id || `call_${i}`, type: 'function' as const,
        function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments) },
      })) ?? null,
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      },
      finishReason: msg.tool_calls?.length ? 'tool_calls' : (data.done ? 'stop' : 'length'),
    };
  }

  // Parse OpenAI-compatible response
  /**
   * @param toolsOffered whether the REQUEST actually supplied tool definitions.
   *   When it did not, any tool-call-shaped text must NOT be turned into an
   *   executable call — the caller withheld tools on purpose (see the chat
   *   loop's repeat-breaker kill-switch and its cap-synthesis call). Kimi still
   *   emits its markup in that situation, so we strip it from the prose but
   *   refuse to resurrect the call. (post-mortem 2026-08-05.)
   */
  function parseOpenAIResponse(data: any, toolsOffered = true): ChatCompletionResponse {
    const choice = data.choices?.[0] || {};
    const msg = choice.message || {};

    // vLLM with hermes parser should populate tool_calls, but some models
    // (e.g. Qwen2.5-Coder) emit tool calls as text in <tools> or <tool_call> tags.
    // Parse them from content if tool_calls is empty.
    let toolCalls: ToolCall[] | null = msg.tool_calls?.length ? msg.tool_calls : null;
    let content = msg.content || '';

    if (!toolCalls && content && !toolsOffered && hasKimiToolMarkup(content)) {
      // Tools were withheld: keep the prose, drop the markup, execute nothing.
      console.warn('[LLM] Ignoring tool-call markup — no tools were offered for this request');
      content = stripKimiToolMarkup(content);
    } else if (!toolCalls && content) {
      const parsed = parseToolCallsFromText(content);
      if (parsed.length > 0) {
        toolCalls = parsed;
        content = stripKimiToolMarkup(content)
          .replace(/<tools>[\s\S]*?<\/tools>/g, '')
          .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
          .replace(/<function=\w+>[\s\S]*?<\/function>/g, '')
          .replace(/\{"name"\s*:\s*"\w+"\s*,\s*"arguments"\s*:\s*\{[^}]*\}\s*\}/g, '')
          .replace(/<\/think>\s*$/g, '')
          .trim();
      }
    }

    return {
      content,
      // vLLM emits `reasoning` for qwen-style parsers and `reasoning_content`
      // for Kimi-K3's parser — accept both.
      reasoning: msg.reasoning_content || msg.reasoning || undefined,
      toolCalls,
      usage: parseProviderUsage(data),
      finishReason: choice.finish_reason || 'stop',
    };
  }

  function parseResponsesResponse(data: any, toolsOffered = true): ChatCompletionResponse {
    const providerError = data?.error;
    if (providerError || data?.status === 'failed' || data?.status === 'cancelled') {
      const detail = providerError?.message || providerError?.code || data?.status || 'unknown failure';
      throw new Error(`Responses API failed: ${detail}`);
    }

    const output = Array.isArray(data?.output) ? data.output : [];
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const item of output) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part?.type === 'output_text' && typeof part.text === 'string') textParts.push(part.text);
          if (part?.type === 'refusal' && typeof part.refusal === 'string') textParts.push(part.refusal);
        }
      } else if (item?.type === 'function_call') {
        const rawArguments = item.arguments ?? '{}';
        toolCalls.push({
          id: item.call_id || item.id || `call_${Date.now()}_${toolCalls.length}`,
          type: 'function',
          function: {
            name: item.name || '',
            arguments: typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments),
          },
        });
      } else if (item?.type === 'reasoning' && Array.isArray(item.summary)) {
        for (const summary of item.summary) {
          if (typeof summary?.text === 'string') reasoningParts.push(summary.text);
        }
      }
    }

    if (!toolsOffered && toolCalls.length > 0) {
      console.warn('[LLM] Ignoring Responses function calls — no tools were offered for this request');
      toolCalls.length = 0;
    }

    const content = textParts.length > 0
      ? textParts.join('')
      : (typeof data?.output_text === 'string' ? data.output_text : '');
    const incompleteReason = data?.incomplete_details?.reason;
    const finishReason: 'stop' | 'tool_calls' | 'length' = toolCalls.length > 0
      ? 'tool_calls'
      : (data?.status === 'incomplete' || incompleteReason === 'max_output_tokens' ? 'length' : 'stop');

    return {
      content,
      reasoning: reasoningParts.join('') || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      usage: parseProviderUsage(data),
      finishReason,
      providerOutput: output,
    };
  }

  async function callEndpoint(ep: Endpoint, req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const isOllama = ep.useOllamaApi;
    const isResponses = !isOllama && ep.apiMode === 'responses';
    const url = isOllama ? `${ep.url}/api/chat` : remoteRequestUrl(ep);
    // Serialize ONCE: SigV4 signs the payload hash, so the signed string and
    // the sent string must be byte-identical.
    const body = isOllama
      ? buildOllamaBody(ep, req)
      : (isResponses ? buildResponsesBody(ep, req, false) : buildOpenAIBody(ep, req));
    const bodyStr = JSON.stringify(body);
    logLlmPrompt({ url, model: effectiveModel(ep, req), apiMode: isOllama ? 'ollama' : (ep.apiMode ?? 'chat-completions'), stream: false, request: body });

    const resp = await postWithAuthRetry(
      ep,
      url,
      bodyStr,
      ep.timeoutMs > 0 ? { signal: AbortSignal.timeout(ep.timeoutMs) } : {},
    );

    if (resp.status === 429 || resp.status === 503) {
      const wait = Math.min(1000 * Math.pow(2, ep.retryCount++), 30000);
      await new Promise(r => setTimeout(r, wait));
      throw new Error(`${resp.status} — retryable`);
    }

    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);

    const data = await resp.json();
    ep.retryCount = 0;
    ep.healthy = true;
    if (isOllama) return parseOllamaResponse(data);
    return isResponses
      ? parseResponsesResponse(data, (req.tools?.length ?? 0) > 0)
      : parseOpenAIResponse(data, (req.tools?.length ?? 0) > 0);
  }

  // ── Streaming: async generator for token-by-token SSE from vLLM ──

  function buildOpenAIStreamBody(ep: Endpoint, req: ChatCompletionRequest): any {
    return {
      model: effectiveModel(ep, req),
      messages: toWireMessages(ep, req.messages),
      temperature: req.temperature ?? config.defaults.temperature,
      max_tokens: req.maxTokens ?? config.defaults.maxCompletionTokens,
      ...dialectFields(ep, req),
      ...(req.tools?.length ? { tools: req.tools } : {}),
      ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
      stream: true,
      stream_options: { include_usage: true },
    };
  }

  async function* streamResponsesEndpoint(ep: Endpoint, req: ChatCompletionRequest): AsyncGenerator<StreamChunk, StreamResult, undefined> {
    const toolsOffered = (req.tools?.length ?? 0) > 0;
    const url = remoteRequestUrl(ep);
    const responsesBody = buildResponsesBody(ep, req, true);
    const bodyStr = JSON.stringify(responsesBody);
    logLlmPrompt({ url, model: effectiveModel(ep, req), apiMode: 'responses', stream: true, request: responsesBody });

    const idleMs = config.streamIdleTimeoutMs ?? 120000;
    const controller = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (idleMs > 0) {
        idleTimer = setTimeout(
          () => controller.abort(new Error(`LLM stream aborted: no data received for ${idleMs}ms`)),
          idleMs,
        );
      }
    };

    resetIdleTimer();
    let resp: Response;
    try {
      resp = await postWithAuthRetry(ep, url, bodyStr, { signal: controller.signal });
    } catch (err) {
      if (idleTimer) clearTimeout(idleTimer);
      throw err;
    }

    if (!resp.ok) {
      if (idleTimer) clearTimeout(idleTimer);
      throw new Error(`HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    }
    if (!resp.body) {
      if (idleTimer) clearTimeout(idleTimer);
      throw new Error('No response body for streaming');
    }

    ep.healthy = true;
    ep.retryCount = 0;

    let contentAcc = '';
    let reasoningAcc = '';
    const toolCallsAcc = new Map<number, { id: string; name: string; arguments: string }>();
    const startedToolCalls = new Set<number>();
    let usageAcc: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let finishReason: 'stop' | 'tool_calls' | 'length' = 'stop';
    let providerOutputAcc: unknown[] | undefined;
    let terminalEventReceived = false;
    let ignoredUnexpectedToolCalls = false;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          resetIdleTimer();
          buffer += decoder.decode(value, { stream: true });
        }
        if (done) {
          buffer += decoder.decode();
          // Process a final SSE data line even when the server closes without a
          // trailing newline. Success still requires an explicit terminal event.
          if (buffer && !buffer.endsWith('\n')) buffer += '\n';
        }

        const lines = buffer.split('\n');
        buffer = done ? '' : (lines.pop() || '');

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;

          let event: any;
          try { event = JSON.parse(payload); } catch { continue; }
          const eventType = event.type;

          if (eventType === 'error') {
            throw new Error(`Responses stream failed: ${event.message || event.code || 'unknown error'}`);
          }
          if (eventType === 'response.failed' || eventType === 'response.cancelled') {
            const failure = event.response?.error || event.error;
            throw new Error(`Responses stream failed: ${failure?.message || failure?.code || eventType}`);
          }

          if (eventType === 'response.output_text.delta' && typeof event.delta === 'string') {
            contentAcc += event.delta;
            yield { type: 'content', text: event.delta };
            continue;
          }
          if (eventType === 'response.refusal.delta' && typeof event.delta === 'string') {
            contentAcc += event.delta;
            yield { type: 'content', text: event.delta };
            continue;
          }
          if (eventType === 'response.reasoning_summary_text.delta' && typeof event.delta === 'string') {
            reasoningAcc += event.delta;
            yield { type: 'thinking', text: event.delta };
            continue;
          }

          if (eventType === 'response.output_item.added' && event.item?.type === 'function_call') {
            if (!toolsOffered) {
              ignoredUnexpectedToolCalls = true;
              continue;
            }
            const index = Number.isInteger(event.output_index) ? event.output_index : toolCallsAcc.size;
            const rawArguments = typeof event.item.arguments === 'string' ? event.item.arguments : '';
            const call = {
              id: event.item.call_id || event.item.id || `call_${Date.now()}_${index}`,
              name: event.item.name || '',
              arguments: rawArguments,
            };
            toolCallsAcc.set(index, call);
            startedToolCalls.add(index);
            yield { type: 'tool_call_start', toolCall: { index, id: call.id, name: call.name } };
            if (rawArguments) {
              yield { type: 'tool_call_args', toolCall: { index, arguments: rawArguments } };
            }
            continue;
          }

          if (eventType === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
            if (!toolsOffered) {
              ignoredUnexpectedToolCalls = true;
              continue;
            }
            const index = Number.isInteger(event.output_index) ? event.output_index : 0;
            let call = toolCallsAcc.get(index);
            if (!call) {
              call = { id: event.item_id || `call_${Date.now()}_${index}`, name: '', arguments: '' };
              toolCallsAcc.set(index, call);
            }
            if (!startedToolCalls.has(index)) {
              startedToolCalls.add(index);
              yield { type: 'tool_call_start', toolCall: { index, id: call.id, name: call.name } };
            }
            call.arguments += event.delta;
            yield { type: 'tool_call_args', toolCall: { index, arguments: event.delta } };
            continue;
          }

          if (eventType === 'response.function_call_arguments.done' && typeof event.arguments === 'string') {
            if (!toolsOffered) {
              ignoredUnexpectedToolCalls = true;
              continue;
            }
            const index = Number.isInteger(event.output_index) ? event.output_index : 0;
            const call = toolCallsAcc.get(index);
            if (call) call.arguments = event.arguments;
            continue;
          }

          if (eventType === 'response.output_item.done' && event.item?.type === 'function_call') {
            if (!toolsOffered) {
              ignoredUnexpectedToolCalls = true;
              continue;
            }
            const index = Number.isInteger(event.output_index) ? event.output_index : toolCallsAcc.size;
            const existing = toolCallsAcc.get(index);
            const rawArguments = typeof event.item.arguments === 'string' ? event.item.arguments : '{}';
            const call = existing ?? {
              id: event.item.call_id || event.item.id || `call_${Date.now()}_${index}`,
              name: event.item.name || '',
              arguments: rawArguments,
            };
            call.id = event.item.call_id || event.item.id || call.id;
            call.name = event.item.name || call.name;
            call.arguments = rawArguments;
            toolCallsAcc.set(index, call);
            if (!startedToolCalls.has(index)) {
              startedToolCalls.add(index);
              yield { type: 'tool_call_start', toolCall: { index, id: call.id, name: call.name } };
              if (call.arguments) {
                yield { type: 'tool_call_args', toolCall: { index, arguments: call.arguments } };
              }
            }
            continue;
          }

          if (eventType === 'response.completed' || eventType === 'response.incomplete') {
            terminalEventReceived = true;
            const completed = parseResponsesResponse(event.response, toolsOffered);
            providerOutputAcc = completed.providerOutput;
            usageAcc = completed.usage;
            finishReason = completed.finishReason;
            if (!contentAcc && completed.content) {
              contentAcc = completed.content;
              yield { type: 'content', text: completed.content };
            }
            if (!reasoningAcc && completed.reasoning) {
              reasoningAcc = completed.reasoning;
              yield { type: 'thinking', text: completed.reasoning };
            }
            for (const parsedCall of completed.toolCalls ?? []) {
              const existingEntry = [...toolCallsAcc.entries()]
                .find(([, call]) => call.id === parsedCall.id);
              if (existingEntry) {
                existingEntry[1].name = parsedCall.function.name || existingEntry[1].name;
                existingEntry[1].arguments = parsedCall.function.arguments;
                continue;
              }
              const index = toolCallsAcc.size;
              toolCallsAcc.set(index, {
                id: parsedCall.id,
                name: parsedCall.function.name,
                arguments: parsedCall.function.arguments,
              });
              startedToolCalls.add(index);
              yield { type: 'tool_call_start', toolCall: { index, id: parsedCall.id, name: parsedCall.function.name } };
              if (parsedCall.function.arguments) {
                yield { type: 'tool_call_args', toolCall: { index, arguments: parsedCall.function.arguments } };
              }
            }
          }
        }
        if (done) break;
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      reader.releaseLock();
    }

    if (!terminalEventReceived) {
      throw new Error('LLM Responses stream terminated before a completed or incomplete terminal event');
    }
    if (ignoredUnexpectedToolCalls) {
      console.warn('[LLM] Ignoring streamed Responses function calls — no tools were offered for this request');
    }
    const toolCalls: ToolCall[] = [...toolCallsAcc.values()]
      .filter(call => call.name)
      .map(call => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments || '{}' },
      }));
    if (toolCalls.length > 0) finishReason = 'tool_calls';

    yield { type: 'done', usage: usageAcc };
    return {
      content: contentAcc,
      reasoning: reasoningAcc,
      toolCalls,
      usage: usageAcc,
      finishReason,
      providerOutput: providerOutputAcc,
    };
  }

  async function* streamEndpoint(ep: Endpoint, req: ChatCompletionRequest): AsyncGenerator<StreamChunk, StreamResult, undefined> {
    if (ep.apiMode === 'responses') {
      return yield* streamResponsesEndpoint(ep, req);
    }
    // Did the caller actually offer tools this turn? An empty array is a
    // deliberate "no tools" signal, not an omission.
    const toolsOffered = (req.tools?.length ?? 0) > 0;
    const url = remoteRequestUrl(ep);
    // Serialize ONCE — sigv4 signs the payload hash (see callEndpoint).
    const openAiStreamBody = buildOpenAIStreamBody(ep, req);
    const bodyStr = JSON.stringify(openAiStreamBody);
    logLlmPrompt({ url, model: effectiveModel(ep, req), apiMode: 'chat-completions', stream: true, request: openAiStreamBody });
    // Whether the caller opted into chain-of-thought. When false, Qwen3.5 emits
    // plain content with NO <think>/</think> tags — so we must NOT treat content
    // as "thinking" just because a </think> marker is absent.
    const thinkingEnabled = req.think === true;

    // Idle watchdog (no absolute deadline — long generations are fine, but a
    // healthy stream produces bytes continuously). The abort message contains
    // 'aborted' on purpose: the chat route's transient-error detector treats it
    // as retryable and restarts the stream once, same as a network flap.
    const idleMs = config.streamIdleTimeoutMs ?? 120000;
    const controller = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (idleMs > 0) {
        idleTimer = setTimeout(
          () => controller.abort(new Error(`LLM stream aborted: no data received for ${idleMs}ms`)),
          idleMs,
        );
      }
    };

    resetIdleTimer(); // also covers time-to-first-byte (prefill)
    let resp: Response;
    try {
      resp = await postWithAuthRetry(ep, url, bodyStr, { signal: controller.signal });
    } catch (err) {
      if (idleTimer) clearTimeout(idleTimer);
      throw err;
    }

    if (!resp.ok) {
      if (idleTimer) clearTimeout(idleTimer);
      throw new Error(`HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    }
    if (!resp.body) {
      if (idleTimer) clearTimeout(idleTimer);
      throw new Error('No response body for streaming');
    }

    ep.healthy = true;
    ep.retryCount = 0;

    // Accumulate full response
    let contentAcc = '';
    let reasoningAcc = '';
    const toolCallsAcc: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let usageAcc: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let finishReason: 'stop' | 'tool_calls' | 'length' = 'stop';

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        resetIdleTimer();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]') continue; // usage comes in the last chunk before [DONE]

          let chunk: any;
          try { chunk = JSON.parse(payload); } catch { continue; }

          // Usage info (vLLM sends this in the final chunk with stream_options.include_usage)
          if (chunk.usage) {
            usageAcc = parseProviderUsage({ usage: chunk.usage });
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          if (choice.finish_reason) {
            finishReason = choice.finish_reason === 'tool_calls' ? 'tool_calls' : (choice.finish_reason === 'length' ? 'length' : 'stop');
          }

          const delta = choice.delta;
          if (!delta) continue;

          // Reasoning tokens (from --reasoning-parser qwen3)
          // vLLM uses delta.reasoning (not delta.reasoning_content)
          if (delta.reasoning_content || delta.reasoning) {
            const text = delta.reasoning_content || delta.reasoning;
            reasoningAcc += text;
            yield { type: 'thinking', text };
          }

          // Content tokens — detect thinking via </think> marker
          // Qwen3.5 with qwen3_xml parser: starts in thinking mode (no <think> tag),
          // ends thinking with </think>, then emits response text
          if (delta.content) {
            const wasInToolMarkup = hasKimiToolMarkup(contentAcc);
            contentAcc += delta.content;

            // Kimi streams tool calls as content tokens. Once the markup
            // starts, stop forwarding tokens to the UI — otherwise the user
            // watches `<|tool_call_begin|>functions.write_file...` scroll past
            // and the raw JSON of the file they asked for. The accumulated text
            // is still parsed into real tool calls after the stream ends.
            if (hasKimiToolMarkup(contentAcc)) {
              // Forward only the prose that preceded the markup start, once.
              if (!wasInToolMarkup) {
                const visible = delta.content.split('<|tool_call')[0];
                if (visible) yield { type: 'content', text: visible };
              }
            } else if (!thinkingEnabled) {
              // Thinking disabled: model streams plain content with no
              // <think>/</think> tags. Emit directly as content — otherwise every
              // token gets misclassified as "thinking" (the "stuck in thoughts" bug).
              yield { type: 'content', text: delta.content };
            } else {
              // Check if we've seen </think> yet in the accumulated content
              const thinkEndIdx = contentAcc.indexOf('</think>');
              const seenThinkEnd = thinkEndIdx !== -1;

              if (!seenThinkEnd) {
                // Still in thinking mode — yield as thinking (strip any <think> tag)
                const cleaned = delta.content.replace(/<\/?think>/g, '');
                if (cleaned) {
                  reasoningAcc += cleaned;
                  yield { type: 'thinking', text: cleaned };
                }
              } else {
                // We've passed </think> — check if this token contains the boundary
                const prevLen = contentAcc.length - delta.content.length;
                if (prevLen < thinkEndIdx + 8) {
                  // This token spans the </think> boundary — split it
                  const beforeEnd = contentAcc.substring(prevLen, thinkEndIdx);
                  const afterEnd = contentAcc.substring(thinkEndIdx + 8); // 8 = '</think>'.length
                  const cleanedThink = beforeEnd.replace(/<\/?think>/g, '');
                  if (cleanedThink) {
                    reasoningAcc += cleanedThink;
                    yield { type: 'thinking', text: cleanedThink };
                  }
                  const cleanedContent = afterEnd.replace(/^\n+/, ''); // strip leading newlines after </think>
                  if (cleanedContent) {
                    yield { type: 'content', text: cleanedContent };
                  }
                } else {
                  // Fully past </think> — all content
                  yield { type: 'content', text: delta.content };
                }
              }
            }
          }

          // Tool call chunks (streamed incrementally)
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsAcc.has(idx)) {
                toolCallsAcc.set(idx, { id: tc.id || `call_${Date.now()}_${idx}`, name: '', arguments: '' });
              }
              const acc = toolCallsAcc.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) {
                acc.name += tc.function.name;
                yield { type: 'tool_call_start', toolCall: { index: idx, id: acc.id, name: tc.function.name } };
              }
              if (tc.function?.arguments) {
                acc.arguments += tc.function.arguments;
                yield { type: 'tool_call_args', toolCall: { index: idx, arguments: tc.function.arguments } };
              }
            }
          }
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      reader.releaseLock();
    }

    // Build final tool calls array
    const toolCalls: ToolCall[] = [];
    for (const [, tc] of toolCallsAcc) {
      if (tc.name) {
        toolCalls.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } });
      }
    }

    // Tools deliberately withheld (repeat-breaker kill-switch / cap synthesis):
    // Kimi still emits its markup, but resurrecting the call here would defeat
    // the caller's whole reason for withholding them. Strip, don't execute.
    if (toolCalls.length === 0 && !toolsOffered && hasKimiToolMarkup(contentAcc)) {
      console.warn('[LLM] Ignoring streamed tool-call markup — no tools were offered for this request');
      contentAcc = stripKimiToolMarkup(contentAcc);
    } else if (toolCalls.length === 0 && contentAcc) {
      // If no structured tool calls, try text parsing fallback
      const parsed = parseToolCallsFromText(contentAcc);
      if (parsed.length > 0) {
        toolCalls.push(...parsed);
        contentAcc = stripKimiToolMarkup(contentAcc)
          .replace(/<tools>[\s\S]*?<\/tools>/g, '')
          .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
          .replace(/<function=\w+>[\s\S]*?<\/function>/g, '')
          .replace(/\{"name"\s*:\s*"\w+"\s*,\s*"arguments"\s*:\s*\{[^}]*\}\s*\}/g, '')
          .trim();
        finishReason = 'tool_calls';
      }
    }

    // Also check reasoning for tool calls (Qwen3 with reasoning parser sometimes
    // emits tool call XML in the thinking/reasoning field instead of content)
    if (toolCalls.length === 0 && reasoningAcc && toolsOffered) {
      console.log(`[LLM] No tool calls in content (${contentAcc.length} chars), checking reasoning (${reasoningAcc.length} chars)...`);
      const parsed = parseToolCallsFromText(reasoningAcc);
      console.log(`[LLM] Parsed ${parsed.length} tool calls from reasoning`);
      if (parsed.length > 0) {
        toolCalls.push(...parsed);
        finishReason = 'tool_calls';
      } else if (reasoningAcc.length > 0) {
        console.log(`[LLM] Reasoning tail: ${reasoningAcc.slice(-400)}`);
      }
    }

    yield { type: 'done', usage: usageAcc };

    return {
      content: contentAcc,
      reasoning: reasoningAcc,
      toolCalls,
      usage: usageAcc,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : finishReason,
    };
  }

  // Start one initial health check. A zero/negative interval disables periodic
  // polling while leaving explicit healthCheck() calls available.
  runHealthCheck().catch(() => {});
  if (config.healthCheckIntervalMs > 0) {
    healthTimer = setInterval(() => runHealthCheck().catch(() => {}), config.healthCheckIntervalMs);
  }

  return {
    getDefaultModel(): string {
      const primary = endpoints.find(ep => !ep.useOllamaApi) ?? endpoints[0];
      return primary?.model ?? '';
    },

    async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
      const ordered = getOrderedEndpoints();
      let lastError: Error | null = null;

      for (const ep of ordered) {
        try {
          return await callEndpoint(ep, request);
        } catch (err: any) {
          ep.healthy = false;
          lastError = err;
          if (!config.fallbackEnabled) throw err;
        }
      }
      throw lastError ?? new Error('All LLM endpoints unavailable');
    },

    async *chatCompletionStream(request: ChatCompletionRequest): AsyncGenerator<StreamChunk, StreamResult, undefined> {
      // Streaming only supported on OpenAI-compatible endpoints (ECS/vLLM), not Ollama
      const ecsEp = endpoints.find(e => !e.useOllamaApi);
      if (!ecsEp) throw new Error('Streaming requires an OpenAI-compatible endpoint (ECS/vLLM)');

      try {
        return yield* streamEndpoint(ecsEp, request);
      } catch (err: any) {
        ecsEp.healthy = false;
        throw err;
      }
    },

    // Backward-compatible sendPrompt (wraps chatCompletion)
    async sendPrompt(prompt: string): Promise<AcpResponse> {
      const resp = await this.chatCompletion({
        messages: [{ role: 'user', content: prompt }],
      });
      return { content: resp.content };
    },

    // Backward-compatible sendMessage
    async sendMessage(messages: AcpChatMessage[]): Promise<AcpResponse> {
      const text = messages.map(m => m.content).join('\n');
      return this.sendPrompt(text);
    },

    // No-op initialize for backward compat
    async initialize(): Promise<void> {},

    isAvailable(): boolean {
      return endpoints.some(e => e.healthy);
    },

    getActiveEndpoint(): 'ecs' | 'ollama' | 'none' {
      const healthy = endpoints.find(e => e.healthy);
      return healthy?.name ?? 'none';
    },

    getActiveModel(): string | undefined {
      return endpoints.find(e => e.healthy)?.model;
    },

    getDialect(): LlmDialect {
      return config.ecs.dialect ?? 'qwen';
    },

    getApiMode(): LlmApiMode {
      return config.ecs.apiMode ?? 'chat-completions';
    },

    getMaxCompletionTokens(): number {
      return config.defaults.maxCompletionTokens;
    },

    getContextWindow(): number {
      return config.ecs.maxContextTokens;
    },

    getContextBudgetTokens(): number {
      const active = endpoints.find((endpoint) => endpoint.healthy) ?? endpoints[0];
      // When failover is enabled the same already-assembled prompt may be sent
      // to any configured endpoint. Size against the smallest eligible window,
      // not merely whichever endpoint happened to answer the last probe.
      const eligible = config.fallbackEnabled ? endpoints : (active ? [active] : []);
      const safeInputBudgets = eligible.map((endpoint) => {
        const contextWindow = endpoint.name === 'ollama'
          ? config.ollama.maxContextTokens
          : config.ecs.maxContextTokens;
        const completionReserve = Math.min(config.defaults.maxCompletionTokens, Math.floor(contextWindow / 2));
        const serializationReserve = Math.min(4_096, Math.max(1_024, Math.floor(contextWindow * 0.02)));
        return Math.max(1_024, contextWindow - completionReserve - serializationReserve);
      });
      return Math.max(
        1_024,
        Math.min(config.defaults.contextBudgetTokens, ...safeInputBudgets),
      );
    },

    async healthCheck(): Promise<boolean> {
      await runHealthCheck();
      return this.isAvailable();
    },

    close(): void {
      if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    },
  };
}
