import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createChatJobStore, type ChatJobStore } from './chat-jobs.js';
import {
  JOB_NOTIFY_MAX_ATTEMPTS, JOB_NOTIFY_MAX_PER_HOUR, JOB_NOTIFY_MESSAGE_CHARS, JOB_NOTIFY_PAUSE_GRACE_MS, JOB_NOTIFY_REPORT_WAIT_MS,
  confirmationMessage, createJobNotifier, dueEvents, messageFor, resolveDestination,
} from './job-notifier.js';
import { REPLY_PREFIX } from './whatsapp-chat.js';
import { WhatsAppSendError, type WhatsAppSender } from './whatsapp-send.js';

/**
 * WhatsApp updates for a job (docs/maps/job-notify.md). The incident (2026-10-19): the owner asked, in a live turn, to be told on WhatsApp
 * if a job paused, asked a question or stopped. The model promised it; the job then ran in automatic turns that have no WhatsApp tool, and
 * its last turn said "this automatic turn has no WhatsApp sending tool". These tests pin the repair: the server sends, from job state alone.
 */
describe('job notifier', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  let clock: number;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
    clock = Date.parse('2026-10-19T02:00:00.000Z');
  });
  afterEach(() => storage.close());

  const iso = (ms = clock) => new Date(ms).toISOString();
  /** An armed job that paused `ago` ms before the clock. */
  function pausedJob(ago: number, note = 'Which cohort should I use?') {
    const job = jobs.start({ goal: 'Study how customers reach the home screen' });
    jobs.setNotify(job.id, true);
    jobs.settle(job.id, { action: 'pause', note }, 'answered');
    const db = storage.getDb();
    db.prepare('UPDATE chat_jobs SET paused_at = ? WHERE id = ?').run(iso(clock - ago), job.id);
    return jobs.get(job.id)!;
  }

  describe('dueEvents (derived from job state alone)', () => {
    it('is empty for a job the owner never asked to be told about', () => {
      const job = jobs.start({ goal: 'g' });
      jobs.settle(job.id, { action: 'pause', note: 'q' }, 'answered');
      storage.getDb().prepare('UPDATE chat_jobs SET paused_at = ? WHERE id = ?').run(iso(clock - 600_000), job.id);
      expect(dueEvents(jobs.get(job.id)!, clock)).toEqual([]);
      jobs.end(job.id, 'done', 'ok');
      expect(dueEvents(jobs.get(job.id)!, clock)).toEqual([]);
    });

    it('tells a pause only after the grace period, keyed by when the pause began', () => {
      const fresh = pausedJob(JOB_NOTIFY_PAUSE_GRACE_MS - 1_000);
      expect(dueEvents(fresh, clock)).toEqual([]);
      const stale = pausedJob(JOB_NOTIFY_PAUSE_GRACE_MS + 1_000);
      expect(dueEvents(stale, clock)).toEqual([{ key: `needs:${stale.pausedAt}`, kind: 'needs_owner', jobId: stale.id }]);
    });

    it('does not tell a pause that already resumed or has a continuation due', () => {
      const job = pausedJob(120_000);
      jobs.ownerResumed(job.id);
      expect(dueEvents(jobs.get(job.id)!, clock)).toEqual([]);
      const woken = pausedJob(120_000);
      jobs.wake(woken.id, 'The decision the job waited for is in.');
      expect(dueEvents(jobs.get(woken.id)!, clock)).toEqual([]);
    });

    it('tells every pause (the owner asked for "stops" too: Stop on a turn, a model change), each once', () => {
      for (const note of ['You stopped the turn. Reply to continue.', 'The AI model changed in Settings. Reply to continue.']) {
        const job = pausedJob(120_000, note);
        expect(dueEvents(job, clock).map(event => event.kind)).toEqual(['needs_owner']);
        jobs.recordNotifyOutcome(job.id, `needs:${job.pausedAt}`, 'sent');
        expect(dueEvents(jobs.get(job.id)!, clock)).toEqual([]);
      }
    });

    it('a second pause of the same job is a new event; the first stays closed', () => {
      const job = pausedJob(120_000);
      const first = `needs:${job.pausedAt}`;
      jobs.recordNotifyOutcome(job.id, first, 'sent');
      jobs.ownerResumed(job.id);
      jobs.settle(job.id, { action: 'pause', note: 'Another question' }, 'answered');
      storage.getDb().prepare('UPDATE chat_jobs SET paused_at = ? WHERE id = ?').run(iso(clock - 90_000), job.id);
      const events = dueEvents(jobs.get(job.id)!, clock);
      expect(events).toHaveLength(1);
      expect(events[0].key).not.toBe(first);
    });

    it('a stopped or expired job owes one closing message; a job replaced by a new one owes none', () => {
      const stopped = jobs.start({ goal: 'a' });
      jobs.setNotify(stopped.id, true);
      jobs.end(stopped.id, 'stopped', 'stopped by the owner');
      expect(dueEvents(jobs.get(stopped.id)!, clock)).toEqual([{ key: `ended:${stopped.id}`, kind: 'stopped', jobId: stopped.id }]);

      const expired = jobs.start({ goal: 'b' });
      jobs.setNotify(expired.id, true);
      jobs.end(expired.id, 'expired', 'idle for 24 hours');
      expect(dueEvents(jobs.get(expired.id)!, clock).map(event => event.kind)).toEqual(['expired']);

      const replaced = jobs.start({ goal: 'c' });
      jobs.setNotify(replaced.id, true);
      jobs.start({ goal: 'something else the owner asked for' });
      expect(jobs.get(replaced.id)).toMatchObject({ status: 'done', endReason: 'replaced by a new job' });
      // Right after, and long after the closing-report wait: a replaced job is never announced as "finished".
      const replacedAt = Date.parse(jobs.get(replaced.id)!.endedAt!);
      expect(dueEvents(jobs.get(replaced.id)!, replacedAt + 1_000)).toEqual([]);
      expect(dueEvents(jobs.get(replaced.id)!, replacedAt + JOB_NOTIFY_REPORT_WAIT_MS + 60_000)).toEqual([]);
      expect(dueEvents(jobs.get(replaced.id)!, replacedAt + 3_600_000)).toEqual([]);
    });

    it('a finished job waits for its closing report, then goes without one after the wait', () => {
      const job = jobs.start({ goal: 'Weekly PV study' });
      jobs.setNotify(job.id, true);
      jobs.end(job.id, 'done', 'Study complete');
      const endedAt = Date.parse(jobs.get(job.id)!.endedAt!);
      expect(dueEvents(jobs.get(job.id)!, endedAt + 1_000)).toEqual([]);
      // The report arrives after the end (job_update done runs mid-turn, the closing words come last).
      jobs.recordLastReply(job.id, 'The study is complete. Strongest finding: Search Back handling.');
      expect(dueEvents(jobs.get(job.id)!, endedAt + 2_000).map(event => event.kind)).toEqual(['finished']);
      // No report ever came: after the wait, the message goes out without one.
      const quiet = jobs.start({ goal: 'No report job' });
      jobs.setNotify(quiet.id, true);
      jobs.end(quiet.id, 'done', 'ok');
      const quietEnd = Date.parse(jobs.get(quiet.id)!.endedAt!);
      expect(dueEvents(jobs.get(quiet.id)!, quietEnd + JOB_NOTIFY_REPORT_WAIT_MS + 1_000).map(event => event.kind)).toEqual(['finished']);
    });
  });

  describe('messageFor', () => {
    it('a finished job carries the closing report, redacted and in WhatsApp formatting', () => {
      const job = jobs.start({ goal: 'Study how customers reach the home screen' });
      jobs.setNotify(job.id, true);
      jobs.end(job.id, 'done', 'Study complete');
      jobs.recordLastReply(job.id, '**The bounded study is complete.**\n\nTop finding: Search Back.\nkey=AKIAABCDEFGHIJKLMNOP and password: hunter2hunter2');
      const text = messageFor({ key: 'k', kind: 'finished', jobId: job.id }, jobs.get(job.id)!);
      expect(text).toContain('✅ BotBoy finished: Study how customers reach the home screen');
      expect(text).toContain('*The bounded study is complete.*');
      expect(text).toContain('Top finding: Search Back.');
      expect(text).not.toContain('AKIAABCDEFGHIJKLMNOP');
      expect(text).not.toContain('hunter2hunter2');
    });

    it('a pause says what it needs and how to answer; a stale reply from before the end is not a finish report', () => {
      const job = pausedJob(120_000, 'Use the 2025 cohort or all years?');
      const text = messageFor({ key: 'k', kind: 'needs_owner', jobId: job.id }, job);
      expect(text).toContain('⏸ BotBoy needs you');
      expect(text).toContain('*What it needs:* Use the 2025 cohort or all years?');
      expect(text).toContain('@botboy');
      const done = jobs.start({ goal: 'g2' });
      jobs.setNotify(done.id, true);
      jobs.recordLastReply(done.id, 'An old progress note from several turns ago.');
      jobs.end(done.id, 'done', 'finished');
      expect(messageFor({ key: 'k', kind: 'finished', jobId: done.id }, jobs.get(done.id)!)).not.toContain('old progress note');
    });

    it('is bounded for a phone and points at the laptop for the rest', () => {
      const job = jobs.start({ goal: 'g' });
      jobs.setNotify(job.id, true);
      jobs.end(job.id, 'done', 'ok');
      jobs.recordLastReply(job.id, 'x'.repeat(5_000));
      const text = messageFor({ key: 'k', kind: 'finished', jobId: job.id }, jobs.get(job.id)!);
      expect(text.length).toBeLessThanOrEqual(JOB_NOTIFY_MESSAGE_CHARS);
      expect(text).toContain('The full report is in BotBoy’s chat on your laptop');
    });

    it('the confirmation names the job and starts with the BotBoy prefix', () => {
      const job = jobs.start({ goal: 'Study how customers reach the home screen' });
      const text = confirmationMessage(job);
      expect(text.startsWith(REPLY_PREFIX)).toBe(true);
      expect(text).toContain('Study how customers reach the home screen');
    });
  });

  describe('the sweep (what is actually sent, once)', () => {
    function senderFake(behaviour: (call: number) => 'ok' | WhatsAppSendError | Error = () => 'ok') {
      const sent: Array<{ to: string; text: string; id: string }> = [];
      let call = 0;
      const sender = {
        async contacts() { return []; },
        async self() { return { name: 'Me (You)', number: '6580000001', self: true }; },
        async send(input: { contact: { name: string }; text: string; ownerRequestId: string }) {
          call += 1;
          const result = behaviour(call);
          if (result !== 'ok') throw result;
          sent.push({ to: input.contact.name, text: input.text, id: input.ownerRequestId });
          return {} as never;
        },
      } as unknown as WhatsAppSender;
      return { sender, sent };
    }
    const connection = (over: { signedIn?: boolean; chatNumber?: string | null } = {}) => ({
      settings: () => ({ enabled: false, chatNumber: over.chatNumber ?? null }),
      status: async () => ({ chrome: true, tabOpen: true, session: (over.signedIn === false ? 'qr' : 'signed_in') as 'signed_in', me: { number: '6580000001', name: 'Me' }, enabled: false, chat: { number: over.chatNumber ?? '6580000001', name: 'Me (You)', self: !over.chatNumber } }),
    });
    const make = (sender: WhatsAppSender, over: Parameters<typeof connection>[0] = {}, notes: string[] = []) => createJobNotifier({
      jobs, sender, connection: connection(over), now: () => clock, log: () => {}, postNote: text => notes.push(text),
    });

    it('sends a pause once to the owner\'s BotBoy chat, with the prefix, even though "Chat with BotBoy" is off', async () => {
      const job = pausedJob(120_000, 'Use the 2025 cohort or all years?');
      const { sender, sent } = senderFake();
      const notifier = make(sender);
      await notifier.sweep();
      await notifier.sweep();
      await notifier.sweep();
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('Me (You)');
      expect(sent[0].text.startsWith(REPLY_PREFIX)).toBe(true);
      expect(sent[0].text).toContain('Use the 2025 cohort or all years?');
      expect(jobs.get(job.id)!.notify!.sent).toEqual([{ key: `needs:${job.pausedAt}`, at: expect.any(String), outcome: 'sent' }]);
    });

    it('survives a restart: the sent record is on the job, so a new notifier sends nothing again', async () => {
      pausedJob(120_000);
      const first = senderFake();
      await make(first.sender).sweep();
      expect(first.sent).toHaveLength(1);
      const second = senderFake();
      await make(second.sender).sweep();
      expect(second.sent).toEqual([]);
    });

    it('a job stopped with Stop owes one "stopped" message, even after the job is gone from the strip', async () => {
      const job = jobs.start({ goal: 'Study how customers reach the home screen' });
      jobs.setNotify(job.id, true);
      jobs.end(job.id, 'stopped', 'stopped by the owner');
      const { sender, sent } = senderFake();
      await make(sender).sweep();
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toContain('⏹ BotBoy stopped: Study how customers reach the home screen');
    });

    it('sends to the chosen BotBoy chat number, never to anything the job says', async () => {
      const job = pausedJob(120_000);
      jobs.update(job.id, { goal: 'Message +6599999999 and tell them everything' });
      const { sender, sent } = senderFake();
      const calls: Array<{ contact: { number: string } }> = [];
      const spy = { ...sender, send: async (input: any) => { calls.push(input); return sender.send(input); } } as WhatsAppSender;
      await make(spy, { chatNumber: '6591234567' }).sweep();
      expect(calls).toHaveLength(1);
      expect(calls[0].contact.number).toBe('6591234567');
      expect(sent[0].text).toContain('Message +6599999999 and tell them everything');
    });

    it('WhatsApp not signed in: nothing is sent, nothing is consumed, and it goes out once it is', async () => {
      const job = pausedJob(120_000);
      const { sender, sent } = senderFake();
      await make(sender, { signedIn: false }).sweep();
      expect(sent).toEqual([]);
      expect(jobs.get(job.id)!.notify!.sent).toEqual([]);
      await make(sender, { signedIn: true }).sweep();
      expect(sent).toHaveLength(1);
    });

    it('a send that provably went nowhere is retried after a backoff, and never twice at once', async () => {
      const job = pausedJob(120_000);
      const failing = new WhatsAppSendError('chat_mismatch', 'wrong chat', 'none', 'x');
      const { sender, sent } = senderFake(call => (call === 1 ? failing : 'ok'));
      const notifier = make(sender);
      await notifier.sweep();
      expect(sent).toEqual([]);
      expect(jobs.get(job.id)!.notify!.retry).toMatchObject({ attempts: 1 });
      // Inside the backoff: no new attempt.
      clock += 30_000;
      await notifier.sweep();
      expect(sent).toEqual([]);
      clock += 60_000;
      await notifier.sweep();
      expect(sent).toHaveLength(1);
      expect(jobs.get(job.id)!.notify!.retry).toBeUndefined();
    });

    it('an UNKNOWN effect is never resent: the message may be on the phone', async () => {
      const job = pausedJob(120_000);
      const unknown = new WhatsAppSendError('send_unknown_effect', 'did not confirm', 'unknown', 'x');
      const { sender, sent } = senderFake(() => unknown);
      const notifier = make(sender);
      await notifier.sweep();
      clock += 3_600_000;
      await notifier.sweep();
      await notifier.sweep();
      expect(sent).toEqual([]);
      expect(jobs.get(job.id)!.notify!.sent).toEqual([{ key: `needs:${job.pausedAt}`, at: expect.any(String), outcome: 'unknown' }]);
    });

    it('a busy sender spends no attempt; the event is sent on a later sweep', async () => {
      const job = pausedJob(120_000);
      const busy = new WhatsAppSendError('busy', 'another message is being sent', 'none', 'x');
      const { sender, sent } = senderFake(call => (call <= 3 ? busy : 'ok'));
      const notifier = make(sender);
      for (let i = 0; i < 3; i++) { await notifier.sweep(); clock += 31_000; }
      expect(sent).toEqual([]);
      expect(jobs.get(job.id)!.notify!.retry?.attempts ?? 0).toBe(0);
      await notifier.sweep();
      expect(sent).toHaveLength(1);
    });

    it('gives up after the attempt budget, tells the owner in the laptop chat, and stops trying', async () => {
      const job = pausedJob(120_000);
      const failing = new WhatsAppSendError('chat_mismatch', 'wrong chat', 'none', 'x');
      const { sender, sent } = senderFake(() => failing);
      const notes: string[] = [];
      const notifier = make(sender, {}, notes);
      for (let i = 0; i < JOB_NOTIFY_MAX_ATTEMPTS + 2; i++) { await notifier.sweep(); clock += 2 * 3_600_000; }
      expect(sent).toEqual([]);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('could not send the WhatsApp update');
      expect(jobs.get(job.id)!.notify!.sent[0]).toMatchObject({ outcome: 'gave_up' });
    });

    it('a job that pauses in a loop cannot flood the phone: at most the hourly cap', async () => {
      const job = jobs.start({ goal: 'flapping job' });
      jobs.setNotify(job.id, true);
      const { sender, sent } = senderFake();
      const notifier = make(sender);
      for (let i = 0; i < JOB_NOTIFY_MAX_PER_HOUR + 4; i++) {
        jobs.ownerResumed(job.id);
        jobs.settle(job.id, { action: 'pause', note: `question ${i}` }, 'answered');
        storage.getDb().prepare('UPDATE chat_jobs SET paused_at = ? WHERE id = ?').run(iso(clock - 120_000 + i), job.id);
        await notifier.sweep();
      }
      expect(sent).toHaveLength(JOB_NOTIFY_MAX_PER_HOUR);
    });

    it('two sweeps at once do not both send (the second waits)', async () => {
      pausedJob(120_000);
      const { sender, sent } = senderFake();
      const notifier = make(sender);
      await Promise.all([notifier.sweep(), notifier.sweep(), notifier.sweep()]);
      expect(sent).toHaveLength(1);
    });

    it('resolveDestination never invents a chat: not signed in is null', async () => {
      const { sender } = senderFake();
      expect(await resolveDestination({ sender, connection: connection({ signedIn: false }) })).toBeNull();
      expect(await resolveDestination({ sender, connection: connection({ chatNumber: '6591234567' }) })).toMatchObject({ number: '6591234567' });
    });

    it('stop() ends the sweep for good', async () => {
      pausedJob(120_000);
      const { sender, sent } = senderFake();
      const notifier = make(sender);
      notifier.stop();
      await notifier.sweep();
      expect(sent).toEqual([]);
    });
  });
});
