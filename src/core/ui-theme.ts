/**
 * UI themes: the saved themes, the staged proposals, and which one is active (docs/maps/ui-themes.md).
 *
 * A theme is a closed set of colour tokens (ui-theme-engine.ts), never CSS. BotBoy's chat tool STAGES a proposal; only the
 * owner's click on the chat card or the Settings → Appearance page keeps, applies, renames or deletes (api/routers/ui-theme.ts).
 * A proposal and the theme it becomes share one id, so a chat card keeps working after the owner keeps it.
 *
 * State lives in one settings row (`ui.themes.v1`), read once and written through on every change. `version()` is its revision;
 * open tabs compare it on the dashboard poll (`themeVersion`) and re-apply the active theme when it moves.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getSetting, setSetting } from './storage.js';
import {
  BUILTIN_THEME_TOKENS, deriveTheme, normalizeHexColor, normalizeThemeName, parseThemeTokens, themeSwatch, themeToInlineStyle, verifyTheme,
  type ThemeAdjustment, type ThemeCheck, type ThemeMode, type ThemeTokens,
} from './ui-theme-engine.js';

export const UI_THEMES_SETTING_KEY = 'ui.themes.v1';
export const MAX_SAVED_THEMES = 12;
export const MAX_PENDING_PROPOSALS = 10;
export const MAX_DECIDED_PROPOSALS = 30;
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const THEME_ID_RE = /^th_[0-9a-f]{12}$/;
export const BUILTIN_DARK = 'builtin:dark';
export const BUILTIN_LIGHT = 'builtin:light';
export const isThemeId = (value: unknown): value is string => typeof value === 'string' && THEME_ID_RE.test(value);

interface StoredTheme {
  id: string;
  name: string;
  mode: ThemeMode;
  seed: { accent: string; background: string | null };
  tokens: ThemeTokens;
  createdAt: string;
  updatedAt: string;
}
interface StoredProposal {
  id: string;
  seedHash: string;
  name: string;
  mode: ThemeMode;
  seed: { accent: string; background: string | null };
  status: 'pending' | 'kept' | 'discarded';
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  /** Present while pending only. */
  tokens?: ThemeTokens;
  checks?: ThemeCheck[];
  adjustments?: ThemeAdjustment[];
  /** What a decided record still shows on its chat card. */
  swatch?: string[];
}
interface StoredState {
  schema: 1;
  rev: number;
  active: string | null;
  themes: StoredTheme[];
  proposals: StoredProposal[];
}

export interface ThemeSummary {
  id: string;
  name: string;
  mode: ThemeMode;
  swatch: string[];
  builtin: boolean;
  active: boolean;
  createdAt: string | null;
}
export interface UiThemeView {
  version: number;
  /** The server's choice; null until the owner makes one (the page then falls back to its own saved light/dark choice). */
  active: string | null;
  activeTheme: { id: string; name: string; mode: ThemeMode; builtin: boolean };
  /** Set only while a saved theme is active. */
  activeTokens: ThemeTokens | null;
  builtins: ThemeSummary[];
  themes: ThemeSummary[];
  limits: { maxThemes: number };
}
export interface ProposalView {
  id: string;
  name: string;
  mode: ThemeMode;
  /** `removed`: kept once, deleted since. `expired`: never decided and past its week. */
  status: 'pending' | 'kept' | 'discarded' | 'removed';
  swatch: string[];
  accent: string;
  background: string | null;
  checks: ThemeCheck[];
  adjustments: ThemeAdjustment[];
  expiresAt: string;
  /** Only while pending, for the preview. */
  tokens: ThemeTokens | null;
  /** True when the saved theme is the one in use. */
  active: boolean;
}

export type ThemeOp<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string; nextAction: string; suggestion?: { accent?: string; background?: string } };
const refuse = (status: number, code: string, message: string, nextAction: string, suggestion?: { accent?: string; background?: string }): ThemeOp<never> =>
  ({ ok: false, status, code, message, nextAction, ...(suggestion ? { suggestion } : {}) });

export interface UiThemeDeps {
  db: Database.Database;
  now?: () => Date;
  /** Test seam: 12 hex digits for a new id. */
  newId?: () => string;
}

