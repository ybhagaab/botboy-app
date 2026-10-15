/**
 * A Knowledge library file opened in the debug Chrome is never captured (knowledge-library.md K1; P1 review N3). The
 * page tab is filtered by path, not by URL pattern: the file URL is converted to a path and asked of the capture
 * exclusion registry, so a former root and a link into the library are covered too. A page outside the library is still
 * captured. Against the same fake DevTools endpoint the page-capture tests use; synthetic content only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerCaptureExcludedRoots } from '../core/capture-exclusions.js';
import { createBrowserMonitor, isCaptureExcludedFileUrl } from './browser-monitor.js';
import { startFakeCdp, type FakeCdp } from './browser-monitor.fake-cdp.js';

let fakeCdp: FakeCdp;
let base: string;
let root: string;
let former: string;
const LONG = 'Reference text that is plenty long to be captured when it is not excluded. '.repeat(10);

beforeAll(async () => { fakeCdp = await startFakeCdp(); });
afterAll(async () => { await fakeCdp.close(); });
beforeEach(() => {
  fakeCdp.clear();
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kl-browser-')));
  root = path.join(base, 'Docs', 'BotBoy Knowledge');
  former = path.join(base, 'Old', 'BotBoy Knowledge');
  fs.mkdirSync(path.join(root, 'shop-data'), { recursive: true });
  fs.mkdirSync(path.join(former, 'shop-data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'shop-data', 'orders.md'), '# Orders\n');
  fs.writeFileSync(path.join(former, 'shop-data', 'orders.md'), '# Orders\n');
  fs.writeFileSync(path.join(base, 'notes.md'), '# Notes\n');
  registerCaptureExcludedRoots(() => [root, former]);
});
afterEach(() => {
  registerCaptureExcludedRoots(null);
  fs.rmSync(base, { recursive: true, force: true });
});

function monitor() {
  const items: Array<{ url: string }> = [];
  const m = createBrowserMonitor({ cdpEndpoint: fakeCdp.endpoint, pollIntervalMs: 60_000, maxSettleAttempts: 1 });
  m.onWorkItem(item => items.push(item as { url: string }));
  return { m, items };
}

describe('a file tab inside the library is not polled', () => {
  it('skips a tab on a library file (spaces in the path, percent-encoded in the URL) and a former root, and still captures a tab outside', async () => {
    const inside = pathToFileURL(path.join(root, 'shop-data', 'orders.md')).href;
    const old = pathToFileURL(path.join(former, 'shop-data', 'orders.md')).href;
    const outside = pathToFileURL(path.join(base, 'notes.md')).href;
    expect(inside).toContain('BotBoy%20Knowledge');
    fakeCdp.page('inside', inside, 'orders.md', () => ({ text: LONG }));
    fakeCdp.page('old', old, 'orders.md', () => ({ text: LONG }));
    fakeCdp.page('outside', outside, 'notes.md', () => ({ text: LONG }));
    const { m, items } = monitor();
    await m.pollOnce();
    expect(items.map(item => item.url)).toEqual([outside]);
  });

  it('a web page whose address merely mentions the folder name is still captured', async () => {
    fakeCdp.page('web', 'https://docs.test/BotBoy%20Knowledge/guide', 'Guide', () => ({ text: LONG }));
    const { m, items } = monitor();
    await m.pollOnce();
    expect(items.map(item => item.url)).toEqual(['https://docs.test/BotBoy%20Knowledge/guide']);
  });

  it('with no library registered the same file tab is captured as before', async () => {
    registerCaptureExcludedRoots(null);
    const inside = pathToFileURL(path.join(root, 'shop-data', 'orders.md')).href;
    fakeCdp.page('inside', inside, 'orders.md', () => ({ text: LONG }));
    const { m, items } = monitor();
    await m.pollOnce();
    expect(items).toHaveLength(1);
  });
});

describe('isCaptureExcludedFileUrl', () => {
  it('judges file URLs by path and leaves everything else alone', () => {
    expect(isCaptureExcludedFileUrl(pathToFileURL(path.join(root, 'shop-data', 'orders.md')).href)).toBe(true);
    expect(isCaptureExcludedFileUrl(pathToFileURL(root).href)).toBe(true);
    expect(isCaptureExcludedFileUrl(pathToFileURL(path.join(base, 'notes.md')).href)).toBe(false);
    expect(isCaptureExcludedFileUrl('https://example.test/')).toBe(false);
    expect(isCaptureExcludedFileUrl('file://remote-host/share/file.md')).toBe(false);
    expect(isCaptureExcludedFileUrl('')).toBe(false);
  });

  it('follows a link that points into the library', () => {
    const link = path.join(base, 'link.md');
    fs.symlinkSync(path.join(root, 'shop-data', 'orders.md'), link);
    expect(isCaptureExcludedFileUrl(pathToFileURL(link).href)).toBe(true);
  });
});
