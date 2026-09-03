import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer, setSetting } from './storage.js';
import {
  ANALYTICS_CONTEXT_DIR_KEY,
  listAnalyticsContext,
  loadAnalyticsContext,
  resolveAnalyticsContextDir,
  setAnalyticsContextDir,
} from './analytics-context.js';

/**
 * Analytics knowledge directory (etl-analytics A2): one dir, two producers
 * (user-dropped root files, generated presets/), one loader with provenance
 * headers and isolation semantics.
 */
describe('analytics-context', () => {
  let storage: StorageLayer;
  let tmpDir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-ctx-'));
    setSetting(storage.getDb(), ANALYTICS_CONTEXT_DIR_KEY, tmpDir);
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const db = () => storage.getDb();

  it('defaults under the BotBoy home dir and honors the configured override', () => {
    setSetting(db(), ANALYTICS_CONTEXT_DIR_KEY, '');
    expect(resolveAnalyticsContextDir(db())).toBe(
      path.join(os.homedir(), '.personal-productivity-tracker', 'analytics-context'),
    );
    const resolved = setAnalyticsContextDir(db(), tmpDir);
    expect(resolved).toBe(path.resolve(tmpDir));
    expect(fs.existsSync(path.join(tmpDir, 'presets'))).toBe(true); // pre-created for A3
  });

  it('lists an empty directory without error (and creates it)', () => {
    const { dir, files } = listAnalyticsContext(db());
    expect(dir).toBe(path.resolve(tmpDir));
    expect(files).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, 'presets'))).toBe(true);
  });

  it('lists root + presets with inferred sources, titles, and skips non-knowledge files', () => {
    fs.writeFileSync(path.join(tmpDir, 'gaid-note.md'), '# Opted-Out Devices note\n\nbody');
    fs.mkdirSync(path.join(tmpDir, 'presets'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'presets', 'fatafat.md'), '# Fatafat — ETL brief\ncontent');
    fs.writeFileSync(path.join(tmpDir, 'data.json'), '{}');          // skipped: extension
    fs.writeFileSync(path.join(tmpDir, '.hidden.md'), 'x');          // skipped: hidden
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), '{"files":[]}'); // never listed as knowledge

    const { files } = listAnalyticsContext(db());
    expect(files.map(f => f.name).sort()).toEqual(['gaid-note.md', path.join('presets', 'fatafat.md')].sort());
    const note = files.find(f => f.name === 'gaid-note.md')!;
    expect(note.source).toBe('user-dropped');
    expect(note.title).toBe('Opted-Out Devices note');
    const preset = files.find(f => f.name.endsWith('fatafat.md'))!;
    expect(preset.source).toBe('etl-derived');
    expect(preset.appliesTo).toEqual(['mcp_sql_*', 'mcp_etl_*']);
  });

  it('manifest tags override inference and carry business/keywords/derivedAt', () => {
    fs.writeFileSync(path.join(tmpDir, 'exported-preset.md'), '# Exported warehouse preset');
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({
      files: [{
        file: 'exported-preset.md',
        source: 'etl-derived',
        business: 'fatafat',
        keywords: ['fatafat', 'micro-drama'],
        appliesTo: ['mcp_etl_*'],
        derivedAt: '2026-09-02T00:00:00Z',
      }],
    }));
    const { files } = listAnalyticsContext(db());
    expect(files[0]).toMatchObject({
      source: 'etl-derived',
      business: 'fatafat',
      keywords: ['fatafat', 'micro-drama'],
      appliesTo: ['mcp_etl_*'],
      derivedAt: '2026-09-02T00:00:00Z',
    });
  });

  it('loads with the provenance header + arbitration line — user-dropped and etl-derived labels differ', () => {
    fs.writeFileSync(path.join(tmpDir, 'note.md'), 'the content body');
    fs.mkdirSync(path.join(tmpDir, 'presets'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'presets', 'ott.md'), 'preset body');

    const dropped = loadAnalyticsContext(db(), 'note.md');
    expect(dropped.ok).toBe(true);
    if (dropped.ok) {
      expect(dropped.content).toContain('[KNOWLEDGE FILE: note.md — user-supplied warehouse/schema knowledge]');
      expect(dropped.content).toContain('name the regime used');
      expect(dropped.content).toContain('the content body');
      expect(dropped.source).toBe('user-dropped');
    }
    const derived = loadAnalyticsContext(db(), 'presets/ott.md');
    expect(derived.ok).toBe(true);
    if (derived.ok) {
      expect(derived.content).toContain("generated from your team's production ETL profiles");
      expect(derived.source).toBe('etl-derived');
    }
  });

  it('rejects traversal, absolute paths, wrong extensions, and names missing files helpfully', () => {
    fs.writeFileSync(path.join(tmpDir, 'ok.md'), 'x');
    for (const bad of ['../evil.md', '/etc/passwd.md', 'a/../../b.md', '', 'x\\y.md']) {
      const result = loadAnalyticsContext(db(), bad);
      expect(result.ok).toBe(false);
    }
    const wrongExt = loadAnalyticsContext(db(), 'manifest.json');
    expect(wrongExt.ok).toBe(false);
    if (!wrongExt.ok) expect(wrongExt.error).toContain('.md and .txt');
    const missing = loadAnalyticsContext(db(), 'nope.md');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('mcp_analytics_list_context');
  });

  it('caps oversized files with a truncation marker pointing at the full file', () => {
    fs.writeFileSync(path.join(tmpDir, 'big.md'), 'A'.repeat(5000));
    const result = loadAnalyticsContext(db(), 'big.md', 1000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(result.content).toContain('[Truncated at 1000 of 5000 characters');
      expect(result.content).toContain('big.md');
    }
  });
});
