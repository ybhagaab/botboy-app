export type DataRoomToolName =
  | 'list_data_room_datasets'
  | 'query_data_room'
  | 'create_data_room_dataset'
  | 'configure_analytics_widget_source';

export type DataRoomFailurePhase =
  | 'arguments'
  | 'authorization'
  | 'policy'
  | 'admission'
  | 'execution'
  | 'observation';

export type DataRoomFailureCategory =
  | 'validation'
  | 'authorization'
  | 'policy'
  | 'not_found'
  | 'conflict'
  | 'integrity'
  | 'availability'
  | 'timeout'
  | 'cancelled'
  | 'execution';

export type DataRoomRetryClass =
  | 'correct_arguments'
  | 'refresh_state'
  | 'retry_transient'
  | 'observe_existing'
  | 'owner_action'
  | 'new_owner_request'
  | 'none';

export type DataRoomAuthorizationGate =
  | 'interactive_owner_turn'
  | 'owner_requested_attestation'
  | 'stable_owner_request'
  | 'exact_target_scope'
  | 'affirmative_owner_action'
  | 'model_context_policy'
  | 'owner_ui_import_approval';

export type DataRoomFailureExpectedV1 =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'enum'; values: Array<string | number | boolean | null> }
  | { kind: 'type'; type: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'scalar' }
  | { kind: 'pattern'; type: 'string'; pattern: string; example?: string }
  | { kind: 'range'; type: 'array' | 'string' | 'integer' | 'number'; minimum?: number; maximum?: number }
  | { kind: 'shape'; requiredKeys: string[]; allowedKeys: string[]; description?: string }
  | { kind: 'absent' }
  | { kind: 'relation'; description: string };

export interface DataRoomFailureReceivedV1 {
  type: 'missing' | 'null' | 'object' | 'array' | 'string' | 'number' | 'boolean' | 'other';
  value?: string | number | boolean | null;
  length?: number;
  keys?: string[];
  keyCount?: number;
}

export interface DataRoomFailureIssueV1 {
  code: string;
  path: string;
  message: string;
  expected: DataRoomFailureExpectedV1;
  received: DataRoomFailureReceivedV1;
}

export interface DataRoomFailureAuthorizationV1 {
  decision: 'allowed' | 'denied' | 'not_evaluated';
  callerClass: 'interactive_owner_chat' | 'background_agent' | 'unknown';
  requiredAuthority: string;
  checks: Array<{
    gate: DataRoomAuthorizationGate;
    passed: boolean;
    reason: string;
  }>;
}

export interface DataRoomFailureEffectV1 {
  state: 'none' | 'committed' | 'unknown';
  mutationApplied: boolean | 'unknown';
  durable: 'none' | 'created' | 'joined_existing' | 'unknown';
  externalCalls: number | 'unknown';
  jobId?: string;
  runId?: string;
  receiptSha256?: string;
}

export interface DataRoomToolFailureV1 {
  version: 1;
  type: 'data_room_tool_failure';
  ok: false;
  tool: DataRoomToolName;
  status: 'blocked' | 'failed';
  phase: DataRoomFailurePhase;
  category: DataRoomFailureCategory;
  code: string;
  message: string;
  issues: DataRoomFailureIssueV1[];
  retry: {
    class: DataRoomRetryClass;
    safe: boolean;
  };
  effect: DataRoomFailureEffectV1;
  authorization: DataRoomFailureAuthorizationV1;
  target?: {
    datasetId?: string;
    versionId?: string;
    jobId?: string;
    dashboardId?: string;
    widgetId?: string;
    runId?: string;
  };
  cause?: {
    code: string;
    message: string;
  };
  nextAction: string;
}

export interface DataRoomIssueCarrier {
  issues?: DataRoomFailureIssueV1[];
}

const MAX_ISSUES = 8;
const MAX_MESSAGE_CHARS = 1_000;
const MAX_PATH_CHARS = 240;
const MAX_CODE_CHARS = 100;
const MAX_RECEIVED_KEYS = 24;
const MAX_LITERAL_CHARS = 160;
const SAFE_PROJECTED_ERROR_CODES = new Set([
  'invalid_input', 'query_unsupported', 'query_timeout', 'query_cancelled',
  'integrity_failed', 'policy_denied', 'conflict', 'not_found', 'unavailable',
  'data_room_unavailable', 'cancelled', 'owner_context_required',
  'owner_request_required', 'owner_scope_mismatch', 'owner_action_mismatch',
  'archived', 'active_run', 'binding_required', 'binding_not_compatible',
  'result_provenance_mismatch', 'max_widgets', 'derived_data_required',
  'request_identity_conflict', 'replay_target_invalid', 'unsupported',
  'timeout', 'widget_run_failed', 'repeated_call',
]);

