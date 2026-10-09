/**
 * WhatsApp in chat: whatsapp_find_contact and whatsapp_send, driven through
 * the owner's own signed-in WhatsApp Web tab in BotBoy's debug Chrome
 * (live-tested 2026-10-09, docs/maps/whatsapp-send.md).
 *
 * Identity (code, not prompt):
 *   - Both tools run only in the owner's live chat turn; whatsapp_find_contact
 *     also in a task the owner started. BotBoy's unattended runs are refused.
 *   - whatsapp_send also needs the server's owner request id and
 *     `ownerRequested: true`, at most MAX_SENDS_PER_REQUEST sends per request,
 *     and the same text to the same number once per request.
 *   - Direct chats only: a group has no phone number, so it is refused.
 * Knowledge: contacts come from WhatsApp Web's own local store (IndexedDB
 * `model-storage` › `contact`), read without clicking anything. Only an exact
 * name match is used; partial matches come back as candidates for the owner.
 * Execution: load WhatsApp's click-to-chat address in the existing tab, check
 * the open chat is the resolved contact and the text box holds exactly the
 * text, click WhatsApp's Send button, then read the message's own status label (Pending, Sent,
 * Delivered, Read). After the click the effect is never "none": an unconfirmed
 * send is `unknown` and is never retried.
 */

import WebSocket from 'ws';
import type { ToolCall } from './llm-client.js';
import type { ToolExecutionContext, ToolExecutor, ToolResult } from './tool-executor.js';

export const WHATSAPP_CHAT_TOOL_NAMES = ['whatsapp_find_contact', 'whatsapp_send'] as const;
const WHATSAPP_TOOLS = new Set<string>(WHATSAPP_CHAT_TOOL_NAMES);

export const MAX_SENDS_PER_REQUEST = 5;
export const MAX_TEXT_CHARS = 4_000;
/** Send clicks per message; repeated only while the text is provably still unsent. */
export const SEND_CLICKS = 3;
const MAX_CANDIDATES = 10;

/** One page operation surface, so the flow is testable without Chrome. */
export interface WhatsAppPage {
  evaluate(expression: string): Promise<unknown>;
  navigate(url: string): Promise<void>;
  /** Clicks WhatsApp's Send button. Throws before any click when there is none. */
  pressSend(): Promise<void>;
}

export interface WhatsAppContact {
  name: string;
  number: string;
  pushName?: string;
}

export type WhatsAppSendCode =
  | 'owner_turn_required'
  | 'owner_request_required'
  | 'invalid_arguments'
  | 'not_open'
  | 'contact_not_found'
  | 'contact_ambiguous'
  | 'not_on_whatsapp'
  | 'chat_mismatch'
  | 'text_mismatch'
  | 'send_limit'
  | 'send_unknown_effect'
  | 'busy'
  | 'stopped';

