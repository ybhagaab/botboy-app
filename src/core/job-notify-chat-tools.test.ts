import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createChatJobStore, type ChatJobStore } from './chat-jobs.js';
import {
  JOB_NOTIFY_CHAT_TOOL_NAMES, JOB_NOTIFY_GUIDANCE_BLOCK, asksForJobNotification, jobNotifyArmed, withJobNotifyChatTools,
} from './job-notify-chat-tools.js';
import { JOB_SCOPE_TOOLS, withJobMandate } from './job-mandate.js';
import { WhatsAppSendError, type WhatsAppSender } from './whatsapp-send.js';
import type { WhatsAppConnection, WhatsAppStatus } from './whatsapp-connection.js';
import type { ToolExecutionContext, ToolExecutor } from './tool-executor.js';

/**
 * job_notify (docs/maps/job-notify.md). The incident (2026-10-19): in a live turn BotBoy promised a WhatsApp report "if it pauses, needs
 * your input or stops", then ran the job in automatic turns that have no WhatsApp tool and had to say so. The tool's job is to make that
 * promise keepable: it records the request, proves a message can reach the phone, and is itself unreachable from an automatic turn.
 */
const call = (args: Record<string, unknown> | string, name = 'job_notify') => ({
  id: 'c1', type: 'function' as const, function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});
const owner = (over: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  callerKind: 'interactive', currentUserMessage: 'start work on this & if it pauses or stops, send me a report on whatsapp', ownerRequestId: 'req-1', ...over,
});
const parse = (result: { content: string }) => JSON.parse(result.content);

