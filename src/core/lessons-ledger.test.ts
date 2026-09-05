/**
 * Lessons ledger (LESSONS_LEDGER_PLAN.md): mechanical admission gates,
 * dedup-or-recurrence, owner-gated adoption rendering into the analytics
 * knowledge dir, and survival alongside the onboarding generator.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer, setSetting } from './storage.js';
import { ANALYTICS_CONTEXT_DIR_KEY, listAnalyticsContext, loadAnalyticsContext } from './analytics-context.js';
import {
  proposeLesson,
  listLessons,
  adoptLesson,
  retireLesson,
  normalizeRule,
} from './lessons-ledger.js';

describe('lessons ledger', () => {
  let storage: StorageLayer;
  let tmpDir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-'));
    setSetting(storage.getDb(), ANALYTICS_CONTEXT_DIR_KEY, tmpDir);
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const db = () => storage.getDb();
  const VALID = {
    scope: 'ott',
    rule: 'ETLM rejects LIMIT — write top-N with ROW_NUMBER() OVER (ORDER BY metric DESC) filtered to rn <= N so widgets run on either lane.',
    evidence: 'Run 12869185059 ERROR: Limit Clause is not supported on ETLM (widget "App-version conversion diagnostic", 2026-09-04).',
  };

  describe('mechanical admission gates', () => {
    it('rejects malformed scopes, unbounded rules, and missing evidence with instructive errors', () => {
      expect(proposeLesson(db(), { ...VALID, scope: 'OTT Business!!' })).toMatchObject({ ok: false });
      expect(proposeLesson(db(), { ...VALID, rule: '' })).toMatchObject({ ok: false });
      const longRule = proposeLesson(db(), { ...VALID, rule: 'x'.repeat(501) });
      expect(longRule.ok).toBe(false);
      expect((longRule as any).error).toContain('ONE bounded rule');
      const essay = proposeLesson(db(), { ...VALID, rule: 'First rule here.\n\nSecond unrelated rule.' });
      expect(essay.ok).toBe(false);
      expect((essay as any).error).toContain('ONE rule');
      const unverified = proposeLesson(db(), { ...VALID, evidence: '' });
      expect(unverified.ok).toBe(false);
      expect((unverified as any).error).toContain('VERIFIED');
    });

    it('accepts a six-criteria rule and stages it as proposed (not rendered)', () => {
      const result = proposeLesson(db(), VALID);
      expect(result.ok).toBe(true);
      expect((result as any).kind).toBe('proposed');
      expect((result as any).lesson.status).toBe('proposed');
      // Staged ≠ adopted: nothing rendered, invisible to briefings.
      expect(fs.existsSync(path.join(tmpDir, 'lessons', 'ott.md'))).toBe(false);
      expect(listAnalyticsContext(db()).files).toHaveLength(0);
    });
  });

  describe('dedup-or-recurrence', () => {
    it('an equivalent re-proposal bumps recurrence instead of duplicating', () => {
      const first = proposeLesson(db(), VALID) as any;
      const exact = proposeLesson(db(), VALID) as any;
      expect(exact.kind).toBe('recurrence');
      expect(exact.lesson.id).toBe(first.lesson.id);
      expect(exact.lesson.recurrenceCount).toBe(2);
      // Light rephrasing still dedups (token overlap, no LLM).
      const rephrased = proposeLesson(db(), {
        ...VALID,
        rule: 'ETLM rejects LIMIT: write top-N with ROW_NUMBER() OVER (ORDER BY metric DESC) filtered rn <= N so widgets run on either lane',
      }) as any;
      expect(rephrased.kind).toBe('recurrence');
      expect(rephrased.lesson.recurrenceCount).toBe(3);
      expect(listLessons(db(), { scope: 'ott' })).toHaveLength(1);
    });

    it('a genuinely different rule in the same scope inserts a new row', () => {
      proposeLesson(db(), VALID);
      const other = proposeLesson(db(), {
        scope: 'ott',
        rule: 'The playback event family must be counted whole — a single member undercounts watchtime by two thirds.',
        evidence: 'Cross-engine validation 2026-09-03: family = 3x single-event watchtime on real day.',
      }) as any;
      expect(other.kind).toBe('proposed');
      expect(listLessons(db(), { scope: 'ott' })).toHaveLength(2);
    });

    it('normalizeRule collapses case, whitespace, and punctuation variance', () => {
      expect(normalizeRule('ETLM  rejects "LIMIT"!')).toBe(normalizeRule('etlm rejects limit'));
    });
  });

  describe('adoption lifecycle and rendering', () => {
    it('adoption renders the scope file + manifest entry; briefings can list and load it', () => {
      const staged = proposeLesson(db(), VALID) as any;
      const adopted = adoptLesson(db(), staged.lesson.id);
      expect(adopted.status).toBe('adopted');

      const rendered = fs.readFileSync(path.join(tmpDir, 'lessons', 'ott.md'), 'utf8');
      expect(rendered).toContain('Lessons — ott');
      expect(rendered).toContain('ROW_NUMBER()');
      expect(rendered).toContain('Evidence: Run 12869185059');

      const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'manifest.json'), 'utf8'));
      const entry = manifest.files.find((f: any) => f.file === 'lessons/ott.md');
      expect(entry).toMatchObject({ source: 'lesson', business: 'ott' });

      // The knowledge lister and loader see it with lesson provenance.
      const { files } = listAnalyticsContext(db());
      const listed = files.find(f => f.name === 'lessons/ott.md');
      expect(listed?.source).toBe('lesson');
      const loaded = loadAnalyticsContext(db(), 'lessons/ott.md');
      expect(loaded.ok).toBe(true);
      expect((loaded as any).content).toContain('BotBoy experiential lessons');
    });

    it('retiring the last adopted lesson removes the rendered file and manifest entry', () => {
      const staged = proposeLesson(db(), VALID) as any;
      adoptLesson(db(), staged.lesson.id);
      retireLesson(db(), staged.lesson.id);
      expect(fs.existsSync(path.join(tmpDir, 'lessons', 'ott.md'))).toBe(false);
      const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'manifest.json'), 'utf8'));
      expect(manifest.files.find((f: any) => f.file === 'lessons/ott.md')).toBeUndefined();
      // Ledger keeps the row for audit.
      expect(listLessons(db(), { scope: 'ott', status: 'retired' })).toHaveLength(1);
    });

    it('rendering preserves other manifest entries (presets, user files)', () => {
      fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({
        files: [
          { file: 'presets/ott.md', business: 'ott', source: 'etl-derived' },
          { file: 'gaid-note.md', business: 'fatafat', source: 'user-dropped' },
        ],
      }));
      const staged = proposeLesson(db(), VALID) as any;
      adoptLesson(db(), staged.lesson.id);
      const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'manifest.json'), 'utf8'));
      expect(manifest.files).toHaveLength(3);
      expect(manifest.files.find((f: any) => f.file === 'presets/ott.md')).toBeDefined();
      expect(manifest.files.find((f: any) => f.file === 'gaid-note.md')).toBeDefined();
    });
  });
});