export class WhatsAppSendError extends Error {
  constructor(
    readonly code: WhatsAppSendCode,
    message: string,
    readonly effect: 'none' | 'unknown',
    readonly nextAction: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Digits of a phone number with its country code, or null (7–15 digits, E.164). */
export function phoneDigits(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

/** Name comparison: case, accents, and spacing do not matter. */
export function normalizeName(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Text comparison for the compose box: WhatsApp renders line breaks and spaces its own way. */
export function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The click-to-chat address that opens the chat with the text typed in. */
export function whatsAppSendUrl(number: string, text: string): string {
  return `https://web.whatsapp.com/send?phone=${number}&text=${encodeURIComponent(text)}`;
}

/** Reads every saved contact with a phone number from WhatsApp Web's own store. */
export const CONTACTS_READER = `(async () => {
  const open = () => new Promise((res, rej) => { const r = indexedDB.open('model-storage'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const db = await open();
  try {
    if (![...db.objectStoreNames].includes('contact')) return JSON.stringify({ ok: false });
    const rows = await new Promise((res) => { const q = db.transaction('contact').objectStore('contact').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); });
    const out = [];
    for (const c of rows) {
      const jid = [c.phoneNumber, c.id].find(v => typeof v === 'string' && /^\\d{7,15}@(c\\.us|s\\.whatsapp\\.net)$/.test(v));
      const name = c.name || c.shortName || '';
      if (!jid || !name) continue;
      out.push({ name: String(name), number: jid.split('@')[0], pushName: c.pushname ? String(c.pushname) : undefined });
    }
    return JSON.stringify({ ok: true, contacts: out });
  } finally { db.close(); }
})()`;

/** The open chat's title, the compose box text, and WhatsApp's "invalid number" notice. */
export const CHAT_STATE_READER = `JSON.stringify({
  title: document.querySelector('[data-testid="conversation-info-header-chat-title"]')?.innerText || null,
  group: Boolean(document.querySelector('#main [data-testid="group-chat-profile-picture"]')),
  box: document.querySelector('footer [contenteditable="true"]')?.innerText ?? null,
  invalid: /phone number shared via url is invalid/i.test(document.body ? document.body.innerText : '')
})`;

/** Every recent outgoing message holding `text`: its id and status label. */
export function sentMessageReader(text: string): string {
  return `JSON.stringify((() => {
    const want = ${JSON.stringify(normalizeText(text))};
    const norm = s => String(s || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
    const rows = [...document.querySelectorAll('#main [role="row"]')].slice(-40);
    const out = [];
    for (const row of rows) {
      // Outgoing: the author label reads "You:" (a follow-up bubble has no tail icon).
      const labels = [...row.querySelectorAll('[aria-label]')].map(e => norm(e.getAttribute('aria-label')));
      if (labels[0] !== 'You:' && !row.querySelector('[data-icon="tail-out"], .message-out')) continue;
      const body = row.querySelector('[data-testid="selectable-text"], .selectable-text');
      if (!body || norm(body.innerText) !== want) continue;
      out.push({ id: row.querySelector('[data-id]')?.getAttribute('data-id') || null, status: labels.find(l => /^(pending|sent|delivered|read)$/i.test(l)) || null });
    }
    return out;
  })())`;
}

/** The centre of WhatsApp's enabled Send button, in page coordinates, or null. */
export const SEND_BUTTON_LOCATOR = `(() => {
  const button = document.querySelector('footer button[aria-label="Send"]') || document.querySelector('footer [data-icon="wds-ic-send-filled"], footer [data-icon="send"]')?.closest('button,[role="button"]');
  if (!button || button.disabled) return 'null';
  const r = button.getBoundingClientRect();
  return r.width && r.height ? JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }) : 'null';
})()`;

export type ContactLookup =
  | { kind: 'number'; contact: WhatsAppContact; saved: boolean }
  | { kind: 'match'; contact: WhatsAppContact }
  | { kind: 'ambiguous'; candidates: WhatsAppContact[] }
  | { kind: 'partial'; candidates: WhatsAppContact[] }
  | { kind: 'none' };

/**
 * Resolves who `to` means. A phone number is used as given. A name must match
 * one saved contact exactly (one number); several numbers under that name, or
 * only partial matches, go back to the owner.
 */
export function resolveContact(to: string, contacts: readonly WhatsAppContact[]): ContactLookup {
  const digits = phoneDigits(to);
  if (digits) {
    const saved = contacts.find(contact => contact.number === digits);
    return { kind: 'number', contact: saved ?? { name: `+${digits}`, number: digits }, saved: Boolean(saved) };
  }
  const wanted = normalizeName(to);
  if (!wanted) return { kind: 'none' };
  const unique = (list: WhatsAppContact[]) => [...new Map(list.map(contact => [contact.number, contact])).values()];
  const exact = unique(contacts.filter(contact => normalizeName(contact.name) === wanted));
  if (exact.length === 1) return { kind: 'match', contact: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact.slice(0, MAX_CANDIDATES) };
  const partial = unique(contacts.filter(contact =>
    normalizeName(contact.name).includes(wanted) || (contact.pushName && normalizeName(contact.pushName) === wanted)));
  return partial.length ? { kind: 'partial', candidates: partial.slice(0, MAX_CANDIDATES) } : { kind: 'none' };
}

/** True when the open chat's title is this contact (its saved name, or its number when unsaved). */
export function titleIsContact(title: string, contact: WhatsAppContact): boolean {
  if (normalizeName(title) === normalizeName(contact.name)) return true;
  return title.replace(/\D/g, '') === contact.number;
}

export interface WhatsAppSendReceipt {
  status: 'sent';
  to: string;
  number: string;
  text: string;
  messageId: string | null;
  deliveryStatus: string | null;
  alreadySent?: boolean;
}

export interface WhatsAppSender {
  contacts(): Promise<WhatsAppContact[]>;
  send(input: { contact: WhatsAppContact; text: string; ownerRequestId: string; signal?: AbortSignal }): Promise<WhatsAppSendReceipt>;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

export function createWhatsAppSender(deps: {
  /** The owner's WhatsApp Web tab, or null when it is not open. */
  page: () => Promise<WhatsAppPage | null>;
  pollMs?: number;
  openTimeoutMs?: number;
  confirmTimeoutMs?: number;
  settleMs?: number;
  clickWaitMs?: number;
}): WhatsAppSender {
  const pollMs = deps.pollMs ?? 500;
  const openTimeoutMs = deps.openTimeoutMs ?? 30_000;
  const confirmTimeoutMs = deps.confirmTimeoutMs ?? 20_000;
  const settleMs = deps.settleMs ?? 1_500;
  const clickWaitMs = deps.clickWaitMs ?? 4_000;
  const sent = new Map<string, Map<string, WhatsAppSendReceipt>>();
  let busy = false;

  async function requirePage(): Promise<WhatsAppPage> {
    const page = await deps.page();
    if (!page) {
      throw new WhatsAppSendError('not_open', 'WhatsApp Web is not open in BotBoy’s Chrome.', 'none',
        'Tell the owner to open web.whatsapp.com in BotBoy’s Chrome window and sign in, then ask again.');
    }
    return page;
  }

  return {
    async contacts() {
      const page = await requirePage();
      const parsed = parseJson<{ ok: boolean; contacts?: WhatsAppContact[] }>(await page.evaluate(CONTACTS_READER).catch(() => null));
      if (!parsed?.ok) {
        throw new WhatsAppSendError('not_open', 'WhatsApp Web’s contact list could not be read.', 'none',
          'WhatsApp may still be loading or signed out. Ask the owner for the phone number with its country code instead.');
      }
      return parsed.contacts ?? [];
    },

    async send({ contact, text, ownerRequestId, signal }) {
      const perRequest = sent.get(ownerRequestId) ?? new Map<string, WhatsAppSendReceipt>();
      const key = `${contact.number}\u0000${normalizeText(text)}`;
      const earlier = perRequest.get(key);
      if (earlier) return { ...earlier, alreadySent: true };
      if (perRequest.size >= MAX_SENDS_PER_REQUEST) {
        throw new WhatsAppSendError('send_limit', `At most ${MAX_SENDS_PER_REQUEST} WhatsApp messages per request.`, 'none',
          'Stop sending. Tell the owner what was sent, and ask them to send the rest in a new message.');
      }
      if (busy) throw new WhatsAppSendError('busy', 'Another WhatsApp message is being sent.', 'none', 'Wait for that send’s result, then send this one.');
      busy = true;
      try {
        const page = await requirePage();
        if (signal?.aborted) throw new WhatsAppSendError('stopped', 'The owner stopped this turn before the send.', 'none', 'Stop; nothing was sent.');
        await page.navigate(whatsAppSendUrl(contact.number, text));
        type ChatState = { title: string | null; group: boolean; box: string | null; invalid: boolean };
        let state: ChatState | null = null;
        const openBy = Date.now() + openTimeoutMs;
        while (Date.now() < openBy) {
          await sleep(pollMs);
          state = parseJson<ChatState>(await page.evaluate(CHAT_STATE_READER).catch(() => null));
          if (state?.invalid) break;
          if (state?.title && state.box !== null && normalizeText(state.box) === normalizeText(text)) break;
        }
        if (state?.invalid) {
          throw new WhatsAppSendError('not_on_whatsapp', `+${contact.number} is not on WhatsApp.`, 'none',
            'Tell the owner this number is not on WhatsApp and ask for the right one.');
        }
        if (!state?.title || !titleIsContact(state.title, contact) || state.group) {
          throw new WhatsAppSendError('chat_mismatch', `WhatsApp opened "${state?.title ?? 'no chat'}", not ${contact.name}; nothing was sent.`, 'none',
            'Tell the owner the chat did not match and nothing was sent. Do not retry with another contact.', { openedChat: state?.title ?? null });
        }
        if (state.box === null || normalizeText(state.box) !== normalizeText(text)) {
          throw new WhatsAppSendError('text_mismatch', 'The message box did not hold exactly the message; nothing was sent.', 'none',
            'Tell the owner nothing was sent. Text may hold characters WhatsApp changes; try once with plain text, or ask the owner to send it.');
        }
        if (signal?.aborted) throw new WhatsAppSendError('stopped', 'The owner stopped this turn before the send.', 'none', 'Stop; nothing was sent. The text is typed in WhatsApp’s box.');
        type Sent = { id: string | null; status: string | null };
        // The same text sent earlier is not this send's confirmation.
        const before = new Set((parseJson<Sent[]>(await page.evaluate(sentMessageReader(text)).catch(() => null)) ?? []).map(entry => entry.id));
        // A freshly opened chat ignores an early click (live 2026-10-09):
        // let it settle, then click. While the box still holds the exact text
        // and no new message exists, nothing went out (WhatsApp empties the
        // box on send), so the click is repeated, at most SEND_CLICKS times.
        await sleep(settleMs);
        const newRows = async () => (parseJson<Sent[]>(await page.evaluate(sentMessageReader(text)).catch(() => null)) ?? [])
          .filter(entry => entry.id && !before.has(entry.id));
        let seen: Sent | null = null;
        for (let click = 0; click < SEND_CLICKS && !seen; click++) {
          if (click > 0) {
            const now = parseJson<ChatState>(await page.evaluate(CHAT_STATE_READER).catch(() => null));
            if (!now || now.box === null || normalizeText(now.box) !== normalizeText(text) || !now.title || !titleIsContact(now.title, contact)) break;
          }
          try {
            await page.pressSend();
          } catch (error) {
            if (error instanceof WhatsAppSendError && click === 0) throw error;
            break;
          }
          // From here the message may be out: never "none" again.
          const clickBy = Date.now() + clickWaitMs;
          while (Date.now() < clickBy) {
            await sleep(pollMs);
            seen = (await newRows()).at(-1) ?? null;
            if (seen) break;
          }
        }
        const confirmBy = Date.now() + confirmTimeoutMs;
        while (seen && Date.now() < confirmBy && !(seen.status && !/^pending$/i.test(seen.status))) {
          await sleep(pollMs);
          seen = (await newRows()).at(-1) ?? seen;
        }
        const receipt: WhatsAppSendReceipt = {
          status: 'sent',
          to: contact.name,
          number: contact.number,
          text,
          messageId: seen?.id ?? null,
          deliveryStatus: seen?.status ?? null,
        };
        // Recorded before the check: a message that may be out is never sent twice.
        perRequest.set(key, receipt);
        sent.set(ownerRequestId, perRequest);
        if (sent.size > 200) sent.delete(sent.keys().next().value as string);
        if (!seen) {
          throw new WhatsAppSendError('send_unknown_effect', 'BotBoy pressed Send, but the message did not appear in the chat.', 'unknown',
            'Do NOT send again. Tell the owner to check the chat in WhatsApp.');
        }
        return receipt;
      } finally {
        busy = false;
      }
    },
  };
}

/** The owner's WhatsApp Web tab in the debug Chrome, as a page surface over CDP. */
export function cdpWhatsAppPage(cdpEndpoint = 'http://127.0.0.1:9222'): () => Promise<WhatsAppPage | null> {
  return async () => {
    let tabs: Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
    try {
      const response = await fetch(`${cdpEndpoint}/json/list`, { signal: AbortSignal.timeout(3000) });
      tabs = await response.json() as typeof tabs;
    } catch {
      return null;
    }
    const tab = tabs.find(entry => entry.type === 'page' && entry.url.startsWith('https://web.whatsapp.com/') && entry.webSocketDebuggerUrl);
    if (!tab?.webSocketDebuggerUrl) return null;
    const wsUrl = tab.webSocketDebuggerUrl;
    const command = (method: string, params: Record<string, unknown>, timeout = 15_000) => new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => { ws.close(); reject(new Error('CDP timeout')); }, timeout);
      ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
      ws.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString());
        if (message.id !== 1) return;
        clearTimeout(timer);
        ws.close();
        if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      });
      ws.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
    return {
      async evaluate(expression) {
        const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        return result?.result?.value;
      },
      async navigate(url) {
        await command('Page.navigate', { url });
      },
      async pressSend() {
        // One CDP session: find WhatsApp's own Send button and click it with
        // a real mouse event. A synthesized Enter key was ignored live
        // (2026-10-09: the text stayed in the box); the button click sends.
        const ws = new WebSocket(wsUrl);
        await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
        let next = 0;
        const send = (method: string, params: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
          const id = ++next;
          const timer = setTimeout(() => reject(new Error('CDP timeout')), 10_000);
          const onMessage = (data: Buffer) => {
            const message = JSON.parse(data.toString());
            if (message.id !== id) return;
            clearTimeout(timer);
            ws.off('message', onMessage);
            if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
          };
          ws.on('message', onMessage);
          ws.send(JSON.stringify({ id, method, params }));
        });
        try {
          const found = await send('Runtime.evaluate', { returnByValue: true, expression: SEND_BUTTON_LOCATOR });
          const point = JSON.parse(String(found?.result?.value ?? 'null')) as { x: number; y: number } | null;
          if (!point) {
            throw new WhatsAppSendError('text_mismatch', 'WhatsApp showed no Send button; nothing was sent.', 'none',
              'Tell the owner nothing was sent and ask them to check WhatsApp Web is open on that chat.');
          }
          for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
            await send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
          }
        } finally {
          ws.close();
        }
      },
    };
  };
}

