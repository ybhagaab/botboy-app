import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, setSetting, type StorageLayer } from './storage.js';
import { ANALYTICS_CONTEXT_DIR_KEY, listAnalyticsContext, loadAnalyticsContext } from './analytics-context.js';
import { createEtlOnboardingService, type EtlOnboardingService } from './etl-onboarding.js';
import { DICTIONARY_SYSTEM, type CatalogReader } from './etl-data-dictionary.js';
import type { EtlToolCall } from './etl-adhoc.js';

/**
 * The data dictionary step of BotBoy's ETL onboarding (owner decision 2026-11-10): BotBoy builds data-dictionary.md itself
 * when it builds its context files, from the profiles' tables, one catalog query and its own model, and never overwrites a
 * preset it did not write. Fakes stand in for Datanet, the model and the catalog query.
 */
const FATAFAT_SQL = "SELECT f.uuid, SUM(CAST(f.playtime AS FLOAT)) FROM fatafat.mxp_player f JOIN daily_cms_data_table c ON f.videoid = c.video_id WHERE f.event = 'onlineStreamEnd' GROUP BY 1;";
const STREAM_SQL = "SELECT uuid, ct_id FROM online_content_watched_table_v2 WHERE event = 'onlinePlayExited';";
const CATALOG_TSV = [
  'table_schema\ttable_name\tcolumn_name\tdata_type\tordinal_position',
  'fatafat\tmxp_player\tuuid\tcharacter varying\t1',
  'fatafat\tmxp_player\tplaytime\tcharacter varying\t2',
  'fatafat\tmxp_player\tvideoid\tcharacter varying\t3',
  'public\tdaily_cms_data_table\tvideo_id\tcharacter varying\t1',
  'public\tonline_content_watched_table_v2\tuuid\tcharacter varying\t1',
  'public\tonline_content_watched_table_v2\tct_id\tcharacter varying\t2',
  'public\tonline_content_watched_table_v2\tappsflyerid\tcharacter varying\t3',
  // The catalog query reads every table; one no profile reads is left out of the dictionary.
  'public\tunused_archive_table\tid\tinteger\t1',
].join('\n');
const DOCS = [
  ['1', 'Fatafat daily watch time'], ['2', 'fatafat weekly streamers'], ['3', 'Fatafat show split'],
  ['4', 'video streaming engagement'], ['5', 'playback funnel weekly'],
].map(([id, description]) => ({ profile_id: id, job_id: `9${id}`, job_group_name: 'MY-GROUP', job_description: description, job_schedule_type: 'DAILY' }));
const SQL: Record<string, string> = { '1': FATAFAT_SQL, '2': FATAFAT_SQL, '3': FATAFAT_SQL, '4': STREAM_SQL, '5': STREAM_SQL };

