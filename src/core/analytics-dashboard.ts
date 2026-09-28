import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { McpManager } from './mcp-types.js';
import { validateReadOnlySql } from './mcp-policy.js';
import {
  isCrossLaneRetryableFailure,
  isDashboardLaneUnavailable,
  isSafeRuntimeQueueChurn,
  otherDashboardLane,
  sqlDashboardLaneCandidate,
  sqlDashboardLaneUsable,
  etlDashboardLaneUsable,
  type DashboardLaneId,
} from './analytics-runners.js';
import type { QueryRunner, QueryRunResult } from './etl-adhoc.js';
import type { AnalyticsDataRoomReadService, DataRoomQueryInput } from './analytics-data-room-read.js';
import { AnalyticsDataRoomError } from './analytics-data-room-store.js';
import {
  AnalyticsDashboardDataRoomError,
  type AnalyticsDashboardDataRoomBridge,
} from './analytics-dashboard-data-room.js';
import type {
  AnalyticsDashboard,
  AnalyticsDashboardService,
  AnalyticsDashboardStatus,
  AnalyticsDashboardSummary,
  AnalyticsLateEtlResult,
  AnalyticsRefreshTrigger,
  AnalyticsRun,
  AnalyticsSchedule,
  AnalyticsPublication,
  DashboardPublicationReceiptV1,
  DashboardPublicationSnapshotV1,
  AnalyticsWidget,
  AnalyticsWidgetBindingMutationResult,
  AnalyticsWidgetControlMutationResult,
  AnalyticsWidgetSourceInput,
  AnalyticsWidgetSourceMutationResult,
  AnalyticsWidgetSourceV1,
  ConfigureAnalyticsWidgetSourceInput,
  AnalyticsWidgetEditErrorCode,
  AnalyticsWidgetEditInput,
  AnalyticsWidgetEditMutationResult,
  AnalyticsWidgetEditPresentation,
  AnalyticsWidgetEditRequestIdentity,
  AnalyticsWidgetInput,
  AnalyticsWidgetKind,
  AnalyticsWidgetResult,
  CreateAnalyticsDashboardInput,
  UpdateAnalyticsDashboardInput,
  UpdateAnalyticsScheduleInput,
  UpdateAnalyticsWidgetBindingInput,
  UpdateAnalyticsWidgetInput,
} from './analytics-types.js';
import { analyticsSha256, stableAnalyticsJson } from './analytics-data-room-policy.js';
import {
  dataRoomIssue,
  prefixDataRoomIssues,
  type DataRoomFailureIssueV1,
} from './data-room-tool-failure.js';
import type { AnalyticsControlApplyInput, AnalyticsDatasetControlState } from './analytics-data-room-types.js';

const WIDGET_KINDS = new Set<AnalyticsWidgetKind>(['metric', 'table', 'bar', 'line', 'text', 'visualization']);
const EDITABLE_DASHBOARD_STATUSES = new Set<AnalyticsDashboardStatus>(['draft', 'ready', 'refreshing', 'degraded', 'archived']);
const LOCAL_WIDGET_CONCURRENCY = 4;
const WAITING_FOR_DATA_PREFIX = '[WAITING_FOR_DATA] ';
const MAX_WIDGETS = 24;
const DATASET_ID_RE = /^ds_[A-Za-z0-9_-]{1,96}$/;
const VERSION_ID_RE = /^dsv_[a-f0-9]{24}$/;
const SOURCE_ALIAS = 'source';
const MAX_VISUALIZATION_SPEC_BYTES = 64 * 1024;
const MAX_VISUALIZATION_SPEC_DEPTH = 24;
const MAX_VISUALIZATION_SPEC_NODES = 4_000;
const VEGA_LITE_MARKS = new Set([
  'arc', 'area', 'bar', 'circle', 'geoshape', 'line', 'point',
  'rect', 'rule', 'square', 'text', 'tick', 'trail',
]);
const FORBIDDEN_VEGA_KEYS = new Set([
  '$schema', '__proto__', 'constructor', 'data', 'datasets', 'expr', 'href',
  'prototype', 'signal', 'signals', 'url',
]);
const EXTERNAL_VEGA_STRING_RE = /(?:\b(?:https?|data|javascript|file):|url\s*\(|^\/\/)/i;

class DataLaneUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataLaneUnavailableError';
  }
}

export class AnalyticsWidgetEditError extends Error {
  readonly code: AnalyticsWidgetEditErrorCode;
  readonly nextAction: string;

  constructor(code: AnalyticsWidgetEditErrorCode, message: string, nextAction: string) {
    super(message);
    this.name = 'AnalyticsWidgetEditError';
    this.code = code;
    this.nextAction = nextAction;
  }
}

interface AnalyticsDashboardEditReceiptRow {
  id: string;
  owner_request_id: string;
  owner_message_json: string;
  owner_message_sha256: string;
  owner_scope_json: string;
  owner_scope_sha256: string;
  request_intent_json: string;
  request_intent_sha256: string;
  intent_version: number;
  intent_json: string;
  intent_sha256: string;
  action: 'add_from_widget' | 'combine_compatible_widgets';
  dashboard_id: string;
  source_widget_ids_json: string;
  explicit_new: number;
  replay_of_receipt_id: string | null;
  created_widget_id: string;
  run_id: string;
  effect_version: number;
  effect_sha256: string;
  mutation_receipt_json: string;
  created_at: string;
  last_replayed_at: string | null;
}

interface NormalizedAnalyticsEditIdentity {
  ownerRequestId: string;
  ownerMessageJson: string;
  ownerMessageSha256: string;
  ownerScopeJson: string;
  ownerScopeSha256: string;
  requestIntentJson: string;
  requestIntentSha256: string;
  intentJson: string;
  intentSha256: string;
  explicitNew: boolean;
}

class EtlAliveHandoffError extends Error {
  readonly runId: string;
  readonly remoteStatus: string;

  constructor(outcome: QueryRunResult) {
    const runId = String(outcome.runId ?? '');
    const remoteStatus = String(outcome.remoteStatus ?? 'RUNNING').toUpperCase();
    super([
      outcome.error,
      'Late output is pending automatic reconciliation; do not rerun the dashboard solely to import it.',
    ].filter(Boolean).join(' — '));
    this.name = 'EtlAliveHandoffError';
    this.runId = runId;
    this.remoteStatus = remoteStatus;
  }
}

const LATE_ETL_RECHECK_MS = 60_000;
const LATE_ETL_RETRY_MS = 5 * 60_000;
const LATE_ETL_LEASE_MS = 6 * 60_000;

function cleanText(value: unknown, label: string, max: number, required = false): string {
  if (value == null) {
    if (required) throw new Error(`${label} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const text = value.trim();
  if (required && !text) throw new Error(`${label} is required`);
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return text;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Validate the declarative Vega-Lite subset accepted for persisted widgets.
 * Query results are injected by the trusted UI at render time, so authored
 * specs cannot provide data, network locations, links, or expression code.
 */
export function validateVisualizationSpec(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error('Visualization config.spec must be a plain object');
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('Visualization config.spec must be JSON serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_VISUALIZATION_SPEC_BYTES) {
    throw new Error(`Visualization config.spec exceeds ${MAX_VISUALIZATION_SPEC_BYTES} bytes`);
  }

  let nodes = 0;
  const visit = (node: unknown, path: string, depth: number): void => {
    nodes++;
    if (nodes > MAX_VISUALIZATION_SPEC_NODES) {
      throw new Error(`Visualization config.spec exceeds ${MAX_VISUALIZATION_SPEC_NODES} values`);
    }
    if (depth > MAX_VISUALIZATION_SPEC_DEPTH) {
      throw new Error(`Visualization config.spec exceeds depth ${MAX_VISUALIZATION_SPEC_DEPTH}`);
    }
    if (node == null || typeof node === 'boolean') return;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new Error(`Visualization ${path} must be a finite number`);
      return;
    }
    if (typeof node === 'string') {
      if (EXTERNAL_VEGA_STRING_RE.test(node)) {
        throw new Error(`Visualization ${path} cannot contain an external URL or executable URI`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!isPlainObject(node)) throw new Error(`Visualization ${path} must contain only JSON values`);

    for (const [key, child] of Object.entries(node)) {
      const normalizedKey = key.toLowerCase();
      const childPath = `${path}.${key}`;
      if (FORBIDDEN_VEGA_KEYS.has(normalizedKey) || normalizedKey.endsWith('expr') || normalizedKey === 'calculate') {
        throw new Error(`Visualization ${childPath} is not allowed`);
      }
      if ((normalizedKey === 'filter' || normalizedKey === 'test') && typeof child === 'string') {
        throw new Error(`Visualization ${childPath} must use a declarative predicate, not an expression string`);
      }
      if (normalizedKey === 'mark') {
        const mark = typeof child === 'string'
          ? child
          : isPlainObject(child) && typeof child.type === 'string'
            ? child.type
            : undefined;
        if (mark && !VEGA_LITE_MARKS.has(mark)) {
          throw new Error(`Visualization ${childPath} uses unsupported mark ${mark}`);
        }
      }
      visit(child, childPath, depth + 1);
    }
  };
  visit(value, 'config.spec', 0);

  if (!['mark', 'layer', 'facet', 'concat', 'hconcat', 'vconcat', 'repeat'].some(key => key in value)) {
    throw new Error('Visualization config.spec must define a mark or a Vega-Lite composition');
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function widgetDefinitionSha256(kind: unknown, sql: unknown, configJson: unknown): string {
  const config = parseJson<Record<string, unknown>>(String(configJson ?? ''), {});
  return createHash('sha256').update(JSON.stringify({
    kind: String(kind ?? ''),
    sql: String(sql ?? ''),
    config,
  })).digest('hex');
}

function shortId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedParts(date: Date, timezone: string): ZonedParts {
  let formatter = zonedFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    // Force eager timezone validation instead of failing later in the scheduler.
    formatter.format(date);
    zonedFormatters.set(timezone, formatter);
  }
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (['year', 'month', 'day', 'hour', 'minute'].includes(part.type)) values[part.type] = Number(part.value);
  }
  return values as unknown as ZonedParts;
}

function localDayPlus(parts: ZonedParts, days: number): ZonedParts {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  };
}

function sameLocalDay(left: ZonedParts, right: ZonedParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function utcForLocalTime(
  localDay: ZonedParts,
  hour: number,
  minute: number,
  timezone: string,
  afterMs: number,
): Date | null {
  const targetPseudo = Date.UTC(localDay.year, localDay.month - 1, localDay.day, hour, minute);
  let guess = targetPseudo;
  for (let attempt = 0; attempt < 5; attempt++) {
    const actual = zonedParts(new Date(guess), timezone);
    const actualPseudo = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const delta = targetPseudo - actualPseudo;
    if (delta === 0) break;
    guess += delta;
  }

  // Scan around the resolved offset to cover DST overlaps and nonexistent
  // wall-clock minutes. On a spring-forward gap, use the first valid minute
  // after the requested local time; on an overlap, use the first future match.
  let exactFuture: number | null = null;
  let firstLater: number | null = null;
  let sawExact = false;
  for (let value = guess - 4 * 60 * 60_000; value <= guess + 4 * 60 * 60_000; value += 60_000) {
    const actual = zonedParts(new Date(value), timezone);
    if (!sameLocalDay(actual, localDay)) continue;
    const actualMinutes = actual.hour * 60 + actual.minute;
    const targetMinutes = hour * 60 + minute;
    if (actualMinutes === targetMinutes) {
      sawExact = true;
      if (value > afterMs && (exactFuture == null || value < exactFuture)) exactFuture = value;
    } else if (actualMinutes > targetMinutes && value > afterMs && (firstLater == null || value < firstLater)) {
      firstLater = value;
    }
  }
  const selected = exactFuture ?? (!sawExact ? firstLater : null);
  return selected == null ? null : new Date(selected);
}

export function nextDailyRun(localTime: string, timezone: string, after = new Date()): Date {
  const match = /^(\d{2}):(\d{2})$/.exec(String(localTime || ''));
  if (!match) throw new Error('Daily refresh time must use HH:MM in 24-hour format');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('Daily refresh time is invalid');
  const zone = cleanText(timezone, 'timezone', 100, true);
  const today = zonedParts(after, zone);
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const candidate = utcForLocalTime(localDayPlus(today, dayOffset), hour, minute, zone, after.getTime());
    if (candidate) return candidate;
  }
  throw new Error('Could not calculate the next daily refresh time');
}

function coerceCell(value: string): string | number | boolean | null {
  const text = value.trim();
  if (/^null$/i.test(text)) return null;
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  return text;
}

/** Parse the stable formatted-table response emitted by sql-context-mcp. */
export function parseSqlMcpResult(text: string, refreshedAt = new Date().toISOString()): AnalyticsWidgetResult {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const separatorIndex = lines.findIndex(line => /^-+(?:-\+-+)*$/.test(line.trim()));
  const countMatch = text.match(/(?:^|\n)(\d+) rows returned\. \((\d+)ms\)\s*$/);
  const emptyMatch = text.match(/Query executed successfully\.\s*(\d+) rows affected\.\s*\((\d+)ms\)/);
  let columns: string[] = [];
  let rows: Array<Array<string | number | boolean | null>> = [];

  if (separatorIndex > 0) {
    columns = lines[separatorIndex - 1].split(' | ').map(value => value.trim());
    for (const line of lines.slice(separatorIndex + 1)) {
      if (!line.trim() || /^\.\.\. \(\d+ more rows\)$/.test(line.trim()) || /^\d+ rows returned\./.test(line.trim())) break;
      const values = line.split(' | ').map(coerceCell);
      while (values.length < columns.length) values.push(null);
      rows.push(values.slice(0, columns.length));
    }
  }

  const rowCount = countMatch ? Number(countMatch[1]) : emptyMatch ? Number(emptyMatch[1]) : rows.length;
  const executionTimeMs = countMatch ? Number(countMatch[2]) : emptyMatch ? Number(emptyMatch[2]) : undefined;
  return {
    trust: 'external_untrusted_data',
    columns,
    rows,
    rowCount,
    displayedRowCount: rows.length,
    executionTimeMs,
    rawPreview: columns.length ? undefined : text.slice(0, 2000),
    refreshedAt,
  };
}

/** Convert a Datanet ETL composite outcome (parsed TSV, string cells) into
 * the widget result shape — same cell coercion as the sql-mcp lane so a
 * widget renders identically regardless of which lane produced it. */
export function etlResultToWidgetResult(outcome: QueryRunResult, elapsedMs?: number): AnalyticsWidgetResult {
  const columns = outcome.columns ?? [];
  const rows = (outcome.rows ?? []).map(row => row.map(coerceCell));
  return {
    trust: 'external_untrusted_data',
    columns,
    rows,
    rowCount: outcome.rowCount ?? rows.length,
    displayedRowCount: rows.length,
    executionTimeMs: elapsedMs,
    rawPreview: columns.length ? undefined : 'The ETL run completed without tabular output.',
    refreshedAt: new Date().toISOString(),
    lane: 'etl',
    ...(outcome.runId ? {
      source: {
        provider: 'datanet' as const,
        runId: outcome.runId,
        remoteStatus: 'SUCCESS' as const,
        ...(outcome.resultSha256 ? { resultSha256: outcome.resultSha256 } : {}),
        ...(outcome.resultBytes !== undefined ? { resultBytes: outcome.resultBytes } : {}),
      },
    } : {}),
  };
}

/** Resolves one model/owner Data Room source into the exact stored descriptor. */
type DataRoomWidgetSourceResolver = (
  source: Record<string, unknown>,
  path: string,
  label: string,
) => Extract<AnalyticsWidgetSourceV1, { kind: 'data_room_query' }>;

function normalizeWidget(
  input: AnalyticsWidgetInput,
  position: number,
  resolveDataRoomSource?: DataRoomWidgetSourceResolver,
): AnalyticsWidgetInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`Widget ${position + 1} must be an object`);
  if (!WIDGET_KINDS.has(input.kind)) throw new Error(`Widget ${position + 1} has invalid kind`);
  const title = cleanText(input.title, `Widget ${position + 1} title`, 200, true);
  const subtitle = cleanText(input.subtitle, `Widget ${position + 1} subtitle`, 500);
  let preset = cleanText(input.preset, `Widget ${position + 1} preset`, 256);
  const config = jsonObject(input.config);
  if (Object.prototype.hasOwnProperty.call(config, 'dataSource')) {
    throw new Error(`Widget ${position + 1} config.dataSource is server-owned; give the widget's data source as widget.source instead ({kind:"data_room_query", datasetId, sql} for a Data Room dataset)`);
  }
  const source = input.source as unknown;
  if (input.kind === 'text') {
    if (source !== undefined) throw new Error(`Widget ${position + 1} is a text widget; remove source`);
    const text = cleanText(config.text, `Widget ${position + 1} text`, 20_000, true);
    return { kind: input.kind, title, subtitle, preset, config: { ...config, text } };
  }
  let sql: string | undefined;
  let nextConfig: Record<string, unknown> = config;
  if (source === undefined) {
    sql = validateReadOnlySql(input.sql);
  } else {
    if (!isPlainObject(source)) throw new Error(`Widget ${position + 1} source must be an object`);
    const topLevelSql = typeof input.sql === 'string' ? input.sql.trim() : '';
    if (source.kind === 'data_room_query') {
      if (topLevelSql) {
        throw new Error(`Widget ${position + 1} reads a Data Room dataset; put its SQLite query in source.sql and omit widget.sql`);
      }
      if (preset) throw new Error(`Widget ${position + 1} preset applies only to warehouse widgets; omit it for a Data Room source`);
      if (!resolveDataRoomSource) {
        throw new Error(`Widget ${position + 1} Data Room sources are set through dashboard create/update or configure_analytics_widget_source`);
      }
      nextConfig = { ...config, dataSource: resolveDataRoomSource(source, `widgets[${position}].source`, `Widget ${position + 1} "${title}"`) };
      preset = '';
    } else if (source.kind === 'warehouse_sql') {
      const extras = Object.keys(source).filter(key => !['kind', 'sql', 'preset'].includes(key)).sort();
      if (extras.length) throw new Error(`Widget ${position + 1} warehouse source contains unsupported fields: ${extras.join(', ')}`);
      if (topLevelSql && topLevelSql !== String(source.sql ?? '').trim()) {
        throw new Error(`Widget ${position + 1} gives two different warehouse queries; use either widget.sql or source.sql`);
      }
      sql = validateReadOnlySql(source.sql);
      preset = cleanText(source.preset ?? input.preset, `Widget ${position + 1} preset`, 256);
    } else {
      throw new Error(`Widget ${position + 1} source.kind must be data_room_query or warehouse_sql`);
    }
  }
  if (input.kind === 'visualization') {
    nextConfig = { ...nextConfig, spec: validateVisualizationSpec(config.spec) };
  }
  return { kind: input.kind, title, subtitle, ...(sql ? { sql } : {}), preset, config: nextConfig };
}

function normalizeWidgets(value: unknown, resolveDataRoomSource?: DataRoomWidgetSourceResolver): AnalyticsWidgetInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('At least one dashboard widget is required');
  if (value.length > MAX_WIDGETS) throw new Error(`A dashboard can contain at most ${MAX_WIDGETS} widgets`);
  return value.map((widget, position) => normalizeWidget(widget as AnalyticsWidgetInput, position, resolveDataRoomSource));
}

function isDataRoomQueryWidget(widget: { config?: Record<string, unknown> }): boolean {
  const dataSource = widget.config?.dataSource;
  return isPlainObject(dataSource) && dataSource.kind === 'data_room_query';
}

function widgetSourceFromConfig(configValue: unknown): AnalyticsWidgetSourceV1 | null {
  const config = jsonObject(configValue);
  const raw = config.dataSource;
  if (raw === undefined) return null;
  if (!isPlainObject(raw) || raw.version !== 1 || !['warehouse_sql', 'data_room_query'].includes(String(raw.kind ?? ''))) {
    throw new Error('Widget dataSource descriptor is malformed or unsupported');
  }
  const extras = Object.keys(raw).filter(key => !(
    raw.kind === 'warehouse_sql'
      ? ['version', 'kind'].includes(key)
      : ['version', 'kind', 'datasetId', 'versionId', 'sql', 'params', 'limit'].includes(key)
  ));
  if (extras.length) throw new Error(`Widget dataSource contains unsupported fields: ${extras.sort().join(', ')}`);
  if (raw.kind === 'warehouse_sql') return { version: 1, kind: 'warehouse_sql' };
  const datasetId = String(raw.datasetId ?? '');
  const versionId = String(raw.versionId ?? '');
  const sql = String(raw.sql ?? '').trim();
  const params = Array.isArray(raw.params) ? raw.params : [];
  const limit = Number(raw.limit ?? 100);
  if (!DATASET_ID_RE.test(datasetId) || !VERSION_ID_RE.test(versionId)
    || !sql || params.length > 100 || params.some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value))
    || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('Widget dataSource query identity or limits are malformed');
  }
  return {
    version: 1,
    kind: 'data_room_query',
    datasetId,
    versionId,
    sql,
    params: params as Array<string | number | boolean | null>,
    limit,
  };
}

/** Payload for the run-failure escalation hook (one event per failed run). */
export interface AnalyticsRunFailureEvent {
  runId: string;
  dashboardId: string;
  dashboardTitle: string;
  trigger: string;
  /** Lane the run executed on (retry pass may have used the other one per widget — errors carry that trail). */
  lane: DashboardLaneId;
  failures: Array<{ widgetId: string; title: string; error: string }>;
}

