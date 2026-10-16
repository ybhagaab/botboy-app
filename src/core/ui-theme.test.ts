// Saved themes, staged proposals and the active choice (docs/maps/ui-themes.md): the owner's decisions, the limits, and the page template.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, getSetting, setSetting, type StorageLayer } from './storage.js';
import {
  BUILTIN_DARK, BUILTIN_LIGHT, MAX_DECIDED_PROPOSALS, MAX_PENDING_PROPOSALS, MAX_SAVED_THEMES, PROPOSAL_TTL_MS, UI_THEMES_SETTING_KEY,
  createUiThemes, isThemeId, renderIndexHtml, sanitizeUiThemeState, type UiThemes,
} from './ui-theme.js';
import { BUILTIN_THEME_TOKENS, parseThemeTokens, verifyTheme } from './ui-theme-engine.js';

describe('ui themes', () => {
  let storage: StorageLayer;
  let clock: number;
  let counter: number;
  const db = () => storage.getDb();
  const make = (): UiThemes => createUiThemes({ db: db(), now: () => new Date(clock), newId: () => (counter++).toString(16).padStart(12, '0') });
  const propose = (themes: UiThemes, over: Record<string, unknown> = {}) => themes.propose({ name: 'Evergreen', mode: 'dark', accent: '#2dd4bf', ...over });
  const proposed = (themes: UiThemes, over: Record<string, unknown> = {}) => {
    const result = propose(themes, over);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    return result.value.proposal;
  };

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    clock = Date.parse('2026-10-16T10:00:00.000Z');
    counter = 1;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    storage.close();
    vi.restoreAllMocks();
  });

  it('starts empty with the shipped dark theme in use, and writes nothing until something changes', () => {
    const themes = make();
    expect(themes.version()).toBe(0);
    const view = themes.view();
    expect(view).toMatchObject({ version: 0, active: null, activeTheme: { id: BUILTIN_DARK, builtin: true, mode: 'dark' }, activeTokens: null, themes: [] });
    expect(view.builtins.map((entry) => [entry.id, entry.active])).toEqual([[BUILTIN_DARK, true], [BUILTIN_LIGHT, false]]);
    expect(getSetting(db(), UI_THEMES_SETTING_KEY)).toBeNull();
    expect(themes.htmlAttributes()).toBeNull();
  });

  describe('a proposal', () => {
    it('is staged with its readability proof, changes nothing in use, and bumps the revision', () => {
      const themes = make();
      const proposal = proposed(themes);
      expect(isThemeId(proposal.id)).toBe(true);
      expect(proposal).toMatchObject({ name: 'Evergreen', mode: 'dark', status: 'pending', accent: '#2dd4bf', background: null, active: false });
      expect(proposal.checks.length).toBeGreaterThan(10);
      expect(proposal.checks.every((check) => check.ok)).toBe(true);
      expect(proposal.swatch).toHaveLength(5);
      expect(parseThemeTokens(proposal.tokens)).not.toBeNull();
      expect(themes.view()).toMatchObject({ active: null, themes: [] });
      expect(themes.version()).toBe(1);
      expect(themes.htmlAttributes()).toBeNull();
    });

    it('asking for the same thing again returns the same proposal (a model that repeats itself makes one card)', () => {
      const themes = make();
      const first = proposed(themes);
      const again = propose(themes);
      expect(again.ok && again.value.existing).toBe(true);
      expect(again.ok && again.value.proposal.id).toBe(first.id);
      expect(themes.version()).toBe(1);
      expect(proposed(themes, { name: 'Evergreen', accent: '#22c55e' }).id).not.toBe(first.id);
    });

    it('refuses a bad name, mode or colour with a next action that names the tool', () => {
      const themes = make();
      for (const bad of [{ name: '' }, { name: '[[]]' }, { mode: 'blue' }, { accent: 'teal' }, { accent: undefined }, { background: 'navy' }]) {
        const result = propose(themes, bad);
        expect(result.ok, JSON.stringify(bad)).toBe(false);
        if (!result.ok) {
          expect(result.status).toBe(400);
          expect(result.nextAction.length).toBeGreaterThan(10);
        }
      }
      expect(themes.version()).toBe(0);
    });

    it('carries the engine refusal and its suggestion when the colours cannot be made readable', () => {
      const result = propose(make(), { mode: 'light', accent: '#ffeb3b' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result).toMatchObject({ status: 422, code: 'accent_unreadable' });
        expect(result.suggestion?.accent).toMatch(/^#[0-9a-f]{6}$/);
      }
    });

    it('expires after a week; the card then says it is gone', () => {
      const themes = make();
      const { id } = proposed(themes);
      clock += PROPOSAL_TTL_MS - 1000;
      expect(themes.proposal(id)?.status).toBe('pending');
      clock += 2000;
      expect(themes.proposal(id)).toBeNull();
      const kept = themes.keep(id);
      expect(kept).toMatchObject({ ok: false, status: 404, code: 'proposal_not_found' });
    });

    it('keeps the newest ten pending proposals', () => {
      const themes = make();
      const ids = Array.from({ length: MAX_PENDING_PROPOSALS + 2 }, (_, index) => proposed(themes, { name: `Option ${index}`, accent: `#${(index + 1).toString(16).padStart(2, '0')}c5e0` }).id);
      expect(themes.proposal(ids[0])).toBeNull();
      expect(themes.proposal(ids[1])).toBeNull();
      expect(themes.proposal(ids[2])?.status).toBe('pending');
      expect(themes.proposal(ids[ids.length - 1])?.status).toBe('pending');
    });

    it('knows when one was made in the last few minutes (a follow-up like "warmer" is still about the theme)', () => {
      const themes = make();
      expect(themes.hasRecentProposal()).toBe(false);
      proposed(themes);
      expect(themes.hasRecentProposal()).toBe(true);
      clock += 16 * 60 * 1000;
      expect(themes.hasRecentProposal()).toBe(false);
    });
  });

  describe('keeping', () => {
    it('saves the proposal as a theme with the same id, makes it the active theme, and drops the proposal tokens', () => {
      const themes = make();
      const { id } = proposed(themes);
      const kept = themes.keep(id);
      expect(kept.ok && kept.value).toMatchObject({ alreadyKept: false, theme: { id, name: 'Evergreen', mode: 'dark', active: true, builtin: false } });
      const view = themes.view();
      expect(view.active).toBe(id);
      expect(view.activeTheme).toMatchObject({ id, name: 'Evergreen', builtin: false });
      expect(parseThemeTokens(view.activeTokens)).not.toBeNull();
      expect(view.themes.map((theme) => theme.id)).toEqual([id]);
      const card = themes.proposal(id);
      expect(card).toMatchObject({ status: 'kept', active: true, tokens: null });
      const stored = JSON.stringify(getSetting(db(), UI_THEMES_SETTING_KEY));
      expect(stored.match(/"bg":/g)?.length).toBe(1);
    });

    it('is idempotent: keeping twice is one theme', () => {
      const themes = make();
      const { id } = proposed(themes);
      themes.keep(id);
      const again = themes.keep(id);
      expect(again.ok && again.value.alreadyKept).toBe(true);
      expect(themes.view().themes).toHaveLength(1);
    });

    it('gives a repeated name a number rather than refusing', () => {
      const themes = make();
      themes.keep(proposed(themes).id);
      const second = themes.keep(proposed(themes, { accent: '#22c55e' }).id);
      expect(second.ok && second.value.theme.name).toBe('Evergreen 2');
    });

    it('stops at the limit, and says what to delete', () => {
      const themes = make();
      for (let index = 0; index < MAX_SAVED_THEMES; index += 1) themes.keep(proposed(themes, { name: `Theme ${index}`, accent: `#${(index + 16).toString(16)}b5c0` }).id);
      expect(themes.view().themes).toHaveLength(MAX_SAVED_THEMES);
      const over = propose(themes, { name: 'One more', accent: '#ff7a00' });
      expect(over).toMatchObject({ ok: false, status: 409, code: 'theme_limit' });
      if (!over.ok) expect(over.nextAction).toMatch(/Settings → Appearance/);
    });

    it('also stops at the limit when the proposals were made before it was reached (the check is at keep, not only at propose)', () => {
      const themes = make();
      for (let index = 0; index < MAX_SAVED_THEMES - 4; index += 1) themes.keep(proposed(themes, { name: `Saved ${index}`, accent: `#${(index + 16).toString(16)}b5c0` }).id);
      const waiting = Array.from({ length: 5 }, (_, index) => proposed(themes, { name: `Waiting ${index}`, accent: `#${(index + 48).toString(16)}9ac0` }).id);
      for (const id of waiting.slice(0, 4)) expect(themes.keep(id).ok).toBe(true);
      expect(themes.view().themes).toHaveLength(MAX_SAVED_THEMES);
      const refused = themes.keep(waiting[4]);
      expect(refused).toMatchObject({ ok: false, status: 409, code: 'theme_limit' });
      if (!refused.ok) expect(refused.nextAction).toMatch(/Delete one in Settings → Appearance/);
      expect(themes.view().themes).toHaveLength(MAX_SAVED_THEMES);
      // The proposal is still there to keep once a theme is deleted.
      themes.remove(themes.view().themes[0].id);
      expect(themes.keep(waiting[4]).ok).toBe(true);
    });

    it('a discarded or unknown proposal cannot be kept', () => {
      const themes = make();
      const { id } = proposed(themes);
      expect(themes.discard(id)).toMatchObject({ ok: true });
      expect(themes.keep(id)).toMatchObject({ ok: false, status: 409, code: 'proposal_discarded' });
      expect(themes.keep('th_ffffffffffff')).toMatchObject({ ok: false, status: 404 });
      expect(themes.keep('not an id')).toMatchObject({ ok: false, status: 404 });
    });

    it('re-checks readability before it saves: a stored proposal that was altered is refused', () => {
      const first = make();
      const { id } = proposed(first);
      const raw = JSON.parse(JSON.stringify(getSetting(db(), UI_THEMES_SETTING_KEY)));
      raw.proposals[0].tokens.muted = '#101015';
      setSetting(db(), UI_THEMES_SETTING_KEY, raw);
      const reloaded = make();
      const result = reloaded.keep(id);
      expect(result).toMatchObject({ ok: false, status: 409, code: 'proposal_invalid' });
      expect(reloaded.view().themes).toEqual([]);
    });
  });

  describe('discarding', () => {
    it('marks it, keeps the card honest, and is repeatable', () => {
      const themes = make();
      const { id } = proposed(themes);
      expect(themes.discard(id)).toMatchObject({ ok: true, value: { status: 'discarded' } });
      expect(themes.discard(id)).toMatchObject({ ok: true });
      expect(themes.proposal(id)).toMatchObject({ status: 'discarded', tokens: null });
      expect(themes.view().themes).toEqual([]);
    });

    it('cannot discard a theme that is saved', () => {
      const themes = make();
      const { id } = proposed(themes);
      themes.keep(id);
      expect(themes.discard(id)).toMatchObject({ ok: false, status: 409, code: 'already_kept' });
    });

    it('keeps at most thirty finished proposals', () => {
      const themes = make();
      const ids: string[] = [];
      for (let index = 0; index < MAX_DECIDED_PROPOSALS + 3; index += 1) {
        const { id } = proposed(themes, { name: `Try ${index}`, accent: `#${(index + 16).toString(16)}9ac0` });
        themes.discard(id);
        ids.push(id);
        clock += 1000;
      }
      expect(themes.proposal(ids[0])).toBeNull();
      expect(themes.proposal(ids[ids.length - 1])?.status).toBe('discarded');
    });
  });

  describe('the active choice, rename, delete and reset', () => {
    it('switches between the shipped themes and saved ones, and refuses anything else', () => {
      const themes = make();
      const { id } = proposed(themes);
      themes.keep(id);
      expect(themes.setActive(BUILTIN_LIGHT)).toMatchObject({ ok: true, value: { active: BUILTIN_LIGHT, activeTheme: { builtin: true, mode: 'light' }, activeTokens: null } });
      expect(themes.setActive(id)).toMatchObject({ ok: true, value: { active: id } });
      expect(themes.setActive('th_ffffffffffff')).toMatchObject({ ok: false, status: 404, code: 'theme_not_found' });
      expect(themes.setActive('builtin:sepia')).toMatchObject({ ok: false, status: 404 });
      expect(themes.setActive(42)).toMatchObject({ ok: false });
    });

    it('does not bump the revision when nothing changed', () => {
      const themes = make();
      themes.setActive(BUILTIN_DARK);
      const version = themes.version();
      themes.setActive(BUILTIN_DARK);
      expect(themes.version()).toBe(version);
    });

    it('renames, with the same numbering rule, and keeps the colours', () => {
      const themes = make();
      const a = proposed(themes);
      themes.keep(a.id);
      const b = proposed(themes, { name: 'Other', accent: '#22c55e' });
      themes.keep(b.id);
      const renamed = themes.rename(b.id, '  Evergreen ');
      expect(renamed.ok && renamed.value.name).toBe('Evergreen 2');
      expect(themes.rename(b.id, '[]')).toMatchObject({ ok: false, status: 400 });
      expect(themes.rename('th_ffffffffffff', 'x')).toMatchObject({ ok: false, status: 404 });
      expect(themes.rename(a.id, 'evergreen')).toMatchObject({ ok: true, value: { name: 'evergreen' } });
    });

    it('deleting the theme in use falls back to the shipped theme of its own mode; deleting another leaves the choice alone', () => {
      const themes = make();
      const dark = proposed(themes);
      themes.keep(dark.id);
      const light = proposed(themes, { name: 'Paper', mode: 'light', accent: '#0d9488' });
      themes.keep(light.id);
      expect(themes.view().active).toBe(light.id);
      expect(themes.remove(dark.id)).toMatchObject({ ok: true, value: { active: light.id } });
      const removed = themes.remove(light.id);
      expect(removed).toMatchObject({ ok: true, value: { active: BUILTIN_LIGHT, themes: [] } });
      expect(themes.remove(light.id)).toMatchObject({ ok: false, status: 404 });
      expect(themes.proposal(light.id)).toMatchObject({ status: 'removed' });
    });

    it('reset returns to the shipped dark theme and keeps the saved themes', () => {
      const themes = make();
      const { id } = proposed(themes);
      themes.keep(id);
      const view = themes.reset();
      expect(view).toMatchObject({ active: BUILTIN_DARK, activeTokens: null });
      expect(view.themes).toHaveLength(1);
    });

    it('lists the newest saved theme first and marks the one in use', () => {
      const themes = make();
      const a = proposed(themes);
      themes.keep(a.id);
      const b = proposed(themes, { name: 'Second', accent: '#22c55e' });
      themes.keep(b.id);
      themes.setActive(a.id);
      expect(themes.view().themes.map((theme) => [theme.name, theme.active])).toEqual([['Second', false], ['Evergreen', true]]);
    });
  });

  describe('the stored row', () => {
    it('survives a restart: the same themes, the same choice, the same revision', () => {
      const first = make();
      const { id } = proposed(first);
      first.keep(id);
      const version = first.version();
      const second = make();
      expect(second.version()).toBe(version);
      expect(second.view()).toMatchObject({ active: id, themes: [{ id, name: 'Evergreen' }] });
    });

    it('drops what is malformed instead of failing: a bad token, a bad id, a foreign schema', () => {
      const good = createUiThemes({ db: db(), now: () => new Date(clock), newId: () => 'aaaaaaaaaaaa' });
      const { id } = (() => { const result = good.propose({ name: 'Keep', mode: 'dark', accent: '#2dd4bf' }); if (!result.ok) throw new Error('x'); return result.value.proposal; })();
      good.keep(id);
      const raw = JSON.parse(JSON.stringify(getSetting(db(), UI_THEMES_SETTING_KEY)));
      const tampered = { ...raw.themes[0].tokens, bg: 'url(https://evil.example/x)' };
      raw.themes.push({ ...raw.themes[0], id: 'th_bbbbbbbbbbbb', tokens: tampered });
      raw.themes.push({ ...raw.themes[0], id: 'not-an-id' });
      raw.themes.push({ ...raw.themes[0], id: 'th_cccccccccccc', mode: 'sepia' });
      raw.active = 'th_bbbbbbbbbbbb';
      setSetting(db(), UI_THEMES_SETTING_KEY, raw);
      const reloaded = make();
      expect(reloaded.view().themes.map((theme) => theme.id)).toEqual([id]);
      expect(reloaded.view().active).toBeNull();
      expect(sanitizeUiThemeState('nonsense')).toMatchObject({ rev: 0, themes: [] });
      expect(sanitizeUiThemeState({ schema: 2, themes: [{}] })).toMatchObject({ themes: [] });
    });
  });

  describe('the page template', () => {
    const html = '<!doctype html>\n<html lang="en" data-theme="dark">\n<head>\n  <meta name="theme-color" content="#09090b">\n</head>';

    it('leaves the page alone until the owner (or a click) has made a choice on the server', () => {
      const themes = make();
      expect(renderIndexHtml(html, themes)).toBe(html);
      expect(renderIndexHtml(html, undefined)).toBe(html);
    });

    it('says the server has spoken even for the shipped dark theme, so the page does not read an old light choice over it', () => {
      const themes = make();
      themes.setActive(BUILTIN_DARK);
      const out = renderIndexHtml(html, themes);
      expect(out).toContain('<html lang="en" data-theme="dark" data-botboy-choice="builtin:dark">');
      expect(out).toContain(`content="${BUILTIN_THEME_TOKENS.dark.bg}"`);
    });

    it('opens the shipped light theme on the first byte', () => {
      const themes = make();
      themes.setActive(BUILTIN_LIGHT);
      const out = renderIndexHtml(html, themes);
      expect(out).toContain('<html lang="en" data-theme="light" data-botboy-choice="builtin:light">');
      expect(out).toContain(`content="${BUILTIN_THEME_TOKENS.light.bg}"`);
    });

    it('puts a saved theme on the <html> tag: its mode, its id, and only allowlisted tokens with valid values', () => {
      const themes = make();
      const { id } = proposed(themes, { mode: 'light', accent: '#0d9488' });
      themes.keep(id);
      const out = renderIndexHtml(html, themes);
      const tag = out.match(/<html [^>]*>/)![0];
      expect(tag).toContain('data-theme="light"');
      expect(tag).toContain(`data-botboy-choice="${id}"`);
      const style = tag.match(/style="([^"]*)"/)![1];
      const pairs = style.split(';');
      expect(pairs).toHaveLength(27);
      expect(style).not.toMatch(/[<>'{}\\]/);
      const tokens = themes.view().activeTokens!;
      expect(out).toContain(`<meta name="theme-color" content="${tokens.bg}">`);
      expect(verifyTheme(tokens).every((check) => check.ok)).toBe(true);
    });

    it('leaves the page alone when its <html> tag is not the one it knows', () => {
      const themes = make();
      themes.setActive(BUILTIN_LIGHT);
      const odd = '<html lang="en">';
      expect(renderIndexHtml(odd, themes)).toBe(odd);
    });

    it('never fails the page if the themes cannot answer', () => {
      expect(renderIndexHtml(html, { htmlAttributes: () => { throw new Error('boom'); } })).toBe(html);
    });
  });
});
