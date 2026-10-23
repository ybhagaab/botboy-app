/**
 * Google Calendar in chat (google-workspace.md, "Calendar"):
 *
 *   gcalendar {action: calendars | events | event, calendarId?, from?, to?, query?, eventId?, limit?}
 *   gcalendar {action: create | update | delete | respond, calendarId?, eventId?, summary?, start?, end?,
 *                   durationMinutes?, allDay?, timeZone?, location?, description?, attendees?, notify?,
 *                   meet?, recurrence?, reminders?, response?, ownerRequested}
 *
 * Times: "2026-10-23T15:00" is local to timeZone (default: this Mac's zone),
 * "2026-10-23T15:00:00Z" or "+05:30" is exact, "2026-10-23" is all day.
 * An event that involves other people (attendees, a reply to an invitation,
 * or a change to an event that has guests) reaches them: an owner-turn action.
 * A new event's id comes from the request, so a create Google answered
 * unclearly is never made twice.
 */

import { createHash } from 'crypto';
import type { ToolResult } from './tool-executor.js';
import { redactSecrets } from './sensitive-files.js';
import type { CalendarClient, CalendarEvent, CalendarEventTime, CalendarSendUpdates } from './google-workspace-api.js';
import { googleErrorFailure, googleResult, invalid, trimmed, untrustedEnvelope, type GoogleTier } from './google-tool-support.js';
import { accountEmail, failedResult, singleAccountFor, type GoogleToolEnv } from './google-tool-env.js';
import { GoogleApiError } from './gmail-api.js';

const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const EXACT_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A Calendar time from the tool's text. */
export function eventTime(value: string, timeZone: string): CalendarEventTime | null {
  const raw = value.trim();
  if (DATE_ONLY.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) return { date: raw };
  if (EXACT_TIME.test(raw) && !Number.isNaN(Date.parse(raw))) return { dateTime: raw };
  if (LOCAL_TIME.test(raw) && !Number.isNaN(Date.parse(`${raw}Z`))) return { dateTime: raw.length === 16 ? `${raw}:00` : raw, timeZone };
  return null;
}

