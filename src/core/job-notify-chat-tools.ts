/**
 * `job_notify` (docs/maps/job-notify.md): the owner asks, in chat, to be told on WhatsApp when a job needs them or ends.
 *
 *   job_notify { action: 'on' | 'off' | 'status' }
 *
 * The tool only RECORDS the owner's request on the job and proves it can be kept; BotBoy's own notifier (job-notifier.ts) sends the
 * messages later, with no model turn. That is the whole point: the old failure was a model promising, in a live turn, something
 * only a later automatic turn could do, and automatic turns have no WhatsApp tool.
 *
 * Authority: a live owner turn only (`callerKind` interactive, the owner's own message). Not in job-mandate.ts, so a continuation
 * never sees it and a job cannot turn updates on or off for itself. The destination is never an argument: the notifier sends to the
 * owner's BotBoy chat from Connections → WhatsApp, and nowhere else.
 * Execution: `on` arms updates only after a confirmation message actually reached the BotBoy chat, so BotBoy can never tell the
 * owner "I will message you" when it cannot. If WhatsApp is not ready it arms nothing and says what to do.
 */
import type { ChatJob, ChatJobStore } from './chat-jobs.js';
import { confirmationMessage, resolveDestination, type JobNotifier } from './job-notifier.js';
import type { ToolCall } from './llm-client.js';
import type { ToolExecutionContext, ToolExecutor, ToolResult } from './tool-executor.js';
import { WhatsAppSendError, type WhatsAppSender } from './whatsapp-send.js';
import { onboardingStep, type WhatsAppConnection } from './whatsapp-connection.js';

export const JOB_NOTIFY_CHAT_TOOL_NAMES = ['job_notify'] as const;

/** The owner's message mentions WhatsApp (or a text/ping/notification) and a job-ish event: the tool is offered on that turn. */
const CHANNEL_WORDS = /\b(?:whats\s*app|whatsap|wa\b|notif\w*|notify|ping|alert|text me|message me|report to me|let me know|tell me|update me|send me (?:a )?(?:report|update|message|summary))\b/i;
const EVENT_WORDS = /\b(?:paus\w*|stop\w*|finish\w*|done|complete\w*|ends?|ended|blocked|stuck|fail\w*|need(?:s)? (?:me|my|input|an answer)|question|when it)\b/i;

/**
 * Whether this live owner turn is about being told on WhatsApp when a job pauses or ends. A heuristic on purpose, like the theme
 * tool's: it only decides whether the tool is OFFERED this turn, and arming is itself confirmed by a real message, so a wrong guess
 * costs one extra tool definition, never a wrong send. An active job whose update the owner asked for earlier is covered by
 * `job.notify` (the tool is also offered then, so the owner can switch it off).
 */
