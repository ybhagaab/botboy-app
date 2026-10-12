import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStorage, getSetting, setSetting, type StorageLayer } from '../core/storage.js';
import { createBrowserEmailCaptureGate, createGraspSync } from './grasp-sync.js';
import { createSharePointSync, SHAREPOINT_SKIP_AMAZON_OFF } from './sharepoint-sync.js';
import { createEtlQueryRunner, createEtlToolCall } from '../core/etl-adhoc.js';
import { McpHiddenByWorkplaceError } from '../core/mcp-manager.js';
import { createAnalyticsScheduler } from '../core/analytics-scheduler.js';
import { createEtlRunWatcher } from '../core/etl-run-watcher.js';
import { createMidwaySentinel } from '../core/midway-sentinel.js';

/** Background gates while Amazon Employee is off (design §7.2, §16 item 12). */
describe('background gates while Amazon Employee is off', () => {
  let storage: StorageLayer;
  let dir: string;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workplace-gates-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const health = () => ({ reportSuccess: vi.fn(), reportFailure: vi.fn() });

  it('GRASP sync skips before any MCP call, health report, or last_run write', async () => {
    const callTool = vi.fn();
    const captureHealth = health();
    const sync = createGraspSync({ db: storage.getDb(), mcpManager: { callTool } as any, emit: () => {}, captureHealth, enabled: () => false });
    const result = await sync.runNow();
    expect(result).toMatchObject({ status: 'skipped', reason: 'amazon_employee_off' });
    expect(callTool).not.toHaveBeenCalled();
    expect(captureHealth.reportFailure).not.toHaveBeenCalled();
    expect(captureHealth.reportSuccess).not.toHaveBeenCalled();
    expect(getSetting(storage.getDb(), 'grasp_sync.last_run')).toBeNull();
  });

  it('the browser email gate follows the toggle without waiting for its 60 s cache', () => {
    setSetting(storage.getDb(), 'grasp_sync.mail_active', true);
    let active = true;
    const gate = createBrowserEmailCaptureGate(storage.getDb(), () => active);
    expect(gate()).toBe(true);
    active = false;
    expect(gate()).toBe(false);
    active = true;
    expect(gate()).toBe(true);
  });

  it('SharePoint discovery skips quietly even when the hidden profile reads as missing', async () => {
    const captureHealth = health();
    const getProfile = vi.fn(async () => null);
    const sync = createSharePointSync({
      db: storage.getDb(), mcpManager: { getProfile, callTool: vi.fn() } as any, emit: () => {}, captureHealth,
      config: { cacheDir: path.join(dir, 'cache'), authJarDir: path.join(dir, 'jars') }, enabled: () => false,
    });
    sync.updateConfig({ enabled: true });
    const result = await sync.runNow();
    expect(result).toMatchObject({ status: 'skipped', reason: SHAREPOINT_SKIP_AMAZON_OFF });
    expect(getProfile).not.toHaveBeenCalled();
    expect(captureHealth.reportFailure).not.toHaveBeenCalled();
    expect(captureHealth.reportSuccess).not.toHaveBeenCalled();
  });

  it('an ETL call on a hidden a2-analytics is a structured failure, and readRun stays status_unavailable', async () => {
    const mcp = { callTool: vi.fn(async () => { throw new McpHiddenByWorkplaceError('Datanet ETL'); }) };
    const call = createEtlToolCall(mcp as any);
    const result = await call('datanet_get_job_run_status', { run_id: '1' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('(code: amazon_employee_off)');
    const runner = createEtlQueryRunner({ db: storage.getDb(), call, downloadDir: dir });
    expect(await runner.readRun!({ runId: '42' })).toMatchObject({ ok: false, code: 'status_unavailable' });
  });

  it('the analytics scheduler never starts the late-ETL pass while off', async () => {
    const processLateEtlResults = vi.fn(async () => 0);
    const analyticsService = {
      recoverInterruptedRuns: () => 0, enqueueChangedBindings: () => 0, processLateEtlResults,
      claimNextRun: () => null, listDueSchedules: () => [],
    } as any;
    const scheduler = createAnalyticsScheduler({ db: storage.getDb(), analyticsService, etlActive: () => false });
    await scheduler.runDueNow().catch(() => 0);
    expect(processLateEtlResults).not.toHaveBeenCalled();
  });

  it('the ETL run watcher and the Midway sentinel tick without any read while off', async () => {
    const jobs = new Proxy({}, { get: () => vi.fn(() => { throw new Error('read'); }) }) as any;
    const readRun = vi.fn();
    const watcher = createEtlRunWatcher({ jobs, readRun, etlAvailable: () => true, onRunsFinished: vi.fn(), enabled: () => false });
    await (watcher as any).tick?.();
    expect(readRun).not.toHaveBeenCalled();
    const mcpManager = new Proxy({}, { get: () => vi.fn(() => { throw new Error('read'); }) }) as any;
    const sentinel = createMidwaySentinel({ db: storage.getDb(), mcpManager, chatTerminal: {} as any, agent: {} as any }, { active: () => false });
    await expect(sentinel.tick()).resolves.toBeUndefined();
  });
});
