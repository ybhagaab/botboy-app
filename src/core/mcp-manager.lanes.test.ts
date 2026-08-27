import { describe, it, expect } from 'vitest';
import { callLaneBlocked } from './mcp-manager.js';

/**
 * Per-source lanes on the sql-context gate: 4 slots total, `dashboard`
 * capped at 3 — a running refresh can never occupy every slot, so
 * interactive chat always finds one free. Lane sizes are MEASURED against
 * the warehouse (2026-08-27: 3 concurrent heavy scans ran at solo speed;
 * 6 collapsed it — completions staircased 6→31 min and four queries blew
 * the 35-min budget).
 */
describe('callLaneBlocked', () => {
  const LIMIT = 4;
  const DASH_CAP = 3;

  it('blocks a dashboard call at its lane cap even with total slots free', () => {
    expect(callLaneBlocked({ inFlight: 3, limit: LIMIT, sourceInFlight: 3, sourceLimit: DASH_CAP })).toBe(true);
  });

  it('lets an interactive call through while dashboards hold their full lane', () => {
    // 3 dashboard calls in flight; a chat ('agent') call has no source cap.
    expect(callLaneBlocked({ inFlight: 3, limit: LIMIT, sourceInFlight: 0, sourceLimit: undefined })).toBe(false);
  });

  it('blocks everyone at the server-wide limit', () => {
    expect(callLaneBlocked({ inFlight: 4, limit: LIMIT, sourceInFlight: 0, sourceLimit: undefined })).toBe(true);
    expect(callLaneBlocked({ inFlight: 4, limit: LIMIT, sourceInFlight: 3, sourceLimit: DASH_CAP })).toBe(true);
  });

  it('uncapped sources fill remaining slots freely below the limit', () => {
    expect(callLaneBlocked({ inFlight: 3, limit: LIMIT, sourceInFlight: 3, sourceLimit: undefined })).toBe(false);
  });
});
