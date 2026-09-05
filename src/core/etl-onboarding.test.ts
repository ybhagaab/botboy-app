import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer, setSetting, getSetting } from './storage.js';
import { ANALYTICS_CONTEXT_DIR_KEY } from './analytics-context.js';
import { createEtlOnboardingService, type EtlOnboardingService } from './etl-onboarding.js';
import type { EtlToolCall } from './etl-adhoc.js';

/**
 * ETL onboarding (etl-analytics A3): autonomous preset generation over the
 * user's OWN Datanet group. These tests fake the two external judges — the
 * Datanet connection (EtlToolCall) and the LLM — and verify the code-owned
 * guarantees: own-group scoping, disk-cached resume, two-pass clustering
 * with zero-break degradation, manifest merges that never touch user files,
 * skip-existing vs regenerate, and the code-appended reuse inventory.
 */

type SearchDoc = Record<string, unknown>;

const doc = (
  profileId: string,
  group: string,
  description: string,
  schedule: string = 'DAILY',
): SearchDoc => ({
  profile_id: profileId,
  job_id: `9${profileId}`,
  job_group_name: group,
  job_description: description,
  job_schedule_type: schedule,
});

/** Paged datanet_search + per-profile SQL, with a full call log. */
function fakeDatanet(config: { docs: SearchDoc[]; sqlById: Record<string, string>; searchError?: boolean }) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const call: EtlToolCall = async (toolName, args) => {
    calls.push({ tool: toolName, args: { ...args } });
    if (toolName === 'datanet_search') {
      if (config.searchError) return { isError: true, text: 'HTTP 500 — search down' };
      const start = Number(args.start ?? 0);
      const size = Number(args.size ?? 25);
      return {
        isError: false,
        text: JSON.stringify({
          found: config.docs.length,
          searchResults: config.docs.slice(start, start + size).map(document => ({ document })),
        }),
      };
    }
    if (toolName === 'datanet_get_profile_sql') {
      const sql = config.sqlById[String(args.profile_id)];
      if (sql === undefined) return { isError: true, text: 'profile not found' };
      return { isError: false, text: sql };
    }
    return { isError: true, text: `unexpected tool ${toolName}` };
  };
  return { call, calls };
}

/** Classification (json_object) vs synthesis (plain) discriminated fake LLM. */
function fakeLlm(handlers: {
  classify?: (input: { existingBusinesses: string[]; profiles: Array<{ id: string }> }) => Record<string, string>;
  synthesize?: (input: { business: string }) => string;
} = {}) {
  const requests: Array<{ kind: 'classify' | 'synthesize'; input: any }> = [];
  return {
    requests,
    chatCompletion: async (request: any) => {
      const input = JSON.parse(request.messages[1].content);
      if (request.responseFormat?.type === 'json_object') {
        requests.push({ kind: 'classify', input });
        if (!handlers.classify) throw new Error('LLM classification unavailable');
        const byId = handlers.classify(input);
        return {
          content: JSON.stringify({
            assignments: input.profiles.map((p: { id: string }) => ({ id: p.id, business: byId[p.id] ?? 'uncategorized' })),
          }),
        };
      }
      requests.push({ kind: 'synthesize', input });
      if (handlers.synthesize) return { content: handlers.synthesize(input) };
      return { content: `# ${input.business} — Datanet ETL SQL Context\n\n## Tables that matter\n(stub brief)` };
    },
  };
}

const FATAFAT_SQL = "/* NO DEPENDENCIES */\nCREATE TEMP TABLE stage AS SELECT * FROM andes.fatafat.orders WHERE event = 'order_placed' AND day = {RUN_DATE_YYYYMMDD};\nSELECT * FROM stage JOIN andes.fatafat.customers ON 1=1;";
const STREAM_SQL = "SELECT gaid FROM andes.stream.playback WHERE event = 'play_start';";

