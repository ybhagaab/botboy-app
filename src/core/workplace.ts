/**
 * Workplace — the owner-attested "Amazon Employee" setting (NON_AMAZON_PATHS_PLAN D1).
 *
 * A visibility and activation switch, not an access-control boundary: while
 * OFF, BotBoy's Amazon internal paths (the four Amazon built-in MCP profiles,
 * AIM installs, Amazon-only chat tools and guidance, Harmony, Datanet ETL)
 * are hidden and inactive; their setup and data are kept. Only the owner UI
 * changes it (api/routers/workplace.ts). Detection only pre-fills: it may
 * promote OFF→ON while the value is detected, never demotes, and never runs
 * once the owner has chosen.
 *
 * No imports from mcp-manager (the manager imports this module).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getSetting, setSetting } from './storage.js';

export const WORKPLACE_SETTING_KEY = 'workplace.v1';

export const AMAZON_SIGNALS = [
  'midway_cookie',
  'amazon_toolbox',
  'amazon_connection_used',
  'amazon_capture_used',
  'amazon_owner_email',
  'team_gateway_credentials',
] as const;
export type AmazonSignal = typeof AMAZON_SIGNALS[number];

export interface WorkplaceStatus {
  amazonEmployee: boolean;
  source: 'owner' | 'detected';
  updatedAt: string | null;
  signals: AmazonSignal[];
  version: number;
}

interface StoredWorkplace {
  schema: 1;
  amazonEmployee: boolean;
  source: 'owner' | 'detected';
  updatedAt: string;
  signals: AmazonSignal[];
}

export interface Workplace {
  amazonEmployee(): boolean;
  status(): WorkplaceStatus;
  version(): number;
  setAmazonEmployee(value: boolean): Promise<WorkplaceStatus>;
  onChange(listener: (amazonEmployee: boolean) => void | Promise<void>, label: string): () => void;
}

export interface WorkplaceDeps {
  db: Database.Database;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  now?: () => Date;
  /** Test seam: replaces signal detection. */
  detect?: () => AmazonSignal[];
}

const AMAZON_PROFILE_IDS = ['grasp-m365', 'slack', 'sharepoint', 'a2-analytics'];

/** Cheap, synchronous checks (design §6.2). Never reads work_items or spawns a process. */
export function detectAmazonSignals(input: {
  db: Database.Database;
  env?: Record<string, string | undefined>;
  homeDir?: string;
}): AmazonSignal[] {
  const home = input.homeDir ?? os.homedir();
  const signals: AmazonSignal[] = [];
  if (fs.existsSync(path.join(home, '.midway', 'cookie'))) signals.push('midway_cookie');
  if (fs.existsSync(path.join(home, '.toolbox', 'bin', 'toolbox')) || fs.existsSync(path.join(home, '.toolbox', 'bin', 'aim'))) {
    signals.push('amazon_toolbox');
  }
  const placeholders = AMAZON_PROFILE_IDS.map(() => '?').join(',');
  const used = input.db.prepare(
    `SELECT 1 FROM mcp_servers WHERE id IN (${placeholders}) AND (enabled = 1 OR last_started_at IS NOT NULL OR last_healthy_at IS NOT NULL) LIMIT 1`,
  ).get(...AMAZON_PROFILE_IDS);
  if (used) signals.push('amazon_connection_used');
  const health = getSetting<Record<string, { lastSuccessAt?: string | null } | undefined>>(input.db, 'capture_health.v1');
  if (
    getSetting<unknown>(input.db, 'grasp_sync.mail_active') === true
    || getSetting<unknown>(input.db, 'sharepoint_sync.enabled') === true
    || Boolean(health?.grasp?.lastSuccessAt)
    || Boolean(health?.sharepoint?.lastSuccessAt)
  ) signals.push('amazon_capture_used');
  const ownerEmail = getSetting<unknown>(input.db, 'grasp_sync.owner_email');
  if (typeof ownerEmail === 'string' && ownerEmail.trim().toLowerCase().endsWith('@amazon.com')) signals.push('amazon_owner_email');
  if ((input.env?.BOTBOY_INFERENCE_OAUTH_CLIENT_ID ?? '').trim()) signals.push('team_gateway_credentials');
  return signals;
}

function readStored(db: Database.Database): StoredWorkplace | null {
  let raw: unknown;
  try {
    raw = getSetting<unknown>(db, WORKPLACE_SETTING_KEY);
  } catch {
    raw = undefined;
  }
  if (raw === null || raw === undefined) return null;
  const value = raw as Partial<StoredWorkplace>;
  const valid = typeof raw === 'object'
    && value.schema === 1
    && typeof value.amazonEmployee === 'boolean'
    && (value.source === 'owner' || value.source === 'detected')
    && Array.isArray(value.signals)
    && value.signals.every(signal => (AMAZON_SIGNALS as readonly string[]).includes(signal as string));
  if (!valid) {
    console.warn('[Workplace] ignoring malformed workplace.v1');
    return null;
  }
  return value as StoredWorkplace;
}

const SIGNAL_LABELS: Record<AmazonSignal, string> = {
  midway_cookie: 'midway_cookie',
  amazon_toolbox: 'amazon_toolbox',
  amazon_connection_used: 'amazon_connection_used',
  amazon_capture_used: 'amazon_capture_used',
  amazon_owner_email: 'amazon_owner_email',
  team_gateway_credentials: 'team_gateway_credentials',
};

