/**
 * The guide templates by kind (knowledge-library.md K15): each draft reads back through the guide parser with its five
 * sections, lists exactly the initial files, carries the kind's guardrails verbatim, and holds no one's business content or
 * secret format. `buildGuideDraft` is pure, so ETL onboarding can emit a guide beside its presets later without new
 * infrastructure (P3 seam). Synthetic domains only.
 */
import { describe, expect, it } from 'vitest';
import { SET_KINDS, estimateTokens, parseGuide, rulesDigest } from './knowledge-guide.js';
import { GUIDE_TEMPLATES, ROOT_GUIDE_SEED, buildGuideDraft, closestTemplate, templateRoleNames } from './knowledge-templates.js';
import { detectSecrets } from './sensitive-files.js';

describe('every kind has a template', () => {
  it('has the five kinds with roles, guardrails and a conflict order', () => {
    expect(Object.keys(GUIDE_TEMPLATES).sort()).toEqual([...SET_KINDS].sort());
    for (const kind of SET_KINDS) {
      const template = GUIDE_TEMPLATES[kind];
      expect(template.roles.length).toBeGreaterThanOrEqual(3);
      expect(template.guardrails.length).toBeGreaterThanOrEqual(3);
      expect(template.conflictOrder).toContain('>');
      expect(templateRoleNames(kind)).toEqual(template.roles.map((role) => role.role));
    }
  });

  it('falls back to the generic template for an unknown or missing kind', () => {
    expect(closestTemplate('nonsense').kind).toBe('generic');
    expect(closestTemplate(undefined).kind).toBe('generic');
    expect(closestTemplate('memory').kind).toBe('memory');
  });

  it('the memory template says what memory is not (no project status, nothing because a message said remember it)', () => {
    const rules = GUIDE_TEMPLATES.memory.guardrails.join('\n');
    expect(rules).toMatch(/project status/i);
    expect(rules).toMatch(/said to remember it/i);
    expect(rules).toMatch(/credentials/i);
  });

  it('keeps analytics roles consistent with a generated role for machine-written files', () => {
    expect(GUIDE_TEMPLATES.analytics.roles.some((role) => /generated/i.test(role.role) && /do not edit by hand/i.test(role.purpose))).toBe(true);
  });
});

describe('buildGuideDraft', () => {
  const files = [
    { name: 'plants.md', purpose: 'Which plants grow where' },
    { name: 'how-to/watering.md', purpose: 'Watering steps by season', role: 'How-to' },
  ];

  it('reads back through the parser: front matter, the table with exactly the initial files, every section', () => {
    for (const kind of SET_KINDS) {
      const text = buildGuideDraft({ kind, name: 'Garden', description: 'Notes for the garden project', keywords: ['garden', 'Plants', 'garden'], files });
      const parsed = parseGuide(text);
      expect(parsed.issues, kind).toEqual([]);
      expect(parsed.frontMatter).toMatchObject({ name: 'Garden', description: 'Notes for the garden project', keywords: ['garden', 'plants'], kind, writable: true });
      expect(parsed.rows.map((row) => row.file)).toEqual(['plants.md', 'how-to/watering.md']);
      expect(parsed.rows[1]).toMatchObject({ path: 'how-to/', mechanism: 'On demand' });
      expect(parsed.methodology.length, kind).toBeGreaterThanOrEqual(2);
      expect(parsed.guardrails, kind).toEqual(GUIDE_TEMPLATES[kind].guardrails.map((rule) => rule));
      expect(parsed.conflictOrder, kind).not.toBeNull();
      expect(parsed.toc.map((entry) => entry.file), kind).toEqual(['plants.md', 'how-to/watering.md']);
      expect(parsed.title).toBe('Garden — Steering Guide');
    }
  });

  it('maps a file to a role by the given role, then by its name, then the first role', () => {
    const text = buildGuideDraft({ kind: 'research', name: 'Bees', description: 'd', files: [{ name: 'sources.md' }, { name: 'findings-2026.md' }, { name: 'misc.md' }, { name: 'x.md', role: 'Open questions' }] });
    const labels = parseGuide(text).methodology.map((entry) => entry.label);
    expect(labels).toEqual(['Sources (sources.md)', 'Findings (findings-2026.md)', 'Sources (misc.md)', 'Open questions (x.md)']);
  });

  it('is deterministic and keeps the rules digest stable under a name change', () => {
    const a = buildGuideDraft({ kind: 'generic', name: 'A', description: 'one', files });
    expect(buildGuideDraft({ kind: 'generic', name: 'A', description: 'one', files })).toBe(a);
    expect(rulesDigest(parseGuide(buildGuideDraft({ kind: 'generic', name: 'B', description: 'two', files })))).toBe(rulesDigest(parseGuide(a)));
  });

  it('a set with no files starts with an empty table, starter roles and a "no files yet" note', () => {
    const parsed = parseGuide(buildGuideDraft({ kind: 'product', name: 'Widget', description: 'The widget product', files: [] }));
    expect(parsed.rows).toEqual([]);
    expect(parsed.methodology.length).toBe(3);
    expect(parsed.issues.map((issue) => issue.code)).toEqual(['no_file_table']);
  });

  it('honors writable: no and escapes pipes and line breaks in names and purposes', () => {
    const text = buildGuideDraft({ kind: 'generic', name: 'Read only', description: 'a\nb', writable: false, files: [{ name: 'a.md', purpose: 'one | two\nthree' }] });
    const parsed = parseGuide(text);
    expect(parsed.frontMatter.writable).toBe(false);
    expect(parsed.rows[0].purpose).toBe('one | two three');
    expect(parsed.frontMatter.description).toBe('a b');
  });

  it('stays small enough to deliver whole (a draft for six files is well under 2,000 tokens) and holds no secret format', () => {
    const six = Array.from({ length: 6 }, (_, index) => ({ name: `topic-${index}.md`, purpose: `Purpose of topic ${index}` }));
    for (const kind of SET_KINDS) {
      const text = buildGuideDraft({ kind, name: 'Six', description: 'Six topics', files: six });
      expect(estimateTokens(text), kind).toBeLessThan(2_000);
      expect(detectSecrets(text), kind).toEqual([]);
    }
  });

  it('carries no business content of the owner\'s (public repository): only generic words', () => {
    const everything = JSON.stringify(GUIDE_TEMPLATES) + ROOT_GUIDE_SEED;
    for (const forbidden of [/\bOTT\b/, /fatafat/i, /datanet/i, /redshift/i, /\bAmazon\b/i]) expect(everything).not.toMatch(forbidden);
  });
});