function toolResult(call: ToolCall, content: unknown, isError = false): ToolResult {
  return { toolCallId: call.id, content: JSON.stringify(content, null, 1), isError };
}

function failed(call: ToolCall, error: WhatsAppSendError, issues?: Array<{ path: string; message: string }>): ToolResult {
  return toolResult(call, {
    ok: false,
    tool: call.function.name,
    status: 'failed',
    code: error.code,
    message: error.message,
    effect: error.effect,
    ...(issues?.length ? { issues } : {}),
    nextAction: error.nextAction,
    ...error.detail,
  }, true);
}

function lookupFailure(to: string, lookup: ContactLookup): WhatsAppSendError | null {
  const listed = (candidates: WhatsAppContact[]) => candidates.map(candidate => ({ name: candidate.name, number: `+${candidate.number}` }));
  switch (lookup.kind) {
    case 'ambiguous':
      return new WhatsAppSendError('contact_ambiguous', `Several WhatsApp contacts are named "${to}".`, 'none',
        'Ask the owner which one (show the names and numbers), then call again with that number as to.', { candidates: listed(lookup.candidates) });
    case 'partial':
      return new WhatsAppSendError('contact_ambiguous', `No WhatsApp contact is named exactly "${to}".`, 'none',
        'Ask the owner whether they mean one of these (names and numbers); call again with the confirmed number as to. Never pick one yourself.', { candidates: listed(lookup.candidates) });
    case 'none':
      return new WhatsAppSendError('contact_not_found', `No WhatsApp contact matches "${to}".`, 'none',
        'Ask the owner for the phone number with its country code (for example +65 9123 4567), then call again with it as to.');
    default:
      return null;
  }
}

