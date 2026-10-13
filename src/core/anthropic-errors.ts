/**
 * Anthropic API error classification (design v3 D10, L3).
 *
 * One pure function, `classifyAnthropicHttpError(status, headers, bodyText)`,
 * maps every documented non-2xx answer to a class the callers act on: Save-time
 * verification (`anthropic-models.ts › verifyAnthropicKey`) today and the
 * Messages client later. It performs no I/O and holds no state, so the whole
 * D10 table is tested once, here.
 *
 * Invariants:
 *   - Classification is by HTTP status first; the JSON body only refines a few
 *     rows (an owner-set spend limit is a 400, the tier spend cap is a 429, a
 *     missing workspace id is a 400, the thinking-related 400s).
 *   - A body that is not JSON (a Cloudflare 413 or 5xx page) or that has no
 *     `error` object maps by status alone; its text is never shown or logged.
 *   - Provider text that is kept (`providerMessage`) passes through
 *     `redactProviderSecrets` and is bounded. Nothing here ever sees the key.
 *   - Every 4xx except 401 is request-specific and never marks endpoint health
 *     (`marksHealth` is true only for 5xx answers); a 401 is a credential
 *     problem, recorded as the provider issue `auth_rejected`.
 */
import { redactProviderSecrets, retryAfterMs } from './llm-client.js';

export const ANTHROPIC_KEYS_URL = 'platform.claude.com/settings/keys';
export const ANTHROPIC_BILLING_URL = 'platform.claude.com/settings/billing';

export type AnthropicErrorKind =
  | 'auth_rejected'
  | 'quota_exhausted'
  | 'workspace_required'
  | 'invalid_request'
  | 'forbidden'
  | 'model_unavailable'
  | 'request_rejected'
  | 'payload_too_large'
  | 'rate_limited'
  | 'overloaded'
  | 'server_error';

/** Why a spend-related answer arrived: billing, a limit the owner set, or the tier's monthly cap. */
export type AnthropicQuotaCause = 'billing' | 'owner_limit' | 'tier_cap';

/** The documented causes of a 400 that BotBoy can name; everything else is `other`. */
export type AnthropicRequestCause =
  | 'thinking_type'
  | 'forced_tool_choice'
  | 'schema_too_complex'
  | 'thinking_replay'
  | 'other';

/** D10 "Class": terminal (retrying cannot help), request-specific, or transient. */
export type AnthropicErrorClass = 'terminal' | 'request' | 'transient';

/** The provider issue the client records for this answer, if any (matches `LlmProviderIssue.code`). */
export type AnthropicProviderIssueCode = 'auth_rejected' | 'quota_exhausted' | 'rate_limited' | 'overloaded';

/** Settings → AI model error codes this classification can produce at Save time. */
export type AnthropicSaveCode =
  | 'invalid_key'
  | 'no_credit'
  | 'workspace_required'
  | 'forbidden'
  | 'model_unavailable'
  | 'rate_limited'
  | 'provider_overloaded'
  | 'rejected';

export interface AnthropicErrorClassification {
  readonly status: number;
  readonly kind: AnthropicErrorKind;
  readonly class: AnthropicErrorClass;
  readonly logLevel: 'warn' | 'info';
  /** Credential or account problem to record, whichever route the call took. */
  readonly issue?: AnthropicProviderIssueCode;
  /** true only for 5xx answers: a route-less call may mark endpoint health until the next probe. */
  readonly marksHealth: boolean;
  /** `bounded`: the client's bounded retry-after loop applies (D7). */
  readonly retry: 'bounded' | 'none';
  /** A free GET /v1/models refresh is worth queueing (thinking-type 400, 404). */
  readonly refreshModels: boolean;
  readonly quotaCause?: AnthropicQuotaCause;
  readonly requestCause?: AnthropicRequestCause;
  /** Provider-requested wait for a 429 or 529, when it sent one. */
  readonly retryAfterMs?: number;
  /** Anthropic `error.type` from a JSON error body. */
  readonly errorType?: string;
  /** `request-id` header or body `request_id` (not a secret; useful to support). */
  readonly requestId?: string;
  /** Redacted, bounded `error.message`; present only for JSON error bodies. */
  readonly providerMessage?: string;
  /** Owner-facing text. Never contains key material or a raw body. */
  readonly message: string;
  readonly nextAction: string;
  readonly saveCode: AnthropicSaveCode;
  readonly saveStatus: number;
}

