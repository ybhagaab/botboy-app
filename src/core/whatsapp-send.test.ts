import { describe, it, expect } from 'vitest';
import {
  CHAT_STATE_READER, CONTACTS_READER, MAX_SENDS_PER_REQUEST, createWhatsAppSender, phoneDigits, resolveContact,
  titleIsContact, whatsAppSendConfirmed, whatsAppSendUrl, withWhatsAppChatTools, type WhatsAppContact, type WhatsAppPage,
} from './whatsapp-send.js';
import type { ToolExecutor } from './tool-executor.js';

const CONTACTS: WhatsAppContact[] = [
  { name: 'Abb China', number: '8613521379471', pushName: 'Abb' },
  { name: 'Sam Lee', number: '6591234567' },
  { name: 'Sam Lee', number: '6598765432' },
  { name: 'Priya Nair', number: '919800000001' },
];

/**
 * A fake WhatsApp Web tab: navigating to a send address opens that chat with
 * the text in the box; Send adds an outgoing row with a status label.
 */
function fakeWhatsApp(options: {
  titleFor?: (number: string) => string | null;
  boxFor?: (text: string) => string;
  invalid?: boolean;
  statusAfterEnter?: string | null;
  rowAppears?: boolean;
  earlierSameText?: boolean;
  ignoredClicks?: number;
} = {}) {
  const state = { title: null as string | null, box: null as string | null, rows: [] as Array<{ id: string; text: string; status: string | null }>, enters: 0, navigations: [] as string[] };
  const page: WhatsAppPage = {
    async navigate(url) {
      state.navigations.push(url);
      const parsed = new URL(url);
      const number = parsed.searchParams.get('phone')!;
      state.title = options.titleFor ? options.titleFor(number) : CONTACTS.find(c => c.number === number)?.name ?? `+${number}`;
      const text = parsed.searchParams.get('text') ?? '';
      state.box = options.boxFor ? options.boxFor(text) : text;
      if (options.earlierSameText) state.rows.push({ id: 'OLD', text, status: 'Read' });
    },
    async pressSend() {
      state.enters++;
      if (state.enters <= (options.ignoredClicks ?? 0)) return; // a click the fresh chat ignored: text stays
      if (options.rowAppears === false) { state.box = ''; return; }
      state.rows.push({ id: `NEW${state.enters}`, text: state.box ?? '', status: options.statusAfterEnter === undefined ? 'Sent' : options.statusAfterEnter });
      state.box = '';
    },
    async evaluate(expression) {
      if (expression === CONTACTS_READER) return JSON.stringify({ ok: true, contacts: CONTACTS });
      if (expression === CHAT_STATE_READER) return JSON.stringify({ title: state.title, group: false, box: state.box, invalid: Boolean(options.invalid) });
      const want = /const want = ("(?:[^"\\]|\\.)*")/.exec(expression);
      if (want) {
        const text = JSON.parse(want[1]);
        return JSON.stringify(state.rows.filter(row => row.text.replace(/\s+/g, ' ').trim() === text).map(row => ({ id: row.id, status: row.status })));
      }
      return null;
    },
  };
  return { page, state };
}