/** The day after a date (an all-day event ends the next day). */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** A local "YYYY-MM-DDTHH:MM" plus minutes, still local. */
function addMinutesLocal(local: string, minutes: number): string {
  const d = new Date(`${local}Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 19);
}

/** An exact ISO time plus minutes, keeping its offset text. */
function addMinutesExact(exact: string, minutes: number): string {
  const offset = exact.match(/(Z|[+-]\d{2}:\d{2})$/)?.[1] ?? 'Z';
  const shift = offset === 'Z' ? 0 : (offset.startsWith('-') ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const d = new Date(Date.parse(exact) + (minutes + shift) * 60_000);
  return `${d.toISOString().slice(0, 19)}${offset}`;
}

/** Bounds for a list: a date means its start (from) or its end (to); a local time is read in timeZone's offset now. */
function boundOf(value: string, end: boolean): string | null {
  const raw = value.trim();
  if (DATE_ONLY.test(raw)) return end ? `${nextDay(raw)}T00:00:00Z` : `${raw}T00:00:00Z`;
  if (EXACT_TIME.test(raw) && !Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString();
  if (LOCAL_TIME.test(raw)) return new Date(`${raw.length === 16 ? `${raw}:00` : raw}`).toISOString();
  return null;
}

function compactEvent(event: CalendarEvent): Record<string, unknown> {
  const others = (event.attendees ?? []).filter(attendee => !attendee.self);
  return {
    eventId: event.id,
    summary: redactSecrets(event.summary ?? '(no title)'),
    start: event.start?.dateTime ?? event.start?.date,
    end: event.end?.dateTime ?? event.end?.date,
    ...(event.start?.timeZone ? { timeZone: event.start.timeZone } : {}),
    ...(event.location ? { location: redactSecrets(event.location) } : {}),
    ...(event.status && event.status !== 'confirmed' ? { status: event.status } : {}),
    ...(others.length ? { attendees: others.map(attendee => `${attendee.email ?? attendee.displayName ?? ''}${attendee.responseStatus ? ` (${attendee.responseStatus})` : ''}`) } : {}),
    ...((event.attendees ?? []).find(attendee => attendee.self)?.responseStatus ? { myResponse: (event.attendees ?? []).find(attendee => attendee.self)!.responseStatus } : {}),
    ...(event.organizer?.self === false && event.organizer.email ? { organizer: event.organizer.email } : {}),
    ...(event.hangoutLink ? { meet: event.hangoutLink } : {}),
    ...(event.recurringEventId ? { recurring: true } : event.recurrence?.length ? { recurrence: event.recurrence } : {}),
    ...(event.htmlLink ? { link: event.htmlLink } : {}),
  };
}

function calendarOf(env: GoogleToolEnv, accountId: string): CalendarClient | null {
  return env.workspaceFor(accountId)?.calendar ?? null;
}

export async function calendarRead(env: GoogleToolEnv): Promise<ToolResult> {
  const action = trimmed(env.args.action) || 'events';
  if (!['calendars', 'events', 'event'].includes(action)) return failedResult(env, invalid('action is calendars, events or event.'));
  const picked = singleAccountFor(env, 'calendar');
  if ('failure' in picked) return failedResult(env, picked.failure);
  const calendar = calendarOf(env, picked.id);
  if (!calendar) return failedResult(env, { code: 'unavailable', message: 'Google Calendar is unavailable in this BotBoy build.', effect: 'none', nextAction: 'Tell the owner.' });
  const calendarId = trimmed(env.args.calendarId) || 'primary';
  try {
    if (action === 'calendars') {
      const calendars = await calendar.listCalendars();
      return googleResult(env.call, untrustedEnvelope(env.now(), 'gcalendar', { account: accountEmail(env, picked.id) }, {
        ok: true,
        calendars: calendars.map(entry => ({ calendarId: entry.id, name: redactSecrets(entry.summary ?? ''), ...(entry.primary ? { primary: true } : {}), access: entry.accessRole, timeZone: entry.timeZone })),
      }));
    }
    if (action === 'event') {
      const eventId = trimmed(env.args.eventId);
      if (!eventId) return failedResult(env, invalid('event needs eventId (from action events).'));
      const event = await calendar.getEvent(calendarId, eventId);
      return googleResult(env.call, untrustedEnvelope(env.now(), 'gcalendar', { account: accountEmail(env, picked.id), calendarId }, {
        ok: true,
        event: { ...compactEvent(event), ...(event.description ? { description: redactSecrets(event.description).slice(0, 8000) } : {}), ...(event.reminders ? { reminders: event.reminders } : {}) },
      }));
    }
    const from = trimmed(env.args.from);
    const to = trimmed(env.args.to);
    const timeMin = from ? boundOf(from, false) : new Date(env.now()).toISOString();
    const timeMax = to ? boundOf(to, true) : new Date(env.now() + 7 * 86_400_000).toISOString();
    if (!timeMin || !timeMax) return failedResult(env, invalid('from and to are dates (2026-10-23) or times (2026-10-23T09:00, or with Z / +05:30).'));
    const limit = env.args.limit === undefined ? 25 : Number(env.args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return failedResult(env, invalid('limit is a whole number from 1 to 100.'));
    const listed = await calendar.listEvents(calendarId, { timeMin, timeMax, ...(trimmed(env.args.query) ? { q: trimmed(env.args.query).slice(0, 200) } : {}), maxResults: limit });
    return googleResult(env.call, untrustedEnvelope(env.now(), 'gcalendar', { account: accountEmail(env, picked.id), calendarId, from: timeMin, to: timeMax }, {
      ok: true,
      calendarId,
      ...(listed.timeZone ? { timeZone: listed.timeZone } : {}),
      events: listed.items.map(compactEvent),
      ...(listed.nextPageToken ? { more: true, note: `More events than ${limit}; narrow from/to or raise limit.` } : {}),
    }));
  } catch (error) {
    return failedResult(env, googleErrorFailure(error, false, 'Google Calendar read'));
  }
}

const ACTIONS = ['create', 'update', 'delete', 'respond'] as const;

/** The tier from the arguments alone; a change to an event with guests is caught again after it is read. */
export function calendarEditTier(args: Record<string, unknown>): GoogleTier {
  const action = trimmed(args.action);
  if (action === 'respond') return 'reach';
  if (Array.isArray(args.attendees) && args.attendees.length) return 'reach';
  if (args.notify === true) return 'reach';
  return 'write';
}

/** A Calendar event id from the request, so a repeat finds the same event (base32hex: a–v, 0–9). */
function eventIdFor(key: string): string {
  return createHash('sha256').update(key).digest('hex').replace(/[w-z]/g, '0').slice(0, 32);
}

export async function calendarEdit(env: GoogleToolEnv): Promise<ToolResult> {
  const action = trimmed(env.args.action) as typeof ACTIONS[number];
  if (!ACTIONS.includes(action)) return failedResult(env, invalid('action is create, update, delete or respond.'));
  const picked = singleAccountFor(env, 'calendar');
  if ('failure' in picked) return failedResult(env, picked.failure);
  const calendar = calendarOf(env, picked.id);
  if (!calendar) return failedResult(env, { code: 'unavailable', message: 'Google Calendar is unavailable in this BotBoy build.', effect: 'none', nextAction: 'Tell the owner.' });
  const calendarId = trimmed(env.args.calendarId) || 'primary';
  const timeZone = trimmed(env.args.timeZone) || systemTimeZone();
  if (!validTimeZone(timeZone)) return failedResult(env, invalid('timeZone is an IANA zone like "Asia/Kolkata" or "America/Los_Angeles".'));
  const issues: Array<{ path: string; message: string }> = [];
  const patch: CalendarEvent = {};
  if (typeof env.args.summary === 'string') patch.summary = env.args.summary.trim().slice(0, 1000);
  if (typeof env.args.description === 'string') patch.description = env.args.description.slice(0, 8000);
  if (typeof env.args.location === 'string') patch.location = env.args.location.trim().slice(0, 1000);
  const startText = trimmed(env.args.start);
  const endText = trimmed(env.args.end);
  const duration = env.args.durationMinutes === undefined ? undefined : Number(env.args.durationMinutes);
  if (duration !== undefined && (!Number.isInteger(duration) || duration < 1 || duration > 14 * 24 * 60)) issues.push({ path: 'durationMinutes', message: 'whole minutes, 1 to 20,160' });
  if (startText) {
    const start = eventTime(startText, timeZone);
    if (!start) issues.push({ path: 'start', message: 'a date (2026-10-23) for all day, or a time (2026-10-23T15:00, or with Z / +05:30)' });
    else {
      patch.start = start;
      let end: CalendarEventTime | null = null;
      if (endText) end = eventTime(endText, timeZone);
      else if (start.date) end = { date: nextDay(start.date) };
      else if (start.dateTime) end = start.timeZone ? { dateTime: addMinutesLocal(start.dateTime.slice(0, 19), duration ?? 60), timeZone } : { dateTime: addMinutesExact(start.dateTime, duration ?? 60) };
      if (!end) issues.push({ path: 'end', message: 'a date or time like start' });
      else {
        // An all-day end that is the same day means one day.
        if (start.date && end.date && end.date <= start.date) end = { date: nextDay(start.date) };
        if (Boolean(start.date) !== Boolean(end.date)) issues.push({ path: 'end', message: 'all-day start and end are both dates; timed start and end are both times' });
        else if (end.dateTime && start.dateTime && !start.timeZone && !end.timeZone && Date.parse(end.dateTime) <= Date.parse(start.dateTime)) issues.push({ path: 'end', message: 'must be after start' });
        else if (end.dateTime && start.dateTime && start.timeZone && end.timeZone && end.dateTime <= start.dateTime) issues.push({ path: 'end', message: 'must be after start' });
        patch.end = end;
      }
    }
  } else if (endText) issues.push({ path: 'start', message: 'give start with end' });
  if (env.args.attendees !== undefined) {
    if (!Array.isArray(env.args.attendees) || env.args.attendees.length > 100) issues.push({ path: 'attendees', message: 'a list of up to 100 email addresses' });
    else {
      const emails = env.args.attendees.map(value => String(value ?? '').trim().toLowerCase());
      const bad = emails.filter(email => !EMAIL.test(email));
      if (bad.length) issues.push({ path: 'attendees', message: `not email addresses: ${bad.slice(0, 5).join(', ')}` });
      patch.attendees = emails.map(email => ({ email }));
    }
  }
  if (env.args.recurrence !== undefined) {
    if (!Array.isArray(env.args.recurrence) || !env.args.recurrence.every(rule => typeof rule === 'string' && /^(?:RRULE|EXRULE|RDATE|EXDATE)[:;]/.test(rule))) issues.push({ path: 'recurrence', message: 'a list of RFC 5545 lines like "RRULE:FREQ=WEEKLY;BYDAY=MO"' });
    else patch.recurrence = env.args.recurrence as string[];
  }
  if (env.args.reminders !== undefined) {
    if (!Array.isArray(env.args.reminders) || env.args.reminders.length > 5 || !env.args.reminders.every(minutes => Number.isInteger(Number(minutes)) && Number(minutes) >= 0 && Number(minutes) <= 40_320)) issues.push({ path: 'reminders', message: 'up to 5 reminder times in minutes before, like [10, 60]' });
    else patch.reminders = { useDefault: false, overrides: (env.args.reminders as unknown[]).map(minutes => ({ method: 'popup', minutes: Number(minutes) })) };
  }
  if (issues.length) return failedResult(env, invalid('Some arguments need fixing.', issues));
  const inJob = env.context?.callerKind === 'continuation';
  try {
    if (action === 'create') {
      if (!patch.summary || !patch.start) return failedResult(env, invalid('create needs summary and start (and end or durationMinutes; default 1 hour).'));
      const meet = env.args.meet === true;
      const key = `${env.context?.ownerRequestId ?? env.context?.jobMandate?.jobId ?? ''}|${JSON.stringify({ ...env.args, ownerRequested: undefined })}`;
      const id = eventIdFor(key);
      const notify: CalendarSendUpdates = patch.attendees?.length && env.args.notify !== false ? 'all' : 'none';
      const body: CalendarEvent = {
        ...patch,
        id,
        ...(meet ? { conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
      };
      let event: CalendarEvent;
      try {
        event = await calendar.insertEvent(calendarId, body, { sendUpdates: notify, conference: meet });
      } catch (error) {
        // The same id again: the first create landed.
        if (error instanceof GoogleApiError && error.status === 409) event = await calendar.getEvent(calendarId, id);
        else throw error;
      }
      return googleResult(env.call, { ok: true, tool: 'gcalendar', status: 'created', account: accountEmail(env, picked.id), calendarId, event: compactEvent(event), ...(notify === 'all' ? { invited: patch.attendees!.map(attendee => attendee.email) } : {}) });
    }
    const eventId = trimmed(env.args.eventId);
    if (!eventId) return failedResult(env, invalid(`${action} needs eventId (from gcalendar action events).`));
    const current = await calendar.getEvent(calendarId, eventId);
    const guests = (current.attendees ?? []).filter(attendee => !attendee.self);
    // Guests see an update, a deletion or a reply: that reaches people, so it is the owner's call.
    if (inJob && (guests.length || action === 'respond')) {
      return failedResult(env, { code: 'outside_job_mandate', message: 'This event has guests, so changing it reaches them; that needs the owner’s ask in chat.', effect: 'none', nextAction: 'Finish what the job allows, then tell the owner what you would change on this event.' });
    }
    const notify: CalendarSendUpdates = env.args.notify === false ? 'none' : guests.length || patch.attendees?.length ? 'all' : 'none';
    if (action === 'delete') {
      await calendar.deleteEvent(calendarId, eventId, { sendUpdates: notify });
      return googleResult(env.call, { ok: true, tool: 'gcalendar', status: 'deleted', account: accountEmail(env, picked.id), calendarId, event: compactEvent(current), ...(notify === 'all' && guests.length ? { notified: guests.map(guest => guest.email) } : {}) });
    }
    if (action === 'respond') {
      const response = trimmed(env.args.response);
      if (!['accepted', 'declined', 'tentative'].includes(response)) return failedResult(env, invalid('respond needs response: accepted, declined or tentative.'));
      const me = (current.attendees ?? []).find(attendee => attendee.self);
      if (!me) return failedResult(env, invalid('The owner is not a guest of this event, so there is nothing to answer.'));
      const attendees = (current.attendees ?? []).map(attendee => (attendee.self ? { ...attendee, responseStatus: response } : attendee));
      const event = await calendar.patchEvent(calendarId, eventId, { attendees }, { sendUpdates: env.args.notify === false ? 'none' : 'all' });
      return googleResult(env.call, { ok: true, tool: 'gcalendar', status: 'responded', account: accountEmail(env, picked.id), calendarId, response, event: compactEvent(event) });
    }
    if (!Object.keys(patch).length && env.args.meet !== true) return failedResult(env, invalid('update needs at least one field to change (summary, start, end, location, description, attendees, recurrence, reminders, meet).'));
    if (patch.attendees) {
      // Adding to the guest list keeps the guests already there (and their answers).
      const existing = new Map((current.attendees ?? []).map(attendee => [String(attendee.email ?? '').toLowerCase(), attendee]));
      for (const attendee of patch.attendees) if (!existing.has(String(attendee.email))) existing.set(String(attendee.email), attendee);
      patch.attendees = env.args.replaceAttendees === true ? patch.attendees : [...existing.values()];
    }
    if (env.args.meet === true && !current.hangoutLink) {
      patch.conferenceData = { createRequest: { requestId: eventIdFor(`${eventId}|meet`), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
    }
    const event = await calendar.patchEvent(calendarId, eventId, patch, { sendUpdates: notify, conference: env.args.meet === true });
    return googleResult(env.call, { ok: true, tool: 'gcalendar', status: 'updated', account: accountEmail(env, picked.id), calendarId, event: compactEvent(event), ...(notify === 'all' ? { notified: (event.attendees ?? []).filter(attendee => !attendee.self).map(attendee => attendee.email) } : {}) });
  } catch (error) {
    return failedResult(env, googleErrorFailure(error, true, 'Google Calendar change'));
  }
}
