import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { createDocumentParser } from './document-parser.js';

/**
 * Large-file lane (sharepoint-docs-brain R6): streamed, early-aborting,
 * bounded extraction. Fixtures are real zips built with the system `zip`
 * binary — the same OOXML container the production path reads with `unzip`.
 */

function makeZip(dir: string, name: string, entries: Record<string, string>): string {
  const stage = path.join(dir, `stage-${name}`);
  for (const [member, content] of Object.entries(entries)) {
    const target = path.join(stage, member);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const zipPath = path.join(dir, name);
  execFileSync('zip', ['-q', '-r', '-X', zipPath, '.'], { cwd: stage });
  return zipPath;
}

function sheetXml(rows: string[], dimensionLastRow?: number): string {
  const dimension = dimensionLastRow ? `<dimension ref="A1:C${dimensionLastRow}"/>` : '';
  return `<?xml version="1.0"?><worksheet>${dimension}<sheetData>${rows.join('')}</sheetData></worksheet>`;
}

function inlineRow(index: number, values: string[]): string {
  const cells = values
    .map((value, column) => `<c r="${String.fromCharCode(65 + column)}${index}" t="str"><v>${value}</v></c>`)
    .join('');
  return `<row r="${index}">${cells}</row>`;
}

function sharedRow(index: number, sharedIndexes: number[]): string {
  const cells = sharedIndexes
    .map((si, column) => `<c r="${String.fromCharCode(65 + column)}${index}" t="s"><v>${si}</v></c>`)
    .join('');
  return `<row r="${index}">${cells}</row>`;
}

function sharedStringsXml(strings: string[]): string {
  return `<?xml version="1.0"?><sst>${strings.map(s => `<si><t>${s}</t></si>`).join('')}</sst>`;
}

function workbookXml(names: string[]): string {
  return `<?xml version="1.0"?><workbook><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
}

function slideXml(texts: string[]): string {
  return `<?xml version="1.0"?><p:sld>${texts.map(t => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:sld>`;
}

describe('DocumentParser large-file lane', () => {
  let dir: string;
  const parser = createDocumentParser();

  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-large-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('xlsx: caps rows per sheet, reports true totals from the dimension element, and labels sheets by workbook name', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => inlineRow(i + 1, [`r${i + 1}a`, `r${i + 1}b`]));
    const zip = makeZip(dir, 'big.xlsx', {
      'xl/workbook.xml': workbookXml(['Raw Data']),
      'xl/worksheets/sheet1.xml': sheetXml(rows, 48213),
    });

    const result = await parser.parseLargeAsync!(zip, { rowsPerSheet: 200 });
    const sheets = result.truncation.sheets as Array<{ name: string; rowsKept: number; rowsTotal: number | null }>;
    expect(sheets).toHaveLength(1);
    expect(sheets[0]).toEqual({ name: 'Raw Data', rowsKept: 200, rowsTotal: 48213 });
    expect(result.text).toContain("--- Raw Data ---");
    expect(result.text).toContain('r1a');
    expect(result.text).toContain('r200a');
    expect(result.text).not.toContain('r201a'); // early abort really cut it
    expect(result.text).toContain("48,013 more rows in 'Raw Data'");
  });

  it('xlsx: resolves shared strings within budget and reports a budget hit with blank fallbacks beyond it', async () => {
    // Two shared strings; budget sized so only the first survives the cut.
    const strings = ['alpha-string', 'omega-string-that-lands-past-the-budget'];
    const zip = makeZip(dir, 'shared.xlsx', {
      'xl/sharedStrings.xml': sharedStringsXml(strings),
      'xl/worksheets/sheet1.xml': sheetXml([sharedRow(1, [0, 1])], 1),
    });

    const full = await parser.parseLargeAsync!(zip, { rowsPerSheet: 10 });
    expect(full.truncation.sharedStringsBudgetHit).toBe(false);
    expect(full.text).toContain('alpha-string');
    expect(full.text).toContain('omega-string');

    const budgeted = await parser.parseLargeAsync!(zip, { rowsPerSheet: 10, sharedStringsBudgetBytes: 60 });
    expect(budgeted.truncation.sharedStringsBudgetHit).toBe(true);
    expect(budgeted.text).toContain('alpha-string');
    expect(budgeted.text).not.toContain('omega-string');
    expect(budgeted.text).toContain('string table exceeded');
  });

  it('pptx: extracts every slide and notes, caps pathological slide text, never reads media', async () => {
    const bigText = 'x'.repeat(5000);
    const zip = makeZip(dir, 'deck.pptx', {
      'ppt/slides/slide1.xml': slideXml(['Roadmap kickoff', 'Q3 targets']),
      'ppt/slides/slide2.xml': slideXml([bigText]),
      'ppt/notesSlides/notesSlide1.xml': slideXml(['Speaker note one']),
      'ppt/media/image1.bin': 'Z'.repeat(200_000), // media must never appear in output
    });

    const result = await parser.parseLargeAsync!(zip, { slideCharCap: 4096 });
    const slides = result.truncation.slides as { kept: number; total: number; charCapped: number };
    expect(slides).toEqual({ kept: 2, total: 2, charCapped: 1 });
    expect(result.text).toContain('--- Slide 1 ---');
    expect(result.text).toContain('Roadmap kickoff');
    expect(result.text).toContain('[Notes] Speaker note one');
    expect(result.text).toContain('[slide text truncated]');
    expect(result.text).not.toContain('ZZZZ');
  });

  it('rejects formats outside the lane and missing files', async () => {
    await expect(parser.parseLargeAsync!(path.join(dir, 'absent.xlsx'))).rejects.toThrow(/not found/i);
    const txt = path.join(dir, 'note.docx');
    writeFileSync(txt, 'hi');
    await expect(parser.parseLargeAsync!(txt)).rejects.toThrow(/Unsupported format for the large-file lane/);
  });

  it('xlsx: engine-facing shape matches the drain contract (text + truncation record)', async () => {
    const zip = makeZip(dir, 'contract.xlsx', {
      'xl/worksheets/sheet1.xml': sheetXml([inlineRow(1, ['h1', 'h2']), inlineRow(2, ['v1', 'v2'])], 2),
    });
    const result = await parser.parseLargeAsync!(zip);
    expect(typeof result.text).toBe('string');
    expect(result.text.length).toBeGreaterThan(0);
    expect(typeof result.truncation).toBe('object');
    // Round-trips through JSON for item metadata.
    expect(() => JSON.stringify(result.truncation)).not.toThrow();
  });
});

/**
 * Sheet-scoped deep reads (xlsx-deep-reads X1): name→member resolution goes
 * through workbook.xml + rels (REORDERED parts must resolve correctly),
 * cells cover shared/inline/bool/formula-cache/date-serial, budgets produce
 * explicit truncation records.
 */
describe('parseXlsxSheet', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-sheet-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  function relsXml(pairs: Array<[string, string]>): string {
    return `<?xml version="1.0"?><Relationships>${pairs.map(([id, target]) => `<Relationship Id="${id}" Type="http://sheet" Target="${target}"/>`).join('')}</Relationships>`;
  }

  it('resolves sheet NAMES through rels even when part numbering is reversed; reads typed cells', async () => {
    // "Summary" → sheet2.xml, "Q3 Data" → sheet1.xml (deliberately crossed).
    const file = makeZip(dir, 'book.xlsx', {
      'xl/workbook.xml': workbookXml(['Summary', 'Q3 Data']),
      'xl/_rels/workbook.xml.rels': relsXml([['rId1', 'worksheets/sheet2.xml'], ['rId2', 'worksheets/sheet1.xml']]),
      'xl/sharedStrings.xml': sharedStringsXml(['Region', 'Headcount']),
      'xl/styles.xml': '<?xml version="1.0"?><styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
      // sheet2 = Summary: shared header + formula with cached value + date serial (style 1).
      'xl/worksheets/sheet2.xml': sheetXml([
        sharedRow(1, [0, 1]),
        `<row r="2"><c r="A2" t="str"><v>EU</v></c><c r="B2"><f>SUM(1,41)</f><v>42</v></c><c r="C2" s="1"><v>46983</v></c><c r="D2" t="b"><v>1</v></c></row>`,
      ], 2),
      'xl/worksheets/sheet1.xml': sheetXml([inlineRow(1, ['other sheet'])], 1),
    });
    const parser = createDocumentParser();

    // Inventory without a sheet arg.
    const inventory = await parser.parseXlsxSheet!(file);
    expect(inventory.sheets.map(s => s.name)).toEqual(['Summary', 'Q3 Data']);
    expect(inventory.sheet).toBeUndefined();

    const result = await parser.parseXlsxSheet!(file, { sheet: 'summary' }); // case-insensitive
    expect(result.sheet!.name).toBe('Summary');
    expect(result.sheet!.rows[0]).toEqual(['Region', 'Headcount']);
    // Formula cached value, date serial → ISO, boolean.
    expect(result.sheet!.rows[1]).toEqual(['EU', '42', '2028-08-18', 'TRUE']); // serial 46983, cross-checked vs python datetime
    expect(result.sheet!.formulaCells).toBe(1);
    expect(result.sheet!.rowsTotal).toBe(2);

    // The crossed mapping: "Q3 Data" must hit sheet1.xml.
    const q3 = await parser.parseXlsxSheet!(file, { sheet: 'Q3 Data' });
    expect(q3.sheet!.rows[0]).toEqual(['other sheet']);

    // Unknown sheet lists what exists.
    await expect(parser.parseXlsxSheet!(file, { sheet: 'nope' })).rejects.toThrow(/workbook has: Summary, Q3 Data/);
  });

  it('row budget aborts the stream early with an explicit truncation record', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => inlineRow(i + 1, [`row ${i + 1}`, 'x']));
    const file = makeZip(dir, 'big.xlsx', {
      'xl/workbook.xml': workbookXml(['Data']),
      'xl/_rels/workbook.xml.rels': relsXml([['rId1', 'worksheets/sheet1.xml']]),
      'xl/worksheets/sheet1.xml': sheetXml(rows, 50),
    });
    const parser = createDocumentParser();
    const result = await parser.parseXlsxSheet!(file, { sheet: 'Data', maxRows: 10 });
    expect(result.sheet!.rows).toHaveLength(10);
    expect(result.sheet!.truncation.rowsCut).toBe(true);
    expect(result.sheet!.truncation.charsCut).toBe(false);
    expect(result.sheet!.rowsTotal).toBe(50);
  });
});

/**
 * Native .docx extraction (owner report 2026-08-26): textutil flattens Word
 * TABLES to one line per cell and drops headings — the doc reader showed a
 * gap-analysis grid as a paragraph stream. The native walker turns w:tbl
 * into markdown pipe tables and Heading styles into #-headings.
 */
describe('native docx extraction (tables + headings)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'ppt-docx-native-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  const P = (text: string, opts: { style?: string; num?: boolean } = {}) =>
    `<w:p><w:pPr>${opts.style ? `<w:pStyle w:val="${opts.style}"/>` : ''}${opts.num ? '<w:numPr><w:ilvl w:val="0"/></w:numPr>' : ''}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const CELL = (text: string) => `<w:tc><w:tcPr/>${P(text)}</w:tc>`;
  const ROW = (...cells: string[]) => `<w:tr>${cells.map(CELL).join('')}</w:tr>`;

  function makeDocx(name: string, bodyXml: string, numberingXml?: string): string {
    const src = path.join(dir, `${name}-src`);
    mkdirSync(path.join(src, 'word'), { recursive: true });
    writeFileSync(path.join(src, '[Content_Types].xml'), '<Types/>');
    writeFileSync(path.join(src, 'word', 'document.xml'),
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`);
    if (numberingXml) {
      writeFileSync(path.join(src, 'word', 'numbering.xml'),
        `<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${numberingXml}</w:numbering>`);
    }
    const out = path.join(dir, `${name}.docx`);
    execFileSync('zip', ['-X', '-q', '-r', out, '.'], { cwd: src });
    return out;
  }

  it('tables become pipe tables in document order; headings and lists keep structure; pipes escape', async () => {
    const file = makeDocx('gaps', [
      P('Gap analysis', { style: 'Heading2' }),
      P('The table below lists every gap.'),
      `<w:tbl><w:tblPr/>${ROW('#', 'Gap', 'Detailed')}${ROW('1', 'MX UI/UX', 'Heavy AVOD | preserved per product decision')}${ROW('2', 'Local Nudge', 'Not supported by PV now')}</w:tbl>`,
      P('After the table.'),
      P('first bullet', { num: true }),
    ].join(''));
    const parser = createDocumentParser();
    const result = await parser.parseAsync!(file);
    expect(result.success).toBe(true);
    const lines = result.text!.split('\n');
    expect(result.text).toContain('## Gap analysis');
    const headerAt = lines.findIndex(l => l === '| # | Gap | Detailed |');
    expect(headerAt).toBeGreaterThan(0);
    expect(lines[headerAt + 1]).toBe('| --- | --- | --- |');
    expect(lines[headerAt + 2]).toBe('| 1 | MX UI/UX | Heavy AVOD \\| preserved per product decision |');
    expect(lines[headerAt + 3]).toBe('| 2 | Local Nudge | Not supported by PV now |');
    // Order: intro before the table, follow-up after, bullet preserved.
    expect(result.text!.indexOf('lists every gap')).toBeLessThan(result.text!.indexOf('| # |'));
    expect(result.text!.indexOf('After the table')).toBeGreaterThan(result.text!.indexOf('| 2 |'));
    expect(result.text).toContain('- first bullet');
  });

  it('REGRESSION (owner 2026-08-26): heading-styled body text (explicit bold-off) demotes to plain text; numbered lists keep their numbers via numbering.xml', async () => {
    // The real HLD shape: authors wrote body text in Heading2 paragraphs and
    // manually un-bolded them (Word leaves <w:b w:val="0"/> on the paragraph
    // mark), and the "customer outcomes" list is numId 3 → decimal.
    const NUMBERING = '<w:abstractNum w:abstractNumId="8">'
      + '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl>'
      + '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/></w:lvl>'
      + '</w:abstractNum>'
      + '<w:abstractNum w:abstractNumId="9"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>'
      + '<w:num w:numId="3"><w:abstractNumId w:val="8"/></w:num>'
      + '<w:num w:numId="4"><w:abstractNumId w:val="9"/></w:num>';
    const HP = (text: string, opts: { boldOff?: boolean; numId?: string; ilvl?: number } = {}) =>
      `<w:p><w:pPr><w:pStyle w:val="Heading2"/>`
      + (opts.numId !== undefined ? `<w:numPr><w:ilvl w:val="${opts.ilvl ?? 0}"/><w:numId w:val="${opts.numId}"/></w:numPr>` : '')
      + (opts.boldOff ? '<w:rPr><w:b w:val="0"/><w:bCs w:val="0"/></w:rPr>' : '')
      + `</w:pPr><w:r>${opts.boldOff ? '<w:rPr><w:b w:val="0"/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
    const file = makeDocx('disguised', [
      HP('6.2 Phase 2 customer outcomes and non-goals'),                       // real heading — stays a heading
      HP('Phase 2 moves feed construction into PV Autobot.', { boldOff: true }), // disguised body — plain text
      HP('Customers continue to receive personalized feeds.', { boldOff: true, numId: '3' }),
      HP('Fatafat remains available.', { boldOff: true, numId: '3' }),
      HP('Search behavior does not change.', { boldOff: true, numId: '3' }),
      HP('sub item under three', { boldOff: true, numId: '3', ilvl: 1 }),      // nested level
      HP('a plain bullet', { boldOff: true, numId: '4' }),                     // bullet numId
    ].join(''), NUMBERING);
    const parser = createDocumentParser();
    const result = await parser.parseAsync!(file);
    expect(result.success).toBe(true);
    const text = result.text!;
    expect(text).toContain('## 6.2 Phase 2 customer outcomes and non-goals'); // real heading intact
    expect(text).toContain('\n\nPhase 2 moves feed construction into PV Autobot.'); // demoted, no ##
    expect(text).not.toContain('## Phase 2 moves feed construction');
    expect(text).toContain('1. Customers continue to receive personalized feeds.');
    expect(text).toContain('2. Fatafat remains available.');
    expect(text).toContain('3. Search behavior does not change.');
    expect(text).toContain('  1. sub item under three'); // nested ordered level, indented within renderer margin
    expect(text).toContain('- a plain bullet');
  });

  it('nested tables fall back to flattened text instead of a broken grid; single-column tables read as paragraphs', async () => {
    const inner = `<w:tbl><w:tblPr/>${ROW('inner A', 'inner B')}</w:tbl>`;
    const nested = `<w:tbl><w:tblPr/><w:tr><w:tc>${P('outer cell')}${inner}</w:tc></w:tr></w:tbl>`;
    const single = `<w:tbl><w:tblPr/><w:tr>${CELL('lonely column')}</w:tr></w:tbl>`;
    const file = makeDocx('nested', nested + single);
    const parser = createDocumentParser();
    const result = await parser.parseAsync!(file);
    expect(result.success).toBe(true);
    expect(result.text).toContain('outer cell');
    expect(result.text).toContain('inner A');
    expect(result.text).toContain('lonely column');
    expect(result.text).not.toContain('| inner A |'); // no broken grid emitted
  });
});
