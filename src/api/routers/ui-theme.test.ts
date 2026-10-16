import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, type StorageLayer } from '../../core/storage.js';
import { createUiThemes, type UiThemes } from '../../core/ui-theme.js';
import { createDashboardRouter, createDashboardState } from './dashboard.js';
import { createUiThemeRouter } from './ui-theme.js';

/** Settings → Appearance and the chat theme card: reads are open, every change is the owner's own click (docs/maps/ui-themes.md). */
describe('ui theme routes', () => {
  let storage: StorageLayer;
  let themes: UiThemes;
  let app: express.Express;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    let n = 1;
    themes = createUiThemes({ db: storage.getDb(), newId: () => (n++).toString(16).padStart(12, '0') });
    app = express();
    app.use(express.json());
    app.use('/api', createUiThemeRouter({ nodeManager: {} as any, uiThemes: themes }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    storage.close();
    vi.restoreAllMocks();
  });

  /** A request as the rendered page makes it: same origin and fetch site. */
  const asOwner = <T extends request.Test>(req: T): T => {
    const port = new URL(req.url).port;
    return req.set('Origin', `http://127.0.0.1:${port}`).set('Sec-Fetch-Site', 'same-origin') as T;
  };
  const stage = (over: Record<string, unknown> = {}) => {
    const result = themes.propose({ name: 'Evergreen', mode: 'dark', accent: '#2dd4bf', ...over });
    if (!result.ok) throw new Error(result.message);
    return result.value.proposal.id;
  };

  it('GET /ui-theme returns the state with the shipped themes, and no CSS', async () => {
    const res = await request(app).get('/api/ui-theme');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.body).toMatchObject({ version: 0, active: null, activeTokens: null, themes: [], limits: { maxThemes: 12 } });
    expect(res.body.builtins.map((entry: any) => entry.id)).toEqual(['builtin:dark', 'builtin:light']);
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(res.body);
    expect(strings.length).toBeGreaterThan(5);
    for (const text of strings) expect(text).not.toMatch(/[<>{}]|url\(/);
  });

  it('every route is 503 when themes are not wired', async () => {
    const bare = express();
    bare.use(express.json());
    bare.use('/api', createUiThemeRouter({ nodeManager: {} as any }));
    expect((await request(bare).get('/api/ui-theme')).status).toBe(503);
    expect((await asOwner(request(bare).post('/api/ui-theme/reset'))).status).toBe(503);
    expect((await request(bare).get('/api/ui-theme/proposals/th_000000000001')).status).toBe(503);
  });

  describe('the card', () => {
    it('GET /ui-theme/proposals/:id returns the tokens to preview while pending, a short state afterwards, 404 when gone', async () => {
      const id = stage();
      const pending = await request(app).get(`/api/ui-theme/proposals/${id}`);
      expect(pending.status).toBe(200);
      expect(pending.body).toMatchObject({ id, status: 'pending', mode: 'dark', name: 'Evergreen' });
      expect(Object.keys(pending.body.tokens)).toHaveLength(27);
      expect(pending.body.checks.every((check: any) => check.ok)).toBe(true);
      await asOwner(request(app).post(`/api/ui-theme/proposals/${id}/keep`));
      const kept = await request(app).get(`/api/ui-theme/proposals/${id}`);
      expect(kept.body).toMatchObject({ status: 'kept', tokens: null, active: true });
      expect((await request(app).get('/api/ui-theme/proposals/th_ffffffffffff')).status).toBe(404);
      expect((await request(app).get('/api/ui-theme/proposals/not-an-id')).status).toBe(404);
    });

    it('Keep saves the theme and makes it the active one, and answers with the new state', async () => {
      const id = stage();
      const res = await asOwner(request(app).post(`/api/ui-theme/proposals/${id}/keep`));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ alreadyKept: false, theme: { id, name: 'Evergreen', active: true }, view: { active: id, version: 2 } });
      expect(res.body.view.activeTokens).toBeTruthy();
      expect(themes.view().active).toBe(id);
    });

    it('Discard marks the proposal and keeps nothing', async () => {
      const id = stage();
      const res = await asOwner(request(app).post(`/api/ui-theme/proposals/${id}/discard`));
      expect(res.body).toEqual({ status: 'discarded' });
      expect(themes.view()).toMatchObject({ active: null, themes: [] });
      const again = await asOwner(request(app).post(`/api/ui-theme/proposals/${id}/keep`));
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: 'proposal_discarded' });
      expect(again.body.nextAction).toMatch(/Ask BotBoy/);
    });
  });

  describe('Settings → Appearance', () => {
    it('applies a saved or shipped theme, renames, deletes and resets', async () => {
      const id = stage();
      await asOwner(request(app).post(`/api/ui-theme/proposals/${id}/keep`));
      const light = await asOwner(request(app).put('/api/ui-theme/active')).send({ id: 'builtin:light' });
      expect(light.body).toMatchObject({ active: 'builtin:light', activeTheme: { mode: 'light', builtin: true } });
      const back = await asOwner(request(app).put('/api/ui-theme/active')).send({ id });
      expect(back.body.active).toBe(id);
      const renamed = await asOwner(request(app).patch(`/api/ui-theme/themes/${id}`)).send({ name: 'Pine' });
      expect(renamed.body).toMatchObject({ theme: { id, name: 'Pine' }, view: { themes: [{ name: 'Pine' }] } });
      const reset = await asOwner(request(app).post('/api/ui-theme/reset'));
      expect(reset.body).toMatchObject({ active: 'builtin:dark' });
      expect(reset.body.themes).toHaveLength(1);
      const removed = await asOwner(request(app).delete(`/api/ui-theme/themes/${id}`));
      expect(removed.body).toMatchObject({ themes: [] });
    });

    it('refuses an unknown theme, a malformed body and a missing theme, each with a next action', async () => {
      const unknown = await asOwner(request(app).put('/api/ui-theme/active')).send({ id: 'th_ffffffffffff' });
      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({ code: 'theme_not_found' });
      expect(unknown.body.nextAction).toBeTruthy();
      for (const body of [{}, { id: 5 }, { id: 'builtin:dark', extra: true }, []]) {
        const res = await asOwner(request(app).put('/api/ui-theme/active')).send(body as object);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect((await asOwner(request(app).patch('/api/ui-theme/themes/th_ffffffffffff')).send({ name: 'x' })).status).toBe(404);
      expect((await asOwner(request(app).patch('/api/ui-theme/themes/th_ffffffffffff')).send({ nope: 'x' })).status).toBe(400);
      expect((await asOwner(request(app).delete('/api/ui-theme/themes/th_ffffffffffff'))).status).toBe(404);
    });
  });

  describe('who may change anything', () => {
    const changes: Array<[string, (a: express.Express, id: string) => request.Test, object | undefined]> = [
      ['keep', (a, id) => request(a).post(`/api/ui-theme/proposals/${id}/keep`), undefined],
      ['discard', (a, id) => request(a).post(`/api/ui-theme/proposals/${id}/discard`), undefined],
      ['apply', (a) => request(a).put('/api/ui-theme/active'), { id: 'builtin:light' }],
      ['rename', (a, id) => request(a).patch(`/api/ui-theme/themes/${id}`), { name: 'Hijacked' }],
      ['delete', (a, id) => request(a).delete(`/api/ui-theme/themes/${id}`), undefined],
      ['reset', (a) => request(a).post('/api/ui-theme/reset'), undefined],
    ];

    it.each(changes)('%s: a request with no Origin (a script, curl, the chat model through run_command) is refused and changes nothing', async (_label, build, body) => {
      const id = stage();
      themes.keep(id);
      const version = themes.version();
      const req = build(app, id);
      const res = await (body ? req.send(body) : req);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'owner_action_required' });
      expect(themes.version()).toBe(version);
      expect(themes.view().themes[0].name).toBe('Evergreen');
    });

    it.each(changes)('%s: another website, or a cross-site navigation, is refused', async (_label, build, body) => {
      const id = stage();
      themes.keep(id);
      const version = themes.version();
      const foreign = build(app, id).set('Origin', 'https://evil.example').set('Sec-Fetch-Site', 'same-origin');
      expect((await (body ? foreign.send(body) : foreign)).status).toBe(403);
      const req = build(app, id);
      const port = new URL(req.url).port;
      const crossSite = req.set('Origin', `http://127.0.0.1:${port}`).set('Sec-Fetch-Site', 'cross-site');
      expect((await (body ? crossSite.send(body) : crossSite)).status).toBe(403);
      expect(themes.version()).toBe(version);
    });
  });

  it('/dashboard/version carries themeVersion, and it moves when a theme changes', async () => {
    const dashboard = express();
    dashboard.use('/api', createDashboardRouter(createDashboardState(), storage.getDb(), undefined, undefined, undefined, undefined, undefined, undefined, () => ({ version: themes.version() })));
    const before = await request(dashboard).get('/api/dashboard/version');
    expect(before.body.themeVersion).toBe(0);
    stage();
    const after = await request(dashboard).get('/api/dashboard/version');
    expect(after.body.themeVersion).toBe(1);
    const bare = express();
    bare.use('/api', createDashboardRouter(createDashboardState(), storage.getDb()));
    expect((await request(bare).get('/api/dashboard/version')).body).not.toHaveProperty('themeVersion');
  });
});
