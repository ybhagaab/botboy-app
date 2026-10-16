// The page the browser gets first (docs/maps/ui-themes.md): GET / carries the owner's active theme on its first bytes, and it is
// served before the static handler, which would hand out index.html as it is on disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { BUILTIN_LIGHT, createUiThemes, indexHtmlHandler, type UiThemes } from './ui-theme.js';

describe('GET /', () => {
  let storage: StorageLayer;
  let themes: UiThemes;
  let dir: string;
  const html = '<!doctype html>\n<html lang="en" data-theme="dark">\n<head><meta name="theme-color" content="#09090b"></head><body>BotBoy</body></html>';
  const serve = (uiDir = dir) => {
    const app = express();
    app.get(['/', '/index.html'], indexHtmlHandler(uiDir, themes));
    app.use(express.static(uiDir));
    return app;
  };
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    themes = createUiThemes({ db: storage.getDb() });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-theme-index-'));
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    fs.writeFileSync(path.join(dir, 'dashboard.css'), 'body{}');
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves the page unchanged until the server has a theme to say, and never lets the browser cache it', async () => {
    const res = await request(serve()).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.text).toBe(html);
  });

  it('puts the active theme in the first bytes, at / and at /index.html', async () => {
    const proposed = themes.propose({ name: 'Paper', mode: 'light', accent: '#0d9488' });
    if (!proposed.ok) throw new Error(proposed.message);
    themes.keep(proposed.value.proposal.id);
    for (const url of ['/', '/index.html']) {
      const res = await request(serve()).get(url);
      expect(res.text, url).toContain(`<html lang="en" data-theme="light" data-botboy-choice="${proposed.value.proposal.id}" style="--bg:`);
    }
    themes.setActive(BUILTIN_LIGHT);
    expect((await request(serve()).get('/')).text).toContain('<html lang="en" data-theme="light" data-botboy-choice="builtin:light">');
  });

  it('every other file in the folder is still served as it is', async () => {
    const res = await request(serve()).get('/dashboard.css');
    expect(res.status).toBe(200);
    expect(res.text).toBe('body{}');
  });

  it('falls through to the static handler when index.html cannot be read', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-theme-index-empty-'));
    try {
      const res = await request(serve(empty)).get('/');
      expect(res.status).toBe(404);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