export function createWorkplace(deps: WorkplaceDeps): Workplace {
  const now = deps.now ?? (() => new Date());
  const stored = readStored(deps.db);
  let amazon = true;
  let source: 'owner' | 'detected';
  let signals: AmazonSignal[] = stored?.signals ?? [];
  let updatedAt: string | null = stored?.updatedAt ?? null;

  if (stored?.source === 'owner') {
    amazon = stored.amazonEmployee;
    source = 'owner';
  } else {
    source = 'detected';
    let detected: AmazonSignal[] | null = null;
    try {
      detected = deps.detect ? deps.detect() : detectAmazonSignals({ db: deps.db, env: deps.env, homeDir: deps.homeDir });
    } catch (error) {
      amazon = stored?.amazonEmployee ?? true;
      console.warn(`[Workplace] detection failed (${error instanceof Error ? error.name : 'error'}); keeping Amazon Employee ${amazon ? 'ON' : 'OFF'}`);
    }
    if (detected) {
      amazon = stored?.amazonEmployee === true || detected.length > 0;
      const changed = !stored
        || stored.amazonEmployee !== amazon
        || JSON.stringify(stored.signals) !== JSON.stringify(detected);
      signals = detected;
      if (changed) {
        updatedAt = now().toISOString();
        setSetting(deps.db, WORKPLACE_SETTING_KEY, { schema: 1, amazonEmployee: amazon, source: 'detected', signals, updatedAt } satisfies StoredWorkplace);
      }
    }
  }
  console.log(source === 'owner'
    ? `✅ Workplace: Amazon Employee ${amazon ? 'ON' : 'OFF'} (set by owner)`
    : `✅ Workplace: Amazon Employee ${amazon ? 'ON' : 'OFF'} (detected${signals.length ? ': ' + signals.map(s => SIGNAL_LABELS[s]).join(', ') : ''})`);

  let version = 0;
  const listeners: Array<{ listener: (value: boolean) => void | Promise<void>; label: string }> = [];
  let queue: Promise<unknown> = Promise.resolve();

  const status = (): WorkplaceStatus => ({ amazonEmployee: amazon, source, updatedAt, signals: [...signals], version });

  async function apply(value: boolean): Promise<WorkplaceStatus> {
    const changed = value !== amazon;
    const at = now().toISOString();
    setSetting(deps.db, WORKPLACE_SETTING_KEY, { schema: 1, amazonEmployee: value, source: 'owner', signals, updatedAt: at } satisfies StoredWorkplace);
    amazon = value;
    source = 'owner';
    updatedAt = at;
    if (changed) {
      version += 1;
      for (const { listener, label } of [...listeners]) {
        try {
          await listener(value);
        } catch (error) {
          console.warn(`[Workplace] ${label} failed: ${error instanceof Error ? error.name : 'error'}`);
        }
      }
    }
    return status();
  }

  return {
    amazonEmployee: () => amazon,
    status,
    version: () => version,
    setAmazonEmployee(value: boolean) {
      const run = queue.then(() => apply(value));
      queue = run.catch(() => undefined);
      return run;
    },
    onChange(listener, label) {
      const entry = { listener, label };
      listeners.push(entry);
      return () => {
        const index = listeners.indexOf(entry);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
}

// ── Shared refusal vocabulary ───────────────────────────────────────

export const AMAZON_EMPLOYEE_OFF_CODE = 'amazon_employee_off';

export class AmazonEmployeeOffError extends Error {
  readonly code = AMAZON_EMPLOYEE_OFF_CODE;
}

export function isAmazonEmployeeOffError(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown } | null | undefined;
  return value?.code === AMAZON_EMPLOYEE_OFF_CODE
    || /\(code: amazon_employee_off\)/.test(String(value?.message ?? error ?? ''));
}

export interface AmazonEmployeeOffToolResult {
  ok: false;
  code: typeof AMAZON_EMPLOYEE_OFF_CODE;
  effect: 'none';
  message: string;
  nextAction: string;
}

export function amazonEmployeeOffToolResult(name: string): AmazonEmployeeOffToolResult {
  return {
    ok: false,
    code: AMAZON_EMPLOYEE_OFF_CODE,
    effect: 'none',
    message: `${name} is part of Amazon internal paths, which are off on this install.`,
    nextAction: 'Do not retry. Tell the owner this needs Amazon Employee turned on in Settings → Workplace, or use another available tool.',
  };
}

// ── Amazon-only chat tools (design §8.1) ─────────────────────────────

export const AMAZON_ONLY_CHAT_TOOLS: ReadonlySet<string> = new Set([
  'publish_static_artifact_to_harmony',
  'get_dashboard_sharing_status',
  'wait_for_etl_run',
  'mcp_etl_generate_presets',
  'mcp_etl_job_run',
  'mcp_etl_latest_run',
  'mcp_etl_runs_for_job',
  'mcp_etl_job',
  'mcp_etl_profile_sql',
  'mcp_etl_search',
  'mcp_etl_run_query',
  'mcp_etl_diagnose_run',
  'mcp_etl_download_results',
  'mcp_etl_submit_run',
  'mcp_etl_alter_run',
  'mcp_etl_force_deps',
  'mcp_etl_create_profile',
  'mcp_etl_update_profile_sql',
  'sharepoint_reply_comment',
  'sharepoint_add_comment',
  'sharepoint_update_document',
  'sharepoint_edit_docx_body',
  'sharepoint_create_document',
  'publish_product_document_to_sharepoint',
  'list_documents',
  'read_document',
  'read_spreadsheet',
]);

/** Set members, plus every future mcp_etl_* / sharepoint_* tool by default. */
export function isAmazonOnlyChatTool(name: string): boolean {
  return AMAZON_ONLY_CHAT_TOOLS.has(name) || name.startsWith('mcp_etl_') || name.startsWith('sharepoint_');
}
