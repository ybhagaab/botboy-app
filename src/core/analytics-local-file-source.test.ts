import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStorage, type StorageLayer } from './storage.js';
import { createAnalyticsDataRoomStore } from './analytics-data-room-store.js';
import { createAnalyticsDataRoomBackupService } from './analytics-data-room-backup.js';
import { createAnalyticsDataRoomService } from './analytics-data-room-service.js';
import { createAnalyticsDerivationService } from './analytics-data-room-derivation.js';
import { createAnalyticsLocalQueryEngine } from './analytics-data-room-query.js';
import { createAnalyticsJobStore } from './analytics-job-store.js';
import { createAnalyticsJobService, derivePreparationSemanticIdentities } from './analytics-job-service.js';
import type { AnalyticsJobPlanner } from './analytics-job-planner.js';
import type { AnalyticsDatasetPreparationPlanV1 } from './analytics-job-types.js';
import { createDocumentParser } from './document-parser.js';
import type { QueryRunner } from './etl-adhoc.js';
import { AnalyticsSqlExportError, type AnalyticsPreparationSqlRunner } from './analytics-sql-export.js';
import {
  AnalyticsLocalFileError,
  defaultAnalyticsLocalFilePolicy,
  readAnalyticsLocalFile,
  readAnalyticsLocalTable,
  resolveAnalyticsLocalFile,
  typeAnalyticsLocalTable,
  type AnalyticsLocalFilePolicy,
} from './analytics-local-file-source.js';

const storages: StorageLayer[] = [];
const directories: string[] = [];

afterEach(() => {
  while (storages.length) {
    try { storages.pop()?.close(); } catch {}
  }
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true });
});

function tempDir(prefix = 'local-file-'): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(value);
  return value;
}

function policyFor(home: string): AnalyticsLocalFilePolicy {
  return { ...defaultAnalyticsLocalFilePolicy(home), tempRoot: tempDir('local-file-tmp-') };
}

function write(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function xmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Minimal SpreadsheetML workbook; `s:1` cells use built-in date format 14. */
function workbook(
  root: string,
  name: string,
  sheets: Record<string, Array<Array<{ v: string | number; t?: 'str'; s?: 1 } | null>>>,
  extensions: { workbook?: string; sheet?: string; sheetData?: string } = {},
): string {
  const stage = path.join(root, `${name}-stage`);
  const names = Object.keys(sheets);
  const column = (index: number) => String.fromCharCode(65 + index);
  const entries: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships/>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook><sheets>${names.map((sheet, index) => `<sheet name="${xmlText(sheet)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>${extensions.workbook ?? ''}</workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships>${names.map((_sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`,
    'xl/styles.xml': '<?xml version="1.0"?><styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
  };
  names.forEach((sheet, sheetIndex) => {
    const rows = sheets[sheet].map((cells, rowIndex) => {
      const row = rowIndex + 1;
      const body = cells.map((cell, cellIndex) => {
        if (!cell) return '';
        const reference = `${column(cellIndex)}${row}`;
        return cell.t === 'str'
          ? `<c r="${reference}" t="str"><v>${xmlText(String(cell.v))}</v></c>`
          : `<c r="${reference}"${cell.s ? ` s="${cell.s}"` : ''}><v>${cell.v}</v></c>`;
      }).join('');
      return body ? `<row r="${row}">${body}</row>` : '';
    }).join('');
    entries[`xl/worksheets/sheet${sheetIndex + 1}.xml`] = `<?xml version="1.0"?><worksheet><sheetData>${rows}${extensions.sheetData ?? ''}</sheetData>${extensions.sheet ?? ''}</worksheet>`;
  });
  for (const [member, content] of Object.entries(entries)) write(path.join(stage, member), content);
  const file = path.join(root, name);
  execFileSync('zip', ['-q', '-r', '-X', file, '.'], { cwd: stage });
  return file;
}

const text = (v: string) => ({ v, t: 'str' as const });
const num = (v: number) => ({ v });
// Excel 1900 serials: 46266 = 2026-09-01.
const day = (offset: number) => ({ v: 46266 + offset, s: 1 as const });

function issuesOf(run: () => unknown): Array<{ code: string; path: string; message: string }> {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AnalyticsLocalFileError);
    return (error as AnalyticsLocalFileError).issues;
  }
  throw new Error('expected an AnalyticsLocalFileError');
}

