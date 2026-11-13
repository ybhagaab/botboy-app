/**
 * The main chat's desk for jobs (PARALLEL_JOBS_PLAN.md §11, owner decisions 2026-11-08; docs/maps/job-continuations.md): what
 * reaches the main chat from a job, and what the main chat sends to one.
 *
 *   - A finished job's report: its own closing reply, posted once in the main chat (a transcript row ending with the job's
 *     report card) and added to the main chat's model history, so a follow-up there has it. A job that expired idle gets one
 *     quiet line. Nothing is posted while an owner turn runs in the main chat: it waits for that reply to end.
 *   - A message for a job: from the main chat in an owner turn there (`jobs message`), or from the main chat's own look at a job
 *     update (job-review.ts, §12). It waits in the job's inbox, the job's running automatic step gives way (its finished work is
 *     kept), and the job's next automatic turn carries it. It is never an owner turn: the job keeps its own permissions. While
 *     the owner talks to the job in its own thread, a message from the main chat waits for that reply to end (ownerTurnEnded).
 *   - Keeping a job going as it is (`jobs continue`) and asking the owner (`jobs ask_owner`, the main chat's look only).
 *   - The job's reply to a main-chat message comes back to the main chat, and so does a job's line with its card when the owner
 *     has to act (job-review.ts › fallbackLine).
 *
 * What is posted is the job's own words or a fixed sentence around them; nothing is re-derived (verify before conclude).
 */
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { jobCardMarker, JOB_INBOX_MAX, JOB_MESSAGE_REASON, JOB_REVIEW_REASON, MAX_REVIEW_ROUNDS, type ChatJob, type ChatJobStore } from './chat-jobs.js';

export interface JobDeskDeps {
  db: Database.Database;
  jobs: ChatJobStore;
  /** The main chat's model session (null before the first main-chat message), and how one reply is added to it. */
  mainSessionId: () => string | null;
  appendMainHistory: (sessionId: string, text: string) => void;
  /** An owner turn is running in the main chat: what goes there waits for it. */
  mainOwnerTurnActive: () => boolean;
  /** An owner turn is running in this job's own thread (the owner is talking to the job right now). */
  ownerTurnInJob: (jobId: string) => boolean;
  /** Stops the job's running automatic turn (its finished work is kept) and waits for it to close. */
  preempt: (jobId: string) => Promise<void>;
  /** Asks the continuation runner to look at the job now. */
  request: (jobId: string) => void;
  /** Tells the chat panel that the transcript changed. */
  bump: () => void;
  log?: (line: string) => void;
  now?: () => number;
}

export type JobMessageCode = 'job_not_found' | 'job_not_active' | 'job_stopped' | 'owner_paused' | 'rounds_used' | 'owner_turn_active'
  | 'empty_message' | 'not_delivered' | 'nothing_to_continue' | 'needs_answer';

/**
 * `queued`: the owner is talking to the job in its own thread right now, so the main chat's message waits and goes in when that
 * reply ends (owner decision 2026-11-12: job #5's two messages from the main chat were refused while he talked to it).
 */
export type JobMessageResult =
  | { ok: true; job: { id: string; number: number; title: string; status: 'active'; reopened: boolean }; note: string; queued?: true }
  | { ok: false; code: JobMessageCode; error: string; nextAction: string };

/** Who acts on a job from the main chat: the owner's turn there, or the main chat's own look at a job update (§12). */
export type JobDeskSource = 'main_chat' | 'review';

