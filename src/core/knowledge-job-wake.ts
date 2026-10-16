/**
 * Waking a job that paused for a decision on a Knowledge card (docs/maps/knowledge-library.md K21, job-continuations.md).
 *
 * A job ends a turn with job_update needs_owner when only the owner can go on, for example "review the proposal in
 * Settings → Knowledge". The owner then decides on the card on that page. Nothing connected that click to the job: the
 * only things that wake a paused job are a chat message and a watched ETL run, so the job kept saying "paused, needs you"
 * after the owner had applied the very change it asked about (owner report 2026-10-16).
 *
 * This is the missing link, and it reads STATE, not events, so one function serves the click, the boot and a retry:
 *   - the active job is paused for the owner and has no continuation due;
 *   - the changes created while the job ran and before it paused are its "era" (what the pausing turn could have staged);
 *   - none of the era is still open (staged, held, stale, revising), and at least one was applied or dismissed AFTER the
 *     pause, so something the job asked for really was decided.
 * Then the job is woken: the pause is cleared and a continuation turn is due, with the decision as the stated reason. The
 * continuation machinery (chat-continuations.ts) runs that turn under the job mandate like any other; the model finishes
 * the job (job_update done), or reacts to a dismissal. Waiting for the LAST open card makes one wake-up, not one per card.
 */
import type { ChatJob, ChatJobStore } from './chat-jobs.js';
import type { KnowledgeChange, KnowledgeChangeStore } from './knowledge-changes.js';

/** Separates the one-sentence headline (the chat note) from the details in the stored reason. Stripped before the model sees it. */
export const DECISION_SEPARATOR = ' ¦ ';

const OPEN = ['staged', 'held', 'stale', 'revising'] as const;
const DECIDED = ['applied', 'dismissed'] as const;

export interface JobWake {
  jobId: string;
  reason: string;
  applied: string[];
  dismissed: string[];
}

/** A change as the owner knows it: "Create the set x" or "Edit orders.md in shop-data". */
export function describeChange(change: Pick<KnowledgeChange, 'kind' | 'setName' | 'file' | 'mode'>): string {
  if (change.kind === 'create_set') return `Create the set ${change.setName}`;
  const verb = change.mode === 'append' ? 'Add to' : change.mode === 'replace' ? 'Replace' : change.mode === 'create' ? 'Create' : 'Edit';
  return change.file ? `${verb} ${change.file} in ${change.setName}` : `${verb} the set ${change.setName}`;
}

const quoted = (names: string[]) => names.map((name) => `"${name}"`).join(', ');

/** The job's era of changes and what became of them, or null when this job is not waiting on a decision that was made. */
export function decisionsForPausedJob(job: ChatJob | null, changes: KnowledgeChangeStore): JobWake | null {
  if (!job || job.status !== 'active' || !job.pausedAt || job.continueRequestedAt) return null;
  const pausedAt = job.pausedAt;
  const everything = changes.list({ statuses: [...OPEN, ...DECIDED, 'expired'], limit: 200 });
  const era = everything.filter((change) => change.createdAt >= job.createdAt && change.createdAt <= pausedAt);
  if (era.length === 0) return null;
  if (era.some((change) => (OPEN as readonly string[]).includes(change.status))) return null;
  const decided = era.filter((change) => (DECIDED as readonly string[]).includes(change.status) && change.decidedAt !== null && change.decidedAt >= pausedAt);
  if (decided.length === 0) return null;
  const applied = decided.filter((change) => change.status === 'applied').map(describeChange);
  const dismissed = decided.filter((change) => change.status === 'dismissed').map(describeChange);
  const others = everything.filter((change) => (OPEN as readonly string[]).includes(change.status) && !era.includes(change)).length;
  const headline = applied.length && dismissed.length
    ? `The owner decided on the Knowledge changes this job was waiting on: applied ${quoted(applied)}, dismissed ${quoted(dismissed)}.`
    : applied.length
      ? `The owner applied ${quoted(applied)}, which this job was waiting on.`
      : `The owner dismissed ${quoted(dismissed)}, which this job was waiting on.`;
  const detail = [
    applied.length ? 'Applied changes are saved in the Knowledge library now (Settings → Knowledge → History has the diff and an Undo).' : '',
    dismissed.length ? 'Dismissed changes wrote nothing.' : '',
    others ? `${others} other Knowledge change${others === 1 ? ' still waits' : 's still wait'} for the owner.` : '',
    'If this is not the answer the job was waiting for, ask again with job_update needs_owner.',
  ].filter(Boolean).join(' ');
  return { jobId: job.id, reason: `${headline}${DECISION_SEPARATOR}${detail}`, applied, dismissed };
}

export interface KnowledgeJobWaker {
  /** Wakes the paused job when the decisions it waited for are in. Returns what it did, or null. Never throws. */
  wakeIfDecided(): JobWake | null;
}

export function createKnowledgeJobWaker(options: {
  jobs: ChatJobStore | undefined;
  changes: KnowledgeChangeStore | undefined;
  /** Asks the continuation runner for a prompt tick (it also finds a due continuation on its own interval). */
  request?: (jobId: string) => void;
  log?: (message: string) => void;
}): KnowledgeJobWaker {
  const log = options.log ?? ((message: string) => console.log(message));
  return {
    wakeIfDecided() {
      try {
        if (!options.jobs || !options.changes) return null;
        const found = decisionsForPausedJob(options.jobs.activeJob(), options.changes);
        if (!found) return null;
        const woken = options.jobs.wake(found.jobId, found.reason);
        if (!woken) return null;
        log(`[Job] ${found.jobId} woken: ${found.reason.split(DECISION_SEPARATOR)[0]}`);
        try { options.request?.(found.jobId); } catch { /* the runner's own interval finds the due continuation */ }
        return found;
      } catch (error: any) {
        log(`[Job] could not check whether a paused job's Knowledge decision was made: ${String(error?.message ?? error).slice(0, 160)}`);
        return null;
      }
    },
  };
}
