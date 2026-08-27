import { describe, it, expect } from 'vitest';
import { sqlToolTimeoutMs } from './tool-executor.js';

/**
 * Owner report 2026-08-27: "the mcp connector is timing out — the same mcp
 * works in Kiro perfectly." The connector was fine; BotBoy's chat path
 * capped every sql-context call at a flat 90s while the owner's warehouse
 * queries legitimately run 10-15+ minutes (audit: agent-source run_query
 * failures pinned at ~90s while dashboard-source calls on the 25-minute
 * budget completed at up to 16 minutes). Data tools now share the analytics
 * budget; catalog tools keep the short leash so a wedged call cannot hold
 * the serialized per-server lane for half an hour.
 */
describe('sqlToolTimeoutMs', () => {
  it('gives data-bearing tools the analytics-grade budget (35 min default, owner decision 2026-08-27)', () => {
    expect(sqlToolTimeoutMs('run_query')).toBe(35 * 60_000);
    expect(sqlToolTimeoutMs('get_sample_data')).toBe(35 * 60_000);
  });

  it('keeps catalog/status tools on the short 90s leash', () => {
    for (const tool of ['list_presets', 'get_schema_context', 'list_schemas', 'list_tables', 'describe_table', 'connection_status']) {
      expect(sqlToolTimeoutMs(tool)).toBe(90_000);
    }
  });
});
