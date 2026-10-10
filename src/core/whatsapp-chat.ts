/**
 * Talk to BotBoy on WhatsApp (docs/maps/whatsapp-chat.md).
 *
 * Owner job: from the phone, write "@botboy …" in the owner's own
 * "Message yourself" chat; BotBoy runs it as an ordinary chat turn on the
 * laptop and answers in that chat.
 *
 * Identity: the owner's self-chat is the channel and the owner's word is the
 * authority (owner decision 2026-10-09: no extra guards). Only the owner's own
 * messages in their own self-chat that mention @botboy start a turn.
 * Knowledge: WhatsApp Web's in-memory message list (`WAWebCollections` › Msg)
 * holds the decrypted text of loaded chats; reading it opens no chat, so no
 * read receipt changes. The IndexedDB message store keeps text encrypted.
 * Execution: one message at a time, recorded as handled BEFORE its turn runs
 * (a crash never runs a request twice); the reply goes back through the
 * verified whatsapp-send flow, prefixed so BotBoy never answers itself.
 */

import type Database from 'better-sqlite3';
import type { WhatsAppPage, WhatsAppSender } from './whatsapp-send.js';
import { resolveConversationMode } from './analytics-chat-context.js';

export const WHATSAPP_CHAT_STATE_KEY = 'whatsapp_chat.v1';
/* The BotBoy chat (own chat or another number) and on/off live in whatsapp-connection.ts. */
export const BOTBOY_TRIGGER = /(^|\s)@botboy\b/i;
/** Every BotBoy reply starts with this, so a reply is never read as a request. */
export const REPLY_PREFIX = '🤖 ';
export const REPLY_CHUNK_CHARS = 3_500;
export const MAX_REPLY_CHUNKS = 4;
const HANDLED_KEEP = 500;

/**
 * The owner's own requests in their self-chat since `since` (unix seconds):
 * the owner's phone and laptop ids, the self-chat title, and each new
 * "@botboy" text message the owner wrote.
 */
export function selfInboxReader(since: number, chatNumber: string | null = null): string {
  return `(() => {
    try {
      const C = window.require('WAWebCollections');
      const me = window.require('WAWebUserPrefsMeUser');
      const pn = me.getMaybeMePnUser && me.getMaybeMePnUser();
      const lid = me.getMaybeMeLidUser && me.getMaybeMeLidUser();
      const want = ${JSON.stringify(chatNumber)};
      // The BotBoy chat: the owner's own chat, or the chat of the chosen number.
      const ids = want
        ? C.Chat.getModelsArray().filter(c => !c.isGroup && c.id && (c.id.user === want || (c.contact && c.contact.phoneNumber && c.contact.phoneNumber.user === want))).map(c => c.id._serialized).concat([want + '@c.us'])
        : [pn && pn._serialized, lid && lid._serialized].filter(Boolean);
      if (!ids.length || !pn) return JSON.stringify({ ok: false });
      const chat = C.Chat.getModelsArray().find(c => ids.includes(c.id && c.id._serialized));
      const out = [];
      for (const m of C.Msg.getModelsArray()) {
        const remote = m.id && m.id.remote && m.id.remote._serialized;
        if (!ids.includes(remote) || !m.id.fromMe || m.type !== 'chat') continue;
        if (!(m.t >= ${Math.floor(since)})) continue;
        const body = String(m.body || '');
        if (!/(^|\\s)@botboy\\b/i.test(body) || body.startsWith(${JSON.stringify(REPLY_PREFIX)})) continue;
        out.push({ id: m.id.id, t: m.t, body: body.slice(0, 8000) });
      }
      out.sort((a, b) => a.t - b.t);
      return JSON.stringify({
        ok: true,
        number: want || String(pn.user),
        self: !want,
        selfName: chat ? String(chat.name || chat.formattedTitle || '') : '',
        messages: out,
      });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e).slice(0, 200) });
    }
  })()`;
}

export interface SelfInbox {
  ok: boolean;
  self?: boolean;
  number?: string | null;
  selfName?: string;
  messages?: Array<{ id: string; t: number; body: string }>;
}