function boundedText(value: unknown, maximum: number, fallback: string): string {
  const text = String(value ?? '')
    .replace(/\0/g, '')
    .replace(/https?:\/\/[^\s"'`]+/gi, '[endpoint omitted]')
    .replace(/(?:~\/|\/(?:Users|home|private|tmp|var|Volumes|opt|etc|root|mnt|srv|usr|Library)\/)[^"'`\n\r,;)\]}]*/gi, '[private path omitted]')
    .replace(/[A-Za-z]:\\[^"'`\n\r,;)\]}]*/g, '[private path omitted]')
    .trim();
  return (text || fallback).slice(0, maximum);
}

function boundedCode(value: unknown, fallback: string): string {
  const code = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_CODE_CHARS);
  return code || fallback;
}

export function dataRoomReceived(
  value: unknown,
  options: { includeValue?: boolean } = {},
): DataRoomFailureReceivedV1 {
  if (value === undefined) return { type: 'missing' };
  if (value === null) return { type: 'null', value: null };
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return {
      type: 'object',
      keys: keys.slice(0, MAX_RECEIVED_KEYS),
      keyCount: keys.length,
    };
  }
  if (typeof value === 'string') {
    const received: DataRoomFailureReceivedV1 = { type: 'string', length: value.length };
    if (options.includeValue && value.length <= MAX_LITERAL_CHARS && !/[\0\r\n]/.test(value)) {
      received.value = boundedText(value, MAX_LITERAL_CHARS, '[value omitted]');
    }
    return received;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { type: 'number', ...(options.includeValue ? { value } : {}) }
      : { type: 'number' };
  }
  if (typeof value === 'boolean') {
    return { type: 'boolean', ...(options.includeValue ? { value } : {}) };
  }
  return { type: 'other' };
}

export function dataRoomIssue(input: {
  code: string;
  path: string;
  message: string;
  expected: DataRoomFailureExpectedV1;
  received: unknown;
  includeReceivedValue?: boolean;
}): DataRoomFailureIssueV1 {
  return {
    code: boundedCode(input.code, 'invalid_value'),
    path: boundedText(input.path, MAX_PATH_CHARS, '$'),
    message: boundedText(input.message, MAX_MESSAGE_CHARS, 'The supplied value was rejected.'),
    expected: input.expected,
    received: dataRoomReceived(input.received, { includeValue: input.includeReceivedValue }),
  };
}

export function prefixDataRoomIssues(
  prefix: string,
  issues: DataRoomFailureIssueV1[],
): DataRoomFailureIssueV1[] {
  const normalized = prefix.replace(/\.$/, '');
  return issues.slice(0, MAX_ISSUES).map(issue => ({
    ...issue,
    path: issue.path === '$'
      ? normalized
      : `${normalized}.${issue.path}`.replace(/\.\[/g, '[').slice(0, MAX_PATH_CHARS),
  }));
}

export function dataRoomAuthorization(input: {
  callerKind?: 'interactive' | 'background';
  requiredAuthority: string;
  checks?: DataRoomFailureAuthorizationV1['checks'];
  decision?: DataRoomFailureAuthorizationV1['decision'];
}): DataRoomFailureAuthorizationV1 {
  const checks = (input.checks ?? []).slice(0, 8).map(check => ({
    gate: check.gate,
    passed: check.passed,
    reason: boundedText(check.reason, 500, check.passed ? 'Gate passed.' : 'Gate failed.'),
  }));
  return {
    decision: input.decision ?? (checks.length ? (checks.every(check => check.passed) ? 'allowed' : 'denied') : 'not_evaluated'),
    callerClass: input.callerKind === 'interactive'
      ? 'interactive_owner_chat'
      : input.callerKind === 'background'
        ? 'background_agent'
        : 'unknown',
    requiredAuthority: boundedText(input.requiredAuthority, 500, 'Data Room tool authority'),
    checks,
  };
}

export function dataRoomNoEffect(): DataRoomFailureEffectV1 {
  return {
    state: 'none',
    mutationApplied: false,
    durable: 'none',
    externalCalls: 0,
  };
}

function failureDefaults(code: string): {
  status: DataRoomToolFailureV1['status'];
  phase: DataRoomFailurePhase;
  category: DataRoomFailureCategory;
  retryClass: DataRoomRetryClass;
} {
  if (code === 'invalid_input' || code === 'query_unsupported') {
    return { status: 'blocked', phase: 'arguments', category: 'validation', retryClass: 'correct_arguments' };
  }
  if (code === 'owner_context_required' || code === 'owner_request_required' || code === 'owner_scope_mismatch' || code === 'owner_action_mismatch') {
    return { status: 'blocked', phase: 'authorization', category: 'authorization', retryClass: 'new_owner_request' };
  }
  if (code === 'policy_denied') {
    return { status: 'blocked', phase: 'policy', category: 'policy', retryClass: 'none' };
  }
  if (code === 'not_found') {
    return { status: 'blocked', phase: 'observation', category: 'not_found', retryClass: 'refresh_state' };
  }
  if (code === 'conflict') {
    return { status: 'blocked', phase: 'admission', category: 'conflict', retryClass: 'refresh_state' };
  }
  if (code === 'integrity_failed') {
    return { status: 'blocked', phase: 'admission', category: 'integrity', retryClass: 'refresh_state' };
  }
  if (code === 'unavailable' || code === 'data_room_unavailable') {
    return { status: 'failed', phase: 'execution', category: 'availability', retryClass: 'retry_transient' };
  }
  if (code === 'query_timeout' || code === 'timeout') {
    return { status: 'failed', phase: 'execution', category: 'timeout', retryClass: 'retry_transient' };
  }
  if (code === 'query_cancelled' || code === 'cancelled') {
    return { status: 'blocked', phase: 'execution', category: 'cancelled', retryClass: 'none' };
  }
  return { status: 'failed', phase: 'execution', category: 'execution', retryClass: 'retry_transient' };
}

export function createDataRoomToolFailure(input: {
  tool: DataRoomToolName;
  code: string;
  message: string;
  nextAction: string;
  issues?: DataRoomFailureIssueV1[];
  status?: DataRoomToolFailureV1['status'];
  phase?: DataRoomFailurePhase;
  category?: DataRoomFailureCategory;
  retryClass?: DataRoomRetryClass;
  effect?: DataRoomFailureEffectV1;
  authorization?: DataRoomFailureAuthorizationV1;
  target?: DataRoomToolFailureV1['target'];
  cause?: DataRoomToolFailureV1['cause'];
}): DataRoomToolFailureV1 {
  const code = boundedCode(input.code, 'execution_failed');
  const defaults = failureDefaults(code);
  const retryClass = input.retryClass ?? defaults.retryClass;
  return {
    version: 1,
    type: 'data_room_tool_failure',
    ok: false,
    tool: input.tool,
    status: input.status ?? defaults.status,
    phase: input.phase ?? defaults.phase,
    category: input.category ?? defaults.category,
    code,
    message: boundedText(input.message, MAX_MESSAGE_CHARS, 'The Data Room operation failed.'),
    issues: (input.issues ?? []).slice(0, MAX_ISSUES).map(issue => ({
      ...issue,
      code: boundedCode(issue.code, 'invalid_value'),
      path: boundedText(issue.path, MAX_PATH_CHARS, '$'),
      message: boundedText(issue.message, MAX_MESSAGE_CHARS, 'The supplied value was rejected.'),
    })),
    retry: {
      class: retryClass,
      safe: ['correct_arguments', 'refresh_state', 'retry_transient', 'observe_existing'].includes(retryClass),
    },
    effect: input.effect ?? dataRoomNoEffect(),
    authorization: input.authorization ?? dataRoomAuthorization({
      requiredAuthority: 'No additional authorization was evaluated for this failure.',
    }),
    ...(input.target ? { target: input.target } : {}),
    ...(input.cause ? {
      cause: {
        code: boundedCode(input.cause.code, 'execution_failed'),
        message: boundedText(input.cause.message, MAX_MESSAGE_CHARS, 'The underlying operation failed.'),
      },
    } : {}),
    nextAction: boundedText(input.nextAction, MAX_MESSAGE_CHARS, 'Inspect the structured failure and follow its retry class.'),
  };
}

export function dataRoomFailureFromError(input: {
  tool: DataRoomToolName;
  error: unknown;
  nextAction: string;
  status?: DataRoomToolFailureV1['status'];
  phase?: DataRoomFailurePhase;
  category?: DataRoomFailureCategory;
  retryClass?: DataRoomRetryClass;
  effect?: DataRoomFailureEffectV1;
  authorization?: DataRoomFailureAuthorizationV1;
  target?: DataRoomToolFailureV1['target'];
}): DataRoomToolFailureV1 {
  const source = input.error && typeof input.error === 'object'
    ? input.error as { code?: unknown; message?: unknown; issues?: unknown }
    : {};
  const rawCode = boundedCode(source.code, 'execution_failed');
  const code = SAFE_PROJECTED_ERROR_CODES.has(rawCode) ? rawCode : 'execution_failed';
  const mayProjectSourceMessage = code !== 'execution_failed' && SAFE_PROJECTED_ERROR_CODES.has(code);
  const message = mayProjectSourceMessage
    ? boundedText(source.message, MAX_MESSAGE_CHARS, 'The Data Room operation failed.')
    : 'The Data Room operation failed unexpectedly; internal exception details were withheld.';
  const issues = mayProjectSourceMessage && Array.isArray(source.issues)
    ? source.issues.filter((issue): issue is DataRoomFailureIssueV1 => Boolean(
        issue && typeof issue === 'object'
        && typeof (issue as DataRoomFailureIssueV1).path === 'string'
        && typeof (issue as DataRoomFailureIssueV1).code === 'string',
      ))
    : [];
  return createDataRoomToolFailure({
    tool: input.tool,
    code,
    message,
    nextAction: input.nextAction,
    issues,
    ...(input.status ? { status: input.status } : {}),
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(input.retryClass ? { retryClass: input.retryClass } : {}),
    ...(input.effect ? { effect: input.effect } : {}),
    ...(input.authorization ? { authorization: input.authorization } : {}),
    ...(input.target ? { target: input.target } : {}),
    cause: { code, message },
  });
}

export function dataRoomFailureOutput(failure: DataRoomToolFailureV1): {
  content: string;
  isError: true;
} {
  return { content: JSON.stringify(failure), isError: true };
}
