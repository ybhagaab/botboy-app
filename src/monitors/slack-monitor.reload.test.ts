import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createStorage, getSetting, setSetting, type StorageLayer } from '../core/storage.js';
import { setChannelConfig } from '../core/slack-config.js';

const tokensSeen: string[] = [];
const historyTokens: string[] = [];
vi.mock('@slack/socket-mode', () => ({ SocketModeClient: vi.fn() }));
vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function (this: any, token: string) {
    tokensSeen.push(token);
    this.auth = { test: async () => ({ ok: true, user_id: 'U1', user: 'owner', team: 'Acme' }) };
    this.conversations = {
      history: async () => { historyTokens.push(token); return { ok: true, messages: [] }; },
      replies: async () => ({ ok: true, messages: [] }),
      info: async () => ({ ok: true, channel: { id: 'C1', name: 'general' } }),
    };
    this.users = {
      conversations: async () => ({ ok: true, channels: [], response_metadata: {} }),
      info: async () => ({ ok: true, user: { id: 'U1', name: 'owner', profile: {} } }),
    };
  }),
}));
import { createSlackMonitor, type ReloadableSlackMonitor } from './slack-monitor.js';

describe('Slack monitor hot token reload', () => {
  let storage: StorageLayer;
  let home: string;
  let previousHome: string | undefined;
  let monitor: ReloadableSlackMonitor | null = null;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-reload-'));
    process.env.HOME = home;
    delete process.env.SLACK_USER_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    tokensSeen.length = 0;
    historyTokens.length = 0;
    storage = createStorage(':memory:');
    storage.initialize();
    setChannelConfig(storage.getDb(), ['C1']);
    setSetting(storage.getDb(), 'slack.poll.cursor.C1', '1759000000.000000');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    monitor?.stop();
    storage.close();
    vi.restoreAllMocks();
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('starts disabled without a token, then captures with a new token without a restart', async () => {
    monitor = createSlackMonitor({ db: storage.getDb() });
    await monitor.start();
    expect(monitor.hasUserToken()).toBe(false);
    expect(monitor.getCaptureMode?.()).toBe('disabled');
    const items: unknown[] = [];
    monitor.onWorkItem(item => items.push(item));

    const result = await monitor.reloadUserToken('xoxp-new-token-1');
    expect(result.captureMode).toBe('poll');
    expect(monitor.hasUserToken()).toBe(true);
    expect(tokensSeen).toContain('xoxp-new-token-1');
    expect(historyTokens).toContain('xoxp-new-token-1');
    expect(monitor.getUserWebClient()).toBeDefined();
    // Cursors live in settings and are untouched by the reload.
    expect(getSetting(storage.getDb(), 'slack.poll.cursor.C1')).toBe('1759000000.000000');

    historyTokens.length = 0;
    await monitor.reloadUserToken('xoxp-second-token-2');
    expect(historyTokens.every(token => token === 'xoxp-second-token-2')).toBe(true);
    expect(historyTokens.length).toBeGreaterThan(0);
  });
});
