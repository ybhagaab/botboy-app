import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DATANET_IN_FLIGHT_STATES,
  DATANET_RUN_STATES,
  DATANET_TERMINAL_STATES,
  isDatanetCancelled,
  isDatanetStopping,
  isDatanetTerminal,
} from './datanet-run-states.js';
import { ETL_TERMINAL_STATES } from './query-ledger.js';
import { outcomeFromReadRun } from './etl-run-watcher.js';

/**
 * Datanet's job run states (datanet-run-states.ts), exactly as Datanet's service model lists them (owner direction 2026-11-14:
 * "botboy should recognize cancelling & cancelled states, and the right states").
 */
describe('Datanet run states', () => {
  it('are Datanet\'s own thirteen, with no KILLED (a kill ends CANCELLING, then CANCELLED)', () => {
    expect([...DATANET_RUN_STATES]).toEqual([
      'NEW', 'WAITING_FOR_DEPENDENCIES', 'WAITING_FOR_RESOURCES', 'RUNNABLE', 'EXECUTING', 'DCS_RECEIVING_DATA',
      'PUBLISHABLE', 'PUBLISHING', 'SUCCESS', 'ERROR', 'DELETED', 'CANCELLED', 'CANCELLING',
    ]);
    expect([...DATANET_TERMINAL_STATES].sort()).toEqual(['CANCELLED', 'DELETED', 'ERROR', 'SUCCESS']);
    // Every state is either in flight or terminal, never both.
    for (const state of DATANET_RUN_STATES) expect(DATANET_IN_FLIGHT_STATES.has(state) !== DATANET_TERMINAL_STATES.has(state), state).toBe(true);
    expect(DATANET_IN_FLIGHT_STATES.has('CANCELLING')).toBe(true);
    expect(isDatanetTerminal('cancelled')).toBe(true);
    expect(isDatanetTerminal('CANCELLING')).toBe(false);
    expect(isDatanetTerminal('KILLED')).toBe(false);
    expect(isDatanetCancelled(' Cancelled ')).toBe(true);
    expect(isDatanetStopping('cancelling')).toBe(true);
    // The query ledger ends runs on exactly these.
    expect(ETL_TERMINAL_STATES).toBe(DATANET_TERMINAL_STATES);
  });

  it('a watched run read CANCELLED ends its watch (the job hears it, instead of waiting for ever)', () => {
    expect(outcomeFromReadRun({ ok: false, code: 'remote_failed', runId: '77', remoteStatus: 'CANCELLED', error: 'Run 77 CANCELLED. Stopped on purpose by the owner.' } as any))
      .toEqual({ remoteStatus: 'CANCELLED', error: 'Run 77 CANCELLED. Stopped on purpose by the owner.' });
    expect(outcomeFromReadRun({ ok: false, code: 'alive_handoff', runId: '77', remoteStatus: 'CANCELLING', error: 'still' } as any)).toBe('pending');
  });

  it('no code names a run state Datanet does not have', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)
          && /'KILLED'|'WAITING_FOR_REQUIREMENTS'/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(dir, full));
      }
    };
    walk(path.join(__dirname, '..'));
    expect(offenders).toEqual([]);
  });
});
