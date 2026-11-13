import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectKnowledgeParts } from './analytics-context.js';
import {
  catalogQuerySql,
  corpusTables,
  createEtlCatalogReader,
  packDictionaryBatches,
  parseCatalogTsv,
  parseDictionaryResponse,
  renderDataDictionary,
  resolveCatalogTables,
  scanTableRefs,
  type DictionaryEntry,
} from './etl-data-dictionary.js';
import type { QueryRunResult, QueryRunner } from './etl-adhoc.js';

/**
 * The data dictionary BotBoy's onboarding writes (owner decision 2026-11-10): which tables the profiles read, their columns
 * from the catalog, the model's meanings kept only for real columns, and one file read in parts.
 */
const TSV = [
  'table_schema\ttable_name\tcolumn_name\tdata_type\tordinal_position',
  'public\tonline_content_watched_table_v2\tuuid\tcharacter varying\t1',
  'public\tonline_content_watched_table_v2\tct_id\tcharacter varying\t2',
  'public\tonline_content_watched_table_v2\tappsflyerid\tcharacter varying\t3',
  // A schema that sorts before public: an unqualified name still resolves to public.
  'archive\tonline_content_watched_table_v2\tuuid\tcharacter varying\t1',
  'fatafat\tmxp_player\tplaytime\tcharacter varying\t2',
  'fatafat\tmxp_player\tuuid\tcharacter varying\t1',
].join('\n');