export function createAnalyticsDashboardService(options: {
  db: Database.Database;
  mcpManager: McpManager;
  queryTimeoutMs?: number;
  /** Fallback data lane (etl-analytics A4): the Datanet ETL composite. When
   * present AND sql-context is not running at run start, widget queries run
   * through the scratch-pair pool — widgets may execute in parallel, each
   * with a minutes-scale budget. */
  etlRunner?: QueryRunner;
  /** Optional R4 bridge. When disabled, persisted bindings remain untouched and
   * every widget follows its pre-R4 SQL/ETL path using retained legacy SQL. */
  dataRoom?: AnalyticsDashboardDataRoomBridge;
  dataRoomRead?: AnalyticsDataRoomReadService;
  dataRoomEnabled?: boolean;
  /** Escalation hook (incident 2026-09-04): called once per run that
   * finalizes with failed widgets AFTER the cross-lane retry pass. The
   * composition root wires it to a background agent investigation whose
   * findings land in BotBoy chat. Fire-and-forget: it must never block or
   * fail the run queue. */
  onRunFailure?: (event: AnalyticsRunFailureEvent) => Promise<void>;
}): AnalyticsDashboardService {
  const db = options.db;
  const mcpManager = options.mcpManager;
  const etlRunner = options.etlRunner;
  const dataRoom = options.dataRoom;
  const dataRoomRead = options.dataRoomRead;
  const dataRoomEnabled = Boolean(dataRoom)
    && (options.dataRoomEnabled ?? process.env.PPT_ANALYTICS_DATA_ROOM_WIDGETS_ENABLED !== '0');
  const defaultQueryTimeoutMs = 60 * 60_000; // owner decision 2026-09-09: allow slow ETL-backed widgets to finish
  const configuredQueryTimeoutMs = Number(
    options.queryTimeoutMs ?? process.env.PPT_ANALYTICS_QUERY_TIMEOUT_MS ?? defaultQueryTimeoutMs,
  );
  const queryTimeoutMs = Number.isFinite(configuredQueryTimeoutMs)
    ? Math.max(30_000, Math.min(60 * 60_000, Math.floor(configuredQueryTimeoutMs)))
    : defaultQueryTimeoutMs;
  const workerId = `worker_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  function processIsAlive(pid: unknown): boolean {
    const value = Number(pid);
    if (!Number.isSafeInteger(value) || value <= 0) return false;
    if (value === process.pid) return true;
    try {
      process.kill(value, 0);
      return true;
    } catch (error: any) {
      return error?.code !== 'ESRCH';
    }
  }

  function validateProjects(projectIds: unknown): string[] {
    if (projectIds == null) return [];
    if (!Array.isArray(projectIds)) throw new Error('projectIds must be an array');
    const ids = [...new Set(projectIds.map(value => cleanText(value, 'projectId', 128, true)))].slice(0, 50);
    const exists = db.prepare('SELECT 1 FROM projects WHERE id = ?');
    for (const id of ids) {
      if (!exists.get(id)) throw new Error(`Project ${id} does not exist`);
    }
    return ids;
  }

  function mapSummary(row: any): AnalyticsDashboardSummary {
    return {
      id: row.id,
      title: row.title,
      description: row.description || '',
      theme: row.theme || 'executive',
      status: row.status === 'archived'
        ? 'archived'
        : row.status === 'refreshing'
          ? 'refreshing'
          : row.status === 'degraded'
            ? 'degraded'
            : ((dataRoomEnabled ? row.data_state : null) || row.status),
      widgetCount: Number(row.widget_count || 0),
      projectCount: Number(row.project_count || 0),
      lastError: row.last_error || undefined,
      lastRefreshedAt: row.last_refreshed_at || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function widgetControls(widgetId: string): AnalyticsDatasetControlState | undefined {
    if (!dataRoom) return undefined;
    try { return dataRoom.getControls(widgetId) ?? undefined; } catch { return undefined; }
  }

  function mapWidget(row: any): AnalyticsWidget {
    return {
      id: row.id,
      dashboardId: row.dashboard_id,
      revision: Number(row.revision || 1),
      bindingRevision: dataRoom?.getBindingRevision(row.id) ?? 0,
      position: Number(row.position),
      kind: row.kind,
      title: row.title,
      subtitle: row.subtitle || '',
      sql: row.sql_query || undefined,
      preset: row.preset || undefined,
      config: parseJson(row.config_json, {}),
      binding: dataRoom?.getBinding(row.id) ?? undefined,
      controls: widgetControls(row.id),
      result: parseJson<AnalyticsWidgetResult | undefined>(row.result_json, undefined),
      lastError: row.last_error || undefined,
      lastRefreshedAt: row.last_refreshed_at || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function mapSchedule(row: any): AnalyticsSchedule {
    return {
      id: row.id,
      dashboardId: row.dashboard_id,
      enabled: row.enabled === 1,
      scheduleKind: row.schedule_kind,
      localTime: row.local_time,
      timezone: row.timezone,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at || undefined,
      consecutiveFailures: Number(row.consecutive_failures || 0),
      lastError: row.last_error || undefined,
    };
  }

  function mapPublication(row: any): AnalyticsPublication {
    const snapshot = row.manifest_json
      ? parseJson<DashboardPublicationSnapshotV1 | undefined>(row.manifest_json, undefined)
      : undefined;
    const receipt = snapshot && row.manifest_sha256 && row.config_sha256
      ? {
          snapshot,
          snapshotManifestSha256: row.manifest_sha256,
          artifactContentSha256: row.content_sha256,
          publisherConfigSha256: row.config_sha256,
        } satisfies DashboardPublicationReceiptV1
      : undefined;
    return {
      id: row.id,
      dashboardId: row.dashboard_id,
      publisherId: row.publisher_id,
      objectKey: row.object_key,
      ...(row.share_request_id ? { shareRequestId: row.share_request_id } : {}),
      url: row.url || undefined,
      status: row.status,
      contentSha256: row.content_sha256,
      deployed: row.deployed === 1,
      contentVerified: row.content_verified === 1,
      visibilityConverged: row.visibility_converged === 1,
      ...(receipt ? { receipt } : {}),
      error: row.error || undefined,
      createdAt: row.created_at,
      publishedAt: row.published_at || undefined,
    };
  }

  function mapLateEtlResult(row: any): AnalyticsLateEtlResult {
    return {
      runId: String(row.run_id),
      widgetId: String(row.widget_id),
      externalRunId: String(row.external_run_id),
      state: row.state,
      remoteStatus: row.remote_status || undefined,
      nextCheckAt: row.next_check_at,
      resultPath: row.result_path || undefined,
      resultBytes: row.result_bytes == null ? undefined : Number(row.result_bytes),
      resultSha256: row.result_sha256 || undefined,
      rowCount: row.row_count == null ? undefined : Number(row.row_count),
      receipt: parseJson<Record<string, unknown> | undefined>(row.receipt_json, undefined),
      error: row.error || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at || undefined,
    };
  }

  function mapRun(row: any): AnalyticsRun {
    // The pool runs several widgets at once; the UI names them all instead
    // of pretending one widget is "current" (owner confusion 2026-08-27:
    // "running L1 Discovery Sources … 0/10" while six queries were mid-flight).
    const runningWidgetIds = row.status === 'running'
      ? (db.prepare(`
          SELECT widget_id FROM analytics_run_widgets
          WHERE run_id = ? AND status = 'running' ORDER BY position
        `).all(row.id) as any[]).map(widget => String(widget.widget_id))
      : undefined;
    const lateEtlResults = (db.prepare(`
      SELECT * FROM analytics_late_etl_results
      WHERE run_id = ? ORDER BY created_at, external_run_id
    `).all(row.id) as any[]).map(mapLateEtlResult);
    return {
      ...(runningWidgetIds?.length ? { runningWidgetIds } : {}),
      ...(lateEtlResults.length ? { lateEtlResults } : {}),
      id: row.id,
      dashboardId: row.dashboard_id,
      trigger: row.trigger,
      status: row.status,
      refreshScope: row.refresh_scope || 'full',
      widgetCount: Number(row.widget_count || 0),
      widgetsCompleted: Number(row.widgets_completed || 0),
      widgetsSucceeded: Number(row.widgets_succeeded || 0),
      currentWidgetId: row.current_widget_id || undefined,
      lane: row.primary_lane || undefined,
      cancelRequested: Boolean(row.cancel_requested),
      queuedAt: row.queued_at,
      startedAt: row.started_at || undefined,
      heartbeatAt: row.heartbeat_at || undefined,
      leaseExpiresAt: row.lease_expires_at || undefined,
      error: row.error || undefined,
      completedAt: row.completed_at || undefined,
    };
  }

  function getRun(id: string): AnalyticsRun | null {
    const row = db.prepare('SELECT * FROM analytics_runs WHERE id = ?').get(id) as any;
    return row ? mapRun(row) : null;
  }

  function activeRun(dashboardId: string): AnalyticsRun | null {
    const row = db.prepare(`
      SELECT * FROM analytics_runs
      WHERE dashboard_id = ? AND status IN ('queued','running')
      ORDER BY queued_at LIMIT 1
    `).get(dashboardId) as any;
    return row ? mapRun(row) : null;
  }

  function listDashboards(): AnalyticsDashboardSummary[] {
    const rows = db.prepare(`
      SELECT d.*,
        (SELECT COUNT(*) FROM analytics_widgets w WHERE w.dashboard_id = d.id) AS widget_count,
        (SELECT COUNT(*) FROM analytics_dashboard_projects p WHERE p.dashboard_id = d.id) AS project_count
      FROM analytics_dashboards d
      WHERE d.status != 'archived'
      ORDER BY COALESCE(d.last_refreshed_at, d.updated_at) DESC, d.title
    `).all() as any[];
    return rows.map(mapSummary);
  }

  function getDashboard(id: string): AnalyticsDashboard | null {
    const row = db.prepare(`
      SELECT d.*,
        (SELECT COUNT(*) FROM analytics_widgets w WHERE w.dashboard_id = d.id) AS widget_count,
        (SELECT COUNT(*) FROM analytics_dashboard_projects p WHERE p.dashboard_id = d.id) AS project_count
      FROM analytics_dashboards d WHERE d.id = ?
    `).get(id) as any;
    if (!row) return null;
    const projectIds = (db.prepare('SELECT project_id FROM analytics_dashboard_projects WHERE dashboard_id = ? ORDER BY linked_at').all(id) as any[]).map(item => item.project_id);
    const widgets = (db.prepare('SELECT * FROM analytics_widgets WHERE dashboard_id = ? ORDER BY position').all(id) as any[]).map(mapWidget);
    const scheduleRow = db.prepare('SELECT * FROM analytics_schedules WHERE dashboard_id = ?').get(id) as any;
    const publicationRow = db.prepare(`
      SELECT * FROM dashboard_publications
      WHERE dashboard_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(id) as any;
    const successfulPublicationRow = publicationRow?.status === 'published'
      ? publicationRow
      : db.prepare(`
          SELECT * FROM dashboard_publications
          WHERE dashboard_id = ? AND status = 'published'
          ORDER BY created_at DESC LIMIT 1
        `).get(id) as any;
    const recentRuns = (db.prepare(`
      SELECT * FROM analytics_runs WHERE dashboard_id = ?
      ORDER BY datetime(queued_at) DESC, id DESC LIMIT 12
    `).all(id) as any[]).map(mapRun);
    return {
      ...mapSummary(row),
      projectIds,
      widgets,
      schedule: scheduleRow ? mapSchedule(scheduleRow) : undefined,
      latestPublication: publicationRow ? mapPublication(publicationRow) : undefined,
      latestSuccessfulPublication: successfulPublicationRow ? mapPublication(successfulPublicationRow) : undefined,
      recentRuns,
    };
  }

  function insertWidget(
    dashboardId: string,
    widgetId: string,
    position: number,
    widget: AnalyticsWidgetInput,
  ): void {
    db.prepare(`
      INSERT INTO analytics_widgets
        (id, dashboard_id, position, kind, title, subtitle, sql_query, preset, config_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      widgetId,
      dashboardId,
      position,
      widget.kind,
      widget.title,
      widget.subtitle || '',
      widget.sql || null,
      widget.preset || null,
      JSON.stringify(widget.config || {}),
    );
  }

  function insertWidgets(dashboardId: string, widgets: AnalyticsWidgetInput[]): void {
    widgets.forEach((widget, position) => {
      insertWidget(dashboardId, shortId('widget'), position, widget);
    });
  }

  function replaceProjectLinks(dashboardId: string, projectIds: string[]): void {
    db.prepare('DELETE FROM analytics_dashboard_projects WHERE dashboard_id = ?').run(dashboardId);
    const insert = db.prepare('INSERT INTO analytics_dashboard_projects (dashboard_id, project_id) VALUES (?, ?)');
    projectIds.forEach(projectId => insert.run(dashboardId, projectId));
  }

  function createDashboard(
    input: CreateAnalyticsDashboardInput,
    refreshTrigger?: AnalyticsRefreshTrigger,
  ): AnalyticsDashboard {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Dashboard input must be an object');
    if (refreshTrigger && !['manual', 'scheduled', 'agent'].includes(refreshTrigger)) {
      throw new Error('Invalid refresh trigger');
    }
    const title = cleanText(input.title, 'title', 200, true);
    const description = cleanText(input.description, 'description', 2000);
    const theme = cleanText(input.theme || 'executive', 'theme', 80, true);
    const widgets = normalizeWidgets(input.widgets, resolveDataRoomWidgetSource);
    const projectIds = validateProjects(input.projectIds);
    const id = shortId('dash');
    db.transaction(() => {
      db.prepare(`
        INSERT INTO analytics_dashboards (id, title, description, theme, status)
        VALUES (?, ?, ?, ?, 'draft')
      `).run(id, title, description, theme);
      insertWidgets(id, widgets);
      replaceProjectLinks(id, projectIds);
      // A full refresh covers every widget. Otherwise Data Room widgets still
      // load now: their local run needs no warehouse lane or remote call.
      if (refreshTrigger) enqueueDashboard(getDashboard(id)!, refreshTrigger);
      else queueDataRoomWidgetRun(id);
    })();
    return getDashboard(id)!;
  }

  function updateDashboard(id: string, input: UpdateAnalyticsDashboardInput): AnalyticsDashboard {
    const current = getDashboard(id);
    if (!current) throw new Error(`Dashboard ${id} not found`);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Dashboard update must be an object');
    const running = activeRun(id);
    if (running && (input.widgets !== undefined || input.status !== undefined || input.projectIds !== undefined)) {
      throw Object.assign(new AnalyticsWidgetEditError(
        'active_run',
        `Dashboard widgets, status, or project links cannot change while refresh ${running.id} is ${running.status}`,
        `Wait for run ${running.id} to finish (get_analytics_dashboard shows it), then send the same update once.`,
      ), { mutationApplied: false });
    }
    const title = input.title === undefined ? current.title : cleanText(input.title, 'title', 200, true);
    const description = input.description === undefined ? current.description : cleanText(input.description, 'description', 2000);
    const theme = input.theme === undefined ? current.theme : cleanText(input.theme, 'theme', 80, true);
    const persistedStatus = (db.prepare('SELECT status FROM analytics_dashboards WHERE id = ?').get(id) as { status: AnalyticsDashboardStatus }).status;
    if (persistedStatus === 'archived' && (input.widgets !== undefined || input.projectIds !== undefined)) {
      throw new Error('Archived dashboard widgets and project links cannot change until the dashboard is restored');
    }
    const status = input.status === undefined ? persistedStatus : input.status;
    if (!EDITABLE_DASHBOARD_STATUSES.has(status)) throw new Error('Invalid dashboard status');
    const widgets = input.widgets === undefined ? null : normalizeWidgets(input.widgets, resolveDataRoomWidgetSource);
    const projectIds = input.projectIds === undefined ? null : validateProjects(input.projectIds);
    if (widgets && db.prepare(`
      SELECT 1 FROM analytics_widget_dataset_bindings binding
      JOIN analytics_widgets widget ON widget.id = binding.widget_id
      WHERE widget.dashboard_id = ? LIMIT 1
    `).get(id)) {
      throw new Error('Bound dashboard widgets require exact per-widget updates; bulk replacement would destroy stable identities.');
    }

    db.transaction(() => {
      db.prepare(`
        UPDATE analytics_dashboards SET title = ?, description = ?, theme = ?, status = ?,
          data_state = CASE WHEN ? = 'archived' THEN NULL ELSE data_state END,
          updated_at = datetime('now') WHERE id = ?
      `).run(title, description, theme, status, status, id);
      if (widgets) {
        db.prepare('DELETE FROM analytics_widgets WHERE dashboard_id = ?').run(id);
        insertWidgets(id, widgets);
        // Replaced Data Room widgets load immediately (local-only run).
        if (status !== 'archived') queueDataRoomWidgetRun(id);
      }
      if (projectIds) replaceProjectLinks(id, projectIds);
      if (persistedStatus === 'archived' && status !== 'archived') {
        dataRoom?.refreshDashboardDataState(id);
      }
      if (status === 'archived') {
        db.prepare(`
          UPDATE analytics_schedules SET enabled = 0, updated_at = datetime('now')
          WHERE dashboard_id = ?
        `).run(id);
      }
    })();
    return getDashboard(id)!;
  }

  function updateWidget(
    dashboardId: string,
    widgetId: string,
    input: UpdateAnalyticsWidgetInput,
  ): AnalyticsWidget {
    const dashboard = getDashboard(dashboardId);
    if (!dashboard) throw new Error(`Dashboard ${dashboardId} not found`);
    const dashboardStatus = (db.prepare('SELECT status FROM analytics_dashboards WHERE id = ?').get(dashboardId) as { status: string }).status;
    if (dashboardStatus === 'archived') throw new Error('Archived dashboard widgets cannot change');
    if (!input || typeof input !== 'object' || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error('A positive expectedRevision is required for a widget update');
    }
    const running = activeRun(dashboardId);
    if (running) throw new Error(`Widget cannot change while refresh ${running.id} is ${running.status}`);
    const current = db.prepare(`
      SELECT * FROM analytics_widgets WHERE id = ? AND dashboard_id = ?
    `).get(widgetId, dashboardId) as any;
    if (!current) throw new Error(`Widget ${widgetId} not found`);
    if (Number(current.revision || 1) !== input.expectedRevision) {
      throw new Error(`Widget revision changed from expected ${input.expectedRevision} to ${Number(current.revision || 1)}`);
    }
    const normalized = normalizeWidget(input.widget, Number(current.position));
    const binding = dataRoom?.getBinding(widgetId);
    if (binding && normalized.kind === 'text') throw new Error('A bound analytical widget cannot become static text');
    db.transaction(() => {
      const changed = db.prepare(`
        UPDATE analytics_widgets
        SET kind = ?, title = ?, subtitle = ?, sql_query = ?, preset = ?,
            config_json = ?, result_json = NULL, last_error = NULL,
            last_refreshed_at = NULL, revision = revision + 1,
            updated_at = datetime('now')
        WHERE id = ? AND dashboard_id = ? AND revision = ?
      `).run(
        normalized.kind,
        normalized.title,
        normalized.subtitle || '',
        normalized.sql || null,
        normalized.preset || null,
        JSON.stringify(normalized.config || {}),
        widgetId,
        dashboardId,
        input.expectedRevision,
      );
      if (changed.changes !== 1) throw new Error('Widget changed during optimistic update');
      if (binding) {
        db.prepare(`
          UPDATE analytics_widget_dataset_bindings
          SET compatibility_state = 'waiting',
              compatibility_error = 'Widget changed; the binding must be re-snapshotted.',
              observed_head_revision = 0, last_queued_version_id = NULL,
              last_applied_version_id = NULL
          WHERE widget_id = ? AND revision = ?
        `).run(widgetId, binding.revision);
        db.prepare(`
          UPDATE analytics_dashboards SET data_state = 'waiting_for_data', updated_at = datetime('now')
          WHERE id = ? AND status != 'archived'
        `).run(dashboardId);
      }
    })();
    return mapWidget(db.prepare('SELECT * FROM analytics_widgets WHERE id = ?').get(widgetId));
  }

  function widgetSourceError(
    code: AnalyticsWidgetEditErrorCode,
    message: string,
    nextAction: string,
    issues: DataRoomFailureIssueV1 | DataRoomFailureIssueV1[] = [],
  ): never {
    const list = Array.isArray(issues) ? issues : [issues];
    throw Object.assign(new AnalyticsWidgetEditError(code, message, nextAction), {
      issues: list.slice(0, 8),
      mutationApplied: false,
    });
  }

  /**
   * One Data Room widget source → the exact stored descriptor, pinned to the
   * dataset's current ready version. Shared by dashboard create/update and
   * configure_analytics_widget_source so every entry point validates alike.
   * Throws before any write, so a failure has zero effects.
   */
  function resolveDataRoomWidgetSource(
    source: Record<string, unknown>,
    path: string,
    label = '',
  ): Extract<AnalyticsWidgetSourceV1, { kind: 'data_room_query' }> {
    const prefix = label ? `${label}: ` : '';
    const extras = Object.keys(source).filter(key => !['kind', 'datasetId', 'sql', 'params', 'limit'].includes(key)).sort();
    if (extras.length) {
      widgetSourceError('invalid_input', `${prefix}Data Room source contains unsupported fields: ${extras.join(', ')}`, 'Use only kind, datasetId, sql, optional params, and optional limit for data_room_query.', extras.map(key => dataRoomIssue({
        code: 'unsupported_field', path: `${path}.${key}`, message: `${key} is not allowed for data_room_query.`,
        expected: { kind: 'absent' }, received: source[key],
      })));
    }
    const dataRoomReader = dataRoomRead;
    if (!dataRoomReader) {
      widgetSourceError('data_room_unavailable', 'Independent Data Room widget source service is unavailable', 'Restore the local Data Room read service before retrying.');
    }
    const datasetId = String(source.datasetId ?? '').trim();
    if (!DATASET_ID_RE.test(datasetId)) {
      widgetSourceError('invalid_input', `${prefix}Data Room source datasetId is malformed`, 'Use the exact datasetId returned by list_data_room_datasets.', dataRoomIssue({
        code: 'invalid_pattern', path: `${path}.datasetId`, message: `${path}.datasetId must be an exact Data Room dataset ID.`,
        expected: { kind: 'pattern', type: 'string', pattern: '^ds_[A-Za-z0-9_-]{1,96}$' }, received: source.datasetId, includeReceivedValue: true,
      }));
    }
    // Exact lookup with dashboard-use eligibility (the same check its runs
    // use), not the model catalog search.
    let pinned: { datasetId: string; versionId: string } | undefined;
    try {
      pinned = dataRoomReader!.resolveDashboardSource(datasetId);
    } catch (error) {
      const readerIssues = error && typeof error === 'object' && Array.isArray((error as { issues?: unknown }).issues)
        ? prefixDataRoomIssues(path, (error as { issues: DataRoomFailureIssueV1[] }).issues)
        : [];
      if (!(error instanceof AnalyticsDataRoomError)) {
        widgetSourceError('data_room_unavailable', `${prefix}Data Room lookup failed unexpectedly`, 'Retry this call once; if it fails again, report that the Data Room is unavailable.', readerIssues);
      }
      widgetSourceError(
        error.code === 'policy_denied' ? 'invalid_input' : 'not_found',
        `${prefix}${error.message}`,
        'Choose one exact ready dataset from list_data_room_datasets that allows dashboard use, then call again once.',
        readerIssues,
      );
    }
    if (!pinned || pinned.datasetId !== datasetId || !VERSION_ID_RE.test(pinned.versionId)) {
      widgetSourceError('not_found', `${prefix}Dataset ${datasetId} has no exact ready version`, 'Choose one exact ready dataset from list_data_room_datasets, then call again once.', dataRoomIssue({
        code: 'dataset_not_ready', path: `${path}.datasetId`, message: `${path}.datasetId must identify one exact ready dataset version.`,
        expected: { kind: 'relation', description: 'Dataset has one current verified head that allows dashboard use.' }, received: datasetId, includeReceivedValue: true,
      }));
    }
    const query = String(source.sql ?? '').trim();
    if (!/^(?:SELECT|WITH)\b/i.test(query) || !new RegExp(`\\b${SOURCE_ALIAS}\\s*\\.\\s*data\\b`, 'i').test(query)) {
      widgetSourceError('invalid_input', `${prefix}Data Room widget SQL must be one read-only SELECT/WITH over ${SOURCE_ALIAS}.data`, `Correct ${path}.sql to one read-only query that references ${SOURCE_ALIAS}.data.`, dataRoomIssue({
        code: 'data_room_sql_required', path: `${path}.sql`, message: `${path}.sql must be one read-only SELECT/WITH over ${SOURCE_ALIAS}.data.`,
        expected: { kind: 'relation', description: `One SELECT/WITH statement references ${SOURCE_ALIAS}.data.` }, received: source.sql,
      }));
    }
    const params = source.params ?? [];
    if (!Array.isArray(params) || params.length > 100
      || params.some(value => value !== null && (!['string', 'number', 'boolean'].includes(typeof value)
        || (typeof value === 'number' && !Number.isFinite(value))))) {
      widgetSourceError('invalid_input', `${prefix}Data Room widget params must contain at most 100 finite scalar values`, 'Use an array of at most 100 strings, finite numbers, booleans, or null values.', dataRoomIssue({
        code: 'invalid_params', path: `${path}.params`, message: `${path}.params must contain at most 100 finite scalar values.`,
        expected: { kind: 'range', type: 'array', minimum: 0, maximum: 100 }, received: source.params,
      }));
    }
    const limit = source.limit ?? 100;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 200) {
      widgetSourceError('invalid_input', `${prefix}Data Room widget limit must be from 1 to 200`, `Use an integer ${path}.limit from 1 to 200.`, dataRoomIssue({
        code: 'out_of_range', path: `${path}.limit`, message: `${path}.limit must be an integer from 1 to 200.`,
        expected: { kind: 'range', type: 'integer', minimum: 1, maximum: 200 }, received: source.limit, includeReceivedValue: true,
      }));
    }
    return {
      version: 1,
      kind: 'data_room_query',
      datasetId,
      versionId: pinned.versionId,
      sql: query,
      params: params as Array<string | number | boolean | null>,
      limit: limit as number,
    };
  }

  /**
   * Queue one local-only run for a dashboard that reads Data Room datasets:
   * its Data Room widgets plus its static text. Warehouse widgets wait for a
   * refresh; a dashboard without Data Room widgets queues nothing.
   */
  function queueDataRoomWidgetRun(dashboardId: string): AnalyticsRun | undefined {
    const dashboard = getDashboard(dashboardId);
    if (!dashboard?.widgets.some(isDataRoomQueryWidget)) return undefined;
    const widgetIds = dashboard.widgets
      .filter(widget => isDataRoomQueryWidget(widget) || widget.kind === 'text')
      .map(widget => widget.id);
    return enqueueDashboard(dashboard, 'agent', widgetIds);
  }

  function configureWidgetSource(
    dashboardId: string,
    widgetId: string,
    input: ConfigureAnalyticsWidgetSourceInput,
  ): AnalyticsWidgetSourceMutationResult {
    const sourceError = widgetSourceError;
    const dashboard = getDashboard(dashboardId);
    if (!dashboard) {
      sourceError('not_found', `Dashboard ${dashboardId} not found`, 'Refresh the dashboard list and use one exact current dashboard ID.', dataRoomIssue({
        code: 'not_found', path: 'dashboardId', message: 'dashboardId does not identify a current dashboard.',
        expected: { kind: 'relation', description: 'ID identifies one current analytics dashboard.' }, received: dashboardId, includeReceivedValue: true,
      }));
    }
    if (!input || typeof input !== 'object') {
      sourceError('invalid_input', 'Widget source configuration input must be an object', 'Send expectedWidgetRevision and one complete source object.', dataRoomIssue({
        code: 'invalid_type', path: '$', message: 'Widget source configuration arguments must be one object.',
        expected: { kind: 'type', type: 'object' }, received: input,
      }));
    }
    if (!Number.isInteger(input.expectedWidgetRevision) || input.expectedWidgetRevision < 1) {
      sourceError('invalid_input', 'Widget source configuration requires an exact positive widget revision', 'Read the exact widget revision and retry once.', dataRoomIssue({
        code: 'out_of_range', path: 'expectedWidgetRevision', message: 'expectedWidgetRevision must be a positive integer.',
        expected: { kind: 'range', type: 'integer', minimum: 1 }, received: input.expectedWidgetRevision, includeReceivedValue: true,
      }));
    }
    if (!isPlainObject(input.source)) {
      sourceError('invalid_input', 'Widget source configuration requires one source object', 'Send one source object matching warehouse_sql or data_room_query.', dataRoomIssue({
        code: 'invalid_type', path: 'source', message: 'source must be one fully specified source object.',
        expected: { kind: 'type', type: 'object' }, received: input.source,
      }));
    }
    const dashboardStatus = (db.prepare('SELECT status FROM analytics_dashboards WHERE id = ?').get(dashboardId) as { status: string }).status;
    if (dashboardStatus === 'archived') {
      sourceError('archived', 'Archived dashboard widget sources cannot change', 'Restore the dashboard before requesting a source change.', dataRoomIssue({
        code: 'archived_target', path: 'dashboardId', message: 'The target dashboard is archived.',
        expected: { kind: 'relation', description: 'Dashboard status is not archived.' }, received: dashboardId, includeReceivedValue: true,
      }));
    }
    const running = activeRun(dashboardId);
    if (running) {
      sourceError('active_run', `Widget source cannot change while refresh ${running.id} is ${running.status}`, `Observe exact run ${running.id}; retry only after it is terminal.`, dataRoomIssue({
        code: 'active_run', path: 'dashboardId', message: 'The dashboard has an active refresh, so source configuration cannot begin.',
        expected: { kind: 'relation', description: 'Dashboard has no queued or running refresh.' }, received: dashboardId, includeReceivedValue: true,
      }));
    }
    const current = db.prepare('SELECT * FROM analytics_widgets WHERE id = ? AND dashboard_id = ?')
      .get(widgetId, dashboardId) as any;
    if (!current) {
      sourceError('not_found', `Widget ${widgetId} not found`, 'Refresh the dashboard and use one exact current widget ID.', dataRoomIssue({
        code: 'not_found', path: 'widgetId', message: 'widgetId does not identify a widget in dashboardId.',
        expected: { kind: 'relation', description: 'Widget belongs to the exact target dashboard.' }, received: widgetId, includeReceivedValue: true,
      }));
    }
    const currentRevision = Number(current.revision || 1);
    if (currentRevision !== input.expectedWidgetRevision) {
      sourceError('conflict', `Widget revision changed from expected ${input.expectedWidgetRevision} to ${currentRevision}`, 'Refresh the exact widget, preserve the requested source intent, and retry with the returned revision.', dataRoomIssue({
        code: 'revision_conflict', path: 'expectedWidgetRevision', message: `expectedWidgetRevision must equal current revision ${currentRevision}.`,
        expected: { kind: 'literal', value: currentRevision }, received: input.expectedWidgetRevision, includeReceivedValue: true,
      }));
    }
    if (current.kind === 'text') {
      sourceError('invalid_input', 'Static text widgets do not have an analytical data source', 'Select one non-text analytics widget.', dataRoomIssue({
        code: 'unsupported_widget_kind', path: 'widgetId', message: 'The selected widget must have an analytical data source.',
        expected: { kind: 'relation', description: 'Widget kind is metric, table, bar, line, or visualization.' }, received: widgetId, includeReceivedValue: true,
      }));
    }
    if (dataRoom?.getBinding(widgetId)) {
      sourceError('binding_not_compatible', 'Widget has an existing managed binding; disconnect it explicitly before configuring an independent source', 'Ask the owner to disconnect this exact managed binding first; do not unbind implicitly.', dataRoomIssue({
        code: 'managed_binding_present', path: 'widgetId', message: 'Independent source configuration requires a widget without a managed Data Room binding.',
        expected: { kind: 'relation', description: 'No managed binding exists for this widget.' }, received: widgetId, includeReceivedValue: true,
      }));
    }
    const source = input.source as AnalyticsWidgetSourceInput;
    const receivedSourceKind = (source as unknown as Record<string, unknown>).kind;
    const sourceKeys = Object.keys(source);
    let descriptor!: AnalyticsWidgetSourceV1;
    let sqlQuery: string | null;
    let preset: string | null;
    if (source.kind === 'warehouse_sql') {
      const extras = sourceKeys.filter(key => !['kind', 'sql', 'preset'].includes(key)).sort();
      if (extras.length) {
        sourceError('invalid_input', `Warehouse source contains unsupported fields: ${extras.join(', ')}`, 'Use only kind, sql, and optional preset for warehouse_sql.', extras.map(key => dataRoomIssue({
          code: 'unsupported_field', path: `source.${key}`, message: `${key} is not allowed for warehouse_sql.`,
          expected: { kind: 'absent' }, received: (source as unknown as Record<string, unknown>)[key],
        })));
      }
      descriptor = { version: 1, kind: 'warehouse_sql' };
      try {
        sqlQuery = validateReadOnlySql(source.sql);
      } catch (error) {
        sourceError('invalid_input', error instanceof Error ? error.message : 'Warehouse SQL was rejected.', 'Correct source.sql to one read-only warehouse SELECT/WITH.', dataRoomIssue({
          code: 'read_only_sql_required', path: 'source.sql', message: 'source.sql must be one read-only SELECT/WITH statement.',
          expected: { kind: 'pattern', type: 'string', pattern: '^(SELECT|WITH)\\b' }, received: source.sql,
        }));
      }
      preset = cleanText(source.preset, 'source.preset', 256) || null;
    } else if (source.kind === 'data_room_query') {
      descriptor = resolveDataRoomWidgetSource(source as unknown as Record<string, unknown>, 'source');
      sqlQuery = null;
      preset = null;
    } else {
      sourceError('invalid_input', 'Widget source kind must be warehouse_sql or data_room_query', 'Set source.kind to exactly warehouse_sql or data_room_query.', dataRoomIssue({
        code: 'invalid_enum', path: 'source.kind', message: 'source.kind must be one supported literal.',
        expected: { kind: 'enum', values: ['warehouse_sql', 'data_room_query'] }, received: receivedSourceKind, includeReceivedValue: true,
      }));
    }
    const currentConfig = parseJson<Record<string, unknown>>(current.config_json, {});
    const nextConfig = { ...currentConfig, dataSource: descriptor };
    const sourceConfigSha256 = analyticsSha256(descriptor);
    let run!: AnalyticsRun;
    db.transaction(() => {
      const changed = db.prepare(`
        UPDATE analytics_widgets
        SET sql_query=?, preset=?, config_json=?, result_json=NULL, last_error=NULL,
            last_refreshed_at=NULL, revision=revision+1, updated_at=datetime('now')
        WHERE id=? AND dashboard_id=? AND revision=?
      `).run(sqlQuery, preset, JSON.stringify(nextConfig), widgetId, dashboardId, input.expectedWidgetRevision);
      if (changed.changes !== 1) {
        sourceError('conflict', 'Widget changed during source configuration', 'Refresh the exact widget state and retry once with its current revision.', dataRoomIssue({
          code: 'revision_conflict', path: 'expectedWidgetRevision', message: 'Widget revision changed before the transaction committed.',
          expected: { kind: 'relation', description: 'Value equals the widget revision at transaction commit.' }, received: input.expectedWidgetRevision, includeReceivedValue: true,
        }));
      }
      run = enqueueDashboard(getDashboard(dashboardId)!, 'agent', [widgetId]);
    }).immediate();
    const widget = mapWidget(db.prepare('SELECT * FROM analytics_widgets WHERE id = ?').get(widgetId));
    return { widget, run, sourceConfigSha256 };
  }

  function editError(code: AnalyticsWidgetEditErrorCode, message: string, nextAction: string): never {
    throw new AnalyticsWidgetEditError(code, message, nextAction);
  }

  function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
    const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
    if (unexpected.length) editError('invalid_input', `${label} contains unsupported fields: ${unexpected.join(', ')}.`, 'Use only the closed edit schema; do not supply SQL, bindings, revisions, datasets, or hashes.');
  }

  function cloneJsonValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  function normalizeEditPresentation(value: unknown): AnalyticsWidgetEditPresentation | undefined {
    if (value === undefined) return undefined;
    if (!isPlainObject(value)) editError('invalid_input', 'presentation must be a plain object.', 'Provide only renderer, title, subtitle, or layout.');
    assertOnlyKeys(value, ['renderer', 'title', 'subtitle', 'layout'], 'presentation');
    if (!Object.keys(value).length) editError('invalid_input', 'presentation must contain at least one change.', 'Provide a renderer, title, subtitle, or layout.');
    const renderer = value.renderer;
    if (renderer !== undefined && !['line', 'bar', 'area', 'point'].includes(String(renderer))) {
      editError('invalid_input', 'presentation.renderer must be line, bar, area, or point.', 'Choose one supported data-preserving renderer.');
    }
    const layout = value.layout;
    if (layout !== undefined && !['vconcat', 'hconcat'].includes(String(layout))) {
      editError('invalid_input', 'presentation.layout must be vconcat or hconcat.', 'Choose one supported common-rowset layout.');
    }
    const title = value.title === undefined
      ? undefined
      : cleanText(value.title, 'presentation.title', 200, true).normalize('NFC');
    const subtitle = value.subtitle === undefined
      ? undefined
      : cleanText(value.subtitle, 'presentation.subtitle', 500).normalize('NFC');
    return {
      ...(renderer === undefined ? {} : { renderer: renderer as AnalyticsWidgetEditPresentation['renderer'] }),
      ...(title === undefined ? {} : { title }),
      ...(subtitle === undefined ? {} : { subtitle }),
      ...(layout === undefined ? {} : { layout: layout as AnalyticsWidgetEditPresentation['layout'] }),
    };
  }

  function normalizeWidgetEditInput(value: AnalyticsWidgetEditInput): AnalyticsWidgetEditInput {
    if (!isPlainObject(value)) editError('invalid_input', 'Widget edit input must be a plain object.', 'Use the closed edit_analytics_dashboard schema.');
    assertOnlyKeys(value, ['action', 'dashboardId', 'widgetIds', 'presentation', 'dateRange'], 'Widget edit input');
    const action = String(value.action ?? '');
    if (!['presentation', 'date_range', 'add_from_widget', 'combine_compatible_widgets'].includes(action)) {
      editError('invalid_input', 'Unknown widget edit action.', 'Choose presentation, date_range, add_from_widget, or combine_compatible_widgets.');
    }
    const dashboardId = cleanText(value.dashboardId, 'dashboardId', 128, true);
    if (!/^dash_[a-zA-Z0-9_-]{1,96}$/.test(dashboardId)) editError('invalid_input', 'dashboardId is invalid.', 'Copy the exact dashboard ID from the canonical dashboard receipt.');
    if (!Array.isArray(value.widgetIds)) editError('invalid_input', 'widgetIds must be an array.', 'Provide exact source/target widget IDs.');
    const widgetIds = value.widgetIds.map((id, index) => {
      const normalized = cleanText(id, `widgetIds[${index}]`, 128, true);
      if (!/^widget_[a-zA-Z0-9_-]{1,96}$/.test(normalized)) editError('invalid_input', `widgetIds[${index}] is invalid.`, 'Copy exact widget IDs from the canonical dashboard receipt.');
      return normalized;
    });
    if (new Set(widgetIds).size !== widgetIds.length) editError('invalid_input', 'widgetIds must be unique.', 'Remove duplicate widget IDs.');
    const presentation = normalizeEditPresentation(value.presentation);
    let dateRange = value.dateRange;
    if (dateRange !== undefined) {
      if (!isPlainObject(dateRange)) editError('invalid_input', 'dateRange must be a plain object.', 'Provide inclusive start and end ISO dates.');
      assertOnlyKeys(dateRange, ['start', 'end'], 'dateRange');
      const start = String(dateRange.start ?? '');
      const end = String(dateRange.end ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
        editError('invalid_input', 'dateRange must contain ordered inclusive YYYY-MM-DD dates.', 'Correct the requested start/end dates.');
      }
      dateRange = { start, end };
    }
    if (action === 'presentation') {
      if (widgetIds.length !== 1 || !presentation || presentation.layout || dateRange) editError('invalid_input', 'presentation requires one widget, presentation fields, no layout, and no dateRange.', 'Submit one exact presentation-only edit.');
    } else if (action === 'date_range') {
      if (widgetIds.length !== 1 || !dateRange || presentation) editError('invalid_input', 'date_range requires one widget and dateRange only.', 'Submit one exact date-range edit.');
    } else if (action === 'add_from_widget') {
      if (widgetIds.length !== 1 || !presentation?.title || presentation.layout || dateRange) editError('invalid_input', 'add_from_widget requires one source widget and a titled presentation without layout/dateRange.', 'Name the new view and optionally choose its renderer/subtitle.');
    } else if (widgetIds.length !== 2 || dateRange || presentation?.renderer) {
      editError('invalid_input', 'combine_compatible_widgets requires exactly two sources, optional title/subtitle/layout, and no renderer/dateRange.', 'Choose two exact compatible visualization widget IDs.');
    }
    return {
      action: action as AnalyticsWidgetEditInput['action'],
      dashboardId,
      widgetIds,
      ...(presentation ? { presentation } : {}),
      ...(dateRange ? { dateRange } : {}),
    };
  }

  function assertEditableDataRoomDashboard(dashboardId: string): AnalyticsDashboard {
    if (!dataRoomEnabled || !dataRoom) editError('data_room_unavailable', 'Data-room widget editing is unavailable or disabled.', 'Enable the existing R4 data-room widget capability before retrying; do not fall back to SQL/ETL.');
    const dashboard = getDashboard(dashboardId);
    if (!dashboard) editError('not_found', `Dashboard ${dashboardId} was not found.`, 'Copy the exact current dashboard ID.');
    const persisted = db.prepare('SELECT status FROM analytics_dashboards WHERE id = ?').get(dashboardId) as { status: string } | undefined;
    if (!persisted || persisted.status === 'archived') editError('archived', `Dashboard ${dashboardId} is archived.`, 'Restore the dashboard before editing its widgets.');
    const running = activeRun(dashboardId);
    if (running) editError('active_run', `Dashboard edit conflicts with refresh ${running.id} (${running.status}).`, 'Wait for that exact run to finish or cancel it explicitly before retrying.');
    return dashboard;
  }

  function bindingInputFromCurrent(
    binding: NonNullable<AnalyticsWidget['binding']>,
    dateRange?: { start: string; end: string },
  ) {
    return {
      datasetId: binding.datasetId,
      versionPolicy: binding.versionPolicy,
      ...(binding.pinnedVersionId ? { pinnedVersionId: binding.pinnedVersionId } : {}),
      expectedSchemaSha256: binding.expectedSchemaSha256,
      ...(binding.expectedContractSha256 ? { expectedContractSha256: binding.expectedContractSha256 } : {}),
      requiredColumns: [...binding.requiredColumns],
      request: {
        ...cloneJsonValue(binding.request),
        ...(dateRange ? { dateRange } : {}),
      },
      presentationLimit: binding.presentationLimit,
    };
  }

  function currentLocalWidget(dashboardId: string, widgetId: string): {
    widget: AnalyticsWidget;
    binding: NonNullable<AnalyticsWidget['binding']>;
    result: AnalyticsWidgetResult & { source: Extract<NonNullable<AnalyticsWidgetResult['source']>, { provider: 'data-room' }> };
  } {
    const row = db.prepare('SELECT * FROM analytics_widgets WHERE id = ? AND dashboard_id = ?').get(widgetId, dashboardId);
    if (!row) editError('not_found', `Widget ${widgetId} was not found in dashboard ${dashboardId}.`, 'Copy the exact current widget ID from this dashboard.');
    const widget = mapWidget(row);
    const binding = widget.binding;
    if (!binding) editError('binding_required', `Widget ${widgetId} has no data-room binding.`, 'Bind the widget through the owner data-room flow before using this composite.');
    if (binding.compatibility !== 'compatible') editError('binding_not_compatible', `Widget ${widgetId} binding is ${binding.compatibility}.`, binding.compatibilityError || 'Resolve the current binding before retrying.');
    const source = widget.result?.source;
    if (widget.result?.trust !== 'local_verified_data' || !source || source.provider !== 'data-room') {
      editError('result_provenance_mismatch', `Widget ${widgetId} has no current verified local result.`, 'Refresh this exact binding locally and verify its receipt before editing.');
    }
    if (source.widgetRevision !== widget.revision
      || source.bindingRevision !== binding.revision
      || source.datasetId !== binding.datasetId
      || source.versionId !== binding.lastAppliedVersionId) {
      editError('result_provenance_mismatch', `Widget ${widgetId} result does not match its current widget/binding revision.`, 'Inspect the exact current run and binding receipt; do not reuse stale rows.');
    }
    const pendingLate = db.prepare(`
      SELECT 1 FROM analytics_late_etl_results
      WHERE widget_id = ? AND state IN ('pending','checking') LIMIT 1
    `).get(widgetId);
    if (pendingLate) editError('conflict', `Widget ${widgetId} has a pending legacy ETL continuation.`, 'Let the existing continuation settle before changing this widget.');
    const prepared = dataRoom!.prepareSnapshot(widgetId);
    if (!prepared || prepared.resolutionState !== 'compatible' || !prepared.version || !prepared.compiled
      || prepared.binding.revision !== binding.revision
      || prepared.version.id !== source.versionId
      || prepared.compiled.querySha256 !== source.querySha256) {
      editError('result_provenance_mismatch', `Widget ${widgetId} no longer resolves to its displayed immutable result.`, 'Use the current compatible head/result before retrying; do not silently move versions.');
    }
    return {
      widget,
      binding,
      result: widget.result as AnalyticsWidgetResult & { source: Extract<NonNullable<AnalyticsWidgetResult['source']>, { provider: 'data-room' }> },
    };
  }

  function presentationWidget(
    source: AnalyticsWidget,
    presentation: AnalyticsWidgetEditPresentation,
    position: number,
  ): AnalyticsWidgetInput {
    let config = cloneJsonValue(source.config);
    if (presentation.renderer) {
      if (source.kind !== 'visualization') editError('invalid_input', `Widget ${source.id} is not a visualization.`, 'Choose a visualization source for renderer changes.');
      const spec = cloneJsonValue(jsonObject(config.spec));
      if (!Object.prototype.hasOwnProperty.call(spec, 'mark')) {
        editError('invalid_input', `Widget ${source.id} has no single root mark to change.`, 'Use combine_compatible_widgets for composed views or change only title/subtitle.');
      }
      const currentMark = spec.mark;
      spec.mark = isPlainObject(currentMark)
        ? { ...currentMark, type: presentation.renderer }
        : presentation.renderer;
      config = { ...config, spec };
    }
    return normalizeWidget({
      kind: source.kind,
      title: presentation.title === undefined ? source.title : presentation.title,
      subtitle: presentation.subtitle === undefined ? source.subtitle : presentation.subtitle,
      sql: source.sql,
      preset: source.preset,
      config,
    }, position);
  }

  function assertCommonRowset(
    left: ReturnType<typeof currentLocalWidget>,
    right: ReturnType<typeof currentLocalWidget>,
  ): void {
    const a = left.result.source;
    const b = right.result.source;
    const same = left.binding.datasetId === right.binding.datasetId
      && left.binding.requestSha256 === right.binding.requestSha256
      && left.binding.expectedSchemaSha256 === right.binding.expectedSchemaSha256
      && left.binding.expectedContractSha256 === right.binding.expectedContractSha256
      && a.versionId === b.versionId
      && a.querySha256 === b.querySha256
      && a.compilerVersion === b.compilerVersion
      && a.contentSha256 === b.contentSha256
      && a.schemaSha256 === b.schemaSha256
      && a.contractSha256 === b.contractSha256
      && a.definitionSha256 === b.definitionSha256
      && JSON.stringify(left.result.columns) === JSON.stringify(right.result.columns)
      && JSON.stringify(left.result.rows) === JSON.stringify(right.result.rows)
      && left.result.rowCount === right.result.rowCount
      && left.result.displayedRowCount === right.result.displayedRowCount;
    if (!same) {
      editError(
        'derived_data_required',
        'The selected widgets do not share one exact dataset/request/version/query rowset.',
        'Create a saved derived dataset with declared keys/cardinality first; this tool will not join sibling results or perform model arithmetic.',
      );
    }
  }

  function normalizeDurableEditIdentity(
    input: AnalyticsWidgetEditInput,
    identity: AnalyticsWidgetEditRequestIdentity | undefined,
  ): NormalizedAnalyticsEditIdentity {
    if (!identity || !isPlainObject(identity)) {
      editError('invalid_input', 'Durable add/combine edits require server-owned request identity.', 'Retry through the live owner chat boundary; do not call this mutation without request identity.');
    }
    const ownerRequestId = cleanText(identity.ownerRequestId, 'ownerRequestId', 128, true);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(ownerRequestId)) {
      editError('invalid_input', 'ownerRequestId is invalid.', 'Use the stable request ID supplied by the live chat boundary.');
    }
    const ownerMessage = cleanText(identity.ownerMessage, 'ownerMessage', 20_000, true)
      .replace(/\r\n?/g, '\n').normalize('NFC').trim();
    if (!isPlainObject(identity.ownerScope)) {
      editError('invalid_input', 'ownerScope is required.', 'Use the server-canonical owner scope.');
    }
    const scope = identity.ownerScope;
    if (!['dashboard_widget_selection', 'owner_exact_ids', 'model_resolved'].includes(scope.source)
      || scope.dashboardId !== input.dashboardId
      || !Array.isArray(scope.orderedWidgetIds)
      || scope.orderedWidgetIds.length !== input.widgetIds.length
      || !scope.orderedWidgetIds.every((id, index) => id === input.widgetIds[index])) {
      editError('invalid_input', 'Owner scope does not exactly match the normalized edit target.', 'Use the exact server-authorized dashboard and ordered widgets.');
    }
    if (typeof identity.explicitNew !== 'boolean') {
      editError('invalid_input', 'explicitNew must be a boolean.', 'Pass createNew=true only when the owner asked for another copy; otherwise omit it.');
    }
    const ownerMessageValue = { version: 1, text: ownerMessage };
    const ownerScopeValue = {
      version: 1,
      source: scope.source,
      dashboardId: input.dashboardId,
      orderedWidgetIds: [...input.widgetIds],
    };
    const presentation = input.action === 'combine_compatible_widgets'
      ? {
          ...(input.presentation?.title === undefined ? {} : { title: input.presentation.title }),
          ...(input.presentation?.subtitle ? { subtitle: input.presentation.subtitle } : {}),
          layout: input.presentation?.layout ?? 'vconcat',
        }
      : {
          ...(input.presentation?.renderer === undefined ? {} : { renderer: input.presentation.renderer }),
          ...(input.presentation?.title === undefined ? {} : { title: input.presentation.title }),
          ...(input.presentation?.subtitle === undefined ? {} : { subtitle: input.presentation.subtitle }),
        };
    const requestIntentValue = {
      version: 1,
      action: input.action,
      dashboardId: input.dashboardId,
      orderedSourceWidgetIds: [...input.widgetIds],
      presentation,
    };
    const requestIntentJson = stableAnalyticsJson(requestIntentValue);
    const requestIntentSha256 = analyticsSha256(requestIntentValue);
    return {
      ownerRequestId,
      ownerMessageJson: stableAnalyticsJson(ownerMessageValue),
      ownerMessageSha256: analyticsSha256(ownerMessageValue),
      ownerScopeJson: stableAnalyticsJson(ownerScopeValue),
      ownerScopeSha256: analyticsSha256(ownerScopeValue),
      requestIntentJson,
      requestIntentSha256,
      // Same-request replay uses requestIntent*. Fresh-request semantic lookup
      // replaces these placeholders with an exact current source effect seed.
      intentJson: requestIntentJson,
      intentSha256: requestIntentSha256,
      explicitNew: identity.explicitNew,
    };
  }

  function withSourceSemanticIntent(
    identity: NormalizedAnalyticsEditIdentity,
    sources: Array<ReturnType<typeof currentLocalWidget>>,
  ): NormalizedAnalyticsEditIdentity {
    const requestIntent = parseCanonicalReceiptJson<unknown>(identity.requestIntentJson, 'Current request intent');
    const sourceEffectSeed = sources.map(source => ({
      widgetId: source.widget.id,
      widgetRevision: source.widget.revision,
      kind: source.widget.kind,
      title: source.widget.title,
      subtitle: source.widget.subtitle,
      configSha256: analyticsSha256(source.widget.config),
      binding: {
        revision: source.binding.revision,
        datasetId: source.binding.datasetId,
        requestSha256: source.binding.requestSha256,
        expectedSchemaSha256: source.binding.expectedSchemaSha256,
        expectedContractSha256: source.binding.expectedContractSha256 ?? null,
        lastAppliedVersionId: source.binding.lastAppliedVersionId ?? null,
      },
      result: {
        versionId: source.result.source.versionId,
        querySha256: source.result.source.querySha256,
        compilerVersion: source.result.source.compilerVersion,
        contentSha256: source.result.source.contentSha256,
        schemaSha256: source.result.source.schemaSha256,
        contractSha256: source.result.source.contractSha256,
        definitionSha256: source.result.source.definitionSha256,
        rowsetSha256: analyticsSha256({
          columns: source.result.columns,
          rows: source.result.rows,
          rowCount: source.result.rowCount,
          displayedRowCount: source.result.displayedRowCount,
        }),
      },
    }));
    const intentValue = { version: 1, requestIntent, sourceEffectSeed };
    return {
      ...identity,
      intentJson: stableAnalyticsJson(intentValue),
      intentSha256: analyticsSha256(intentValue),
    };
  }

  function parseCanonicalReceiptJson<T>(raw: string, label: string): T {
    let parsed: T;
    try {
      parsed = JSON.parse(raw) as T;
    } catch {
      editError('replay_target_invalid', `${label} is malformed.`, 'Inspect or restore the durable edit receipt; never recreate the widget automatically.');
    }
    if (stableAnalyticsJson(parsed) !== raw) {
      editError('replay_target_invalid', `${label} is not canonical.`, 'Inspect or restore the durable edit receipt; never recreate the widget automatically.');
    }
    return parsed;
  }

  function validateReceiptHashes(row: AnalyticsDashboardEditReceiptRow): void {
    const ownerMessage = parseCanonicalReceiptJson<unknown>(row.owner_message_json, 'Stored owner message');
    const ownerScope = parseCanonicalReceiptJson<unknown>(row.owner_scope_json, 'Stored owner scope');
    const requestIntent = parseCanonicalReceiptJson<unknown>(row.request_intent_json, 'Stored request intent');
    const intent = parseCanonicalReceiptJson<unknown>(row.intent_json, 'Stored semantic intent');
    const effect = parseCanonicalReceiptJson<unknown>(row.mutation_receipt_json, 'Stored mutation receipt');
    if (analyticsSha256(ownerMessage) !== row.owner_message_sha256
      || analyticsSha256(ownerScope) !== row.owner_scope_sha256
      || analyticsSha256(requestIntent) !== row.request_intent_sha256
      || analyticsSha256(intent) !== row.intent_sha256
      || analyticsSha256(effect) !== row.effect_sha256
      || row.intent_version !== 1 || row.effect_version !== 1) {
      editError('replay_target_invalid', `Durable edit receipt ${row.id} failed its hash/version checks.`, 'Inspect or restore the durable edit receipt; never recreate the widget automatically.');
    }
  }

  function receiptById(id: string): AnalyticsDashboardEditReceiptRow | undefined {
    return db.prepare('SELECT * FROM analytics_dashboard_edit_receipts WHERE id = ?')
      .get(id) as AnalyticsDashboardEditReceiptRow | undefined;
  }

  function canonicalReceipt(row: AnalyticsDashboardEditReceiptRow): AnalyticsDashboardEditReceiptRow {
    validateReceiptHashes(row);
    if (!row.replay_of_receipt_id) return row;
    const canonical = receiptById(row.replay_of_receipt_id);
    if (!canonical || canonical.replay_of_receipt_id) {
      editError('replay_target_invalid', `Replay receipt ${row.id} does not point directly to one canonical receipt.`, 'Inspect or restore the receipt chain; never recreate the widget automatically.');
    }
    validateReceiptHashes(canonical);
    if (row.request_intent_json !== canonical.request_intent_json
      || row.request_intent_sha256 !== canonical.request_intent_sha256
      || row.intent_version !== canonical.intent_version
      || row.intent_json !== canonical.intent_json
      || row.intent_sha256 !== canonical.intent_sha256
      || row.action !== canonical.action
      || row.dashboard_id !== canonical.dashboard_id
      || row.source_widget_ids_json !== canonical.source_widget_ids_json
      || row.explicit_new !== canonical.explicit_new
      || row.created_widget_id !== canonical.created_widget_id
      || row.run_id !== canonical.run_id
      || row.effect_version !== canonical.effect_version
      || row.effect_sha256 !== canonical.effect_sha256
      || row.mutation_receipt_json !== canonical.mutation_receipt_json) {
      editError('replay_target_invalid', `Replay receipt ${row.id} disagrees with canonical receipt ${canonical.id}.`, 'Inspect or restore the durable receipt chain; never recreate the widget automatically.');
    }
    return canonical;
  }

  function validateRequestReceipt(
    row: AnalyticsDashboardEditReceiptRow,
    input: AnalyticsWidgetEditInput,
    identity: NormalizedAnalyticsEditIdentity,
  ): void {
    validateReceiptHashes(row);
    if (row.owner_message_json !== identity.ownerMessageJson
      || row.owner_message_sha256 !== identity.ownerMessageSha256
      || row.owner_scope_json !== identity.ownerScopeJson
      || row.owner_scope_sha256 !== identity.ownerScopeSha256
      || row.request_intent_json !== identity.requestIntentJson
      || row.request_intent_sha256 !== identity.requestIntentSha256
      || row.intent_version !== 1
      || row.action !== input.action
      || row.dashboard_id !== input.dashboardId
      || row.source_widget_ids_json !== stableAnalyticsJson(input.widgetIds)
      || Boolean(row.explicit_new) !== identity.explicitNew) {
      editError('request_identity_conflict', `Owner request ${identity.ownerRequestId} was already bound to a different edit identity.`, 'Use a fresh request ID only for a genuinely new owner send; never reinterpret an existing request.');
    }
  }

  function replayMutation(
    requestRow: AnalyticsDashboardEditReceiptRow,
    replayReason: 'same_request' | 'semantic_intent',
  ): AnalyticsWidgetEditMutationResult {
    const canonical = canonicalReceipt(requestRow);
    const sourceWidgetIds = parseCanonicalReceiptJson<string[]>(canonical.source_widget_ids_json, 'Stored source widget IDs');
    if (!Array.isArray(sourceWidgetIds) || !sourceWidgetIds.length
      || sourceWidgetIds.some(widgetId => !db.prepare('SELECT 1 FROM analytics_widgets WHERE id = ? AND dashboard_id = ?').get(widgetId, canonical.dashboard_id))) {
      editError('replay_target_invalid', `Receipt ${canonical.id} source widgets no longer exist in their dashboard.`, 'Inspect or restore the canonical source widgets; never create a replacement automatically.');
    }
    const widgetRow = db.prepare('SELECT * FROM analytics_widgets WHERE id = ? AND dashboard_id = ?')
      .get(canonical.created_widget_id, canonical.dashboard_id);
    const runRow = db.prepare('SELECT dashboard_id, refresh_scope FROM analytics_runs WHERE id = ?')
      .get(canonical.run_id) as { dashboard_id: string; refresh_scope: string } | undefined;
    const child = db.prepare('SELECT 1 FROM analytics_run_widgets WHERE run_id = ? AND widget_id = ?')
      .get(canonical.run_id, canonical.created_widget_id);
    const snapshot = db.prepare(`
      SELECT widget_revision, binding_revision, dataset_id, dataset_definition_revision,
        dataset_definition_sha256, resolved_head_revision, version_id, content_sha256,
        schema_sha256, contract_sha256, request_sha256, query_sha256, compiler_version,
        execution_receipt_json, applied_at, resolution_state
      FROM analytics_run_widget_data_room_snapshots
      WHERE run_id = ? AND widget_id = ?
    `).get(canonical.run_id, canonical.created_widget_id) as any;
    if (!widgetRow || !runRow || runRow.dashboard_id !== canonical.dashboard_id
      || runRow.refresh_scope !== 'selective' || !child || !snapshot) {
      editError('replay_target_invalid', `Receipt ${canonical.id} no longer has its exact widget/run/snapshot target.`, 'Inspect or restore the canonical target; never recreate it automatically.');
    }
    const storedEffect = parseCanonicalReceiptJson<Record<string, any>>(
      canonical.mutation_receipt_json,
      'Stored mutation receipt',
    );
    const effectValue = {
      version: 1,
      action: canonical.action,
      dashboardId: canonical.dashboard_id,
      orderedSourceWidgetIds: sourceWidgetIds,
      createdWidgetId: canonical.created_widget_id,
      runId: canonical.run_id,
      resultDisposition: 'refresh_queued',
      widgetRevision: Number(snapshot.widget_revision),
      bindingRevision: Number(snapshot.binding_revision),
      createdWidget: storedEffect.createdWidget,
      snapshot: {
        datasetId: snapshot.dataset_id,
        datasetDefinitionRevision: Number(snapshot.dataset_definition_revision),
        datasetDefinitionSha256: snapshot.dataset_definition_sha256,
        resolvedHeadRevision: Number(snapshot.resolved_head_revision),
        versionId: snapshot.version_id,
        contentSha256: snapshot.content_sha256,
        schemaSha256: snapshot.schema_sha256,
        contractSha256: snapshot.contract_sha256,
        requestSha256: snapshot.request_sha256,
        querySha256: snapshot.query_sha256,
        compilerVersion: snapshot.compiler_version,
        resolutionState: snapshot.resolution_state,
      },
    };
    if (stableAnalyticsJson(effectValue) !== canonical.mutation_receipt_json
      || analyticsSha256(effectValue) !== canonical.effect_sha256) {
      editError('replay_target_invalid', `Receipt ${canonical.id} does not match its immutable run snapshot.`, 'Inspect or restore the canonical target; never recreate it automatically.');
    }
    const run = getRun(canonical.run_id);
    if (!run) editError('replay_target_invalid', `Receipt ${canonical.id} run is unavailable.`, 'Restore the exact run; never recreate it automatically.');
    const widget = mapWidget(widgetRow);
    const shape = storedEffect.createdWidget;
    const currentSource = widget.result?.source;
    const currentShapeMatches = isPlainObject(shape)
      && shape.kind === widget.kind
      && shape.title === widget.title
      && shape.subtitle === widget.subtitle
      && shape.preset === (widget.preset ?? '')
      && shape.sqlSha256 === analyticsSha256(widget.sql ?? '')
      && shape.configSha256 === analyticsSha256(widget.config)
      && widget.revision === Number(snapshot.widget_revision)
      && widget.bindingRevision === Number(snapshot.binding_revision)
      && widget.binding?.datasetId === snapshot.dataset_id;
    const completedResultMatches = run.status !== 'completed' || (
      widget.result?.trust === 'local_verified_data'
      && currentSource?.provider === 'data-room'
      && currentSource.widgetRevision === Number(snapshot.widget_revision)
      && currentSource.bindingRevision === Number(snapshot.binding_revision)
      && currentSource.datasetId === snapshot.dataset_id
      && currentSource.versionId === snapshot.version_id
      && currentSource.querySha256 === snapshot.query_sha256
      && currentSource.compilerVersion === snapshot.compiler_version
      && currentSource.contentSha256 === snapshot.content_sha256
      && currentSource.schemaSha256 === snapshot.schema_sha256
      && currentSource.contractSha256 === snapshot.contract_sha256
      && currentSource.definitionSha256 === snapshot.dataset_definition_sha256
    );
    let semanticReceiptMatches = run.status !== 'completed';
    if (run.status === 'completed' && currentSource?.provider === 'data-room'
      && typeof snapshot.execution_receipt_json === 'string' && snapshot.applied_at) {
      parseCanonicalReceiptJson<unknown>(snapshot.execution_receipt_json, 'Stored snapshot execution receipt');
      semanticReceiptMatches = stableAnalyticsJson(currentSource.semanticReceipt) === snapshot.execution_receipt_json;
    }
    if (!currentShapeMatches || !completedResultMatches || !semanticReceiptMatches) {
      editError('replay_target_invalid', `Receipt ${canonical.id} target widget drifted from its committed effect.`, 'Inspect the current widget and canonical receipt; never combine historical completion with mutable live state.');
    }
    const replayedAt = new Date().toISOString();
    db.prepare('UPDATE analytics_dashboard_edit_receipts SET last_replayed_at = ? WHERE id IN (?, ?)')
      .run(replayedAt, requestRow.id, canonical.id);
    return {
      action: canonical.action,
      dashboardId: canonical.dashboard_id,
      sourceWidgetIds,
      widget,
      createdWidgetId: canonical.created_widget_id,
      resultDisposition: 'refresh_queued',
      run,
      receiptId: canonical.id,
      intentVersion: 1,
      intentSha256: canonical.intent_sha256,
      effectSha256: canonical.effect_sha256,
      explicitNew: Boolean(canonical.explicit_new),
      idempotentReplay: true,
      replayReason,
      effectAppliedThisCall: false,
    };
  }

  function insertReplayAlias(
    identity: NormalizedAnalyticsEditIdentity,
    input: AnalyticsWidgetEditInput,
    canonical: AnalyticsDashboardEditReceiptRow,
  ): AnalyticsDashboardEditReceiptRow {
    const id = shortId('aedit');
    const createdAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO analytics_dashboard_edit_receipts
        (id, owner_request_id, owner_message_json, owner_message_sha256,
         owner_scope_json, owner_scope_sha256, request_intent_json,
         request_intent_sha256, intent_version, intent_json,
         intent_sha256, action, dashboard_id, source_widget_ids_json, explicit_new,
         replay_of_receipt_id, created_widget_id, run_id, effect_version,
         effect_sha256, mutation_receipt_json, created_at, last_replayed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      id, identity.ownerRequestId, identity.ownerMessageJson, identity.ownerMessageSha256,
      identity.ownerScopeJson, identity.ownerScopeSha256,
      identity.requestIntentJson, identity.requestIntentSha256,
      identity.intentJson, identity.intentSha256, input.action, input.dashboardId, stableAnalyticsJson(input.widgetIds),
      identity.explicitNew ? 1 : 0, canonical.id, canonical.created_widget_id,
      canonical.run_id, canonical.effect_sha256, canonical.mutation_receipt_json,
      createdAt, createdAt,
    );
    const row = receiptById(id);
    if (!row) editError('replay_target_invalid', 'Semantic replay alias did not persist.', 'Inspect the receipt ledger; never recreate the widget automatically.');
    return row;
  }

  function durableRequestReplay(
    input: AnalyticsWidgetEditInput,
    identity: NormalizedAnalyticsEditIdentity,
  ): AnalyticsWidgetEditMutationResult | undefined {
    const requestRow = db.prepare('SELECT * FROM analytics_dashboard_edit_receipts WHERE owner_request_id = ?')
      .get(identity.ownerRequestId) as AnalyticsDashboardEditReceiptRow | undefined;
    if (!requestRow) return undefined;
    validateRequestReceipt(requestRow, input, identity);
    return replayMutation(requestRow, 'same_request');
  }

  function durableSemanticReplay(
    input: AnalyticsWidgetEditInput,
    identity: NormalizedAnalyticsEditIdentity,
  ): AnalyticsWidgetEditMutationResult | undefined {
    if (identity.explicitNew) return undefined;
    const semantic = db.prepare(`
      SELECT * FROM analytics_dashboard_edit_receipts
      WHERE intent_version = 1 AND intent_sha256 = ?
        AND explicit_new = 0 AND replay_of_receipt_id IS NULL
    `).get(identity.intentSha256) as AnalyticsDashboardEditReceiptRow | undefined;
    if (!semantic) return undefined;
    validateReceiptHashes(semantic);
    if (semantic.request_intent_json !== identity.requestIntentJson
      || semantic.request_intent_sha256 !== identity.requestIntentSha256
      || semantic.intent_json !== identity.intentJson
      || semantic.action !== input.action
      || semantic.dashboard_id !== input.dashboardId
      || semantic.source_widget_ids_json !== stableAnalyticsJson(input.widgetIds)) {
      editError('replay_target_invalid', `Semantic receipt ${semantic.id} conflicts with its indexed intent.`, 'Inspect the receipt ledger; never create another widget automatically.');
    }
    const replay = replayMutation(semantic, 'semantic_intent');
    insertReplayAlias(identity, input, semantic);
    return replay;
  }

  function persistCanonicalEditReceipt(
    input: AnalyticsWidgetEditInput,
    identity: NormalizedAnalyticsEditIdentity,
    widget: AnalyticsWidget,
    run: AnalyticsRun,
  ): Pick<AnalyticsWidgetEditMutationResult, 'receiptId' | 'intentVersion' | 'intentSha256' | 'effectSha256' | 'explicitNew' | 'idempotentReplay' | 'effectAppliedThisCall'> {
    const snapshot = db.prepare(`
      SELECT widget_revision, binding_revision, dataset_id, dataset_definition_revision,
        dataset_definition_sha256, resolved_head_revision, version_id, content_sha256,
        schema_sha256, contract_sha256, request_sha256, query_sha256, compiler_version,
        execution_receipt_json, applied_at, resolution_state
      FROM analytics_run_widget_data_room_snapshots
      WHERE run_id = ? AND widget_id = ?
    `).get(run.id, widget.id) as any;
    if (!snapshot) editError('replay_target_invalid', 'The new edit did not produce its immutable run snapshot.', 'The transaction will roll back; inspect the local snapshot boundary before retrying.');
    const effectValue = {
      version: 1,
      action: input.action,
      dashboardId: input.dashboardId,
      orderedSourceWidgetIds: [...input.widgetIds],
      createdWidgetId: widget.id,
      runId: run.id,
      resultDisposition: 'refresh_queued',
      widgetRevision: Number(snapshot.widget_revision),
      bindingRevision: Number(snapshot.binding_revision),
      createdWidget: {
        kind: widget.kind,
        title: widget.title,
        subtitle: widget.subtitle,
        preset: widget.preset ?? '',
        sqlSha256: analyticsSha256(widget.sql ?? ''),
        configSha256: analyticsSha256(widget.config),
      },
      snapshot: {
        datasetId: snapshot.dataset_id,
        datasetDefinitionRevision: Number(snapshot.dataset_definition_revision),
        datasetDefinitionSha256: snapshot.dataset_definition_sha256,
        resolvedHeadRevision: Number(snapshot.resolved_head_revision),
        versionId: snapshot.version_id,
        contentSha256: snapshot.content_sha256,
        schemaSha256: snapshot.schema_sha256,
        contractSha256: snapshot.contract_sha256,
        requestSha256: snapshot.request_sha256,
        querySha256: snapshot.query_sha256,
        compilerVersion: snapshot.compiler_version,
        resolutionState: snapshot.resolution_state,
      },
    };
    const effectJson = stableAnalyticsJson(effectValue);
    const effectSha256 = analyticsSha256(effectValue);
    const receiptId = shortId('aedit');
    const createdAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO analytics_dashboard_edit_receipts
        (id, owner_request_id, owner_message_json, owner_message_sha256,
         owner_scope_json, owner_scope_sha256, request_intent_json,
         request_intent_sha256, intent_version, intent_json,
         intent_sha256, action, dashboard_id, source_widget_ids_json, explicit_new,
         replay_of_receipt_id, created_widget_id, run_id, effect_version,
         effect_sha256, mutation_receipt_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?, ?)
    `).run(
      receiptId, identity.ownerRequestId, identity.ownerMessageJson, identity.ownerMessageSha256,
      identity.ownerScopeJson, identity.ownerScopeSha256,
      identity.requestIntentJson, identity.requestIntentSha256,
      identity.intentJson, identity.intentSha256, input.action, input.dashboardId, stableAnalyticsJson(input.widgetIds),
      identity.explicitNew ? 1 : 0, widget.id, run.id, effectSha256, effectJson, createdAt,
    );
    return {
      receiptId,
      intentVersion: 1,
      intentSha256: identity.intentSha256,
      effectSha256,
      explicitNew: identity.explicitNew,
      idempotentReplay: false,
      effectAppliedThisCall: true,
    };
  }

  function editDataRoomWidget(
    rawInput: AnalyticsWidgetEditInput,
    rawIdentity?: AnalyticsWidgetEditRequestIdentity,
  ): AnalyticsWidgetEditMutationResult {
    const input = normalizeWidgetEditInput(rawInput);
    const durable = input.action === 'add_from_widget' || input.action === 'combine_compatible_widgets';
    let identity = durable ? normalizeDurableEditIdentity(input, rawIdentity) : undefined;
    try {
      const mutate = db.transaction(() => {
        let durableSources: Array<ReturnType<typeof currentLocalWidget>> | undefined;
        if (identity) {
          const requestReplay = durableRequestReplay(input, identity);
          if (requestReplay) return requestReplay;
          // A fresh request keys semantic reuse to the exact current source
          // state. Same-request replay above intentionally remains historical.
          durableSources = input.widgetIds.map(widgetId => currentLocalWidget(input.dashboardId, widgetId));
          identity = withSourceSemanticIntent(identity, durableSources);
          const semanticReplay = durableSemanticReplay(input, identity);
          if (semanticReplay) return semanticReplay;
        }
        const dashboard = assertEditableDataRoomDashboard(input.dashboardId);
        if (input.action === 'presentation') {
          const current = currentLocalWidget(input.dashboardId, input.widgetIds[0]);
          const normalized = presentationWidget(current.widget, input.presentation!, current.widget.position);
          const nextRevision = current.widget.revision + 1;
          const preservedResult: AnalyticsWidgetResult = {
            ...cloneJsonValue(current.result),
            source: { ...cloneJsonValue(current.result.source), widgetRevision: nextRevision },
          };
          const changed = db.prepare(`
            UPDATE analytics_widgets
            SET kind = ?, title = ?, subtitle = ?, preset = ?, config_json = ?,
                result_json = ?, revision = revision + 1, updated_at = datetime('now')
            WHERE id = ? AND dashboard_id = ? AND revision = ?
              AND NOT EXISTS (
                SELECT 1 FROM analytics_runs run
                WHERE run.dashboard_id = analytics_widgets.dashboard_id
                  AND run.status IN ('queued','running')
              )
          `).run(
            normalized.kind,
            normalized.title,
            normalized.subtitle || '',
            normalized.preset || null,
            JSON.stringify(normalized.config || {}),
            JSON.stringify(preservedResult),
            current.widget.id,
            input.dashboardId,
            current.widget.revision,
          );
          if (changed.changes !== 1) editError('conflict', 'Widget changed during presentation update.', 'Read the current dashboard and retry the exact owner request once.');
          return {
            action: input.action,
            dashboardId: input.dashboardId,
            sourceWidgetIds: [current.widget.id],
            widget: mapWidget(db.prepare('SELECT * FROM analytics_widgets WHERE id = ?').get(current.widget.id)),
            resultDisposition: 'preserved' as const,
          };
        }

        if (input.action === 'date_range') {
          const current = currentLocalWidget(input.dashboardId, input.widgetIds[0]);
          const controls = dataRoom!.getControls(current.widget.id);
          if (!controls) editError('binding_required', `Widget ${current.widget.id} has no controls.`, 'Bind an exact data-room dataset before changing dates.');
          const applied = dataRoom!.applyControls(current.widget.id, {
            expected: {
              widgetRevision: current.widget.revision,
              bindingRevision: current.binding.revision,
              controlRevision: controls.controlRevision,
              controlValuesSha256: controls.currentValuesSha256,
              controlDefinitionSha256: controls.definitionSha256,
              datasetDefinitionRevision: controls.definition.datasetDefinitionRevision,
              datasetDefinitionSha256: controls.definition.datasetDefinitionSha256,
              contractSha256: controls.definition.contractSha256,
            },
            controls: { ...controls.currentValues, dateRange: input.dateRange! },
          });
          const run = applied.changed
            ? enqueueDashboard(getDashboard(input.dashboardId)!, 'agent', [current.widget.id])
            : undefined;
          return {
            action: input.action,
            dashboardId: input.dashboardId,
            sourceWidgetIds: [current.widget.id],
            widget: mapWidget(db.prepare('SELECT * FROM analytics_widgets WHERE id = ?').get(current.widget.id)),
            resultDisposition: applied.changed ? 'refresh_queued' as const : 'preserved' as const,
            ...(run ? { run } : {}),
          };
        }

        if (dashboard.widgets.length >= MAX_WIDGETS) editError('max_widgets', `Dashboard ${input.dashboardId} already has ${MAX_WIDGETS} widgets.`, 'Remove or reuse an existing view before adding another.');
        const sources = durableSources ?? input.widgetIds.map(widgetId => currentLocalWidget(input.dashboardId, widgetId));
        let normalized: AnalyticsWidgetInput;
        if (input.action === 'add_from_widget') {
          normalized = presentationWidget(sources[0].widget, input.presentation!, dashboard.widgets.length);
        } else {
          if (sources.some(source => source.widget.kind !== 'visualization')) {
            editError('invalid_input', 'Combined common-rowset views require visualization sources.', 'Choose two current visualization widget IDs.');
          }
          assertCommonRowset(sources[0], sources[1]);
          const layout = input.presentation?.layout ?? 'vconcat';
          const spec = validateVisualizationSpec({
            [layout]: sources.map(source => cloneJsonValue(jsonObject(source.widget.config.spec))),
            resolve: { scale: { color: 'shared' } },
          });
          normalized = normalizeWidget({
            kind: 'visualization',
            title: input.presentation?.title || `Combined: ${sources[0].widget.title} + ${sources[1].widget.title}`,
            subtitle: input.presentation?.subtitle || 'Compatible views over one exact canonical rowset',
            sql: sources[0].widget.sql,
            preset: sources[0].widget.preset,
            config: { spec },
          }, dashboard.widgets.length);
        }
        const widgetId = shortId('widget');
        const position = Number((db.prepare(`
          SELECT COALESCE(MAX(position), -1) + 1 AS position
          FROM analytics_widgets WHERE dashboard_id = ?
        `).get(input.dashboardId) as { position: number }).position);
        insertWidget(input.dashboardId, widgetId, position, normalized);
        dataRoom!.putBinding(widgetId, 0, bindingInputFromCurrent(sources[0].binding));
        const run = enqueueDashboard(getDashboard(input.dashboardId)!, 'agent', [widgetId]);
        const widget = mapWidget(db.prepare('SELECT * FROM analytics_widgets WHERE id = ?').get(widgetId));
        if (!identity) editError('invalid_input', 'Durable add/combine identity disappeared during mutation.', 'Retry through the live owner chat boundary.');
        const durableReceipt = persistCanonicalEditReceipt(input, identity, widget, run);
        return {
          action: input.action,
          dashboardId: input.dashboardId,
          sourceWidgetIds: [...input.widgetIds],
          widget,
          createdWidgetId: widgetId,
          resultDisposition: 'refresh_queued' as const,
          run,
          ...durableReceipt,
        };
      });
      return identity ? mutate.immediate() : mutate();
    } catch (error) {
      if (error instanceof AnalyticsWidgetEditError) throw error;
      if (error instanceof AnalyticsDashboardDataRoomError) {
        const code: AnalyticsWidgetEditErrorCode = error.code === 'not_found'
          ? 'not_found'
          : error.code === 'conflict'
            ? 'conflict'
            : 'binding_not_compatible';
        throw new AnalyticsWidgetEditError(code, error.message, 'Read the exact current dashboard/binding receipt and retry only after resolving that state.');
      }
      throw error;
    }
  }

  function setSchedule(id: string, input: UpdateAnalyticsScheduleInput): AnalyticsSchedule {
    const dashboard = getDashboard(id);
    if (!dashboard) throw new Error(`Dashboard ${id} not found`);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Schedule input must be an object');
    if (typeof input.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    if (dashboard.status === 'archived' && input.enabled) throw new Error('Archived dashboards cannot enable a refresh schedule');
    const localTime = cleanText(input.localTime, 'localTime', 5, true);
    const timezone = cleanText(input.timezone, 'timezone', 100, true);
    const nextRunAt = nextDailyRun(localTime, timezone).toISOString();
    const existing = db.prepare('SELECT id FROM analytics_schedules WHERE dashboard_id = ?').get(id) as { id: string } | undefined;
    const scheduleId = existing?.id || shortId('schedule');
    db.prepare(`
      INSERT INTO analytics_schedules
        (id, dashboard_id, enabled, schedule_kind, local_time, timezone, next_run_at)
      VALUES (?, ?, ?, 'daily', ?, ?, ?)
      ON CONFLICT(dashboard_id) DO UPDATE SET
        enabled = excluded.enabled,
        local_time = excluded.local_time,
        timezone = excluded.timezone,
        next_run_at = excluded.next_run_at,
        consecutive_failures = CASE
          WHEN analytics_schedules.enabled = 0 AND excluded.enabled = 1 THEN 0
          ELSE analytics_schedules.consecutive_failures
        END,
        last_error = CASE
          WHEN analytics_schedules.enabled = 0 AND excluded.enabled = 1 THEN NULL
          ELSE analytics_schedules.last_error
        END,
        updated_at = datetime('now')
    `).run(scheduleId, id, input.enabled ? 1 : 0, localTime, timezone, nextRunAt);
    const row = db.prepare('SELECT * FROM analytics_schedules WHERE dashboard_id = ?').get(id) as any;
    return mapSchedule(row);
  }

  function enqueueDashboard(
    dashboard: AnalyticsDashboard,
    trigger: AnalyticsRefreshTrigger,
    selectedWidgetIds?: string[],
  ): AnalyticsRun {
    const persistedDashboard = db.prepare('SELECT status FROM analytics_dashboards WHERE id = ?').get(dashboard.id) as { status: string } | undefined;
    if (!persistedDashboard) throw new Error(`Dashboard ${dashboard.id} not found`);
    if (persistedDashboard.status === 'archived') throw new Error('Archived dashboards cannot be refreshed');
    const selective = selectedWidgetIds !== undefined;
    const schedule = !selective && trigger === 'scheduled'
      ? db.prepare('SELECT id FROM analytics_schedules WHERE dashboard_id = ?').get(dashboard.id) as { id: string } | undefined
      : undefined;
    const existing = activeRun(dashboard.id);
    if (existing) {
      if (selective) throw new Error(`Selective refresh conflicts with active refresh ${existing.id}`);
      if (schedule?.id) {
        db.prepare('UPDATE analytics_runs SET schedule_id = COALESCE(schedule_id, ?) WHERE id = ?')
          .run(schedule.id, existing.id);
      }
      db.prepare(`
        UPDATE analytics_dashboards SET status = 'refreshing', updated_at = datetime('now')
        WHERE id = ?
      `).run(dashboard.id);
      return getRun(existing.id)!;
    }

    const selected = selective
      ? (() => {
          const ids = [...new Set(selectedWidgetIds)];
          if (!ids.length || ids.length !== selectedWidgetIds.length) {
            throw new Error('Selective refresh requires unique widget IDs');
          }
          const byId = new Map(dashboard.widgets.map(widget => [widget.id, widget]));
          return ids.map(id => {
            const widget = byId.get(id);
            if (!widget) throw new Error(`Widget ${id} does not belong to dashboard ${dashboard.id}`);
            return widget;
          }).sort((left, right) => left.position - right.position);
        })()
      : dashboard.widgets;
    const prepared = new Map<string, ReturnType<NonNullable<typeof dataRoom>['prepareSnapshot']>>();
    if (dataRoomEnabled && dataRoom) {
      for (const widget of selected) {
        if (dataRoom.getBinding(widget.id)) prepared.set(widget.id, dataRoom.prepareSnapshot(widget.id));
      }
    }

    const runId = shortId('run');
    const queuedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO analytics_runs
        (id, dashboard_id, schedule_id, trigger, status, refresh_scope, widget_count, queued_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(
      runId,
      dashboard.id,
      schedule?.id || null,
      trigger,
      selective ? 'selective' : 'full',
      selected.length,
      queuedAt,
    );
    const insertRunWidget = db.prepare(`
      INSERT INTO analytics_run_widgets
        (run_id, widget_id, widget_revision, position, kind, title, sql_query, config_json, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')
    `);
    for (const widget of selected) {
      insertRunWidget.run(
        runId,
        widget.id,
        widget.revision,
        widget.position,
        widget.kind,
        widget.title,
        widget.sql || null,
        JSON.stringify(widget.config || {}),
      );
      const snapshot = prepared.get(widget.id);
      if (snapshot && dataRoom) dataRoom.persistSnapshot(runId, snapshot);
    }
    db.prepare(`
      UPDATE analytics_dashboards SET status = 'refreshing',
        last_error = CASE WHEN ? = 'full' THEN NULL ELSE last_error END,
        updated_at = datetime('now') WHERE id = ?
    `).run(selective ? 'selective' : 'full', dashboard.id);
    return getRun(runId)!;
  }

  function enqueueRefresh(id: string, trigger: AnalyticsRefreshTrigger = 'manual'): AnalyticsRun {
    if (!['manual', 'scheduled', 'agent'].includes(trigger)) throw new Error('Invalid refresh trigger');
    const dashboard = getDashboard(id);
    if (!dashboard) throw new Error(`Dashboard ${id} not found`);
    if (dashboard.status === 'archived') throw new Error('Archived dashboards cannot be refreshed');
    const enqueue = db.transaction(() => enqueueDashboard(dashboard, trigger));
    try {
      return enqueue();
    } catch (error: any) {
      // The partial unique index is the final deduplication guard if another
      // producer inserted between lookup and insert.
      if (/unique constraint/i.test(String(error?.message || error))) {
        const existing = activeRun(id);
        if (existing) return existing;
      }
      throw error;
    }
  }

  function enqueueSelectiveRefresh(
    dashboardId: string,
    widgetIds: string[],
    trigger: AnalyticsRefreshTrigger = 'manual',
  ): AnalyticsRun {
    if (!['manual', 'agent'].includes(trigger)) throw new Error('Selective refresh trigger must be manual or agent');
    if (!Array.isArray(widgetIds) || widgetIds.length < 1 || widgetIds.length > MAX_WIDGETS
      || widgetIds.some(id => typeof id !== 'string' || !id.trim())) {
      throw new Error(`Selective refresh requires 1 to ${MAX_WIDGETS} widget IDs`);
    }
    const dashboard = getDashboard(dashboardId);
    if (!dashboard) throw new Error(`Dashboard ${dashboardId} not found`);
    if (dashboard.status === 'archived') throw new Error('Archived dashboards cannot be refreshed');
    return db.transaction(() => enqueueDashboard(dashboard, trigger, widgetIds))();
  }

  function updateWidgetBinding(
    dashboardId: string,
    widgetId: string,
    input: UpdateAnalyticsWidgetBindingInput,
  ): AnalyticsWidgetBindingMutationResult {
    if (!dataRoom) throw new Error('Analytics data-room binding service is unavailable');
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0
      || !Object.prototype.hasOwnProperty.call(input, 'binding')) {
      throw new Error('Binding update requires expectedRevision and binding');
    }
    const current = db.prepare(`
      SELECT 1 FROM analytics_widgets WHERE id = ? AND dashboard_id = ?
    `).get(widgetId, dashboardId);
    if (!current) throw new Error(`Widget ${widgetId} not found`);
    const persistedDashboard = db.prepare('SELECT status FROM analytics_dashboards WHERE id = ?').get(dashboardId) as { status: string } | undefined;
    if (!persistedDashboard || persistedDashboard.status === 'archived') {
      throw new Error('Archived dashboard bindings cannot change');
    }
    const running = activeRun(dashboardId);
    if (running) throw new Error(`Binding cannot change while refresh ${running.id} is ${running.status}`);
    let run: AnalyticsRun | undefined;
    let bindingRevision = input.expectedRevision;
    let outcome: AnalyticsWidgetBindingMutationResult['outcome'] = 'queued';
    db.transaction(() => {
      if (input.binding === null) {
        bindingRevision = dataRoom.removeBinding(widgetId, input.expectedRevision);
        const cleared = db.prepare(`
          UPDATE analytics_widgets
          SET result_json = NULL, last_refreshed_at = NULL, last_error = NULL,
              updated_at = datetime('now')
          WHERE id = ? AND dashboard_id = ?
        `).run(widgetId, dashboardId);
        if (cleared.changes !== 1) throw new Error(`Widget ${widgetId} changed during unbind`);
        outcome = 'cleared';
      } else {
        bindingRevision = dataRoom.putBinding(widgetId, input.expectedRevision, input.binding).revision;
        run = enqueueDashboard(getDashboard(dashboardId)!, 'manual', [widgetId]);
      }
    })();
    return {
      outcome,
      widget: mapWidget(db.prepare('SELECT * FROM analytics_widgets WHERE id = ?').get(widgetId)),
      bindingRevision,
      ...(run ? { run } : {}),
    };
  }

  function getWidgetControls(dashboardId: string, widgetId: string): AnalyticsDatasetControlState {
    if (!dataRoom) throw new Error('Analytics data-room control service is unavailable');
    const current = db.prepare('SELECT 1 FROM analytics_widgets WHERE id = ? AND dashboard_id = ?')
      .get(widgetId, dashboardId);
    if (!current) throw new Error(`Widget ${widgetId} not found`);
    const controls = dataRoom.getControls(widgetId);
    if (!controls) throw new Error(`Widget ${widgetId} has no data-room binding`);
    return controls;
  }

  function applyWidgetControls(
    dashboardId: string,
    widgetId: string,
    input: AnalyticsControlApplyInput,
  ): AnalyticsWidgetControlMutationResult {
    if (!dataRoom) throw new Error('Analytics data-room control service is unavailable');
    const current = db.prepare('SELECT 1 FROM analytics_widgets WHERE id = ? AND dashboard_id = ?')
      .get(widgetId, dashboardId);
    if (!current) throw new Error(`Widget ${widgetId} not found`);
    const persistedDashboard = db.prepare('SELECT status FROM analytics_dashboards WHERE id = ?')
      .get(dashboardId) as { status: string } | undefined;
    if (!persistedDashboard || persistedDashboard.status === 'archived') {
      throw new Error('Archived dashboard controls cannot change');
    }
    const running = activeRun(dashboardId);
    if (running) throw new Error(`Controls cannot change while refresh ${running.id} is ${running.status}`);
    let applied!: { state: AnalyticsDatasetControlState; changed: boolean };
    let run: AnalyticsRun | undefined;
    db.transaction(() => {
      applied = dataRoom.applyControls(widgetId, input);
      if (applied.changed) run = enqueueDashboard(getDashboard(dashboardId)!, 'manual', [widgetId]);
    }).immediate();
    return {
      outcome: applied.changed ? 'queued' : 'no_op',
      widget: mapWidget(db.prepare('SELECT * FROM analytics_widgets WHERE id = ?').get(widgetId)),
      controls: applied.state,
      ...(run ? { run } : {}),
    };
  }

  function enqueueChangedBindings(limit = 20): number {
    if (!dataRoomEnabled || !dataRoom) return 0;
    let queued = 0;
    for (const group of dataRoom.listChangedBindings(limit)) {
      if (activeRun(group.dashboardId)) continue;
      try {
        enqueueSelectiveRefresh(group.dashboardId, group.widgetIds, 'agent');
        queued += 1;
      } catch (error) {
        dataRoom.refreshDashboardDataState(group.dashboardId);
        console.warn(`[Analytics data-room] could not enqueue changed bindings for ${group.dashboardId}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return queued;
  }

  function inferAttemptedLane(error: string | null, primaryLane: string | null): DashboardLaneId {
    const lower = String(error ?? '').toLowerCase();
    if (/\|\s*etl retry also failed:/.test(lower)) return 'etl';
    if (/\|\s*sql-mcp retry also failed:/.test(lower)) return 'sql-mcp';
    if (primaryLane === 'etl' || primaryLane === 'sql-mcp') return primaryLane;
    return /datanet|\betl\b|scratch pair|waiting_for_resources|run \d+ (?:error|killed|deleted)/.test(lower)
      ? 'etl'
      : 'sql-mcp';
  }

  function recoverInterruptedRuns(): number {
    const candidates = db.prepare(`
      SELECT id, dashboard_id, worker_id, worker_pid, lease_expires_at, primary_lane, current_widget_id
      FROM analytics_runs WHERE status = 'running'
      ORDER BY queued_at
    `).all() as Array<{
      id: string;
      dashboard_id: string;
      worker_id: string | null;
      worker_pid: number | null;
      lease_expires_at: string | null;
      primary_lane: string | null;
      current_widget_id: string | null;
    }>;
    const interrupted = candidates.filter(run => {
      const leaseExpiry = Date.parse(run.lease_expires_at || '');
      const leaseActive = Number.isFinite(leaseExpiry) && leaseExpiry > Date.now();
      return !leaseActive || !processIsAlive(run.worker_pid);
    });
    if (!interrupted.length) return 0;

    let recovered = 0;
    db.transaction(() => {
      for (const run of interrupted) {
        const childAttempts = db.prepare(`
          SELECT child.widget_id, child.status, child.error, child.last_lane,
            EXISTS(
              SELECT 1 FROM analytics_run_widget_data_room_snapshots snapshot
              WHERE snapshot.run_id = child.run_id AND snapshot.widget_id = child.widget_id
            ) AS data_room_snapshot,
            json_extract(child.config_json, '$.dataSource.kind') = 'data_room_query' AS independent_data_source,
            child.kind = 'text' AS static_text
          FROM analytics_run_widgets child
          WHERE child.run_id = ? AND child.status IN ('queued','running','failed')
          ORDER BY child.position
        `).all(run.id) as Array<{
          widget_id: string;
          status: string;
          error: string | null;
          last_lane: string | null;
          data_room_snapshot: number;
          independent_data_source: number;
          static_text: number;
        }>;
        const claimed = db.prepare(`
          UPDATE analytics_runs SET status = 'queued',
            widgets_completed = 0, widgets_succeeded = 0,
            current_widget_id = NULL, started_at = NULL, heartbeat_at = NULL,
            lease_expires_at = NULL, worker_id = NULL, worker_pid = NULL,
            error = NULL, completed_at = NULL
          WHERE id = ? AND status = 'running'
            AND worker_id IS ? AND worker_pid IS ? AND lease_expires_at IS ?
        `).run(run.id, run.worker_id, run.worker_pid, run.lease_expires_at);
        if (claimed.changes !== 1) continue;

        const backfillLane = db.prepare(`
          UPDATE analytics_run_widgets SET last_lane = ?
          WHERE run_id = ? AND widget_id = ? AND last_lane IS NULL
        `);
        const interruptAttempt = db.prepare(`
          UPDATE analytics_run_widgets SET status = 'failed', error = ?,
            last_lane = ?, completed_at = ?
          WHERE run_id = ? AND widget_id = ? AND status = 'running'
        `);
        const interruptLegacyRetry = db.prepare(`
          UPDATE analytics_run_widgets SET error = ?, last_lane = ?, completed_at = ?
          WHERE run_id = ? AND widget_id = ? AND status = 'failed' AND last_lane IS NULL
        `);
        const resetLocalAttempt = db.prepare(`
          UPDATE analytics_run_widgets
          SET status = 'queued', error = NULL, last_lane = NULL,
              started_at = NULL, completed_at = NULL
          WHERE run_id = ? AND widget_id = ?
            AND (status = 'running' OR (? = 1 AND status = 'failed'))
        `);
        const interruptedAt = new Date().toISOString();
        for (const child of childAttempts) {
          // Local snapshots, independent Data Room sources, and static text
          // are read-only local work. Requeue an interrupted local worker; no
          // remote lane attempt may be fabricated or resubmitted.
          if ((child.data_room_snapshot || child.independent_data_source || child.static_text) && !child.last_lane) {
            const localCapabilityReady = child.static_text
              ? true
              : child.independent_data_source ? Boolean(dataRoomRead) : dataRoomEnabled;
            if (child.status === 'running' || (!localCapabilityReady && child.status === 'failed')) {
              resetLocalAttempt.run(run.id, child.widget_id, localCapabilityReady ? 0 : 1);
            }
            continue;
          }
          const inferredLane = inferAttemptedLane(child.error, run.primary_lane);
          // Pre-lane-receipt builds kept an alternate retry child `failed`
          // while only parent.current_widget_id named the in-flight call.
          // Treat that exact legacy shape as a possibly submitted retry and
          // terminalize it on the alternate lane before clearing the parent.
          if (!child.last_lane && child.status === 'failed' && run.current_widget_id === child.widget_id) {
            const retryLane = otherDashboardLane(inferredLane);
            const interruption = `${String(child.error ?? '').slice(0, 1200)} | ${retryLane} retry also failed: worker interrupted during a legacy in-flight retry; submission may still be running`;
            interruptLegacyRetry.run(interruption.slice(0, 2000), retryLane, interruptedAt, run.id, child.widget_id);
            continue;
          }
          const attemptedLane = child.last_lane === 'etl' || child.last_lane === 'sql-mcp'
            ? child.last_lane
            : inferredLane;
          if (!child.last_lane && child.status === 'failed') {
            backfillLane.run(attemptedLane, run.id, child.widget_id);
          }
          if (child.status !== 'running') continue;
          // A non-null error is preserved while a cross-lane retry is running;
          // primary claims clear it. If the retry worker dies, mark the second
          // lane attempted so recovery never submits a third copy.
          const interruption = child.error
            ? `${String(child.error).slice(0, 1200)} | ${attemptedLane} retry also failed: worker interrupted while this lane might still be in flight`
            : `Worker interrupted during ${attemptedLane} execution; that lane will not be resubmitted automatically`;
          interruptAttempt.run(interruption.slice(0, 2000), attemptedLane, interruptedAt, run.id, child.widget_id);
        }

        const progress = db.prepare(`
          SELECT COUNT(*) AS widget_count,
            SUM(CASE WHEN status IN ('completed','failed') THEN 1 ELSE 0 END) AS widgets_completed,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS widgets_succeeded
          FROM analytics_run_widgets WHERE run_id = ?
        `).get(run.id) as any;
        db.prepare(`
          UPDATE analytics_runs SET widget_count = ?, widgets_completed = ?, widgets_succeeded = ?
          WHERE id = ? AND status = 'queued'
        `).run(
          Number(progress.widget_count || 0),
          Number(progress.widgets_completed || 0),
          Number(progress.widgets_succeeded || 0),
          run.id,
        );
        db.prepare(`
          UPDATE analytics_dashboards SET status = 'refreshing', updated_at = datetime('now')
          WHERE id = ?
        `).run(run.dashboard_id);
        recovered++;
      }
    })();
    return recovered;
  }

  function leaseExpiresAt(): string {
    return new Date(Date.now() + queryTimeoutMs + 60_000).toISOString();
  }

  function ownsRun(runId: string): boolean {
    return Boolean(db.prepare(`
      SELECT 1 FROM analytics_runs
      WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
    `).get(runId, workerId, process.pid));
  }

  function recordLateEtlHandoff(
    runId: string,
    widget: any,
    handoff: EtlAliveHandoffError,
    observedAt: string,
  ): void {
    const definitionSha256 = widgetDefinitionSha256(widget.kind, widget.sql_query, widget.config_json);
    const effectiveQuerySha256 = createHash('sha256').update(String(widget.sql_query ?? ''), 'utf8').digest('hex');
    // A disabled R4 bridge intentionally executes retained legacy SQL while
    // preserving binding metadata. Freeze that inert generation so a later
    // status/download can distinguish safe rollback continuation from drift.
    const inertBinding = !dataRoomEnabled ? dataRoom?.getBinding(widget.widget_id) : null;
    const existing = db.prepare(`
      SELECT external_run_id FROM analytics_late_etl_results
      WHERE run_id = ? AND widget_id = ?
    `).get(runId, widget.widget_id) as { external_run_id: string } | undefined;
    if (existing) {
      if (existing.external_run_id !== handoff.runId) {
        throw new Error(`Late ETL identity changed for ${runId}/${widget.widget_id}`);
      }
      return;
    }
    const remoteBinding = db.prepare(`
      SELECT run_id, widget_id FROM analytics_late_etl_results
      WHERE external_run_id = ?
    `).get(handoff.runId) as { run_id: string; widget_id: string } | undefined;
    if (remoteBinding) {
      throw new Error(`Datanet run ${handoff.runId} is already bound to ${remoteBinding.run_id}/${remoteBinding.widget_id}`);
    }
    db.prepare(`
      INSERT INTO analytics_late_etl_results
        (run_id, widget_id, external_run_id, definition_sha256, widget_revision,
         binding_revision, control_revision, dataset_id, dataset_version_id,
         effective_query_sha256, state, remote_status, next_check_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(
      runId,
      widget.widget_id,
      handoff.runId,
      definitionSha256,
      Number(widget.widget_revision || 1),
      inertBinding?.revision ?? null,
      inertBinding?.datasetId ?? null,
      inertBinding?.lastAppliedVersionId ?? inertBinding?.pinnedVersionId ?? null,
      effectiveQuerySha256,
      handoff.remoteStatus,
      new Date(Date.parse(observedAt) + LATE_ETL_RECHECK_MS).toISOString(),
      observedAt,
      observedAt,
    );
  }

  /** Exact-pattern compatibility for handoffs created before structured
   * identity shipped. It only journals the numeric run id already recorded by
   * BotBoy; all stale/current checks still run before any remote read/apply. */
  function backfillLegacyLateEtlHandoffs(): number {
    const rows = db.prepare(`
      SELECT rw.*, r.dashboard_id
      FROM analytics_run_widgets rw
      JOIN analytics_runs r ON r.id = rw.run_id
      LEFT JOIN analytics_late_etl_results late
        ON late.run_id = rw.run_id AND late.widget_id = rw.widget_id
      WHERE late.run_id IS NULL AND rw.status = 'failed' AND rw.last_lane = 'etl'
        AND rw.error LIKE 'Run % still % after % minutes.%Do NOT resubmit%'
      ORDER BY r.queued_at, rw.position
    `).all() as any[];
    let inserted = 0;
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO analytics_late_etl_results
        (run_id, widget_id, external_run_id, definition_sha256, widget_revision,
         binding_revision, control_revision, dataset_id, dataset_version_id,
         effective_query_sha256, state, remote_status, next_check_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 'pending', ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const row of rows) {
        const match = String(row.error ?? '').match(/^Run (\d+) still ([A-Z_]+) after \d+ minutes\./i);
        if (!match) continue;
        inserted += insert.run(
          row.run_id,
          row.widget_id,
          match[1],
          widgetDefinitionSha256(row.kind, row.sql_query, row.config_json),
          Number(row.widget_revision || 1),
          createHash('sha256').update(String(row.sql_query ?? ''), 'utf8').digest('hex'),
          match[2].toUpperCase(),
          now,
          now,
          now,
        ).changes;
      }
    })();
    if (inserted) console.log(`[Analytics late ETL] journaled ${inserted} legacy alive handoff(s)`);
    return inserted;
  }

  type LateEligibility =
    | { kind: 'eligible'; source: any; current: any }
    | { kind: 'wait'; reason: string }
    | { kind: 'terminal'; state: 'superseded' | 'cancelled' | 'definition_changed'; reason: string };

  function inspectLateEligibility(record: any): LateEligibility {
    const source = db.prepare(`
      SELECT r.dashboard_id, r.status AS run_status, r.cancel_requested,
        r.queued_at, r.schedule_id, rw.status AS child_status,
        rw.kind AS child_kind, rw.sql_query AS child_sql_query,
        rw.config_json AS child_config_json, rw.title AS child_title,
        rw.widget_revision AS child_widget_revision
      FROM analytics_runs r
      JOIN analytics_run_widgets rw ON rw.run_id = r.id
      WHERE r.id = ? AND rw.widget_id = ?
    `).get(record.run_id, record.widget_id) as any;
    if (!source) {
      return { kind: 'terminal', state: 'superseded', reason: 'The source dashboard run or widget no longer exists.' };
    }
    if (source.run_status === 'queued' || source.run_status === 'running') {
      return { kind: 'wait', reason: 'The source dashboard run has not finalized yet.' };
    }
    if (source.run_status === 'cancelled' || Number(source.cancel_requested) === 1) {
      return { kind: 'terminal', state: 'cancelled', reason: 'The owner cancelled the source dashboard run.' };
    }
    const newer = db.prepare(`
      SELECT id FROM analytics_runs
      WHERE dashboard_id = ? AND (
        queued_at > ? OR (queued_at = ? AND id > ?)
      )
      LIMIT 1
    `).get(source.dashboard_id, source.queued_at, source.queued_at, record.run_id) as { id: string } | undefined;
    if (newer) {
      return { kind: 'terminal', state: 'superseded', reason: `Newer dashboard run ${newer.id} exists.` };
    }
    if (source.child_status !== 'failed') {
      return { kind: 'terminal', state: 'superseded', reason: `Source widget is already ${source.child_status}.` };
    }
    const current = db.prepare(`
      SELECT w.*, d.status AS dashboard_status
      FROM analytics_widgets w
      JOIN analytics_dashboards d ON d.id = w.dashboard_id
      WHERE w.id = ? AND w.dashboard_id = ?
    `).get(record.widget_id, source.dashboard_id) as any;
    if (!current || current.dashboard_status === 'archived') {
      return { kind: 'terminal', state: 'superseded', reason: 'The current widget is absent or its dashboard is archived.' };
    }
    const currentBinding = db.prepare(`
      SELECT revision, dataset_id, last_applied_version_id, pinned_version_id
      FROM analytics_widget_dataset_bindings WHERE widget_id = ?
    `).get(record.widget_id) as {
      revision: number;
      dataset_id: string;
      last_applied_version_id: string | null;
      pinned_version_id: string | null;
    } | undefined;
    if (currentBinding) {
      const currentVersionId = currentBinding.last_applied_version_id ?? currentBinding.pinned_version_id;
      const inertMatch = !dataRoomEnabled
        && Number(record.binding_revision) === Number(currentBinding.revision)
        && record.dataset_id === currentBinding.dataset_id
        && (record.dataset_version_id ?? null) === (currentVersionId ?? null)
        && record.control_revision == null;
      if (!inertMatch) {
        return {
          kind: 'terminal',
          state: 'definition_changed',
          reason: `Widget has data-room binding ${currentBinding.dataset_id} revision ${currentBinding.revision}; this late output has no matching disabled-mode receipt.`,
        };
      }
    } else if (record.binding_revision != null || record.dataset_id != null || record.control_revision != null) {
      return { kind: 'terminal', state: 'definition_changed', reason: 'The late-result binding/control snapshot no longer matches the widget.' };
    }
    if (record.widget_revision != null && Number(current.revision || 1) !== Number(record.widget_revision)) {
      return { kind: 'terminal', state: 'definition_changed', reason: 'The widget revision changed after submission.' };
    }
    const effectiveQuerySha256 = createHash('sha256').update(String(current.sql_query ?? ''), 'utf8').digest('hex');
    if (record.effective_query_sha256 && record.effective_query_sha256 !== effectiveQuerySha256) {
      return { kind: 'terminal', state: 'definition_changed', reason: 'The effective legacy query changed after submission.' };
    }
    const sourceSha = widgetDefinitionSha256(source.child_kind, source.child_sql_query, source.child_config_json);
    const currentSha = widgetDefinitionSha256(current.kind, current.sql_query, current.config_json);
    if (sourceSha !== record.definition_sha256 || currentSha !== record.definition_sha256) {
      return { kind: 'terminal', state: 'definition_changed', reason: 'The widget execution definition changed after submission.' };
    }
    return { kind: 'eligible', source, current };
  }

  function claimLateEtlResults(limit: number): any[] {
    const claimed: any[] = [];
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + LATE_ETL_LEASE_MS).toISOString();
    db.transaction(() => {
      while (claimed.length < limit) {
        const candidate = db.prepare(`
          SELECT * FROM analytics_late_etl_results
          WHERE (state = 'pending' AND julianday(next_check_at) <= julianday(?))
             OR (state = 'checking' AND julianday(lease_expires_at) <= julianday(?))
          ORDER BY julianday(next_check_at), created_at, external_run_id
          LIMIT 1
        `).get(now, now) as any;
        if (!candidate) break;
        const updated = db.prepare(`
          UPDATE analytics_late_etl_results
          SET state = 'checking', lease_owner = ?, lease_expires_at = ?, updated_at = ?
          WHERE run_id = ? AND widget_id = ? AND (
            (state = 'pending' AND julianday(next_check_at) <= julianday(?))
            OR (state = 'checking' AND julianday(lease_expires_at) <= julianday(?))
          )
        `).run(
          workerId,
          leaseExpiresAt,
          now,
          candidate.run_id,
          candidate.widget_id,
          now,
          now,
        );
        if (updated.changes === 1) claimed.push({ ...candidate, state: 'checking', lease_owner: workerId });
      }
    })();
    return claimed;
  }

  function returnLateEtlPending(record: any, outcome: QueryRunResult | null, delayMs: number, reason?: string): void {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE analytics_late_etl_results
      SET state = 'pending', remote_status = COALESCE(?, remote_status),
        next_check_at = ?, lease_owner = NULL, lease_expires_at = NULL,
        error = ?, updated_at = ?
      WHERE run_id = ? AND widget_id = ? AND state = 'checking' AND lease_owner = ?
    `).run(
      outcome?.remoteStatus ?? null,
      new Date(Date.now() + delayMs).toISOString(),
      String(reason ?? outcome?.error ?? '').slice(0, 2000) || null,
      now,
      record.run_id,
      record.widget_id,
      workerId,
    );
  }

  function finishLateEtlWithoutApply(
    record: any,
    state: 'superseded' | 'cancelled' | 'definition_changed' | 'remote_failed',
    reason: string,
    remoteStatus?: string,
  ): void {
    const now = new Date().toISOString();
    const receipt = {
      outcome: state,
      sourceRunId: record.run_id,
      widgetId: record.widget_id,
      externalRunId: record.external_run_id,
      ...(remoteStatus ? { remoteStatus } : {}),
      reason,
      completedAt: now,
      submittedAgain: false,
    };
    db.prepare(`
      UPDATE analytics_late_etl_results
      SET state = ?, remote_status = COALESCE(?, remote_status),
        lease_owner = NULL, lease_expires_at = NULL, receipt_json = ?,
        error = ?, updated_at = ?, completed_at = ?
      WHERE run_id = ? AND widget_id = ? AND state = 'checking' AND lease_owner = ?
    `).run(
      state,
      remoteStatus ?? null,
      JSON.stringify(receipt),
      reason.slice(0, 2000),
      now,
      now,
      record.run_id,
      record.widget_id,
      workerId,
    );
  }

  function recomputeLateRunProjection(runId: string, observedAt: string, refreshApplied: boolean): void {
    const run = db.prepare('SELECT * FROM analytics_runs WHERE id = ?').get(runId) as any;
    if (!run) return;
    const progress = db.prepare(`
      SELECT COUNT(*) AS widget_count,
        SUM(CASE WHEN status IN ('completed','failed') THEN 1 ELSE 0 END) AS widgets_completed,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS widgets_succeeded
      FROM analytics_run_widgets WHERE run_id = ?
    `).get(runId) as any;
    const failures = db.prepare(`
      SELECT title, error FROM analytics_run_widgets
      WHERE run_id = ? AND status = 'failed' ORDER BY position
    `).all(runId) as Array<{ title: string; error: string | null }>;
    const errorSummary = failures.length
      ? failures.map(item => `${item.title}: ${item.error || 'Unknown widget failure'}`).join('\n').slice(0, 4000)
      : null;
    const status = failures.length ? 'failed' : 'completed';
    db.prepare(`
      UPDATE analytics_runs SET status = ?, widget_count = ?, widgets_completed = ?,
        widgets_succeeded = ?, error = ?, heartbeat_at = ?
      WHERE id = ? AND status IN ('failed','completed')
    `).run(
      status,
      Number(progress.widget_count || 0),
      Number(progress.widgets_completed || 0),
      Number(progress.widgets_succeeded || 0),
      errorSummary,
      observedAt,
      runId,
    );
    projectDashboardAfterRun(run, observedAt, refreshApplied);
    if (run.schedule_id) {
      const recoveredWholeRun = run.status === 'failed' && status === 'completed';
      db.prepare(`
        UPDATE analytics_schedules SET last_error = ?,
          consecutive_failures = CASE WHEN ? = 1 THEN MAX(0, consecutive_failures - 1) ELSE consecutive_failures END,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(errorSummary, recoveredWholeRun ? 1 : 0, run.schedule_id);
    }
  }

  function applyLateEtlSuccess(record: any, outcome: QueryRunResult): void {
    const appliedAt = new Date().toISOString();
    let applied = false;
    db.transaction(() => {
      const eligibility = inspectLateEligibility(record);
      if (eligibility.kind !== 'eligible') {
        if (eligibility.kind === 'wait') {
          returnLateEtlPending(record, outcome, LATE_ETL_RECHECK_MS, eligibility.reason);
        } else {
          finishLateEtlWithoutApply(record, eligibility.state, eligibility.reason, outcome.remoteStatus);
        }
        return;
      }
      const result = etlResultToWidgetResult(outcome);
      if (result.source?.provider === 'datanet') result.source.reconciled = true;
      const child = db.prepare(`
        UPDATE analytics_run_widgets SET status = 'completed', error = NULL, completed_at = ?
        WHERE run_id = ? AND widget_id = ? AND status = 'failed'
      `).run(appliedAt, record.run_id, record.widget_id);
      if (child.changes !== 1) throw new Error('Late ETL source widget changed before apply');
      const widget = db.prepare(`
        UPDATE analytics_widgets SET result_json = ?, last_error = NULL,
          last_refreshed_at = ?, updated_at = datetime('now')
        WHERE id = ? AND dashboard_id = ?
      `).run(JSON.stringify(result), result.refreshedAt, record.widget_id, eligibility.source.dashboard_id);
      if (widget.changes !== 1) throw new Error('Late ETL current widget disappeared before apply');
      const receipt = {
        outcome: 'applied',
        sourceRunId: record.run_id,
        widgetId: record.widget_id,
        widgetTitle: eligibility.source.child_title,
        externalRunId: record.external_run_id,
        remoteStatus: 'SUCCESS',
        resultPath: outcome.savedTo,
        resultBytes: outcome.resultBytes,
        resultSha256: outcome.resultSha256,
        rowCount: outcome.rowCount ?? outcome.rows?.length ?? 0,
        definitionSha256: record.definition_sha256,
        appliedAt,
        submittedAgain: false,
      };
      const journal = db.prepare(`
        UPDATE analytics_late_etl_results
        SET state = 'applied', remote_status = 'SUCCESS', result_path = ?,
          result_bytes = ?, result_sha256 = ?, row_count = ?, receipt_json = ?,
          error = NULL, lease_owner = NULL, lease_expires_at = NULL,
          updated_at = ?, completed_at = ?
        WHERE run_id = ? AND widget_id = ? AND state = 'checking' AND lease_owner = ?
      `).run(
        outcome.savedTo ?? null,
        outcome.resultBytes ?? null,
        outcome.resultSha256 ?? null,
        outcome.rowCount ?? outcome.rows?.length ?? 0,
        JSON.stringify(receipt),
        appliedAt,
        appliedAt,
        record.run_id,
        record.widget_id,
        workerId,
      );
      if (journal.changes !== 1) throw new Error('Late ETL journal lease changed before apply');
      recomputeLateRunProjection(record.run_id, appliedAt, true);
      applied = true;
    })();
    if (applied) {
      console.log(`[Analytics late ETL] applied Datanet run ${record.external_run_id} to ${record.run_id}/${record.widget_id} without resubmission`);
    }
  }

  function applyLateEtlRemoteFailure(record: any, outcome: QueryRunResult): void {
    const observedAt = new Date().toISOString();
    db.transaction(() => {
      const eligibility = inspectLateEligibility(record);
      if (eligibility.kind !== 'eligible') {
        if (eligibility.kind === 'wait') {
          returnLateEtlPending(record, outcome, LATE_ETL_RECHECK_MS, eligibility.reason);
        } else {
          finishLateEtlWithoutApply(record, eligibility.state, eligibility.reason, outcome.remoteStatus);
        }
        return;
      }
      const message = [outcome.error, outcome.nextAction].filter(Boolean).join(' — ').slice(0, 2000);
      db.prepare(`
        UPDATE analytics_run_widgets SET error = ?, completed_at = ?
        WHERE run_id = ? AND widget_id = ? AND status = 'failed'
      `).run(message, observedAt, record.run_id, record.widget_id);
      db.prepare(`
        UPDATE analytics_widgets SET last_error = ?, updated_at = datetime('now')
        WHERE id = ? AND dashboard_id = ?
      `).run(message, record.widget_id, eligibility.source.dashboard_id);
      finishLateEtlWithoutApply(record, 'remote_failed', message, outcome.remoteStatus);
      recomputeLateRunProjection(record.run_id, observedAt, false);
    })();
  }

  async function processLateEtlRecord(record: any): Promise<void> {
    const eligibility = inspectLateEligibility(record);
    if (eligibility.kind === 'wait') {
      returnLateEtlPending(record, null, LATE_ETL_RECHECK_MS, eligibility.reason);
      return;
    }
    if (eligibility.kind === 'terminal') {
      finishLateEtlWithoutApply(record, eligibility.state, eligibility.reason);
      return;
    }
    if (!etlRunner?.readRun) {
      returnLateEtlPending(record, null, LATE_ETL_RETRY_MS, 'The ETL runner cannot read an existing run yet.');
      return;
    }
    const outcome = await etlRunner.readRun({ runId: String(record.external_run_id) });
    if (outcome.ok) {
      applyLateEtlSuccess(record, outcome);
      return;
    }
    if (outcome.code === 'remote_failed') {
      applyLateEtlRemoteFailure(record, outcome);
      return;
    }
    const delay = outcome.code === 'alive_handoff' ? LATE_ETL_RECHECK_MS : LATE_ETL_RETRY_MS;
    returnLateEtlPending(record, outcome, delay);
  }

  async function processLateEtlResults(limit = 4): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(12, Math.floor(Number(limit) || 1)));
    const claimed = claimLateEtlResults(boundedLimit);
    await Promise.all(claimed.map(async record => {
      try {
        await processLateEtlRecord(record);
      } catch (error: any) {
        console.warn(`[Analytics late ETL] ${record.external_run_id} reconciliation failed: ${error?.message ?? error}`);
        returnLateEtlPending(record, null, LATE_ETL_RETRY_MS, String(error?.message ?? error));
      }
    }));
    return claimed.length;
  }

  async function executeRunWidget(row: any, lane: DashboardLaneId = 'sql-mcp'): Promise<AnalyticsWidgetResult> {
    const storedWidget = db.prepare(`
      SELECT 1 FROM analytics_widgets WHERE id = ? AND dashboard_id = ?
    `).get(row.widget_id, row.dashboard_id);
    if (!storedWidget) throw new Error('Widget definition is no longer available');

    if (dataRoomEnabled && dataRoom?.hasSnapshot(row.run_id, row.widget_id)) {
      return dataRoom.executeSnapshot(row.run_id, row.widget_id);
    }

    const configuredSource = widgetSourceFromConfig(parseJson<Record<string, unknown>>(row.config_json, {}));
    if (configuredSource?.kind === 'data_room_query') {
      if (!dataRoomRead) throw new Error('Independent Data Room widget source service is unavailable');
      // Each run reads the dataset's current ready head, so a refresh shows new
      // versions. config.dataSource.versionId only records the head at
      // configuration; pinning it failed every refresh once the head moved.
      // The result receipt names the exact version this run used.
      const executed = await dataRoomRead.queryForDashboard({
        datasets: [{ alias: SOURCE_ALIAS, datasetId: configuredSource.datasetId }],
        sql: configuredSource.sql,
        params: configuredSource.params,
        limit: configuredSource.limit,
      });
      if (executed.status !== 'ok' || executed.trust !== 'verified_data_room_rows') {
        throw new Error('Independent Data Room widget query returned no verified receipt');
      }
      if (executed.truncated) {
        throw new Error('Independent Data Room widget query exceeded its row/byte limit; aggregate or narrow the widget SQL');
      }
      const source = Array.isArray(executed.sources) ? executed.sources[0] as any : undefined;
      const receipt = executed.receipt as any;
      if (!source || source.datasetId !== configuredSource.datasetId || !VERSION_ID_RE.test(String(source.versionId ?? ''))
        || typeof receipt?.querySha256 !== 'string') {
        throw new Error('Independent Data Room widget query receipt differs from its configured source');
      }
      return {
        trust: 'local_verified_data',
        columns: executed.columns as string[],
        rows: executed.rows as AnalyticsWidgetResult['rows'],
        rowCount: Number(executed.displayedRowCount),
        displayedRowCount: Number(executed.displayedRowCount),
        executionTimeMs: Number(receipt.elapsedMs ?? 0),
        refreshedAt: new Date().toISOString(),
        source: {
          provider: 'data-room-query',
          datasetId: source.datasetId,
          versionId: source.versionId,
          widgetRevision: Number(row.widget_revision),
          sourceConfigSha256: analyticsSha256(configuredSource),
          querySha256: receipt.querySha256,
          compilerVersion: String(receipt.compilerVersion),
          contentSha256: String(source.hashes?.contentSha256),
          schemaSha256: String(source.hashes?.schemaSha256),
          contractSha256: String(source.hashes?.contractSha256),
          definitionSha256: String(source.hashes?.definitionSha256),
          integrityVerifiedAt: String(source.integrityVerifiedAt),
        },
      };
    }

    if (row.kind === 'text') {
      const config = parseJson<Record<string, unknown>>(row.config_json, {});
      const text = cleanText(config.text, `${row.title} text`, 20_000, true);
      const refreshedAt = new Date().toISOString();
      return {
        trust: 'local_static_content',
        columns: ['text'],
        rows: [[text]],
        rowCount: 1,
        displayedRowCount: 1,
        refreshedAt,
      };
    }

    const sql = validateReadOnlySql(row.sql_query);

    // ETL fallback lane (etl-analytics A4): the composite handles the whole
    // Datanet dance; a non-ok outcome fails THIS widget with the runner's
    // own actionable message (run machine semantics unchanged).
    if (lane === 'etl' && etlRunner) {
      const startedAtMs = Date.now();
      const outcome = await etlRunner.runQuery({ sql });
      if (!outcome.ok) {
        if (outcome.code === 'alive_handoff' && /^\d+$/.test(String(outcome.runId ?? ''))) {
          throw new EtlAliveHandoffError(outcome);
        }
        throw new Error([outcome.error, outcome.nextAction].filter(Boolean).join(' — ') || 'Datanet ETL query failed');
      }
      return etlResultToWidgetResult(outcome, Date.now() - startedAtMs);
    }

    const call = await mcpManager.callTool(
      'sql-context',
      'run_query',
      { sql },
      { source: 'dashboard', timeoutMs: queryTimeoutMs },
    );
    if (call.isError) {
      // A sql-context whose PROCESS is up but whose warehouse connection is
      // dead answers with a bare "Error: " / "Not connected: " and no detail
      // (live 2026-09-04: 12 widgets failed with a blank reason on the
      // dashboard). Substance check, not truthiness: strip the error-prefix
      // scaffolding and fall back to an actionable message when nothing is
      // left. Classified infra → the cross-lane retry pass picks these up.
      const detail = String(call.text ?? '').replace(/^\s*(Error|Not connected)\s*:?\s*/i, '').trim();
      throw new Error(detail
        ? call.text
        : `SQL connector returned no error detail (likely "Not connected" — its warehouse connection is down while the process is up; check VPN and #/connections/sql-context). Original: "${String(call.text ?? '').slice(0, 60)}"`);
    }
    return { ...parseSqlMcpResult(call.text), lane: 'sql-mcp' };
  }

  async function executeRunWidgetWithSafeRuntimeRetry(
    row: any,
    lane: DashboardLaneId,
  ): Promise<AnalyticsWidgetResult> {
    try {
      return await executeRunWidget(row, lane);
    } catch (error) {
      if (!isSafeRuntimeQueueChurn(error)) throw error;
      console.warn(`[Analytics] transient ${lane} runtime queue churn before widget ${String(row.widget_id ?? row.id ?? 'unknown')} started; retrying once`);
      await new Promise<void>(resolve => setTimeout(resolve, 250));
      return executeRunWidget(row, lane);
    }
  }

  function projectDashboardAfterRun(run: any, observedAt: string, claimWholeRefresh: boolean): void {
    const failures = db.prepare(`
      SELECT title, last_error AS error FROM analytics_widgets
      WHERE dashboard_id = ? AND last_error IS NOT NULL ORDER BY position
    `).all(run.dashboard_id) as Array<{ title: string; error: string }>;
    const errorSummary = failures.length
      ? failures.map(item => `${item.title}: ${item.error || 'Unknown widget failure'}`).join('\n').slice(0, 4000)
      : null;
    const bindingWaiting = dataRoomEnabled && Boolean(db.prepare(`
      SELECT 1 FROM analytics_widget_dataset_bindings binding
      JOIN analytics_widgets widget ON widget.id = binding.widget_id
      WHERE widget.dashboard_id = ? AND binding.compatibility_state != 'compatible'
      LIMIT 1
    `).get(run.dashboard_id));
    const hardFailures = failures.filter(item => !String(item.error || '').includes(WAITING_FOR_DATA_PREFIX));
    const waitingForData = bindingWaiting && hardFailures.length === 0;
    const claimsWholeRefresh = claimWholeRefresh && run.refresh_scope !== 'selective';
    db.prepare(`
      UPDATE analytics_dashboards SET status = ?, data_state = ?, last_error = ?,
        last_refreshed_at = CASE WHEN ? = 1 THEN ? ELSE last_refreshed_at END,
        updated_at = datetime('now')
      WHERE id = ? AND status != 'archived'
    `).run(
      waitingForData ? 'ready' : (failures.length ? 'degraded' : 'ready'),
      waitingForData ? 'waiting_for_data' : null,
      errorSummary,
      claimsWholeRefresh ? 1 : 0,
      observedAt,
      run.dashboard_id,
    );
  }

  function finalizeRun(runId: string): void {
    const run = db.prepare('SELECT * FROM analytics_runs WHERE id = ?').get(runId) as any;
    if (!run || run.status !== 'running' || run.worker_id !== workerId || run.worker_pid !== process.pid) return;
    const progress = db.prepare(`
      SELECT COUNT(*) AS widget_count,
        SUM(CASE WHEN status IN ('completed','failed') THEN 1 ELSE 0 END) AS widgets_completed,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS widgets_succeeded,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS widgets_failed
      FROM analytics_run_widgets WHERE run_id = ?
    `).get(runId) as any;
    if (Number(progress.widgets_completed || 0) !== Number(progress.widget_count || 0)) {
      throw new Error(`Run ${runId} still has unfinished widgets`);
    }
    const failures = db.prepare(`
      SELECT title, error FROM analytics_run_widgets
      WHERE run_id = ? AND status = 'failed' ORDER BY position
    `).all(runId) as Array<{ title: string; error: string | null }>;
    const runErrorSummary = failures.length
      ? failures.map(item => `${item.title}: ${item.error || 'Unknown widget failure'}`).join('\n').slice(0, 4000)
      : null;
    const status = failures.length ? 'failed' : 'completed';
    const completedAt = new Date().toISOString();

    db.transaction(() => {
      const finalized = db.prepare(`
        UPDATE analytics_runs SET status = ?, widget_count = ?, widgets_completed = ?,
          widgets_succeeded = ?, current_widget_id = NULL, heartbeat_at = ?,
          lease_expires_at = NULL, worker_id = NULL, worker_pid = NULL,
          error = ?, completed_at = ?
        WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
      `).run(
        status,
        Number(progress.widget_count || 0),
        Number(progress.widgets_completed || 0),
        Number(progress.widgets_succeeded || 0),
        completedAt,
        runErrorSummary,
        completedAt,
        runId,
        workerId,
        process.pid,
      );
      if (finalized.changes !== 1) throw new Error(`Run ${runId} ownership changed before finalization`);
      projectDashboardAfterRun(run, completedAt, true);
      if (run.schedule_id) {
        db.prepare(`
          UPDATE analytics_schedules SET last_run_at = ?,
            consecutive_failures = CASE WHEN ? IS NULL THEN 0 ELSE consecutive_failures + 1 END,
            last_error = ?, updated_at = datetime('now') WHERE id = ?
        `).run(completedAt, runErrorSummary, runErrorSummary, run.schedule_id);
      }
    })();
  }

  /**
   * Stop the dashboard's active refresh (owner-initiated, 2026-08-27).
   * Queued runs cancel immediately in one transaction. Running runs are only
   * FLAGGED — the owning worker finalizes at its next between-widgets stop
   * point, because the in-flight MCP SQL call cannot be aborted and status
   * transitions belong to the run's owner (lease invariant).
   */
  function cancelActiveRun(dashboardId: string): { result: 'cancelled' | 'stopping' | 'none'; run: AnalyticsRun | null } {
    const outcome = db.transaction((): { result: 'cancelled' | 'stopping' | 'none'; runId: string | null } => {
      const active = db.prepare(`
        SELECT id, status, dashboard_id, refresh_scope FROM analytics_runs
        WHERE dashboard_id = ? AND status IN ('queued','running')
        ORDER BY queued_at LIMIT 1
      `).get(dashboardId) as { id: string; status: string; dashboard_id: string; refresh_scope: string } | undefined;
      if (!active) return { result: 'none', runId: null };
      const completedAt = new Date().toISOString();
      if (active.status === 'queued') {
        const cancelled = db.prepare(`
          UPDATE analytics_runs SET status = 'cancelled', current_widget_id = NULL,
            heartbeat_at = ?, lease_expires_at = NULL, worker_id = NULL,
            worker_pid = NULL, error = NULL, completed_at = ?
          WHERE id = ? AND status = 'queued'
        `).run(completedAt, completedAt, active.id);
        if (cancelled.changes !== 1) {
          // A worker claimed it between our read and update — fall through
          // to the cooperative path.
          db.prepare(`
            UPDATE analytics_runs SET cancel_requested = 1
            WHERE id = ? AND status = 'running'
          `).run(active.id);
          return { result: 'stopping', runId: active.id };
        }
        db.prepare(`
          UPDATE analytics_run_widgets SET status = 'cancelled', completed_at = ?
          WHERE run_id = ? AND status IN ('queued','running')
        `).run(completedAt, active.id);
        projectDashboardAfterRun(active, completedAt, false);
        return { result: 'cancelled', runId: active.id };
      }
      db.prepare(`
        UPDATE analytics_runs SET cancel_requested = 1
        WHERE id = ? AND status = 'running'
      `).run(active.id);
      return { result: 'stopping', runId: active.id };
    })();
    return { result: outcome.result, run: outcome.runId ? getRun(outcome.runId) : null };
  }

  /**
   * Worker-side terminalization of a cancel request, at a between-widgets
   * stop point. Completed widget results stay persisted; untouched widgets
   * are marked cancelled, not failed — and schedules never count a cancel
   * as a failure.
   */
  function finalizeCancelledRun(runId: string): void {
    const run = db.prepare('SELECT * FROM analytics_runs WHERE id = ?').get(runId) as any;
    if (!run || run.status !== 'running' || run.worker_id !== workerId || run.worker_pid !== process.pid) return;
    const completedAt = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`
        UPDATE analytics_run_widgets SET status = 'cancelled', completed_at = ?
        WHERE run_id = ? AND status IN ('queued','running')
      `).run(completedAt, runId);
      const progress = db.prepare(`
        SELECT COUNT(*) AS widget_count,
          SUM(CASE WHEN status IN ('completed','failed') THEN 1 ELSE 0 END) AS widgets_completed,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS widgets_succeeded,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS widgets_failed
        FROM analytics_run_widgets WHERE run_id = ?
      `).get(runId) as any;
      const failures = db.prepare(`
        SELECT title, error FROM analytics_run_widgets
        WHERE run_id = ? AND status = 'failed' ORDER BY position
      `).all(runId) as Array<{ title: string; error: string | null }>;
      const errorSummary = failures.length
        ? failures.map(item => `${item.title}: ${item.error || 'Unknown widget failure'}`).join('\n').slice(0, 4000)
        : null;
      const finalized = db.prepare(`
        UPDATE analytics_runs SET status = 'cancelled', widget_count = ?,
          widgets_completed = ?, widgets_succeeded = ?, current_widget_id = NULL,
          heartbeat_at = ?, lease_expires_at = NULL, worker_id = NULL,
          worker_pid = NULL, error = ?, completed_at = ?
        WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
      `).run(
        Number(progress.widget_count || 0),
        Number(progress.widgets_completed || 0),
        Number(progress.widgets_succeeded || 0),
        completedAt,
        errorSummary,
        completedAt,
        runId,
        workerId,
        process.pid,
      );
      if (finalized.changes !== 1) throw new Error(`Run ${runId} ownership changed while cancelling`);
      // No cancellation path claims a whole-dashboard refresh timestamp.
      projectDashboardAfterRun(run, completedAt, false);
      if (run.schedule_id) {
        db.prepare(`
          UPDATE analytics_schedules SET last_run_at = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(completedAt, run.schedule_id);
      }
    })();
  }

  function deferClaimedRunForLane(runId: string, failure: unknown): void {
    const message = String((failure as any)?.message ?? failure).slice(0, 4000)
      || 'Waiting for an analytics data lane';
    const deferred = db.prepare(`
      UPDATE analytics_runs SET status = 'queued', primary_lane = NULL,
        current_widget_id = NULL, started_at = NULL, heartbeat_at = NULL,
        lease_expires_at = NULL, worker_id = NULL, worker_pid = NULL,
        error = ?, completed_at = NULL
      WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
    `).run(message, runId, workerId, process.pid);
    if (deferred.changes !== 1) return;
    const run = db.prepare('SELECT dashboard_id FROM analytics_runs WHERE id = ?').get(runId) as { dashboard_id: string } | undefined;
    if (run) {
      db.prepare(`
        UPDATE analytics_dashboards SET status = 'refreshing', updated_at = datetime('now')
        WHERE id = ?
      `).run(run.dashboard_id);
    }
    console.warn(`[Analytics queue] run ${runId} deferred until a data lane is ready: ${message}`);
  }

  function failClaimedRun(runId: string, failure: unknown): void {
    const run = db.prepare('SELECT * FROM analytics_runs WHERE id = ?').get(runId) as any;
    if (!run || run.status !== 'running' || run.worker_id !== workerId || run.worker_pid !== process.pid) return;
    const message = String((failure as any)?.message ?? failure).slice(0, 4000)
      || 'Analytics queue worker failed unexpectedly';
    const completedAt = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`
        UPDATE analytics_widgets SET last_error = ?, updated_at = datetime('now')
        WHERE dashboard_id = ? AND id IN (
          SELECT widget_id FROM analytics_run_widgets
          WHERE run_id = ? AND status IN ('queued','running')
        )
      `).run(message, run.dashboard_id, runId);
      db.prepare(`
        UPDATE analytics_run_widgets SET status = 'failed', error = ?,
          completed_at = ?, started_at = COALESCE(started_at, ?)
        WHERE run_id = ? AND status IN ('queued','running')
      `).run(message, completedAt, completedAt, runId);
      const progress = db.prepare(`
        SELECT COUNT(*) AS widget_count,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS widgets_succeeded
        FROM analytics_run_widgets WHERE run_id = ?
      `).get(runId) as any;
      const failed = db.prepare(`
        UPDATE analytics_runs SET status = 'failed', widget_count = ?, widgets_completed = ?,
          widgets_succeeded = ?, current_widget_id = NULL, heartbeat_at = ?,
          lease_expires_at = NULL, worker_id = NULL, worker_pid = NULL,
          error = ?, completed_at = ?
        WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
      `).run(
        Number(progress.widget_count || 0),
        Number(progress.widget_count || 0),
        Number(progress.widgets_succeeded || 0),
        completedAt,
        message,
        completedAt,
        runId,
        workerId,
        process.pid,
      );
      if (failed.changes !== 1) throw new Error(`Run ${runId} ownership changed while recording failure`);
      projectDashboardAfterRun(run, completedAt, false);
      if (run.schedule_id) {
        db.prepare(`
          UPDATE analytics_schedules SET last_run_at = ?,
            consecutive_failures = consecutive_failures + 1,
            last_error = ?, updated_at = datetime('now') WHERE id = ?
        `).run(completedAt, message, run.schedule_id);
      }
    })();
  }

  /**
   * Widgets refresh through a concurrent pool: the sql-context profile
   * reserves a 3-wide `dashboard` lane (of 4 total server slots), so up to
   * 3 widget queries run at once while interactive chat always keeps a
   * slot. Lane size is measured against the warehouse (2026-08-27: 3
   * concurrent scans run at solo speed; 6 collapsed it) — see
   * mcp-profiles.ts sql-context policy before changing.
   * Safety unchanged: every DB step below is a synchronous better-sqlite3
   * transaction (never interleaved), widget claims are row-guarded so two
   * pool workers can never take the same widget, and the cooperative cancel
   * check happens at each CLAIM — in-flight queries finish, nothing new
   * starts.
   */
  const WIDGET_REFRESH_CONCURRENCY = 3;

  async function currentServer(serverId: string) {
    if (typeof (mcpManager as any).getServer === 'function') {
      return mcpManager.getServer(serverId);
    }
    return (await mcpManager.listServers()).find(server => server.id === serverId) ?? null;
  }

  /** A lane needs both a capability-complete runtime snapshot and, for SQL,
   * one fresh warehouse connection receipt. Process liveness alone is not
   * data readiness (2026-09-19 incident: 42 timed-out health checks while the
   * process still advertised running). */
  // Local phase: Data Room snapshots, independent Data Room queries, and
  // static text. None of them needs a warehouse lane, so a dashboard built
  // only from these loads with SQL/ETL down.
  async function processLocalSnapshotWidgets(runId: string): Promise<{ ownershipLost: boolean; cancelSeen: boolean }> {
    let ownershipLost = false;
    let cancelSeen = false;
    const count = Number((db.prepare(`
      SELECT COUNT(*) AS count
      FROM analytics_run_widgets child
      WHERE child.run_id = ? AND child.status = 'queued' AND child.last_lane IS NULL
        AND (
          (? = 1 AND EXISTS (
            SELECT 1 FROM analytics_run_widget_data_room_snapshots snapshot
            WHERE snapshot.run_id = child.run_id AND snapshot.widget_id = child.widget_id
          ))
          OR json_extract(child.config_json, '$.dataSource.kind') = 'data_room_query'
          OR child.kind = 'text'
        )
    `).get(runId, dataRoomEnabled ? 1 : 0) as { count: number }).count);
    if (!count) return { ownershipLost, cancelSeen };

    const claim = (): any | 'stop' | null => {
      while (true) {
        const current = db.prepare(`
          SELECT cancel_requested FROM analytics_runs
          WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
        `).get(runId, workerId, process.pid) as { cancel_requested: number } | undefined;
        if (!current) { ownershipLost = true; return 'stop'; }
        if (current.cancel_requested) { cancelSeen = true; return 'stop'; }
        const child = db.prepare(`
          SELECT run_widget.*, run.dashboard_id
          FROM analytics_run_widgets run_widget
          JOIN analytics_runs run ON run.id = run_widget.run_id
          WHERE run_widget.run_id = ? AND run_widget.status = 'queued'
            AND run_widget.last_lane IS NULL AND run.status = 'running'
            AND (
              (? = 1 AND EXISTS (
                SELECT 1 FROM analytics_run_widget_data_room_snapshots snapshot
                WHERE snapshot.run_id = run_widget.run_id AND snapshot.widget_id = run_widget.widget_id
              ))
              OR json_extract(run_widget.config_json, '$.dataSource.kind') = 'data_room_query'
              OR run_widget.kind = 'text'
            )
            AND run.worker_id = ? AND run.worker_pid = ?
          ORDER BY run_widget.position LIMIT 1
        `).get(runId, dataRoomEnabled ? 1 : 0, workerId, process.pid) as any;
        if (!child) return null;
        const startedAt = new Date().toISOString();
        const claimed = db.transaction(() => {
          const updated = db.prepare(`
            UPDATE analytics_run_widgets SET status = 'running', error = NULL,
              started_at = ?, completed_at = NULL
            WHERE run_id = ? AND widget_id = ? AND status = 'queued' AND last_lane IS NULL
          `).run(startedAt, runId, child.widget_id);
          if (updated.changes !== 1) return false;
          const parent = db.prepare(`
            UPDATE analytics_runs SET current_widget_id = ?, heartbeat_at = ?, lease_expires_at = ?
            WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
          `).run(child.widget_id, startedAt, leaseExpiresAt(), runId, workerId, process.pid);
          if (parent.changes !== 1) throw new Error(`Run ${runId} ownership changed before local widget claim`);
          return true;
        })();
        if (claimed) return child;
      }
    };

    const complete = async (child: any): Promise<void> => {
      try {
        const result = await executeRunWidget(child);
        const completedAt = new Date().toISOString();
        db.transaction(() => {
          const source = result.source?.provider === 'data-room' || result.source?.provider === 'data-room-query'
            ? result.source
            : null;
          // Static text carries no data source receipt; everything else must.
          const staticText = child.kind === 'text' && result.trust === 'local_static_content';
          if (!source && !staticText) throw new Error('Local Data Room execution returned no exact source receipt');
          const runWidget = db.prepare(`
            UPDATE analytics_run_widgets SET status = 'completed', error = NULL, completed_at = ?
            WHERE run_id = ? AND widget_id = ? AND status = 'running' AND last_lane IS NULL
          `).run(completedAt, runId, child.widget_id);
          if (runWidget.changes !== 1) throw new Error('Local widget progress changed while its refresh was running');
          const widget = db.prepare(`
            UPDATE analytics_widgets SET result_json = ?, last_error = NULL,
              last_refreshed_at = ?, updated_at = datetime('now')
            WHERE id = ? AND dashboard_id = ? AND revision = ?
          `).run(
            JSON.stringify(result), result.refreshedAt, child.widget_id, child.dashboard_id,
            source ? source.widgetRevision : Number(child.widget_revision),
          );
          if (widget.changes !== 1) throw new Error('Widget revision changed before local result apply');
          if (source?.provider === 'data-room') dataRoom?.markApplied(runId, child.widget_id, result);
          const parent = db.prepare(`
            UPDATE analytics_runs SET widgets_completed = MIN(widget_count, widgets_completed + 1),
              widgets_succeeded = MIN(widget_count, widgets_succeeded + 1),
              current_widget_id = NULL, heartbeat_at = ?, lease_expires_at = ?
            WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
          `).run(completedAt, leaseExpiresAt(), runId, workerId, process.pid);
          if (parent.changes !== 1) throw new Error(`Run ${runId} ownership changed after local widget execution`);
        })();
      } catch (error) {
        if (!ownsRun(runId)) { ownershipLost = true; return; }
        const waiting = error instanceof AnalyticsDashboardDataRoomError
          && (error.code === 'waiting_for_data' || error.code === 'incompatible');
        const plain = String(error instanceof Error ? error.message : error).slice(0, 1900);
        const message = `${waiting ? WAITING_FOR_DATA_PREFIX : ''}${plain}`.slice(0, 2000);
        const completedAt = new Date().toISOString();
        db.transaction(() => {
          const childUpdate = db.prepare(`
            UPDATE analytics_run_widgets SET status = 'failed', error = ?, completed_at = ?
            WHERE run_id = ? AND widget_id = ? AND status = 'running' AND last_lane IS NULL
          `).run(message, completedAt, runId, child.widget_id);
          if (childUpdate.changes !== 1) throw new Error('Local widget progress changed while recording failure');
          db.prepare(`
            UPDATE analytics_widgets SET last_error = ?, updated_at = datetime('now')
            WHERE id = ? AND dashboard_id = ? AND revision = ?
          `).run(message, child.widget_id, child.dashboard_id, Number(child.widget_revision));
          if (waiting) {
            db.prepare(`
              UPDATE analytics_widget_dataset_bindings
              SET compatibility_state = CASE WHEN ? = 'incompatible' THEN 'incompatible' ELSE 'waiting' END,
                  compatibility_error = ?
              WHERE widget_id = ? AND revision = (
                SELECT binding_revision FROM analytics_run_widget_data_room_snapshots
                WHERE run_id = ? AND widget_id = ?
              )
            `).run(error instanceof AnalyticsDashboardDataRoomError ? error.code : 'waiting_for_data', plain, child.widget_id, runId, child.widget_id);
            db.prepare(`
              UPDATE analytics_dashboards SET data_state = 'waiting_for_data', updated_at = datetime('now')
              WHERE id = ? AND status != 'archived'
            `).run(child.dashboard_id);
          }
          const parent = db.prepare(`
            UPDATE analytics_runs SET widgets_completed = MIN(widget_count, widgets_completed + 1),
              current_widget_id = NULL, heartbeat_at = ?, lease_expires_at = ?
            WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
          `).run(completedAt, leaseExpiresAt(), runId, workerId, process.pid);
          if (parent.changes !== 1) throw new Error(`Run ${runId} ownership changed while recording local failure`);
        })();
      }
    };

    const worker = async (): Promise<void> => {
      while (!ownershipLost && !cancelSeen) {
        const next = claim();
        if (next === 'stop' || next === null) return;
        await complete(next);
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOCAL_WIDGET_CONCURRENCY, count) }, () => worker()));
    return { ownershipLost, cancelSeen };
  }

  async function liveLaneUsable(lane: DashboardLaneId): Promise<boolean> {
    try {
      if (lane === 'etl') {
        return etlDashboardLaneUsable(await currentServer('a2-analytics'), !!etlRunner);
      }
      const sql = await currentServer('sql-context');
      if (!sqlDashboardLaneCandidate(sql)) return false;
      // Production managers always expose the fresh probe. The fallback keeps
      // isolated service fakes honest by requiring a current health receipt.
      if (typeof (mcpManager as any).testConnection !== 'function') {
        return sqlDashboardLaneUsable(sql);
      }
      const check = await mcpManager.testConnection('sql-context');
      if (check.isError || !/^Connected(?:\n|$)/.test(check.text)) return false;
      return sqlDashboardLaneCandidate(await currentServer('sql-context'));
    } catch {
      return false;
    }
  }

  /** SQL keeps primacy only after a fresh warehouse probe. ETL is selected
   * directly when SQL is not data-ready. No usable lane fails closed rather
   * than generating one doomed SQL attempt per widget. */
  async function pickRunLane(): Promise<DashboardLaneId> {
    if (await liveLaneUsable('sql-mcp')) return 'sql-mcp';
    if (await liveLaneUsable('etl')) return 'etl';
    throw new DataLaneUnavailableError(
      'No analytics data lane is ready yet: sql-context failed its live warehouse check and '
      + 'the Datanet ETL composite is not running with its required tools. Waiting for a connection before retrying.',
    );
  }

  async function processClaimedRun(runId: string): Promise<void> {
    let ownershipLost = false;
    let cancelSeen = false;
    let primaryLaneUnavailable = false;
    const local = await processLocalSnapshotWidgets(runId);
    if (local.ownershipLost) return;
    if (local.cancelSeen) {
      finalizeCancelledRun(runId);
      return;
    }
    const legacyQueued = Number((db.prepare(`
      SELECT COUNT(*) AS count
      FROM analytics_run_widgets child
      WHERE child.run_id = ? AND child.status = 'queued'
        AND COALESCE(json_extract(child.config_json, '$.dataSource.kind'), '') != 'data_room_query'
        AND (? = 0 OR NOT EXISTS (
          SELECT 1 FROM analytics_run_widget_data_room_snapshots snapshot
          WHERE snapshot.run_id = child.run_id AND snapshot.widget_id = child.widget_id
        ))
    `).get(runId, dataRoomEnabled ? 1 : 0) as { count: number }).count);
    if (!legacyQueued) {
      const priorLane = db.prepare(`
        SELECT COALESCE(run.primary_lane, (
          SELECT child.last_lane FROM analytics_run_widgets child
          WHERE child.run_id = run.id AND child.last_lane IS NOT NULL
          ORDER BY child.position LIMIT 1
        )) AS lane
        FROM analytics_runs run WHERE run.id = ?
      `).get(runId) as { lane: DashboardLaneId | null } | undefined;
      const failedLegacy = Number((db.prepare(`
        SELECT COUNT(*) AS count FROM analytics_run_widgets child
        WHERE child.run_id = ? AND child.status = 'failed'
          AND COALESCE(json_extract(child.config_json, '$.dataSource.kind'), '') != 'data_room_query'
          AND (? = 0 OR NOT EXISTS (
            SELECT 1 FROM analytics_run_widget_data_room_snapshots snapshot
            WHERE snapshot.run_id = child.run_id AND snapshot.widget_id = child.widget_id
          ))
      `).get(runId, dataRoomEnabled ? 1 : 0) as { count: number }).count);
      if (failedLegacy && (priorLane?.lane === 'sql-mcp' || priorLane?.lane === 'etl')) {
        await retryFailedWidgetsOnOtherLane(runId, priorLane.lane);
        if (!ownsRun(runId)) return;
      }
      finalizeRun(runId);
      const run = db.prepare('SELECT dashboard_id FROM analytics_runs WHERE id = ?').get(runId) as { dashboard_id: string } | undefined;
      if (run && dataRoom) dataRoom.refreshDashboardDataState(run.dashboard_id);
      if (priorLane?.lane === 'sql-mcp' || priorLane?.lane === 'etl') maybeEscalateRunFailures(runId, priorLane.lane);
      return;
    }
    const lane = await pickRunLane();
    const laneReceipt = db.prepare(`
      UPDATE analytics_runs SET primary_lane = ?, heartbeat_at = ?, lease_expires_at = ?
      WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
    `).run(lane, new Date().toISOString(), leaseExpiresAt(), runId, workerId, process.pid);
    if (laneReceipt.changes !== 1) return;
    if (lane === 'etl') {
      console.log(`[Analytics] run ${runId}: sql-context is down — refreshing through the Datanet ETL lane (all widgets in parallel over the scratch-pair pool; each is a minutes-scale Datanet run)`);
    }

    const claimNextWidget = (): any | 'stop' | null => {
      while (true) {
        if (primaryLaneUnavailable) return null;
        // Cooperative stop point: the owner's cancel flag is honored at each
        // claim — queries already in flight run to completion and their
        // results persist. Only this worker transitions the run's status
        // (ownership guard), so cancel never steals a live run.
        const ownedRun = db.prepare(`
          SELECT cancel_requested FROM analytics_runs
          WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
        `).get(runId, workerId, process.pid) as { cancel_requested: number } | undefined;
        if (!ownedRun) { ownershipLost = true; return 'stop'; }
        if (ownedRun.cancel_requested) { cancelSeen = true; return 'stop'; }
        const widget = db.prepare(`
          SELECT rw.*, r.dashboard_id
          FROM analytics_run_widgets rw
          JOIN analytics_runs r ON r.id = rw.run_id
          WHERE rw.run_id = ? AND rw.status = 'queued' AND rw.last_lane IS NULL
            AND COALESCE(json_extract(rw.config_json, '$.dataSource.kind'), '') != 'data_room_query'
            AND (? = 0 OR NOT EXISTS (
              SELECT 1 FROM analytics_run_widget_data_room_snapshots snapshot
              WHERE snapshot.run_id = rw.run_id AND snapshot.widget_id = rw.widget_id
            ))
            AND r.status = 'running' AND r.worker_id = ? AND r.worker_pid = ?
          ORDER BY rw.position LIMIT 1
        `).get(runId, dataRoomEnabled ? 1 : 0, workerId, process.pid) as any;
        if (!widget) return null;
        const startedAt = new Date().toISOString();
        const claimed = db.transaction(() => {
          const result = db.prepare(`
            UPDATE analytics_run_widgets SET status = 'running', started_at = ?, error = NULL, last_lane = ?
            WHERE run_id = ? AND widget_id = ? AND status = 'queued'
          `).run(startedAt, lane, runId, widget.widget_id);
          if (result.changes !== 1) return false;
          const parent = db.prepare(`
            UPDATE analytics_runs SET current_widget_id = ?, heartbeat_at = ?, lease_expires_at = ?
            WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
          `).run(widget.widget_id, startedAt, leaseExpiresAt(), runId, workerId, process.pid);
          if (parent.changes !== 1) throw new Error(`Run ${runId} ownership changed before widget claim`);
          return true;
        })();
        if (claimed) return widget;
        // Another pool worker claimed it between select and update — retry.
      }
    };

    const runWidgetToCompletion = async (widget: any): Promise<void> => {
      try {
        const result = await executeRunWidgetWithSafeRuntimeRetry(widget, lane);
        const completedAt = new Date().toISOString();
        db.transaction(() => {
          const progressed = db.prepare(`
            UPDATE analytics_runs SET widgets_completed = MIN(widget_count, widgets_completed + 1),
              widgets_succeeded = MIN(widget_count, widgets_succeeded + 1),
              current_widget_id = NULL, heartbeat_at = ?, lease_expires_at = ?
            WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
          `).run(completedAt, leaseExpiresAt(), runId, workerId, process.pid);
          if (progressed.changes !== 1) throw new Error(`Run ${runId} ownership changed after widget execution`);
          const runWidget = db.prepare(`
            UPDATE analytics_run_widgets SET status = 'completed', error = NULL, completed_at = ?
            WHERE run_id = ? AND widget_id = ? AND status = 'running'
          `).run(completedAt, runId, widget.widget_id);
          if (runWidget.changes !== 1) throw new Error('Widget progress changed while its refresh was running');
          const updated = db.prepare(`
            UPDATE analytics_widgets SET result_json = ?, last_error = NULL,
              last_refreshed_at = ?, updated_at = datetime('now')
            WHERE id = ? AND dashboard_id = ?
          `).run(JSON.stringify(result), result.refreshedAt, widget.widget_id, widget.dashboard_id);
          if (updated.changes !== 1) throw new Error('Widget definition disappeared while its refresh was running');
        })();
      } catch (error: any) {
        if (!ownsRun(runId)) { ownershipLost = true; return; }
        const lateHandoff = error instanceof EtlAliveHandoffError ? error : null;
        const message = String(error?.message ?? error).slice(0, 2000);
        const laneUnavailable = isDashboardLaneUnavailable(error, lane);
        if (laneUnavailable) primaryLaneUnavailable = true;
        const completedAt = new Date().toISOString();
        db.transaction(() => {
          const progressed = db.prepare(`
            UPDATE analytics_runs SET widgets_completed = MIN(widget_count, widgets_completed + 1),
              current_widget_id = NULL, heartbeat_at = ?, lease_expires_at = ?
            WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
          `).run(completedAt, leaseExpiresAt(), runId, workerId, process.pid);
          if (progressed.changes !== 1) throw new Error(`Run ${runId} ownership changed while recording widget failure`);
          const runWidget = db.prepare(`
            UPDATE analytics_run_widgets SET status = 'failed', error = ?, completed_at = ?
            WHERE run_id = ? AND widget_id = ? AND status = 'running'
          `).run(message, completedAt, runId, widget.widget_id);
          if (runWidget.changes !== 1) throw new Error('Widget progress changed while recording its failure');
          if (lateHandoff) recordLateEtlHandoff(runId, widget, lateHandoff, completedAt);
          db.prepare(`
            UPDATE analytics_widgets SET last_error = ?, updated_at = datetime('now')
            WHERE id = ? AND dashboard_id = ?
          `).run(message, widget.widget_id, widget.dashboard_id);

          if (laneUnavailable) {
            const skippedMessage = `${lane} became unavailable; this widget was not attempted on that lane. Trigger: ${message}`.slice(0, 2000);
            const skipped = db.prepare(`
              UPDATE analytics_run_widgets SET status = 'failed', error = ?,
                started_at = COALESCE(started_at, ?), completed_at = ?,
                last_lane = COALESCE(last_lane, ?)
              WHERE run_id = ? AND status = 'queued'
                AND COALESCE(json_extract(config_json, '$.dataSource.kind'), '') != 'data_room_query'
                AND (? = 0 OR NOT EXISTS (
                  SELECT 1 FROM analytics_run_widget_data_room_snapshots snapshot
                  WHERE snapshot.run_id = analytics_run_widgets.run_id
                    AND snapshot.widget_id = analytics_run_widgets.widget_id
                ))
            `).run(skippedMessage, completedAt, completedAt, lane, runId, dataRoomEnabled ? 1 : 0);
            if (skipped.changes > 0) {
              db.prepare(`
                UPDATE analytics_runs SET widgets_completed = MIN(widget_count, widgets_completed + ?),
                  heartbeat_at = ?, lease_expires_at = ?
                WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
              `).run(skipped.changes, completedAt, leaseExpiresAt(), runId, workerId, process.pid);
              db.prepare(`
                UPDATE analytics_widgets SET last_error = ?, updated_at = datetime('now')
                WHERE dashboard_id = ? AND id IN (
                  SELECT widget_id FROM analytics_run_widgets
                  WHERE run_id = ? AND status = 'failed' AND error = ?
                )
              `).run(skippedMessage, widget.dashboard_id, runId, skippedMessage);
              console.warn(`[Analytics] run ${runId}: ${lane} unavailable after widget ${String(widget.widget_id)}; skipped ${skipped.changes} further primary-lane call(s)`);
            }
          }
        })();
      }
    };

    const poolWorker = async (): Promise<void> => {
      while (!ownershipLost && !cancelSeen) {
        const next = claimNextWidget();
        if (next === 'stop' || next === null) return;
        await runWidgetToCompletion(next);
      }
    };
    // The ETL lane runs ALL widgets in parallel (owner ruling 2026-09-09):
    // each widget claims its own scratch pair from the etl-adhoc pool, so
    // there is no shared-SQL clobber and no per-job duplicate-collapse —
    // Datanet's queue absorbs the concurrent runs. The sql lane keeps its
    // measured connector-side cap.
    const poolWidth = lane === 'etl'
      ? Math.max(1, legacyQueued)
      : WIDGET_REFRESH_CONCURRENCY;
    await Promise.all(Array.from({ length: poolWidth }, () => poolWorker()));

    if (ownershipLost) return;
    if (cancelSeen) {
      finalizeCancelledRun(runId);
      return;
    }
    await retryFailedWidgetsOnOtherLane(runId, lane);
    if (ownershipLost || !ownsRun(runId)) return;
    finalizeRun(runId);
    const completedRun = db.prepare('SELECT dashboard_id FROM analytics_runs WHERE id = ?').get(runId) as { dashboard_id: string } | undefined;
    if (completedRun && dataRoom) dataRoom.refreshDashboardDataState(completedRun.dashboard_id);
    maybeEscalateRunFailures(runId, lane);
  }

  /**
   * Post-run cross-lane retry (incident 2026-09-04): only infrastructure
   * failures move lanes. Retrying is a real durable phase: retryable child
   * rows return to queued, run progress is decremented, and workers claim them
   * into running so the UI never says N/N while recovery is still active.
   * ETL uses one worker per retryable widget (distinct scratch pairs/jobs);
   * SQL retains its measured 3-wide cap.
   */
  async function retryFailedWidgetsOnOtherLane(runId: string, primaryLane: DashboardLaneId): Promise<void> {
    const candidates = db.prepare(`
      SELECT rw.*, r.dashboard_id
      FROM analytics_run_widgets rw
      JOIN analytics_runs r ON r.id = rw.run_id
      WHERE rw.run_id = ?
        AND COALESCE(json_extract(rw.config_json, '$.dataSource.kind'), '') != 'data_room_query'
        AND (? = 0 OR NOT EXISTS (
          SELECT 1 FROM analytics_run_widget_data_room_snapshots snapshot
          WHERE snapshot.run_id = rw.run_id AND snapshot.widget_id = rw.widget_id
        ))
        AND (
          rw.status = 'failed' OR (rw.status = 'queued' AND rw.last_lane IS NOT NULL)
        )
      ORDER BY rw.position
    `).all(runId, dataRoomEnabled ? 1 : 0) as any[];
    const groups = new Map<DashboardLaneId, any[]>();
    for (const widget of candidates) {
      const handedOff = db.prepare(`
        SELECT 1 FROM analytics_late_etl_results
        WHERE run_id = ? AND widget_id = ? AND state IN ('pending','checking')
      `).get(runId, widget.widget_id);
      if (handedOff) continue; // the original ETL run is alive; never submit another copy on either lane
      if (widget.status === 'failed' && !isCrossLaneRetryableFailure(widget.error)) continue;
      const attemptedLane: DashboardLaneId = widget.last_lane === 'etl' || widget.last_lane === 'sql-mcp'
        ? widget.last_lane
        : primaryLane;
      const retryLane = otherDashboardLane(attemptedLane);
      groups.set(retryLane, [...(groups.get(retryLane) ?? []), widget]);
    }
    for (const [retryLane, widgets] of groups) {
      await retryFailedWidgetGroup(runId, retryLane, widgets);
      if (!ownsRun(runId)) return;
    }
  }

  async function retryFailedWidgetGroup(
    runId: string,
    retryLane: DashboardLaneId,
    retryable: any[],
  ): Promise<void> {
    if (!retryable.length || !(await liveLaneUsable(retryLane))) return;
    const attemptedLane = otherDashboardLane(retryLane);

    const owned = db.prepare(`
      SELECT cancel_requested FROM analytics_runs
      WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
    `).get(runId, workerId, process.pid) as { cancel_requested: number } | undefined;
    if (!owned) return;
    if (owned.cancel_requested) {
      finalizeCancelledRun(runId);
      return;
    }

    const retryStartedAt = new Date().toISOString();
    const resetRetry = db.transaction(() => {
      const reset = db.prepare(`
        UPDATE analytics_run_widgets SET status = 'queued', started_at = NULL,
          completed_at = NULL, last_lane = COALESCE(last_lane, ?)
        WHERE run_id = ? AND widget_id = ? AND status = 'failed'
      `);
      let resetCount = 0;
      let pendingCount = 0;
      for (const widget of retryable) {
        if (widget.status === 'queued') {
          pendingCount += 1;
        } else {
          resetCount += reset.run(attemptedLane, runId, widget.widget_id).changes;
        }
      }
      if (resetCount > 0) {
        const parent = db.prepare(`
          UPDATE analytics_runs SET widgets_completed = MAX(0, widgets_completed - ?),
            current_widget_id = NULL, heartbeat_at = ?, lease_expires_at = ?
          WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
        `).run(resetCount, retryStartedAt, leaseExpiresAt(), runId, workerId, process.pid);
        if (parent.changes !== 1) throw new Error(`Run ${runId} ownership changed before cross-lane retry`);
      }
      return resetCount + pendingCount;
    })();
    if (!resetRetry) return;

    console.log(`[Analytics] run ${runId}: retrying ${resetRetry} infra-failed widget(s) on the ${retryLane} lane in parallel`);
    let retryOwnershipLost = false;
    let retryCancelSeen = false;
    let retryLaneUnavailable = false;

    const claimRetryWidget = (): any | 'stop' | null => {
      while (true) {
        if (retryLaneUnavailable) return null;
        const current = db.prepare(`
          SELECT cancel_requested FROM analytics_runs
          WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
        `).get(runId, workerId, process.pid) as { cancel_requested: number } | undefined;
        if (!current) { retryOwnershipLost = true; return 'stop'; }
        if (current.cancel_requested) { retryCancelSeen = true; return 'stop'; }
        const widget = db.prepare(`
          SELECT rw.*, r.dashboard_id
          FROM analytics_run_widgets rw
          JOIN analytics_runs r ON r.id = rw.run_id
          WHERE rw.run_id = ? AND rw.status = 'queued' AND rw.last_lane = ?
            AND r.status = 'running' AND r.worker_id = ? AND r.worker_pid = ?
          ORDER BY rw.position LIMIT 1
        `).get(runId, attemptedLane, workerId, process.pid) as any;
        if (!widget) return null;
        const startedAt = new Date().toISOString();
        const claimed = db.transaction(() => {
          const child = db.prepare(`
            UPDATE analytics_run_widgets SET status = 'running', started_at = ?, completed_at = NULL, last_lane = ?
            WHERE run_id = ? AND widget_id = ? AND status = 'queued'
          `).run(startedAt, retryLane, runId, widget.widget_id);
          if (child.changes !== 1) return false;
          const parent = db.prepare(`
            UPDATE analytics_runs SET current_widget_id = ?, heartbeat_at = ?, lease_expires_at = ?
            WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
          `).run(widget.widget_id, startedAt, leaseExpiresAt(), runId, workerId, process.pid);
          if (parent.changes !== 1) throw new Error(`Run ${runId} ownership changed during cross-lane claim`);
          return true;
        })();
        if (claimed) return widget;
      }
    };

    const retryWidgetToCompletion = async (widget: any): Promise<void> => {
      try {
        const result = await executeRunWidgetWithSafeRuntimeRetry(widget, retryLane);
        const completedAt = new Date().toISOString();
        db.transaction(() => {
          const child = db.prepare(`
            UPDATE analytics_run_widgets SET status = 'completed', error = NULL, completed_at = ?
            WHERE run_id = ? AND widget_id = ? AND status = 'running'
          `).run(completedAt, runId, widget.widget_id);
          if (child.changes !== 1) throw new Error('Widget progress changed while its cross-lane retry was running');
          const updated = db.prepare(`
            UPDATE analytics_widgets SET result_json = ?, last_error = NULL,
              last_refreshed_at = ?, updated_at = datetime('now')
            WHERE id = ? AND dashboard_id = ?
          `).run(JSON.stringify(result), result.refreshedAt, widget.widget_id, widget.dashboard_id);
          if (updated.changes !== 1) throw new Error('Widget definition disappeared while its cross-lane retry was running');
          const parent = db.prepare(`
            UPDATE analytics_runs SET widgets_completed = MIN(widget_count, widgets_completed + 1),
              widgets_succeeded = MIN(widget_count, widgets_succeeded + 1),
              current_widget_id = NULL, heartbeat_at = ?, lease_expires_at = ?
            WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
          `).run(completedAt, leaseExpiresAt(), runId, workerId, process.pid);
          if (parent.changes !== 1) throw new Error(`Run ${runId} ownership changed after cross-lane success`);
        })();
        console.log(`[Analytics] run ${runId}: widget "${widget.title}" recovered on the ${retryLane} lane`);
      } catch (error: any) {
        if (!ownsRun(runId)) { retryOwnershipLost = true; return; }
        const lateHandoff = error instanceof EtlAliveHandoffError ? error : null;
        const laneUnavailable = isDashboardLaneUnavailable(error, retryLane);
        if (laneUnavailable) retryLaneUnavailable = true;
        const completedAt = new Date().toISOString();
        const message = `${String(widget.error ?? '').slice(0, 1200)} | ${retryLane} retry also failed: ${String(error?.message ?? error)}`.slice(0, 2000);
        db.transaction(() => {
          const child = db.prepare(`
            UPDATE analytics_run_widgets SET status = 'failed', error = ?, completed_at = ?
            WHERE run_id = ? AND widget_id = ? AND status = 'running'
          `).run(message, completedAt, runId, widget.widget_id);
          if (child.changes !== 1) throw new Error('Widget progress changed while recording cross-lane failure');
          if (lateHandoff) recordLateEtlHandoff(runId, widget, lateHandoff, completedAt);
          db.prepare(`
            UPDATE analytics_widgets SET last_error = ?, updated_at = datetime('now')
            WHERE id = ? AND dashboard_id = ?
          `).run(message, widget.widget_id, widget.dashboard_id);
          const parent = db.prepare(`
            UPDATE analytics_runs SET widgets_completed = MIN(widget_count, widgets_completed + 1),
              current_widget_id = NULL, heartbeat_at = ?, lease_expires_at = ?
            WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
          `).run(completedAt, leaseExpiresAt(), runId, workerId, process.pid);
          if (parent.changes !== 1) throw new Error(`Run ${runId} ownership changed after cross-lane failure`);

          if (laneUnavailable) {
            const skippedMessage = `${retryLane} became unavailable during cross-lane recovery; retry not attempted. Trigger: ${String(error?.message ?? error)}`.slice(0, 2000);
            const skipped = db.prepare(`
              UPDATE analytics_run_widgets SET status = 'failed', error = ?,
                started_at = COALESCE(started_at, ?), completed_at = ?
              WHERE run_id = ? AND status = 'queued'
            `).run(skippedMessage, completedAt, completedAt, runId);
            if (skipped.changes > 0) {
              db.prepare(`
                UPDATE analytics_runs SET widgets_completed = MIN(widget_count, widgets_completed + ?),
                  heartbeat_at = ?, lease_expires_at = ?
                WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
              `).run(skipped.changes, completedAt, leaseExpiresAt(), runId, workerId, process.pid);
              db.prepare(`
                UPDATE analytics_widgets SET last_error = ?, updated_at = datetime('now')
                WHERE dashboard_id = ? AND id IN (
                  SELECT widget_id FROM analytics_run_widgets
                  WHERE run_id = ? AND status = 'failed' AND error = ?
                )
              `).run(skippedMessage, widget.dashboard_id, runId, skippedMessage);
              console.warn(`[Analytics] run ${runId}: ${retryLane} unavailable during retry; skipped ${skipped.changes} further call(s)`);
            }
          }
        })();
      }
    };

    const retryWorker = async (): Promise<void> => {
      while (!retryOwnershipLost && !retryCancelSeen) {
        const next = claimRetryWidget();
        if (next === 'stop' || next === null) return;
        await retryWidgetToCompletion(next);
      }
    };
    const retryWidth = retryLane === 'etl'
      ? Math.max(1, retryable.length)
      : Math.min(WIDGET_REFRESH_CONCURRENCY, Math.max(1, retryable.length));
    await Promise.all(Array.from({ length: retryWidth }, () => retryWorker()));

    if (retryOwnershipLost || !ownsRun(runId)) return;
    const afterRetry = db.prepare(`
      SELECT cancel_requested FROM analytics_runs
      WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
    `).get(runId, workerId, process.pid) as { cancel_requested: number } | undefined;
    if (retryCancelSeen || afterRetry?.cancel_requested) {
      finalizeCancelledRun(runId);
      return;
    }
    db.prepare(`
      UPDATE analytics_runs SET current_widget_id = NULL, heartbeat_at = ?, lease_expires_at = ?
      WHERE id = ? AND status = 'running' AND worker_id = ? AND worker_pid = ?
    `).run(new Date().toISOString(), leaseExpiresAt(), runId, workerId, process.pid);
  }

  /** One escalation per run that finalized with failures — fire-and-forget. */
  function maybeEscalateRunFailures(runId: string, lane: DashboardLaneId): void {
    const escalate = options.onRunFailure;
    if (!escalate) return;
    const run = db.prepare('SELECT * FROM analytics_runs WHERE id = ?').get(runId) as any;
    if (!run || run.status !== 'failed') return;
    const dashboard = db.prepare('SELECT title FROM analytics_dashboards WHERE id = ?').get(run.dashboard_id) as any;
    const failures = (db.prepare(`
      SELECT widget_id, title, error FROM analytics_run_widgets
      WHERE run_id = ? AND status = 'failed' ORDER BY position
    `).all(runId) as any[]).map(row => ({
      widgetId: String(row.widget_id),
      title: String(row.title ?? row.widget_id),
      error: String(row.error ?? 'Unknown widget failure'),
    }));
    if (!failures.length) return;
    void escalate({
      runId,
      dashboardId: String(run.dashboard_id),
      dashboardTitle: String(dashboard?.title ?? run.dashboard_id),
      trigger: String(run.trigger ?? 'manual'),
      lane,
      failures,
    }).catch(error => {
      console.warn(`[Analytics] run ${runId}: failure escalation itself failed: ${error?.message ?? error}`);
    });
  }

  async function processQueuedRuns(limit = 1): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(20, Math.floor(Number(limit) || 1)));
    // Claims are row-guarded transactions, so independent scheduler slots may
    // invoke this concurrently without taking the same durable run.
    const claimedRunIds: string[] = [];
    while (claimedRunIds.length < boundedLimit) {
      const claimedRunId = db.transaction(() => {
        const queued = db.prepare(`
          SELECT id FROM analytics_runs WHERE status = 'queued'
          ORDER BY datetime(queued_at), id LIMIT 1
        `).get() as { id: string } | undefined;
        if (!queued) return null;
        const startedAt = new Date().toISOString();
        const claimed = db.prepare(`
          UPDATE analytics_runs SET status = 'running', started_at = COALESCE(started_at, ?),
            heartbeat_at = ?, lease_expires_at = ?, worker_id = ?, worker_pid = ?, error = NULL
          WHERE id = ? AND status = 'queued'
        `).run(startedAt, startedAt, leaseExpiresAt(), workerId, process.pid, queued.id);
        return claimed.changes === 1 ? queued.id : null;
      })();
      if (!claimedRunId) break;
      claimedRunIds.push(claimedRunId);
    }

    const outcomes = await Promise.all(claimedRunIds.map(async claimedRunId => {
      try {
        await processClaimedRun(claimedRunId);
        return true;
      } catch (error) {
        if (error instanceof DataLaneUnavailableError) {
          deferClaimedRunForLane(claimedRunId, error);
          return false;
        }
        console.error(`[Analytics queue] run ${claimedRunId} failed unexpectedly:`, error);
        failClaimedRun(claimedRunId, error);
        return true;
      }
    }));
    return outcomes.filter(Boolean).length;
  }

  function deleteDashboard(id: string): void {
    const dashboard = getDashboard(id);
    if (!dashboard) throw new Error(`Dashboard ${id} not found`);
    const running = activeRun(id);
    if (running) {
      throw new Error(`Dashboard cannot be deleted while refresh ${running.id} is ${running.status}`);
    }
    const publishing = db.prepare(`
      SELECT 1 FROM dashboard_publications
      WHERE dashboard_id = ? AND status = 'publishing' LIMIT 1
    `).get(id);
    if (publishing) throw new Error('Dashboard cannot be deleted while a snapshot is publishing');
    const ownedDataset = db.prepare(`
      SELECT dataset_id FROM analytics_dataset_dashboard_owners
      WHERE dashboard_id = ? ORDER BY dataset_id LIMIT 1
    `).get(id) as { dataset_id: string } | undefined;
    if (ownedDataset) {
      throw new Error(`Dashboard owns local dataset ${ownedDataset.dataset_id}; promote or retire that dataset before deleting the dashboard`);
    }
    const deleted = db.transaction(() => {
      db.prepare(`
        DELETE FROM analytics_late_etl_results
        WHERE run_id IN (SELECT id FROM analytics_runs WHERE dashboard_id = ?)
      `).run(id);
      return db.prepare('DELETE FROM analytics_dashboards WHERE id = ?').run(id);
    })();
    if (deleted.changes !== 1) throw new Error(`Dashboard ${id} not found`);
  }

  backfillLegacyLateEtlHandoffs();

  return {
    listDashboards,
    getDashboard,
    createDashboard,
    updateDashboard,
    updateWidget,
    configureWidgetSource,
    updateWidgetBinding,
    getWidgetControls,
    applyWidgetControls,
    editDataRoomWidget,
    deleteDashboard,
    setSchedule,
    enqueueRefresh,
    enqueueSelectiveRefresh,
    enqueueChangedBindings,
    getRun,
    recoverInterruptedRuns,
    cancelActiveRun,
    processQueuedRuns,
    processLateEtlResults,
  };
}