describe('etl-onboarding data dictionary', () => {
  let storage: StorageLayer;
  let tmpDir: string;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-dictionary-'));
    setSetting(storage.getDb(), ANALYTICS_CONTEXT_DIR_KEY, tmpDir);
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const call: EtlToolCall = async (toolName, args) => {
    if (toolName === 'datanet_search') {
      const start = Number(args.start ?? 0);
      return { isError: false, text: JSON.stringify({ found: DOCS.length, searchResults: DOCS.slice(start, start + 25).map(document => ({ document })) }) };
    }
    if (toolName === 'datanet_get_profile_sql') return { isError: false, text: SQL[String(args.profile_id)] ?? '' };
    return { isError: true, text: `unexpected tool ${toolName}` };
  };

  function fakeLlm(options: { failDictionary?: boolean; omit?: string } = {}) {
    const dictionaryInputs: any[] = [];
    return {
      dictionaryInputs,
      chatCompletion: async (request: any) => {
        const system = String(request.messages[0].content);
        const input = JSON.parse(request.messages[1].content);
        if (system === DICTIONARY_SYSTEM) {
          dictionaryInputs.push(input);
          if (options.failDictionary) throw new Error('model unavailable');
          return {
            content: JSON.stringify({
              tables: input.tables.filter((table: any) => table.table !== options.omit).map((table: any) => ({
                table: table.table,
                purpose: `What ${table.table} records.`,
                idColumns: table.columns.map((column: any[]) => column[0]).filter((name: string) => /uuid|_id$|ct_id|appsflyerid/.test(name)),
                columns: Object.fromEntries(table.columns.map((column: any[]) => [column[0], `Meaning of ${column[0]}`])),
              })),
            }),
          };
        }
        if (request.responseFormat?.type === 'json_object') {
          return { content: JSON.stringify({ assignments: input.profiles.map((profile: any) => ({ id: profile.id, business: 'streaming' })) }) };
        }
        // A generated brief names the tables it covers, like a real one.
        return { content: `# ${input.business} — Datanet ETL SQL Context\n\n## Tables that matter\n\`fatafat.mxp_player\` and \`online_content_watched_table_v2\` (brief)` };
      },
    };
  }

  function fakeCatalog(result: { fail?: boolean } = {}) {
    const sqls: string[] = [];
    const catalog: CatalogReader = {
      read: async ({ sql }) => {
        sqls.push(sql);
        return result.fail
          ? { ok: false, error: 'The catalog query failed: Run 1 ERROR.', nextAction: 'Check the Datanet ETL connection.' }
          : { ok: true, text: CATALOG_TSV, runId: '13300000001' };
      },
    };
    return { catalog, sqls };
  }

  const makeService = (llm: ReturnType<typeof fakeLlm>, catalog?: CatalogReader, extra: { dictionaryBatchColumns?: number } = {}): EtlOnboardingService => createEtlOnboardingService({
    db: storage.getDb(), call, llm: llm as any, pageSize: 25, fetchDelayMs: 0, minClusterSize: 2, synthesisMaxTokens: 200,
    ...(catalog ? { catalog } : {}),
    ...extra,
  });

  async function runOnce(service: EtlOnboardingService, options: Parameters<EtlOnboardingService['start']>[0] = {}) {
    service.start({ group: 'MY-GROUP', ...options });
    const startedAt = Date.now();
    while (service.getStatus().state === 'running') {
      if (Date.now() - startedAt > 5000) throw new Error('onboarding did not finish in time');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return service.getStatus();
  }

  const dictionaryText = () => fs.readFileSync(path.join(tmpDir, 'data-dictionary.md'), 'utf8');

  it('writes the data dictionary with the presets: every table the profiles read, its catalog columns, what it is for', async () => {
    const llm = fakeLlm();
    const { catalog, sqls } = fakeCatalog();
    const status = await runOnce(makeService(llm, catalog));
    expect(status.state).toBe('completed');
    expect(status.lastResult?.presetsWritten).toBe(2);
    expect(status.lastResult?.dictionary).toEqual({ file: 'data-dictionary.md', tables: 3, notInCatalog: 0, batchesFailed: 0, tablesUnwritten: 0 });
    expect(status.lastResult?.errors).toEqual([]);
    // One catalog query, for every table; BotBoy keeps the three the profiles read.
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain("WHERE table_schema NOT IN ('pg_catalog', 'information_schema')");
    expect(dictionaryText()).not.toContain('unused_archive_table');
    // The model got the catalog columns with their use counts and the profiles' SQL.
    const stream = llm.dictionaryInputs.flatMap(input => input.tables).find((table: any) => table.table === 'public.online_content_watched_table_v2');
    expect(stream.columns).toEqual([['uuid', 'character varying', 2], ['ct_id', 'character varying', 2], ['appsflyerid', 'character varying', 0]]);
    expect(stream.businesses).toEqual({ streaming: 2 });
    expect(stream.sqlExcerpts[0]).toContain('FROM online_content_watched_table_v2');

    const text = dictionaryText();
    expect(text).toContain('## public.online_content_watched_table_v2');
    expect(text).toContain('| `appsflyerid` | character varying | 0 | Meaning of appsflyerid |');
    expect(text).toContain("**What it's for:** What fatafat.mxp_player records.");
    // The file is listed for the model, and a search finds a column no profile uses.
    const listed = listAnalyticsContext(storage.getDb()).files.find(file => file.name === 'data-dictionary.md')!;
    expect(listed.title).toBe('Data dictionary — MY-GROUP');
    expect(listed.keywords).toEqual(expect.arrayContaining(['data dictionary', 'uuid', 'appsflyerid']));
    const found = loadAnalyticsContext(storage.getDb(), 'data-dictionary.md', undefined, { find: 'appsflyerid' });
    expect(found.ok && found.content).toContain('| `appsflyerid` | character varying | 0 | Meaning of appsflyerid |');
  });

  it('keeps a preset BotBoy did not write, and reads its meanings into the dictionary', async () => {
    fs.mkdirSync(path.join(tmpDir, 'presets'), { recursive: true });
    const handWritten = '# Fatafat — hand-written brief\n\n## 3.1 `fatafat.mxp_player` — the workhorse\n\n`playtime` is milliseconds stored as text.\n';
    fs.writeFileSync(path.join(tmpDir, 'presets', 'fatafat-etl.md'), handWritten);
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({ files: [{ file: 'presets/fatafat-etl.md', source: 'etl-derived', business: 'fatafat' }] }));
    const llm = fakeLlm();
    const status = await runOnce(makeService(llm, fakeCatalog().catalog), { regenerate: true });
    expect(status.lastResult?.kept).toEqual(['fatafat']);
    expect(status.lastResult?.businesses).toEqual(['streaming']);
    expect(fs.readFileSync(path.join(tmpDir, 'presets', 'fatafat-etl.md'), 'utf8')).toBe(handWritten);
    expect(fs.existsSync(path.join(tmpDir, 'presets', 'fatafat.md'))).toBe(false);
    const player = llm.dictionaryInputs.flatMap(input => input.tables).find((table: any) => table.table === 'fatafat.mxp_player');
    expect(player.knowledgeExcerpts).toEqual([{ file: path.join('presets', 'fatafat-etl.md'), text: expect.stringContaining('`playtime` is milliseconds stored as text.') }]);
  });

  it('builds a missing dictionary without touching presets, never on a targeted refresh, and rebuilds only it on request', async () => {
    const first = fakeCatalog();
    await runOnce(makeService(fakeLlm(), first.catalog));
    const stream = path.join(tmpDir, 'presets', 'streaming.md');
    fs.writeFileSync(stream, `${fs.readFileSync(stream, 'utf8')}\nowner note\n`);
    fs.rmSync(path.join(tmpDir, 'data-dictionary.md'));

    // A plain start: presets are skipped as before, and the missing dictionary is built from the cached catalog.
    const plain = await runOnce(makeService(fakeLlm(), first.catalog));
    expect(plain.lastResult?.presetsWritten).toBe(0);
    expect(plain.lastResult?.dictionary?.tables).toBe(3);
    expect(first.sqls).toHaveLength(1);
    expect(fs.readFileSync(stream, 'utf8')).toContain('owner note');

    // A targeted refresh never builds it, even when it is missing.
    fs.rmSync(path.join(tmpDir, 'data-dictionary.md'));
    const targeted = await runOnce(makeService(fakeLlm(), first.catalog), { businesses: ['streaming'] });
    expect(targeted.lastResult?.dictionary).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, 'data-dictionary.md'))).toBe(false);

    // A dictionary-only run reads the catalog again, writes no preset, and asks the model again only for the table whose
    // evidence changed: the team's new note about daily_cms_data_table.
    fs.writeFileSync(path.join(tmpDir, 'notes.md'), '# Notes\n\n## daily_cms_data_table\n\n`video_id` is the CMS video id.\n');
    const rebuildLlm = fakeLlm();
    const rebuilt = await runOnce(makeService(rebuildLlm, first.catalog), { dictionary: true });
    expect(rebuilt.lastResult?.presetsWritten).toBe(0);
    expect(rebuilt.lastResult?.dictionary?.tables).toBe(3);
    expect(first.sqls).toHaveLength(2);
    expect(rebuildLlm.dictionaryInputs.flatMap(input => input.tables.map((table: any) => table.table))).toEqual(['public.daily_cms_data_table']);
    expect(dictionaryText()).toContain("**What it's for:** What fatafat.mxp_player records.");
  });

  it('a dictionary-only run writes the dictionary and no preset, even where no preset exists yet', async () => {
    const status = await runOnce(makeService(fakeLlm(), fakeCatalog().catalog), { dictionary: true });
    expect(status.lastResult?.presetsWritten).toBe(0);
    expect(status.lastResult?.dictionary?.tables).toBe(3);
    const presets = path.join(tmpDir, 'presets');
    expect(fs.existsSync(presets) ? fs.readdirSync(presets) : []).toEqual([]);
  });

  it('resumes from the cached catalog and table entries: a second build makes no model or catalog call', async () => {
    const { catalog, sqls } = fakeCatalog();
    await runOnce(makeService(fakeLlm(), catalog));
    fs.rmSync(path.join(tmpDir, 'data-dictionary.md'));
    const llm = fakeLlm();
    const again = await runOnce(makeService(llm, catalog));
    expect(again.lastResult?.dictionary?.tables).toBe(3);
    expect(llm.dictionaryInputs).toHaveLength(0);
    expect(sqls).toHaveLength(1);
    expect(dictionaryText()).toContain('Meaning of appsflyerid');

    // Regenerate all reads the catalog again and asks again for every table.
    const regenerateLlm = fakeLlm();
    const regenerated = await runOnce(makeService(regenerateLlm, catalog), { regenerate: true });
    expect(regenerated.lastResult?.dictionary?.tables).toBe(3);
    expect(sqls).toHaveLength(2);
    expect(regenerateLlm.dictionaryInputs.flatMap(input => input.tables)).toHaveLength(3);
  });

  it('a failed catalog query leaves the presets written and says why; a failed model batch keeps the catalog columns', async () => {
    const failed = await runOnce(makeService(fakeLlm(), fakeCatalog({ fail: true }).catalog));
    expect(failed.state).toBe('completed');
    expect(failed.lastResult?.presetsWritten).toBe(2);
    expect(failed.lastResult?.dictionary).toBeUndefined();
    expect(failed.lastResult?.errors).toEqual(['data dictionary: The catalog query failed: Run 1 ERROR. Check the Datanet ETL connection.']);
    expect(fs.existsSync(path.join(tmpDir, 'data-dictionary.md'))).toBe(false);

    const model = await runOnce(makeService(fakeLlm({ failDictionary: true }), fakeCatalog().catalog), { dictionary: true });
    expect(model.lastResult?.dictionary).toMatchObject({ tables: 3, batchesFailed: 1 });
    expect(dictionaryText()).toContain("**What it's for:** not written yet");
    expect(dictionaryText()).toContain('| `appsflyerid` | character varying | 0 |  |');

    // An answer that skips a table counts as a failed batch; the skipped table keeps its catalog columns.
    const partialLlm = fakeLlm({ omit: 'fatafat.mxp_player' });
    const partial = await runOnce(makeService(partialLlm, fakeCatalog().catalog), { dictionary: true });
    expect(partial.lastResult?.dictionary).toMatchObject({ tables: 3, batchesFailed: 1, tablesUnwritten: 1 });
    expect(dictionaryText()).toContain("## fatafat.mxp_player\n\n**What it's for:** not written yet");
    expect(dictionaryText()).toContain("**What it's for:** What public.online_content_watched_table_v2 records.");
    // BotBoy's own files (its generated presets and the previous dictionary) are never read as the team's knowledge.
    expect(partialLlm.dictionaryInputs.flatMap((input: any) => input.tables).flatMap((table: any) => table.knowledgeExcerpts)).toEqual([]);

    // Build data dictionary again: only the table without an entry is asked for.
    const retryLlm = fakeLlm();
    const retried = await runOnce(makeService(retryLlm, fakeCatalog().catalog), { dictionary: true });
    expect(retried.lastResult?.dictionary).toMatchObject({ tables: 3, batchesFailed: 0, tablesUnwritten: 0 });
    expect(retryLlm.dictionaryInputs.flatMap(input => input.tables.map((table: any) => table.table))).toEqual(['fatafat.mxp_player']);
    expect(dictionaryText()).toContain("**What it's for:** What fatafat.mxp_player records.");
  });

  it('sends the model batches small enough in columns for one answer each', async () => {
    const llm = fakeLlm();
    const status = await runOnce(makeService(llm, fakeCatalog().catalog, { dictionaryBatchColumns: 3 }));
    expect(status.lastResult?.dictionary).toMatchObject({ tables: 3, tablesUnwritten: 0 });
    // mxp_player (3 columns), daily_cms_data_table (1) and online_content_watched_table_v2 (3): no two fit in 3 columns.
    expect(llm.dictionaryInputs.map(input => input.tables.map((table: any) => table.table))).toEqual([
      ['fatafat.mxp_player'], ['public.daily_cms_data_table'], ['public.online_content_watched_table_v2'],
    ]);
  });

  it('writes no dictionary without a catalog reader (as before this step)', async () => {
    const status = await runOnce(makeService(fakeLlm()));
    expect(status.lastResult?.presetsWritten).toBe(2);
    expect(status.lastResult?.dictionary).toBeUndefined();
    expect(status.lastResult?.errors).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, 'data-dictionary.md'))).toBe(false);
  });
});
