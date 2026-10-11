import { describe, expect, it } from 'vitest';
import { createPromptManager } from './prompt-manager.js';

/**
 * Weaker models kept reading pages through DOM text only and said they could
 * not see typed values or could not click. The tool definition is a numbered
 * recipe that states both facts (2026-10-11).
 */
describe('browser_hands tool definition', () => {
  const pm = createPromptManager();
  const definition = pm.getToolDefinitions('chat').find(tool => tool.function.name === 'browser_hands')!;
  const parameters = definition.function.parameters as any;

  it('offers read_form and fill with a fields list', () => {
    expect(parameters.properties.action.enum).toEqual(expect.arrayContaining(['inspect', 'read_form', 'fill', 'click', 'type', 'select', 'key']));
    expect(parameters.properties.fields.items.properties.label).toBeTruthy();
    expect(parameters.properties.fields.items.properties.ref).toBeTruthy();
    expect(parameters.properties.fields.items.required).toEqual(['value']);
  });

  it('is a numbered recipe that says field values are included and actions are available', () => {
    const description = definition.function.description;
    for (const step of ['(1)', '(2)', '(3)', '(4)', '(5)', '(6)']) expect(description).toContain(step);
    expect(description).toContain('field values ARE included');
    expect(description).toContain('[withheld]');
    expect(description).toContain('click, type, select, key, scroll, wait, and navigate are also available');
    expect(description).toContain('requested, actual, ok');
  });

  it('the chat prompt carries the short web-form guidance', () => {
    const system = pm.getSystemPrompt('chat');
    expect(system).toContain('## Web pages and forms');
    expect(system).toContain('Field values ARE in the output');
    expect(system).toContain('WhatsApp requests included');
  });
});
