/**
 * WhatsApp updates for an owner job (docs/maps/job-notify.md).
 *
 * Owner job: "tell me on my phone when the job I started needs me or ends, so I can leave my laptop." The owner asks once, in
 * a live chat turn (`job_notify`, job-notify-chat-tools.ts); BotBoy then sends the message ITSELF. Nothing here is a model turn:
 * a job pauses, finishes, is stopped or expires on the server, often while no turn runs, and a continuation turn has no
 * WhatsApp tool by design (job-mandate.ts), so a promise kept by the model could never be kept.
 *
 * Identity. The notifier may message ONE place: the owner's BotBoy chat from Connections → WhatsApp (their own chat by
 * default), never a name or number from a job or a model. It speaks only for a job the owner armed, and the owner's ask is its
 * authority (the "Chat with BotBoy" switch governs reading requests, not these). Every message starts with the BotBoy reply
 * prefix, so the chat bridge never reads it as a request. It can read, search and send nothing else.
 * Knowledge. Operating: the job row (`chat_jobs`: status, pause, end reason, `notify`, `last_reply`). Retrieved: none.
 * Runtime context: one event at a time, the job's words redacted of secret formats.
 * Execution. Events are DERIVED from job state each sweep (`dueEvents`), so a restart, a missed hook or a late WhatsApp loses
 * nothing. An event is closed in the job row BEFORE its send is attempted (as 'unknown'), then replaced by the result: a crash
 * mid-send can never send twice, and an unknown effect is never resent. Only an attempt that provably sent nothing is retried,
 * with a backoff and a small budget; after that the owner is told in the laptop chat. WhatsApp not signed in, or the sender
 * busy, leaves the event untouched (no attempt is spent). At most `JOB_NOTIFY_MAX_PER_HOUR` messages per job per hour.
 */
import { CHAT_JOB_REPLACED_REASON, type ChatJob, type ChatJobStore } from './chat-jobs.js';
import { redactSecrets } from './sensitive-files.js';
import { REPLY_PREFIX, toWhatsAppText } from './whatsapp-chat.js';
import { WhatsAppSendError, type WhatsAppContact, type WhatsAppSender } from './whatsapp-send.js';
import type { WhatsAppConnection } from './whatsapp-connection.js';

/** How often the notifier looks for due events. */
export const JOB_NOTIFY_INTERVAL_MS = 15_000;
/** A pause is told only once it has stood this long with nothing resuming it (a quick owner reply or a wake-up cancels it). */
export const JOB_NOTIFY_PAUSE_GRACE_MS = 45_000;
/** A finished job waits this long for its closing report (written after `job_update done`), then goes without one. */
export const JOB_NOTIFY_REPORT_WAIT_MS = 2 * 60_000;
/** Armed jobs that ended within this window can still owe their closing message (a WhatsApp that was down). */
export const JOB_NOTIFY_ENDED_WINDOW_MS = 6 * 60 * 60_000;
/** Attempts that provably sent nothing, per event, before the owner is told in the laptop chat instead. */
export const JOB_NOTIFY_MAX_ATTEMPTS = 6;
/** A job that pauses and resumes in a loop cannot flood the phone: at most this many messages per job per hour. */
export const JOB_NOTIFY_MAX_PER_HOUR = 6;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
/** Longest message BotBoy puts on a phone for one event. */
export const JOB_NOTIFY_MESSAGE_CHARS = 1_800;
const HOUR_MS = 60 * 60_000;

export type JobNotifyKind = 'needs_owner' | 'finished' | 'stopped' | 'expired';

export interface JobNotifyEvent {
  /** Stable for the event: a pause is keyed by when it began, an end by the job. */
  key: string;
  kind: JobNotifyKind;
  jobId: string;
}

const clip = (value: unknown, max: number): string => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

/**
 * The events a job owes right now, from its state alone. Pure: the same job and clock give the same events.
 *  - paused (a question, a failure, the continuation limit, Stop on a turn, a model change) and still paused after the grace period
 *  - finished (`job_update done`), stopped (the Stop button), or expired (idle a day)
 * Silent by design: a job REPLACED by a new one (the owner started something else). A finished job waits for its closing report.
 */
export function dueEvents(job: ChatJob, nowMs: number): JobNotifyEvent[] {
  if (!job.notify) return [];
  const done = new Set(job.notify.sent.map(entry => entry.key));
  const events: JobNotifyEvent[] = [];
  if (job.status === 'active') {
    if (job.pausedAt && !job.continueRequestedAt && nowMs - Date.parse(job.pausedAt) >= JOB_NOTIFY_PAUSE_GRACE_MS) {
      events.push({ key: `needs:${job.pausedAt}`, kind: 'needs_owner', jobId: job.id });
    }
  } else if (job.endedAt && job.endReason !== CHAT_JOB_REPLACED_REASON) {
    const kind: JobNotifyKind = job.status === 'done' ? 'finished' : job.status === 'expired' ? 'expired' : 'stopped';
    if (kind === 'finished') {
      // `job_update done` ends the job mid-turn and drops every earlier report (chat-jobs.ts › endJob); the closing report is written
      // after it. Wait for a reply to exist, but not forever.
      if (!job.lastReply && nowMs - Date.parse(job.endedAt) < JOB_NOTIFY_REPORT_WAIT_MS) return [];
    }
    events.push({ key: `ended:${job.id}`, kind, jobId: job.id });
  }
  return events.filter(event => !done.has(event.key));
}