describe('local-file source boundary and strict table reader', () => {
  it('reads owner files and BotBoy artifact folders but never BotBoy private state', () => {
    const home = tempDir('local-file-home-');
    const policy = policyFor(home);
    const owner = write(path.join(home, 'Downloads', 'owner.csv'), 'a\n1\n');
    const etl = write(path.join(policy.privateRoot, 'etl-results', 'run_1.tsv'), 'a\n1\n');
    const written = write(path.join(policy.filesDir, 'nested', 'made.csv'), 'a\n1\n');
    const secret = write(path.join(policy.privateRoot, 'data-room', 'internal.csv'), 'a\n1\n');
    const aliasToSecret = path.join(home, 'Downloads', 'alias.csv');
    fs.symlinkSync(secret, aliasToSecret);

    expect(resolveAnalyticsLocalFile({ path: owner }, policy, 'file').format).toBe('csv');
    expect(resolveAnalyticsLocalFile({ path: '~/Downloads/owner.csv' }, policy, 'file').resolvedPath).toBe(fs.realpathSync(owner));
    expect(resolveAnalyticsLocalFile({ path: etl }, policy, 'file').format).toBe('tsv');
    expect(resolveAnalyticsLocalFile({ path: 'nested/made.csv' }, policy, 'file').resolvedPath).toBe(fs.realpathSync(written));

    expect(issuesOf(() => resolveAnalyticsLocalFile({ path: secret }, policy, 'file'))[0]).toMatchObject({ code: 'private_state_denied', path: 'file.path' });
    expect(issuesOf(() => resolveAnalyticsLocalFile({ path: aliasToSecret }, policy, 'file'))[0].code).toBe('private_state_denied');
    expect(issuesOf(() => resolveAnalyticsLocalFile({ path: '../escape.csv' }, policy, 'file'))[0].code).toBe('relative_path_escape');
    expect(issuesOf(() => resolveAnalyticsLocalFile({ path: path.join(home, 'missing.csv') }, policy, 'file'))[0].code).toBe('file_not_found');
    expect(issuesOf(() => resolveAnalyticsLocalFile({ path: write(path.join(home, 'old.xls'), 'x') }, policy, 'file'))[0].code).toBe('unsupported_file_format');
  });

  it('denies private state reached through a different letter case (case-insensitive macOS volumes)', () => {
    const home = tempDir('local-file-home-');
    const policy = policyFor(home);
    const secret = write(path.join(policy.privateRoot, 'ai-model.json'), '{"apiKey":"sk-proj-casevariant0000000000"}\n');
    const variantRoot = policy.privateRoot.replace('.personal-productivity-tracker', '.PERSONAL-Productivity-Tracker');
    const variantPath = path.join(variantRoot, 'AI-MODEL.json');
    // Only meaningful where the volume folds case (the macOS default); elsewhere the path does not exist.
    if (!fs.existsSync(variantPath)) return;
    const aliasToVariant = path.join(home, 'Downloads', 'variant.csv');
    fs.mkdirSync(path.dirname(aliasToVariant), { recursive: true });
    fs.symlinkSync(variantPath, aliasToVariant);

    for (const candidate of [variantPath, aliasToVariant]) {
      expect(issuesOf(() => resolveAnalyticsLocalFile({ path: candidate, format: 'csv' }, policy, 'file'))[0].code).toBe('private_state_denied');
    }
    expect(fs.readFileSync(secret, 'utf8')).toContain('casevariant');
  });

  it('maps delimited headers by exact name, treats empty cells as null by default, and names the first bad cell per column', async () => {
    const home = tempDir('local-file-home-');
    const policy = policyFor(home);
    const file = write(path.join(home, 'metrics.csv'), 'total,date,rate\n5,2026-09-01,\n7,2026-09-02,0.5\n');
    const snapshot = readAnalyticsLocalFile(resolveAnalyticsLocalFile({ path: file }, policy, 'src'), 'src');
    const table = await readAnalyticsLocalTable(snapshot, {}, {}, 'src');
    const schema = [
      { name: 'date', logicalType: 'date' as const, nullable: false },
      { name: 'total', logicalType: 'integer' as const, nullable: false },
      { name: 'rate', logicalType: 'number' as const, nullable: true },
    ];
    expect(typeAnalyticsLocalTable(table, schema, undefined, { source: 'src', schema: 'src.target.schema' })).toEqual({
      columns: ['date', 'total', 'rate'],
      rows: [['2026-09-01', 5, null], ['2026-09-02', 7, 0.5]],
    });
    const strict = issuesOf(() => typeAnalyticsLocalTable(table, [schema[0], schema[1], { ...schema[2], nullable: false }], undefined, { source: 'src', schema: 'src.target.schema' }));
    expect(strict[0]).toMatchObject({ code: 'null_in_non_nullable_field', path: 'src.target.schema[2].nullable' });
    const mismatch = issuesOf(() => typeAnalyticsLocalTable(table, [schema[0], schema[1]], undefined, { source: 'src', schema: 'src.target.schema' }));
    expect(mismatch[0].code).toBe('columns_mismatch');
    expect(mismatch[0].message).toContain('["total", "date", "rate"]');

    const tsv = write(path.join(home, 'run.tsv'), 'date\ttotal\n2026-09-01\t\\N\n2026-09-02\tN/A\n');
    const tsvTable = await readAnalyticsLocalTable(readAnalyticsLocalFile(resolveAnalyticsLocalFile({ path: tsv }, policy, 'src'), 'src'), { nullToken: '\\N' }, {}, 'src');
    const typeIssue = issuesOf(() => typeAnalyticsLocalTable(tsvTable, [schema[0], { ...schema[1], nullable: true }], '\\N', { source: 'src', schema: 'src.target.schema' }));
    expect(typeIssue[0]).toMatchObject({ code: 'cell_type_mismatch', path: 'src.target.schema[1].logicalType' });
    expect(typeIssue[0].message).toContain('row 3 column 2 holds text "N/A"');
  });

  it('reads one XLSX table below a title row with native dates, skips blank rows, and rejects cells outside the header', async () => {
    const home = tempDir('local-file-home-');
    const policy = policyFor(home);
    const parser = createDocumentParser();
    const file = workbook(home, 'report.xlsx', {
      Raw: [
        [text('Ingress report')],
        [text('date'), text('metrics_name'), text('total')],
        [day(0), text('app_open'), num(10)],
        [],
        [day(1), text('app_open'), num(12)],
      ],
      Notes: [[text('free text')]],
    });
    const snapshot = readAnalyticsLocalFile(resolveAnalyticsLocalFile({ path: file }, policy, 'src'), 'src');
    await expect(readAnalyticsLocalTable(snapshot, { headerRow: 2 }, { documentParser: parser, tempRoot: policy.tempRoot }, 'src'))
      .rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'sheet_required', path: 'src.sheet' })] });
    const table = await readAnalyticsLocalTable(snapshot, { sheet: 'Raw', headerRow: 2 }, { documentParser: parser, tempRoot: policy.tempRoot }, 'src');
    expect(table).toMatchObject({ header: ['date', 'metrics_name', 'total'], blankRowsSkipped: 0, rowsAboveHeader: 1, sheets: ['Raw', 'Notes'] });
    expect(typeAnalyticsLocalTable(table, [
      { name: 'date', logicalType: 'date', nullable: false },
      { name: 'metrics_name', logicalType: 'string', nullable: false },
      { name: 'total', logicalType: 'integer', nullable: false },
    ], undefined, { source: 'src', schema: 's' }).rows).toEqual([['2026-09-01', 'app_open', 10], ['2026-09-02', 'app_open', 12]]);
    expect(fs.readdirSync(policy.tempRoot!)).toEqual([]);

    const stray = workbook(home, 'stray.xlsx', { Raw: [[text('date')], [day(0), num(1)]] });
    await expect(readAnalyticsLocalTable(readAnalyticsLocalFile(resolveAnalyticsLocalFile({ path: stray }, policy, 'src'), 'src'), {}, { documentParser: parser, tempRoot: policy.tempRoot }, 'src'))
      .rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'cells_outside_header' })] });
  });

  it('reads modern Excel files whose optional extension lists hold namespaced elements', async () => {
    const home = tempDir('local-file-home-');
    const policy = policyFor(home);
    // Excel 2013+ writes x15:workbookPr and x14 conditional formats (xm:f / xm:sqref) inside extLst.
    const file = workbook(home, 'modern.xlsx', { Raw: [[text('date'), text('total')], [day(0), num(3)]] }, {
      workbook: '<extLst><ext uri="{140A7094-0E35-4892-8432-C4D2E57EDEB5}"><x15:workbookPr chartTrackingRefBase="1"/></ext></extLst>',
      sheet: '<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}"><x14:conditionalFormattings><x14:conditionalFormatting><x14:cfRule type="expression" id="{1}"><xm:f>$B$2&gt;1</xm:f></x14:cfRule><xm:sqref>B2:B9</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext></extLst>',
    });
    const table = await readAnalyticsLocalTable(readAnalyticsLocalFile(resolveAnalyticsLocalFile({ path: file }, policy, 'src'), 'src'), {}, { documentParser: createDocumentParser(), tempRoot: policy.tempRoot }, 'src');
    expect(table.header).toEqual(['date', 'total']);
    expect(table.rows).toHaveLength(1);

    // A namespaced shadow of real cell data outside extLst still fails closed.
    const shadow = workbook(home, 'shadow.xlsx', { Raw: [[text('date'), text('total')], [day(0), num(3)]] }, {
      sheetData: '<x:row r="3"><x:c r="A3"><x:v>46267</x:v></x:c></x:row>',
    });
    await expect(readAnalyticsLocalTable(readAnalyticsLocalFile(resolveAnalyticsLocalFile({ path: shadow }, policy, 'src'), 'src'), {}, { documentParser: createDocumentParser(), tempRoot: policy.tempRoot }, 'src'))
      .rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'xlsx_sheet_unreadable' })] });
  });

  it('reads ragged-right exports as absent trailing cells but rejects an unterminated short final record', async () => {
    const home = tempDir('local-file-home-');
    const policy = policyFor(home);
    const schema = [
      { name: 'date', logicalType: 'date' as const, nullable: false },
      { name: 'total', logicalType: 'integer' as const, nullable: false },
      { name: 'hours', logicalType: 'number' as const, nullable: true },
    ];
    const ragged = write(path.join(home, 'datanet.tsv'), 'date\ttotal\thours\n2026-09-01\t5\t1.5\n2026-09-02\t6\n');
    const table = await readAnalyticsLocalTable(readAnalyticsLocalFile(resolveAnalyticsLocalFile({ path: ragged }, policy, 'src'), 'src'), {}, {}, 'src');
    expect(table.shortRows).toBe(1);
    expect(typeAnalyticsLocalTable(table, schema, undefined, { source: 'src', schema: 's' }).rows).toEqual([['2026-09-01', 5, 1.5], ['2026-09-02', 6, null]]);
    const truncated = write(path.join(home, 'cut.tsv'), 'date\ttotal\thours\n2026-09-01\t5\t1.5\n2026-09-02\t6');
    await expect(readAnalyticsLocalTable(readAnalyticsLocalFile(resolveAnalyticsLocalFile({ path: truncated }, policy, 'src'), 'src'), {}, {}, 'src'))
      .rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'delimited_parse_failed' })] });
  });
});