export interface JobDesk {
  /** Posts every finished job's report (and every expired job's line) not posted yet; the number posted. */
  deliverReports(): number;
  /**
   * The turn that finished this job was the owner's `#N` message typed in the main chat, so its reply (the report) already shows
   * there: the report row carries only the job's card under it, never the same words twice.
   */
  noteReportShown(jobId: string): void;
  messageJob(jobId: string, text: string, input: { from: JobDeskSource; ownerWords?: string }): Promise<JobMessageResult>;
  /** Keeps a job going as it is (`jobs continue`): a pause BotBoy made clears, with a fresh round of turns (§12 R3). */
  continueJob(jobId: string, input: { from: JobDeskSource }): Promise<JobMessageResult>;
  /** The main chat found a choice only the owner can make: the job asks him, with one-tap answers (the "needs you" banner). */
  askOwner(jobId: string, question: string, options: string[]): JobMessageResult;
  /** The job's reply to a main-chat message ("#N replied"). */
  postReply(jobId: string, text: string): void;
  /** One line about a job in the main chat with the job's card under it: the owner has to act (job-review.ts › fallbackLine). */
  postUpdateLine(jobId: string, line: string): void;
  /** Posts what waited for a main-chat reply, then any report due. Call after an owner turn in the main chat ends. */
  flush(): void;
  /**
   * The owner's turn in this job's own thread ended: the main chat's messages that waited for it go to the job now, as they would
   * have (its inbox, a turn due, the reply back to the main chat). Call after the turn has left the active turns. Never throws.
   */
  ownerTurnEnded(jobId: string): Promise<void>;
}

/** How far back a report that never reached the main chat (a restart, a long owner turn) is still posted. */
export const REPORT_CATCH_UP_MS = 48 * 60 * 60_000;