const GOAL_CHARS = 140;

/**
 * The message the owner reads on the phone. Plain WhatsApp text: what happened, the job, and (for a pause or a finish) the job's
 * own closing words, which are the report. Secret formats are removed; markdown becomes WhatsApp formatting. Bounded (a phone
 * message), and says where the full answer lives.
 */
export function messageFor(event: JobNotifyEvent, job: ChatJob): string {
  const goal = clip(job.goal, GOAL_CHARS);
  const lead = event.kind === 'needs_owner' ? '⏸ BotBoy needs you'
    : event.kind === 'finished' ? '✅ BotBoy finished'
      : event.kind === 'expired' ? '⌛ BotBoy ended an idle job'
        : '⏹ BotBoy stopped';
  const parts = [`${lead}: ${goal}`];
  if (event.kind === 'needs_owner' && job.pauseNote) parts.push(`*What it needs:* ${clip(job.pauseNote, 600)}`);
  if (event.kind === 'finished' && job.endReason) parts.push(`*Outcome:* ${clip(job.endReason, 400)}`);
  if (event.kind === 'stopped' && job.endReason && !/stopped by the owner/i.test(job.endReason)) parts.push(clip(job.endReason, 300));
  if (event.kind === 'expired') parts.push('Nothing happened on it for 24 hours, so BotBoy closed it. Write @botboy here to start again.');
  // The report is the job's last reply. For an ended job the store dropped everything written before the end (chat-jobs.ts › endJob), so
  // what is here was written after it: the closing report. A pause carries the reply of the turn that paused.
  const report = job.lastReply ? toWhatsAppText(redactSecrets(job.lastReply)) : '';
  if (report && event.kind !== 'expired') parts.push(report);
  if (event.kind === 'needs_owner') parts.push('Answer here with @botboy and your reply, or in BotBoy on your laptop.');
  let text = parts.join('\n\n').trim();
  if (text.length > JOB_NOTIFY_MESSAGE_CHARS) {
    text = `${text.slice(0, JOB_NOTIFY_MESSAGE_CHARS - 70).trimEnd()}…\n\n(The full report is in BotBoy’s chat on your laptop.)`;
  }
  return text;
}

/** The text sent to confirm that updates are on. Sent by the tool, so a promise is never made that cannot be kept. */
export function confirmationMessage(job: ChatJob): string {
  return `${REPLY_PREFIX}Updates are on for: ${clip(job.goal, GOAL_CHARS)}\n\nBotBoy will message this chat when the job needs you, finishes, or is stopped. These come from BotBoy itself, so they arrive even while it works on its own.`;
}

export interface JobNotifierDeps {
  jobs: ChatJobStore;
  sender: WhatsAppSender;
  /** Connections → WhatsApp: where the BotBoy chat is (null number: the owner's own chat), and whether WhatsApp is signed in. */
  connection: Pick<WhatsAppConnection, 'settings' | 'status'>;
  /** A visible note in the laptop chat (an event that could not be sent). */
  postNote?: (text: string) => void;
  now?: () => number;
  log?: (line: string) => void;
  intervalMs?: number;
}

export interface JobNotifier {
  start(): void;
  stop(): void;
  /** One sweep (exposed for tests and for a check right after a state change). Never throws. */
  sweep(): Promise<void>;
  /** Runs a sweep now instead of waiting for the interval (a job just paused or ended). Coalesces. */
  nudge(): void;
}

/**
 * Where a message goes: the owner's BotBoy chat, resolved from the connection at send time. Null when WhatsApp is not ready.
 * Never a name or number from anywhere else.
 */
export async function resolveDestination(deps: Pick<JobNotifierDeps, 'sender' | 'connection'>): Promise<WhatsAppContact | null> {
  const settings = deps.connection.settings();
  const status = await deps.connection.status().catch(() => null);
  if (!status || status.session !== 'signed_in') return null;
  if (!settings.chatNumber) return deps.sender.self().catch(() => null);
  return { name: status.chat?.name ?? `+${settings.chatNumber}`, number: settings.chatNumber };
}

/** Errors that mean "not now" rather than "this message failed": nothing was attempted, so no retry is spent. */
const isBusy = (error: unknown): boolean => error instanceof WhatsAppSendError && (error.code === 'busy' || error.code === 'not_open');

