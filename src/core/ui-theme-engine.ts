/**
 * UI theme engine: the colour math behind themes BotBoy makes in chat (docs/maps/ui-themes.md).
 *
 * The chat model supplies four small choices: a name, a mode (dark or light), an accent colour, and optionally a background
 * tint. This module turns them into the colour tokens the stylesheet reads and PROVES the result is readable before the owner
 * sees it:
 *   derive  → a neutral ramp from the background, the accent family, status colours, all from the seed;
 *   nudge   → a colour that misses its contrast target moves toward the readable end, inside a bound; past the bound the
 *             seed is refused with the closest readable colour as the suggestion;
 *   verify  → the FINAL tokens, read back from their strings exactly as the browser reads them, are checked pair by pair.
 *
 * Pure: no I/O, no clock, no randomness (the same seed always gives the same theme). The seven layout tokens
 * (--topbar, --sidebar-*, --assistant, --radius, --radius-lg) are never part of a theme, and neither is any CSS: a theme is a
 * closed set of named colours with strictly formatted values, so there is nothing in it to inject.
 */

export type ThemeMode = 'dark' | 'light';

/** The closed set of tokens a theme may set. The client keeps its own copy of this list and refuses anything else. */
export const THEME_TOKEN_NAMES = [
  'bg', 'bg-raised', 'surface', 'surface-2', 'hover', 'border', 'border-strong', 'text', 'soft', 'muted', 'faint',
  'accent', 'accent-strong', 'accent-soft', 'green', 'green-soft', 'yellow', 'yellow-soft', 'red', 'red-soft', 'blue', 'blue-soft',
  'accent-rgb', 'accent-fill-top', 'accent-fill-bottom', 'accent-fill-edge', 'ring-yellow',
] as const;
export type ThemeTokenName = typeof THEME_TOKEN_NAMES[number];
export type ThemeTokens = Record<ThemeTokenName, string>;

type TokenKind = 'hex' | 'rgba' | 'triplet';
const TOKEN_KIND: Record<ThemeTokenName, TokenKind> = {
  bg: 'hex', 'bg-raised': 'hex', surface: 'hex', 'surface-2': 'hex', hover: 'hex',
  border: 'rgba', 'border-strong': 'rgba', text: 'hex', soft: 'hex', muted: 'hex', faint: 'hex',
  accent: 'hex', 'accent-strong': 'hex', 'accent-soft': 'rgba',
  green: 'hex', 'green-soft': 'rgba', yellow: 'hex', 'yellow-soft': 'rgba', red: 'hex', 'red-soft': 'rgba', blue: 'hex', 'blue-soft': 'rgba',
  'accent-rgb': 'triplet', 'accent-fill-top': 'hex', 'accent-fill-bottom': 'hex', 'accent-fill-edge': 'hex', 'ring-yellow': 'hex',
};

const HEX_RE = /^#[0-9a-f]{6}$/;
const RGBA_RE = /^rgba\((\d{1,3}),(\d{1,3}),(\d{1,3}),(0|1|0?\.\d{1,3})\)$/;
const TRIPLET_RE = /^(\d{1,3}),(\d{1,3}),(\d{1,3})$/;

/** The values of the two shipped palettes (src/ui/dashboard.css). A test keeps these equal to the stylesheet. */
export const BUILTIN_THEME_TOKENS: Record<ThemeMode, ThemeTokens> = {
  dark: {
    bg: '#09090b', 'bg-raised': '#0f0f13', surface: '#131319', 'surface-2': '#191920', hover: '#202029',
    border: 'rgba(255,255,255,.085)', 'border-strong': 'rgba(255,255,255,.15)', text: '#f4f4f5', soft: '#d4d4d8', muted: '#92929d', faint: '#65656f',
    accent: '#9d8cff', 'accent-strong': '#735ce2', 'accent-soft': 'rgba(157,140,255,.13)',
    green: '#56d69a', 'green-soft': 'rgba(86,214,154,.12)', yellow: '#f3ba63', 'yellow-soft': 'rgba(243,186,99,.12)',
    red: '#f0777d', 'red-soft': 'rgba(240,119,125,.12)', blue: '#6faef5', 'blue-soft': 'rgba(111,174,245,.12)',
    'accent-rgb': '157,140,255', 'accent-fill-top': '#8e7af5', 'accent-fill-bottom': '#6852d7', 'accent-fill-edge': '#8773f2', 'ring-yellow': '#f3ba63',
  },
  light: {
    bg: '#f4f4f6', 'bg-raised': '#ffffff', surface: '#ffffff', 'surface-2': '#f8f8fb', hover: '#efeff4',
    border: 'rgba(31,25,48,.09)', 'border-strong': 'rgba(31,25,48,.16)', text: '#1c1926', soft: '#403b4b', muted: '#716d7a', faint: '#938f99',
    accent: '#6750d3', 'accent-strong': '#5d46cb', 'accent-soft': 'rgba(103,80,211,.1)',
    green: '#16885b', 'green-soft': 'rgba(22,136,91,.09)', yellow: '#a9680f', 'yellow-soft': 'rgba(169,104,15,.09)',
    red: '#bd424b', 'red-soft': 'rgba(189,66,75,.09)', blue: '#357ac5', 'blue-soft': 'rgba(53,122,197,.09)',
    'accent-rgb': '157,140,255', 'accent-fill-top': '#8e7af5', 'accent-fill-bottom': '#6852d7', 'accent-fill-edge': '#8773f2', 'ring-yellow': '#c28a00',
  },
};

