import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  REPLY_PREFIX, WHATSAPP_CHAT_STATE_KEY, createWhatsAppChatBridge, replyChunks, requestText, toWhatsAppText, welcomeMessage,
} from './whatsapp-chat.js';
import type { WhatsAppPage, WhatsAppSender } from './whatsapp-send.js';

function setup(messages: Array<{ id: string; t: number; body: string }>, options: { turnActive?: boolean; db?: Database.Database } = {}) {
  const db = options.db ?? new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  const sent: Array<{ to: string; text: string }> = [];
  const turns: string[] = [];
  const modes: string[] = [];
  const page: WhatsAppPage = {
    async evaluate(expression) {
      const since = Number(/m\.t >= (\d+)/.exec(expression)?.[1] ?? 0);
      return JSON.stringify({ ok: true, number: '6580000001', selfName: 'Me Owner', messages: messages.filter(m => m.t >= since) });
    },
    async navigate() {},
    async pressSend() {},
  };
  const sender = {
    async contacts() { return []; },
    async self() { return null; },
    async send(input: { contact: { name: string }; text: string }) { sent.push({ to: input.contact.name, text: input.text }); return {} as never; },
  } as unknown as WhatsAppSender;
  const bridge = createWhatsAppChatBridge({
    db, page: async () => page, sender,
    isTurnActive: () => Boolean(options.turnActive),
    runTurn: async (message, _id, mode) => { turns.push(message); modes.push(mode); return '**Two** things today.'; },
    now: () => 1_000_000_000_000,
    log: () => {},
  });
  return { db, bridge, sent, turns, modes };
}

describe('WhatsApp chat bridge', () => {
  it('answers only requests written after it first ran, one at a time, each once, and replies with the prefix', async () => {
    const { db, bridge, sent, turns, modes } = setup([
      { id: 'OLD', t: 999_999_000, body: '@botboy old request' },
      { id: 'A', t: 1_000_000_010, body: '@botboy what is on today?' },
      { id: 'B', t: 1_000_000_020, body: 'Hi @BotBoy: summarise Fatafat' },
    ]);
    await bridge.tick();
    await bridge.tick();
    await bridge.tick();
    expect(turns.map(turn => turn.split('\n')[0])).toEqual(['what is on today?', 'Hi summarise Fatafat']);
    // The mode comes from the owner's words, never from BotBoy's WhatsApp note.
    expect(modes).toEqual(['general', 'general']);
    expect(sent).toEqual([
      { to: 'Me Owner', text: `${REPLY_PREFIX}${welcomeMessage(true)}` },
      { to: 'Me Owner', text: `${REPLY_PREFIX}*Two* things today.` },
      { to: 'Me Owner', text: `${REPLY_PREFIX}*Two* things today.` },
    ]);
    const state = JSON.parse((db.prepare('SELECT value FROM app_settings WHERE key = ?').get(WHATSAPP_CHAT_STATE_KEY) as { value: string }).value);
    expect(state.handled).toEqual(['A', 'B']);
  });

  it('uses dashboard mode only when the owner asks for analytics', async () => {
    const { bridge, modes } = setup([{ id: 'A', t: 1_000_000_010, body: '@botboy build a dashboard of weekly OTT streams' }]);
    await bridge.tick();
    expect(modes).toEqual(['analytics_dashboard']);
  });

  it('waits while another chat turn runs', async () => {
    const { bridge, turns } = setup([{ id: 'A', t: 1_000_000_010, body: '@botboy hi' }], { turnActive: true });
    await bridge.tick();
    expect(turns).toEqual([]);
  });

  it('sends the how-to message once per BotBoy chat, and never runs it as a request', async () => {
    const { db, bridge, sent, turns } = setup([]);
    await bridge.tick();
    await bridge.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].text.startsWith(REPLY_PREFIX)).toBe(true);
    expect(sent[0].text).toContain('@botboy what needs my attention today?');
    expect(turns).toEqual([]);
    const state = JSON.parse((db.prepare('SELECT value FROM app_settings WHERE key = ?').get(WHATSAPP_CHAT_STATE_KEY) as { value: string }).value);
    expect(state.welcomed).toBe('6580000001');
    // A restart keeps the record: no second message.
    const again = setup([], { db });
    await again.bridge.tick();
    expect(again.sent).toHaveLength(0);
  });
  it('an install that already answered requests gets no how-to message', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, 'x')").run(WHATSAPP_CHAT_STATE_KEY, JSON.stringify({ since: 1_000_000_000, handled: ['OLD'] }));
    const { bridge, sent } = setup([], { db });
    await bridge.tick();
    expect(sent).toHaveLength(0);
  });
  it('formats and splits replies for WhatsApp', () => {
    expect(requestText('@botboy, show the dashboard')).toBe('show the dashboard');
    expect(toWhatsAppText('## Today\n**Bold** and [doc](https://x.com/a) [[gmail-draft:abc]]')).toBe('*Today*\n*Bold* and doc (https://x.com/a)');
    const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'x'.repeat(400)}`).join('\n\n');
    const chunks = replyChunks(long, 3500, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks.every(chunk => chunk.length <= 3600)).toBe(true);
    expect(chunks[1]).toContain('full answer is in BotBoy');
  });
});
