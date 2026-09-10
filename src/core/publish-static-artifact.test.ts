import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildStaticArtifactBundle,
  staticArtifactSlug,
  writeStaticArtifactBundle,
} from './publish-static-artifact.js';

let root: string;
let destination: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-artifact-files-'));
  destination = fs.mkdtempSync(path.join(os.tmpdir(), 'static-artifact-output-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(destination, { recursive: true, force: true });
});

describe('static Harmony artifact bundle', () => {
  it('externalizes inline CSS/JS, discovers local HTML+CSS assets, and writes deterministic files', () => {
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hero.svg'), '<svg/>');
    fs.writeFileSync(path.join(root, 'assets', 'extra.css'), '.x{background:url(../pixel.png)}');
    fs.writeFileSync(path.join(root, 'pixel.png'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(root, 'prototype.html'), `<!doctype html><html><head>
      <style>body{background-image:url('hero.svg')}</style>
      <link rel="stylesheet" href="assets/extra.css">
    </head><body><img src="hero.svg"><script>document.body.dataset.ready='yes'</script></body></html>`);

    const first = buildStaticArtifactBundle({ filePath: 'prototype.html', filesRoot: root });
    const second = buildStaticArtifactBundle({ filePath: path.join(root, 'prototype.html'), filesRoot: root });

    expect(first.slug).toBe('prototype');
    expect(first.manifestSha256).toBe(second.manifestSha256);
    expect(first.transformations).toEqual({
      inlineStylesExternalized: 1,
      inlineScriptsExternalized: 1,
      localAssetsIncluded: 3,
    });
    expect(first.manifest.map(file => file.relativePath)).toEqual([
      'assets/extra.css',
      'botboy-inline-script-1.js',
      'botboy-inline-style-1.css',
      'hero.svg',
      'index.html',
      'pixel.png',
    ]);
    const html = first.files.get('index.html')!.toString('utf8');
    expect(html).toContain('href="botboy-inline-style-1.css"');
    expect(html).toContain('src="botboy-inline-script-1.js"');
    expect(html).not.toContain('<style>');
    expect(html).not.toContain("document.body.dataset.ready='yes'");

    writeStaticArtifactBundle(first, destination);
    expect(fs.readFileSync(path.join(destination, 'botboy-inline-script-1.js'), 'utf8')).toContain('dataset.ready');
    expect(fs.readFileSync(path.join(destination, 'assets', 'extra.css'), 'utf8')).toContain('../pixel.png');
  });

  it('rejects external dependencies, inline attributes, missing files, and paths outside BotBoy files', () => {
    fs.writeFileSync(path.join(root, 'external.html'), '<script src="https://example.com/x.js"></script>');
    expect(() => buildStaticArtifactBundle({ filePath: 'external.html', filesRoot: root })).toThrow(/external asset/);

    fs.writeFileSync(path.join(root, 'inline.html'), '<button onclick="go()" style="color:red">Go</button>');
    expect(() => buildStaticArtifactBundle({ filePath: 'inline.html', filesRoot: root })).toThrow(/inline style attributes/);

    fs.writeFileSync(path.join(root, 'missing.html'), '<img src="missing.png">');
    expect(() => buildStaticArtifactBundle({ filePath: 'missing.html', filesRoot: root })).toThrow(/is missing/);

    const outside = path.join(path.dirname(root), 'outside.html');
    fs.writeFileSync(outside, '<p>outside</p>');
    try {
      expect(() => buildStaticArtifactBundle({ filePath: outside, filesRoot: root })).toThrow(/must live under/);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('normalizes stable URL slugs', () => {
    expect(staticArtifactSlug('Prime Video Mock v3.3.html')).toBe('prime-video-mock-v3-3');
    expect(() => staticArtifactSlug('---.html')).toThrow(/letters or numbers/);
  });
});
