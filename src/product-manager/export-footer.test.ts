import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, getSetting, setSetting, type StorageLayer } from '../core/storage.js';
import {
  createExportFooterSettings,
  EXPORT_FOOTER_MIGRATION_KEY,
  EXPORT_FOOTER_SETTING_KEY,
  ExportFooterError,
  normalizeExportFooterText,
} from './export-footer.js';
import { buildDocxFooterXml, buildExportStyle } from './document-exporter.js';

/** Document export footer (design §10, §16 items 7–8). */
describe('export footer settings', () => {
  let storage: StorageLayer;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
  });
  afterEach(() => {
    storage.close();
    vi.restoreAllMocks();
  });
  const db = () => storage.getDb();
  const addCapture = () => db().prepare(
    "INSERT INTO work_items (id, source, type, title, captured_at) VALUES ('wi_1', 'browser', 'web_page', 'x', datetime('now'))",
  ).run();

  it('effective() never reads the toggle', () => {
    const amazonEmployee = vi.fn(() => true);
    const footer = createExportFooterSettings({ db: db(), amazonEmployee });
    expect(footer.effective()).toBe('');
    setSetting(db(), EXPORT_FOOTER_SETTING_KEY, { schema: 1, text: 'Team only', setBy: 'settings', updatedAt: 'x' });
    expect(footer.effective()).toBe('Team only');
    setSetting(db(), EXPORT_FOOTER_SETTING_KEY, { schema: 1, text: '', setBy: 'chat', updatedAt: 'x' });
    expect(footer.effective()).toBe('');
    expect(amazonEmployee).not.toHaveBeenCalled();
  });

  it('keeps "Amazon Confidential" once for an existing ON install', () => {
    addCapture();
    let amazon = true;
    const footer = createExportFooterSettings({ db: db(), amazonEmployee: () => amazon });
    footer.seedLegacyFooterOnce();
    expect(getSetting<any>(db(), EXPORT_FOOTER_MIGRATION_KEY).decision).toBe('kept_amazon_confidential');
    expect(footer.status()).toMatchObject({ text: 'Amazon Confidential', source: 'kept', setBy: 'migration' });
    for (const value of [false, true, false]) {
      amazon = value;
      footer.seedLegacyFooterOnce();
      expect(footer.effective()).toBe('Amazon Confidential');
    }
  });

  it('leaves fresh installs and OFF installs blank, and never overwrites a stored footer', () => {
    const fresh = createExportFooterSettings({ db: db(), amazonEmployee: () => true });
    fresh.seedLegacyFooterOnce();
    expect(getSetting<any>(db(), EXPORT_FOOTER_MIGRATION_KEY).decision).toBe('blank');
    expect(fresh.status()).toEqual({ text: '', source: 'default' });
    addCapture();
    fresh.seedLegacyFooterOnce();
    expect(fresh.effective()).toBe('');

    storage.close();
    storage = createStorage(':memory:');
    storage.initialize();
    addCapture();
    const off = createExportFooterSettings({ db: db(), amazonEmployee: () => false });
    off.seedLegacyFooterOnce();
    expect(getSetting<any>(db(), EXPORT_FOOTER_MIGRATION_KEY).decision).toBe('blank');

    storage.close();
    storage = createStorage(':memory:');
    storage.initialize();
    addCapture();
    setSetting(db(), EXPORT_FOOTER_SETTING_KEY, { schema: 1, text: 'Mine', setBy: 'settings', updatedAt: 'x' });
    const set = createExportFooterSettings({ db: db(), amazonEmployee: () => true });
    set.seedLegacyFooterOnce();
    expect(getSetting<any>(db(), EXPORT_FOOTER_MIGRATION_KEY).decision).toBe('already_set');
    expect(set.effective()).toBe('Mine');
  });

  it('a DB error writes no marker and logs one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const footer = createExportFooterSettings({ db: db(), amazonEmployee: () => { throw new RangeError('db'); } });
    footer.seedLegacyFooterOnce();
    expect(getSetting(db(), EXPORT_FOOTER_MIGRATION_KEY)).toBeNull();
    expect(warn).toHaveBeenCalledWith('[ExportFooter] seed skipped (RangeError)');
  });

  it('set() normalizes and refuses the migration origin', () => {
    const footer = createExportFooterSettings({ db: db(), amazonEmployee: () => true });
    expect(footer.set('  Internal  ', 'settings')).toMatchObject({ text: 'Internal', source: 'owner', setBy: 'settings' });
    expect(() => footer.set('x', 'migration' as any)).toThrow(ExportFooterError);
  });

  it('normalizes per §10.2', () => {
    expect(normalizeExportFooterText('  Cafe\u0301 ')).toBe('Café');
    expect(normalizeExportFooterText('')).toBe('');
    expect(normalizeExportFooterText('😀'.repeat(120))).toHaveLength(240);
    for (const bad of [42, null, 'x'.repeat(121), 'a\nb', 'tab\tx', 'del\u007f', 'line\u2028sep']) {
      expect(() => normalizeExportFooterText(bad)).toThrow(ExportFooterError);
    }
  });
});

describe('exporter footer rendering', () => {
  it('omits the center print footer when blank and escapes owner text in CSS', () => {
    expect(buildExportStyle('Oct 1, 2026', '')).not.toContain('@bottom-center');
    const style = buildExportStyle('Oct 1, 2026', 'a"b</style><x>&\\');
    const line = style.split('\n').find(text => text.includes('@bottom-center'))!;
    const content = line.slice(line.indexOf('content: ') + 9, line.indexOf('; font:'));
    expect(content.startsWith('"') && content.endsWith('"')).toBe(true);
    expect(content.slice(1, -1)).not.toMatch(/["<>&]/);
    expect(content).toContain('\\3C ');
    expect(style).not.toContain('</style>');
  });

  it('escapes Word footer text and keeps the layout when blank', () => {
    const xml = buildDocxFooterXml('Oct 1, 2026', 'R&D <draft>');
    expect(xml).toContain('R&amp;D &lt;draft&gt;');
    const blank = buildDocxFooterXml('Oct 1, 2026', '');
    expect(blank.match(/<w:tab \/>/g)).toHaveLength(2);
    expect(blank).toContain('PAGE');
    expect(blank).toContain('NUMPAGES');
    expect(blank).not.toContain('Amazon Confidential');
  });
});
