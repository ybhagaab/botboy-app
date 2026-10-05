import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createStorage, setSetting, type StorageLayer } from '../core/storage.js';
import { setChannelConfig } from '../core/slack-config.js';

// Poll mode runs over the managed Slack MCP only; the token clients are
// mocked so no real Slack connection can be made.
vi.mock('@slack/socket-mode', () => ({ SocketModeClient: vi.fn() }));
vi.mock('@slack/web-api', () => ({ WebClient: vi.fn() }));

import { createSlackMonitor, type SlackMonitor } from './slack-monitor.js';

const MIDWAY_401 = 'Request to IDP URL https://midway-auth.amazon.com/SSO/redirect?client_id=a&state=b did not redirect. Status code: 401. You may need to authenticate by running mwinit.';

type HistoryReply = (channelId: string) => unknown;

describe('Slack poll cycle failure handling', () => {
  let storage: StorageLayer;
  let home: string;
  let previousHome: string | undefined;
  let monitor: SlackMonitor | null;
  let historyCalls: string[];
  let historyReply: HistoryReply;
  let restarts: string[];
  let reports: Array<{ kind: 'success' } | { kind: 'failure'; failureKind: string; reason: string }>;

  const okHistory: HistoryReply = channelId => [{ channelId, result: { ok: true, messages: [] } }];

  const mcpManager = () => ({
    async getServer() { return { state: 'running' } as any; },
    async restart(id: string) { restarts.push(id); return { id } as any; },
    async callTool(_server: string, tool: string, args: any) {
      if (tool === 'list_channels') {
        return { text: JSON.stringify({ ok: true, ims: [{ id: 'D1' }, { id: 'D2' }, { id: 'D3' }] }), isError: false };
      }
      if (tool === 'batch_get_conversation_history') {
        const channelId = String(args.channels[0].channelId);
        historyCalls.push(channelId);
        return { text: JSON.stringify(historyReply(channelId)), isError: false };
      }
      return { text: '[]', isError: false };
    },
  }) as any;

  const captureHealth = {
    reportSuccess: () => { reports.push({ kind: 'success' }); },
    reportFailure: (_source: string, failure: { kind: string; reason: string }) => {
      reports.push({ kind: 'failure', failureKind: failure.kind, reason: failure.reason });
    },
  };

  /** Let the interval's async cycle finish (real microtasks, faked clocks). */
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-02T08:08:15Z'));
    previousHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-poll-home-'));
    process.env.HOME = home; // no developer ~/.personal-productivity-tracker/.env tokens
    delete process.env.SLACK_USER_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    storage = createStorage(':memory:');
    storage.initialize();
    const db = storage.getDb();
    setChannelConfig(db, ['C1']);
    for (const id of ['C1', 'D1', 'D2', 'D3']) setSetting(db, `slack.poll.cursor.${id}`, '1759000000.000000');
    historyCalls = [];
    historyReply = okHistory;
    restarts = [];
    reports = [];
    monitor = null;
  });

  afterEach(() => {
    monitor?.stop();
    storage.close();
    vi.useRealTimers();
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('stops the cycle at the first Midway failure, reports its cause, and backs off', async () => {
    historyReply = channelId => [{ channelId, error: MIDWAY_401 }];
    monitor = createSlackMonitor({ db: storage.getDb(), mcpManager: mcpManager(), captureHealth });
    await monitor.start();

    // One attempt stands for every conversation (was: one per conversation).
    expect(historyCalls).toEqual(['C1']);
    expect(reports).toEqual([{ kind: 'failure', failureKind: 'midway_auth', reason: expect.stringContaining('mwinit') }]);
    expect((reports[0] as any).reason).not.toContain('state=b');

    await vi.advanceTimersByTimeAsync(90_000); // 1st retry at the normal cadence
    await settle();
    expect(historyCalls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(90_000); // inside the doubled backoff: skipped
    await settle();
    expect(historyCalls).toHaveLength(2);

    historyReply = okHistory; // the owner ran mwinit
    await vi.advanceTimersByTimeAsync(90_000);
    await settle();
    expect(historyCalls.length).toBeGreaterThan(2);
    expect(reports.at(-1)).toEqual({ kind: 'success' });
    // Midway expiry is the sentinel's to fix; the monitor restarts nothing.
    expect(restarts).toEqual([]);
  });

  it('skips a conversation it cannot read and still polls the rest', async () => {
    historyReply = channelId => (channelId === 'C1'
      ? [{ channelId, result: { ok: false, error: 'channel_not_found' } }]
      : [{ channelId, result: { ok: true, messages: [] } }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    monitor = createSlackMonitor({ db: storage.getDb(), mcpManager: mcpManager(), captureHealth });
    await monitor.start();
    expect(historyCalls).toEqual(['C1', 'D1', 'D2', 'D3']);
    expect(reports).toEqual([{ kind: 'success' }]);

    await vi.advanceTimersByTimeAsync(90_000);
    await settle();
    // The broken conversation is retried but logged once, not every cycle.
    const conversationWarnings = warn.mock.calls.filter(call => String(call[0]).includes('poll failed for C1'));
    expect(conversationWarnings).toHaveLength(1);
    warn.mockRestore();
  });

  it('reports an outage when every conversation fails, even with unclassified errors', async () => {
    historyReply = channelId => [{ channelId, error: 'something odd happened' }];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    monitor = createSlackMonitor({ db: storage.getDb(), mcpManager: mcpManager(), captureHealth });
    await monitor.start();
    expect(historyCalls).toEqual(['C1', 'D1', 'D2', 'D3']);
    expect(reports).toEqual([{ kind: 'failure', failureKind: 'unknown', reason: expect.stringContaining('something odd') }]);
  });

  it('restarts the Slack connection once after repeated sign-in rejections', async () => {
    historyReply = channelId => [{ channelId, result: { ok: false, error: 'invalid_auth' } }];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    monitor = createSlackMonitor({ db: storage.getDb(), mcpManager: mcpManager(), captureHealth });
    await monitor.start();
    expect(restarts).toEqual([]);

    await vi.advanceTimersByTimeAsync(90_000);
    await settle();
    expect(restarts).toEqual(['slack']);

    // Further failures inside the heal interval do not restart again.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle();
    expect(restarts).toEqual(['slack']);
    expect(reports.every(report => report.kind === 'failure' && report.failureKind === 'service_auth')).toBe(true);
  });
});
