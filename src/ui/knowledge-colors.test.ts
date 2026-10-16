// Readability of the Knowledge change card, in BOTH themes (src/ui/dashboard.css, docs/maps/knowledge-library.md K20).
//
// Owner report 2026-10-16: on the light theme the green "+" lines of a change were unreadable. They were #7bd88f on a
// translucent dark panel, a pair chosen for the dark theme only: 1.1:1 once the page behind was white. This test reads the real
// stylesheet, takes the colors the card uses in each theme, and holds every text/background pair to WCAG AA for normal text.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.css'), 'utf8');

function ruleAt(start: number): string {
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  return ruleAt(start);
}
/** `--name:#abc` / `--name:#aabbcc` pairs of a block, as 6-digit hex. */
function colors(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of text.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6})\b/g)) {
    const hex = match[2].slice(1);
    out[match[1]] = `#${hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex}`.toLowerCase();
  }
  return out;
}
const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16) / 255;
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => { const v = channel(hex, at); return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The page's own theme blocks are the FIRST `:root {` and `:root[data-theme="light"] {` in the file; the Knowledge colors are
// the blocks that start with `--kn-` further down. The card sits on the page's surface in each theme.
const THEMES = {
  dark: { page: colors(ruleAt(css.indexOf(':root {'))), knowledge: colors(ruleAt(css.indexOf(':root { --kn-'))) },
  light: { page: colors(ruleAt(css.indexOf(':root[data-theme="light"] {'))), knowledge: colors(ruleAt(css.indexOf(':root[data-theme="light"] { --kn-'))) },
} as const;

describe.each(Object.entries(THEMES))('%s theme', (_name, theme) => {
  const k = theme.knowledge;
  const pairs: Array<[string, string, string]> = [
    ['an added line', k['kn-add-fg'], k['kn-add-bg']],
    ['a removed line', k['kn-del-fg'], k['kn-del-bg']],
    ['a context line', k['kn-ctx-fg'], k['kn-diff-bg']],
    ['a file or hunk header line', k['kn-meta-fg'], k['kn-diff-bg']],
    ['the Applied / Undone line on a card', k['kn-ok-fg'], k['kn-card-bg']],
    ['a warning line on a card', k['kn-warn-fg'], k['kn-card-bg']],
    ['an error line on a card', k['kn-bad-fg'], k['kn-card-bg']],
    ['the derived-from notice', k['kn-notice-fg'], k['kn-notice-bg']],
    ['the Applied / Undone line in the overlay footer', k['kn-ok-fg'], theme.page['bg-raised']],
    ['a warning line in the overlay footer', k['kn-warn-fg'], theme.page['bg-raised']],
    ['an error line in the overlay footer', k['kn-bad-fg'], theme.page['bg-raised']],
  ];
  it.each(pairs)('%s is readable (WCAG AA, 4.5:1)', (_what, foreground, background) => {
    expect(foreground, 'the foreground color is defined').toMatch(/^#[0-9a-f]{6}$/);
    expect(background, 'the background color is defined').toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it('the card background is the page\'s own surface, so the pairs above are the pairs the owner sees', () => {
    expect(k['kn-card-bg']).toBe(theme.page.surface);
  });
});

describe('the rules use those colors', () => {
  it('the diff lines and the state lines take them from the variables, and the old dark-only pastels are gone', () => {
    const from = css.indexOf('/* Knowledge write path (K19)');
    const section = css.slice(from);
    expect(block('.knowledge-diff-line.add')).toMatch(/color:var\(--kn-add-fg\); background:var\(--kn-add-bg\)/);
    expect(block('.knowledge-diff-line.del')).toMatch(/color:var\(--kn-del-fg\); background:var\(--kn-del-bg\)/);
    expect(block('.knowledge-diff')).toMatch(/background:var\(--kn-diff-bg\)/);
    expect(block('.knowledge-card-state.good')).toMatch(/color:var\(--kn-ok-fg\)/);
    expect(block('.knowledge-card-state.warn')).toMatch(/color:var\(--kn-warn-fg\)/);
    expect(section).toMatch(/\.knowledge-card-error \{ color:var\(--kn-bad-fg\); \}/);
    expect(section).toMatch(/\.knowledge-card-note, \.knowledge-card-error \{[^}]*color:var\(--kn-warn-fg\)/);
    expect(block('.knowledge-card-source')).toMatch(/background:var\(--kn-notice-bg\)/);
    expect(section).not.toMatch(/#7bd88f|#ff8f8f|#ffbe5a|var\(--panel/);
  });
});
