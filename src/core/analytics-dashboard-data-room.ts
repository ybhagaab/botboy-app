import type Database from 'better-sqlite3';
import {
  analyticsRequestSha256,
  analyticsSha256,
  chooseAnalyticsSource,
  normalizeAnalyticsRequest,
  stableAnalyticsJson,
} from './analytics-data-room-policy.js';
import {
  AnalyticsDataRoomError,
  type AnalyticsDataRoomStore,
} from './analytics-data-room-store.js';
import type { AnalyticsLocalQueryEngine, AnalyticsLocalQueryViewContext } from './analytics-data-room-query.js';
import {
  AnalyticsControlError,
  analyticsControlRequestSha256,
  buildAnalyticsControlState,
} from './analytics-controls.js';
import type {
  AnalyticsCompiledLocalQuery,
  AnalyticsControlApplyInput,
  AnalyticsDatasetControlDefinitionV1,
  AnalyticsDatasetControlState,
  AnalyticsDatasetControlValuesV1,
  AnalyticsDatasetDetail,
  AnalyticsDatasetVersionDetail,
  AnalyticsDashboardViewRequestV1,
  AnalyticsRequest,
  AnalyticsSemanticReceipt,
} from './analytics-data-room-types.js';
import type {
  AnalyticsWidgetDataRoomBinding,
  AnalyticsWidgetDataRoomBindingInput,
  AnalyticsWidgetResult,
  DashboardPublicationDataRoomIdentityV1,
  DashboardPublicationDataRoomQueryIdentityV1,
} from './analytics-types.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_REQUIRED_COLUMNS = 128;

export type AnalyticsDashboardDataRoomErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'waiting_for_data'
  | 'incompatible'
  | 'policy_denied';

export class AnalyticsDashboardDataRoomError extends Error {
  constructor(
    readonly code: AnalyticsDashboardDataRoomErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AnalyticsDashboardDataRoomError';
  }
}

interface BindingRow {
  widget_id: string;
  dataset_id: string;
  revision: number;
  version_policy: AnalyticsWidgetDataRoomBinding['versionPolicy'];
  pinned_version_id: string | null;
  expected_schema_sha256: string;
  expected_contract_sha256: string | null;
  required_columns_json: string;
  request_json: string;
  request_sha256: string;
  presentation_limit: number;
  compatibility_state: AnalyticsWidgetDataRoomBinding['compatibility'];
  compatibility_error: string | null;
  observed_head_revision: number;
  last_queued_version_id: string | null;
  last_applied_version_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ControlRow {
  widget_id: string;
  dataset_id: string;
  binding_revision: number;
  control_revision: number;
  dataset_definition_revision: number;
  dataset_definition_sha256: string;
  contract_sha256: string;
  schema_sha256: string;
  control_definition_json: string;
  control_definition_sha256: string;
  default_values_json: string;
  default_values_sha256: string;
  current_values_json: string;
  current_values_sha256: string;
  effective_view_request_json: string;
  effective_view_request_sha256: string;
  created_at: string;
  updated_at: string;
}

interface WidgetRow {
  id: string;
  dashboard_id: string;
  kind: string;
  revision: number;
}

interface SnapshotRow {
  run_id: string;
  widget_id: string;
  widget_revision: number;
  binding_revision: number;
  control_revision: number | null;
  control_definition_sha256: string | null;
  control_values_sha256: string | null;
  effective_view_request_json: string | null;
  effective_view_request_sha256: string | null;
  dataset_id: string;
  dataset_definition_revision: number;
  dataset_definition_sha256: string;
  resolved_head_revision: number;
  candidate_version_id: string | null;
  version_id: string | null;
  content_sha256: string | null;
  schema_sha256: string | null;
  contract_sha256: string | null;
  request_json: string;
  request_sha256: string;
  compiled_query_json: string | null;
  query_sha256: string | null;
  compiler_version: string | null;
  semantic_context_json: string | null;
  resolution_state: AnalyticsWidgetDataRoomBinding['compatibility'];
  resolution_error: string | null;
  execution_receipt_json: string | null;
  applied_at: string | null;
  created_at: string;
}

export interface AnalyticsPreparedWidgetDataRoomSnapshot {
  widgetId: string;
  widgetRevision: number;
  binding: AnalyticsWidgetDataRoomBinding;
  dataset: AnalyticsDatasetDetail;
  resolvedHeadRevision: number;
  candidateVersionId?: string;
  version?: AnalyticsDatasetVersionDetail;
  request: AnalyticsRequest;
  controls?: AnalyticsDatasetControlState;
  compiled?: AnalyticsCompiledLocalQuery;
  semanticContext?: Record<string, unknown>;
  resolutionState: AnalyticsWidgetDataRoomBinding['compatibility'];
  resolutionError?: string;
}

export interface AnalyticsChangedBindingGroup {
  dashboardId: string;
  widgetIds: string[];
}

export interface AnalyticsDashboardDataRoomBridge {
  getBinding(widgetId: string): AnalyticsWidgetDataRoomBinding | null;
  getBindingRevision(widgetId: string): number;
  putBinding(widgetId: string, expectedRevision: number, input: AnalyticsWidgetDataRoomBindingInput): AnalyticsWidgetDataRoomBinding;
  removeBinding(widgetId: string, expectedRevision: number): number;
  getControls(widgetId: string): AnalyticsDatasetControlState | null;
  applyControls(widgetId: string, input: AnalyticsControlApplyInput): { state: AnalyticsDatasetControlState; changed: boolean };
  prepareSnapshot(widgetId: string): AnalyticsPreparedWidgetDataRoomSnapshot | null;
  persistSnapshot(runId: string, prepared: AnalyticsPreparedWidgetDataRoomSnapshot): void;
  hasSnapshot(runId: string, widgetId: string): boolean;
  executeSnapshot(runId: string, widgetId: string, signal?: AbortSignal): Promise<AnalyticsWidgetResult>;
  markApplied(runId: string, widgetId: string, receipt: AnalyticsWidgetResult): void;
  validatePublicationResult(widgetId: string, result: AnalyticsWidgetResult): DashboardPublicationDataRoomIdentityV1;
  /** Independent (config.dataSource) Data Room widget at publication; throws when it is not exact. */
  validateIndependentPublicationResult(
    widget: { id: string; revision: number; sourceConfigSha256: string; datasetId: string },
    result: AnalyticsWidgetResult,
  ): DashboardPublicationDataRoomQueryIdentityV1;
  listChangedBindings(limit?: number): AnalyticsChangedBindingGroup[];
  refreshDashboardDataState(dashboardId: string): void;
}

function fail(code: AnalyticsDashboardDataRoomErrorCode, message: string): never {
  throw new AnalyticsDashboardDataRoomError(code, message);
}

function boundedIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || value.includes('\0')) {
    return fail('invalid_input', `${label} must be a bounded identity.`);
  }
  return value.trim();
}

function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    return fail('invalid_input', `${label} must be a lowercase SHA-256.`);
  }
  return value;
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fail('incompatible', `${label} contains malformed JSON.`);
  }
}

function uniqueColumns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REQUIRED_COLUMNS) {
    return fail('invalid_input', `requiredColumns must contain 1 to ${MAX_REQUIRED_COLUMNS} fields.`);
  }
  const columns = value.map((field, index) => boundedIdentity(field, `requiredColumns[${index}]`));
  if (new Set(columns).size !== columns.length) fail('invalid_input', 'requiredColumns contains duplicates.');
  return columns.sort();
}