interface ChatState {
  since: number;
  handled: string[];
  /** The BotBoy chat (number) that got the how-to message; once per chat. */
  welcomed?: string;
}

function readState(db: Database.Database): ChatState | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(WHATSAPP_CHAT_STATE_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (typeof parsed?.since !== 'number' || !Array.isArray(parsed.handled)) return null;
    return { since: parsed.since, handled: parsed.handled, ...(typeof parsed.welcomed === 'string' ? { welcomed: parsed.welcomed } : {}) };
  } catch {
    return null;
  }
}

function writeState(db: Database.Database, state: ChatState): void {
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(WHATSAPP_CHAT_STATE_KEY, JSON.stringify({ since: state.since, handled: state.handled.slice(-HANDLED_KEEP), ...(state.welcomed ? { welcomed: state.welcomed } : {}) }));
}

/** The request without its @botboy mention. */
export function requestText(body: string): string {
  return body.replace(/(^|\s)@botboy\b[:,]?/gi, ' ').replace(/[ \t]+/g, ' ').trim();
}

/** Chat markdown → WhatsApp formatting (bold, headings, links, code fences). */
export function toWhatsAppText(markdown: string): string {
  return markdown
    .replace(/```[a-z]*\n?/gi, '```')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/__([^_\n]+)__/g, '*$1*')
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)')
    .replace(/\[\[[a-z-]+:[^\]]+\]\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Splits a reply into WhatsApp-sized messages at paragraph, then line, breaks. */
export function replyChunks(text: string, size = REPLY_CHUNK_CHARS, max = MAX_REPLY_CHUNKS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest && chunks.length < max) {
    if (rest.length <= size) { chunks.push(rest); rest = ''; break; }
    let cut = rest.lastIndexOf('\n\n', size);
    if (cut < size / 2) cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = rest.lastIndexOf(' ', size);
    if (cut < size / 2) cut = size;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks[chunks.length - 1] += '\n\n… (the full answer is in BotBoy’s chat on the laptop)';
  return chunks;
}

/**
 * Sent once to the BotBoy chat when WhatsApp is first connected (or the
 * BotBoy chat changes), so the owner knows how to use it from the phone.
 * It carries REPLY_PREFIX, so the reader never treats it as a request.
 */
export function welcomeMessage(self: boolean): string {
  const where = self ? 'this chat (your own "Message yourself" chat)' : 'this chat';
  return [
    'BotBoy is connected to WhatsApp.',
    '',
    `To ask BotBoy something from your phone, write a message in ${where} that starts with @botboy, for example:`,
    '@botboy what needs my attention today?',
    '@botboy send me the latest version of my CV',
    '',
    'BotBoy replies here, in this chat. It can use everything it can use on your laptop: your projects, files, email, and the browser.',
    'Messages without @botboy are ignored.',
    'BotBoy reads WhatsApp only while your laptop is on and WhatsApp Web is open in BotBoy\u2019s Chrome window.',
  ].join('\n');
}
/** What the model is told about a turn that came from WhatsApp. */
export function whatsAppTurnMessage(request: string): string {
  return `${request}\n\n[Sent from WhatsApp on the owner's phone. Your final reply is sent back to them on WhatsApp automatically: keep it short and readable on a phone, no tables. BotBoy pages on the laptop cannot be opened from the phone, so put the answer itself in the reply. To share a screenshot (ui_screenshot of the BotBoy route), an exported document, or another file, call whatsapp_send with to: "me", ownerRequested: true, and attachments, then say in your reply what you sent. A SharePoint link can go in the reply itself. This is a live owner turn, exactly like the laptop chat: every tool is available, including browser_hands click, type, select, and key on the tabs you opened, run_command, and files. Keep working the job; the phone only changes where your reply goes.]`;
}

export interface WhatsAppChatBridge {
  start(): void;
  stop(): void;
  /** One check for new requests (exposed for tests). */
  tick(): Promise<void>;
}

export function createWhatsAppChatBridge(deps: {
  db: Database.Database;
  page: () => Promise<WhatsAppPage | null>;
  sender: WhatsAppSender;
  /**
   * Runs one owner chat turn and resolves with the final reply text. `mode`
   * is decided from the owner's words alone: BotBoy's WhatsApp note must not
   * steer the turn into dashboard mode (live 2026-10-09).
   */
  runTurn: (message: string, requestId: string, mode: 'general' | 'analytics_dashboard') => Promise<string>;
  /** Connections → WhatsApp: off means no requests are read; chatNumber picks the BotBoy chat. */
  settings?: () => { enabled: boolean; chatNumber: string | null };
  /** True while any chat turn runs; the WhatsApp request waits its turn. */
  isTurnActive?: () => boolean;
  intervalMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}): WhatsAppChatBridge {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let welcomeRetryAt = 0;

  async function reply(inbox: SelfInbox, text: string, requestId: string): Promise<void> {
    if (!inbox.number) return;
    const contact = { name: inbox.selfName || `+${inbox.number}`, number: inbox.number, self: inbox.self !== false };
    const chunks = replyChunks(toWhatsAppText(text) || 'Done.');
    for (const [index, chunk] of chunks.entries()) {
      await deps.sender.send({ contact, text: `${REPLY_PREFIX}${chunk}`, ownerRequestId: `${requestId}:reply:${index}` });
    }
  }

  async function tick(): Promise<void> {
    const settings = deps.settings?.() ?? { enabled: true, chatNumber: null };
    if (!settings.enabled || running || deps.isTurnActive?.()) return;
    running = true;
    try {
      const page = await deps.page();
      if (!page) return;
      let state = readState(deps.db);
      if (!state) {
        // First run: only requests written from now on are answered.
        state = { since: Math.floor(now() / 1000), handled: [] };
        writeState(deps.db, state);
      }
      let inbox: SelfInbox | null = null;
      try {
        inbox = JSON.parse(String(await page.evaluate(selfInboxReader(state.since - 5, settings.chatNumber)) ?? 'null'));
      } catch {
        inbox = null;
      }
      if (inbox?.ok && inbox.number && state.welcomed !== inbox.number && now() >= welcomeRetryAt) {
        // An install that already answered requests knows how: mark it, no message.
        if (state.handled.length > 0 && state.welcomed === undefined) {
          state.welcomed = inbox.number;
          writeState(deps.db, state);
        } else {
          try {
            await reply(inbox, welcomeMessage(inbox.self !== false), `wa-welcome-${inbox.number}`);
            state.welcomed = inbox.number;
            writeState(deps.db, state);
            log('💬 WhatsApp: sent the how-to message to the BotBoy chat');
          } catch (error) {
            welcomeRetryAt = now() + 10 * 60_000;
            log(`⚠ WhatsApp how-to message failed (retrying in 10 min): ${(error as Error).message}`);
          }
        }
      }
      if (!inbox?.ok || !inbox.messages?.length) return;
      const next = inbox.messages.find(message => !state!.handled.includes(message.id));
      if (!next) return;
      // Recorded before the turn: a crash or restart never runs a request twice.
      state.handled.push(next.id);
      state.since = Math.max(state.since, next.t);
      writeState(deps.db, state);
      const request = requestText(next.body);
      const requestId = `wa-${next.id}`;
      log(`💬 WhatsApp request: ${request.slice(0, 80)}`);
      let answer: string;
      try {
        answer = request ? await deps.runTurn(whatsAppTurnMessage(request), requestId, resolveConversationMode({ message: request }).mode) : 'Hi! Write your request after @botboy.';
      } catch (error) {
        answer = `BotBoy could not finish that: ${(error as Error).message}`.slice(0, 500);
      }
      try {
        await reply(inbox, answer, requestId);
      } catch (error) {
        log(`⚠️ WhatsApp reply failed: ${(error as Error).message}`);
      }
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch(error => log(`⚠️ WhatsApp chat: ${(error as Error).message}`)); }, deps.intervalMs ?? 5_000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