export function createJobDesk(deps: JobDeskDeps): JobDesk {
  const { db, jobs } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? Date.now;
  /** Posts that waited for an owner turn in the main chat to end (in memory: a restart drops them, the report survives). */
  const waiting: Array<() => void> = [];
  /** Jobs whose report the main chat already shows as a `#N` reply (in memory: after a restart the words show once more). */
  const shownInMain = new Set<string>();
  /**
   * Main-chat messages waiting for the owner's turn in the job's own thread to end, newest last (in memory, like `waiting`: a
   * restart drops them; the owner's own words stay in the main chat). They are not put in the inbox during his turn: delivering
   * resets the job's declaration and counts, which belong to that turn.
   */
  const queuedForJob = new Map<string, Array<{ text: string; ownerWords?: string }>>();
  const rowId = (prefix: string) => `${prefix}-${now()}-${randomBytes(4).toString('hex')}`;
  const insertMain = db.prepare('INSERT INTO chat_messages (id, role, content, job_id, ref_job_id) VALUES (?, ?, ?, NULL, ?)');
  const insertThread = db.prepare('INSERT INTO chat_messages (id, role, content, job_id) VALUES (?, ?, ?, ?)');

  function addToMainHistory(text: string): void {
    try {
      const sessionId = deps.mainSessionId();
      if (sessionId) deps.appendMainHistory(sessionId, text);
    } catch (error: any) {
      log(`[JobDesk] could not add a job note to the main chat's history: ${error?.message ?? error}`);
    }
  }

  /** Runs `post` now, or after the owner's main-chat reply ends (a post never lands in the middle of one). */
  function whenMainIsFree(post: () => void): void {
    if (deps.mainOwnerTurnActive()) { waiting.push(post); return; }
    try { post(); } catch (error: any) { log(`[JobDesk] post failed: ${error?.message ?? error}`); }
  }

  const reportBody = (job: ChatJob): string => job.report?.trim()
    || (job.endReason && job.endReason !== 'done' ? job.endReason : 'Finished.');

  function reportRow(job: ChatJob): { content: string; history: string } {
    if (job.status === 'expired') {
      const line = `#${job.seq} ${job.title} stopped after a day with no activity. Start a message with #${job.seq} to pick it up again.`;
      return { content: `${line}\n\n${jobCardMarker(job.id, 'ended')}`, history: `Job #${job.seq} "${job.title}" ended after a day with no activity; the owner can pick it up again with #${job.seq}.` };
    }
    const body = reportBody(job);
    const steps = job.nextSteps?.length ? `\n\nNext steps offered as one-tap buttons: ${job.nextSteps.join('; ')}.` : '';
    return {
      content: shownInMain.has(job.id) ? jobCardMarker(job.id, 'report') : `${body}\n\n${jobCardMarker(job.id, 'report')}`,
      history: `Job #${job.seq} "${job.title}" is done. Its report, as posted in this chat:\n\n${body}${steps}`,
    };
  }

  function deliverReports(): number {
    if (deps.mainOwnerTurnActive()) return 0;
    let posted = 0;
    for (const job of jobs.unreportedEnded(new Date(now() - REPORT_CATCH_UP_MS).toISOString())) {
      const row = reportRow(job);
      // Claimed and written together: a report is posted exactly once, whoever asks first (a turn's end, an expiry, the boot).
      const claimed = db.transaction(() => {
        if (!jobs.markReported(job.id)) return false;
        insertMain.run(rowId('job'), 'assistant', row.content, job.id);
        return true;
      })();
      if (!claimed) continue;
      shownInMain.delete(job.id);
      addToMainHistory(row.history);
      posted += 1;
      log(`[Job] #${job.seq} ${job.id} ${job.status === 'expired' ? 'ended idle' : 'report'} posted in the main chat`);
    }
    if (posted) deps.bump();
    return posted;
  }

  const refuse = (code: JobMessageCode, error: string, nextAction: string): JobMessageResult => ({ ok: false, code, error, nextAction });

  /**
   * What stops the main chat from acting on a job, or null. Both sources: the owner first (he is talking to the job), and a job he
   * stopped stays stopped. The main chat's own look (`review`) also never reopens an ended job, never overrides a pause he made,
   * and stops once it has kept the job going MAX_REVIEW_ROUNDS times without him.
   */
  function refusalFor(job: ChatJob | null, from: JobDeskSource, options: { ownerTurn?: boolean } = {}): JobMessageResult | null {
    if (!job || !job.seq) return refuse('job_not_found', 'There is no such job.', 'Call jobs {"action":"list"} for the jobs and their numbers.');
    // A job the owner stopped stays stopped until the owner picks it up again themselves (a #N message); a finished or expired
    // job takes a follow-up from the owner's main-chat turn like one from its own thread.
    if (job.status === 'stopped') {
      return refuse('job_stopped', `The owner stopped #${job.seq}.`, `If the owner wants it to carry on, tell them to start a message with #${job.seq}.`);
    }
    if (from === 'review') {
      if (job.status !== 'active') return refuse('job_not_active', `#${job.seq} has ended.`, 'Nothing to decide: tell the owner in one line how it ended.');
      if (job.pausedAt && job.pauseKind === 'paused') {
        return refuse('owner_paused', `The owner paused #${job.seq} (or stopped its turn, or changed its model).`, 'Leave it paused for the owner; say in one line what you found.');
      }
      if (job.supervisions >= MAX_REVIEW_ROUNDS) {
        return refuse('rounds_used', `You have kept #${job.seq} going ${MAX_REVIEW_ROUNDS} times without the owner.`, 'Leave this one for the owner: say in one line what the job needs from them.');
      }
    }
    // The owner goes first: while they talk to the job in its own thread, the main chat does not talk over them (a message from
    // the owner's main-chat turn waits instead, messageJob).
    if (options.ownerTurn !== false && deps.ownerTurnInJob(job.id)) {
      return refuse('owner_turn_active', `The owner is talking to #${job.seq} in its own thread right now.`, 'Tell the owner what you would pass on, or send it when that reply ends.');
    }
    return null;
  }

  function showInThread(job: ChatJob, text: string): void {
    try {
      insertThread.run(rowId('asst'), 'assistant', text, job.id);
    } catch (error: any) {
      log(`[JobDesk] could not show the main chat's note in #${job.seq}'s thread: ${error?.message ?? error}`);
    }
  }

  async function messageJob(jobId: string, text: string, input: { from: JobDeskSource; ownerWords?: string }): Promise<JobMessageResult> {
    const job = jobs.get(jobId);
    const clean = String(text ?? '').trim();
    if (job?.seq && !clean) return refuse('empty_message', 'The message is empty.', 'Say what the job should do.');
    const fromMain = input.from === 'main_chat';
    const refused = refusalFor(job, input.from, { ownerTurn: !fromMain });
    if (refused || !job) return refused!;
    if (fromMain && deps.ownerTurnInJob(job.id)) {
      // The owner is talking to the job in its own thread: the message waits for that reply to end (ownerTurnEnded).
      const list = [...(queuedForJob.get(job.id) ?? []), { text: clean, ...(input.ownerWords ? { ownerWords: input.ownerWords } : {}) }];
      queuedForJob.set(job.id, list.slice(-JOB_INBOX_MAX));
      log(`[Job] #${job.seq} ${job.id}: a message from the main chat waits for the owner's reply in its thread to end`);
      return {
        ok: true,
        queued: true,
        job: { id: job.id, number: job.seq, title: job.title, status: 'active', reopened: false },
        note: `The owner is talking to #${job.seq} in its own thread right now, so your message waits: it reaches #${job.seq} as soon as that reply ends, and #${job.seq}'s answer comes back to this chat as "#${job.seq} replied". Tell the owner in one short line what you passed on.`,
      };
    }
    const reopened = job.status !== 'active';
    const delivered = jobs.deliverMessage(jobId, { from: input.from, text: clean, ...(input.ownerWords ? { ownerWords: input.ownerWords } : {}) });
    if (!delivered) return refuse('not_delivered', `#${job.seq} could not take the message.`, 'Call jobs {"action":"read"} to see where it stands.');
    const sentAt = delivered.inbox.at(-1)?.at;
    showInThread(job, input.from === 'review' ? `↪ The main chat looked at this job: ${clean}` : `↪ From the main chat: ${clean}`);
    // The job's running step gives way, so the message takes effect now; its finished work stays.
    try { await deps.preempt(jobId); } catch { /* the step ends on its own; the message waits for the next turn */ }
    // A step that ended on its own just before it gave way may have cleared the due turn (it paused with a question, got stuck,
    // or waits for a run) or finished the job: the message still waits in the inbox, so its turn is made due again, and a job that
    // just finished takes it as a follow-up. What the OWNER did meanwhile stands: a pause they made (or a model they changed)
    // keeps the message waiting for their resume, and a job they stopped stays stopped.
    const after = jobs.get(jobId);
    const stillWaiting = Boolean(sentAt && after?.inbox.some(message => message.at === sentAt));
    if (after?.status === 'active' && stillWaiting && !after.continueRequestedAt && after.pauseKind !== 'paused') {
      jobs.requestTurn(jobId, input.from === 'review' ? JOB_REVIEW_REASON : JOB_MESSAGE_REASON);
    } else if (after?.status === 'done' && input.from === 'main_chat') {
      jobs.deliverMessage(jobId, { from: 'main_chat', text: clean, ...(input.ownerWords ? { ownerWords: input.ownerWords } : {}) });
    }
    deps.request(jobId);
    deps.bump();
    log(`[Job] #${job.seq} ${job.id} got a message from the main chat${input.from === 'review' ? ' (its look at a job update)' : ''}${reopened ? ' (reopened)' : ''}`);
    return {
      ok: true,
      job: { id: job.id, number: job.seq, title: job.title, status: 'active', reopened },
      note: input.from === 'main_chat'
        ? `#${job.seq} acts on it now in its own thread${reopened ? ' (it had ended, so it is open again)' : ''}; its reply comes back to this chat as "#${job.seq} replied". Tell the owner in one short line what you passed on.`
        : `#${job.seq} acts on it now in its own thread.`,
    };
  }

  function postReply(jobId: string, text: string): void {
    const job = jobs.get(jobId);
    const body = String(text ?? '').trim();
    if (!job?.seq || !body) return;
    whenMainIsFree(() => {
      // ref_job_id marks it: the panel labels it "from #N", like the reply to a #N message typed in the main chat.
      insertMain.run(rowId('asst'), 'assistant', body, jobId);
      addToMainHistory(`Job #${job.seq} "${job.title}" replied to the main chat's message:\n\n${body}`);
      deps.bump();
    });
  }

  async function continueJob(jobId: string, input: { from: JobDeskSource }): Promise<JobMessageResult> {
    const job = jobs.get(jobId);
    const refused = refusalFor(job, input.from);
    if (refused || !job) return refused!;
    // A question waits for an answer: the main chat answers it (message) or leaves it for the owner.
    if (input.from === 'review' && job.pausedAt && job.pauseKind === 'question') {
      return refuse('needs_answer', `#${job.seq} asks a question; carrying on would skip it.`, 'Answer it with jobs message when the answer is yours to give, or leave it for the owner.');
    }
    const continued = jobs.continueJob(jobId, { from: input.from });
    if (!continued) {
      return refuse('nothing_to_continue', `#${job.seq} is not paused: it is already working or waiting for its runs.`, 'Nothing to do: say in one line that it carries on by itself.');
    }
    showInThread(job, input.from === 'review' ? '↪ The main chat looked at this job and kept it going as it is.' : '↪ From the main chat: carry on.');
    deps.request(jobId);
    deps.bump();
    log(`[Job] #${job.seq} ${job.id} kept going by the main chat${input.from === 'review' ? ` (round ${continued.supervisions} of ${MAX_REVIEW_ROUNDS})` : ''}`);
    return {
      ok: true,
      job: { id: job.id, number: job.seq, title: job.title, status: 'active', reopened: job.status !== 'active' },
      note: `#${job.seq} carries on now in its own thread${job.pauseKind === 'limit' ? ', with a fresh round of automatic turns' : ''}.`,
    };
  }

  function askOwner(jobId: string, question: string, options: string[]): JobMessageResult {
    const job = jobs.get(jobId);
    // Asking the owner is always open to the main chat's look, its rounds used up included: it hands the decision to him.
    const refused = refusalFor(job, 'review');
    if (refused && !(refused.ok === false && refused.code === 'rounds_used')) return refused;
    if (!job) return refuse('job_not_found', 'There is no such job.', 'Call jobs {"action":"list"} for the jobs and their numbers.');
    const text = String(question ?? '').trim();
    if (!text) return refuse('empty_message', 'The question is empty.', 'Write the question the owner should answer.');
    const asked = jobs.askOwner(jobId, text, options);
    if (!asked) return refuse('not_delivered', `#${job.seq} already asks the owner something, or the owner paused it.`, 'Leave it as it is and say so in one line.');
    showInThread(job, `↪ The main chat looked at this job and asks you: ${text}`);
    deps.bump();
    log(`[Job] #${job.seq} ${job.id}: the main chat asks the owner`);
    return {
      ok: true,
      job: { id: job.id, number: job.seq, title: job.title, status: 'active', reopened: false },
      note: `The owner sees the question on #${job.seq}'s card with ${asked.options?.length ? 'its one-tap answers' : 'an Answer button'}; the job carries on when they answer.`,
    };
  }

  function postUpdateLine(jobId: string, line: string): void {
    const job = jobs.get(jobId);
    const text = String(line ?? '').trim();
    if (!job?.seq || !text) return;
    whenMainIsFree(() => {
      // ref_job_id marks it as being about the job; the card under it shows what the job is doing now.
      insertMain.run(rowId('job'), 'assistant', `${text}\n\n${jobCardMarker(jobId, 'update')}`, jobId);
      addToMainHistory(text);
      deps.bump();
    });
  }

  function flush(): void {
    if (deps.mainOwnerTurnActive()) return;
    for (const post of waiting.splice(0)) {
      try { post(); } catch (error: any) { log(`[JobDesk] post failed: ${error?.message ?? error}`); }
    }
    deliverReports();
  }

  async function ownerTurnEnded(jobId: string): Promise<void> {
    const waitingMessages = queuedForJob.get(jobId);
    if (!waitingMessages?.length) return;
    // Another owner turn in the thread began meanwhile: the messages wait for that one to end too.
    if (deps.ownerTurnInJob(jobId)) return;
    queuedForJob.delete(jobId);
    for (const message of waitingMessages) {
      try {
        const result = await messageJob(jobId, message.text, { from: 'main_chat', ...(message.ownerWords ? { ownerWords: message.ownerWords } : {}) });
        if (!result.ok) log(`[JobDesk] a waiting message from the main chat did not reach ${jobId}: ${result.code}`);
      } catch (error: any) {
        log(`[JobDesk] a waiting message from the main chat did not reach ${jobId}: ${error?.message ?? error}`);
      }
    }
  }

  return {
    deliverReports,
    noteReportShown: (jobId) => { shownInMain.add(jobId); },
    messageJob,
    continueJob,
    askOwner,
    postReply,
    postUpdateLine,
    flush,
    ownerTurnEnded,
  };
}