describe('etl-onboarding', () => {
  let storage: StorageLayer;
  let tmpDir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-onboarding-'));
    setSetting(storage.getDb(), ANALYTICS_CONTEXT_DIR_KEY, tmpDir);
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const db = () => storage.getDb();
  const makeService = (
    call: EtlToolCall,
    llm: { chatCompletion: (request: any) => Promise<{ content: string }> },
    overrides: Record<string, unknown> = {},
  ): EtlOnboardingService => createEtlOnboardingService({
    db: db(),
    call,
    llm: llm as any,
    pageSize: 2,
    fetchDelayMs: 0,
    classifyBatchSize: 10,
    minClusterSize: 2,
    sqlSampleChars: 500,
    synthesisMaxTokens: 200,
    ...overrides,
  });

  async function untilDone(service: EtlOnboardingService, timeoutMs = 5000) {
    const startedAt = Date.now();
    while (service.getStatus().state === 'running') {
      if (Date.now() - startedAt > timeoutMs) throw new Error('onboarding did not finish in time');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return service.getStatus();
  }

  it('runs end to end: own-group scope, two-pass clustering, code-appended inventory, manifest tags', async () => {
    const { call, calls } = fakeDatanet({
      docs: [
        doc('1', 'MY-GROUP', 'Fatafat daily orders rollup'),
        doc('2', 'MY-GROUP', 'fatafat weekly customers'),
        doc('3', 'MY-GROUP', 'Fatafat ad-hoc backfill', 'NOT_SCHEDULED'),
        doc('4', 'MY-GROUP', 'video streaming engagement rollup'),
        doc('5', 'MY-GROUP', 'playback funnel weekly'),
        doc('6', 'OTHER-GROUP', 'foreign team profile — must be dropped'),
      ],
      sqlById: { '1': FATAFAT_SQL, '2': FATAFAT_SQL, '3': FATAFAT_SQL, '4': STREAM_SQL, '5': STREAM_SQL, '6': 'SELECT 1;' },
    });
    const llm = fakeLlm({
      classify: () => ({ '4': 'streaming', '5': 'streaming' }),
    });
    const service = makeService(call, llm);
    service.start({ group: 'MY-GROUP' });
    const status = await untilDone(service);

    expect(status.state).toBe('completed');
    expect(status.lastResult?.group).toBe('MY-GROUP');
    // Foreign-group doc dropped BEFORE any fetch: 5 own-group profiles only.
    expect(status.lastResult?.profiles).toBe(5);
    expect(calls.filter(c => c.tool === 'datanet_get_profile_sql').map(c => c.args.profile_id)).not.toContain('6');
    expect(status.lastResult?.businesses?.sort()).toEqual(['fatafat', 'streaming']);
    expect(status.lastResult?.presetsWritten).toBe(2);

    // Pass 2 saw ONLY the profiles pass 1 could not place.
    expect(llm.requests.filter(r => r.kind === 'classify')).toHaveLength(1);
    expect(llm.requests[0].input.profiles.map((p: any) => p.id).sort()).toEqual(['4', '5']);

    // Preset = generated header + LLM body + CODE-appended inventory.
    const preset = fs.readFileSync(path.join(tmpDir, 'presets', 'fatafat.md'), 'utf8');
    expect(preset).toContain('Generated by BotBoy ETL onboarding');
    expect(preset).toContain('# fatafat — Datanet ETL SQL Context');
    expect(preset).toContain('## Profile inventory & reuse ladder');
    expect(preset).toContain('REUSE FIRST: scheduled');            // profiles 1, 2 (DAILY)
    expect(preset).toContain('| 3 | NOT_SCHEDULED |');             // and the reference verdict
    expect(preset).toContain('reference: read its SQL');
    expect(fs.existsSync(path.join(tmpDir, 'presets', 'streaming.md'))).toBe(true);

    // Manifest entries are etl-derived, keyed for routing, both lanes.
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'manifest.json'), 'utf8'));
    const fatafat = manifest.files.find((f: any) => f.file === 'presets/fatafat.md');
    expect(fatafat.source).toBe('etl-derived');
    expect(fatafat.appliesTo).toEqual(['mcp_etl_*', 'mcp_sql_*']);
    expect(fatafat.keywords).toContain('fatafat');
    expect(fatafat.keywords).toContain('orders');                  // top table short name
    expect(fatafat.corpusSize).toBe(3);

    // Result persisted for restarts.
    expect(getSetting(db(), 'etl.onboarding.last_result')).toMatchObject({ group: 'MY-GROUP', presetsWritten: 2 });
  });

  it('keyword pass is longest-seed-first: "prime video" wins over "prime"', async () => {
    const { call } = fakeDatanet({
      docs: [
        doc('1', 'G', 'prime video signups prime video weekly'),
        doc('2', 'G', 'prime video churn prime video monthly'),
      ],
      sqlById: { '1': 'SELECT 1;', '2': 'SELECT 2;' },
    });
    const llm = fakeLlm(); // must never be consulted — keyword pass covers all
    const service = makeService(call, llm);
    service.start({ group: 'G' });
    const status = await untilDone(service);
    expect(status.state).toBe('completed');
    expect(status.lastResult?.businesses).toEqual(['prime video']);
    expect(fs.existsSync(path.join(tmpDir, 'presets', 'prime-video.md'))).toBe(true);
    expect(llm.requests.filter(r => r.kind === 'classify')).toHaveLength(0);
  });

  it('resumes from disk: cached estate skips search, cached SQL files are not re-fetched', async () => {
    const workDir = path.join(tmpDir, '.onboarding');
    fs.mkdirSync(path.join(workDir, 'sql'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'estate.json'), JSON.stringify({
      group: 'MY-GROUP',
      profiles: [
        { profileId: '1', jobId: '91', description: 'fatafat orders', scheduleType: 'DAILY' },
        { profileId: '2', jobId: '92', description: 'fatafat customers', scheduleType: 'DAILY' },
        { profileId: '3', jobId: '93', description: 'fatafat refunds', scheduleType: 'DAILY' },
      ],
    }));
    fs.writeFileSync(path.join(workDir, 'sql', 'profile-1.txt'), FATAFAT_SQL); // already fetched

    const { call, calls } = fakeDatanet({ docs: [], sqlById: { '2': FATAFAT_SQL, '3': FATAFAT_SQL } });
    const service = makeService(call, fakeLlm());
    service.start({ group: 'MY-GROUP' });
    const status = await untilDone(service);

    expect(status.state).toBe('completed');
    expect(calls.filter(c => c.tool === 'datanet_search')).toHaveLength(0); // estate cache hit
    expect(calls.filter(c => c.tool === 'datanet_get_profile_sql').map(c => c.args.profile_id).sort()).toEqual(['2', '3']);
    expect(status.lastResult?.businesses).toEqual(['fatafat']);
  });

  it('degrades a failed LLM classification batch to uncategorized and still completes', async () => {
    const { call } = fakeDatanet({
      docs: [doc('1', 'G', 'mystery pipeline one'), doc('2', 'G', 'mystery pipeline two')],
      sqlById: { '1': 'SELECT 1;', '2': 'SELECT 2;' },
    });
    const service = makeService(call, fakeLlm()); // no classify handler → throws
    service.start({ group: 'G' });
    const status = await untilDone(service);
    expect(status.state).toBe('completed'); // zero breaks
    expect(status.lastResult?.uncategorized).toBe(2);
    expect(status.lastResult?.presetsWritten).toBe(0);
    expect(status.lastResult?.errors).toEqual([]);
  });

  it('merges the manifest without touching user-dropped entries; replaces stale etl-derived ones', async () => {
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({
      files: [
        { file: 'gaid-note.md', source: 'user-dropped', business: 'fatafat', note: 'owner wrote this' },
        { file: 'presets/fatafat.md', source: 'etl-derived', business: 'fatafat', derivedAt: '2026-01-01' },
      ],
    }));
    const { call } = fakeDatanet({
      docs: [doc('1', 'G', 'fatafat a'), doc('2', 'G', 'fatafat b')],
      sqlById: { '1': FATAFAT_SQL, '2': FATAFAT_SQL },
    });
    const service = makeService(call, fakeLlm());
    service.start({ group: 'G', regenerate: true }); // regenerate: fatafat already exists
    const status = await untilDone(service);
    expect(status.state).toBe('completed');

    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'manifest.json'), 'utf8'));
    const userEntry = manifest.files.find((f: any) => f.file === 'gaid-note.md');
    expect(userEntry).toMatchObject({ source: 'user-dropped', note: 'owner wrote this' }); // untouched
    const derived = manifest.files.filter((f: any) => f.file === 'presets/fatafat.md');
    expect(derived).toHaveLength(1);                       // stale entry replaced, not duplicated
    expect(derived[0].derivedAt).not.toBe('2026-01-01');
  });

  it('skips businesses that already have a generated preset unless regenerate is set', async () => {
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({
      files: [{ file: 'presets/fatafat.md', source: 'etl-derived', business: 'fatafat' }],
    }));
    const datanet = () => fakeDatanet({
      docs: [doc('1', 'G', 'fatafat a'), doc('2', 'G', 'fatafat b')],
      sqlById: { '1': FATAFAT_SQL, '2': FATAFAT_SQL },
    });

    const llmSkip = fakeLlm();
    const skipRun = makeService(datanet().call, llmSkip);
    skipRun.start({ group: 'G' });
    const skipped = await untilDone(skipRun);
    expect(skipped.state).toBe('completed');
    expect(skipped.lastResult?.skipped).toEqual(['fatafat']);
    expect(skipped.lastResult?.presetsWritten).toBe(0);
    expect(llmSkip.requests.filter(r => r.kind === 'synthesize')).toHaveLength(0);

    const llmRegen = fakeLlm();
    const regenRun = makeService(datanet().call, llmRegen);
    regenRun.start({ group: 'G', regenerate: true });
    const regenerated = await untilDone(regenRun);
    expect(regenerated.state).toBe('completed');
    expect(regenerated.lastResult?.businesses).toEqual(['fatafat']);
    expect(llmRegen.requests.filter(r => r.kind === 'synthesize')).toHaveLength(1);
  });

  it('targeted refresh regenerates ONLY the named business, in its manifest-owned file, from the cached corpus', async () => {
    // fatafat's generated brief lives under a non-slug file name (hand-seeded).
    fs.mkdirSync(path.join(tmpDir, 'presets'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'presets', 'fatafat-etl.md'), '# old brief\n');
    fs.writeFileSync(path.join(tmpDir, 'presets', 'membership.md'), '# old membership brief\n');
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({
      files: [
        { file: 'presets/fatafat-etl.md', source: 'etl-derived', business: 'fatafat' },
        { file: 'presets/membership.md', source: 'etl-derived', business: 'membership' },
      ],
    }));
    // Cached corpus on disk — a targeted refresh must not touch Datanet.
    const workDir = path.join(tmpDir, '.onboarding');
    fs.mkdirSync(path.join(workDir, 'sql'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'estate.json'), JSON.stringify({
      group: 'G',
      profiles: [
        { profileId: '1', description: 'fatafat a', scheduleType: 'DAILY' },
        { profileId: '2', description: 'fatafat b', scheduleType: 'DAILY' },
        { profileId: '3', description: 'membership x', scheduleType: 'DAILY' },
        { profileId: '4', description: 'membership y', scheduleType: 'DAILY' },
      ],
    }));
    const MEMBERSHIP_SQL = 'SELECT uuid FROM public.membership_summary WHERE day = 1;';
    for (const id of ['1', '2']) fs.writeFileSync(path.join(workDir, 'sql', `profile-${id}.txt`), FATAFAT_SQL);
    for (const id of ['3', '4']) fs.writeFileSync(path.join(workDir, 'sql', `profile-${id}.txt`), MEMBERSHIP_SQL);

    const { call, calls } = fakeDatanet({ docs: [], sqlById: {} });
    const llm = fakeLlm();
    const service = makeService(call, llm);
    service.start({ group: 'G', businesses: ['fatafat'] });
    const status = await untilDone(service);

    expect(status.state).toBe('completed');
    expect(status.lastResult?.businesses).toEqual(['fatafat']);
    expect(status.lastResult?.skipped).toContain('membership');
    expect(calls).toHaveLength(0); // fully served from the cached corpus
    // Refreshed IN PLACE at the manifest-owned file — no second fatafat file.
    expect(fs.readFileSync(path.join(tmpDir, 'presets', 'fatafat-etl.md'), 'utf8')).toContain('Generated by BotBoy ETL onboarding');
    expect(fs.existsSync(path.join(tmpDir, 'presets', 'fatafat.md'))).toBe(false);
    // The untargeted business file is untouched.
    expect(fs.readFileSync(path.join(tmpDir, 'presets', 'membership.md'), 'utf8')).toBe('# old membership brief\n');
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'manifest.json'), 'utf8'));
    expect(manifest.files.filter((f: any) => f.business === 'fatafat')).toHaveLength(1);
  });

  it('preset generation leaves lesson files and manifest entries untouched (separate knowledge lifecycles)', async () => {
    // An adopted lesson rendered before onboarding runs.
    fs.mkdirSync(path.join(tmpDir, 'lessons'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'lessons', 'ott.md'), '# Lessons — ott\n\nETLM rejects LIMIT.\n');
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({
      files: [{ file: 'lessons/ott.md', business: 'ott', source: 'lesson' }],
    }));
    const { call } = fakeDatanet({
      docs: [doc('1', 'G', 'fatafat a'), doc('2', 'G', 'fatafat b')],
      sqlById: { '1': FATAFAT_SQL, '2': FATAFAT_SQL },
    });
    const service = makeService(call, fakeLlm());
    service.start({ group: 'G' });
    const status = await untilDone(service);
    expect(status.state).toBe('completed');

    // Lesson file + entry survive; the generated preset entry joined them.
    expect(fs.readFileSync(path.join(tmpDir, 'lessons', 'ott.md'), 'utf8')).toContain('ETLM rejects LIMIT');
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'manifest.json'), 'utf8'));
    expect(manifest.files.find((f: any) => f.file === 'lessons/ott.md')).toMatchObject({ source: 'lesson' });
    expect(manifest.files.find((f: any) => f.file === 'presets/fatafat.md')).toBeDefined();
  });

  it('regenerate with a dead Datanet answer never clobbers the cached corpus (live 2026-09-04)', async () => {
    // Good cache from a previous successful run.
    const workDir = path.join(tmpDir, '.onboarding');
    fs.mkdirSync(path.join(workDir, 'sql'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'estate.json'), JSON.stringify({
      group: 'G',
      profiles: [{ profileId: '1', description: 'fatafat a', scheduleType: 'DAILY' }],
    }));
    fs.writeFileSync(path.join(workDir, 'sql', 'profile-1.txt'), 'SELECT 1;');
    // Datanet answers searches with nothing (dead VPN/Sentry session).
    const { call } = fakeDatanet({ docs: [], sqlById: {} });
    const service = makeService(call, fakeLlm());
    service.start({ group: 'G', regenerate: true });
    const status = await untilDone(service);

    expect(status.state).toBe('failed');
    expect(status.error).toContain('No profiles found');
    expect(status.nextAction).toContain('mwinit -o -s');
    expect(status.nextAction).toContain('left untouched');
    // The cache survived: estate still lists the profile, SQL still cached.
    const estate = JSON.parse(fs.readFileSync(path.join(workDir, 'estate.json'), 'utf8'));
    expect(estate.profiles).toHaveLength(1);
    expect(fs.readFileSync(path.join(workDir, 'sql', 'profile-1.txt'), 'utf8')).toBe('SELECT 1;');
  });

  it('regenerate still refuses to clobber an unowned user file sharing the slug', async () => {
    fs.mkdirSync(path.join(tmpDir, 'presets'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'presets', 'fatafat.md'), '# user file, not in manifest\n');
    const { call } = fakeDatanet({
      docs: [doc('1', 'G', 'fatafat a'), doc('2', 'G', 'fatafat b')],
      sqlById: { '1': FATAFAT_SQL, '2': FATAFAT_SQL },
    });
    const service = makeService(call, fakeLlm());
    service.start({ group: 'G', regenerate: true }); // the old code overwrote here
    const status = await untilDone(service);
    expect(status.state).toBe('completed');
    expect(fs.readFileSync(path.join(tmpDir, 'presets', 'fatafat.md'), 'utf8')).toBe('# user file, not in manifest\n');
    expect(fs.existsSync(path.join(tmpDir, 'presets', 'fatafat-generated.md'))).toBe(true);
  });

  it('parks thin clusters instead of writing noise presets', async () => {
    const { call } = fakeDatanet({
      docs: [doc('1', 'G', 'fatafat a'), doc('2', 'G', 'fatafat b'), doc('3', 'G', 'membership one-off')],
      sqlById: { '1': FATAFAT_SQL, '2': FATAFAT_SQL, '3': 'SELECT 3;' },
    });
    const service = makeService(call, fakeLlm());
    service.start({ group: 'G' });
    const status = await untilDone(service);
    expect(status.state).toBe('completed');
    expect(status.lastResult?.businesses).toEqual(['fatafat']);
    expect(status.lastResult?.thin).toEqual(['membership (1)']);
    expect(fs.existsSync(path.join(tmpDir, 'presets', 'membership.md'))).toBe(false);
  });

  it('never overwrites a user file that shares the slug — writes the -generated variant', async () => {
    fs.mkdirSync(path.join(tmpDir, 'presets'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'presets', 'fatafat.md'), '# The owner hand-wrote this brief\n');
    const { call } = fakeDatanet({
      docs: [doc('1', 'G', 'fatafat a'), doc('2', 'G', 'fatafat b')],
      sqlById: { '1': FATAFAT_SQL, '2': FATAFAT_SQL },
    });
    const service = makeService(call, fakeLlm());
    service.start({ group: 'G' });
    const status = await untilDone(service);
    expect(status.state).toBe('completed');
    expect(fs.readFileSync(path.join(tmpDir, 'presets', 'fatafat.md'), 'utf8'))
      .toBe('# The owner hand-wrote this brief\n');                 // untouched
    const generated = fs.readFileSync(path.join(tmpDir, 'presets', 'fatafat-generated.md'), 'utf8');
    expect(generated).toContain('Generated by BotBoy ETL onboarding');
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'manifest.json'), 'utf8'));
    expect(manifest.files[0].file).toBe('presets/fatafat-generated.md');
  });

  it('aggregates honestly: staging idioms split from real tables, IN-list events counted whole as families, regime filters counted', async () => {
    const sql = [
      '/* NO DEPENDENCIES */',
      'create temp table user_agg as (select uuid from public.online_content_watched_table_v2',
      "  where event in ('onlinePlayExited','onlineRecomPlayExited','downloadVideoPlayExited')",
      "  and countryname = 'India' and playtime not like '%E%'",
      "  and (type is null or type in ('player')));",
      'with cte_watch as (select * from user_agg)',
      'select * from cte_watch join daily_cms_data_table on 1=1;',
    ].join('\n');
    const { call } = fakeDatanet({
      docs: [doc('1', 'G', 'fatafat a'), doc('2', 'G', 'fatafat b')],
      sqlById: { '1': sql, '2': sql },
    });
    const llm = fakeLlm();
    const service = makeService(call, llm);
    service.start({ group: 'G' });
    const status = await untilDone(service);
    expect(status.state).toBe('completed');

    const synthesis = llm.requests.find(r => r.kind === 'synthesize');
    expect(synthesis).toBeDefined();
    const aggregates = synthesis!.input.aggregates;
    const tableNames = aggregates.topTables.map((t: any) => t.name);
    const stagingNames = aggregates.stagingIdioms.map((t: any) => t.name);
    // Real warehouse tables stay tables; profile-created names (temp + CTE) are staging.
    expect(tableNames).toContain('public.online_content_watched_table_v2');
    expect(tableNames).toContain('daily_cms_data_table');
    expect(tableNames).not.toContain('user_agg');
    expect(tableNames).not.toContain('cte_watch');
    expect(stagingNames).toContain('user_agg');
    expect(stagingNames).toContain('cte_watch');
    // Every IN-list literal counts, and the recurring list is a family.
    const eventNames = aggregates.topEvents.map((e: any) => e.name);
    expect(eventNames).toEqual(expect.arrayContaining(['onlinePlayExited', 'onlineRecomPlayExited', 'downloadVideoPlayExited']));
    expect(aggregates.eventFamilies[0]).toEqual({
      name: 'downloadVideoPlayExited + onlinePlayExited + onlineRecomPlayExited',
      profiles: 2,
    });
    // Measurement regimes counted.
    expect(aggregates.conventions.geoFilterIndia).toBe(2);
    expect(aggregates.conventions.playtimeCorruptionGuard).toBe(2);
    expect(aggregates.conventions.streamTypeGuard).toBe(2);
  });

  it('teaches column type traps: corpus-cast columns land as a code-appended section; mixed-usage columns and the LLM payload stay clean', async () => {
    // Live incident 2026-09-04: eventts is varchar — production always casts
    // it before date functions, the generated brief never said so, and two
    // dashboard widgets fed it raw into DATEADD (Redshift refused).
    const casterA = [
      'select cast(dateadd(minute,330,cast(eventts as timestamp)) as date) as report_date',
      'from public.events_v2 where eventts >= dateadd(minute,-330,current_date-28);',
    ].join('\n');
    const casterB = "select eventts::timestamp as ts, date_trunc('day', mixedcol) from public.events_v2;";
    const mixed = 'select cast(mixedcol as date) from public.events_v2;';
    const { call } = fakeDatanet({
      docs: [doc('1', 'G', 'fatafat a'), doc('2', 'G', 'fatafat b'), doc('3', 'G', 'fatafat c')],
      sqlById: { '1': casterA, '2': casterB, '3': mixed },
    });
    const llm = fakeLlm();
    const service = makeService(call, llm);
    service.start({ group: 'G' });
    const status = await untilDone(service);
    expect(status.state).toBe('completed');

    // The LLM payload must NOT carry the trap table — code appends it verbatim
    // with exact corpus counts (paraphrase risk is the reason).
    const synthesis = llm.requests.find(r => r.kind === 'synthesize');
    expect(synthesis).toBeDefined();
    expect(synthesis!.input.aggregates.castDisciplines).toBeUndefined();

    const preset = fs.readFileSync(path.join(tmpDir, 'presets', 'fatafat.md'), 'utf8');
    expect(preset).toContain('## Column type traps (corpus-verified)');
    // eventts: cast in 2 profiles (both idioms shown), never raw → a trap row.
    expect(preset).toMatch(/\| eventts \| 2 \| .*CAST\(eventts AS TIMESTAMP\).*eventts::timestamp.* \| 0 \|/);
    // mixedcol: cast once, used raw once (date_trunc) — mixed usage must NOT
    // be taught as a discipline.
    expect(preset).not.toMatch(/\| mixedcol \|/);
  });

  it('keeps writing other briefs when one synthesis fails, and reports the error', async () => {
    const { call } = fakeDatanet({
      docs: [doc('1', 'G', 'fatafat a'), doc('2', 'G', 'fatafat b'), doc('3', 'G', 'ott x'), doc('4', 'G', 'ott y')],
      sqlById: { '1': FATAFAT_SQL, '2': FATAFAT_SQL, '3': STREAM_SQL, '4': STREAM_SQL },
    });
    const llm = fakeLlm({
      synthesize: ({ business }) => {
        if (business === 'ott') return 'not markdown at all'; // triggers the guard
        return `# ${business} — Datanet ETL SQL Context\n\n## Tables that matter\nok`;
      },
    });
    const service = makeService(call, llm);
    service.start({ group: 'G' });
    const status = await untilDone(service);
    expect(status.state).toBe('completed');
    expect(status.lastResult?.businesses).toEqual(['fatafat']);
    expect(status.lastResult?.errors).toHaveLength(1);
    expect(status.lastResult?.errors?.[0]).toContain('ott');
    expect(fs.existsSync(path.join(tmpDir, 'presets', 'ott.md'))).toBe(false);
  });

  it('fails with a next action when the estate comes back empty for the given group', async () => {
    const { call } = fakeDatanet({ docs: [], sqlById: {}, searchError: true });
    const service = makeService(call, fakeLlm());
    service.start({ group: 'TYPO-GROUP' });
    const status = await untilDone(service);
    expect(status.state).toBe('failed');
    expect(status.error).toContain('No profiles found');
    expect(status.nextAction).toContain('group parameter');
  });

  it('discovers the group from the cached ad-hoc environment when none is given', async () => {
    setSetting(db(), 'etl.adhoc.env', { group: 'MY-GROUP' });
    const { call, calls } = fakeDatanet({
      docs: [doc('1', 'MY-GROUP', 'fatafat a'), doc('2', 'MY-GROUP', 'fatafat b')],
      sqlById: { '1': FATAFAT_SQL, '2': FATAFAT_SQL },
    });
    const service = makeService(call, fakeLlm());
    service.start(); // no group parameter
    const status = await untilDone(service);
    expect(status.state).toBe('completed');
    expect(status.group).toBe('MY-GROUP');
    expect(calls.find(c => c.tool === 'datanet_search')?.args.query).toBe('MY-GROUP');
  });

  it('start() is idempotent: a second start during a run reports progress instead of forking', async () => {
    let releaseSearch: () => void = () => {};
    const gate = new Promise<void>(resolve => { releaseSearch = resolve; });
    const inner = fakeDatanet({
      docs: [doc('1', 'G', 'fatafat a'), doc('2', 'G', 'fatafat b')],
      sqlById: { '1': FATAFAT_SQL, '2': FATAFAT_SQL },
    });
    const gatedCall: EtlToolCall = async (toolName, args, opts) => {
      if (toolName === 'datanet_search') await gate;
      return inner.call(toolName, args, opts);
    };
    const service = makeService(gatedCall, fakeLlm());
    const first = service.start({ group: 'G' });
    expect(first.state).toBe('running');
    const second = service.start({ group: 'G' });
    expect(second.state).toBe('running'); // no second run forked
    releaseSearch();
    const status = await untilDone(service);
    expect(status.state).toBe('completed');
    expect(inner.calls.filter(c => c.tool === 'datanet_search' && c.args.start === 0)).toHaveLength(1);
  });
});
