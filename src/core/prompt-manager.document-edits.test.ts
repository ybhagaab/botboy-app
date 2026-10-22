import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPromptManager } from './prompt-manager.js';

/**
 * Owner report 2026-10-21: BotBoy opened its own Documents reader with
 * ui_inspect to see what a document said, and saved a whole new version for
 * every one-line change. The tools and the prompt now route reads to
 * read_product_document / read_file and small changes to targeted edits.
 */
describe('document read and targeted edit tools', () => {
  const prompts = createPromptManager();
  const tool = (name: string) => prompts.getToolDefinitions('chat').find((definition) => definition.function.name === name)!;

  it('offers read_product_document, edit_product_document and edit_file in chat, with closed exact-edit schemas', () => {
    for (const name of ['read_product_document', 'edit_product_document', 'edit_file']) expect(tool(name), name).toBeTruthy();
    const read = tool('read_product_document').function.parameters as any;
    expect(read.required).toEqual([]);
    expect(Object.keys(read.properties)).toEqual(['artifactId', 'startLine', 'endLine', 'query', 'projectId']);
    const edit = tool('edit_product_document').function.parameters as any;
    expect(edit.required).toEqual(['artifactId', 'edits', 'ownerRequested']);
    expect(edit.properties.edits).toMatchObject({ type: 'array', minItems: 1, maxItems: 50, items: { additionalProperties: false, required: ['find', 'replace'] } });
    expect(edit.properties.citations.items.required).toEqual(['id', 'label']);
    const file = tool('edit_file').function.parameters as any;
    expect(file.required).toEqual(['filename', 'edits']);
    expect(file.properties.edits).toBe(edit.properties.edits);
    // save keeps its own citations description and points at the targeted edit.
    expect((tool('save_product_document').function.parameters as any).properties.citations.description).toMatch(/^Evidence citations matching inline \[cN\] markers/);
    expect(tool('save_product_document').function.description).toContain('For a change to part of an existing document use edit_product_document instead');
  });

  // Owner decision 2026-10-22: the tools say what they are for; nothing tells the model not to use ui_inspect.
  it('describes the read tools by what they do, and leaves ui_inspect as it was', () => {
    expect(tool('read_product_document').function.description).toContain('Use it to see what a saved document says, and before edit_product_document to copy exact text.');
    expect(tool('read_file').function.description).toContain('a longer one comes back as its first lines, numbered "N: text", with a note naming the startLine to read on');
    for (const name of ['read_product_document', 'edit_product_document', 'edit_file', 'read_file']) {
      expect(tool(name).function.description, name).not.toMatch(/ui_inspect|ui_screenshot|browser/);
    }
    expect(tool('ui_inspect').function.description).not.toMatch(/read_product_document|document's text/);
    expect(tool('ui_inspect').function.description).toMatch(/only BotBoy's own app can be observed\.$/);
  });

  it('teaches read first, one targeted edit per request, and full saves only for rewrites', () => {
    const prompt = prompts.getSystemPrompt('chat');
    // One compact routing rule; the mechanics live in the tool descriptions.
    expect(prompt).toContain('- READ AND EDIT: read a saved document with read_product_document.');
    expect(prompt).toContain('For a change to part of it, call edit_product_document once with every change of the request; save a full revision only when most of it changes.');
    const rule = prompt.split('\n').find((line) => line.startsWith('- READ AND EDIT:')) ?? '';
    expect(rule).not.toMatch(/ui_inspect|ui_screenshot|browser|never/);
    expect(prompt).toContain('Working files: read_file, then edit_file.');
    expect(prompt).toContain('- Artifacts are immutable versions. For a full revision, pass parentArtifactId');
    expect(prompt).toContain('6. If a junction has errors, fix it with edit_file, or rewrite the whole file with write_file in overwrite mode.');
    expect(prompt).toContain('- edit_file: Change exact text in an existing file. Parameters: filename, edits [{find, replace}].');
    expect(prompt).toContain('Long files and line ranges come back numbered, with the startLine to read on.');
    expect(prompt).not.toContain('use run_command with sed to patch specific lines');
    expect(prompt).not.toContain('Without line range returns full content (up to 8000 chars)');
    // Analytics mode shares the toolset and the document rules.
    const analytics = prompts.getToolDefinitions('chat', { conversationMode: 'analytics_dashboard' }).map((definition) => definition.function.name);
    expect(analytics).toEqual(expect.arrayContaining(['read_product_document', 'edit_product_document', 'edit_file']));
  });

  it('keeps the new tools while Amazon Employee is off', () => {
    const names = prompts.getToolDefinitions('chat', { amazonEmployee: false }).map((definition) => definition.function.name);
    expect(names).toEqual(expect.arrayContaining(['read_product_document', 'edit_product_document', 'edit_file']));
  });

  // Source seam: the chat route never runs a write tool whose arguments were cut off and
  // repaired (a half edit list could apply part of a change), and counts it for action integrity.
  it('lists both edit tools as write tools in the chat route', () => {
    const chat = readFileSync(path.join(process.cwd(), 'src/api/routers/chat.ts'), 'utf8');
    const block = /const WRITE_TOOLS = new Set\(\[([\s\S]*?)\]\);/.exec(chat)?.[1] ?? '';
    for (const name of ['write_file', 'edit_file', 'save_product_document', 'edit_product_document']) expect(block, name).toContain(`'${name}'`);
    expect(block).not.toContain("'read_product_document'");
  });
});