export interface ProposeInput { name: unknown; mode: unknown; accent: unknown; background?: unknown }
export interface ProposeValue { proposal: ProposalView; existing: boolean }

export interface UiThemes {
  version(): number;
  view(): UiThemeView;
  /** A proposal was made in the last few minutes (any outcome): a follow-up like "warmer" is then about the theme. */
  hasRecentProposal(windowMs?: number): boolean;
  propose(input: ProposeInput): ThemeOp<ProposeValue>;
  proposal(id: string): ProposalView | null;
  keep(id: string): ThemeOp<{ theme: ThemeSummary; alreadyKept: boolean }>;
  discard(id: string): ThemeOp<{ status: 'discarded' }>;
  setActive(selection: unknown): ThemeOp<UiThemeView>;
  rename(id: string, name: unknown): ThemeOp<ThemeSummary>;
  remove(id: string): ThemeOp<UiThemeView>;
  reset(): UiThemeView;
  /** Attributes for the page's <html> tag and its theme-color, or null when the page keeps its own default. */
  htmlAttributes(): { attributes: string; themeColor: string | null } | null;
}

function summaryOf(theme: StoredTheme, active: boolean): ThemeSummary {
  return { id: theme.id, name: theme.name, mode: theme.mode, swatch: themeSwatch(theme.tokens), builtin: false, active, createdAt: theme.createdAt };
}
const BUILTIN_NAMES: Record<ThemeMode, string> = { dark: 'BotBoy Dark', light: 'BotBoy Light' };

function sanitizeSeed(raw: unknown): { accent: string; background: string | null } | null {
  if (!raw || typeof raw !== 'object') return null;
  const seed = raw as Record<string, unknown>;
  const accent = normalizeHexColor(seed.accent);
  if (!accent) return null;
  const background = seed.background === null || seed.background === undefined ? null : normalizeHexColor(seed.background);
  if (seed.background !== null && seed.background !== undefined && !background) return null;
  return { accent, background };
}
const isIso = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