describe('data dictionary: tables and catalog', () => {
  it('reads the tables a profile queries, not its comments, literals, CTEs, temp tables or EXTRACT columns', () => {
    const sql = [
      '/* weekly report: data from the old system */',
      '-- read from legacy_table later',
      "CREATE TEMP TABLE stage AS SELECT * FROM fatafat.mxp_player WHERE note = 'copied from backup';",
      'WITH daily AS (SELECT uuid FROM online_content_watched_table_v2 WHERE EXTRACT(HOUR FROM eventts) = 1)',
      "SELECT TRIM(BOTH ' ' FROM d.uuid) FROM daily d JOIN stage s ON 1=1 JOIN information_schema.columns c ON 1=1;",
      // A recursive CTE with a column list, and a column named from (a profile's `a.from in ('local')`).
      "WITH RECURSIVE months(run_month) AS (SELECT 1 FROM daily_cms_data_table) SELECT a.from IN ('local') FROM months a",
    ].join('\n');
    expect(scanTableRefs(sql)).toEqual([
      { name: 'fatafat.mxp_player', internal: false },
      { name: 'online_content_watched_table_v2', internal: false },
      { name: 'daily', internal: true },
      { name: 'stage', internal: true },
      { name: 'information_schema.columns', internal: false },
      { name: 'daily_cms_data_table', internal: false },
      { name: 'months', internal: true },
    ]);
    const refs = corpusTables(new Map([['1', sql], ['2', 'SELECT 1 FROM fatafat.mxp_player']]));
    expect([...refs.keys()]).toEqual(['fatafat.mxp_player', 'online_content_watched_table_v2', 'daily_cms_data_table']);
    expect([...refs.get('fatafat.mxp_player')!]).toEqual(['1', '2']);
  });

  it('asks the catalog in the form that works through ETL: every column outside the system schemas, no list of table names', () => {
    const sql = catalogQuerySql();
    expect(sql).toContain('CREATE TEMP TABLE botboy_dictionary_columns AS');
    expect(sql).toContain('FROM svv_columns');
    expect(sql).toContain('column_name::VARCHAR(256) AS column_name');
    expect(sql).toContain('ordinal_position::INTEGER AS ordinal_position');
    expect(sql).toContain("WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_temp%';");
    // A list of 133 table names failed through ETL (run 13238928700, "Hash table for subplan does not exist"). Nothing that
    // cannot be exported through ETL, and nothing that fails over catalog rows.
    for (const banned of [/table_name\s+IN/i, /\b(?:information_schema|pg_catalog)\.\w/i, /current_database/i, /\bjoin\b/i, /group by/i, /\bover\s*\(/i]) {
      expect(sql).not.toMatch(banned);
    }
  });

  it('matches profile names to catalog tables: a schema must match, an unqualified name prefers public', () => {
    const catalog = parseCatalogTsv(TSV);
    expect(catalog).toHaveLength(6);
    const refs = new Map<string, Set<string>>([
      ['online_content_watched_table_v2', new Set(['1', '2'])],
      ['public.online_content_watched_table_v2', new Set(['2', '3'])],
      ['fatafat.mxp_player', new Set(['4'])],
      ['other.mxp_player', new Set(['5'])],
      ['daily_cms_data_table', new Set(['6', '7'])],
    ]);
    const { tables, missing } = resolveCatalogTables(refs, catalog);
    expect(tables.map(table => [table.key, [...table.profileIds].sort()])).toEqual([
      ['public.online_content_watched_table_v2', ['1', '2', '3']],
      ['fatafat.mxp_player', ['4']],
    ]);
    // Columns come in catalog order.
    expect(tables[1].columns.map(column => column.name)).toEqual(['uuid', 'playtime']);
    expect(missing).toEqual([{ name: 'daily_cms_data_table', profiles: 2 }, { name: 'other.mxp_player', profiles: 1 }]);
    expect(() => parseCatalogTsv('foo\tbar\n1\t2')).toThrow(/no table_name and column_name/);
  });

  it('keeps what the model says only about real columns, and marks columns read from the name', () => {
    const [table] = resolveCatalogTables(new Map([['online_content_watched_table_v2', new Set(['1'])]]), parseCatalogTsv(TSV)).tables;
    const content = '```json\n' + JSON.stringify({
      tables: [{
        table: 'online_content_watched_table_v2',
        purpose: 'One row per OTT playback exit.',
        timeColumn: 'start_date',
        idColumns: ['uuid', 'invented_id', 'ct_id'],
        columns: { appsflyerid: 'AppsFlyer ID of the device', made_up: 'not a column', ct_id: 'CleverTap ID' },
        inferredColumns: ['ct_id'],
        inferred: ['purpose'],
      }, { table: 'some_other_table', purpose: 'ignored' }],
    }) + '\n```';
    const entry = parseDictionaryResponse(content, [table]).get('public.online_content_watched_table_v2')!;
    expect(entry.purpose).toBe('One row per OTT playback exit.');
    expect(entry.timeColumn).toBeUndefined();
    expect(entry.idColumns).toEqual(['uuid', 'ct_id']);
    expect([...entry.meanings.entries()]).toEqual([
      ['appsflyerid', { text: 'AppsFlyer ID of the device', inferred: false }],
      ['ct_id', { text: 'CleverTap ID', inferred: true }],
    ]);
    expect(entry.inferred).toEqual(['purpose']);
    expect(parseDictionaryResponse('not json', [table]).size).toBe(0);
  });

  it('packs tables into batches by table count and by columns, a wide table alone', () => {
    const table = (key: string, columns: number) => ({
      key, profileIds: new Set(['1']), columns: Array.from({ length: columns }, (_, index) => ({ name: `c${index}`, type: 'integer' })),
    });
    const batches = packDictionaryBatches(
      [table('a', 3), table('b', 1), table('wide', 200), table('c', 2), table('d', 2), table('e', 2), table('f', 2), table('g', 2)],
      4, 10,
    );
    expect(batches.map(batch => batch.map(item => item.key))).toEqual([['a', 'b'], ['wide'], ['c', 'd', 'e', 'f'], ['g']]);
  });
});

describe('data dictionary: one file read in parts', () => {
  function dictionary(): string {
    const { tables, missing } = resolveCatalogTables(new Map([
      ['online_content_watched_table_v2', new Set(['1', '2'])],
      ['fatafat.mxp_player', new Set(['3'])],
      ['daily_cms_data_table', new Set(['4'])],
    ]), parseCatalogTsv(TSV));
    const entries = new Map<string, DictionaryEntry>([['public.online_content_watched_table_v2', {
      purpose: 'One row per OTT playback exit: which video a device played. Use it for watch time.',
      grain: 'one playback exit',
      idColumns: ['uuid', 'ct_id', 'appsflyerid'],
      joins: ['videoid = daily_cms_data_table.video_id'],
      events: ['onlinePlayExited'],
      meanings: new Map([['appsflyerid', { text: 'AppsFlyer ID', inferred: false }], ['ct_id', { text: 'CleverTap ID', inferred: true }]]),
      traps: ['playtime is milliseconds stored as text'],
      inferred: ['grain'],
    }]]);
    return renderDataDictionary({
      group: 'MY-GROUP', derivedAt: '2026-11-10', profilesWithSql: 4, tables, entries, missing,
      usage: new Map([['public.online_content_watched_table_v2', new Map([['uuid', 2], ['appsflyerid', 1]])]]),
      businessesByTable: new Map([['public.online_content_watched_table_v2', { ott: 2 }]]),
    });
  }

  it('lists every catalog column, says what each table is for, and names what the catalog did not return', () => {
    const text = dictionary();
    expect(text.split('\n')[0]).toBe('# Data dictionary — MY-GROUP');
    expect(text).toContain('<!-- botboy:data-dictionary v1 -->');
    expect(text).toContain('| `public.online_content_watched_table_v2` | One row per OTT playback exit: which video a device played. | `uuid`, `ct_id`, `appsflyerid` | 3 | 2 |');
    expect(text).toContain('**Grain:** one playback exit (inferred)');
    expect(text).toContain('**Read by:** 2 profiles (ott 2) · **Columns:** 3');
    // Every column the catalog lists, used or not, with how many profiles mention it.
    expect(text).toContain('| `uuid` | character varying | 2 |  |');
    expect(text).toContain('| `ct_id` | character varying | 0 | CleverTap ID (from the name) |');
    expect(text).toContain('| `appsflyerid` | character varying | 1 | AppsFlyer ID |');
    // A table the model wrote nothing for still has its columns.
    expect(text).toContain("## fatafat.mxp_player\n\n**What it's for:** not written yet");
    expect(text).toContain('| `playtime` | character varying | 0 |  |');
    expect(text).toContain('`daily_cms_data_table` (1)');
  });

  it('tells an entry the model wrote without a purpose apart from a table it wrote nothing for', () => {
    const { tables } = resolveCatalogTables(new Map([['fatafat.mxp_player', new Set(['1'])]]), parseCatalogTsv(TSV));
    const entries = new Map<string, DictionaryEntry>([['fatafat.mxp_player', {
      idColumns: ['uuid'], joins: [], events: [], meanings: new Map(), traps: [], inferred: [],
    }]]);
    const text = renderDataDictionary({
      group: 'G', derivedAt: '2026-11-10', profilesWithSql: 1, tables, entries, missing: [], usage: new Map(), businessesByTable: new Map(),
    });
    expect(text).toContain("**What it's for:** not stated (the evidence did not show it).");
    expect(text).not.toContain('not written yet');
  });

  it('returns the index by default, whole entries by table, and matching rows by word', () => {
    const text = dictionary();
    const index = selectKnowledgeParts(text)!;
    expect(index).toContain('## Index');
    expect(index).not.toContain('## fatafat.mxp_player');
    expect(index).toContain('[Index only: this file holds 2 table entries.');

    const entry = selectKnowledgeParts(text, { tables: ['mxp_player', 'nope'] })!;
    expect(entry.startsWith('## fatafat.mxp_player')).toBe(true);
    expect(entry).toContain('| `playtime` |');
    expect(entry).not.toContain('online_content_watched_table_v2 |');
    expect(entry).toContain('[Not in this file: nope. The Index lists every table this dictionary covers.]');

    const found = selectKnowledgeParts(text, { find: 'AppsFlyer' })!;
    expect(found).toContain('[find "appsflyer": 2 matching lines in 1 section.]');
    expect(found).toContain("## public.online_content_watched_table_v2\n**What it's for:** One row per OTT playback exit");
    expect(found).toContain('**ID columns:**');
    expect(found).toContain('| Column | Type | Profiles | Meaning |\n|---|---|---|---|\n| `appsflyerid` | character varying | 1 | AppsFlyer ID |');
    // The index repeats the entries, so a search reads only the entries.
    expect(found).not.toContain('| `public.online_content_watched_table_v2` |');

    expect(selectKnowledgeParts(text, { find: 'gaid' })).toContain('no matches. This dictionary covers the tables the team');
  });

  it('leaves any other file whole unless a part is asked for, and finds lines under their heading there', () => {
    const preset = '# OTT\n\n## Tables that matter\n\n`online_content_watched_table_v2` playback\n\n## Recipes\n\nSELECT uuid FROM t\n';
    expect(selectKnowledgeParts(preset)).toBeNull();
    expect(selectKnowledgeParts(preset, { find: 'uuid' })).toBe('[find "uuid": 1 matching line in 1 section.]\n\n## Recipes\nSELECT uuid FROM t');
    expect(selectKnowledgeParts(preset, { tables: ['recipes'] })).toBe('## Recipes\n\nSELECT uuid FROM t');
  });
});

describe('data dictionary: the catalog query through ETL', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-dictionary-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function fakeRunner(script: { run?: QueryRunResult; reads: QueryRunResult[] }) {
    const log: string[] = [];
    const runner: QueryRunner = {
      id: 'fake',
      runQuery: async ({ onSubmitted }) => {
        log.push('runQuery');
        await onSubmitted?.('13300000001');
        log.push(`checkpoint:${fs.existsSync(path.join(dir, 'run.json'))}`);
        return script.run ?? { ok: false, code: 'alive_handoff', runId: '13300000001', remoteStatus: 'WAITING_FOR_RESOURCES' };
      },
      readRun: async ({ runId }) => {
        log.push(`readRun:${runId}`);
        // Out of scripted reads: a terminal failure, so a reader that keeps polling ends instead of looping.
        return script.reads.shift() ?? { ok: false, code: 'remote_failed', runId, error: 'fake: no more reads' };
      },
    };
    return { runner, log };
  }

  // A fake clock that each wait moves on, so a reader that kept polling would reach its deadline instead of looping forever.
  const reader = (runner: QueryRunner) => {
    let clock = 0;
    return createEtlCatalogReader({
      db: {} as any, call: async () => ({ isError: true, text: 'unused' }), runner: () => runner,
      sleep: async ms => { clock += ms; }, now: () => clock, pollIntervalMs: 60_000, totalBudgetMs: 10 * 60_000,
    });
  };

  it('checkpoints the run before waiting, reads it until it lands, and never submits it twice', async () => {
    const result = path.join(dir, 'adhoc_13300000001.tsv');
    fs.writeFileSync(result, TSV);
    const { runner, log } = fakeRunner({ reads: [
      { ok: false, code: 'alive_handoff', runId: '13300000001', remoteStatus: 'EXECUTING' },
      { ok: true, runId: '13300000001', savedTo: result },
    ] });
    const notes: string[] = [];
    const read = await reader(runner).read({ sql: 'SELECT 1', downloadDir: dir, checkpointFile: path.join(dir, 'run.json'), onStatus: note => notes.push(note) });
    expect(read).toEqual({ ok: true, text: TSV, runId: '13300000001' });
    expect(log).toEqual(['runQuery', 'checkpoint:true', 'readRun:13300000001', 'readRun:13300000001']);
    expect(notes).toEqual(['catalog query: Datanet run 13300000001 submitted', 'catalog query: Datanet run 13300000001 EXECUTING']);
    expect(fs.existsSync(path.join(dir, 'run.json'))).toBe(false);
  });

  it('a run that fails at once is forgotten; a run whose download did not land is read again, not submitted again', async () => {
    const checkpointFile = path.join(dir, 'run.json');
    const failedAtOnce = fakeRunner({
      run: { ok: false, code: 'remote_failed', runId: '13300000001', remoteStatus: 'ERROR', error: 'Run 13300000001 ERROR. (SQL Error: ERROR: Assert' },
      reads: [],
    });
    const failed = await reader(failedAtOnce.runner).read({ sql: 'SELECT 1', downloadDir: dir, checkpointFile });
    expect(failed).toMatchObject({ ok: false, error: expect.stringContaining('Assert') });
    expect(failedAtOnce.log).toEqual(['runQuery', 'checkpoint:true']);
    expect(fs.existsSync(checkpointFile)).toBe(false);

    const result = path.join(dir, 'adhoc_13300000001.tsv');
    fs.writeFileSync(result, TSV);
    const landing = fakeRunner({ reads: [
      { ok: false, code: 'download_failed', runId: '13300000001', remoteStatus: 'SUCCESS', error: 'The download did not land.' },
      { ok: true, runId: '13300000001', savedTo: result },
    ] });
    const first = await reader(landing.runner).read({ sql: 'SELECT 1', downloadDir: dir, checkpointFile });
    expect(first).toMatchObject({ ok: false, error: expect.stringContaining('The download did not land.') });
    expect(fs.existsSync(checkpointFile)).toBe(true);
    const second = await reader(landing.runner).read({ sql: 'SELECT 1', downloadDir: dir, checkpointFile });
    expect(second).toEqual({ ok: true, text: TSV, runId: '13300000001' });
    expect(landing.log).toEqual(['runQuery', 'checkpoint:true', 'readRun:13300000001', 'readRun:13300000001']);
  });

  it('a restarted read picks up the submitted run, and a failed run is forgotten', async () => {
    const checkpointFile = path.join(dir, 'run.json');
    const { createHash } = await import('node:crypto');
    fs.writeFileSync(checkpointFile, JSON.stringify({ runId: '13300000009', sqlSha256: createHash('sha256').update('SELECT 1').digest('hex') }));
    const { runner, log } = fakeRunner({ reads: [{ ok: false, code: 'remote_failed', runId: '13300000009', error: 'Run 13300000009 ERROR. bad', nextAction: 'Fix the SQL.' }] });
    const read = await reader(runner).read({ sql: 'SELECT 1', downloadDir: dir, checkpointFile });
    expect(read).toEqual({ ok: false, error: 'The catalog query failed: Run 13300000009 ERROR. bad', nextAction: 'Fix the SQL.' });
    expect(log).toEqual(['readRun:13300000009']);
    expect(fs.existsSync(checkpointFile)).toBe(false);
  });

  it('a checkpoint left by a different catalog query is not read: the new query is submitted', async () => {
    const checkpointFile = path.join(dir, 'run.json');
    fs.writeFileSync(checkpointFile, JSON.stringify({ runId: '13300000009', sqlSha256: 'the previous table list' }));
    const result = path.join(dir, 'adhoc_13300000001.tsv');
    fs.writeFileSync(result, TSV);
    const { runner, log } = fakeRunner({ run: { ok: true, runId: '13300000001', savedTo: result }, reads: [] });
    const read = await reader(runner).read({ sql: 'SELECT 1', downloadDir: dir, checkpointFile });
    expect(read).toEqual({ ok: true, text: TSV, runId: '13300000001' });
    expect(log).toEqual(['runQuery', 'checkpoint:true']);
    expect(fs.existsSync(checkpointFile)).toBe(false);
  });
});
