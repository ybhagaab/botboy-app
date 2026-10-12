import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStorage, getSetting, setSetting, type StorageLayer } from './storage.js';
import {
  AMAZON_ONLY_CHAT_TOOLS,
  AmazonEmployeeOffError,
  amazonEmployeeOffToolResult,
  createWorkplace,
  detectAmazonSignals,
  isAmazonEmployeeOffError,
  isAmazonOnlyChatTool,
  WORKPLACE_SETTING_KEY,
} from './workplace.js';
import { loadEnv as loadSlackEnv } from '../monitors/slack-monitor.js';

/** Settings → Workplace setting, detection, precedence, and writes (design §6, §16 item 1). */
describe('workplace', () => {
  let storage: StorageLayer;
  let home: string;
  const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => {});
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'workplace-home-'));
    quiet();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const db = () => storage.getDb();
  const touch = (relative: string) => {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
  };

  it('detects no signal on a non-Amazon Mac → OFF, persisted as detected', () => {
    const workplace = createWorkplace({ db: db(), env: {}, homeDir: home });
    expect(workplace.amazonEmployee()).toBe(false);
    expect(getSetting<any>(db(), WORKPLACE_SETTING_KEY)).toMatchObject({ schema: 1, amazonEmployee: false, source: 'detected', signals: [] });
  });

  it('turns ON for each signal in isolation', () => {
    const cases: Array<[string, () => Record<string, string>]> = [
      ['midway_cookie', () => { touch('.midway/cookie'); return {}; }],
      ['amazon_toolbox', () => { touch('.toolbox/bin/aim'); return {}; }],
      ['amazon_connection_used', () => { db().prepare("UPDATE mcp_servers SET last_started_at = datetime('now') WHERE id = 'slack'").run(); return {}; }],
      ['amazon_capture_used', () => { setSetting(db(), 'grasp_sync.mail_active', true); return {}; }],
      ['amazon_owner_email', () => { setSetting(db(), 'grasp_sync.owner_email', 'Jane@Amazon.com'); return {}; }],
      ['team_gateway_credentials', () => ({ BOTBOY_INFERENCE_OAUTH_CLIENT_ID: 'client' })],
    ];
    for (const [signal, arrange] of cases) {
      storage.close();
      storage = createStorage(':memory:');
      storage.initialize();
      fs.rmSync(home, { recursive: true, force: true });
      fs.mkdirSync(home, { recursive: true });
      // Seeded built-in rows exist; make sure none counts as used unless arranged.
      db().prepare('UPDATE mcp_servers SET enabled = 0, last_started_at = NULL, last_healthy_at = NULL').run();
      const env = arrange();
      expect(detectAmazonSignals({ db: db(), env, homeDir: home }), signal).toEqual([signal]);
      expect(createWorkplace({ db: db(), env, homeDir: home }).amazonEmployee(), signal).toBe(true);
    }
  });

  it('keeps an owner choice: detection never runs once the owner saved', () => {
    touch('.midway/cookie');
    setSetting(db(), WORKPLACE_SETTING_KEY, { schema: 1, amazonEmployee: false, source: 'owner', updatedAt: '2026-10-01T00:00:00.000Z', signals: [] });
    const detect = vi.fn(() => ['midway_cookie' as const]);
    const workplace = createWorkplace({ db: db(), env: {}, homeDir: home, detect });
    expect(workplace.amazonEmployee()).toBe(false);
    expect(workplace.status().source).toBe('owner');
    expect(detect).not.toHaveBeenCalled();
  });

  it('promotes detected OFF → ON when a signal appears, and never demotes', () => {
    expect(createWorkplace({ db: db(), env: {}, homeDir: home, detect: () => [] }).amazonEmployee()).toBe(false);
    expect(createWorkplace({ db: db(), env: {}, homeDir: home, detect: () => ['midway_cookie'] }).amazonEmployee()).toBe(true);
    const later = createWorkplace({ db: db(), env: {}, homeDir: home, detect: () => [] });
    expect(later.amazonEmployee()).toBe(true);
    expect(getSetting<any>(db(), WORKPLACE_SETTING_KEY).amazonEmployee).toBe(true);
  });

  it('falls back to ON without persisting when detection throws', () => {
    const workplace = createWorkplace({ db: db(), env: {}, homeDir: home, detect: () => { throw new TypeError('boom'); } });
    expect(workplace.amazonEmployee()).toBe(true);
    expect(getSetting(db(), WORKPLACE_SETTING_KEY)).toBeNull();
  });

  it('ignores a malformed setting and detects again', () => {
    setSetting(db(), WORKPLACE_SETTING_KEY, { schema: 2, amazonEmployee: 'yes' });
    const detect = vi.fn(() => ['amazon_toolbox' as const]);
    expect(createWorkplace({ db: db(), env: {}, homeDir: home, detect }).amazonEmployee()).toBe(true);
    expect(detect).toHaveBeenCalledOnce();
    expect(getSetting<any>(db(), WORKPLACE_SETTING_KEY)).toMatchObject({ schema: 1, source: 'detected', signals: ['amazon_toolbox'] });
  });

  it('reads the team gateway credential from the local .env the way index.ts builds inferenceEnv', () => {
    const previousHome = process.env.HOME;
    const previousClient = process.env.BOTBOY_INFERENCE_OAUTH_CLIENT_ID;
    delete process.env.BOTBOY_INFERENCE_OAUTH_CLIENT_ID;
    process.env.HOME = home;
    try {
      fs.mkdirSync(path.join(home, '.personal-productivity-tracker'), { recursive: true });
      fs.writeFileSync(path.join(home, '.personal-productivity-tracker', '.env'), 'BOTBOY_INFERENCE_OAUTH_CLIENT_ID=x\n');
      db().prepare('UPDATE mcp_servers SET enabled = 0, last_started_at = NULL, last_healthy_at = NULL').run();
      const workplace = createWorkplace({ db: db(), env: { ...loadSlackEnv(), ...process.env }, homeDir: home });
      expect(workplace.amazonEmployee()).toBe(true);
      expect(workplace.status().signals).toEqual(['team_gateway_credentials']);
    } finally {
      process.env.HOME = previousHome;
      if (previousClient !== undefined) process.env.BOTBOY_INFERENCE_OAUTH_CLIENT_ID = previousClient;
    }
  });

  it('setAmazonEmployee pins the owner choice, bumps the version, and runs isolated listeners in order', async () => {
    const workplace = createWorkplace({ db: db(), env: {}, homeDir: home, detect: () => [] });
    const order: string[] = [];
    workplace.onChange(() => { order.push('first'); throw new Error('listener down'); }, 'first');
    workplace.onChange(async value => { order.push(`second:${value}`); }, 'second');
    const status = await workplace.setAmazonEmployee(true);
    expect(status).toMatchObject({ amazonEmployee: true, source: 'owner', version: 1 });
    expect(order).toEqual(['first', 'second:true']);
    expect(getSetting<any>(db(), WORKPLACE_SETTING_KEY)).toMatchObject({ amazonEmployee: true, source: 'owner' });
    // The same value again pins it but does not notify.
    await workplace.setAmazonEmployee(true);
    expect(workplace.version()).toBe(1);
    expect(order).toHaveLength(2);
  });

  it('serializes changes: a second change waits for the first change’s listeners', async () => {
    const workplace = createWorkplace({ db: db(), env: {}, homeDir: home, detect: () => ['midway_cookie'] });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const seen: string[] = [];
    workplace.onChange(async value => {
      seen.push(`start:${value}`);
      if (!value) await gate;
      seen.push(`end:${value}`);
    }, 'slow');
    const off = workplace.setAmazonEmployee(false);
    const on = workplace.setAmazonEmployee(true);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(seen).toEqual(['start:false']);
    expect(getSetting<any>(db(), WORKPLACE_SETTING_KEY).amazonEmployee).toBe(false);
    release();
    await Promise.all([off, on]);
    expect(seen).toEqual(['start:false', 'end:false', 'start:true', 'end:true']);
    expect(getSetting<any>(db(), WORKPLACE_SETTING_KEY).amazonEmployee).toBe(true);
  });

  it('a rejected change does not block the queue', async () => {
    const workplace = createWorkplace({ db: db(), env: {}, homeDir: home, detect: () => [] });
    const original = db().prepare.bind(db());
    let failNext = true;
    const spy = vi.spyOn(db(), 'prepare').mockImplementation((sql: string) => {
      if (failNext && sql.includes('INSERT INTO app_settings')) { failNext = false; throw new Error('disk full'); }
      return original(sql);
    });
    await expect(workplace.setAmazonEmployee(true)).rejects.toThrow('disk full');
    await expect(workplace.setAmazonEmployee(true)).resolves.toMatchObject({ amazonEmployee: true });
    spy.mockRestore();
  });

  it('recognizes the off error by code or by its message token', () => {
    expect(isAmazonEmployeeOffError(new AmazonEmployeeOffError('x'))).toBe(true);
    expect(isAmazonEmployeeOffError(new Error('Slack is hidden. Nothing was called. (code: amazon_employee_off)'))).toBe(true);
    expect(isAmazonEmployeeOffError(new Error('Unknown MCP server'))).toBe(false);
    expect(amazonEmployeeOffToolResult('mcp_etl_search')).toMatchObject({ ok: false, code: 'amazon_employee_off', effect: 'none' });
  });

  it('gates future mcp_etl_* and sharepoint_* tools by prefix', () => {
    expect(isAmazonOnlyChatTool('mcp_etl_new_tool')).toBe(true);
    expect(isAmazonOnlyChatTool('sharepoint_future')).toBe(true);
    expect(isAmazonOnlyChatTool('list_documents')).toBe(true);
    expect(isAmazonOnlyChatTool('mcp_analytics_list_context')).toBe(false);
    expect(isAmazonOnlyChatTool('export_footer')).toBe(false);
    expect(AMAZON_ONLY_CHAT_TOOLS.has('publish_static_artifact_to_harmony')).toBe(true);
  });
});