// ── Colour primitives ────────────────────────────────────────────────────────────────────────────────────────────

export type Rgb = readonly [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const channel = (value: number): number => Math.min(255, Math.max(0, Math.round(value)));
const snap = (c: Rgb): Rgb => [channel(c[0]), channel(c[1]), channel(c[2])];

/** `#rgb` or `#rrggbb` (case-insensitive, surrounding spaces ignored); anything else is null. */
export function parseHexColor(text: unknown): Rgb | null {
  if (typeof text !== 'string') return null;
  const match = text.trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!match) return null;
  const digits = match[1].length === 3 ? [...match[1]].map((d) => d + d).join('') : match[1];
  return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16)) as unknown as Rgb;
}

export function toHex(c: Rgb): string {
  const [r, g, b] = snap(c);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function toLinear(value: number): number {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
export function luminance(c: Rgb): number {
  return 0.2126 * toLinear(c[0]) + 0.7152 * toLinear(c[1]) + 0.0722 * toLinear(c[2]);
}
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `a` toward `b` by `t` (0..1) in sRGB, the model CSS color-mix(in srgb) uses. */
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
/** A translucent colour painted over an opaque one, the way the browser composites it. */
function overlay(top: Rgb, alpha: number, base: Rgb): Rgb {
  return mix(base, top, alpha);
}

function toHsl(c: Rgb): [number, number, number] {
  const r = c[0] / 255; const g = c[1] / 255; const b = c[2] / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function fromHsl(h: number, s: number, l: number): Rgb {
  const hue = ((h % 360) + 360) % 360 / 360;
  const sat = Math.min(1, Math.max(0, s));
  const light = Math.min(1, Math.max(0, l));
  if (sat === 0) return [light * 255, light * 255, light * 255];
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const part = (offset: number): number => {
    let t = hue + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [part(1 / 3) * 255, part(0) * 255, part(-1 / 3) * 255];
}

const alphaText = (alpha: number): string => {
  const fixed = Number(alpha.toFixed(3));
  if (fixed >= 1) return '1';
  if (fixed <= 0) return '0';
  return String(fixed).replace(/^0\./, '.');
};
function rgbaText(c: Rgb, alpha: number): string {
  const [r, g, b] = snap(c);
  return `rgba(${r},${g},${b},${alphaText(alpha)})`;
}

// ── Token strings ────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether `value` is a well-formed value for `name` (strict formats, channels 0..255, alpha 0..1). */
export function isValidTokenValue(name: ThemeTokenName, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const kind = TOKEN_KIND[name];
  if (kind === 'hex') return HEX_RE.test(value);
  const match = (kind === 'rgba' ? RGBA_RE : TRIPLET_RE).exec(value);
  return Boolean(match) && [match![1], match![2], match![3]].every((part) => Number(part) <= 255);
}

/** A complete, strictly valid token map, or null. Extra or missing names make it invalid (a theme is the whole set). */
export function parseThemeTokens(input: unknown): ThemeTokens | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== THEME_TOKEN_NAMES.length) return null;
  const out: Partial<ThemeTokens> = {};
  for (const name of THEME_TOKEN_NAMES) {
    const value = source[name];
    if (!isValidTokenValue(name, value)) return null;
    out[name] = value;
  }
  return out as ThemeTokens;
}

/** `--bg:#09090b;--bg-raised:…` for an inline style attribute. Only call with tokens that passed parseThemeTokens. */
export function themeToInlineStyle(tokens: ThemeTokens): string {
  return THEME_TOKEN_NAMES.map((name) => `--${name}:${tokens[name]}`).join(';');
}

function readRgb(tokens: ThemeTokens, name: ThemeTokenName): Rgb {
  const value = tokens[name];
  const hexValue = parseHexColor(value);
  if (hexValue) return hexValue;
  const rgba = RGBA_RE.exec(value);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
  const triplet = TRIPLET_RE.exec(value);
  return triplet ? [Number(triplet[1]), Number(triplet[2]), Number(triplet[3])] : [0, 0, 0];
}
function readAlpha(tokens: ThemeTokens, name: ThemeTokenName): number {
  const rgba = RGBA_RE.exec(tokens[name]);
  return rgba ? Number(rgba[4]) : 1;
}

/** Five colours that tell a theme apart at a glance, for the Appearance list and the chat card. */
export function themeSwatch(tokens: ThemeTokens): string[] {
  return [tokens.bg, tokens.surface, tokens['surface-2'], tokens.accent, tokens.text];
}

// ── Readability ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ThemeCheck {
  id: string;
  label: string;
  ratio: number;
  min: number;
  ok: boolean;
}

type Ground = ThemeTokenName | { over: ThemeTokenName; on: ThemeTokenName };
interface PairSpec { id: string; label: string; fg: ThemeTokenName | 'white'; grounds: Ground[]; min: number }

const PLAIN: ThemeTokenName[] = ['bg', 'surface', 'surface-2'];
const withHover: ThemeTokenName[] = ['bg', 'surface', 'surface-2', 'hover'];
const soft = (over: ThemeTokenName): Ground[] => PLAIN.map((on) => ({ over, on }));

/**
 * The text/background pairs the stylesheet actually uses (counted from dashboard.css), held to WCAG AA for normal text (4.5:1).
 * Placeholder text only needs the 3:1 the shipped palettes have, white-on-the-top-of-a-button is a large bold label (3:1), and the
 * paused-job outline is a shape, not text (3:1 against the strip).
 */
const PAIRS: PairSpec[] = [
  { id: 'text', label: 'Main text', fg: 'text', grounds: withHover, min: 4.5 },
  { id: 'soft', label: 'Secondary text', fg: 'soft', grounds: withHover, min: 4.5 },
  { id: 'muted', label: 'Hint text', fg: 'muted', grounds: PLAIN, min: 4.5 },
  { id: 'faint', label: 'Placeholder text', fg: 'faint', grounds: ['surface', 'surface-2'], min: 3 },
  { id: 'accent', label: 'Accent text and links', fg: 'accent', grounds: PLAIN, min: 4.5 },
  { id: 'accent-label', label: 'Accent labels and chips', fg: 'accent', grounds: soft('accent-soft'), min: 4.5 },
  { id: 'selected', label: 'Text on selected rows', fg: 'text', grounds: soft('accent-soft'), min: 4.5 },
  { id: 'selected-soft', label: 'Secondary text on selected rows', fg: 'soft', grounds: soft('accent-soft'), min: 4.5 },
  { id: 'button', label: 'White text on buttons', fg: 'white', grounds: ['accent-strong', 'accent-fill-bottom'], min: 4.5 },
  { id: 'button-top', label: 'White text at the top edge of buttons', fg: 'white', grounds: ['accent-fill-top'], min: 3 },
  { id: 'green', label: 'Success text and chips', fg: 'green', grounds: [...PLAIN, ...soft('green-soft')], min: 4.5 },
  { id: 'yellow', label: 'Warning text and chips', fg: 'yellow', grounds: [...PLAIN, ...soft('yellow-soft')], min: 4.5 },
  { id: 'red', label: 'Error text and chips', fg: 'red', grounds: [...PLAIN, ...soft('red-soft')], min: 4.5 },
  { id: 'blue', label: 'Info text and chips', fg: 'blue', grounds: [...PLAIN, ...soft('blue-soft')], min: 4.5 },
  { id: 'job-ring', label: 'Paused job outline', fg: 'ring-yellow', grounds: ['surface'], min: 3 },
];

function resolveGround(tokens: ThemeTokens, ground: Ground): Rgb {
  if (typeof ground === 'string') return readRgb(tokens, ground);
  return overlay(readRgb(tokens, ground.over), readAlpha(tokens, ground.over), readRgb(tokens, ground.on));
}

/**
 * Every readability pair, recomputed from the token STRINGS (so rounding and formatting are already applied). This is the
 * independent re-check: it does not know how the tokens were derived. The ratio shown for a pair is its worst background.
 */
export function verifyTheme(tokens: ThemeTokens): ThemeCheck[] {
  return PAIRS.map((pair) => {
    const fg = pair.fg === 'white' ? WHITE : readRgb(tokens, pair.fg);
    const worst = Math.min(...pair.grounds.map((ground) => contrastRatio(fg, resolveGround(tokens, ground))));
    const ratio = Math.floor(worst * 100) / 100;
    return { id: pair.id, label: pair.label, ratio, min: pair.min, ok: worst >= pair.min };
  });
}

// ── Derivation ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface ThemeAdjustment { token: 'accent' | 'background'; from: string; to: string; reason: string }
export type ThemeErrorCode = 'invalid_color' | 'accent_unreadable' | 'background_wrong_mode' | 'theme_unreadable';
export interface ThemeDeriveFailure {
  ok: false;
  code: ThemeErrorCode;
  message: string;
  nextAction: string;
  /** The closest values that would work, when there are any. */
  suggestion?: { accent?: string; background?: string };
}
export interface ThemeDeriveSuccess {
  ok: true;
  tokens: ThemeTokens;
  checks: ThemeCheck[];
  adjustments: ThemeAdjustment[];
}
export type ThemeDeriveResult = ThemeDeriveSuccess | ThemeDeriveFailure;

export interface ThemeSeedColors { mode: ThemeMode; accent: string; background?: string | null }

/** Derivation aims a little above each target so rounding to whole channel values can never drop a pair under it. */
const MARGIN = 0.03;
/** The most an accent may be moved toward white or black (fraction of the way) before the seed is refused instead. */
const ACCENT_MAX_SHIFT = 0.55;
/** The most a background may be moved to fit its mode before the seed is refused instead. */
const BACKGROUND_MAX_SHIFT = 0.5;
/**
 * Relative luminance bounds: a dark theme's page must stay at or under, a light theme's at or over. They are loose on purpose
 * (every popular editor theme sits well inside them); the pair checks below decide whether the colours really work together.
 */
const DARK_BG_MAX_LUMINANCE = 0.08;
const LIGHT_BG_MIN_LUMINANCE = 0.5;

/** Where each neutral sits between the background and the text colour, measured on the two shipped palettes. */
const RAMP = {
  dark: { soft: 0.864, muted: 0.583, faint: 0.391, raised: 0.0255, surface: 0.0426, surface2: 0.068, hover: 0.098 },
  light: { soft: 0.833, muted: 0.606, faint: 0.449, surface2: 0.45, hover: 0.02 },
} as const;

/** The first colour on the way from `from` toward `toward` (steps of 1%) for which `ok` holds, within `maxShift`. */
function nudge(from: Rgb, toward: Rgb, ok: (candidate: Rgb) => boolean, maxShift: number): { color: Rgb; shift: number } | null {
  for (let step = 0; step <= Math.round(maxShift * 100); step += 1) {
    const color = snap(mix(from, toward, step / 100));
    if (ok(color)) return { color, shift: step / 100 };
  }
  return null;
}

function fail(code: ThemeErrorCode, message: string, nextAction: string, suggestion?: ThemeDeriveFailure['suggestion']): ThemeDeriveFailure {
  return { ok: false, code, message, nextAction, ...(suggestion ? { suggestion } : {}) };
}

export function deriveTheme(seed: ThemeSeedColors): ThemeDeriveResult {
  return derive(seed, true);
}

/** `suggest` lets a refusal try a few darker/lighter backgrounds and name one that works; the trial runs never suggest again. */
function derive(seed: ThemeSeedColors, suggest: boolean): ThemeDeriveResult {
  const dark = seed.mode === 'dark';
  const accentIn = parseHexColor(seed.accent);
  if (!accentIn) {
    return fail('invalid_color', `The accent "${String(seed.accent).slice(0, 40)}" is not a hex colour.`, 'Call ui_theme_propose again with accent as a hex colour like "#2dd4bf" (3 or 6 digits).');
  }
  const wantsBackground = seed.background !== undefined && seed.background !== null && String(seed.background).trim() !== '';
  const backgroundIn = wantsBackground ? parseHexColor(seed.background) : null;
  if (wantsBackground && !backgroundIn) {
    return fail('invalid_color', `The background "${String(seed.background).slice(0, 40)}" is not a hex colour.`, 'Call ui_theme_propose again with background as a hex colour like "#0b1220", or leave it out.');
  }

  const adjustments: ThemeAdjustment[] = [];
  const [accentHue] = toHsl(accentIn);
  let tint = accentHue;
  if (backgroundIn) {
    const [backgroundHue, backgroundSat] = toHsl(backgroundIn);
    if (backgroundSat >= 0.06) tint = backgroundHue;
  }

  // A refusal names a background only if sending it back really works: each candidate is derived for real (without suggesting again).
  const workingBackground = (start: Rgb, steps: number[]): string | null => {
    if (!suggest) return null;
    for (const step of steps) {
      const candidate = toHex(snap(mix(start, dark ? BLACK : WHITE, step)));
      if (derive({ mode: seed.mode, accent: toHex(accentIn), background: candidate }, false).ok) return candidate;
    }
    return null;
  };

  // 1. The page background, kept on the right side of the mode.
  let bg: Rgb = backgroundIn ?? (dark ? fromHsl(tint, 0.13, 0.042) : fromHsl(tint, 0.12, 0.965));
  if (backgroundIn) {
    const fitsMode = (c: Rgb): boolean => (dark ? luminance(c) <= DARK_BG_MAX_LUMINANCE : luminance(c) >= LIGHT_BG_MIN_LUMINANCE);
    if (!fitsMode(bg)) {
      const moved = nudge(bg, dark ? BLACK : WHITE, fitsMode, BACKGROUND_MAX_SHIFT);
      if (!moved) {
        const nearest = nudge(bg, dark ? BLACK : WHITE, fitsMode, 1);
        const example = nearest ? workingBackground(nearest.color, [0, 0.15, 0.3, 0.5, 0.75]) : null;
        return fail(
          'background_wrong_mode',
          `The background ${toHex(bg)} is too ${dark ? 'light' : 'dark'} for a ${seed.mode} theme: text could not be read on it.`,
          dark
            ? `Call ui_theme_propose again with a darker background${example ? ` (for example "${example}")` : ''}, or with mode "light" if the owner wants a light page.`
            : `Call ui_theme_propose again with a lighter background${example ? ` (for example "${example}")` : ''}, or with mode "dark" if the owner wants a dark page.`,
          example ? { background: example } : undefined,
        );
      }
      adjustments.push({ token: 'background', from: toHex(bg), to: toHex(moved.color), reason: `${dark ? 'Darkened' : 'Lightened'} so text stays readable on a ${seed.mode} theme.` });
      bg = moved.color;
    }
  }
  bg = snap(bg);

  // 2. The text colour and the neutral ramp between the background and it.
  const ink: Rgb = snap(dark ? fromHsl(tint, 0.08, 0.96) : fromHsl(tint, 0.2, 0.13));
  const [, bgSaturation] = toHsl(bg);
  const cardMix = 1 - 0.4 * Math.min(1, bgSaturation / 0.3);
  const ramp = dark ? RAMP.dark : RAMP.light;
  const raised = snap(dark ? mix(bg, ink, RAMP.dark.raised) : mix(bg, WHITE, cardMix));
  const surface = snap(dark ? mix(bg, ink, RAMP.dark.surface) : mix(bg, WHITE, cardMix));
  const surface2 = snap(dark ? mix(bg, ink, RAMP.dark.surface2) : mix(bg, WHITE, RAMP.light.surface2));
  const hover = snap(dark ? mix(bg, ink, RAMP.dark.hover) : mix(bg, ink, RAMP.light.hover));
  const grounds: Rgb[] = [bg, surface, surface2, hover];
  const against = (c: Rgb, list: Rgb[], target: number): boolean => list.every((ground) => contrastRatio(c, ground) >= target + MARGIN);

  const toward = dark ? WHITE : BLACK;
  const text = ink;
  const neutral = (weight: number, list: Rgb[], target: number): Rgb => {
    const start = snap(mix(bg, ink, weight));
    return nudge(start, toward, (c) => against(c, list, target), 1)?.color ?? start;
  };
  let softText = neutral(ramp.soft, grounds, 4.5);
  const muted = neutral(ramp.muted, [bg, surface, surface2], 4.5);
  const faint = neutral(ramp.faint, [surface, surface2], 3);

  // 3. The accent: readable as text on the page and on its own tinted chip, or refused.
  const accentSoftAlpha = dark ? 0.13 : 0.1;
  const accentReadable = (c: Rgb): boolean => against(c, [bg, surface, surface2], 4.5)
    && against(c, [bg, surface, surface2].map((ground) => overlay(c, accentSoftAlpha, ground)), 4.5);
  let accent = snap(accentIn);
  if (!accentReadable(accent)) {
    const moved = nudge(accent, toward, accentReadable, ACCENT_MAX_SHIFT);
    if (!moved) {
      const closest = nudge(accent, toward, accentReadable, 1);
      const suggestion: NonNullable<ThemeDeriveFailure['suggestion']> = {};
      if (closest) suggestion.accent = toHex(closest.color);
      const betterBackground = backgroundIn ? workingBackground(bg, [0.25, 0.5, 0.75, 0.9]) : null;
      if (betterBackground) suggestion.background = betterBackground;
      const reason = backgroundIn
        ? `The accent ${toHex(accentIn)} cannot be made readable as text on the background ${toHex(backgroundIn)}${toHex(bg) !== toHex(backgroundIn) ? ` (${dark ? 'darkened' : 'lightened'} to ${toHex(bg)} to suit a ${seed.mode} theme)` : ''} without changing it into a different colour.`
        : `The accent ${toHex(accentIn)} is too ${dark ? 'dark' : 'light'} to read as text on a ${seed.mode} theme without changing it into a different colour.`;
      const options = [
        closest ? `accent "${toHex(closest.color)}" (the same colour made readable)` : null,
        betterBackground ? `background "${betterBackground}" (a ${dark ? 'darker' : 'lighter'} page that suits this accent)` : null,
      ].filter(Boolean);
      return fail(
        'accent_unreadable',
        reason,
        `Call ui_theme_propose again with ${options.length > 0 ? options.join(', or ') : `a ${dark ? 'lighter' : 'darker'} accent`}.`,
        Object.keys(suggestion).length > 0 ? suggestion : undefined,
      );
    }
    adjustments.push({ token: 'accent', from: toHex(accentIn), to: toHex(moved.color), reason: `Moved ${dark ? 'lighter' : 'darker'} so accent text and chips stay readable on a ${seed.mode} theme.` });
    accent = moved.color;
  }

  // Secondary text also sits on selected rows (the accent tint over each surface), which only the accent decides.
  const selectedRows = [bg, surface, surface2].map((ground) => overlay(accent, accentSoftAlpha, ground));
  if (!against(softText, selectedRows, 4.5)) {
    softText = nudge(softText, toward, (c) => against(c, [...grounds, ...selectedRows], 4.5), 1)?.color ?? softText;
  }

  // 4. The accent family: the solid used behind white text, the button gradient, the tint colour for borders and glows.
  const [accentH, accentS, accentL] = toHsl(accent);
  const strongS = Math.min(accentS, 0.72);
  let strongL = accentL - 0.03;
  while (strongL > 0 && contrastRatio(WHITE, snap(fromHsl(accentH, strongS, strongL))) < 4.8 + MARGIN) strongL -= 0.005;
  const strong = snap(fromHsl(accentH, strongS, Math.max(0, strongL)));
  let bottomL = strongL - 0.03;
  while (bottomL > 0 && contrastRatio(WHITE, snap(fromHsl(accentH, Math.max(0, strongS - 0.08), bottomL))) < 4.5 + MARGIN) bottomL -= 0.005;
  const fillBottom = snap(fromHsl(accentH, Math.max(0, strongS - 0.08), Math.max(0, bottomL)));
  let topLift = 0.1;
  const fillTopAt = (lift: number): Rgb => snap(fromHsl(accentH, Math.min(1, strongS + 0.17), Math.min(0.95, strongL + lift)));
  while (topLift > 0 && contrastRatio(WHITE, fillTopAt(topLift)) < 3 + MARGIN) topLift -= 0.005;
  const fillTop = fillTopAt(Math.max(0, topLift));
  const fillEdge = snap(fromHsl(accentH, Math.min(1, strongS + 0.14), Math.min(0.95, strongL + Math.min(0.065, Math.max(0, topLift)))));
  const accentRgb: Rgb = dark ? accent : snap(mix(accent, WHITE, 0.38));

  // 5. Status colours: the shipped hues, moved toward the readable end only as far as this background needs.
  const base = BUILTIN_THEME_TOKENS[seed.mode];
  const statusAlpha = dark ? 0.12 : 0.09;
  const status = (name: 'green' | 'yellow' | 'red' | 'blue'): Rgb => {
    const start = parseHexColor(base[name])!;
    const readable = (c: Rgb): boolean => against(c, [bg, surface, surface2], 4.5)
      && against(c, [bg, surface, surface2].map((ground) => overlay(c, statusAlpha, ground)), 4.5);
    return nudge(start, toward, readable, 1)?.color ?? start;
  };
  const green = status('green'); const yellow = status('yellow'); const red = status('red'); const blue = status('blue');

  // 6. The ring for a paused job: gold on a light theme (its --yellow is a dark amber made for text), the yellow itself on a dark one.
  const ringStart = parseHexColor(base['ring-yellow'])!;
  const ring = dark ? yellow : (nudge(ringStart, BLACK, (c) => contrastRatio(c, surface) >= 3 + MARGIN, 1)?.color ?? ringStart);

  const tokens: ThemeTokens = {
    bg: toHex(bg), 'bg-raised': toHex(raised), surface: toHex(surface), 'surface-2': toHex(surface2), hover: toHex(hover),
    border: rgbaText(dark ? WHITE : ink, dark ? 0.085 : 0.09), 'border-strong': rgbaText(dark ? WHITE : ink, dark ? 0.15 : 0.16),
    text: toHex(text), soft: toHex(softText), muted: toHex(muted), faint: toHex(faint),
    accent: toHex(accent), 'accent-strong': toHex(strong), 'accent-soft': rgbaText(accent, accentSoftAlpha),
    green: toHex(green), 'green-soft': rgbaText(green, statusAlpha), yellow: toHex(yellow), 'yellow-soft': rgbaText(yellow, statusAlpha),
    red: toHex(red), 'red-soft': rgbaText(red, statusAlpha), blue: toHex(blue), 'blue-soft': rgbaText(blue, statusAlpha),
    'accent-rgb': snap(accentRgb).join(','), 'accent-fill-top': toHex(fillTop), 'accent-fill-bottom': toHex(fillBottom), 'accent-fill-edge': toHex(fillEdge),
    'ring-yellow': toHex(ring),
  };

  // 7. The independent check. Nothing is returned that does not pass it.
  const proof = proveReadable(tokens, seed.mode);
  if (!proof.ok) return proof;
  return { ok: true, tokens, checks: proof.checks, adjustments };
}

/**
 * The last word on a finished token map: every readability pair re-read from the strings. `deriveTheme` ends with it, and it is
 * exported so a hand-built or tampered map can be judged the same way. A pass returns the checks; a miss returns the refusal.
 */
export function proveReadable(tokens: ThemeTokens, mode: ThemeMode): { ok: true; checks: ThemeCheck[] } | ThemeDeriveFailure {
  const checks = verifyTheme(tokens);
  const failed = checks.filter((check) => !check.ok);
  if (failed.length === 0) return { ok: true, checks };
  return fail(
    'theme_unreadable',
    `These colours could not be made readable together (${failed.map((check) => `${check.label} ${check.ratio}:1, needs ${check.min}:1`).join('; ')}).`,
    `Call ui_theme_propose again with a ${mode === 'dark' ? 'darker' : 'lighter'} background or a different accent.`,
  );
}

// ── Names and seeds ──────────────────────────────────────────────────────────────────────────────────────────────

export const THEME_NAME_MAX = 40;

/** Plain letters, digits, spaces and a few marks; brackets, angle brackets, quotes and control characters are dropped. */
export function normalizeThemeName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.normalize('NFC').replace(/[^\p{L}\p{N} \-_.,&'()!?+]/gu, '').replace(/\s+/g, ' ').trim().slice(0, THEME_NAME_MAX).trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** `#AABBCC` and `#abc` become `#aabbcc`; null when it is not a hex colour. */
export function normalizeHexColor(input: unknown): string | null {
  const rgb = parseHexColor(input);
  return rgb ? toHex(rgb) : null;
}