const fast = { pollMs: 1, openTimeoutMs: 50, confirmTimeoutMs: 50, settleMs: 1, clickWaitMs: 10 };
const ownerTurn = { callerKind: 'interactive' as const, currentUserMessage: 'whatsapp Abb China hi', ownerRequestId: 'req-1' };
const base: ToolExecutor = { async executeTool(call) { return { toolCallId: call.id, content: 'base', isError: false }; } };
const call = (name: string, args: unknown) => ({ id: 'c1', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

describe('contact resolution', () => {
  it('uses a number as given and an exact single name match only', () => {
    expect(phoneDigits('+86 135-2137-9471')).toBe('8613521379471');
    expect(phoneDigits('Abb China')).toBeNull();
    expect(phoneDigits('123')).toBeNull();
    expect(resolveContact('abb  china', CONTACTS)).toEqual({ kind: 'match', contact: CONTACTS[0] });
    expect(resolveContact('+8613521379471', CONTACTS)).toMatchObject({ kind: 'number', saved: true, contact: { name: 'Abb China' } });
    expect(resolveContact('+6580000000', CONTACTS)).toMatchObject({ kind: 'number', saved: false, contact: { name: '+6580000000' } });
    expect(resolveContact('Sam Lee', CONTACTS)).toMatchObject({ kind: 'ambiguous', candidates: [{ number: '6591234567' }, { number: '6598765432' }] });
    expect(resolveContact('Priya', CONTACTS)).toMatchObject({ kind: 'partial', candidates: [{ name: 'Priya Nair' }] });
    expect(resolveContact('Nobody', CONTACTS)).toEqual({ kind: 'none' });
  });

  it('matches the chat title by saved name or by number', () => {
    expect(titleIsContact('Abb China', CONTACTS[0])).toBe(true);
    expect(titleIsContact('+86 135 2137 9471', CONTACTS[0])).toBe(true);
    expect(titleIsContact('Abb', CONTACTS[0])).toBe(false);
  });
});

describe('createWhatsAppSender', () => {
  it('opens the click-to-chat address, checks chat and text, sends once, and reads the status label', async () => {
    const wa = fakeWhatsApp({ statusAfterEnter: 'Delivered' });
    const sender = createWhatsAppSender({ page: async () => wa.page, ...fast });
    const receipt = await sender.send({ contact: CONTACTS[0], text: 'hello\nthere', ownerRequestId: 'r' });
    expect(wa.state.navigations).toEqual([whatsAppSendUrl('8613521379471', 'hello\nthere')]);
    expect(wa.state.enters).toBe(1);
    expect(receipt).toMatchObject({ status: 'sent', to: 'Abb China', number: '8613521379471', messageId: 'NEW1', deliveryStatus: 'Delivered' });
    // The same message in the same request is never sent twice.
    expect(await sender.send({ contact: CONTACTS[0], text: 'hello there', ownerRequestId: 'r' })).toMatchObject({ alreadySent: true });
    expect(wa.state.enters).toBe(1);
  });

  it('presses nothing when the chat or the text does not match, or the number is not on WhatsApp', async () => {
    for (const [options, code] of [
      [{ titleFor: () => 'Someone Else' }, 'chat_mismatch'],
      [{ boxFor: (text: string) => `${text}!` }, 'text_mismatch'],
      [{ invalid: true }, 'not_on_whatsapp'],
    ] as const) {
      const wa = fakeWhatsApp(options);
      const sender = createWhatsAppSender({ page: async () => wa.page, ...fast });
      await expect(sender.send({ contact: CONTACTS[0], text: 'hi', ownerRequestId: 'r' })).rejects.toMatchObject({ code, effect: 'none' });
      expect(wa.state.enters).toBe(0);
    }
  });

  it('reports an unconfirmed send as unknown, never confirms from an older same-text message, and never resends', async () => {
    const wa = fakeWhatsApp({ rowAppears: false, earlierSameText: true });
    const sender = createWhatsAppSender({ page: async () => wa.page, ...fast });
    await expect(sender.send({ contact: CONTACTS[0], text: 'hi', ownerRequestId: 'r' })).rejects.toMatchObject({ code: 'send_unknown_effect', effect: 'unknown' });
    expect(await sender.send({ contact: CONTACTS[0], text: 'hi', ownerRequestId: 'r' })).toMatchObject({ alreadySent: true });
    expect(wa.state.enters).toBe(1);
  });

  it('clicks again only while the exact text is still unsent in the box, at most three times', async () => {
    const once = fakeWhatsApp({ ignoredClicks: 1 });
    const receipt = await createWhatsAppSender({ page: async () => once.page, ...fast }).send({ contact: CONTACTS[0], text: 'hi', ownerRequestId: 'r' });
    expect(receipt).toMatchObject({ messageId: 'NEW2' });
    expect(once.state.enters).toBe(2);
    const never = fakeWhatsApp({ ignoredClicks: 99 });
    await expect(createWhatsAppSender({ page: async () => never.page, ...fast }).send({ contact: CONTACTS[0], text: 'hi', ownerRequestId: 'r' }))
      .rejects.toMatchObject({ code: 'send_unknown_effect', effect: 'unknown' });
    expect(never.state.enters).toBe(3);
  });

  it('caps sends per request and needs an open WhatsApp tab', async () => {
    const wa = fakeWhatsApp();
    const sender = createWhatsAppSender({ page: async () => wa.page, ...fast });
    for (let i = 0; i < MAX_SENDS_PER_REQUEST; i++) await sender.send({ contact: CONTACTS[0], text: `m${i}`, ownerRequestId: 'r' });
    await expect(sender.send({ contact: CONTACTS[0], text: 'one more', ownerRequestId: 'r' })).rejects.toMatchObject({ code: 'send_limit' });
    const closed = createWhatsAppSender({ page: async () => null, ...fast });
    await expect(closed.send({ contact: CONTACTS[0], text: 'hi', ownerRequestId: 'r' })).rejects.toMatchObject({ code: 'not_open', effect: 'none' });
  });
});

describe('withWhatsAppChatTools', () => {
  const tools = () => {
    const wa = fakeWhatsApp();
    return { wa, executor: withWhatsAppChatTools(base, { sender: createWhatsAppSender({ page: async () => wa.page, ...fast }) }) };
  };

  it('sends by exact name in the owner turn and returns a receipt the claim check accepts', async () => {
    const { wa, executor } = tools();
    const result = await executor.executeTool(call('whatsapp_send', { to: 'Abb China', text: 'hi', ownerRequested: true }), ownerTurn);
    expect(JSON.parse(result.content)).toMatchObject({ ok: true, status: 'sent', to: 'Abb China', number: '+8613521379471' });
    expect(whatsAppSendConfirmed('whatsapp_send', result.content)).toBe(true);
    expect(wa.state.enters).toBe(1);
  });

  it('refuses background runs, owner-started tasks, and calls without ownerRequested', async () => {
    const { wa, executor } = tools();
    const send = call('whatsapp_send', { to: 'Abb China', text: 'hi', ownerRequested: true });
    for (const context of [undefined, { callerKind: 'background' as const, currentUserMessage: 'x' }, { ownerStartedRun: true, currentUserMessage: 'x' }]) {
      expect(JSON.parse((await executor.executeTool(send, context as never)).content)).toMatchObject({ code: 'owner_turn_required' });
    }
    expect(JSON.parse((await executor.executeTool(call('whatsapp_send', { to: 'Abb China', text: 'hi' }), ownerTurn)).content)).toMatchObject({ code: 'owner_request_required' });
    expect(JSON.parse((await executor.executeTool(call('whatsapp_send', { to: 'Abb China', text: 'hi', ownerRequested: true }), { ...ownerTurn, ownerRequestId: '' })).content)).toMatchObject({ code: 'owner_request_required' });
    expect(wa.state.enters).toBe(0);
  });

  it('sends nothing for several or partial name matches, and lists them for the owner', async () => {
    const { wa, executor } = tools();
    const several = JSON.parse((await executor.executeTool(call('whatsapp_send', { to: 'Sam Lee', text: 'hi', ownerRequested: true }), ownerTurn)).content);
    expect(several).toMatchObject({ code: 'contact_ambiguous', effect: 'none', candidates: [{ number: '+6591234567' }, { number: '+6598765432' }] });
    const partial = JSON.parse((await executor.executeTool(call('whatsapp_send', { to: 'Priya', text: 'hi', ownerRequested: true }), ownerTurn)).content);
    expect(partial).toMatchObject({ code: 'contact_ambiguous', candidates: [{ name: 'Priya Nair' }] });
    expect(JSON.parse((await executor.executeTool(call('whatsapp_send', { to: 'Nobody', text: 'hi', ownerRequested: true }), ownerTurn)).content)).toMatchObject({ code: 'contact_not_found' });
    expect(wa.state.enters).toBe(0);
  });

  it('finds contacts read-only, also in a task the owner started, and passes other tools through', async () => {
    const { wa, executor } = tools();
    const found = JSON.parse((await executor.executeTool(call('whatsapp_find_contact', { name: 'abb china' }), { ownerStartedRun: true, currentUserMessage: 'x' } as never)).content);
    expect(found).toMatchObject({ ok: true, match: 'exact', contacts: [{ name: 'Abb China', number: '+8613521379471' }] });
    expect(wa.state.navigations).toEqual([]);
    expect((await executor.executeTool(call('query_db', {}), ownerTurn)).content).toBe('base');
  });

  it('lists every argument problem at once', async () => {
    const { executor } = tools();
    const result = JSON.parse((await executor.executeTool(call('whatsapp_send', { to: '', text: '', ownerRequested: true }), ownerTurn)).content);
    expect(result).toMatchObject({ code: 'invalid_arguments', issues: [{ path: 'to' }, { path: 'text' }] });
  });
});