describe('local-file Data Room lifecycle', () => {
  function environment(
    home: string,
    modelContextRuntime: { providerLocality: 'device_local' | 'amazon_managed_remote' | 'external_remote'; endpointSha256: string } = { providerLocality: 'amazon_managed_remote', endpointSha256: 'a'.repeat(64) },
    etlRunner?: QueryRunner,
    sqlRunner?: AnalyticsPreparationSqlRunner,
  ) {
    const storage = createStorage(':memory:');
    storage.initialize();
    storages.push(storage);
    const db = storage.getDb();
    const store = createAnalyticsDataRoomStore({ db, rootDir: tempDir('local-file-room-') });
    const room = createAnalyticsDataRoomService({ store, backups: createAnalyticsDataRoomBackupService({ db, store }) });
    const planner = { plan: async () => { throw new Error('The answer planner must not run for dataset preparation.'); } } as unknown as AnalyticsJobPlanner;
    const service = createAnalyticsJobService({
      db,
      store,
      jobStore: createAnalyticsJobStore({ db }),
      planner,
      derivation: createAnalyticsDerivationService({ db, store }),
      localQuery: createAnalyticsLocalQueryEngine({ store }),
      dataRoom: room,
      documentParser: createDocumentParser(),
      localFilePolicy: policyFor(home),
      modelContextRuntime,
      etlRunner,
      sqlRunner,
      waitMs: 20_000,
    });
    const counts = () => ({
      jobs: Number((db.prepare('SELECT COUNT(*) AS n FROM analytics_jobs').get() as { n: number }).n),
      datasets: Number((db.prepare('SELECT COUNT(*) AS n FROM analytics_datasets').get() as { n: number }).n),
      versions: Number((db.prepare('SELECT COUNT(*) AS n FROM analytics_dataset_versions').get() as { n: number }).n),
    });
    const rows = (versionId: string) => {
      const sidecar = new Database(store.getVerifiedMaterializedPath(versionId, 'local_answer'), { readonly: true });
      try {
        return sidecar.prepare('SELECT date, metrics_name, total FROM data ORDER BY date, metrics_name').all();
      } finally {
        sidecar.close();
      }
    };
    return { store, service, counts, rows };
  }

  const metric = { id: 'ingress_total', version: '1', unit: 'count', definition: 'Daily ingress total for one metric name, as reported.' };
  const regime = { id: 'report_as_delivered', version: '1', definition: 'Values exactly as delivered in the owner report file.' };
  const ids = derivePreparationSemanticIdentities(metric, regime);
  const schema = [
    { name: 'date', logicalType: 'date', nullable: false },
    { name: 'metrics_name', logicalType: 'string', nullable: false },
    { name: 'total', logicalType: 'integer', nullable: false },
  ];
  const request = (start: string, end: string, identity: { metric: unknown; regime: unknown } = ids) => ({
    domainKey: 'fixture_ingress', metric: identity.metric, dimensions: ['metrics_name'], filters: [],
    dateRange: { start, end }, timeZone: 'UTC', countingKey: 'metrics_name', regime: identity.regime,
    requiredGrain: 'day_metric', freshness: { mode: 'historical_as_of' }, use: 'local_answer',
  });
  const coverage = (start: string, end: string) => ({
    partitionKind: 'day', observedRanges: [{ start, end }], completeRanges: [{ start, end }], watermark: `${end}T23:59:59.000Z`,
  });
  const target = (start: string, end: string) => ({
    name: 'Fixture ingress', description: 'Daily ingress totals by metric from the owner report.', domainKey: 'fixture_ingress',
    schema, metric, regime, countingKey: 'metrics_name', grain: 'day_metric', availableDimensions: ['metrics_name'],
    timeField: 'date', timeZone: 'UTC', coverage: coverage(start, end),
    answer: {
      version: 1, metricId: 'ingress_total', metricValueColumn: 'total', rowDimensions: ['metrics_name'],
      filterableFields: ['date', 'metrics_name'],
      stableOrder: [{ field: 'date', direction: 'asc' }, { field: 'metrics_name', direction: 'asc' }],
    },
  });
  const owner = (requestId: string) => ({ ownerId: 'owner', requestId: `owner-request-${requestId}`, message: 'Import this file into the Data Room.' });
  const plan = (source: Record<string, unknown>, planRequest: Record<string, unknown>) => ({
    version: 1, mode: 'dataset_preparation', request: planRequest, sources: [source], fragments: [], terminal: { kind: 'source', alias: 'report' },
  }) as unknown as AnalyticsDatasetPreparationPlanV1;

  it('imports an XLSX sheet as a new dataset, then merges and replaces later files into that same dataset', async () => {
    const home = tempDir('local-file-home-');
    const env = environment(home);
    const first = workbook(home, 'ingress.xlsx', {
      Ingress_Level_Raw: [
        [text('date'), text('metrics_name'), text('total')],
        [day(0), text('app_open'), num(10)],
        [day(1), text('app_open'), num(12)],
        [day(2), text('app_open'), num(14)],
      ],
    });

    const profile = await env.service.inspectLocalFile({ path: first });
    expect(profile).toMatchObject({ sheet: 'Ingress_Level_Raw', rowCount: 3, samplesWithheld: false });
    expect(profile.columns.map(column => [column.name, column.compatibleTypes])).toEqual([
      ['date', ['date']], ['metrics_name', ['string']], ['total', ['string', 'integer', 'number']],
    ]);
    expect(profile.columns[0].dayRanges).toEqual([{ start: '2026-09-01', end: '2026-09-03' }]);

    const created = await env.service.prepareOrJoinAndWait(owner('r1'), plan(
      { kind: 'local_file', alias: 'report', path: first, target: target('2026-09-01', '2026-09-03') },
      request('2026-09-01', '2026-09-03'),
    ));
    expect(created.status).toBe('completed');
    const datasetId = created.result!.primary.datasetId;
    const dataset = env.store.getDataset(datasetId)!;
    expect(dataset).toMatchObject({ catalogVisibility: 'catalog', sourceKind: 'import', definitionRevision: 1 });
    expect(dataset.definition.adapter).toBe('local_file');
    expect(env.rows(created.result!.primary.versionId)).toHaveLength(3);

    // Merge: 09-03 is replaced by the file, 09-04/05 are new, 09-01/02 stay.
    const second = write(path.join(home, 'Downloads', 'next.csv'), 'metrics_name,date,total\napp_open,2026-09-03,99\napp_open,2026-09-04,20\napp_open,2026-09-05,21\n');
    const existing = { metric: dataset.contract.metric, regime: dataset.contract.regime };
    const merged = await env.service.prepareOrJoinAndWait(owner('r2'), plan(
      { kind: 'local_file', alias: 'report', path: '~/Downloads/next.csv', into: { datasetId, mode: 'merge_partitions', coverage: coverage('2026-09-03', '2026-09-05') } },
      request('2026-09-01', '2026-09-05', existing),
    ));
    expect(merged.status).toBe('completed');
    const afterMerge = env.store.getDataset(datasetId)!;
    expect(afterMerge.definitionRevision).toBe(2);
    expect(afterMerge.head).toMatchObject({ definitionRevision: 2, headRevision: 2, versionId: merged.result!.primary.versionId });
    expect(env.store.getDatasetVersion(merged.result!.primary.versionId)!.contractSha256).toBe(afterMerge.contractSha256);
    expect(afterMerge.contract.coverage.observedPartitions).toEqual(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']);
    expect(env.rows(merged.result!.primary.versionId)).toEqual([
      { date: '2026-09-01', metrics_name: 'app_open', total: 10 },
      { date: '2026-09-02', metrics_name: 'app_open', total: 12 },
      { date: '2026-09-03', metrics_name: 'app_open', total: 99 },
      { date: '2026-09-04', metrics_name: 'app_open', total: 20 },
      { date: '2026-09-05', metrics_name: 'app_open', total: 21 },
    ]);
    // The first immutable version is untouched.
    expect(env.rows(created.result!.primary.versionId)).toHaveLength(3);

    const replacement = write(path.join(home, 'Downloads', 'corrected.csv'), 'date,metrics_name,total\n2026-09-05,app_open,30\n');
    const replaced = await env.service.prepareOrJoinAndWait(owner('r3'), plan(
      { kind: 'local_file', alias: 'report', path: replacement, into: { datasetId, mode: 'replace', coverage: coverage('2026-09-05', '2026-09-05') } },
      request('2026-09-05', '2026-09-05', existing),
    ));
    expect(replaced.status).toBe('completed');
    expect(env.rows(replaced.result!.primary.versionId)).toEqual([{ date: '2026-09-05', metrics_name: 'app_open', total: 30 }]);
    expect(env.store.getDataset(datasetId)!.head).toMatchObject({ definitionRevision: 3, headRevision: 3 });
    expect(env.counts()).toMatchObject({ datasets: 1, versions: 3 });
  });

  // REGRESSION (chat logs 2026-10-07): the schema and the prompt allowed a
  // coverage that proves no partition complete, but the service rejected
  // completeRanges: [] and the import spent its attempts on it.
  it('imports a file whose coverage proves no partition complete (completeRanges: [])', async () => {
    const home = tempDir('local-file-home-');
    const env = environment(home);
    const file = write(path.join(home, 'Downloads', 'partial.csv'), 'date,metrics_name,total\n2026-09-01,app_open,10\n2026-09-02,app_open,12\n');
    const partial = { ...target('2026-09-01', '2026-09-02'), coverage: { ...coverage('2026-09-01', '2026-09-02'), completeRanges: [] } };
    const created = await env.service.prepareOrJoinAndWait(owner('partial'), plan(
      { kind: 'local_file', alias: 'report', path: file, target: partial },
      request('2026-09-01', '2026-09-02'),
    ));
    expect(created.status).toBe('completed');
    const dataset = env.store.getDataset(created.result!.primary.datasetId)!;
    expect(dataset.contract.coverage).toMatchObject({ observedPartitions: ['2026-09-01', '2026-09-02'], completePartitions: [] });
  });

  it('rejects contract/file mismatches before any job, dataset, or version exists', async () => {
    const home = tempDir('local-file-home-');
    const env = environment(home);
    const file = write(path.join(home, 'bad.csv'), 'date,metrics_name,total\n2026-09-01,app_open,N/A\n2026-09-03,app_open,4\n');
    const attempt = (source: Record<string, unknown>, planRequest = request('2026-09-01', '2026-09-03')) =>
      env.service.prepareOrJoinAndWait(owner(`bad-${Math.random()}`), plan(source, planRequest));

    await expect(attempt({ kind: 'local_file', alias: 'report', path: file, target: target('2026-09-01', '2026-09-03') }))
      .rejects.toMatchObject({ code: 'invalid_input', issues: [expect.objectContaining({ code: 'cell_type_mismatch', path: 'plan.sources[0].target.schema[2].logicalType' })] });

    const typed = write(path.join(home, 'gap.csv'), 'date,metrics_name,total\n2026-09-01,app_open,1\n2026-09-03,app_open,4\n');
    await expect(attempt({ kind: 'local_file', alias: 'report', path: typed, target: target('2026-09-01', '2026-09-03') }))
      .rejects.toMatchObject({ code: 'invalid_input', issues: [expect.objectContaining({ code: 'observed_coverage_mismatch', path: 'plan.sources[0].target.coverage' })] });

    await expect(attempt({ kind: 'local_file', alias: 'report', path: typed, into: { datasetId: 'ds_missing', mode: 'replace', coverage: coverage('2026-09-01', '2026-09-01') } }))
      .rejects.toMatchObject({ code: 'invalid_input', issues: [expect.objectContaining({ code: 'unknown_dataset' })] });

    const secret = write(path.join(home, '.personal-productivity-tracker', 'tracker-export.csv'), 'date\n2026-09-01\n');
    await expect(attempt({ kind: 'local_file', alias: 'report', path: secret, target: target('2026-09-01', '2026-09-01') }, request('2026-09-01', '2026-09-01')))
      .rejects.toMatchObject({ code: 'policy_denied', issues: [expect.objectContaining({ code: 'private_state_denied' })] });

    expect(env.counts()).toEqual({ jobs: 0, datasets: 0, versions: 0 });
  });

  it('reports independent contract mistakes from the live Fatafat attempt in one no-effect wave', async () => {
    const home = tempDir('local-file-home-');
    const env = environment(home);
    const file = write(path.join(home, 'ingress.csv'), 'date,metrics_name,total\n2026-09-01,app_open,1\n');
    const planRequest = { ...request('2026-09-01', '2026-09-01'), countingKey: ['date', 'metrics_name'], requiredGrain: 'one row per date and metrics_name' };
    const planTarget = { ...target('2026-09-01', '2026-09-01'), countingKey: ['date', 'metrics_name'], coverage: { ...coverage('2026-09-01', '2026-09-01'), watermark: '2026-09-01' } };
    const failure = await env.service.prepareOrJoinAndWait(owner('one-wave'), plan(
      { kind: 'local_file', alias: 'report', path: file, target: planTarget },
      planRequest,
    )).catch(error => error);
    expect(failure.code).toBe('invalid_input');
    expect(failure.issues.map((issue: { code: string; path: string }) => `${issue.code}@${issue.path}`)).toEqual(expect.arrayContaining([
      'invalid_field_reference@plan.request.countingKey',
      'invalid_field_reference@plan.sources[0].target.countingKey',
      'invalid_timestamp@plan.sources[0].target.coverage.watermark',
      'terminal_grain_mismatch@plan.request.requiredGrain',
    ]));
    // The second live wave (bare-string stableOrder) is also reported before any job.
    const secondWave = await env.service.prepareOrJoinAndWait(owner('one-wave-2'), plan(
      { kind: 'local_file', alias: 'report', path: file, target: { ...target('2026-09-01', '2026-09-01'), answer: { ...target('2026-09-01', '2026-09-01').answer, stableOrder: ['date'] } } },
      request('2026-09-01', '2026-09-01'),
    )).catch(error => error);
    expect(secondWave.issues.map((issue: { code: string }) => issue.code)).toContain('invalid_stable_order');
    expect(env.counts()).toEqual({ jobs: 0, datasets: 0, versions: 0 });
  });

  it('withholds cell values from profiles and failures when the chat provider may not see rows', async () => {
    const home = tempDir('local-file-home-');
    const env = environment(home, { providerLocality: 'external_remote', endpointSha256: 'b'.repeat(64) });
    const file = write(path.join(home, 'secret-values.csv'), 'date,metrics_name,total\n2026-09-01,confidential_metric,N/A\n');
    const profile = await env.service.inspectLocalFile({ path: file });
    expect(profile.samplesWithheld).toBe(true);
    expect(profile.columns.every(column => column.samples.length === 0 && column.minimum === undefined)).toBe(true);
    expect(profile.columns.map(column => column.name)).toEqual(['date', 'metrics_name', 'total']);
    const failure = await env.service.prepareOrJoinAndWait(owner('withheld'), plan(
      { kind: 'local_file', alias: 'report', path: file, target: target('2026-09-01', '2026-09-01') },
      request('2026-09-01', '2026-09-01'),
    )).catch(error => error);
    expect(failure.issues[0].message).toContain('holds text (value withheld)');
    expect(JSON.stringify(failure.issues)).not.toContain('N/A');
  });

  const etlTarget = (start: string, end: string) => ({
    ...target(start, end),
    schema: [...schema, { name: 'hours', logicalType: 'number', nullable: true }],
  });
  /** A Datanet runner that saves one exact result where the real runner does. */
  function fakeEtl(home: string, runId: string, result: string) {
    const calls: string[] = [];
    const runner: QueryRunner = {
      id: 'etl-fixture',
      runQuery: async ({ sql, onSubmitted }) => {
        calls.push(sql);
        await onSubmitted?.(runId);
        const savedTo = write(path.join(home, '.personal-productivity-tracker', 'etl-results', `adhoc_${runId}.tsv`), result);
        const bytes = fs.readFileSync(savedTo);
        return { ok: true, runId, savedTo, resultBytes: bytes.length, resultSha256: createHash('sha256').update(bytes).digest('hex') };
      },
    };
    return { runner, calls };
  }

  it('publishes a real-shaped Datanet result (SQL column order, omitted trailing field, empty null) through etl_query', async () => {
    const home = tempDir('local-file-home-');
    const result = 'metrics_name\tdate\ttotal\thours\napp_open\t2026-09-01\t5\t1.5\napp_open\t2026-09-02\t6\napp_open\t2026-09-03\t7\t\n';
    const etl = fakeEtl(home, '4242', result);
    const env = environment(home, undefined, etl.runner);
    const created = await env.service.prepareOrJoinAndWait(owner('etl-ok'), plan(
      { kind: 'etl_query', alias: 'report', sql: 'SELECT metrics_name, date, total, hours FROM fixture', target: etlTarget('2026-09-01', '2026-09-03') },
      request('2026-09-01', '2026-09-03'),
    ));
    expect(created.status).toBe('completed');
    expect(etl.calls).toHaveLength(1);
    const { datasetId, versionId } = created.result!.primary;
    expect(env.store.getDataset(datasetId)).toMatchObject({ sourceKind: 'datanet_etl', sourceFormat: 'tsv' });
    expect(env.store.getDatasetVersion(versionId)!.sourceSha256).toBe(createHash('sha256').update(result).digest('hex'));
    const sidecar = new Database(env.store.getVerifiedMaterializedPath(versionId, 'local_answer'), { readonly: true });
    try {
      expect(sidecar.prepare('SELECT date, metrics_name, total, hours FROM data ORDER BY date').all()).toEqual([
        { date: '2026-09-01', metrics_name: 'app_open', total: 5, hours: 1.5 },
        { date: '2026-09-02', metrics_name: 'app_open', total: 6, hours: null },
        { date: '2026-09-03', metrics_name: 'app_open', total: 7, hours: null },
      ]);
    } finally {
      sidecar.close();
    }
  });

  it('fails a finished Datanet result that misfits its target without resubmitting, naming the saved-result recovery', async () => {
    const home = tempDir('local-file-home-');
    // An undeclared column literally named "network" must not read as a transient network failure.
    const etl = fakeEtl(home, '4243', 'metrics_name\tdate\ttotal\thours\tnetwork\napp_open\t2026-09-01\t5\t1.5\twifi\n');
    const env = environment(home, undefined, etl.runner);
    const failed = await env.service.prepareOrJoinAndWait(owner('etl-misfit'), plan(
      { kind: 'etl_query', alias: 'report', sql: 'SELECT 1', target: etlTarget('2026-09-01', '2026-09-01') },
      request('2026-09-01', '2026-09-01'),
    ));
    expect(failed.status).not.toBe('completed');
    expect(failed.error).toMatchObject({ code: 'invalid_input' });
    expect(failed.error!.message).toContain('Datanet run 4243 succeeded');
    expect(failed.error!.message).toContain('Not declared: network');
    expect(failed.error!.nextAction).toContain('never resubmit this SQL');
    expect(failed.error!.nextAction).toContain('~/.personal-productivity-tracker/etl-results/adhoc_4243.tsv');
    expect(etl.calls).toHaveLength(1);
    expect(env.counts()).toMatchObject({ jobs: 1, versions: 0 });
    // The named recovery is actionable: the saved result reads as a local file.
    const profile = await env.service.inspectLocalFile({ path: '~/.personal-productivity-tracker/etl-results/adhoc_4243.tsv' });
    expect(profile.columns.map(column => column.name)).toEqual(['metrics_name', 'date', 'total', 'hours', 'network']);

    await expect(env.service.prepareOrJoinAndWait(owner('etl-bad-token'), plan(
      { kind: 'etl_query', alias: 'report', sql: 'SELECT 1', nullToken: 'a\tb', target: etlTarget('2026-09-01', '2026-09-01') },
      request('2026-09-01', '2026-09-01'),
    ))).rejects.toMatchObject({ code: 'invalid_input', issues: [expect.objectContaining({ code: 'invalid_null_token' })] });
    expect(env.counts().jobs).toBe(1);
  });

  /** One exact sql-context 1.5 CSV export (the runner is covered in analytics-sql-export.test.ts). */
  function fakeSql(csv: string, columns: string[]) {
    const calls: string[] = [];
    const runner: AnalyticsPreparationSqlRunner = {
      exportComplete: async sql => {
        calls.push(sql);
        const bytes = Buffer.from(csv);
        return {
          format: 'csv', bytes, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
          rowCount: csv.split('\n').filter(Boolean).length - 1,
          columns: columns.map(name => ({ name, type: 'text' })),
          sqlSha256: createHash('sha256').update(sql).digest('hex'),
        };
      },
    };
    return { runner, calls };
  }

  // REGRESSION (live 2026-09-26): the SQL source read a run_query page (100
  // rows, "0 rows returned" footer on Redshift, JS Date text), so it could
  // never publish. It now exports the complete result and types it like a CSV.
  it('publishes a complete SQL export: exact dates, NULL, the text "NULL", and quoted commas', async () => {
    const home = tempDir('local-file-home-');
    const sql = fakeSql(
      'metrics_name,date,total,hours\n"app, open",2026-09-01,5,1.5\nNULL,2026-09-02,6,\n',
      ['metrics_name', 'date', 'total', 'hours'],
    );
    const env = environment(home, undefined, undefined, sql.runner);
    const created = await env.service.prepareOrJoinAndWait(owner('sql-ok'), plan(
      { kind: 'sql_query', alias: 'report', sql: 'SELECT metrics_name, date, total, hours FROM fixture', target: etlTarget('2026-09-01', '2026-09-02') },
      request('2026-09-01', '2026-09-02'),
    ));
    expect(created.status).toBe('completed');
    expect(sql.calls).toEqual(['SELECT metrics_name, date, total, hours FROM fixture']);
    const { datasetId, versionId } = created.result!.primary;
    expect(env.store.getDataset(datasetId)).toMatchObject({ sourceKind: 'sql_context', sourceFormat: 'canonical_json' });
    expect(env.store.getDatasetVersion(versionId)).toMatchObject({ rowCount: 2 });
    const sidecar = new Database(env.store.getVerifiedMaterializedPath(versionId, 'local_answer'), { readonly: true });
    try {
      expect(sidecar.prepare('SELECT date, metrics_name, total, hours FROM data ORDER BY date').all()).toEqual([
        { date: '2026-09-01', metrics_name: 'app, open', total: 5, hours: 1.5 },
        { date: '2026-09-02', metrics_name: 'NULL', total: 6, hours: null },
      ]);
    } finally {
      sidecar.close();
    }
  });

  it('publishes nothing when a SQL result misfits its target, and says re-running the query is safe', async () => {
    const home = tempDir('local-file-home-');
    const sql = fakeSql(
      'metrics_name,date,total,hours,network\napp_open,2026-09-01,5,1.5,wifi\n',
      ['metrics_name', 'date', 'total', 'hours', 'network'],
    );
    const env = environment(home, undefined, undefined, sql.runner);
    const failed = await env.service.prepareOrJoinAndWait(owner('sql-misfit'), plan(
      { kind: 'sql_query', alias: 'report', sql: 'SELECT 1', target: etlTarget('2026-09-01', '2026-09-01') },
      request('2026-09-01', '2026-09-01'),
    ));
    expect(failed.status).not.toBe('completed');
    expect(failed.error).toMatchObject({ code: 'invalid_input' });
    expect(failed.error!.message).toContain('The SQL query returned 1 row(s)');
    expect(failed.error!.message).toContain('The query returned exactly the columns');
    expect(failed.error!.message).toContain('Not declared: network');
    expect(failed.error!.message).not.toContain('nullToken');
    expect(failed.error!.nextAction).toContain('re-running this read-only query is safe');
    expect(env.counts()).toMatchObject({ jobs: 1, versions: 0 });

    const timestamps = fakeSql('metrics_name,date,total,hours\napp_open,2026-09-01 10:30:00,5,1.5\n', ['metrics_name', 'date', 'total', 'hours']);
    const envTs = environment(tempDir('local-file-home-'), undefined, undefined, timestamps.runner);
    const wrongType = await envTs.service.prepareOrJoinAndWait(owner('sql-ts'), plan(
      { kind: 'sql_query', alias: 'report', sql: 'SELECT 1', target: etlTarget('2026-09-01', '2026-09-01') },
      request('2026-09-01', '2026-09-01'),
    ));
    expect(wrongType.error!.message).toContain('result row 1 holds text "2026-09-01 10:30:00"');
    expect(wrongType.error!.message).toContain('convert the column in the query');
  });

  it('passes an export failure through with its own next action and publishes nothing', async () => {
    const home = tempDir('local-file-home-');
    const runner: AnalyticsPreparationSqlRunner = {
      exportComplete: async () => {
        throw new AnalyticsSqlExportError('too_large', 'The query returns more than 50,000 rows or 32 MiB.', 'Nothing was published. Aggregate or filter in SQL, or use etl_query.');
      },
    };
    const env = environment(home, undefined, undefined, runner);
    const failed = await env.service.prepareOrJoinAndWait(owner('sql-large'), plan(
      { kind: 'sql_query', alias: 'report', sql: 'SELECT * FROM big', target: etlTarget('2026-09-01', '2026-09-01') },
      request('2026-09-01', '2026-09-01'),
    ));
    expect(failed.status).not.toBe('completed');
    expect(failed.error).toMatchObject({ code: 'invalid_input', message: 'The query returns more than 50,000 rows or 32 MiB.' });
    expect(failed.error!.nextAction).toBe('Nothing was published. Aggregate or filter in SQL, or use etl_query.');
    expect(env.counts()).toMatchObject({ jobs: 1, versions: 0 });
  });
});
