import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentParser } from '../core/document-parser.js';
import { createContextResolver } from './context-resolver.js';
import { createGlossaryResolver } from './glossary-resolver.js';
import { createProfileRegistry } from './profile-registry.js';
import { createWritingConfigStore } from './writing-config.js';

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-writing-home-'));
  cleanup.push(home);
  return home;
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  return db;
}

const parser: DocumentParser = {
  parse(filePath) {
    return { success: true, text: fs.readFileSync(filePath, 'utf8'), filePath, fileType: path.extname(filePath) };
  },
  getSupportedFormats: () => ['.md', '.txt', '.json'],
};

describe('product-manager profile, context, and glossary foundation', () => {
  it('loads all versioned profiles, overlays, and exact rubric totals', () => {
    const registry = createProfileRegistry();
    expect(registry.listProfiles()).toHaveLength(9);
    expect(registry.listOverlays().map((entry) => entry.overlayId)).toEqual([
      'amazon_writing.v1',
      'asd_ste100_issue9.v1',
      'tenets.v1',
    ]);
    expect(registry.getProfile('communication/email.v1').family).toBe('communication');
    expect(registry.getRubric('prd.v1').weight_total).toBe(100);
    expect(registry.buildWritingInstructions('op_roadmap_vision.v1', 'enforced_full')).toContain('Never use SHALL, SHOULD, or modal MAY');
  });

  it('persists canonical context config and resolves overview before product and glossary files', async () => {
    const home = makeHome();
    const overview = path.join(home, 'overview.md');
    const productDir = path.join(home, 'product');
    const glossary = path.join(home, 'glossary.json');
    fs.mkdirSync(productDir);
    fs.writeFileSync(overview, '# Overview\nNova Player is the customer surface.');
    fs.writeFileSync(path.join(productDir, 'b.md'), 'Beta Capability supports Nova Player.');
    fs.writeFileSync(path.join(productDir, 'a.md'), 'Alpha Capability supports Nova Player.');
    fs.writeFileSync(glossary, JSON.stringify({ schema_version: 'product-glossary.v1', terms: [] }));

    const db = makeDb();
    const store = createWritingConfigStore(db, { homeDir: home });
    const saved = store.set({
      overviewFile: overview,
      productDocDirectories: [{ path: productDir }],
      glossaryFiles: [glossary],
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.config.overviewFile).toBe(fs.realpathSync(overview));

    const resolution = await createContextResolver(parser, { homeDir: home }).resolve(store.get());
    expect(resolution.status).toBe('ready');
    expect(resolution.documents.map((document) => document.role)).toEqual(['overview', 'product', 'product', 'glossary']);
    expect(resolution.documents.map((document) => path.basename(document.path))).toEqual([
      'overview.md',
      'a.md',
      'b.md',
      'glossary.json',
    ]);
    expect(resolution.manifest.every((entry) => entry.sha256?.length === 64)).toBe(true);
    db.close();
  });

  it('keeps explicit approval above context and prompt candidates without leaking terms between requests', async () => {
    const home = makeHome();
    const glossaryPath = path.join(home, 'glossary.json');
    fs.writeFileSync(glossaryPath, JSON.stringify({
      schema_version: 'product-glossary.v1',
      terms: [{
        term: 'Pulse Engine',
        term_type: 'technical_noun',
        approved_definition: 'The request-routing component.',
        approved_forms: ['Pulse Engine'],
        part_of_speech: 'noun',
        subject_field: 'routing',
        allowed_contexts: ['product documents'],
        prohibited_synonyms: [],
        owner: 'Product owner',
        approval_state: 'approved',
        version: '1.0.0',
        review_date: '2026-08-08',
      }],
    }));
    const context = await createContextResolver(parser, { homeDir: home }).resolve({
      schemaVersion: 'writing-context.v1',
      productDocDirectories: [],
      technicalDocDirectories: [],
      domainDocDirectories: [],
      glossaryFiles: [glossaryPath],
      limits: { maxFiles: 10, maxFileBytes: 100_000, maxTotalCharacters: 100_000 },
    });
    const resolver = createGlossaryResolver();
    const first = resolver.resolve({ prompt: 'Nova Player uses Pulse Engine.', context });
    expect(first.entries.find((entry) => entry.term === 'Pulse Engine')?.approvalState).toBe('approved');
    expect(first.candidateTerms.some((entry) => entry.term === 'Nova Player')).toBe(true);

    const second = resolver.resolve({
      prompt: 'Orion Console is a separate product.',
      context: { status: 'prompt_only', overviewAvailable: false, documents: [], manifest: [], diagnostics: [], totalCharacters: 0 },
    });
    expect(second.entries.some((entry) => entry.normalizedTerm === 'pulse engine')).toBe(false);
  });
});
