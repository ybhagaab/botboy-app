import { describe, it, expect } from 'vitest';
import { createPromptManager } from './prompt-manager.js';

/**
 * Owner decision 2026-08-27: "same tools everywhere." Analytics mode used to
 * carry a restricted 16-tool list (dashboard CRUD + governed SQL reads), so
 * "add this as a task under the project" mid-analysis was honestly refused —
 * add_task was not in the toolset (prompt-log-verified incident, 01:25).
 * Analytical discipline lives in the analytics system prompt, not in tool
 * removal.
 */
describe('getToolDefinitions — conversation modes share one toolset', () => {
  it('analytics mode carries the exact same tools as general chat', () => {
    const pm = createPromptManager();
    const general = pm.getToolDefinitions('chat', { conversationMode: 'general' }).map(t => t.function.name);
    const analytics = pm.getToolDefinitions('chat', { conversationMode: 'analytics_dashboard' }).map(t => t.function.name);
    expect(analytics).toEqual(general);
    // The incident tools specifically:
    for (const name of ['add_task', 'set_task_state', 'get_project_brain', 'mcp_sql_query', 'create_analytics_dashboard']) {
      expect(analytics).toContain(name);
    }
  });
});