export function asksForJobNotification(message: string, job?: Pick<ChatJob, 'notify'> | null): boolean {
  const text = String(message ?? '');
  if (job?.notify && /\b(?:stop|no more|don'?t|do not|cancel|turn off|disable|mute)\b/i.test(text)) return true;
  return CHANNEL_WORDS.test(text) && EVENT_WORDS.test(text);
}

/** Prompt guidance, added only on turns where the tool is offered. */
export const JOB_NOTIFY_GUIDANCE_BLOCK = [
  '## Telling the owner on WhatsApp when a job needs them or ends',
  '- When the owner asks to be told, messaged, pinged or sent a report on WhatsApp when a job pauses, needs them, finishes or stops, call job_notify with action "on". Do this INSTEAD of promising it yourself: you cannot send WhatsApp messages from the automatic turns that continue a job, but BotBoy itself will, because job_notify records the request.',
  '- job_notify "on" sends the owner one confirmation message first and turns updates on only if that message reached their BotBoy chat. If it returns ok:false, tell the owner exactly what the result says (usually: sign in to WhatsApp Web in BotBoy’s Chrome, then ask again). Never say updates are on unless the result says so.',
  '- BotBoy sends the updates (no turn needed): when the job needs the owner, finishes, is stopped, or expires. The message includes the job’s closing words, so make the last words of a job’s final turn the report the owner should read on a phone: short, plain, the answer first. Do not call whatsapp_send for this.',
  '- If there is no job yet, job_notify "on" starts one from the owner’s message, so ask for the work in the same message or call job_update afterwards. "off" turns updates off; "status" says whether they are on.',
].join('\n');

function reply(call: ToolCall, content: unknown, isError = false): ToolResult {
  return { toolCallId: call.id, content: typeof content === 'string' ? content : JSON.stringify(content, null, 1), isError };
}
function failure(call: ToolCall, code: string, message: string, nextAction: string, extra?: Record<string, unknown>): ToolResult {
  return reply(call, { ok: false, tool: 'job_notify', status: 'failed', code, message, effect: 'none', nextAction, ...(extra ?? {}) }, true);
}

/** True for a receipt of a successful `job_notify` that turned updates on (for the chat route's claim check). */
export function jobNotifyArmed(toolName: string, content: unknown): boolean {
  if (toolName !== 'job_notify' || typeof content !== 'string') return false;
  try {
    const parsed = JSON.parse(content);
    return parsed?.ok === true && parsed?.notify === 'on';
  } catch {
    return false;
  }
}

export function withJobNotifyChatTools(base: ToolExecutor, deps: {
  jobs?: ChatJobStore;
  sender?: WhatsAppSender;
  connection?: WhatsAppConnection;
  notifier?: Pick<JobNotifier, 'nudge'>;
}): ToolExecutor {
  /** One confirmation per request: a repeat call in the same turn returns the first answer instead of messaging twice. */
  const perRequest = new Map<string, ToolResult>();

  return {
    ...base,
    async executeTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
      if (call.function.name !== 'job_notify') return base.executeTool(call, context);
      if (context?.callerKind !== 'interactive' || !context.currentUserMessage?.trim()) {
        return failure(call, 'owner_turn_required', 'WhatsApp updates are turned on or off only from the owner’s own chat message.', 'Do not call job_notify from an automatic turn. Tell the owner to ask in chat.');
      }
      if (!deps.jobs) return failure(call, 'jobs_unavailable', 'Owner jobs are unavailable in this session.', 'Tell the owner updates cannot be turned on right now.');
      let args: Record<string, unknown>;
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { return failure(call, 'invalid_arguments', 'Arguments must be one JSON object.', 'Call again with {"action":"on"}, {"action":"off"} or {"action":"status"}.'); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) return failure(call, 'invalid_arguments', 'Arguments must be one JSON object.', 'Call again with {"action":"on"}, {"action":"off"} or {"action":"status"}.');
      const stray = Object.keys(args).filter(key => key !== 'action');
      const action = String(args.action ?? '');
      if (stray.length || !['on', 'off', 'status'].includes(action)) {
        return failure(call, 'invalid_arguments', stray.length ? `${stray.slice(0, 3).join(', ')} is not an argument of job_notify.` : 'action must be on, off or status.',
          'Send only action: "on", "off" or "status". The destination is always the owner’s BotBoy chat; it cannot be chosen.');
      }

      const requestKey = `${context.ownerRequestId ?? ''}:${action}`;
      if (context.ownerRequestId) {
        const earlier = perRequest.get(requestKey);
        if (earlier) return earlier;
      }
      const remember = (result: ToolResult): ToolResult => {
        if (context.ownerRequestId) {
          perRequest.set(requestKey, result);
          if (perRequest.size > 64) perRequest.delete(perRequest.keys().next().value as string);
        }
        return result;
      };

      const active = deps.jobs.activeJob();
      if (action === 'status') {
        return reply(call, {
          ok: true, tool: 'job_notify', notify: active?.notify ? 'on' : 'off', job: active ? { id: active.id, goal: active.goal.slice(0, 160) } : null,
          nextAction: active ? (active.notify ? 'Updates are on for this job.' : 'Updates are off. Call job_notify with action "on" if the owner asked for them.') : 'There is no active job.',
        });
      }
      if (action === 'off') {
        if (!active) return reply(call, { ok: true, tool: 'job_notify', notify: 'off', job: null, nextAction: 'There is no active job, so nothing is on. Tell the owner.' });
        deps.jobs.setNotify(active.id, false);
        return remember(reply(call, { ok: true, tool: 'job_notify', notify: 'off', job: { id: active.id }, nextAction: 'Tell the owner WhatsApp updates for this job are off.' }));
      }

      // action === 'on'
      if (!deps.sender || !deps.connection) {
        return failure(call, 'whatsapp_unavailable', 'WhatsApp is unavailable in this BotBoy build.', 'Tell the owner WhatsApp updates cannot be turned on.');
      }
      const status = await deps.connection.status().catch(() => null);
      if (!status || status.session !== 'signed_in') {
        const opened = status && status.chrome && !status.tabOpen ? await deps.connection.openWindow().catch(() => false) : false;
        return failure(call, 'whatsapp_not_ready', 'WhatsApp Web is not signed in, so BotBoy cannot send updates yet. Updates were NOT turned on.', 
          `Tell the owner exactly: "${status ? onboardingStep(status) : 'Open Connections → WhatsApp and sign in to WhatsApp Web.'}" Do not say updates are on. Ask again once they have signed in.`,
          { whatsapp: { session: status?.session ?? 'unknown', windowOpened: Boolean(opened) } });
      }
      const destination = await resolveDestination({ sender: deps.sender, connection: deps.connection });
      if (!destination) {
        return failure(call, 'whatsapp_not_ready', 'BotBoy could not find the BotBoy chat in WhatsApp Web. Updates were NOT turned on.',
          'Tell the owner to check Connections → WhatsApp (the BotBoy chat), then ask again. Do not say updates are on.');
      }
      // A job to attach to: the active one, or one made from the owner's message (like job_update continue from an owner turn).
      const job = active ?? deps.jobs.start({ goal: context.currentUserMessage });
      const wasOn = Boolean(job.notify);
      if (wasOn) {
        return remember(reply(call, { ok: true, tool: 'job_notify', notify: 'on', already: true, job: { id: job.id, goal: job.goal.slice(0, 160) }, nextAction: 'Updates were already on for this job; nothing new was sent. Tell the owner.' }));
      }
      // Confirm BEFORE arming: the owner must get a message from BotBoy itself, or nothing is promised.
      try {
        await deps.sender.send({
          contact: destination,
          text: confirmationMessage(job),
          ownerRequestId: `job-notify-confirm:${job.id}`,
          signal: context.abortSignal,
        });
      } catch (error) {
        if (error instanceof WhatsAppSendError && error.effect === 'none') {
          return failure(call, error.code, `${error.message} Updates were NOT turned on.`, `${error.nextAction} Do not say updates are on.`);
        }
        // The confirmation may have reached the phone but WhatsApp did not say so: arm nothing, and say so honestly.
        return failure(call, 'confirmation_unknown', 'BotBoy could not confirm that its WhatsApp message arrived. Updates were NOT turned on.',
          'Tell the owner to look in the BotBoy chat on their phone: if the “Updates are on” message is there, ask again and BotBoy will turn them on; otherwise check Connections → WhatsApp.', { effect: 'unknown' });
      }
      const armed = deps.jobs.setNotify(job.id, true);
      if (!armed) {
        return failure(call, 'job_not_active', 'The job ended before updates could be turned on.', 'Tell the owner; start the work again if they still want it.');
      }
      deps.notifier?.nudge();
      return remember(reply(call, {
        ok: true, tool: 'job_notify', notify: 'on', job: { id: job.id, goal: job.goal.slice(0, 160) }, destination: destination.self ? 'your own WhatsApp chat' : `+${destination.number}`,
        nextAction: 'A confirmation message is in the owner’s BotBoy chat. Tell the owner updates are on: BotBoy will message them when the job needs them, finishes or is stopped. Make the final words of the job’s last turn the report to read on a phone.',
      }));
    },
  };
}
