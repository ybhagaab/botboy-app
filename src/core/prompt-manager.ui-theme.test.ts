import { describe, expect, it } from 'vitest';
import { createPromptManager } from './prompt-manager.js';
import { UI_THEME_CHAT_TOOL_NAMES, UI_THEME_GUIDANCE_BLOCK } from './ui-theme-chat-tools.js';

/** The theme tool is offered only on turns about how BotBoy looks (docs/maps/ui-themes.md). */
describe('ui_theme_propose in the prompt manager', () => {
  const pm = createPromptManager();
  const names = (context?: Parameters<typeof pm.getToolDefinitions>[1], role: Parameters<typeof pm.getToolDefinitions>[0] = 'chat') => pm.getToolDefinitions(role, context).map((tool) => tool.function.name);

  it('is not offered by default, nor on a turn the route did not mark', () => {
    expect(names()).not.toContain('ui_theme_propose');
    expect(names({})).not.toContain('ui_theme_propose');
    expect(names({ uiThemeAvailable: false })).not.toContain('ui_theme_propose');
  });

  it('is offered on a marked chat turn, to chat only', () => {
    expect(names({ uiThemeAvailable: true })).toContain('ui_theme_propose');
    for (const role of ['orchestrator', 'classifier', 'enricher', 'organizer', 'describer', 'deduplicator', 'product_manager'] as const) {
      expect(names({ uiThemeAvailable: true }, role), role).not.toContain('ui_theme_propose');
    }
    expect([...UI_THEME_CHAT_TOOL_NAMES]).toEqual(['ui_theme_propose']);
  });

  it('has a closed schema of four choices, three required, and no way to pass CSS or a file', () => {
    const def = pm.getToolDefinitions('chat', { uiThemeAvailable: true }).find((tool) => tool.function.name === 'ui_theme_propose')!;
    const schema = def.function.parameters as any;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(['name', 'mode', 'accent', 'background']);
    expect(schema.required).toEqual(['name', 'mode', 'accent']);
    expect(schema.properties.mode.enum).toEqual(['dark', 'light']);
    expect(def.function.description).toMatch(/only STAGES/);
    expect(def.function.description).toMatch(/Never recolour the UI by editing files/);
  });

  it('adds its guidance only on those turns', () => {
    expect(pm.getSystemPrompt('chat')).not.toContain(UI_THEME_GUIDANCE_BLOCK);
    expect(pm.getSystemPrompt('chat', { uiThemeAvailable: true })).toContain(UI_THEME_GUIDANCE_BLOCK);
    expect(pm.getSystemPrompt('orchestrator', { uiThemeAvailable: true })).not.toContain(UI_THEME_GUIDANCE_BLOCK);
  });

  it('the UI-modification block sends colour work to the tool instead of sed', () => {
    const prompt = pm.getSystemPrompt('chat');
    expect(prompt).toContain('ui_theme_propose');
    expect(prompt).toMatch(/Do not recolour the UI by running sed on dashboard\.css/);
  });
});