/** Reads the stored row defensively: anything malformed is dropped (a hand-edited or older blob never breaks the page). */
export function sanitizeUiThemeState(raw: unknown): StoredState {
  const empty: StoredState = { schema: 1, rev: 0, active: null, themes: [], proposals: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const value = raw as Record<string, unknown>;
  if (value.schema !== 1) return empty;
  const seen = new Set<string>();
  const themes: StoredTheme[] = [];
  for (const entry of Array.isArray(value.themes) ? value.themes : []) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const tokens = parseThemeTokens(item.tokens);
    const seed = sanitizeSeed(item.seed);
    const name = normalizeThemeName(item.name);
    if (!tokens || !seed || !name || !isThemeId(item.id) || seen.has(item.id)) continue;
    if (item.mode !== 'dark' && item.mode !== 'light') continue;
    if (!isIso(item.createdAt) || !isIso(item.updatedAt)) continue;
    seen.add(item.id);
    themes.push({ id: item.id, name, mode: item.mode, seed, tokens, createdAt: item.createdAt, updatedAt: item.updatedAt });
  }
  const proposals: StoredProposal[] = [];
  for (const entry of Array.isArray(value.proposals) ? value.proposals : []) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const seed = sanitizeSeed(item.seed);
    const name = normalizeThemeName(item.name);
    if (!seed || !name || !isThemeId(item.id) || (item.mode !== 'dark' && item.mode !== 'light')) continue;
    if (item.status !== 'pending' && item.status !== 'kept' && item.status !== 'discarded') continue;
    if (typeof item.seedHash !== 'string' || !isIso(item.createdAt) || !isIso(item.expiresAt)) continue;
    const base: StoredProposal = { id: item.id, seedHash: item.seedHash, name, mode: item.mode, seed, status: item.status, createdAt: item.createdAt, expiresAt: item.expiresAt };
    if (isIso(item.decidedAt)) base.decidedAt = item.decidedAt;
    if (Array.isArray(item.swatch) && item.swatch.every((entry2) => typeof entry2 === 'string' && /^#[0-9a-f]{6}$/.test(entry2))) base.swatch = item.swatch.slice(0, 5) as string[];
    if (item.status === 'pending') {
      const tokens = parseThemeTokens(item.tokens);
      if (!tokens) continue;
      base.tokens = tokens;
      base.checks = Array.isArray(item.checks) ? (item.checks as ThemeCheck[]).filter((check) => check && typeof check.id === 'string' && typeof check.label === 'string' && typeof check.ratio === 'number' && typeof check.min === 'number' && typeof check.ok === 'boolean') : [];
      base.adjustments = Array.isArray(item.adjustments) ? (item.adjustments as ThemeAdjustment[]).filter((adj) => adj && (adj.token === 'accent' || adj.token === 'background') && typeof adj.from === 'string' && typeof adj.to === 'string' && typeof adj.reason === 'string') : [];
      base.swatch = themeSwatch(tokens);
    }
    proposals.push(base);
  }
  const rev = typeof value.rev === 'number' && Number.isFinite(value.rev) && value.rev >= 0 ? Math.floor(value.rev) : 0;
  let active: string | null = null;
  if (value.active === BUILTIN_DARK || value.active === BUILTIN_LIGHT) active = value.active;
  else if (typeof value.active === 'string' && themes.some((theme) => theme.id === value.active)) active = value.active;
  return { schema: 1, rev, active, themes, proposals };
}

export function createUiThemes(deps: UiThemeDeps): UiThemes {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomBytes(6).toString('hex'));
  let raw: unknown = null;
  try {
    raw = getSetting<unknown>(deps.db, UI_THEMES_SETTING_KEY);
  } catch {
    raw = null;
  }
  let state = sanitizeUiThemeState(raw);

  function save(): void {
    state.rev += 1;
    setSetting(deps.db, UI_THEMES_SETTING_KEY, state);
  }

  /** Expired pending proposals go; decided records beyond the cap go oldest first. Returns whether anything changed. */
  function prune(): boolean {
    const before = state.proposals.length;
    const stamp = now().getTime();
    state.proposals = state.proposals.filter((proposal) => proposal.status !== 'pending' || Date.parse(proposal.expiresAt) > stamp);
    const decided = state.proposals.filter((proposal) => proposal.status !== 'pending');
    if (decided.length > MAX_DECIDED_PROPOSALS) {
      const drop = new Set(decided.sort((a, b) => Date.parse(a.decidedAt ?? a.createdAt) - Date.parse(b.decidedAt ?? b.createdAt)).slice(0, decided.length - MAX_DECIDED_PROPOSALS).map((proposal) => proposal.id));
      state.proposals = state.proposals.filter((proposal) => !drop.has(proposal.id));
    }
    return state.proposals.length !== before;
  }

  const activeSelection = (): string => state.active ?? BUILTIN_DARK;
  const themeById = (id: string): StoredTheme | undefined => state.themes.find((theme) => theme.id === id);
  const builtinSummary = (mode: ThemeMode): ThemeSummary => ({
    id: mode === 'dark' ? BUILTIN_DARK : BUILTIN_LIGHT, name: BUILTIN_NAMES[mode], mode, swatch: themeSwatch(BUILTIN_THEME_TOKENS[mode]), builtin: true,
    active: activeSelection() === (mode === 'dark' ? BUILTIN_DARK : BUILTIN_LIGHT), createdAt: null,
  });

  function view(): UiThemeView {
    const selection = activeSelection();
    const custom = selection === BUILTIN_DARK || selection === BUILTIN_LIGHT ? undefined : themeById(selection);
    const effective = custom
      ? { id: custom.id, name: custom.name, mode: custom.mode, builtin: false }
      : { id: selection === BUILTIN_LIGHT ? BUILTIN_LIGHT : BUILTIN_DARK, name: BUILTIN_NAMES[selection === BUILTIN_LIGHT ? 'light' : 'dark'], mode: (selection === BUILTIN_LIGHT ? 'light' : 'dark') as ThemeMode, builtin: true };
    return {
      version: state.rev,
      active: state.active,
      activeTheme: effective,
      activeTokens: custom ? custom.tokens : null,
      builtins: [builtinSummary('dark'), builtinSummary('light')],
      // Newest first: the theme the owner just kept is the first row on the Appearance page.
      themes: state.themes.slice().reverse().map((theme) => summaryOf(theme, theme.id === state.active)),
      limits: { maxThemes: MAX_SAVED_THEMES },
    };
  }

  function proposalView(proposal: StoredProposal): ProposalView {
    const saved = proposal.status === 'kept' ? themeById(proposal.id) : undefined;
    const status: ProposalView['status'] = proposal.status === 'kept' && !saved ? 'removed' : proposal.status;
    return {
      id: proposal.id,
      name: saved?.name ?? proposal.name,
      mode: proposal.mode,
      status,
      swatch: saved ? themeSwatch(saved.tokens) : proposal.swatch ?? [],
      accent: proposal.seed.accent,
      background: proposal.seed.background,
      checks: proposal.checks ?? [],
      adjustments: proposal.adjustments ?? [],
      expiresAt: proposal.expiresAt,
      tokens: proposal.status === 'pending' ? proposal.tokens ?? null : null,
      active: Boolean(saved) && state.active === proposal.id,
    };
  }

  function uniqueName(wanted: string, exceptId?: string): string {
    const taken = new Set(state.themes.filter((theme) => theme.id !== exceptId).map((theme) => theme.name.toLowerCase()));
    if (!taken.has(wanted.toLowerCase())) return wanted;
    for (let n = 2; n < 100; n += 1) {
      const suffix = ` ${n}`;
      const candidate = `${wanted.slice(0, 40 - suffix.length).trim()}${suffix}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return wanted;
  }

  return {
    version: () => state.rev,
    view,

    hasRecentProposal(windowMs = 15 * 60 * 1000) {
      const since = now().getTime() - windowMs;
      return state.proposals.some((proposal) => Date.parse(proposal.createdAt) >= since);
    },

    propose(input) {
      const name = normalizeThemeName(input.name);
      if (!name) return refuse(400, 'invalid_name', 'The theme needs a short name.', 'Call ui_theme_propose again with name set to a few plain words, like "Evergreen".');
      if (input.mode !== 'dark' && input.mode !== 'light') return refuse(400, 'invalid_mode', 'mode must be "dark" or "light".', 'Call ui_theme_propose again with mode "dark" or "light".');
      const accent = normalizeHexColor(input.accent);
      if (!accent) return refuse(400, 'invalid_color', `The accent "${String(input.accent).slice(0, 40)}" is not a hex colour.`, 'Call ui_theme_propose again with accent as a hex colour like "#2dd4bf" (3 or 6 digits).');
      const wantsBackground = input.background !== undefined && input.background !== null && String(input.background).trim() !== '';
      const background = wantsBackground ? normalizeHexColor(input.background) : null;
      if (wantsBackground && !background) return refuse(400, 'invalid_color', `The background "${String(input.background).slice(0, 40)}" is not a hex colour.`, 'Call ui_theme_propose again with background as a hex colour like "#0b1220", or leave it out.');

      prune();
      const seedHash = crypto.createHash('sha256').update(JSON.stringify([name.toLowerCase(), input.mode, accent, background])).digest('hex').slice(0, 16);
      const twin = state.proposals.find((proposal) => proposal.status === 'pending' && proposal.seedHash === seedHash);
      if (twin) return { ok: true, value: { proposal: proposalView(twin), existing: true } };
      if (state.themes.length >= MAX_SAVED_THEMES) {
        return refuse(409, 'theme_limit', `There are already ${MAX_SAVED_THEMES} saved themes.`, 'Tell the owner to delete one in Settings → Appearance, then try again.');
      }

      const derived = deriveTheme({ mode: input.mode, accent, background });
      if (!derived.ok) return refuse(422, derived.code, derived.message, derived.nextAction, derived.suggestion);

      let id = `th_${newId()}`;
      for (let attempt = 0; attempt < 5 && (themeById(id) || state.proposals.some((proposal) => proposal.id === id)); attempt += 1) id = `th_${newId()}`;
      const created = now();
      const pending = state.proposals.filter((proposal) => proposal.status === 'pending');
      if (pending.length >= MAX_PENDING_PROPOSALS) {
        const oldest = pending.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
        state.proposals = state.proposals.filter((proposal) => proposal.id !== oldest.id);
      }
      const proposal: StoredProposal = {
        id, seedHash, name, mode: input.mode, seed: { accent, background }, status: 'pending',
        createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + PROPOSAL_TTL_MS).toISOString(),
        tokens: derived.tokens, checks: derived.checks, adjustments: derived.adjustments, swatch: themeSwatch(derived.tokens),
      };
      state.proposals.push(proposal);
      save();
      return { ok: true, value: { proposal: proposalView(proposal), existing: false } };
    },

    proposal(id) {
      if (!isThemeId(id)) return null;
      if (prune()) save();
      const proposal = state.proposals.find((entry) => entry.id === id);
      if (proposal) return proposalView(proposal);
      const saved = themeById(id);
      if (!saved) return null;
      return {
        id, name: saved.name, mode: saved.mode, status: 'kept', swatch: themeSwatch(saved.tokens), accent: saved.seed.accent, background: saved.seed.background,
        checks: [], adjustments: [], expiresAt: saved.createdAt, tokens: null, active: state.active === id,
      };
    },

    keep(id) {
      if (!isThemeId(id)) return refuse(404, 'proposal_not_found', 'There is no such theme proposal.', 'Ask BotBoy to make the theme again.');
      if (prune()) save();
      const saved = themeById(id);
      if (saved) return { ok: true, value: { theme: summaryOf(saved, state.active === id), alreadyKept: true } };
      const proposal = state.proposals.find((entry) => entry.id === id);
      if (!proposal) return refuse(404, 'proposal_not_found', 'This proposal is no longer available (proposals last a week).', 'Ask BotBoy to make the theme again.');
      if (proposal.status === 'discarded') return refuse(409, 'proposal_discarded', 'This proposal was discarded.', 'Ask BotBoy to make the theme again.');
      if (proposal.status === 'kept') return refuse(409, 'proposal_removed', 'This theme was kept and then deleted.', 'Ask BotBoy to make the theme again.');
      if (state.themes.length >= MAX_SAVED_THEMES) return refuse(409, 'theme_limit', `There are already ${MAX_SAVED_THEMES} saved themes.`, 'Delete one in Settings → Appearance, then keep this one.');
      const tokens = parseThemeTokens(proposal.tokens);
      if (!tokens || verifyTheme(tokens).some((check) => !check.ok)) {
        return refuse(409, 'proposal_invalid', 'This proposal no longer passes the readability checks.', 'Ask BotBoy to make the theme again.');
      }
      const stamp = now().toISOString();
      const theme: StoredTheme = { id, name: uniqueName(proposal.name), mode: proposal.mode, seed: proposal.seed, tokens, createdAt: stamp, updatedAt: stamp };
      state.themes.push(theme);
      proposal.status = 'kept';
      proposal.decidedAt = stamp;
      proposal.swatch = themeSwatch(tokens);
      delete proposal.tokens; delete proposal.checks; delete proposal.adjustments;
      state.active = id;
      prune();
      save();
      return { ok: true, value: { theme: summaryOf(theme, true), alreadyKept: false } };
    },

    discard(id) {
      if (!isThemeId(id)) return refuse(404, 'proposal_not_found', 'There is no such theme proposal.', 'Ask BotBoy to make the theme again.');
      if (themeById(id)) return refuse(409, 'already_kept', 'This theme is saved.', 'Delete it in Settings → Appearance if you do not want it.');
      const proposal = state.proposals.find((entry) => entry.id === id);
      if (!proposal) return refuse(404, 'proposal_not_found', 'This proposal is no longer available.', 'Ask BotBoy to make the theme again.');
      if (proposal.status === 'discarded') return { ok: true, value: { status: 'discarded' } };
      if (proposal.status === 'kept') return refuse(409, 'proposal_removed', 'This theme was kept and then deleted.', 'Ask BotBoy to make the theme again.');
      proposal.status = 'discarded';
      proposal.decidedAt = now().toISOString();
      delete proposal.tokens; delete proposal.checks; delete proposal.adjustments;
      prune();
      save();
      return { ok: true, value: { status: 'discarded' } };
    },

    setActive(selection) {
      if (selection !== BUILTIN_DARK && selection !== BUILTIN_LIGHT && !(isThemeId(selection) && themeById(selection))) {
        return refuse(404, 'theme_not_found', 'There is no such theme.', 'Pick a theme from Settings → Appearance.');
      }
      if (state.active !== selection) {
        state.active = selection;
        save();
      }
      return { ok: true, value: view() };
    },

    rename(id, name) {
      const clean = normalizeThemeName(name);
      if (!clean) return refuse(400, 'invalid_name', 'A theme name needs a few plain letters or digits.', 'Type a short name.');
      const theme = isThemeId(id) ? themeById(id) : undefined;
      if (!theme) return refuse(404, 'theme_not_found', 'There is no such theme.', 'Pick a theme from Settings → Appearance.');
      const next = uniqueName(clean, id);
      if (next !== theme.name) {
        theme.name = next;
        theme.updatedAt = now().toISOString();
        save();
      }
      return { ok: true, value: summaryOf(theme, state.active === id) };
    },

    remove(id) {
      const theme = isThemeId(id) ? themeById(id) : undefined;
      if (!theme) return refuse(404, 'theme_not_found', 'There is no such theme.', 'Pick a theme from Settings → Appearance.');
      state.themes = state.themes.filter((entry) => entry.id !== id);
      if (state.active === id) state.active = theme.mode === 'light' ? BUILTIN_LIGHT : BUILTIN_DARK;
      save();
      return { ok: true, value: view() };
    },

    reset() {
      if (state.active !== BUILTIN_DARK) {
        state.active = BUILTIN_DARK;
        save();
      }
      return view();
    },

    htmlAttributes() {
      const selection = state.active;
      // data-botboy-choice tells the page the server has spoken, so it does not read its own saved light/dark choice over it.
      if (selection === BUILTIN_DARK || selection === BUILTIN_LIGHT) {
        const mode: ThemeMode = selection === BUILTIN_LIGHT ? 'light' : 'dark';
        return { attributes: ` data-theme="${mode}" data-botboy-choice="${selection}"`, themeColor: BUILTIN_THEME_TOKENS[mode].bg };
      }
      const custom = selection ? themeById(selection) : undefined;
      if (!custom) return null;
      return { attributes: ` data-theme="${custom.mode}" data-botboy-choice="${custom.id}" style="${themeToInlineStyle(custom.tokens)}"`, themeColor: custom.tokens.bg };
    },
  };
}

/**
 * GET / and /index.html: the page with the owner's active theme already on its first bytes. It must be registered BEFORE the static
 * handler (which would serve index.html as it is on disk). An unreadable file falls through to the static handler.
 */
export function indexHtmlHandler(uiDir: string, themes: Pick<UiThemes, 'htmlAttributes'> | undefined) {
  return (_req: unknown, res: { set(name: string, value: string): unknown; type(kind: string): { send(body: string): unknown } }, next: () => void): void => {
    let html: string;
    try {
      html = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
    } catch {
      next();
      return;
    }
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.type('html').send(renderIndexHtml(html, themes));
  };
}

const HTML_OPEN = '<html lang="en" data-theme="dark">';
const THEME_COLOR_META = '<meta name="theme-color" content="#09090b">';

/** Puts the server's active theme on the page before it paints, so a chosen theme never flashes the default one first. */
export function renderIndexHtml(html: string, themes: Pick<UiThemes, 'htmlAttributes'> | undefined): string {
  if (!themes || !html.includes(HTML_OPEN)) return html;
  let result: ReturnType<UiThemes['htmlAttributes']>;
  try {
    result = themes.htmlAttributes();
  } catch {
    return html;
  }
  if (!result) return html;
  let out = html.replace(HTML_OPEN, `<html lang="en"${result.attributes}>`);
  if (result.themeColor && out.includes(THEME_COLOR_META)) out = out.replace(THEME_COLOR_META, `<meta name="theme-color" content="${result.themeColor}">`);
  return out;
}