export function createJobNotifier(deps: JobNotifierDeps): JobNotifier {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  let timer: ReturnType<typeof setInterval> | null = null;
  let sweeping = false;
  let again = false;
  let stopped = false;
  /** Recent sends per job, for the hourly cap. In memory on purpose: a restart resets a cap that exists to stop loops. */
  const recent = new Map<string, number[]>();

  function underCap(jobId: string): boolean {
    const cutoff = now() - HOUR_MS;
    const times = (recent.get(jobId) ?? []).filter(time => time > cutoff);
    recent.set(jobId, times);
    return times.length < JOB_NOTIFY_MAX_PER_HOUR;
  }

  /** Sends one event. Resolves with how it ended; never throws. */
  async function deliver(event: JobNotifyEvent, job: ChatJob): Promise<'sent' | 'unknown' | 'retry' | 'not_ready'> {
    const destination = await resolveDestination(deps);
    if (!destination) return 'not_ready';
    const text = `${REPLY_PREFIX}${messageFor(event, job)}`;
    // Closed BEFORE the attempt: whatever happens next (a crash, a timeout), this event is never sent twice.
    deps.jobs.recordNotifyOutcome(job.id, event.key, 'unknown');
    try {
      await deps.sender.send({ contact: destination, text, ownerRequestId: `job-notify:${job.id}:${event.key}` });
      deps.jobs.recordNotifyOutcome(job.id, event.key, 'sent');
      (recent.get(job.id) ?? recent.set(job.id, []).get(job.id)!).push(now());
      return 'sent';
    } catch (error) {
      if (isBusy(error)) {
        // Nothing was attempted: put the event back exactly as it was, spend nothing.
        deps.jobs.recordNotifyOutcome(job.id, event.key, { retryAt: new Date(now() + 30_000).toISOString(), attempts: job.notify?.retry?.key === event.key ? job.notify.retry.attempts : 0 });
        return 'not_ready';
      }
      if (error instanceof WhatsAppSendError && error.effect === 'none') {
        // Provably nothing went out (a chat mismatch, a number WhatsApp cannot open): open the event again for a retry.
        return 'retry';
      }
      // Effect unknown: the message may be on the phone. Never resend; it stays closed as 'unknown'.
      log(`[JobNotify] ${job.id} ${event.kind}: WhatsApp did not confirm (${String((error as Error)?.message ?? error).slice(0, 140)}); not resent`);
      return 'unknown';
    }
  }

  async function sweepOnce(): Promise<void> {
    const since = new Date(now() - JOB_NOTIFY_ENDED_WINDOW_MS).toISOString();
    for (const candidate of deps.jobs.notifyCandidates(since)) {
      if (stopped) return;
      const retry = candidate.notify?.retry;
      for (const event of dueEvents(candidate, now())) {
        if (retry && retry.key === event.key && Date.parse(retry.notBefore) > now()) continue;
        if (!underCap(candidate.id)) {
          log(`[JobNotify] ${candidate.id}: ${JOB_NOTIFY_MAX_PER_HOUR} messages in the last hour; holding ${event.kind}`);
          break;
        }
        const attempts = retry && retry.key === event.key ? retry.attempts : 0;
        const result = await deliver(event, candidate);
        if (result === 'not_ready') return; // WhatsApp is not signed in, not open, or busy: try again next sweep, nothing is spent
        if (result === 'sent') {
          log(`[JobNotify] ${candidate.id} ${event.kind}: sent to the BotBoy chat`);
        } else if (result === 'retry') {
          const next = attempts + 1;
          if (next >= JOB_NOTIFY_MAX_ATTEMPTS) {
            deps.jobs.recordNotifyOutcome(candidate.id, event.key, 'gave_up');
            log(`[JobNotify] ${candidate.id} ${event.kind}: gave up after ${next} attempts`);
            deps.postNote?.(`⚠️ I could not send the WhatsApp update for "${clip(candidate.goal, 100)}" (${event.kind === 'needs_owner' ? 'it needs you' : event.kind === 'finished' ? 'it finished' : 'it ended'}). WhatsApp Web may be closed or signed out: check Connections → WhatsApp.`);
          } else {
            const delay = BACKOFF_MS[Math.min(next - 1, BACKOFF_MS.length - 1)];
            deps.jobs.recordNotifyOutcome(candidate.id, event.key, { retryAt: new Date(now() + delay).toISOString(), attempts: next });
            log(`[JobNotify] ${candidate.id} ${event.kind}: not sent (attempt ${next}); retrying in ${Math.round(delay / 60_000)} min`);
          }
        }
        // 'unknown': recorded; the owner may or may not have it. Never resent, never retried.
      }
    }
  }

  async function sweep(): Promise<void> {
    if (stopped) return;
    if (sweeping) { again = true; return; }
    sweeping = true;
    try {
      do {
        again = false;
        try { await sweepOnce(); } catch (error) { log(`[JobNotify] sweep failed: ${String((error as Error)?.message ?? error).slice(0, 160)}`); }
      } while (again && !stopped);
    } finally {
      sweeping = false;
    }
  }

  return {
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => { void sweep(); }, deps.intervalMs ?? JOB_NOTIFY_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    sweep,
    nudge() { void sweep(); },
  };
}
