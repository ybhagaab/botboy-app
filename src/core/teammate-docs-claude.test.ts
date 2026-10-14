/**
 * The shipped Claude text (Claude slice C, brief item 4): docs/TEAMMATE_SETUP.md and the release README tell a teammate
 * where an Anthropic key comes from, the Settings steps, what leaves the Mac, that Admin keys are refused, that a key
 * should belong to one workspace, and that an older build drops the Claude key. Wherever either file says which key to
 * add it names every provider card, and it uses the `botboy-app` URL and flat paths, never the dev checkout's.
 * No Amazon Employee notice or guard is added for external keys (owner decision 2026-10-13).
 *
 * docs/release/README.md ships as the ROOT README of botboy-app, so a distribution checkout has no such file (its
 * cases skip there), exactly as launcher-node-advice.test.ts treats it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const distribution = fs.existsSync(path.join(packageRoot, '.botboy-distribution'));
const read = (file: string) => (fs.existsSync(path.join(packageRoot, file)) ? fs.readFileSync(path.join(packageRoot, file), 'utf8') : null);
const docs: [string, string | null][] = [
  ['docs/TEAMMATE_SETUP.md', read('docs/TEAMMATE_SETUP.md')],
  ['docs/release/README.md', distribution ? null : read('docs/release/README.md')],
];
const PHRASE = 'OpenAI, DeepSeek or Anthropic (Claude)';

for (const [name, text] of docs) {
  describe.skipIf(text === null)(name, () => {
    // Markdown line breaks are not part of the wording.
    const doc = (text ?? '').replace(/\s+/g, ' ');

    it('names every provider card wherever it says which key to add', () => {
      expect(doc).toContain(PHRASE);
      expect(doc).not.toContain('OpenAI or DeepSeek');
      expect(doc).toContain('Check and save key');
    });

    it('says where a Claude key comes from, that Admin keys are refused, and that a key should belong to one workspace', () => {
      expect(doc).toContain('https://platform.claude.com/settings/keys');
      expect(doc).toContain('sk-ant-');
      expect(doc).toMatch(/Admin keys[^.]*(refuse|refused)/);
      expect(doc).toMatch(/belongs? to one workspace/);
      expect(doc).toMatch(/no (workspace ID field|field for a workspace ID)/);
    });

    it('says what leaves the Mac, Data Room tables and file values included, and never claims those are withheld', () => {
      expect(doc).toContain('under your own account');
      expect(doc).toContain('Data Room table');
      expect(doc).not.toMatch(/never sent to them|never sent to OpenAI|are not sent to (OpenAI|DeepSeek|Anthropic)/i);
    });

    it('tells a teammate how to check the key and what an older build does to it', () => {
      expect(doc).toContain('anthropic probe');
      expect(doc).toContain('last four');
      expect(doc).toMatch(/older BotBoy[^.]*(ignores|does not know)[^.]*Claude key/);
      expect(doc).toContain('drops it the next time it saves its Settings');
      expect(doc).toMatch(/paste (the|it|that) (Claude )?key again/);
    });

    it('uses the botboy-app URL and flat paths, never the dev checkout', () => {
      expect(doc).not.toMatch(/botboy\/personal-productivity-tracker|Workflow tracker|\.agents\/|\.kiro\//);
      expect(doc).toContain('cd ~/botboy-app');
      expect(doc).toContain('https://github.com/ybhagaab/botboy-app.git');
    });
  });
}

describe.skipIf(docs[0][1] === null)('the Claude section of docs/TEAMMATE_SETUP.md', () => {
  const setup = docs[0][1] ?? '';
  const start = setup.indexOf('#### Claude (an Anthropic API key)');
  const end = setup.indexOf('\n### ', start);
  const section = setup.slice(start, end);

  it('exists inside the own-key section, before the next top-level topic', () => {
    expect(start).toBeGreaterThan(setup.indexOf('### Your own OpenAI, DeepSeek or Claude API key'));
    expect(end).toBeGreaterThan(start);
    for (const label of ['Where the key comes from', 'Steps', 'Defaults', 'Thinking', 'What leaves your Mac', 'Credit and limits', 'Check it', 'Going back to an older release']) {
      expect(section, label).toContain(`**${label}:**`);
    }
  });

  it('shows the exact doctor lines of the Claude key (the suffix only) and the status meanings', () => {
    const flat = section.replace(/\s+/g, ' ');
    expect(flat).toContain('`ai-model: Anthropic (Claude) key …abcd saved in Settings`');
    expect(flat).toContain('`anthropic probe: HTTP 200`');
    expect(flat).toMatch(/`401` means Anthropic rejected the key, and `000` means a network, proxy or VPN blocks api\.anthropic\.com/);
  });

  it('adds no Amazon Employee notice or guard for an external key', () => {
    expect(section).not.toMatch(/Amazon/i);
  });
});
