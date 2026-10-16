// The theme engine (docs/maps/ui-themes.md): strict token formats, the derivation, the readability proof, and what a refusal says.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_THEME_TOKENS, THEME_TOKEN_NAMES, contrastRatio, deriveTheme, isValidTokenValue, luminance, normalizeHexColor, normalizeThemeName,
  parseHexColor, parseThemeTokens, proveReadable, themeSwatch, themeToInlineStyle, verifyTheme, type ThemeMode, type ThemeTokens,
} from './ui-theme-engine.js';

const css = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.css'), 'utf8');

/** `--name:value` pairs of the first block that starts with `selector {`. */
function tokenBlock(selector: string): Record<string, string> {
  const from = css.indexOf(`${selector} {`);
  expect(from, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf('{', from) + 1, css.indexOf('\n}', from));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}
const expandHex = (value: string): string => (/^#[0-9a-f]{3}$/i.test(value) ? `#${[...value.slice(1)].map((d) => d + d).join('')}`.toLowerCase() : value.toLowerCase());
const rgb = (value: string): number[] => {
  const hex = parseHexColor(value);
  if (hex) return [...hex];
  return (value.match(/[\d.]+/g) ?? []).map(Number);
};
const maxDelta = (a: string, b: string): number => Math.max(...rgb(a).slice(0, 3).map((v, i) => Math.abs(v - rgb(b)[i])));

const seeds: Record<ThemeMode, { accent: string; background: string }> = {
  dark: { accent: '#9d8cff', background: '#09090b' },
  light: { accent: '#6750d3', background: '#f4f4f6' },
};

describe('the shipped palettes the engine is calibrated on', () => {
  it.each(['dark', 'light'] as const)('BUILTIN_THEME_TOKENS.%s is exactly what dashboard.css defines', (mode) => {
    const dark = tokenBlock(':root');
    const block = mode === 'dark' ? dark : { ...dark, ...tokenBlock(':root[data-theme="light"]') };
    const resolve = (value: string): string => {
      const ref = value.match(/^var\(--([a-z0-9-]+)\)$/);
      return ref ? resolve(block[ref[1]]) : expandHex(value);
    };
    for (const name of THEME_TOKEN_NAMES) {
      expect(block[name], `${mode} --${name} is defined in the stylesheet`).toBeDefined();
      expect(resolve(block[name]), `${mode} --${name}`).toBe(BUILTIN_THEME_TOKENS[mode][name]);
    }
  });

  it('a theme never includes a layout token, and the stylesheet keeps those seven out of both colour blocks', () => {
    const layout = ['topbar', 'sidebar-expanded', 'sidebar-collapsed', 'sidebar', 'assistant', 'radius', 'radius-lg'];
    for (const name of layout) expect(THEME_TOKEN_NAMES as readonly string[]).not.toContain(name);
    expect(Object.keys(tokenBlock(':root[data-theme="light"]'))).not.toEqual(expect.arrayContaining(layout));
  });

  it('the shipped dark palette passes every readability pair', () => {
    expect(verifyTheme(BUILTIN_THEME_TOKENS.dark).filter((check) => !check.ok)).toEqual([]);
  });

  it('the shipped light palette misses exactly the bars it is known to miss: placeholder text and the four status colours (pinned, so a palette fix must update this)', () => {
    const missed = verifyTheme(BUILTIN_THEME_TOKENS.light).filter((check) => !check.ok).map((check) => check.id).sort();
    expect(missed).toEqual(['blue', 'faint', 'green', 'red', 'yellow']);
    // They are close, not broken: all above 2.9, and the worst status colour is 3.6:1.
    for (const check of verifyTheme(BUILTIN_THEME_TOKENS.light)) expect(check.ratio, check.id).toBeGreaterThan(2.9);
  });
});

describe('token formats', () => {
  it('accepts the strict formats and nothing else', () => {
    expect(isValidTokenValue('bg', '#09090b')).toBe(true);
    expect(isValidTokenValue('bg', '#09090B')).toBe(false);
    expect(isValidTokenValue('bg', '#fff')).toBe(false);
    expect(isValidTokenValue('bg', 'red')).toBe(false);
    expect(isValidTokenValue('border', 'rgba(255,255,255,.085)')).toBe(true);
    expect(isValidTokenValue('border', 'rgba(255,255,255,1)')).toBe(true);
    expect(isValidTokenValue('border', 'rgba(255,255,255,0)')).toBe(true);
    expect(isValidTokenValue('border', 'rgba(256,255,255,.5)')).toBe(false);
    expect(isValidTokenValue('border', 'rgba(255,255,255,1.5)')).toBe(false);
    expect(isValidTokenValue('border', 'rgba(255, 255, 255, .5)')).toBe(false);
    expect(isValidTokenValue('accent-rgb', '157,140,255')).toBe(true);
    expect(isValidTokenValue('accent-rgb', '157,140,256')).toBe(false);
    expect(isValidTokenValue('accent-rgb', '157, 140, 255')).toBe(false);
    expect(isValidTokenValue('bg', 42)).toBe(false);
  });

  it.each([
    'url(https://evil.example/x.png)', '#09090b;position:fixed', '#09090b}body{display:none', 'expression(alert(1))', '#09090b"onload="x', '#09090b\n', 'var(--text)', 'rgba(1,2,3,.5);color:red',
  ])('refuses the injection attempt %j in every token position', (attempt) => {
    for (const name of THEME_TOKEN_NAMES) expect(isValidTokenValue(name, attempt), name).toBe(false);
  });

  it('parseThemeTokens takes a complete map only: a missing, extra or malformed token makes the whole theme invalid', () => {
    const good = { ...BUILTIN_THEME_TOKENS.dark };
    expect(parseThemeTokens(good)).toEqual(good);
    const missing: Partial<ThemeTokens> = { ...good };
    delete missing.hover;
    expect(parseThemeTokens(missing)).toBeNull();
    expect(parseThemeTokens({ ...good, topbar: '12px' })).toBeNull();
    expect(parseThemeTokens({ ...good, bg: 'url(x)' })).toBeNull();
    expect(parseThemeTokens(null)).toBeNull();
    expect(parseThemeTokens([])).toBeNull();
    expect(parseThemeTokens('bg')).toBeNull();
  });

  it('the inline style is the allowlisted names with their validated values and nothing else', () => {
    const style = themeToInlineStyle(BUILTIN_THEME_TOKENS.light);
    const declarations = style.split(';');
    expect(declarations).toHaveLength(THEME_TOKEN_NAMES.length);
    for (const declaration of declarations) expect(declaration).toMatch(/^--[a-z0-9-]+:[#a-z0-9(),.]+$/);
    expect(style).not.toMatch(/[{}"'<>\\]/);
  });

  it('names lose brackets, markup and control characters, and are capped', () => {
    expect(normalizeThemeName('  Evergreen  ')).toBe('Evergreen');
    expect(normalizeThemeName('[[theme:th_000000000000]]')).toBe('theme:th_000000000000'.replace(':', ''));
    expect(normalizeThemeName('<b>Bold</b>\u0007')).toBe('bBoldb');
    expect(normalizeThemeName('Café Crème – Nuit')).toBe('Café Crème Nuit');
    expect(normalizeThemeName('x'.repeat(100))).toHaveLength(40);
    expect(normalizeThemeName('   ')).toBeNull();
    expect(normalizeThemeName('[]<>')).toBeNull();
    expect(normalizeThemeName(42)).toBeNull();
    expect(normalizeHexColor('#ABC')).toBe('#aabbcc');
    expect(normalizeHexColor('abc')).toBeNull();
  });
});

describe('deriveTheme, calibrated on the shipped palettes', () => {
  it.each(['dark', 'light'] as const)('a %s theme from the shipped seed lands near the shipped palette', (mode) => {
    const derived = deriveTheme({ mode, ...seeds[mode] });
    if (!derived.ok) throw new Error(derived.message);
    const shipped = BUILTIN_THEME_TOKENS[mode];
    // The accent is the owner's choice and is kept exactly; the neutral ramp follows the shipped one to within a few levels.
    expect(derived.tokens.accent).toBe(shipped.accent);
    expect(derived.tokens.bg).toBe(shipped.bg);
    for (const name of ['bg-raised', 'surface', 'surface-2', 'hover', 'text', 'soft', 'muted', 'faint', 'accent-strong'] as const) {
      expect(maxDelta(derived.tokens[name], shipped[name]), `${mode} ${name}: ${derived.tokens[name]} vs ${shipped[name]}`).toBeLessThanOrEqual(10);
    }
    expect(derived.adjustments).toEqual([]);
    expect(derived.checks.every((check) => check.ok)).toBe(true);
  });

  it('a light theme is held to the bar the shipped light palette misses: its status colours come out a little darker', () => {
    const derived = deriveTheme({ mode: 'light', ...seeds.light });
    if (!derived.ok) throw new Error(derived.message);
    for (const name of ['green', 'yellow', 'red', 'blue'] as const) {
      expect(luminance(parseHexColor(derived.tokens[name])!), name).toBeLessThan(luminance(parseHexColor(BUILTIN_THEME_TOKENS.light[name])!));
    }
  });

  it('is deterministic', () => {
    const a = deriveTheme({ mode: 'dark', accent: '#2dd4bf' });
    const b = deriveTheme({ mode: 'dark', accent: '#2dd4bf' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('every token it returns is a valid token, and the set is complete', () => {
    const derived = deriveTheme({ mode: 'dark', accent: '#2dd4bf', background: '#0b1220' });
    if (!derived.ok) throw new Error(derived.message);
    expect(parseThemeTokens(derived.tokens)).toEqual(derived.tokens);
    expect(Object.keys(derived.tokens).sort()).toEqual([...THEME_TOKEN_NAMES].sort());
  });

  it('a background tint shapes the page; with none, the page is tinted from the accent', () => {
    const navy = deriveTheme({ mode: 'dark', accent: '#7aa2f7', background: '#1a1b26' });
    const teal = deriveTheme({ mode: 'dark', accent: '#2dd4bf' });
    if (!navy.ok || !teal.ok) throw new Error('expected both to derive');
    expect(navy.tokens.bg).toBe('#1a1b26');
    const [r, g, b] = rgb(teal.tokens.bg);
    expect(g).toBeGreaterThanOrEqual(r);
    expect(b).toBeGreaterThanOrEqual(r);
    expect(themeSwatch(navy.tokens)).toHaveLength(5);
  });
});

describe('readability is proven, not assumed', () => {
  const accents: string[] = [];
  for (const hue of [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]) {
    for (const [s, l] of [[100, 50], [90, 30], [60, 75], [30, 50], [100, 85], [80, 15], [40, 92]] as const) {
      accents.push(hslToHex(hue, s, l));
    }
  }
  const backgrounds: Array<string | undefined> = [undefined, '#0b1220', '#2e3440', '#1e1e2e', '#fdf6e3', '#f4ecd8', '#ffffff', '#000000', '#808080'];

  function hslToHex(h: number, s: number, l: number): string {
    const sat = s / 100; const light = l / 100;
    const a = sat * Math.min(light, 1 - light);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }

  it('every seed either yields a theme that passes all checks when re-read from its own strings, or is refused with a way forward', () => {
    let accepted = 0; let refused = 0;
    for (const mode of ['dark', 'light'] as const) {
      for (const accent of accents) {
        for (const background of backgrounds) {
          const derived = deriveTheme({ mode, accent, background });
          if (derived.ok) {
            accepted += 1;
            const tokens = parseThemeTokens(derived.tokens);
            expect(tokens, `${mode} ${accent} ${background}`).not.toBeNull();
            const failing = verifyTheme(tokens!).filter((check) => !check.ok);
            expect(failing, `${mode} ${accent} ${background}`).toEqual([]);
            // Any change to what the owner chose is reported.
            for (const adjustment of derived.adjustments) expect(adjustment.from).not.toBe(adjustment.to);
          } else {
            refused += 1;
            expect(['accent_unreadable', 'background_wrong_mode']).toContain(derived.code);
            expect(derived.nextAction).toContain('ui_theme_propose');
            // A suggestion is a promise: sending it back works.
            if (derived.suggestion?.accent) expect(deriveTheme({ mode, accent: derived.suggestion.accent, background }).ok, `${mode} ${accent} ${background} → accent ${derived.suggestion.accent}`).toBe(true);
            if (derived.suggestion?.background) expect(deriveTheme({ mode, accent, background: derived.suggestion.background }).ok, `${mode} ${accent} → background ${derived.suggestion.background}`).toBe(true);
          }
        }
      }
    }
    // The sweep is meaningful in both directions.
    expect(accepted).toBeGreaterThan(500);
    expect(refused).toBeGreaterThan(20);
  });

  it('a too-light accent on a light theme is refused with the same colour made readable', () => {
    const refused = deriveTheme({ mode: 'light', accent: '#ffeb3b' });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe('accent_unreadable');
    expect(refused.suggestion?.accent).toMatch(/^#[0-9a-f]{6}$/);
    expect(refused.nextAction).toContain(refused.suggestion!.accent!);
    const retried = deriveTheme({ mode: 'light', accent: refused.suggestion!.accent! });
    expect(retried.ok).toBe(true);
  });

  it('a page that does not suit its mode is refused beyond a small correction, and lightly corrected inside it', () => {
    const wrong = deriveTheme({ mode: 'dark', accent: '#9d8cff', background: '#ffffff' });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.code).toBe('background_wrong_mode');
      expect(wrong.suggestion?.background).toMatch(/^#[0-9a-f]{6}$/);
    }
    const nearly = deriveTheme({ mode: 'dark', accent: '#9d8cff', background: '#202020' });
    if (!nearly.ok) throw new Error(nearly.message);
    expect(nearly.tokens.bg).toBe('#202020');
    const corrected = deriveTheme({ mode: 'dark', accent: '#e2e8f0', background: '#505050' });
    if (corrected.ok) expect(corrected.adjustments.some((adjustment) => adjustment.token === 'background')).toBe(true);
  });

  it('an accent that is moved says so, with the colour it moved to', () => {
    const derived = deriveTheme({ mode: 'dark', accent: '#ef4444' });
    if (!derived.ok) throw new Error(derived.message);
    const adjustment = derived.adjustments.find((entry) => entry.token === 'accent');
    expect(adjustment).toMatchObject({ from: '#ef4444', to: derived.tokens.accent });
    expect(adjustment!.reason).toMatch(/readable/);
    expect(contrastRatio(parseHexColor(derived.tokens.accent)!, parseHexColor(derived.tokens.surface)!)).toBeGreaterThanOrEqual(4.5);
  });

  it('refuses something that is not a hex colour, with the format to use', () => {
    const named = deriveTheme({ mode: 'dark', accent: 'teal' });
    expect(named.ok).toBe(false);
    if (!named.ok) {
      expect(named.code).toBe('invalid_color');
      expect(named.nextAction).toMatch(/#2dd4bf/);
    }
    expect(deriveTheme({ mode: 'dark', accent: '#2dd4bf', background: 'navy' }).ok).toBe(false);
  });

  it('the last word refuses a finished map that is not readable, names the pairs, and passes a good one', () => {
    const good = proveReadable(BUILTIN_THEME_TOKENS.dark, 'dark');
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.checks.every((check) => check.ok)).toBe(true);
    const broken = proveReadable({ ...BUILTIN_THEME_TOKENS.dark, muted: '#1a1a20', text: '#202028' }, 'dark');
    expect(broken.ok).toBe(false);
    if (!broken.ok) {
      expect(broken.code).toBe('theme_unreadable');
      expect(broken.message).toMatch(/Hint text .*needs 4\.5:1/);
      expect(broken.message).toMatch(/Main text/);
      expect(broken.nextAction).toContain('ui_theme_propose');
      expect(broken.nextAction).toContain('darker background');
    }
    const light = proveReadable({ ...BUILTIN_THEME_TOKENS.light, text: '#f0f0f0' }, 'light');
    expect(light.ok === false && light.nextAction).toContain('lighter background');
  });

  it('verifyTheme catches a theme that is not readable, and reports the pair', () => {
    const broken: ThemeTokens = { ...BUILTIN_THEME_TOKENS.dark, muted: '#1a1a20' };
    const checks = verifyTheme(broken);
    expect(checks.find((check) => check.id === 'muted')).toMatchObject({ ok: false });
    expect(checks.find((check) => check.id === 'text')).toMatchObject({ ok: true });
  });
});