describe('job_notify', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
  });
  afterEach(() => storage.close());

  function build(over: { session?: WhatsAppStatus['session']; sendBehaviour?: () => void; chatNumber?: string | null } = {}) {
    const sends: Array<{ contact: { name: string; number: string }; text: string; ownerRequestId: string }> = [];
    const sender = {
      async contacts() { return []; },
      async self() { return { name: 'Me (You)', number: '6580000001', self: true }; },
      async send(input: any) { over.sendBehaviour?.(); sends.push(input); return {} as never; },
    } as unknown as WhatsAppSender;
    const openWindow = vi.fn(async () => true);
    const connection = {
      settings: () => ({ enabled: false, chatNumber: over.chatNumber ?? null }),
      status: async () => ({ chrome: true, tabOpen: true, session: over.session ?? 'signed_in', me: { number: '6580000001', name: 'Me' }, enabled: false, chat: { number: '6580000001', name: 'Me (You)', self: true } }),
      openWindow,
      update: vi.fn(),
    } as unknown as WhatsAppConnection;
    const base: ToolExecutor = { executeTool: vi.fn(async (c) => ({ toolCallId: c.id, content: 'base', isError: false })) };
    const nudge = vi.fn();
    const exec = withJobNotifyChatTools(base, { jobs, sender, connection, notifier: { nudge } });
    return { exec, sends, base, nudge, openWindow };
  }

  it('passes every other tool through to the base executor', async () => {
    const { exec, base } = build();
    await exec.executeTool(call({}, 'query_db'), owner());
    expect(base.executeTool).toHaveBeenCalledTimes(1);
  });

  it('is offered by name only as job_notify', () => {
    expect([...JOB_NOTIFY_CHAT_TOOL_NAMES]).toEqual(['job_notify']);
  });

  describe('authority (the incident)', () => {
    it('an AUTOMATIC continuation turn cannot arm, disarm or read updates', async () => {
      const job = jobs.start({ goal: 'g' });
      const { exec, sends } = build();
      for (const action of ['on', 'off', 'status']) {
        const result = await exec.executeTool(call({ action }), { callerKind: 'continuation', jobMandate: { jobId: job.id, goal: 'g' }, currentUserMessage: 'g' });
        expect(result.isError).toBe(true);
        expect(parse(result)).toMatchObject({ ok: false, code: 'owner_turn_required', effect: 'none' });
      }
      expect(sends).toEqual([]);
      expect(jobs.get(job.id)!.notify).toBeUndefined();
    });

    it('a background caller and a turn with no owner message are refused too', async () => {
      jobs.start({ goal: 'g' });
      const { exec } = build();
      expect(parse(await exec.executeTool(call({ action: 'on' }), { callerKind: 'background', currentUserMessage: 'x' })).code).toBe('owner_turn_required');
      expect(parse(await exec.executeTool(call({ action: 'on' }), owner({ currentUserMessage: '  ' }))).code).toBe('owner_turn_required');
      expect(parse(await exec.executeTool(call({ action: 'on' }), undefined)).code).toBe('owner_turn_required');
    });

    it('the job mandate keeps it (and every WhatsApp tool) out of a continuation before it even runs', async () => {
      const job = jobs.start({ goal: 'g' });
      expect(JOB_SCOPE_TOOLS.has('job_notify')).toBe(false);
      const { exec, base } = build();
      const guarded = withJobMandate(exec, { jobs });
      const refused = await guarded.executeTool(call({ action: 'on' }), { callerKind: 'continuation', jobMandate: { jobId: job.id, goal: 'g' }, currentUserMessage: 'g' });
      expect(parse(refused)).toMatchObject({ status: 'blocked', code: 'outside_job_mandate' });
      expect(base.executeTool).not.toHaveBeenCalled();
    });
  });

  describe('on', () => {
    it('sends ONE confirmation to the owner\'s BotBoy chat first, and arms the job only after it went', async () => {
      const job = jobs.start({ goal: 'Study how customers reach the home screen' });
      const { exec, sends, nudge } = build();
      const result = await exec.executeTool(call({ action: 'on' }), owner());
      expect(result.isError).toBe(false);
      expect(parse(result)).toMatchObject({ ok: true, notify: 'on', job: { id: job.id }, destination: 'your own WhatsApp chat' });
      expect(sends).toHaveLength(1);
      expect(sends[0].contact.number).toBe('6580000001');
      expect(sends[0].text.startsWith('🤖 ')).toBe(true);
      expect(sends[0].text).toContain('Study how customers reach the home screen');
      expect(jobs.get(job.id)!.notify).toMatchObject({ channel: 'whatsapp', sent: [] });
      expect(nudge).toHaveBeenCalled();
      expect(jobNotifyArmed('job_notify', result.content)).toBe(true);
    });

    it('with no job yet, starts one from the owner\'s message (like job_update continue)', async () => {
      const { exec } = build();
      expect(jobs.activeJob()).toBeNull();
      const result = parse(await exec.executeTool(call({ action: 'on' }), owner({ currentUserMessage: 'research X, and WhatsApp me when it is done' })));
      expect(result.ok).toBe(true);
      expect(jobs.activeJob()).toMatchObject({ goal: 'research X, and WhatsApp me when it is done' });
      expect(jobs.activeJob()!.notify).toBeDefined();
    });

    it('does NOT arm, and says so, when WhatsApp Web is not signed in (the promise cannot be kept)', async () => {
      const job = jobs.start({ goal: 'g' });
      const { exec, sends } = build({ session: 'qr' });
      const result = await exec.executeTool(call({ action: 'on' }), owner());
      expect(result.isError).toBe(true);
      const body = parse(result);
      expect(body).toMatchObject({ ok: false, code: 'whatsapp_not_ready', effect: 'none' });
      expect(body.message).toContain('Updates were NOT turned on');
      expect(body.nextAction).toContain('Do not say updates are on');
      // The owner is told the real next step (scan the QR code), not a vague "could not find the chat".
      expect(body.message).toContain('is not signed in');
      expect(body.nextAction).toContain('Linked devices');
      expect(body.whatsapp).toMatchObject({ session: 'qr' });
      expect(sends).toEqual([]);
      expect(jobs.get(job.id)!.notify).toBeUndefined();
      expect(jobNotifyArmed('job_notify', result.content)).toBe(false);
    });

    it('does NOT arm when the confirmation provably went nowhere', async () => {
      const job = jobs.start({ goal: 'g' });
      const { exec } = build({ sendBehaviour: () => { throw new WhatsAppSendError('chat_mismatch', 'WhatsApp opened another chat; nothing was sent.', 'none', 'Tell the owner nothing was sent.'); } });
      const body = parse(await exec.executeTool(call({ action: 'on' }), owner()));
      expect(body).toMatchObject({ ok: false, code: 'chat_mismatch', effect: 'none' });
      expect(body.message).toContain('Updates were NOT turned on');
      expect(jobs.get(job.id)!.notify).toBeUndefined();
    });

    it('does NOT arm when the confirmation\'s effect is unknown, and tells the owner to look at their phone', async () => {
      const job = jobs.start({ goal: 'g' });
      const { exec } = build({ sendBehaviour: () => { throw new WhatsAppSendError('send_unknown_effect', 'did not confirm', 'unknown', 'x'); } });
      const body = parse(await exec.executeTool(call({ action: 'on' }), owner()));
      expect(body).toMatchObject({ ok: false, code: 'confirmation_unknown', effect: 'unknown' });
      expect(body.nextAction).toContain('look in the BotBoy chat on their phone');
      expect(jobs.get(job.id)!.notify).toBeUndefined();
    });

    it('turning it on twice sends one confirmation, and a repeat call in the same request returns the same answer', async () => {
      jobs.start({ goal: 'g' });
      const { exec, sends } = build();
      const first = await exec.executeTool(call({ action: 'on' }), owner());
      const repeat = await exec.executeTool(call({ action: 'on' }), owner());
      expect(repeat).toEqual(first);
      const later = parse(await exec.executeTool(call({ action: 'on' }), owner({ ownerRequestId: 'req-2' })));
      expect(later).toMatchObject({ ok: true, already: true });
      expect(sends).toHaveLength(1);
    });

    it('the destination is never an argument: any extra field is refused with nothing sent', async () => {
      jobs.start({ goal: 'g' });
      const { exec, sends } = build();
      for (const args of [{ action: 'on', to: '+6599999999' }, { action: 'on', number: '1', text: 'hi' }, { action: 'sendnow' }, { action: 'on', chat: 'x' }]) {
        const body = parse(await exec.executeTool(call(args), owner()));
        expect(body).toMatchObject({ ok: false, code: 'invalid_arguments' });
      }
      expect(parse(await exec.executeTool(call('not json'), owner())).code).toBe('invalid_arguments');
      expect(parse(await exec.executeTool(call('[]'), owner())).code).toBe('invalid_arguments');
      expect(sends).toEqual([]);
    });

    it('goes to the chosen BotBoy chat number when the owner picked another one', async () => {
      jobs.start({ goal: 'g' });
      const { exec, sends } = build({ chatNumber: '6591234567' });
      const body = parse(await exec.executeTool(call({ action: 'on' }), owner()));
      expect(body).toMatchObject({ ok: true, destination: '+6591234567' });
      expect(sends[0].contact.number).toBe('6591234567');
    });

    it('an ended job cannot be armed', async () => {
      const job = jobs.start({ goal: 'g' });
      const { exec } = build({ sendBehaviour: () => { jobs.end(job.id, 'done', 'finished meanwhile'); } });
      const body = parse(await exec.executeTool(call({ action: 'on' }), owner()));
      expect(body).toMatchObject({ ok: false, code: 'job_not_active' });
    });
  });

  describe('off and status', () => {
    it('off forgets the request; status reports it either way, and neither sends a message', async () => {
      const job = jobs.start({ goal: 'g' });
      jobs.setNotify(job.id, true);
      const { exec, sends } = build();
      expect(parse(await exec.executeTool(call({ action: 'status' }), owner()))).toMatchObject({ ok: true, notify: 'on' });
      expect(parse(await exec.executeTool(call({ action: 'off' }), owner()))).toMatchObject({ ok: true, notify: 'off' });
      expect(jobs.get(job.id)!.notify).toBeUndefined();
      expect(parse(await exec.executeTool(call({ action: 'status' }), owner({ ownerRequestId: 'req-3' })))).toMatchObject({ ok: true, notify: 'off' });
      expect(sends).toEqual([]);
    });

    it('with no active job they say so without an error', async () => {
      const { exec } = build();
      expect(parse(await exec.executeTool(call({ action: 'off' }), owner()))).toMatchObject({ ok: true, notify: 'off', job: null });
      expect(parse(await exec.executeTool(call({ action: 'status' }), owner({ ownerRequestId: 'req-4' }))).job).toBeNull();
    });
  });

  describe('when the tool is offered', () => {
    it('on the owner\'s real request, and on similar asks', () => {
      for (const message of [
        'start work on this & if it pauses, or any question or stops, send me report on whatsapp please.',
        'ping me on WhatsApp when the job is done',
        'notify me on whatsapp if it gets stuck',
        'text me when it finishes',
        'send me a report when it pauses',
        'let me know on WhatsApp when you need my input',
        'update me if it fails',
      ]) {
        expect(asksForJobNotification(message), message).toBe(true);
      }
    });

    it('not on ordinary work, nor on a WhatsApp message with no job event', () => {
      for (const message of [
        'what needs my attention today?',
        'message Priya on WhatsApp that I am late',
        'summarise the OTT dashboard',
        'build a dashboard of weekly streams',
        'check next week after 19th Monday',
      ]) {
        expect(asksForJobNotification(message), message).toBe(false);
      }
    });

    it('once updates are on, a message that asks to stop them offers the tool again', () => {
      const armed = { notify: { channel: 'whatsapp' as const, armedAt: 'x', sent: [] } };
      expect(asksForJobNotification('stop sending me whatsapp updates', armed)).toBe(true);
      expect(asksForJobNotification('turn off the notifications', armed)).toBe(true);
      expect(asksForJobNotification('turn off the notifications', null)).toBe(false);
      expect(asksForJobNotification('summarise the OTT dashboard', armed)).toBe(false);
    });

    it('the guidance names the tool, the confirm-first rule, and that automatic turns do not send', () => {
      expect(JOB_NOTIFY_GUIDANCE_BLOCK).toContain('job_notify');
      expect(JOB_NOTIFY_GUIDANCE_BLOCK).toMatch(/INSTEAD of promising it yourself/);
      expect(JOB_NOTIFY_GUIDANCE_BLOCK).toMatch(/only if that message reached/);
      expect(JOB_NOTIFY_GUIDANCE_BLOCK).toMatch(/Do not call whatsapp_send for this/);
    });
  });
});
