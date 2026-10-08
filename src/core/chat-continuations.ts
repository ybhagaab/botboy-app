/**
 * Continuation turns: when a watched ETL run finishes after the chat turn
 * that started it has ended, BotBoy continues the job in the same chat on its
 * own (ANALYTICS_AUTONOMY_PLAN.md, owner decision D2, 2026-10-08).
 *
 * The runner starts an ordinary streamed chat turn through an internal call
 * to POST /api/chat/messages. The call carries an in-memory secret, so only
 * this process can start a continuation; the route then runs the turn with
 * callerKind 'continuation' under the job mandate (job-mandate.ts). Model
 * processes cannot reach BotBoy's port at all (Seatbelt), and the secret is
 * never written to env, disk, or logs.
 *
 * One continuation runs at a time. An owner turn in progress goes first, and
 * an owner message preempts a running continuation (chat.ts). The live hub
 * relays the continuation's SSE events to the chat panel (GET /api/chat/live).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CHAT_JOB_MAX_CONTINUATIONS,
  workspaceRelativePath,
  type ChatJob,
  type ChatJobStore,
  type EtlRunWatch,
} from './chat-jobs.js';

export const CONTINUATION_HEADER = 'x-botboy-continuation';
const RETRY_INTERVAL_MS = 5_000;
const MAX_LIVE_EVENTS = 6_000;
const MAX_LIVE_CHARS = 4_000_000;

// ── Live hub ──

export interface ChatLiveTurnInfo {
  turnKey: string;
  jobId: string;
  goal: string;
  note: string;
  startedAt: string;
}

export type ChatLiveMessage =
  | { kind: 'begin'; info: ChatLiveTurnInfo }
  | { kind: 'event'; turnKey: string; event: Record<string, unknown> }
  | { kind: 'end'; turnKey: string };

export interface ChatLiveHub {
  begin(info: ChatLiveTurnInfo): void;
  push(event: Record<string, unknown>): void;
  end(): void;
  current(): { info: ChatLiveTurnInfo; events: Array<Record<string, unknown>>; ended: boolean } | null;
  subscribe(listener: (message: ChatLiveMessage) => void): () => void;
}

export function createChatLiveHub(): ChatLiveHub {
  let info: ChatLiveTurnInfo | null = null;
  let events: Array<Record<string, unknown>> = [];
  let chars = 0;
  let ended = true;
  const listeners = new Set<(message: ChatLiveMessage) => void>();
  const emit = (message: ChatLiveMessage) => {
    for (const listener of [...listeners]) {
      try { listener(message); } catch { /* a broken viewer never stops the turn */ }
    }
  };
  return {
    begin(next) {
      info = next;
      events = [];
      chars = 0;
      ended = false;
      emit({ kind: 'begin', info: next });
    },
    push(event) {
      if (!info || ended) return;
      const size = JSON.stringify(event).length;
      // Replay stays bounded: past the cap only structural events are kept
      // (the final done event carries the authoritative text anyway).
      const structural = event.type !== 'token' && event.type !== 'thinking' && event.type !== 'tool_args';
      if (structural || (events.length < MAX_LIVE_EVENTS && chars + size < MAX_LIVE_CHARS)) {
        events.push(event);
        chars += size;
      }
      emit({ kind: 'event', turnKey: info.turnKey, event });
    },
    end() {
      if (!info || ended) return;
      ended = true;
      emit({ kind: 'end', turnKey: info.turnKey });
    },
    current: () => (info ? { info, events: [...events], ended } : null),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

// ── Request authentication (used by the chat route) ──

/** Constant-time check of the in-memory continuation secret. */
export function continuationSecretMatches(secret: string | undefined, header: string | undefined): boolean {
  if (!secret || header === undefined) return false;
  const supplied = Buffer.from(String(header));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export type ContinuationAuth =
  | { ok: true; job: ChatJob; ordinal: number; note: string }
  | { ok: false; status: 403 | 409; code: 'not_authorized' | 'job_not_active'; error: string };

/**
 * null when the request is not a continuation (no header). A wrong secret,
 * an inactive job, or a malformed body is refused; it never falls through to
 * an owner turn.
 */
export function authenticateContinuationRequest(input: {
  secret?: string;
  header: string | undefined;
  body: Record<string, any>;
  jobs?: ChatJobStore;
}): ContinuationAuth | null {
  if (input.header === undefined) return null;
  if (!continuationSecretMatches(input.secret, input.header)) {
    return { ok: false, status: 403, code: 'not_authorized', error: 'Continuation is not authorized.' };
  }
  const continuation = input.body?.continuation;
  const jobId = typeof continuation?.jobId === 'string' ? continuation.jobId : '';
  const job = jobId && input.jobs ? input.jobs.get(jobId) : null;
  if (!job || job.status !== 'active') {
    return { ok: false, status: 409, code: 'job_not_active', error: 'The job is no longer active.' };
  }
  const ordinal = Number.isInteger(continuation.ordinal) && continuation.ordinal > 0
    ? continuation.ordinal
    : job.continuationCount + 1;
  const note = typeof continuation.note === 'string' ? continuation.note.slice(0, 600) : '';
  return { ok: true, job, ordinal, note };
}

/** Stable owner-request id for one continuation turn (matches chat.ts › normalizeOwnerRequestId). */
export function continuationRequestId(jobId: string, ordinal: number): string {
  return `cont:${jobId.replace(/[^A-Za-z0-9]/g, '')}:${ordinal}`;
}

// ── Trigger text ──

function rowsLabel(watch: EtlRunWatch): string {
  const rows = watch.outcome?.rowCount;
  return rows === undefined ? '' : `${rows} row${rows === 1 ? '' : 's'}`;
}

export function buildContinuationTrigger(
  job: ChatJob,
  finished: EtlRunWatch[],
  allWatches: EtlRunWatch[],
  filesDir?: string,
): { message: string; note: string } {
  const describe = (watch: EtlRunWatch) => {
    const outcome = watch.outcome;
    const purpose = watch.purpose ? ` (${watch.purpose})` : '';
    if (!outcome) return `- Run ${watch.runId}${purpose}: finished.`;
    if (outcome.remoteStatus === 'SUCCESS' && outcome.savedTo && !outcome.error) {
      const where = filesDir ? workspaceRelativePath(outcome.savedTo, filesDir) : outcome.savedTo;
      const columns = outcome.columns?.length ? `; columns: ${outcome.columns.slice(0, 40).join(', ')}` : '';
      return `- Run ${watch.runId}${purpose}: SUCCESS — ${rowsLabel(watch) || 'rows'}, saved to ${where}${columns}.`;
    }
    return `- Run ${watch.runId}${purpose}: ${outcome.remoteStatus}${outcome.error ? ` — ${outcome.error}` : ''}.`;
  };
  const finishedIds = new Set(finished.map(watch => watch.runId));
  const stillRunning = allWatches.filter(watch => watch.status === 'pending' && !finishedIds.has(watch.runId));
  const message = [
    '[Automatic continuation — not a message from the owner]',
    'ETL runs for the job you are working on finished:',
    ...finished.map(describe),
    ...(stillRunning.length ? [`Still running (BotBoy continues again when they finish): ${stillRunning.map(watch => watch.runId).join(', ')}.`] : []),
    'Continue the job from where it stands: use these results, take the next steps, and verify the deliverable. The files above are in the files workspace (run_command starts there; create_data_room_dataset inspect_local_file accepts the path). If a run failed, fix its root cause and run it again. Do not ask the owner to check back.',
  ].join('\n');
  const parts = finished.map((watch) => {
    const status = watch.outcome?.remoteStatus ?? 'finished';
    if (status === 'SUCCESS' && !watch.outcome?.error) return `run ${watch.runId} finished${rowsLabel(watch) ? ` (${rowsLabel(watch)})` : ''}`;
    return `run ${watch.runId} ${status === 'SUCCESS' ? 'finished, download failed' : status.toLowerCase()}`;
  });
  return { message, note: `↻ Continued automatically: ${parts.join('; ')}.` };
}

// ── Runner ──

export interface ContinuationRunnerOptions {
  jobs: ChatJobStore;
  /** http://127.0.0.1:<port>/api/chat/messages */
  url: string;
  secret: string;
  hub: ChatLiveHub;
  /** Any chat turn (owner or continuation) in progress. */
  isTurnActive: () => boolean;
  /** Persist a visible assistant note in the chat. */
  postNote: (text: string) => void;
  filesDir?: string;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  /** How request() schedules a prompt tick (default setImmediate). */
  scheduleTick?: (tick: () => void) => void;
  log?: (message: string) => void;
}

export interface ContinuationRunner {
  request(jobId: string): void;
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  running(): { jobId: string; turnKey: string; startedAt: string } | null;
  /** Drops queued continuations for a job (the owner stopped it). */
  forget(jobId: string): void;
}

export function createContinuationRunner(options: ContinuationRunnerOptions): ContinuationRunner {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((message: string) => console.log(message));
  const requested = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  let stopped = false;
  let current: { jobId: string; turnKey: string; startedAt: string; controller: AbortController } | null = null;
  let turnCounter = 0;

  async function runOne(job: ChatJob, finished: EtlRunWatch[]): Promise<void> {
    const ordinal = job.continuationCount + 1;
    const { message, note } = buildContinuationTrigger(job, finished, options.jobs.watchesForJob(job.id), options.filesDir);
    const controller = new AbortController();
    const turnKey = `cont-${++turnCounter}-${Date.now()}`;
    let response: Response;
    try {
      response = await fetchImpl(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [CONTINUATION_HEADER]: options.secret },
        body: JSON.stringify({
          message,
          stream: true,
          ...(job.modelKey ? { model: job.modelKey } : {}),
          thinking: job.thinking,
          continuation: { jobId: job.id, ordinal, note },
        }),
        signal: controller.signal,
      });
    } catch (error: any) {
      // Nothing started; the watcher re-announces the runs next tick.
      log(`[Continuation] job ${job.id} could not reach the chat route: ${String(error?.message ?? error).slice(0, 200)}`);
      return;
    }
    if (!response.ok || !response.body) {
      let code = '';
      let detail = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(await response.text());
        code = String(parsed?.code ?? '');
        detail = String(parsed?.error || detail);
      } catch { /* keep the status */ }
      if (code === 'owner_turn_active') {
        requested.add(job.id); // the owner goes first; try again next tick
        return;
      }
      if (code === 'job_not_active') return; // stopped or finished meanwhile
      for (const watch of finished) options.jobs.consumeWatch(watch.runId);
      options.postNote(`${note}\n\nBotBoy could not continue on its own (${detail}). Reply in chat to continue the job.`);
      log(`[Continuation] job ${job.id} could not start: ${detail}`);
      return;
    }
    // The turn is admitted: these results are now its to use.
    for (const watch of finished) options.jobs.consumeWatch(watch.runId);
    options.jobs.incrementContinuations(job.id);
    current = { jobId: job.id, turnKey, startedAt: new Date().toISOString(), controller };
    options.hub.begin({ turnKey, jobId: job.id, goal: job.goal, note, startedAt: current.startedAt });
    log(`[Continuation] job ${job.id} #${ordinal}: ${note}`);
    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try { options.hub.push(JSON.parse(line.slice(6))); } catch { /* not JSON: skip */ }
        }
      }
    } catch (error: any) {
      if (!controller.signal.aborted) log(`[Continuation] job ${job.id} stream failed: ${String(error?.message ?? error).slice(0, 200)}`);
    } finally {
      options.hub.end();
      current = null;
    }
  }

  async function tick(): Promise<void> {
    if (busy || stopped || !requested.size) return;
    if (options.isTurnActive()) return; // the owner goes first; retry next tick
    const jobId = requested.values().next().value as string;
    requested.delete(jobId);
    const job = options.jobs.get(jobId);
    if (!job || job.status !== 'active') return;
    const finished = options.jobs.unconsumedFinished(jobId);
    if (!finished.length) return; // an owner turn already used the results
    if (job.continuationCount >= CHAT_JOB_MAX_CONTINUATIONS) {
      options.jobs.end(jobId, 'stopped', `paused after ${CHAT_JOB_MAX_CONTINUATIONS} automatic continuations`);
      options.postNote(`↻ I paused the job "${job.goal.slice(0, 160)}" after ${CHAT_JOB_MAX_CONTINUATIONS} automatic continuations. Its latest run results are ready; reply in chat to continue.`);
      return;
    }
    busy = true;
    try {
      await runOne(job, finished);
    } finally {
      busy = false;
    }
  }

  return {
    request(jobId) {
      if (stopped) return;
      requested.add(jobId);
      (options.scheduleTick ?? setImmediate)(() => { void tick(); });
    },
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => { void tick(); }, options.intervalMs ?? RETRY_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      current?.controller.abort();
    },
    tick,
    running: () => (current ? { jobId: current.jobId, turnKey: current.turnKey, startedAt: current.startedAt } : null),
    forget(jobId) {
      requested.delete(jobId);
    },
  };
}

// ── Bridge between index.ts and the chat router ──

/**
 * The continuation seam: index.ts creates it (secret + live hub), the chat
 * router reports whether a turn is running, and index.ts binds the runner
 * once the server port is known. Kept in memory only.
 */
export interface ContinuationBridge {
  readonly secret: string;
  readonly hub: ChatLiveHub;
  bindTurnProbe(probe: () => boolean): void;
  isTurnActive(): boolean;
  bindRunner(runner: ContinuationRunner): void;
  runner(): ContinuationRunner | undefined;
}

export function createContinuationBridge(): ContinuationBridge {
  const secret = randomBytes(32).toString('hex');
  const hub = createChatLiveHub();
  let probe: (() => boolean) | undefined;
  let boundRunner: ContinuationRunner | undefined;
  return {
    secret,
    hub,
    bindTurnProbe(next) { probe = next; },
    isTurnActive: () => probe?.() ?? false,
    bindRunner(next) { boundRunner = next; },
    runner: () => boundRunner,
  };
}
