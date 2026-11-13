import { describe, expect, it } from 'vitest';
import { createPromptManager, createWaitForToolDefinition } from './prompt-manager.js';
import { JOB_SCOPE_TOOLS, REVIEW_TOOLS } from './job-mandate.js';
import { AMAZON_ONLY_CHAT_TOOLS } from './workplace.js';
import type { McpServerSnapshot } from './mcp-types.js';

/**
 * The general wait in the chat prompt (docs/maps/job-waits.md): wait_for takes the old ETL-only wait's place (the tool count is
 * unchanged), is offered with Amazon Employee on or off (its ETL kind only while on), and the guidance sends long SQL through a
 * background export that BotBoy waits for, never a status polled in turns.
 */
const sqlOnly = [{
  id: 'sql-context', kind: 'managed', displayName: 'SQL', enabled: true, configured: true, state: 'running', packageVersion: '1',
  tools: ['connection_status', 'run_query'].map(name => ({ name, inputSchema: {}, risk: 'read' as const })), restartCount: 0,
  lastHealthyAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
}] as McpServerSnapshot[];

describe('wait_for in the chat prompt', () => {
  const pm = createPromptManager();
  const kinds = (def: any) => def.function.parameters.properties.kind.enum as string[];

  it('replaces wait_for_etl_run in every chat turn, with Amazon Employee on or off', () => {
    for (const amazonEmployee of [true, false]) {
      const names = pm.getToolDefinitions('chat', { amazonEmployee }).map(def => def.function.name);
      expect(names).toContain('wait_for');
      expect(names).not.toContain('wait_for_etl_run');
    }
    expect(AMAZON_ONLY_CHAT_TOOLS.has('wait_for')).toBe(false);
  });

  it('names the ETL kind only while Amazon Employee is on', () => {
    const on = pm.getToolDefinitions('chat').find(def => def.function.name === 'wait_for')!;
    const off = pm.getToolDefinitions('chat', { amazonEmployee: false }).find(def => def.function.name === 'wait_for')!;
    expect(kinds(on)).toEqual(['sql_export', 'etl_run', 'data_room_job', 'terminal', 'file', 'connection', 'time']);
    expect(kinds(off)).toEqual(['sql_export', 'data_room_job', 'terminal', 'file', 'connection', 'time']);
    expect(JSON.stringify(off)).not.toMatch(/etl_run|\bETL\b/);
    expect(JSON.stringify(createWaitForToolDefinition())).toBe(JSON.stringify(on));
    expect(on.function.description).toContain('end your turn with job_update wait');
  });

  it('job_update takes wait, and its words no longer say waiting needs none', () => {
    const def = pm.getToolDefinitions('chat').find(candidate => candidate.function.name === 'job_update')!;
    expect((def.function.parameters as any).properties.action.enum).toContain('wait');
    expect(def.function.description).toContain('wait (the next step needs something still running');
    expect(def.function.description).not.toContain('Waiting on watched ETL runs needs none of these');
  });

  it('a job may wait in its automatic turns; the main chat\'s look at a job never waits', () => {
    expect(JOB_SCOPE_TOOLS.has('wait_for')).toBe(true);
    expect(REVIEW_TOOLS.has('wait_for')).toBe(false);
  });

  it('long SQL goes through a background export BotBoy waits for; no prompt tells the model to poll a status', () => {
    for (const amazonEmployee of [true, false]) {
      const job = pm.getSystemPrompt('chat', { mcpServers: sqlOnly, jobTurn: true, jobDataWork: true, amazonEmployee } as any);
      expect(job).toContain('- Long SQL: a warehouse query that may run more than a couple of minutes');
      expect(job).toContain('export_query with wait:false');
      expect(job).toContain('End the turn with job_update wait.');
      const main = pm.getSystemPrompt('chat', { mcpServers: sqlOnly, amazonEmployee } as any);
      expect(main).toContain('BotBoy waits for the export by itself');
      for (const prompt of [job, main]) {
        expect(prompt).not.toContain('poll export_status.');
        expect(prompt).not.toContain('wait_for_etl_run');
      }
    }
  });

  // Owner decision 2026-11-13, after job #5's own 10-60 minute timeoutMs values cancelled 6 exports in one day
  // (.agents/tasks/export-30min-limit/report.md): no self-chosen limit by default, and never a short one on a large query.
  it('tells main chat and job turns to leave timeoutMs out unless the owner set one, and to size any limit to the data', () => {
    for (const amazonEmployee of [true, false]) {
      const job = pm.getSystemPrompt('chat', { mcpServers: sqlOnly, jobTurn: true, jobDataWork: true, amazonEmployee } as any);
      const main = pm.getSystemPrompt('chat', { mcpServers: sqlOnly, amazonEmployee } as any);
      for (const prompt of [job, main]) {
        const lines = prompt.split('\n').filter(line => line.startsWith('- Query time limits:'));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('leave timeoutMs out of run_query and export_query unless the owner set a limit');
        expect(lines[0]).toContain('cancel_query stops it');
        expect(lines[0]).toContain('size it to the work');
        expect(lines[0]).toContain('never a short limit on a large query');
      }
    }
  });
});