/** A non-2xx Anthropic answer, classified. `message` starts with `HTTP <status>`. */
export class AnthropicApiError extends Error {
  readonly code = 'ANTHROPIC_API_ERROR';
  constructor(readonly classification: AnthropicErrorClassification) {
    const type = classification.errorType ? ` (${classification.errorType})` : '';
    const detail = classification.providerMessage ?? classification.message;
    const request = classification.requestId ? ` [request ${classification.requestId}]` : '';
    super(`HTTP ${classification.status}${type}: ${detail}${request}`);
    this.name = 'AnthropicApiError';
  }
  get status(): number {
    return this.classification.status;
  }
}

/** The request never produced an answer (offline, DNS, TLS, timeout). */
export class AnthropicUnreachableError extends Error {
  readonly code = 'ANTHROPIC_UNREACHABLE';
  constructor() {
    super('BotBoy could not reach api.anthropic.com.');
    this.name = 'AnthropicUnreachableError';
  }
}

export function isAnthropicApiError(error: unknown): error is AnthropicApiError {
  return error instanceof AnthropicApiError || (error as { code?: unknown } | null)?.code === 'ANTHROPIC_API_ERROR';
}

export function isAnthropicUnreachableError(error: unknown): error is AnthropicUnreachableError {
  return error instanceof AnthropicUnreachableError || (error as { code?: unknown } | null)?.code === 'ANTHROPIC_UNREACHABLE';
}

interface ParsedErrorBody {
  type?: string;
  message?: string;
  errorCode?: string;
  requestId?: string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/** A request id is kept only if it is plain and survives secret redaction unchanged (a key-shaped id is dropped). */
function safeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) && redactProviderSecrets(value) === value ? value : undefined;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = redactProviderSecrets(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : undefined;
}