/**
 * Adds whatsapp_find_contact and whatsapp_send to a tool executor. The sender
 * owns the page work; this layer owns authority and arguments.
 */
export function withWhatsAppChatTools(base: ToolExecutor, deps: { sender?: WhatsAppSender }): ToolExecutor {
  function authority(name: string, args: Record<string, unknown>, context?: ToolExecutionContext): WhatsAppSendError | null {
    const hasOwnerMessage = Boolean(context?.currentUserMessage?.trim());
    const liveTurn = context?.callerKind === 'interactive' && hasOwnerMessage;
    const ownerRun = context?.ownerStartedRun === true && hasOwnerMessage;
    if (!liveTurn && !(name === 'whatsapp_find_contact' && ownerRun)) {
      return new WhatsAppSendError('owner_turn_required', 'WhatsApp messages are sent only from the owner’s chat.', 'none',
        'Do not use WhatsApp from this task. Tell the owner to ask in chat.');
    }
    if (name === 'whatsapp_send' && (!context?.ownerRequestId?.trim() || args.ownerRequested !== true)) {
      return new WhatsAppSendError('owner_request_required', 'ownerRequested must be true: send only when the owner’s current message asks to send this WhatsApp message.', 'none',
        'If the owner asked to send it, call again with ownerRequested=true. If they did not, show them the recipient and text in your reply and ask.');
    }
    return null;
  }

  return {
    async executeTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
      const name = call.function.name;
      if (!WHATSAPP_TOOLS.has(name)) return base.executeTool(call, context);
      let args: Record<string, unknown>;
      try {
        const parsed = JSON.parse(call.function.arguments || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        args = parsed;
      } catch {
        return failed(call, new WhatsAppSendError('invalid_arguments', 'Tool arguments must be one JSON object.', 'none', 'Call again with a JSON object of arguments.'));
      }
      const denied = authority(name, args, context);
      if (denied) return failed(call, denied);
      const sender = deps.sender;
      if (!sender) return failed(call, new WhatsAppSendError('not_open', 'WhatsApp is unavailable in this BotBoy build.', 'none', 'Tell the owner WhatsApp sending is unavailable.'));

      const issues: Array<{ path: string; message: string }> = [];
      const target = typeof (name === 'whatsapp_send' ? args.to : args.name) === 'string'
        ? String(name === 'whatsapp_send' ? args.to : args.name).trim() : '';
      if (!target || target.length > 120) issues.push({ path: name === 'whatsapp_send' ? 'to' : 'name', message: 'required: a saved contact name or a phone number with country code (≤120 characters)' });
      const text = typeof args.text === 'string' ? args.text : '';
      if (name === 'whatsapp_send') {
        if (!text.trim()) issues.push({ path: 'text', message: 'required: the message to send' });
        if (text.length > MAX_TEXT_CHARS) issues.push({ path: 'text', message: `at most ${MAX_TEXT_CHARS} characters` });
      }
      if (issues.length) return failed(call, new WhatsAppSendError('invalid_arguments', 'The arguments are invalid.', 'none', 'Fix every listed issue, then call once more.'), issues);

      try {
        // A phone number needs no contact list (an unsaved number still sends).
        const contacts = phoneDigits(target) ? await sender.contacts().catch(() => []) : await sender.contacts();
        const lookup = resolveContact(target, contacts);
        if (name === 'whatsapp_find_contact') {
          const found = lookup.kind === 'match' || lookup.kind === 'number' ? [lookup.contact]
            : lookup.kind === 'ambiguous' || lookup.kind === 'partial' ? lookup.candidates : [];
          return toolResult(call, {
            ok: true,
            query: target,
            match: lookup.kind === 'match' ? 'exact' : lookup.kind === 'ambiguous' ? 'several_exact' : lookup.kind === 'partial' ? 'partial_only' : lookup.kind === 'number' ? 'number' : 'none',
            contacts: found.map(contact => ({ name: contact.name, number: `+${contact.number}` })),
            note: 'Contacts from the owner’s WhatsApp. Only an exact single match may be sent to by name; otherwise confirm the number with the owner.',
          });
        }
        const problem = lookupFailure(target, lookup);
        if (problem) return failed(call, problem);
        const contact = (lookup as { contact: WhatsAppContact }).contact;
        const receipt = await sender.send({ contact, text, ownerRequestId: context!.ownerRequestId!, signal: context?.abortSignal });
        return toolResult(call, {
          ok: true,
          ...receipt,
          number: `+${receipt.number}`,
          next: receipt.alreadySent
            ? 'This exact message already went to this contact in this request; nothing new was sent. Report the earlier send.'
            : `Sent on WhatsApp to ${receipt.to} (+${receipt.number})${receipt.deliveryStatus ? `; WhatsApp shows it as ${receipt.deliveryStatus}` : ''}. Tell the owner, quoting the message.`,
        });
      } catch (error) {
        if (error instanceof WhatsAppSendError) return failed(call, error);
        return failed(call, new WhatsAppSendError('send_unknown_effect', `WhatsApp send failed: ${(error as Error).message}`.slice(0, 300), 'unknown',
          'Do NOT send again. Tell the owner to check the chat in WhatsApp.'));
      }
    },
  };
}

/** A WhatsApp send backed by its receipt (for the chat router's claim check). */
export function whatsAppSendConfirmed(toolName: string, content: unknown): boolean {
  if (toolName !== 'whatsapp_send' || typeof content !== 'string') return false;
  try {
    const parsed = JSON.parse(content);
    return parsed?.ok === true && parsed?.status === 'sent';
  } catch {
    return false;
  }
}
