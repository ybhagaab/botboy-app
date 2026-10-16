// Why a theme made in chat can recolour the whole UI (docs/maps/ui-themes.md P0): the stylesheet and the scripts take BotBoy's
// violet from the theme tokens, not from literals. A violet literal outside a token definition would stay violet under a teal
// theme, so this test fails on a new one and says which token to use instead.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.join(process.cwd(), 'src/ui');
const files = readdirSync(dir).filter((name) => /\.(css|js|html)$/.test(name) && !/\.test\./.test(name));
const read = (name: string) => readFileSync(path.join(dir, name), 'utf8');

const COLOUR = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)/g;

function rgbOf(literal: string): [number, number, number] {
  if (literal.startsWith('#')) {
    let hex = literal.slice(1);
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  const numbers = literal.match(/[\d.]+/g)!.map(Number);
  return [numbers[0], numbers[1], numbers[2]];
}
function hueAndSaturation([r, g, b]: [number, number, number]): [number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn); const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h * 60, s];
}
const isVioletFamily = (literal: string): boolean => {
  const [h, s] = hueAndSaturation(rgbOf(literal));
  return h >= 235 && h <= 285 && s > 0.18;
};

/**
 * A violet-family literal that may stay, with why. Everything not listed must be a token. (A literal that IS a token definition,
 * `--name: <literal>`, is the theme itself and is always fine.)
 */
const ALLOWED: Record<string, Record<string, { count: number; why: string }>> = {
  'dashboard.css': {
    'rgba(5,5,8,.68)': { count: 2, why: 'a dark scrim behind a dialog: it dims the page the same way under any theme' },
    'rgba(5,5,8,.62)': { count: 1, why: 'the same kind of scrim' },
    'rgba(7,7,12,.28)': { count: 1, why: 'the same kind of scrim' },
    'rgba(7,7,12,.42)': { count: 1, why: 'the same kind of scrim' },
  },
  'dashboard.js': {
    '#9d8cff': { count: 1, why: 'the first colour of the categorical area palette (data, not chrome)' },
    '#ae91d1': { count: 1, why: 'the categorical area palette' },
    '#8b7fd4': { count: 1, why: 'the colour for a Markdown file type' },
  },
  'analytics-html-view.js': {
    '#1c1926': { count: 1, why: 'dark text on the yellow warning flag of a dashboard view' },
  },
};

describe('no accent colour is baked into the UI', () => {
  it('every violet-family literal is a token definition or a documented exception', () => {
    const found: Record<string, Record<string, number>> = {};
    const offenders: string[] = [];
    for (const name of files) {
      read(name).split('\n').forEach((line, index) => {
        COLOUR.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = COLOUR.exec(line))) {
          const literal = match[0];
          if (!isVioletFamily(literal)) continue;
          if (/--[a-z0-9-]+\s*:\s*$/.test(line.slice(Math.max(0, match.index - 40), match.index))) continue;
          const key = literal.replace(/\s+/g, '');
          found[name] ??= {};
          found[name][key] = (found[name][key] ?? 0) + 1;
          if (!ALLOWED[name]?.[key]) offenders.push(`${name}:${index + 1} ${literal}`);
        }
      });
    }
    expect(offenders, 'Use rgba(var(--accent-rgb), a) for a tint of the accent, var(--accent) / var(--accent-strong) / color-mix(...) for a solid, or add a documented exception above.').toEqual([]);
    // The exceptions are exact: one that disappears must be removed from the list, so the list never goes stale.
    for (const [name, entries] of Object.entries(ALLOWED)) {
      for (const [literal, { count }] of Object.entries(entries)) expect(found[name]?.[literal] ?? 0, `${name} ${literal}`).toBe(count);
    }
  });

  it('the accent halo colour 157,140,255 exists only as the token and the dark accent-soft, never as a literal in a rule', () => {
    const css = read('dashboard.css');
    // Three definitions: --accent-rgb in each shipped block, and the dark --accent-soft.
    expect([...css.matchAll(/157,\s*140,\s*255/g)]).toHaveLength(3);
    expect([...css.matchAll(/(?:--accent-rgb:\s*|--accent-soft:\s*rgba\()157,\s*140,\s*255/g)]).toHaveLength(3);
    for (const name of files.filter((file) => file.endsWith('.js'))) expect(read(name), name).not.toMatch(/157,\s*140,\s*255/);
  });

  it('no script sets the accent as a hex literal in inline style (they use the tokens)', () => {
    for (const name of ['app.js', 'dashboard.js', 'knowledge-ui.js', 'knowledge-overlay.js', 'ui-theme.js']) {
      expect(read(name), name).not.toMatch(/style="[^"]*#(?:9d8cff|7c3aed|735ce2|6750d3)/i);
    }
  });

  it('the pause ring and the button fill are theme tokens with a declared fallback for each shipped palette', () => {
    const css = read('dashboard.css');
    expect(css).toMatch(/\.button\.primary \{[^}]*border-color:var\(--accent-fill-edge\); background:linear-gradient\(180deg,var\(--accent-fill-top\),var\(--accent-fill-bottom\)\)/);
    expect(css).toMatch(/\.chat-job-strip \{ --job-run:var\(--accent\); --job-pause:var\(--ring-yellow\); --job-done:var\(--green\); \}/);
  });
});