/** Anthropic's documented shape: `{type:'error', error:{type,message,details?}, request_id}`. Anything else = by status alone. */
function parseErrorBody(bodyText: string): ParsedErrorBody {
  let parsed: any;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {};
  }
  const error = parsed?.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return {};
  const requestId = safeRequestId(parsed.request_id);
  return {
    ...(boundedText(error.type, 64) ? { type: boundedText(error.type, 64) } : {}),
    ...(boundedText(error.message, 300) ? { message: boundedText(error.message, 300) } : {}),
    ...(typeof error.details?.error_code === 'string' ? { errorCode: error.details.error_code.slice(0, 80) } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

/**
 * A mid-stream `error` event (after a 200) carries only an `error.type`. The status each documented type stands
 * for (D10); a type the API adds later counts as 500, so a stream error is never mistaken for a request-level 4xx.
 */
const ERROR_TYPE_STATUS: Readonly<Record<string, number>> = Object.freeze({
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  conflict_error: 409,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
});

export function statusForAnthropicErrorType(type: unknown): number {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(ERROR_TYPE_STATUS, type) ? ERROR_TYPE_STATUS[type] : 500;
}

const USAGE_LIMIT_400 = /^you have reached your specified (workspace )?api usage limits/i;

/** Lead texts only: the trailing sentence of these 400s can change (S4). */
function requestCauseOf(message: string | undefined): AnthropicRequestCause {
  if (!message) return 'other';
  // The replay 400s mention `thinking` too, so they are tested before the generic thinking row.
  if (/invalid\s+[`'"]?signature[`'"]?\s+in\s+[`'"]?thinking[`'"]?\s+block/i.test(message)
    || /(thinking|redacted_thinking)[`'"\s\w,]*blocks?\s+in\s+the\s+latest\s+assistant\s+message\s+cannot\s+be\s+modified/i.test(message)) {
    return 'thinking_replay';
  }
  if (/schema\s+is\s+too\s+complex/i.test(message)) return 'schema_too_complex';
  if (/tool_choice|forced\s+tool/i.test(message)) return 'forced_tool_choice';
  if (/thinking/i.test(message) && /(not\s+supported|cannot\s+be|can'?t\s+be|must\s+be|is\s+required|not\s+allowed|enable\s+thinking|thinking\s+is\s+disabled)/i.test(message)) {
    return 'thinking_type';
  }
  return 'other';
}

const REQUEST_CAUSE_TEXT: Record<AnthropicRequestCause, { message: string; nextAction: string }> = {
  thinking_type: {
    message: 'This Claude model does not accept the Thinking setting BotBoy sent.',
    nextAction: 'Pick another Thinking level or another Claude model, then try again. BotBoy refreshes the model list on its own.',
  },
  forced_tool_choice: {
    message: 'This Claude model does not accept forced tool use.',
    nextAction: 'Pick another Claude model, then try again.',
  },
  schema_too_complex: {
    message: 'Claude could not compile the response format BotBoy asked for.',
    nextAction: 'Try again with a simpler request, or pick another Claude model.',
  },
  thinking_replay: {
    message: 'Claude could not verify the earlier reasoning in this conversation.',
    nextAction: 'Send the message again. BotBoy retries once without the earlier reasoning.',
  },
  other: {
    message: 'Anthropic rejected the request (HTTP 400).',
    nextAction: 'Try again. If it keeps failing, run ./start.sh --doctor and check /tmp/ppt.log.',
  },
};

const QUOTA_TEXT: Record<AnthropicQuotaCause, { message: string; nextAction: string }> = {
  billing: {
    message: 'Your Anthropic account has no available credit.',
    nextAction: `Add credit at ${ANTHROPIC_BILLING_URL}, then try again.`,
  },
  owner_limit: {
    message: 'Your Anthropic account has reached a spend limit you set.',
    nextAction: `Raise or remove the limit at ${ANTHROPIC_BILLING_URL}, then try again.`,
  },
  tier_cap: {
    message: "Your Anthropic account has reached its monthly spend cap.",
    nextAction: `Request a higher limit at ${ANTHROPIC_BILLING_URL}, or wait for the cap to reset on the first day of the month (00:00 UTC).`,
  },
};

/**
 * Which call the answer belongs to. A 403 on the model LIST is about the key (permissions, workspace); on a
 * generation it is about the model the request named.
 */
export type AnthropicCallContext = 'generation' | 'models';

type Core = Pick<AnthropicErrorClassification, 'kind' | 'class' | 'logLevel' | 'message' | 'nextAction' | 'saveCode' | 'saveStatus'>
  & Partial<Pick<AnthropicErrorClassification, 'issue' | 'marksHealth' | 'retry' | 'refreshModels' | 'quotaCause' | 'requestCause'>>;

function quota(cause: AnthropicQuotaCause): Core {
  return {
    kind: 'quota_exhausted', class: 'terminal', logLevel: 'warn', issue: 'quota_exhausted', quotaCause: cause,
    ...QUOTA_TEXT[cause], saveCode: 'no_credit', saveStatus: 400,
  };
}

function core(status: number, parsed: ParsedErrorBody, context: AnthropicCallContext): Core {
  if (status === 401) {
    return {
      kind: 'auth_rejected', class: 'terminal', logLevel: 'warn', issue: 'auth_rejected',
      message: 'Anthropic rejected this API key. It may be expired, revoked or malformed.',
      nextAction: `Copy a current key from ${ANTHROPIC_KEYS_URL} and try again.`,
      saveCode: 'invalid_key', saveStatus: 400,
    };
  }
  if (status === 402) return quota('billing');
  if (status === 400) {
    if (parsed.message && USAGE_LIMIT_400.test(parsed.message)) return quota('owner_limit');
    if (parsed.message && /anthropic-workspace-id/i.test(parsed.message) && /required/i.test(parsed.message)) {
      return {
        kind: 'workspace_required', class: 'request', logLevel: 'warn',
        message: 'This key is not tied to one workspace.',
        nextAction: 'Create a key scoped to one workspace (Console → Settings → API keys → Create key, choose a workspace), then save it here.',
        saveCode: 'workspace_required', saveStatus: 400,
      };
    }
    const requestCause = requestCauseOf(parsed.message);
    return {
      kind: 'invalid_request', class: 'request', logLevel: 'warn', requestCause,
      refreshModels: requestCause === 'thinking_type',
      ...REQUEST_CAUSE_TEXT[requestCause], saveCode: 'rejected', saveStatus: 502,
    };
  }
  if (status === 403) {
    // The model list is the key's own business: no model was named, so the wording is key-level.
    if (context === 'models') {
      return {
        kind: 'forbidden', class: 'request', logLevel: 'warn',
        message: 'This key is not allowed to list Claude models.',
        nextAction: `Check the key's permissions and workspace at ${ANTHROPIC_KEYS_URL}, or create a new key and save it here.`,
        saveCode: 'forbidden', saveStatus: 400,
      };
    }
    return {
      kind: 'forbidden', class: 'request', logLevel: 'warn',
      message: 'This key is not allowed to use that Claude model.',
      nextAction: `Check the key's workspace and model access at ${ANTHROPIC_KEYS_URL}, or pick another Claude model.`,
      saveCode: 'forbidden', saveStatus: 400,
    };
  }
  if (status === 404) {
    return {
      kind: 'model_unavailable', class: 'request', logLevel: 'warn', refreshModels: true,
      message: 'That Claude model is not available to this key.',
      nextAction: `Pick another Claude model in Settings → AI model, or check the key at ${ANTHROPIC_KEYS_URL}.`,
      saveCode: 'model_unavailable', saveStatus: 400,
    };
  }
  if (status === 413) {
    return {
      kind: 'payload_too_large', class: 'request', logLevel: 'warn',
      message: 'The request was larger than Anthropic accepts.',
      nextAction: 'Send fewer or smaller images and attachments, then try again.',
      saveCode: 'rejected', saveStatus: 502,
    };
  }
  if (status === 429) {
    // The tier spend cap is a rate_limit_error too; only error.details.error_code tells them apart,
    // and retrying it cannot succeed (no retry-after header).
    if (parsed.errorCode === 'enforced_spend_limit_reached') return quota('tier_cap');
    return {
      kind: 'rate_limited', class: 'transient', logLevel: 'info', issue: 'rate_limited', retry: 'bounded',
      message: 'Anthropic is rate-limiting this key right now.',
      nextAction: 'Wait a minute, then try again. New accounts have lower limits that rise with use.',
      saveCode: 'rate_limited', saveStatus: 429,
    };
  }
  if (status === 529) {
    return {
      kind: 'overloaded', class: 'transient', logLevel: 'info', issue: 'overloaded', retry: 'bounded',
      message: 'Anthropic is temporarily overloaded.',
      nextAction: 'Anthropic is busy. Try again in a minute.',
      saveCode: 'provider_overloaded', saveStatus: 503,
    };
  }
  if (status >= 500) {
    return {
      kind: 'server_error', class: 'transient', logLevel: 'info', marksHealth: true,
      message: `Anthropic had a temporary problem (HTTP ${status}).`,
      nextAction: 'Try again in a minute.',
      saveCode: 'rejected', saveStatus: 502,
    };
  }
  // 409 conflict_error and any other 4xx the API may add.
  return {
    kind: 'request_rejected', class: 'request', logLevel: 'warn',
    message: `Anthropic rejected the request (HTTP ${status}).`,
    nextAction: 'Try again. If it keeps failing, run ./start.sh --doctor and check /tmp/ppt.log.',
    saveCode: 'rejected', saveStatus: 502,
  };
}

/**
 * The wait Anthropic asked for, through the shared `retryAfterMs` parser.
 * Only delta-seconds (non-negative) and HTTP-dates are accepted: the shared
 * parser would read a stray `-5` through the legacy date parser as "now", so a
 * negative or malformed `retry-after` is ignored here (D7).
 */
function providerWaitMs(headers: Pick<Headers, 'get'>): number | undefined {
  const raw = headers.get('retry-after')?.trim();
  if (!raw || !(/^\d+(\.\d+)?$/.test(raw) || /^[A-Za-z]{3},\s/.test(raw))) return undefined;
  return retryAfterMs(headers);
}

/**
 * Classify one non-2xx Anthropic answer (D10). `headers` supplies `retry-after`
 * and `request-id`; `bodyText` is the raw body (JSON error object or anything);
 * `context` says whether the answer came from the model list or a generation.
 */
export function classifyAnthropicHttpError(
  status: number,
  headers: Pick<Headers, 'get'>,
  bodyText: string,
  context: AnthropicCallContext = 'generation',
): AnthropicErrorClassification {
  const parsed = parseErrorBody(typeof bodyText === 'string' ? bodyText : '');
  const base = core(status, parsed, context);
  const requestId = safeRequestId(headers.get('request-id')) ?? parsed.requestId;
  const wait = base.kind === 'rate_limited' || base.kind === 'overloaded' ? providerWaitMs(headers) : undefined;
  return {
    status,
    ...base,
    marksHealth: base.marksHealth ?? false,
    retry: base.retry ?? 'none',
    refreshModels: base.refreshModels ?? false,
    ...(wait !== undefined ? { retryAfterMs: wait } : {}),
    ...(parsed.type ? { errorType: parsed.type } : {}),
    ...(requestId ? { requestId } : {}),
    ...(parsed.message ? { providerMessage: parsed.message } : {}),
  };
}