function mapBinding(row: BindingRow): AnalyticsWidgetDataRoomBinding {
  return {
    widgetId: row.widget_id,
    datasetId: row.dataset_id,
    revision: Number(row.revision),
    versionPolicy: row.version_policy,
    ...(row.pinned_version_id ? { pinnedVersionId: row.pinned_version_id } : {}),
    expectedSchemaSha256: row.expected_schema_sha256,
    ...(row.expected_contract_sha256 ? { expectedContractSha256: row.expected_contract_sha256 } : {}),
    requiredColumns: parseJson<string[]>(row.required_columns_json, 'Binding required columns'),
    request: parseJson<AnalyticsRequest>(row.request_json, 'Binding request'),
    requestSha256: row.request_sha256,
    presentationLimit: Number(row.presentation_limit),
    compatibility: row.compatibility_state,
    ...(row.compatibility_error ? { compatibilityError: row.compatibility_error } : {}),
    observedHeadRevision: Number(row.observed_head_revision),
    ...(row.last_queued_version_id ? { lastQueuedVersionId: row.last_queued_version_id } : {}),
    ...(row.last_applied_version_id ? { lastAppliedVersionId: row.last_applied_version_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createAnalyticsDashboardDataRoomBridge(input: {
  db: Database.Database;
  store: AnalyticsDataRoomStore;
  localQuery: AnalyticsLocalQueryEngine;
  now?: () => Date;
}): AnalyticsDashboardDataRoomBridge {
  const { db, store, localQuery } = input;
  const now = input.now ?? (() => new Date());

  function timestamp(): string {
    return now().toISOString();
  }

  function widgetRow(widgetId: string): WidgetRow {
    boundedIdentity(widgetId, 'widgetId');
    const row = db.prepare(`
      SELECT id, dashboard_id, kind, revision FROM analytics_widgets WHERE id = ?
    `).get(widgetId) as WidgetRow | undefined;
    if (!row) fail('not_found', `Widget ${widgetId} was not found.`);
    return row;
  }

  function assertDatasetScope(
    widget: WidgetRow,
    dataset: AnalyticsDatasetDetail,
    allowUnclaimedDashboardLocal: boolean,
    code: AnalyticsDashboardDataRoomErrorCode,
  ): void {
    if (dataset.scope === 'workspace') return;
    if (dataset.scope === 'project') {
      const sharedProject = db.prepare(`
        SELECT 1
        FROM analytics_dataset_project_links dataset_project
        JOIN analytics_dashboard_projects dashboard_project
          ON dashboard_project.project_id = dataset_project.project_id
        WHERE dataset_project.dataset_id = ? AND dashboard_project.dashboard_id = ?
        LIMIT 1
      `).get(dataset.id, widget.dashboard_id);
      if (!sharedProject) fail(code, 'Project-scoped dataset is not linked to this dashboard project.');
      return;
    }
    const owner = db.prepare(`
      SELECT dashboard_id FROM analytics_dataset_dashboard_owners WHERE dataset_id = ?
    `).get(dataset.id) as { dashboard_id: string } | undefined;
    if (!owner && allowUnclaimedDashboardLocal) return;
    if (!owner || owner.dashboard_id !== widget.dashboard_id) {
      fail(code, owner
        ? `Dashboard-local dataset belongs to ${owner.dashboard_id}.`
        : 'Dashboard-local dataset has no durable owner claim.');
    }
  }

  function bindingRow(widgetId: string): BindingRow | null {
    return (db.prepare(`
      SELECT * FROM analytics_widget_dataset_bindings WHERE widget_id = ?
    `).get(widgetId) as BindingRow | undefined) ?? null;
  }

  function getBindingRevision(widgetId: string): number {
    widgetRow(widgetId);
    const row = db.prepare(`
      SELECT revision FROM analytics_widget_binding_revisions WHERE widget_id = ?
    `).get(widgetId) as { revision: number } | undefined;
    return Number(row?.revision ?? 0);
  }

  function getBinding(widgetId: string): AnalyticsWidgetDataRoomBinding | null {
    const row = bindingRow(widgetId);
    return row ? mapBinding(row) : null;
  }

  function controlRow(widgetId: string): ControlRow | null {
    return (db.prepare('SELECT * FROM analytics_dataset_controls WHERE widget_id = ?')
      .get(widgetId) as ControlRow | undefined) ?? null;
  }

  function bumpRoomRevision(): void {
    const changed = db.prepare(`
      UPDATE analytics_data_room_state
      SET revision = revision + 1, updated_at = ?
      WHERE singleton = 1
    `).run(timestamp());
    if (changed.changes !== 1) fail('conflict', 'Analytics data-room revision row is unavailable.');
  }

  function mapPersistedControls(row: ControlRow, binding: AnalyticsWidgetDataRoomBinding): AnalyticsDatasetControlState {
    const definition = parseJson<AnalyticsDatasetControlDefinitionV1>(row.control_definition_json, 'Control definition');
    const defaultValues = parseJson<AnalyticsDatasetControlValuesV1>(row.default_values_json, 'Control defaults');
    const currentValues = parseJson<AnalyticsDatasetControlValuesV1>(row.current_values_json, 'Control values');
    const effectiveViewRequest = parseJson<AnalyticsDashboardViewRequestV1>(row.effective_view_request_json, 'Effective view request');
    const dataset = db.prepare(`
      SELECT definition_revision, definition_sha256, contract_sha256, schema_sha256
      FROM analytics_datasets WHERE id = ?
    `).get(row.dataset_id) as {
      definition_revision: number;
      definition_sha256: string;
      contract_sha256: string;
      schema_sha256: string;
    } | undefined;
    const exact = dataset
      && row.widget_id === binding.widgetId
      && row.dataset_id === binding.datasetId
      && Number(row.binding_revision) === binding.revision
      && Number(row.dataset_definition_revision) === Number(dataset.definition_revision)
      && row.dataset_definition_sha256 === dataset.definition_sha256
      && row.contract_sha256 === dataset.contract_sha256
      && row.schema_sha256 === dataset.schema_sha256
      && definition.bindingRevision === binding.revision
      && row.control_definition_json === stableAnalyticsJson(definition)
      && row.default_values_json === stableAnalyticsJson(defaultValues)
      && row.current_values_json === stableAnalyticsJson(currentValues)
      && row.effective_view_request_json === stableAnalyticsJson(effectiveViewRequest)
      && analyticsSha256(definition) === row.control_definition_sha256
      && analyticsSha256(defaultValues) === row.default_values_sha256
      && analyticsSha256(currentValues) === row.current_values_sha256
      && analyticsSha256(effectiveViewRequest) === row.effective_view_request_sha256;
    if (!exact) fail('conflict', 'Persisted control state differs from its binding, dataset definition, or hashes.');
    return {
      widgetId: row.widget_id,
      datasetId: row.dataset_id,
      bindingRevision: Number(row.binding_revision),
      controlRevision: Number(row.control_revision),
      definition,
      definitionSha256: row.control_definition_sha256,
      defaultValues,
      defaultValuesSha256: row.default_values_sha256,
      currentValues,
      currentValuesSha256: row.current_values_sha256,
      effectiveViewRequest,
      effectiveViewRequestSha256: row.effective_view_request_sha256,
      projected: false,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function buildCurrentControlState(binding: AnalyticsWidgetDataRoomBinding): AnalyticsDatasetControlState {
    const row = controlRow(binding.widgetId);
    if (row) return mapPersistedControls(row, binding);
    const prepared = resolveBinding(binding);
    if (!prepared.version) fail('waiting_for_data', 'Binding has no exact version for controls.');
    try {
      return buildAnalyticsControlState({
        widgetId: binding.widgetId,
        binding,
        dataset: prepared.dataset,
        version: prepared.version,
        controlRevision: 0,
        projected: true,
      });
    } catch (error) {
      if (error instanceof AnalyticsControlError) fail(error.code, error.message);
      throw error;
    }
  }

  function getControls(widgetId: string): AnalyticsDatasetControlState | null {
    const binding = getBinding(widgetId);
    return binding ? buildCurrentControlState(binding) : null;
  }

  function persistInitialControls(binding: AnalyticsWidgetDataRoomBinding): void {
    // A binding may legitimately wait for a version/definition. In that case
    // controls remain a read-time projection until an exact Apply is possible.
    let projected: AnalyticsDatasetControlState;
    try {
      projected = buildCurrentControlState(binding);
    } catch (error) {
      if (error instanceof AnalyticsDashboardDataRoomError
        && (error.code === 'waiting_for_data' || error.code === 'incompatible')) {
        db.prepare('DELETE FROM analytics_dataset_controls WHERE widget_id = ?').run(binding.widgetId);
        return;
      }
      throw error;
    }
    const resolvedVersionId = binding.versionPolicy === 'pinned'
      ? binding.pinnedVersionId
      : store.getHead(binding.datasetId)?.versionId;
    const resolvedVersion = resolvedVersionId ? store.getDatasetVersion(resolvedVersionId) : null;
    if (!resolvedVersion) fail('waiting_for_data', 'Binding has no exact version for initial controls.');
    const state = buildAnalyticsControlState({
      widgetId: binding.widgetId,
      binding,
      dataset: store.getDataset(binding.datasetId)!,
      version: resolvedVersion,
      controlRevision: 1,
      values: projected.defaultValues,
      projected: false,
      createdAt: timestamp(),
      updatedAt: timestamp(),
    });
    db.prepare(`
      INSERT INTO analytics_dataset_controls
        (widget_id, dataset_id, binding_revision, control_revision,
         dataset_definition_revision, dataset_definition_sha256,
         contract_sha256, schema_sha256, control_definition_json,
         control_definition_sha256, default_values_json, default_values_sha256,
         current_values_json, current_values_sha256,
         effective_view_request_json, effective_view_request_sha256,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(widget_id) DO UPDATE SET
        dataset_id = excluded.dataset_id,
        binding_revision = excluded.binding_revision,
        control_revision = excluded.control_revision,
        dataset_definition_revision = excluded.dataset_definition_revision,
        dataset_definition_sha256 = excluded.dataset_definition_sha256,
        contract_sha256 = excluded.contract_sha256,
        schema_sha256 = excluded.schema_sha256,
        control_definition_json = excluded.control_definition_json,
        control_definition_sha256 = excluded.control_definition_sha256,
        default_values_json = excluded.default_values_json,
        default_values_sha256 = excluded.default_values_sha256,
        current_values_json = excluded.current_values_json,
        current_values_sha256 = excluded.current_values_sha256,
        effective_view_request_json = excluded.effective_view_request_json,
        effective_view_request_sha256 = excluded.effective_view_request_sha256,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      state.widgetId, state.datasetId, state.bindingRevision, state.controlRevision,
      state.definition.datasetDefinitionRevision, state.definition.datasetDefinitionSha256,
      state.definition.contractSha256, state.definition.schemaSha256,
      stableAnalyticsJson(state.definition), state.definitionSha256,
      stableAnalyticsJson(state.defaultValues), state.defaultValuesSha256,
      stableAnalyticsJson(state.currentValues), state.currentValuesSha256,
      stableAnalyticsJson(state.effectiveViewRequest), state.effectiveViewRequestSha256,
      state.createdAt, state.updatedAt,
    );
  }

  function applyControls(
    widgetId: string,
    input: AnalyticsControlApplyInput,
  ): { state: AnalyticsDatasetControlState; changed: boolean } {
    const payload = input && typeof input === 'object' && !Array.isArray(input) ? input as any : null;
    if (!payload || Object.keys(payload).some(key => key !== 'expected' && key !== 'controls')) {
      fail('invalid_input', 'Control Apply requires only expected and controls.');
    }
    const expected = payload.expected && typeof payload.expected === 'object' && !Array.isArray(payload.expected)
      ? payload.expected as Record<string, unknown>
      : fail('invalid_input', 'Control Apply expected receipt is required.');
    const expectedKeys = [
      'widgetRevision', 'bindingRevision', 'controlRevision', 'controlValuesSha256',
      'controlDefinitionSha256', 'datasetDefinitionRevision',
      'datasetDefinitionSha256', 'contractSha256',
    ];
    const extras = Object.keys(expected).filter(key => !expectedKeys.includes(key));
    if (extras.length || expectedKeys.some(key => !Object.prototype.hasOwnProperty.call(expected, key))) {
      fail('invalid_input', 'Control Apply expected receipt fields are incomplete or unsupported.');
    }
    const widget = widgetRow(widgetId);
    const binding = getBinding(widgetId);
    if (!binding) fail('not_found', `Widget ${widgetId} has no data-room binding.`);
    const current = buildCurrentControlState(binding);
    if (!Number.isInteger(expected.widgetRevision) || Number(expected.widgetRevision) !== Number(widget.revision)
      || !Number.isInteger(expected.bindingRevision) || Number(expected.bindingRevision) !== binding.revision
      || !Number.isInteger(expected.controlRevision) || Number(expected.controlRevision) !== current.controlRevision
      || sha(expected.controlValuesSha256, 'expected.controlValuesSha256') !== current.currentValuesSha256
      || sha(expected.controlDefinitionSha256, 'expected.controlDefinitionSha256') !== current.definitionSha256
      || !Number.isInteger(expected.datasetDefinitionRevision)
      || Number(expected.datasetDefinitionRevision) !== current.definition.datasetDefinitionRevision
      || sha(expected.datasetDefinitionSha256, 'expected.datasetDefinitionSha256') !== current.definition.datasetDefinitionSha256
      || sha(expected.contractSha256, 'expected.contractSha256') !== current.definition.contractSha256) {
      fail('conflict', 'Widget, binding, control, or dataset definition changed before Apply.');
    }
    const dataset = store.getDataset(binding.datasetId)!;
    const resolvedVersionId = binding.versionPolicy === 'pinned'
      ? binding.pinnedVersionId
      : store.getHead(binding.datasetId)?.versionId;
    const version = resolvedVersionId ? store.getDatasetVersion(resolvedVersionId) : null;
    if (!version) fail('waiting_for_data', 'Binding has no exact version for control Apply.');
    let next: AnalyticsDatasetControlState;
    try {
      next = buildAnalyticsControlState({
        widgetId,
        binding,
        dataset,
        version,
        controlRevision: current.controlRevision + 1,
        values: payload.controls,
        projected: false,
        createdAt: current.createdAt ?? timestamp(),
        updatedAt: timestamp(),
      });
    } catch (error) {
      if (error instanceof AnalyticsControlError) fail(error.code, error.message);
      throw error;
    }
    if (next.currentValuesSha256 === current.currentValuesSha256
      && next.effectiveViewRequestSha256 === current.effectiveViewRequestSha256) {
      return { state: current, changed: false };
    }

    const row = controlRow(widgetId);
    if (!row) {
      db.prepare(`
        INSERT INTO analytics_dataset_controls
          (widget_id, dataset_id, binding_revision, control_revision,
           dataset_definition_revision, dataset_definition_sha256,
           contract_sha256, schema_sha256, control_definition_json,
           control_definition_sha256, default_values_json, default_values_sha256,
           current_values_json, current_values_sha256,
           effective_view_request_json, effective_view_request_sha256,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        next.widgetId, next.datasetId, next.bindingRevision, next.controlRevision,
        next.definition.datasetDefinitionRevision, next.definition.datasetDefinitionSha256,
        next.definition.contractSha256, next.definition.schemaSha256,
        stableAnalyticsJson(next.definition), next.definitionSha256,
        stableAnalyticsJson(next.defaultValues), next.defaultValuesSha256,
        stableAnalyticsJson(next.currentValues), next.currentValuesSha256,
        stableAnalyticsJson(next.effectiveViewRequest), next.effectiveViewRequestSha256,
        next.createdAt, next.updatedAt,
      );
    } else {
      const changed = db.prepare(`
        UPDATE analytics_dataset_controls
        SET control_revision = ?, current_values_json = ?, current_values_sha256 = ?,
            effective_view_request_json = ?, effective_view_request_sha256 = ?, updated_at = ?
        WHERE widget_id = ? AND binding_revision = ? AND control_revision = ?
          AND current_values_sha256 = ? AND control_definition_sha256 = ?
      `).run(
        next.controlRevision, stableAnalyticsJson(next.currentValues), next.currentValuesSha256,
        stableAnalyticsJson(next.effectiveViewRequest), next.effectiveViewRequestSha256,
        next.updatedAt, widgetId, binding.revision, current.controlRevision,
        current.currentValuesSha256, current.definitionSha256,
      );
      if (changed.changes !== 1) fail('conflict', 'Control state changed during optimistic Apply.');
    }
    bumpRoomRevision();
    return { state: buildCurrentControlState(binding), changed: true };
  }

  function normalizeBinding(
    widgetId: string,
    raw: AnalyticsWidgetDataRoomBindingInput,
  ): Omit<AnalyticsWidgetDataRoomBinding, 'revision' | 'compatibility' | 'compatibilityError' | 'observedHeadRevision' | 'lastQueuedVersionId' | 'lastAppliedVersionId' | 'createdAt' | 'updatedAt'> {
    const widget = widgetRow(widgetId);
    if (widget.kind === 'text' || widget.kind === 'html') fail('invalid_input', 'Static text and html view widgets cannot bind analytical data.');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_input', 'Binding input must be an object.');
    const datasetId = boundedIdentity(raw.datasetId, 'datasetId');
    if (!['pinned', 'latest_compatible', 'latest_fresh'].includes(raw.versionPolicy)) {
      fail('invalid_input', 'Binding versionPolicy is unsupported.');
    }
    const pinnedVersionId = raw.pinnedVersionId === undefined
      ? undefined
      : boundedIdentity(raw.pinnedVersionId, 'pinnedVersionId');
    if ((raw.versionPolicy === 'pinned') !== Boolean(pinnedVersionId)) {
      fail('invalid_input', 'Pinned policy requires one exact pinnedVersionId; latest policies forbid it.');
    }
    const dataset = store.getDataset(datasetId);
    if (!dataset) fail('not_found', `Dataset ${datasetId} was not found.`);
    if (dataset.lifecycle !== 'active' || dataset.contract.status !== 'active') {
      fail('conflict', `Dataset ${datasetId} is not active.`);
    }
    if (dataset.catalogVisibility !== 'catalog') {
      fail('policy_denied', `Dataset ${datasetId} is not available for ordinary dashboard binding.`);
    }
    assertDatasetScope(widget, dataset, true, 'conflict');
    if (pinnedVersionId) {
      const pinned = store.getDatasetVersion(pinnedVersionId);
      if (!pinned || pinned.datasetId !== datasetId) fail('not_found', `Pinned version ${pinnedVersionId} does not belong to ${datasetId}.`);
    }
    const expectedSchemaSha256 = sha(raw.expectedSchemaSha256, 'expectedSchemaSha256');
    const expectedContractSha256 = raw.expectedContractSha256 === undefined
      ? undefined
      : sha(raw.expectedContractSha256, 'expectedContractSha256');
    const requiredColumns = uniqueColumns(raw.requiredColumns);
    if (!Number.isInteger(raw.presentationLimit) || raw.presentationLimit < 1 || raw.presentationLimit > 200) {
      fail('invalid_input', 'presentationLimit must be an integer from 1 to 200.');
    }
    if (raw.request?.datasetId && raw.request.datasetId !== datasetId) {
      fail('invalid_input', 'Binding request datasetId differs from the binding dataset.');
    }
    if (raw.request?.versionId && raw.request.versionId !== pinnedVersionId) {
      fail('invalid_input', 'Binding request versionId differs from the binding version policy.');
    }
    const request = normalizeAnalyticsRequest({
      ...raw.request,
      use: 'dashboard',
      datasetId,
      ...(pinnedVersionId ? { versionId: pinnedVersionId } : { versionId: undefined }),
      resultLimit: raw.presentationLimit,
      unresolvedSemantics: undefined,
      ...(expectedContractSha256 ? { requiredContractSha256: expectedContractSha256 } : {}),
    });
    if (raw.versionPolicy === 'latest_fresh' && request.freshness.mode !== 'fresh_by') {
      fail('invalid_input', 'latest_fresh requires a fresh_by request with maxAgeMs.');
    }
    return {
      widgetId,
      datasetId,
      versionPolicy: raw.versionPolicy,
      ...(pinnedVersionId ? { pinnedVersionId } : {}),
      expectedSchemaSha256,
      ...(expectedContractSha256 ? { expectedContractSha256 } : {}),
      requiredColumns,
      request,
      requestSha256: analyticsRequestSha256(request),
      presentationLimit: raw.presentationLimit,
    };
  }

  function putBinding(
    widgetId: string,
    expectedRevision: number,
    raw: AnalyticsWidgetDataRoomBindingInput,
  ): AnalyticsWidgetDataRoomBinding {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      fail('invalid_input', 'expectedRevision must be a non-negative integer.');
    }
    const normalized = normalizeBinding(widgetId, raw);
    const current = bindingRow(widgetId);
    const actualRevision = getBindingRevision(widgetId);
    if (current && Number(current.revision) !== actualRevision) {
      fail('conflict', 'Binding row differs from its monotonic revision ledger.');
    }
    if (actualRevision !== expectedRevision) {
      fail('conflict', `Binding revision changed from expected ${expectedRevision} to ${actualRevision}.`);
    }
    const revision = actualRevision + 1;
    const at = timestamp();
    const widget = widgetRow(widgetId);
    db.transaction(() => {
      db.prepare(`
        INSERT OR IGNORE INTO analytics_widget_binding_revisions (widget_id, revision, updated_at)
        VALUES (?, 0, ?)
      `).run(widgetId, at);
      const advanced = db.prepare(`
        UPDATE analytics_widget_binding_revisions SET revision = ?, updated_at = ?
        WHERE widget_id = ? AND revision = ?
      `).run(revision, at, widgetId, expectedRevision);
      if (advanced.changes !== 1) fail('conflict', 'Binding revision changed during optimistic update.');
      const localDataset = db.prepare(`
        SELECT scope FROM analytics_datasets WHERE id = ?
      `).get(normalized.datasetId) as { scope: string };
      if (localDataset.scope === 'dashboard_local') {
        db.prepare(`
          INSERT OR IGNORE INTO analytics_dataset_dashboard_owners (dataset_id, dashboard_id, claimed_at)
          VALUES (?, ?, ?)
        `).run(normalized.datasetId, widget.dashboard_id, at);
        const owner = db.prepare(`
          SELECT dashboard_id FROM analytics_dataset_dashboard_owners WHERE dataset_id = ?
        `).get(normalized.datasetId) as { dashboard_id: string };
        if (owner.dashboard_id !== widget.dashboard_id) {
          fail('conflict', `Dashboard-local dataset belongs to ${owner.dashboard_id}.`);
        }
      }
      if (!current) {
        db.prepare(`
          INSERT INTO analytics_widget_dataset_bindings
            (widget_id, dataset_id, revision, version_policy, pinned_version_id,
             expected_schema_sha256, expected_contract_sha256, required_columns_json,
             request_json, request_sha256, presentation_limit, compatibility_state,
             compatibility_error, observed_head_revision, last_queued_version_id,
             last_applied_version_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting',
            'Binding has not resolved an immutable version yet.', 0, NULL, NULL, ?, ?)
        `).run(
          widgetId,
          normalized.datasetId,
          revision,
          normalized.versionPolicy,
          normalized.pinnedVersionId ?? null,
          normalized.expectedSchemaSha256,
          normalized.expectedContractSha256 ?? null,
          stableAnalyticsJson(normalized.requiredColumns),
          stableAnalyticsJson(normalized.request),
          normalized.requestSha256,
          normalized.presentationLimit,
          at,
          at,
        );
      } else {
        const changed = db.prepare(`
          UPDATE analytics_widget_dataset_bindings
          SET dataset_id = ?, revision = ?, version_policy = ?, pinned_version_id = ?,
              expected_schema_sha256 = ?, expected_contract_sha256 = ?,
              required_columns_json = ?, request_json = ?, request_sha256 = ?,
              presentation_limit = ?, compatibility_state = 'waiting',
              compatibility_error = 'Binding has not resolved an immutable version yet.',
              observed_head_revision = 0, last_queued_version_id = NULL,
              last_applied_version_id = NULL, updated_at = ?
          WHERE widget_id = ? AND revision = ?
        `).run(
          normalized.datasetId,
          revision,
          normalized.versionPolicy,
          normalized.pinnedVersionId ?? null,
          normalized.expectedSchemaSha256,
          normalized.expectedContractSha256 ?? null,
          stableAnalyticsJson(normalized.requiredColumns),
          stableAnalyticsJson(normalized.request),
          normalized.requestSha256,
          normalized.presentationLimit,
          at,
          widgetId,
          expectedRevision,
        );
        if (changed.changes !== 1) fail('conflict', 'Binding changed during optimistic update.');
      }
      db.prepare('DELETE FROM analytics_dataset_controls WHERE widget_id = ?').run(widgetId);
      persistInitialControls(getBinding(widgetId)!);
      bumpRoomRevision();
      db.prepare(`
        UPDATE analytics_dashboards SET data_state = 'waiting_for_data', updated_at = datetime('now')
        WHERE id = ? AND status != 'archived'
      `).run(widget.dashboard_id);
    })();
    return getBinding(widgetId)!;
  }

  function removeBinding(widgetId: string, expectedRevision: number): number {
    const current = bindingRow(widgetId);
    const actualRevision = getBindingRevision(widgetId);
    if (!current) fail('not_found', `Widget ${widgetId} has no data-room binding.`);
    if (Number(current.revision) !== actualRevision) fail('conflict', 'Binding row differs from its monotonic revision ledger.');
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1 || actualRevision !== expectedRevision) {
      fail('conflict', `Binding revision changed from expected ${expectedRevision} to ${actualRevision}.`);
    }
    const nextRevision = actualRevision + 1;
    const widget = widgetRow(widgetId);
    db.transaction(() => {
      const removed = db.prepare(`
        DELETE FROM analytics_widget_dataset_bindings WHERE widget_id = ? AND revision = ?
      `).run(widgetId, expectedRevision);
      if (removed.changes !== 1) fail('conflict', 'Binding changed during optimistic removal.');
      db.prepare('DELETE FROM analytics_dataset_controls WHERE widget_id = ?').run(widgetId);
      const advanced = db.prepare(`
        UPDATE analytics_widget_binding_revisions SET revision = ?, updated_at = ?
        WHERE widget_id = ? AND revision = ?
      `).run(nextRevision, timestamp(), widgetId, expectedRevision);
      if (advanced.changes !== 1) fail('conflict', 'Binding generation changed during optimistic removal.');
      bumpRoomRevision();
      refreshDashboardDataState(widget.dashboard_id);
    })();
    return nextRevision;
  }

  function resolveBinding(binding: AnalyticsWidgetDataRoomBinding): AnalyticsPreparedWidgetDataRoomSnapshot {
    const widget = widgetRow(binding.widgetId);
    const dataset = store.getDataset(binding.datasetId);
    if (!dataset || dataset.lifecycle !== 'active' || dataset.contract.status !== 'active') {
      fail('waiting_for_data', `Dataset ${binding.datasetId} is missing or inactive.`);
    }
    assertDatasetScope(widget, dataset, false, 'incompatible');
    const head = store.getHead(dataset.id);
    const resolvedHeadRevision = head?.headRevision ?? 0;
    if (binding.versionPolicy !== 'pinned' && dataset.kind === 'derived' && store.isDerivedDatasetDirty(dataset.id)) {
      fail('waiting_for_data', `Derived dataset ${dataset.id} is dirty; its independent materializer must publish a current head first.`);
    }
    const candidateVersionId = binding.versionPolicy === 'pinned'
      ? binding.pinnedVersionId
      : head?.versionId;
    if (!candidateVersionId) fail('waiting_for_data', `Dataset ${dataset.id} has no version for this binding.`);
    const version = store.getDatasetVersion(candidateVersionId);
    if (!version || version.datasetId !== dataset.id) {
      fail('waiting_for_data', `Dataset version ${candidateVersionId} is unavailable.`);
    }
    store.verifyVersion(version.id, 'dashboard');
    if (dataset.definitionRevision < 1 || dataset.definitionSha256 !== version.definitionSha256) {
      fail('incompatible', 'The selected version belongs to an older dataset definition without an exact current local-view recipe.');
    }
    if (version.contract.schemaSha256 !== binding.expectedSchemaSha256) {
      fail('incompatible', 'The selected version declared schema differs from the binding expectation.');
    }
    if (binding.expectedContractSha256 && version.contractSha256 !== binding.expectedContractSha256) {
      fail('incompatible', 'The selected version contract differs from the binding expectation.');
    }
    const fields = new Set(version.contract.schema.map(field => field.name));
    const missing = binding.requiredColumns.filter(field => !fields.has(field));
    if (missing.length) fail('incompatible', `The selected version is missing required fields: ${missing.join(', ')}.`);
    const request = normalizeAnalyticsRequest({
      ...binding.request,
      use: 'dashboard',
      datasetId: dataset.id,
      versionId: version.id,
      resultLimit: binding.presentationLimit,
      ...(binding.expectedContractSha256 ? { requiredContractSha256: binding.expectedContractSha256 } : {}),
    });
    const support = localQuery.supports({ dataset, version, request });
    const decision = chooseAnalyticsSource(request, [{
      datasetId: dataset.id,
      versionId: version.id,
      capability: 'materialized_answer',
      contract: version.contract,
      contentSha256: version.materializedSha256,
      contentExists: true,
      integrityVerified: true,
      querySupported: support.supported,
      selectionRank: 0,
      materializedAt: version.materializedAt,
      quality: version.quality,
    }], { sqlUsable: false, etlUsable: false }, now().getTime());
    if (!support.supported || decision.kind !== 'ready_materialized' || decision.selectedVersionId !== version.id) {
      const rejections = decision.candidates.flatMap(candidate => candidate.rejections);
      const reason = rejections.map(item => item.detail).join(' ')
        || (support.supported ? 'The selected version is not eligible for this binding.' : support.reason);
      const freshnessOnly = rejections.length > 0 && rejections.every(item => item.code === 'freshness_miss');
      fail(freshnessOnly ? 'waiting_for_data' : 'incompatible', reason);
    }
    const compiled = localQuery.compile({ dataset, version, request });
    return {
      widgetId: binding.widgetId,
      widgetRevision: Number(widget.revision),
      binding,
      dataset,
      resolvedHeadRevision,
      candidateVersionId: version.id,
      version,
      request,
      compiled,
      resolutionState: 'compatible',
      semanticContext: {
        sourceKind: version.derivation ? 'data_room_derived' : 'data_room_materialized',
        datasetId: dataset.id,
        versionId: version.id,
        metric: request.metric,
        regime: request.regime,
        countingKey: request.countingKey,
        grain: request.requiredGrain,
        dimensions: request.dimensions,
        unit: request.metric.unit,
        timeZone: request.timeZone,
        requestedRange: request.dateRange,
        coveredPartitions: version.coverage.completePartitions,
        watermark: version.coverage.watermark,
        materializedAt: version.materializedAt,
        qualityWarnings: version.quality
          .filter(item => !item.success && item.severity === 'warning')
          .map(item => item.assertionId)
          .sort(),
      },
    };
  }

  function prepareSnapshot(widgetId: string): AnalyticsPreparedWidgetDataRoomSnapshot | null {
    const binding = getBinding(widgetId);
    if (!binding) return null;
    const dataset = store.getDataset(binding.datasetId);
    if (!dataset) fail('not_found', `Dataset ${binding.datasetId} was not found.`);
    const head = store.getHead(dataset.id);
    const candidateVersionId = binding.versionPolicy === 'pinned' ? binding.pinnedVersionId : head?.versionId;
    try {
      let prepared = resolveBinding(binding);
      const controls = getControls(widgetId);
      if (controls && !controls.projected && prepared.version) {
        const view: AnalyticsLocalQueryViewContext = {
          viewRequest: controls.effectiveViewRequest,
          controlDefinitionSha256: controls.definitionSha256,
          controlValuesSha256: controls.currentValuesSha256,
          effectiveViewRequestSha256: controls.effectiveViewRequestSha256,
        };
        prepared = {
          ...prepared,
          request: controls.effectiveViewRequest.request,
          controls,
          compiled: localQuery.compile({
            dataset: prepared.dataset,
            version: prepared.version,
            request: controls.effectiveViewRequest.request,
            view,
          }),
          semanticContext: {
            ...(prepared.semanticContext ?? {}),
            requestedRange: controls.currentValues.dateRange,
            controlRevision: controls.controlRevision,
            controlDefinitionSha256: controls.definitionSha256,
            controlValuesSha256: controls.currentValuesSha256,
            effectiveViewRequestSha256: controls.effectiveViewRequestSha256,
          },
        };
      }
      const changed = db.prepare(`
        UPDATE analytics_widget_dataset_bindings
        SET compatibility_state = 'compatible', compatibility_error = NULL,
            observed_head_revision = ?
        WHERE widget_id = ? AND revision = ?
      `).run(prepared.resolvedHeadRevision, widgetId, binding.revision);
      if (changed.changes !== 1) fail('conflict', 'Binding changed during version resolution.');
      return prepared;
    } catch (error) {
      const known = error instanceof AnalyticsDashboardDataRoomError || error instanceof AnalyticsDataRoomError;
      if (!known) throw error;
      const message = String(error.message).slice(0, 2000);
      const waiting = (error instanceof AnalyticsDashboardDataRoomError && error.code === 'waiting_for_data')
        || (error instanceof AnalyticsDataRoomError && (error.code === 'conflict' || error.code === 'not_found'));
      const compatibility = waiting ? 'waiting' : 'incompatible';
      const changed = db.prepare(`
        UPDATE analytics_widget_dataset_bindings
        SET compatibility_state = ?, compatibility_error = ?, observed_head_revision = ?
        WHERE widget_id = ? AND revision = ?
      `).run(compatibility, message, head?.headRevision ?? 0, widgetId, binding.revision);
      if (changed.changes !== 1) fail('conflict', 'Binding changed during failed version resolution.');
      return {
        widgetId,
        widgetRevision: Number(widgetRow(widgetId).revision),
        binding: { ...binding, compatibility, compatibilityError: message, observedHeadRevision: head?.headRevision ?? 0 },
        dataset,
        resolvedHeadRevision: head?.headRevision ?? 0,
        ...(candidateVersionId ? { candidateVersionId } : {}),
        request: binding.request,
        resolutionState: compatibility,
        resolutionError: message,
      };
    }
  }

  function persistSnapshot(runId: string, prepared: AnalyticsPreparedWidgetDataRoomSnapshot): void {
    boundedIdentity(runId, 'runId');
    const widget = widgetRow(prepared.widgetId);
    if (Number(widget.revision) !== prepared.widgetRevision) {
      fail('conflict', 'Widget revision changed before the data-room snapshot committed.');
    }
    const current = getBinding(prepared.widgetId);
    if (!current || current.revision !== prepared.binding.revision || current.datasetId !== prepared.dataset.id) {
      fail('conflict', 'Binding changed before the data-room snapshot committed.');
    }
    if (prepared.controls) {
      const controls = getControls(prepared.widgetId);
      if (!controls || controls.projected
        || controls.controlRevision !== prepared.controls.controlRevision
        || controls.definitionSha256 !== prepared.controls.definitionSha256
        || controls.currentValuesSha256 !== prepared.controls.currentValuesSha256
        || controls.effectiveViewRequestSha256 !== prepared.controls.effectiveViewRequestSha256) {
        fail('conflict', 'Control state changed before the data-room snapshot committed.');
      }
    }
    if (current.versionPolicy !== 'pinned') {
      const head = store.getHead(current.datasetId);
      if ((head?.headRevision ?? 0) !== prepared.resolvedHeadRevision) {
        fail('conflict', 'Dataset head changed before the data-room snapshot committed.');
      }
    }
    const createdAt = timestamp();
    db.prepare(`
      INSERT INTO analytics_run_widget_data_room_snapshots
        (run_id, widget_id, widget_revision, binding_revision, control_revision,
         control_definition_sha256, control_values_sha256,
         effective_view_request_json, effective_view_request_sha256,
         dataset_id, dataset_definition_revision, dataset_definition_sha256,
         resolved_head_revision, candidate_version_id, version_id, content_sha256,
         schema_sha256, contract_sha256, request_json, request_sha256,
         compiled_query_json, query_sha256, compiler_version, semantic_context_json,
         resolution_state, resolution_error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      prepared.widgetId,
      prepared.widgetRevision,
      prepared.binding.revision,
      prepared.controls?.controlRevision ?? null,
      prepared.controls?.definitionSha256 ?? null,
      prepared.controls?.currentValuesSha256 ?? null,
      prepared.controls ? stableAnalyticsJson(prepared.controls.effectiveViewRequest) : null,
      prepared.controls?.effectiveViewRequestSha256 ?? null,
      prepared.dataset.id,
      prepared.dataset.definitionRevision,
      prepared.dataset.definitionSha256,
      prepared.resolvedHeadRevision,
      prepared.candidateVersionId ?? null,
      prepared.version?.id ?? null,
      prepared.version?.materializedSha256 ?? null,
      prepared.version?.observedSchemaSha256 ?? null,
      prepared.version?.contractSha256 ?? null,
      stableAnalyticsJson(prepared.request),
      prepared.controls ? analyticsControlRequestSha256(prepared.controls) : analyticsRequestSha256(prepared.request),
      prepared.compiled ? stableAnalyticsJson(prepared.compiled) : null,
      prepared.compiled?.querySha256 ?? null,
      prepared.compiled?.compilerVersion ?? null,
      prepared.semanticContext ? stableAnalyticsJson(prepared.semanticContext) : null,
      prepared.resolutionState,
      prepared.resolutionError ?? null,
      createdAt,
    );
    const updated = db.prepare(`
      UPDATE analytics_widget_dataset_bindings
      SET observed_head_revision = ?, last_queued_version_id = ?,
          compatibility_state = ?, compatibility_error = ?
      WHERE widget_id = ? AND revision = ?
    `).run(
      prepared.resolvedHeadRevision,
      prepared.candidateVersionId ?? null,
      prepared.resolutionState,
      prepared.resolutionError ?? null,
      prepared.widgetId,
      prepared.binding.revision,
    );
    if (updated.changes !== 1) fail('conflict', 'Binding changed while recording its run snapshot.');
  }

  function hasSnapshot(runId: string, widgetId: string): boolean {
    return Boolean(db.prepare(`
      SELECT 1 FROM analytics_run_widget_data_room_snapshots
      WHERE run_id = ? AND widget_id = ?
    `).get(runId, widgetId));
  }

  function snapshotView(row: SnapshotRow): AnalyticsLocalQueryViewContext | undefined {
    if (row.control_revision === null) {
      if (row.control_definition_sha256 !== null || row.control_values_sha256 !== null
        || row.effective_view_request_json !== null || row.effective_view_request_sha256 !== null) {
        fail('conflict', 'Legacy snapshot contains partial control identity.');
      }
      return undefined;
    }
    if (!row.control_definition_sha256 || !row.control_values_sha256
      || !row.effective_view_request_json || !row.effective_view_request_sha256) {
      fail('conflict', 'Controlled snapshot is missing exact view identity.');
    }
    return {
      viewRequest: parseJson<AnalyticsDashboardViewRequestV1>(row.effective_view_request_json, 'Run effective view request'),
      controlDefinitionSha256: row.control_definition_sha256,
      controlValuesSha256: row.control_values_sha256,
      effectiveViewRequestSha256: row.effective_view_request_sha256,
    };
  }

  async function executeSnapshot(runId: string, widgetId: string, signal?: AbortSignal): Promise<AnalyticsWidgetResult> {
    const row = db.prepare(`
      SELECT snapshot.*, widget.revision AS current_widget_revision,
        binding.revision AS current_binding_revision,
        binding.dataset_id AS current_dataset_id,
        controls.control_revision AS current_control_revision,
        controls.control_definition_sha256 AS current_control_definition_sha256,
        controls.current_values_sha256 AS current_control_values_sha256,
        controls.effective_view_request_sha256 AS current_effective_view_request_sha256
      FROM analytics_run_widget_data_room_snapshots snapshot
      JOIN analytics_widgets widget ON widget.id = snapshot.widget_id
      LEFT JOIN analytics_widget_dataset_bindings binding ON binding.widget_id = snapshot.widget_id
      LEFT JOIN analytics_dataset_controls controls ON controls.widget_id = snapshot.widget_id
      WHERE snapshot.run_id = ? AND snapshot.widget_id = ?
    `).get(runId, widgetId) as (SnapshotRow & {
      current_widget_revision: number;
      current_binding_revision: number | null;
      current_dataset_id: string | null;
      current_control_revision: number | null;
      current_control_definition_sha256: string | null;
      current_control_values_sha256: string | null;
      current_effective_view_request_sha256: string | null;
    }) | undefined;
    if (!row) fail('not_found', `Data-room snapshot ${runId}/${widgetId} was not found.`);
    if (Number(row.current_widget_revision) !== Number(row.widget_revision)
      || Number(row.current_binding_revision) !== Number(row.binding_revision)
      || row.current_dataset_id !== row.dataset_id) {
      fail('conflict', 'Widget or binding revision changed after this run was queued; stale local output was not applied.');
    }
    if (row.control_revision !== null
      && (Number(row.current_control_revision) !== Number(row.control_revision)
        || row.current_control_definition_sha256 !== row.control_definition_sha256
        || row.current_control_values_sha256 !== row.control_values_sha256
        || row.current_effective_view_request_sha256 !== row.effective_view_request_sha256)) {
      fail('conflict', 'Control state changed after this run was queued; stale local output was not applied.');
    }
    if (row.resolution_error || !row.version_id || !row.compiled_query_json || !row.query_sha256) {
      fail(
        row.resolution_state === 'incompatible' ? 'incompatible' : 'waiting_for_data',
        row.resolution_error || 'The binding has no resolved immutable version yet.',
      );
    }
    const dataset = store.getDataset(row.dataset_id);
    const version = store.getDatasetVersion(row.version_id);
    if (!dataset || !version || version.datasetId !== dataset.id) {
      fail('waiting_for_data', 'The snapshotted dataset version is unavailable.');
    }
    assertDatasetScope(widgetRow(widgetId), dataset, false, 'incompatible');
    if (dataset.definitionRevision !== Number(row.dataset_definition_revision)
      || dataset.definitionSha256 !== row.dataset_definition_sha256
      || version.materializedSha256 !== row.content_sha256
      || version.observedSchemaSha256 !== row.schema_sha256
      || version.contractSha256 !== row.contract_sha256) {
      fail('conflict', 'The immutable dataset snapshot no longer matches its queued receipt.');
    }
    const request = normalizeAnalyticsRequest(parseJson<AnalyticsRequest>(row.request_json, 'Run binding request'));
    const view = snapshotView(row);
    const persistedCompiled = parseJson<AnalyticsCompiledLocalQuery>(row.compiled_query_json, 'Run compiled query');
    const compiled = localQuery.compile({ dataset, version, request, ...(view ? { view } : {}) });
    if (compiled.querySha256 !== row.query_sha256
      || stableAnalyticsJson(compiled) !== stableAnalyticsJson(persistedCompiled)) {
      fail('conflict', 'The effective local query changed after this run was queued.');
    }
    const executed = await localQuery.execute({ dataset, version, request, ...(view ? { view } : {}), signal });
    if (executed.receipt.querySha256 !== row.query_sha256 || executed.receipt.versionId !== version.id) {
      fail('conflict', 'Local query execution returned a receipt for a different snapshot.');
    }
    const qualityWarnings = version.quality
      .filter(item => !item.success && item.severity === 'warning')
      .map(item => item.assertionId)
      .sort();
    const limitations = executed.result.truncated
      ? [`Result displays ${executed.result.displayedRowCount} of ${executed.result.rowCount} rows within fixed row/byte limits.`]
      : [];
    const receipt: AnalyticsSemanticReceipt = {
      requestSha256: row.request_sha256,
      sourceKind: version.derivation ? 'data_room_derived' : 'data_room_materialized',
      executionKind: 'materialized_answer',
      metric: request.metric,
      regime: request.regime,
      countingKey: request.countingKey,
      grain: request.requiredGrain,
      dimensions: request.dimensions,
      unit: request.metric.unit,
      timeZone: request.timeZone,
      requestedRange: request.dateRange,
      coveredPartitions: version.coverage.completePartitions,
      watermark: version.coverage.watermark,
      datasetIds: [dataset.id],
      versionIds: [version.id],
      contractSha256: version.contractSha256,
      definitionSha256: version.definitionSha256,
      contentSha256: version.materializedSha256,
      materializedAt: version.materializedAt,
      sourceDecision: { kind: 'ready_materialized', reason: 'exact_materialized_candidate' },
      schemaSha256: version.observedSchemaSha256,
      querySha256: executed.receipt.querySha256,
      queryCompilerVersion: executed.receipt.compilerVersion,
      integrityVerifiedAt: executed.receipt.integrityVerifiedAt,
      resultLimit: executed.receipt.rowLimit,
      resultByteLimit: executed.receipt.byteLimit,
      ...(version.derivation ? {
        inputVersionIds: version.derivation.inputs.map(item => item.versionId),
        materializationKeySha256: version.derivation.materializationKeySha256,
        transformSha256: version.derivation.transformSha256,
      } : {}),
      qualityWarnings,
      limitations,
    };
    return {
      trust: 'local_verified_data',
      ...executed.result,
      executionTimeMs: executed.receipt.elapsedMs,
      refreshedAt: timestamp(),
      source: {
        provider: 'data-room',
        datasetId: dataset.id,
        versionId: version.id,
        bindingRevision: Number(row.binding_revision),
        widgetRevision: Number(row.widget_revision),
        querySha256: row.query_sha256,
        compilerVersion: executed.receipt.compilerVersion,
        contentSha256: version.materializedSha256,
        schemaSha256: version.observedSchemaSha256,
        contractSha256: version.contractSha256,
        definitionSha256: version.definitionSha256,
        requestSha256: row.request_sha256,
        ...(row.control_revision !== null ? {
          controlRevision: Number(row.control_revision),
          controlDefinitionSha256: row.control_definition_sha256!,
          controlValuesSha256: row.control_values_sha256!,
          effectiveViewRequestSha256: row.effective_view_request_sha256!,
        } : {}),
        semanticReceipt: receipt,
      },
    };
  }

  function markApplied(runId: string, widgetId: string, result: AnalyticsWidgetResult): void {
    if (result.source?.provider !== 'data-room') fail('invalid_input', 'Only a data-room result can complete a data-room snapshot.');
    const queued = db.prepare(`
      SELECT snapshot.*, widget.revision AS current_widget_revision,
        binding.revision AS current_binding_revision,
        binding.dataset_id AS current_dataset_id,
        controls.control_revision AS current_control_revision,
        controls.control_definition_sha256 AS current_control_definition_sha256,
        controls.current_values_sha256 AS current_control_values_sha256,
        controls.effective_view_request_sha256 AS current_effective_view_request_sha256
      FROM analytics_run_widget_data_room_snapshots snapshot
      JOIN analytics_widgets widget ON widget.id = snapshot.widget_id
      LEFT JOIN analytics_widget_dataset_bindings binding ON binding.widget_id = snapshot.widget_id
      LEFT JOIN analytics_dataset_controls controls ON controls.widget_id = snapshot.widget_id
      WHERE snapshot.run_id = ? AND snapshot.widget_id = ?
    `).get(runId, widgetId) as (SnapshotRow & {
      current_widget_revision: number;
      current_binding_revision: number | null;
      current_dataset_id: string | null;
      current_control_revision: number | null;
      current_control_definition_sha256: string | null;
      current_control_values_sha256: string | null;
      current_effective_view_request_sha256: string | null;
    }) | undefined;
    if (!queued || queued.applied_at
      || Number(queued.current_widget_revision) !== Number(queued.widget_revision)
      || Number(queued.current_binding_revision) !== Number(queued.binding_revision)
      || queued.current_dataset_id !== queued.dataset_id
      || queued.version_id !== result.source.versionId
      || queued.query_sha256 !== result.source.querySha256) {
      fail('conflict', 'Widget, binding, or run snapshot changed before local result apply.');
    }
    if (queued.control_revision !== null
      && (Number(queued.current_control_revision) !== Number(queued.control_revision)
        || queued.current_control_definition_sha256 !== queued.control_definition_sha256
        || queued.current_control_values_sha256 !== queued.control_values_sha256
        || queued.current_effective_view_request_sha256 !== queued.effective_view_request_sha256
        || result.source.controlRevision !== Number(queued.control_revision)
        || result.source.controlDefinitionSha256 !== queued.control_definition_sha256
        || result.source.controlValuesSha256 !== queued.control_values_sha256
        || result.source.effectiveViewRequestSha256 !== queued.effective_view_request_sha256
        || result.source.requestSha256 !== queued.request_sha256)) {
      fail('conflict', 'Control or result identity changed before local result apply.');
    }
    const dataset = store.getDataset(queued.dataset_id);
    const version = queued.version_id ? store.getDatasetVersion(queued.version_id) : null;
    if (!dataset || !version
      || dataset.definitionRevision !== Number(queued.dataset_definition_revision)
      || dataset.definitionSha256 !== queued.dataset_definition_sha256
      || version.materializedSha256 !== queued.content_sha256
      || version.observedSchemaSha256 !== queued.schema_sha256
      || version.contractSha256 !== queued.contract_sha256) {
      fail('conflict', 'Dataset definition or immutable version changed before local result apply.');
    }
    assertDatasetScope(widgetRow(widgetId), dataset, false, 'conflict');
    store.verifyVersion(version.id, 'dashboard');
    const request = normalizeAnalyticsRequest(parseJson<AnalyticsRequest>(queued.request_json, 'Run binding request'));
    const view = snapshotView(queued);
    const compiled = localQuery.compile({ dataset, version, request, ...(view ? { view } : {}) });
    if (compiled.querySha256 !== queued.query_sha256
      || stableAnalyticsJson(compiled) !== stableAnalyticsJson(parseJson<AnalyticsCompiledLocalQuery>(queued.compiled_query_json!, 'Run compiled query'))) {
      fail('conflict', 'Effective local query changed before local result apply.');
    }
    const appliedAt = timestamp();
    const snapshot = db.prepare(`
      UPDATE analytics_run_widget_data_room_snapshots
      SET execution_receipt_json = ?, applied_at = ?
      WHERE run_id = ? AND widget_id = ? AND applied_at IS NULL
        AND version_id = ? AND query_sha256 = ?
        AND ((? IS NULL AND control_revision IS NULL)
          OR (control_revision = ? AND control_definition_sha256 = ?
            AND control_values_sha256 = ? AND effective_view_request_sha256 = ?))
    `).run(
      stableAnalyticsJson(result.source.semanticReceipt),
      appliedAt,
      runId,
      widgetId,
      result.source.versionId,
      result.source.querySha256,
      queued.control_revision,
      queued.control_revision,
      queued.control_definition_sha256,
      queued.control_values_sha256,
      queued.effective_view_request_sha256,
    );
    if (snapshot.changes !== 1) fail('conflict', 'Data-room run snapshot changed before result apply.');
    const binding = db.prepare(`
      UPDATE analytics_widget_dataset_bindings
      SET last_applied_version_id = ?, compatibility_state = 'compatible',
          compatibility_error = NULL
      WHERE widget_id = ? AND revision = ? AND dataset_id = ?
    `).run(
      result.source.versionId,
      widgetId,
      result.source.bindingRevision,
      result.source.datasetId,
    );
    if (binding.changes !== 1) fail('conflict', 'Binding changed before the local result apply.');
  }

  function validateIndependentPublicationResult(
    widget: { id: string; revision: number; sourceConfigSha256: string; datasetId: string },
    result: AnalyticsWidgetResult,
  ): DashboardPublicationDataRoomQueryIdentityV1 {
    const source = result.source as Record<string, any> | undefined;
    if (result.trust !== 'local_verified_data' || source?.provider !== 'data-room-query') {
      fail('conflict', `Widget ${widget.id} has no verified Data Room result for publication. Refresh it first.`);
    }
    if (source.sourceConfigSha256 !== widget.sourceConfigSha256 || source.datasetId !== widget.datasetId) {
      fail('conflict', `Widget ${widget.id} result came from a different source than the widget now has. Refresh it first.`);
    }
    if (Number(source.widgetRevision) !== widget.revision) {
      fail('conflict', `Widget ${widget.id} changed after its result was read. Refresh it first.`);
    }
    const head = store.getHead(widget.datasetId);
    if (!head || head.versionId !== source.versionId) {
      fail('conflict', `Dataset ${widget.datasetId} has a newer version than widget ${widget.id} shows. Refresh the dashboard first.`);
    }
    const version = store.getDatasetVersion(source.versionId);
    if (!version || version.datasetId !== widget.datasetId
      || source.contentSha256 !== version.materializedSha256
      || source.schemaSha256 !== version.observedSchemaSha256
      || source.contractSha256 !== version.contractSha256
      || source.definitionSha256 !== version.definitionSha256) {
      fail('conflict', `Widget ${widget.id} result does not match dataset version ${source.versionId}.`);
    }
    // Re-reads the stored files and applies the dataset's publication policy.
    store.verifyVersion(version.id, 'publication');
    return {
      datasetId: widget.datasetId,
      versionId: version.id,
      headRevision: head.headRevision,
      sourceConfigSha256: String(source.sourceConfigSha256),
      querySha256: String(source.querySha256),
      compilerVersion: String(source.compilerVersion),
      contentSha256: String(source.contentSha256),
      schemaSha256: String(source.schemaSha256),
      contractSha256: String(source.contractSha256),
      definitionSha256: String(source.definitionSha256),
    };
  }

  function validatePublicationResult(
    widgetId: string,
    result: AnalyticsWidgetResult,
  ): DashboardPublicationDataRoomIdentityV1 {
    const binding = getBinding(widgetId);
    if (!binding) fail('not_found', `Widget ${widgetId} has no data-room binding.`);
    if (result.trust !== 'local_verified_data' || result.source?.provider !== 'data-room') {
      fail('conflict', `Bound widget ${widgetId} has no current verified data-room result for publication.`);
    }
    const prepared = prepareSnapshot(widgetId);
    if (!prepared || prepared.resolutionState !== 'compatible' || !prepared.version || !prepared.compiled) {
      fail('conflict', `Bound widget ${widgetId} is not currently publication-ready.`);
    }
    const source = result.source;
    const version = prepared.version;
    const controls = prepared.controls ?? getControls(widgetId);
    if (!controls) fail('conflict', `Bound widget ${widgetId} has no current control identity.`);
    const head = store.getHead(binding.datasetId);
    if (binding.lastAppliedVersionId !== source.versionId
      || source.datasetId !== binding.datasetId
      || source.versionId !== version.id
      || source.widgetRevision !== prepared.widgetRevision
      || source.bindingRevision !== binding.revision
      || source.querySha256 !== prepared.compiled.querySha256
      || source.compilerVersion !== prepared.compiled.compilerVersion
      || source.contentSha256 !== version.materializedSha256
      || source.schemaSha256 !== version.observedSchemaSha256
      || source.contractSha256 !== version.contractSha256
      || source.definitionSha256 !== version.definitionSha256
      || source.requestSha256 !== analyticsRequestSha256(prepared.request)) {
      fail('conflict', `Bound widget ${widgetId} result identity differs from current publication state.`);
    }
    if (controls.projected) {
      if (source.controlRevision !== undefined) {
        fail('conflict', `Bound widget ${widgetId} result has stale persisted controls.`);
      }
    } else if (source.controlRevision !== controls.controlRevision
      || source.controlDefinitionSha256 !== controls.definitionSha256
      || source.controlValuesSha256 !== controls.currentValuesSha256
      || source.effectiveViewRequestSha256 !== controls.effectiveViewRequestSha256) {
      fail('conflict', `Bound widget ${widgetId} control identity differs from the applied result.`);
    }
    const applied = db.prepare(`
      SELECT * FROM analytics_run_widget_data_room_snapshots
      WHERE widget_id = ? AND widget_revision = ? AND binding_revision = ?
        AND version_id = ? AND query_sha256 = ? AND applied_at IS NOT NULL
      ORDER BY applied_at DESC, run_id DESC LIMIT 1
    `).get(widgetId, prepared.widgetRevision, binding.revision, version.id, prepared.compiled.querySha256) as SnapshotRow | undefined;
    if (!applied || !applied.execution_receipt_json
      || stableAnalyticsJson(parseJson<AnalyticsSemanticReceipt>(applied.execution_receipt_json, 'Applied publication receipt'))
        !== stableAnalyticsJson(source.semanticReceipt)) {
      fail('conflict', `Bound widget ${widgetId} semantic receipt is not backed by its applied snapshot.`);
    }
    if (applied.control_revision === null) {
      if (!controls.projected || source.controlRevision !== undefined) {
        fail('conflict', `Bound widget ${widgetId} legacy control receipt is no longer current.`);
      }
    } else if (Number(applied.control_revision) !== controls.controlRevision
      || applied.control_definition_sha256 !== controls.definitionSha256
      || applied.control_values_sha256 !== controls.currentValuesSha256
      || applied.effective_view_request_sha256 !== controls.effectiveViewRequestSha256) {
      fail('conflict', `Bound widget ${widgetId} applied control snapshot differs from current controls.`);
    }
    try {
      store.verifyVersion(version.id, 'publication');
    } catch (error) {
      if (error instanceof AnalyticsDataRoomError) fail(error.code === 'policy_denied' ? 'policy_denied' : 'conflict', error.message);
      throw error;
    }
    return {
      datasetId: binding.datasetId,
      datasetDefinitionRevision: prepared.dataset.definitionRevision,
      bindingRevision: binding.revision,
      bindingSha256: analyticsSha256({
        datasetId: binding.datasetId,
        revision: binding.revision,
        versionPolicy: binding.versionPolicy,
        pinnedVersionId: binding.pinnedVersionId ?? null,
        expectedSchemaSha256: binding.expectedSchemaSha256,
        expectedContractSha256: binding.expectedContractSha256 ?? null,
        requiredColumns: binding.requiredColumns,
        requestSha256: binding.requestSha256,
        presentationLimit: binding.presentationLimit,
      }),
      versionPolicy: binding.versionPolicy,
      ...(binding.pinnedVersionId ? { pinnedVersionId: binding.pinnedVersionId } : {}),
      lastAppliedVersionId: binding.lastAppliedVersionId!,
      head: {
        ...(head?.versionId ? { versionId: head.versionId } : {}),
        headRevision: head?.headRevision ?? 0,
        ...(head?.definitionRevision ? { definitionRevision: head.definitionRevision } : {}),
      },
      control: {
        revision: controls.controlRevision,
        projected: controls.projected,
        definitionSha256: controls.definitionSha256,
        valuesSha256: controls.currentValuesSha256,
        effectiveViewRequestSha256: controls.effectiveViewRequestSha256,
      },
      versionId: version.id,
      requestSha256: source.requestSha256!,
      querySha256: source.querySha256,
      compilerVersion: source.compilerVersion,
      contentSha256: source.contentSha256,
      schemaSha256: source.schemaSha256,
      contractSha256: source.contractSha256,
      definitionSha256: source.definitionSha256,
      semanticReceiptSha256: analyticsSha256(source.semanticReceipt),
    };
  }

  function listChangedBindings(limit = 20): AnalyticsChangedBindingGroup[] {
    const bounded = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
    const rows = db.prepare(`
      SELECT binding.*, widget.dashboard_id, head.version_id AS head_version_id,
        head.head_revision AS current_head_revision
      FROM analytics_widget_dataset_bindings binding
      JOIN analytics_widgets widget ON widget.id = binding.widget_id
      LEFT JOIN analytics_dataset_heads head ON head.dataset_id = binding.dataset_id
      JOIN analytics_dashboards dashboard ON dashboard.id = widget.dashboard_id
      WHERE dashboard.status != 'archived'
      ORDER BY widget.dashboard_id, widget.position, binding.widget_id
    `).all() as Array<BindingRow & {
      dashboard_id: string;
      head_version_id: string | null;
      current_head_revision: number | null;
    }>;
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const targetVersionId = row.version_policy === 'pinned' ? row.pinned_version_id : row.head_version_id;
      if (!targetVersionId) continue;
      let shouldQueue = targetVersionId !== row.last_queued_version_id;
      if (!shouldQueue && row.version_policy === 'latest_fresh' && row.compatibility_state === 'compatible') {
        const request = parseJson<AnalyticsRequest>(row.request_json, 'Binding request');
        const version = store.getDatasetVersion(targetVersionId);
        if (request.freshness.mode === 'fresh_by' && version) {
          const materializedAge = now().getTime() - Date.parse(version.materializedAt);
          const watermarkAge = now().getTime() - Date.parse(version.coverage.watermark);
          shouldQueue = !Number.isFinite(materializedAge) || !Number.isFinite(watermarkAge)
            || materializedAge > request.freshness.maxAgeMs
            || watermarkAge > request.freshness.maxAgeMs;
        }
      }
      if (!shouldQueue) continue;
      if (!grouped.has(row.dashboard_id) && grouped.size >= bounded) continue;
      grouped.set(row.dashboard_id, [...(grouped.get(row.dashboard_id) ?? []), row.widget_id]);
    }
    return [...grouped.entries()].map(([dashboardId, widgetIds]) => ({ dashboardId, widgetIds }));
  }

  function refreshDashboardDataState(dashboardId: string): void {
    const waiting = db.prepare(`
      SELECT 1 FROM analytics_widget_dataset_bindings binding
      JOIN analytics_widgets widget ON widget.id = binding.widget_id
      WHERE widget.dashboard_id = ? AND binding.compatibility_state != 'compatible'
      LIMIT 1
    `).get(dashboardId);
    db.prepare(`
      UPDATE analytics_dashboards SET data_state = ?, updated_at = datetime('now')
      WHERE id = ? AND status != 'archived'
    `).run(waiting ? 'waiting_for_data' : null, dashboardId);
  }

  return {
    getBinding,
    getBindingRevision,
    putBinding,
    removeBinding,
    getControls,
    applyControls,
    prepareSnapshot,
    persistSnapshot,
    hasSnapshot,
    executeSnapshot,
    markApplied,
    validatePublicationResult,
    validateIndependentPublicationResult,
    listChangedBindings,
    refreshDashboardDataState,
  };
}
