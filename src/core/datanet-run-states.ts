/**
 * Datanet's job run states, exactly as Datanet's own service model lists them (DatanetServicePythonClient,
 * `com.amazon.datanet.model.jobrun.JobRun.status`, the enum the A2 Analytics connector deserializes; read 2026-11-14 from
 * A2AnalyticsAgent-1.0). Owner direction 2026-11-14: "botboy should recognize cancelling & cancelled states, and the right states".
 *
 * There is no KILLED: Datanet's KILL_SESSION and CANCEL actions end a run as CANCELLING, then CANCELLED (live 2026-11-14: job
 * #5's three stopped runs all read CANCELLED, and no watched run ever read KILLED). Every reader of a run status uses these sets,
 * so a stopped run ends everywhere at once: the query list, the stop's check, job watches and the runners.
 */
export const DATANET_RUN_STATES = Object.freeze([
  'NEW',
  'WAITING_FOR_DEPENDENCIES',
  'WAITING_FOR_RESOURCES',
  'RUNNABLE',
  'EXECUTING',
  'DCS_RECEIVING_DATA',
  'PUBLISHABLE',
  'PUBLISHING',
  'SUCCESS',
  'ERROR',
  'DELETED',
  'CANCELLED',
  'CANCELLING',
] as const);
export type DatanetRunState = (typeof DATANET_RUN_STATES)[number];

/** A run in one of these has ended: nothing more happens to it. */
export const DATANET_TERMINAL_STATES: ReadonlySet<string> = new Set(['SUCCESS', 'ERROR', 'DELETED', 'CANCELLED']);

/** A stop is under way: Datanet took a KILL_SESSION or CANCEL and is ending the run (it reads CANCELLED next). */
export const DATANET_STOPPING_STATE = 'CANCELLING';

/** A run in one of these still holds its job (a scratch pair is busy): every state that is not terminal. */
export const DATANET_IN_FLIGHT_STATES: ReadonlySet<string> = new Set(DATANET_RUN_STATES.filter(state => !DATANET_TERMINAL_STATES.has(state)));

const normalized = (status: unknown) => String(status ?? '').trim().toUpperCase();

export function isDatanetTerminal(status: unknown): boolean {
  return DATANET_TERMINAL_STATES.has(normalized(status));
}

/** Ended by a stop (BotBoy's, or someone's in Datanet): CANCELLED. */
export function isDatanetCancelled(status: unknown): boolean {
  return normalized(status) === 'CANCELLED';
}

export function isDatanetStopping(status: unknown): boolean {
  return normalized(status) === DATANET_STOPPING_STATE;
}
