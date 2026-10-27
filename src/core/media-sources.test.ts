import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rasterDimensions, resolveBotboyImage, sniffImageType, type MediaSourceDeps } from './media-sources.js';

/** A real 3×2 PNG. */
function png(width = 3, height = 2): Buffer {
  const header = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([header, ihdr, Buffer.from('0000000049454e44ae426082', 'hex')]);
}

let tmp: string;
let deps: MediaSourceDeps;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-sources-'));
  const home = path.join(tmp, 'home');
  const privateRoot = path.join(home, '.personal-productivity-tracker');
  deps = { homeDir: home, filesDir: path.join(privateRoot, 'files'), attachmentsDir: path.join(privateRoot, 'chat-attachments') };
  fs.mkdirSync(path.join(deps.filesDir, 'shots'), { recursive: true });
  fs.mkdirSync(deps.attachmentsDir, { recursive: true });
  fs.writeFileSync(path.join(deps.filesDir, 'shots', 'pie chart.png'), png());
  fs.writeFileSync(path.join(deps.filesDir, 'shape.svg'), '<?xml version="1.0"?>\n<!-- drawn -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>');
  fs.writeFileSync(path.join(deps.filesDir, 'notes.txt'), 'plain words');
  fs.writeFileSync(path.join(deps.attachmentsDir, 'att_0123456789ab.png'), png());
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('what a picture’s bytes are', () => {
  it('reads the type from the bytes, never the name, and the size from the header', () => {
    expect(sniffImageType(png())).toBe('png');
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImageType(Buffer.from('GIF89a......', 'latin1'))).toBe('gif');
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('webp');
    expect(sniffImageType(Buffer.from('\uFEFF  <svg viewBox="0 0 1 1"/>'))).toBe('svg');
    expect(sniffImageType(Buffer.from('{"svg": "<svg>"}'))).toBeNull();
    expect(rasterDimensions(png(640, 480), 'png')).toEqual({ width: 640, height: 480 });
    const gif = Buffer.from('GIF89a', 'latin1');
    expect(rasterDimensions(Buffer.concat([gif, Buffer.from([0x20, 0x00, 0x10, 0x00])]), 'gif')).toEqual({ width: 32, height: 16 });
  });
});

describe('the pictures BotBoy holds', () => {
  it('finds a files-workspace file by every name a document uses for it', () => {
    const forms = [
      '/api/files/shots/pie%20chart.png',
      '<shots/pie chart.png>',
      'shots/pie%20chart.png',
      `${deps.filesDir}/shots/pie chart.png`,
      `file://${deps.filesDir}/shots/pie%20chart.png`,
    ];
    for (const source of forms) {
      const resolved = resolveBotboyImage(source, deps);
      expect(resolved, source).toMatchObject({ ok: true, source: 'files', type: 'png', displayUrl: '/api/files/shots/pie%20chart.png', name: 'pie chart.png' });
    }
    const tilde = resolveBotboyImage('~/.personal-productivity-tracker/files/shape.svg', deps);
    expect(tilde).toMatchObject({ ok: true, type: 'svg', displayUrl: '/api/files/shape.svg' });
  });

  it('finds a chat attachment by its id, route or file path', () => {
    for (const source of ['att_0123456789ab', '/api/chat/attachments/att_0123456789ab', path.join(deps.attachmentsDir, 'att_0123456789ab.png')]) {
      expect(resolveBotboyImage(source, deps), source).toMatchObject({ ok: true, source: 'chat_attachment', displayUrl: '/api/chat/attachments/att_0123456789ab' });
    }
    expect(resolveBotboyImage('att_ffffffffffff', deps)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('finds a chat image or screenshot by its va_ id through the registry', () => {
    const file = path.join(tmp, 'blob.png');
    fs.writeFileSync(file, png());
    const asset = `va_${'a'.repeat(32)}`;
    const version = `vav_${'b'.repeat(32)}`;
    const visualAssets = {
      resolveOriginalPath(assetId: string, versionId?: string) {
        if (assetId !== asset) throw new Error('unknown');
        return { record: { mime: 'image/png', ownerKind: 'browser_screenshot', versionId: versionId ?? version } as any, path: file };
      },
    };
    expect(resolveBotboyImage(asset, { ...deps, visualAssets })).toMatchObject({ ok: true, source: 'visual_asset', displayUrl: `/api/visual-assets/${asset}/original`, name: expect.stringMatching(/^screenshot-/) });
    expect(resolveBotboyImage(`/api/visual-assets/${asset}/original?versionId=${version}`, { ...deps, visualAssets })).toMatchObject({ ok: true, displayUrl: `/api/visual-assets/${asset}/original?versionId=${version}` });
    expect(resolveBotboyImage(`va_${'c'.repeat(32)}`, { ...deps, visualAssets })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('says what is not BotBoy’s, what is gone, and what is not a picture', () => {
    expect(resolveBotboyImage('https://example.com/a.png', deps)).toMatchObject({ ok: false, code: 'external' });
    expect(resolveBotboyImage('data:image/png;base64,AAAA', deps)).toMatchObject({ ok: false, code: 'invalid_source' });
    const outside = path.join(tmp, 'elsewhere.png');
    fs.writeFileSync(outside, png());
    expect(resolveBotboyImage(outside, deps)).toMatchObject({ ok: false, code: 'outside_botboy', path: fs.realpathSync(outside) });
    expect(resolveBotboyImage('/api/files/missing.png', deps)).toMatchObject({ ok: false, code: 'not_found' });
    expect(resolveBotboyImage('notes.txt', deps)).toMatchObject({ ok: false, code: 'not_an_image' });
    expect(resolveBotboyImage('shots', deps)).toMatchObject({ ok: false, code: 'not_an_image' });
    expect(resolveBotboyImage('../secret.png', deps)).toMatchObject({ ok: false, code: 'invalid_source' });
    expect(resolveBotboyImage('/api/files/shots/..%2F..%2Fsecret.png', deps)).toMatchObject({ ok: false, code: 'invalid_source' });
  });

  it('judges the real path, so a link in the workspace cannot reach out of it', () => {
    const outside = path.join(tmp, 'private.png');
    fs.writeFileSync(outside, png());
    fs.symlinkSync(outside, path.join(deps.filesDir, 'link.png'));
    expect(resolveBotboyImage('/api/files/link.png', deps)).toMatchObject({ ok: false, code: 'outside_botboy' });
  });

  it('refuses a picture over 25 MB', () => {
    const big = path.join(deps.filesDir, 'big.png');
    const fd = fs.openSync(big, 'w');
    fs.writeSync(fd, png());
    fs.ftruncateSync(fd, 26 * 1024 * 1024);
    fs.closeSync(fd);
    expect(resolveBotboyImage('big.png', deps)).toMatchObject({ ok: false, code: 'too_large' });
  });
});
