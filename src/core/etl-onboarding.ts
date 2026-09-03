/**
 * ETL onboarding (etl-analytics A3) — autonomous business-preset generation.
 *
 * The user job: after connecting Datanet ETL, BotBoy builds an understanding
 * of the team's WHOLE profile estate — what each profile is FOR — clusters
 * them by business/feature, and writes one zero-context knowledge preset per
 * business into the analytics knowledge directory (A2). From then on, a data
 * question routes to the right preset and a reuse-or-create decision with no
 * discovery calls.
 *
 * Owner decisions (2026-09-03): discovery is scoped to the USER'S OWN GROUP
 * (Datanet search/reads are technically global; foreign estates are noise
 * and a courtesy line), and refresh is MANUAL ONLY (regenerate flag).
 *
 * Framework shape (practical-agent steering): deterministic work in code
 * (enumeration, SQL collection, keyword clustering, aggregation counters,
 * inventory tables, manifest writes), LLM only where judgment lives
 * (pass-2 purpose classification, brief synthesis). Zero manual inputs and
 * zero breaks: every per-item failure degrades to the `uncategorized`
 * bucket or an error count — nothing stops the run. Resumable: the estate,
 * fetched SQL, and cluster assignments persist under
 * `<knowledge dir>/.onboarding/`; a restarted run skips completed work.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getSetting, setSetting } from './storage.js';
import { resolveOwnerIdentity } from './owner-identity.js';
import { resolveAnalyticsContextDir } from './analytics-context.js';
import type { EtlToolCall } from './etl-adhoc.js';

export interface EtlOnboardingStatus {
  state: 'idle' | 'running' | 'completed' | 'failed';
  phase?: 'discover' | 'enumerate' | 'fetch' | 'cluster' | 'synthesize';
  group?: string;
  progress?: {
    profilesTotal?: number;
    profilesFetched?: number;
    businessesTotal?: number;
    businessesDone?: number;
    currentBusiness?: string;
  };
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  nextAction?: string;
  lastResult?: EtlOnboardingResult;
}

export interface EtlOnboardingResult {
  group: string;
  profiles: number;
  businesses: string[];
  skipped: string[];
  thin: string[];
  uncategorized: number;
  presetsWritten: number;
  errors: string[];
  finishedAt: string;
}

export interface EtlOnboardingService {
  /** Idempotent: starts a run, or reports the one already in flight.
   * `businesses` = targeted refresh: regenerate ONLY those (others skipped). */
  start(options?: { group?: string; regenerate?: boolean; businesses?: string[] }): EtlOnboardingStatus;
  getStatus(): EtlOnboardingStatus;
}

interface EstateProfile {
  profileId: string;
  jobId?: string;
  description: string;
  scheduleType: string;
}

interface LlmLike {
  chatCompletion(request: {
    messages: Array<{ role: 'system' | 'user'; content: string }>;
    temperature?: number;
    maxTokens?: number;
    responseFormat?: { type: 'json_object' };
    think?: boolean;
  }): Promise<{ content: string }>;
}

export interface EtlOnboardingOptions {
  db: Database.Database;
  call: EtlToolCall;
  llm: LlmLike;
  /** Injectables for tests. */
  pageSize?: number;
  fetchDelayMs?: number;
  classifyBatchSize?: number;
  minClusterSize?: number;
  maxProfiles?: number;
  sqlSampleChars?: number;
  synthesisMaxTokens?: number;
  now?: () => number;
}

const LAST_RESULT_KEY = 'etl.onboarding.last_result';
const BUSINESS_SEEDS_KEY = 'etl.onboarding.businesses';
const DEFAULT_BUSINESS_SEEDS = ['fatafat', 'ott', 'local', 'membership', 'prime video', 'prime'];

const parseJson = (text: string): Record<string, any> => {
  try { return JSON.parse(text) as Record<string, any>; } catch { return {}; }
};

const slugOf = (business: string): string =>
  business.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'business';

export function createEtlOnboardingService(options: EtlOnboardingOptions): EtlOnboardingService {
  const { db, call, llm } = options;
  const pageSize = options.pageSize ?? 25;
  const fetchDelayMs = options.fetchDelayMs ?? 300;
  const classifyBatchSize = options.classifyBatchSize ?? 25;
  const minClusterSize = options.minClusterSize ?? 3;
  const maxProfiles = options.maxProfiles ?? 400;
  const sqlSampleChars = options.sqlSampleChars ?? 3000;
  const synthesisMaxTokens = options.synthesisMaxTokens ?? 8000;
  const now = options.now ?? Date.now;
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  let running = false;
  let status: EtlOnboardingStatus = {
    state: 'idle',
    lastResult: getSetting<EtlOnboardingResult>(db, LAST_RESULT_KEY) ?? undefined,
  };

  const workDir = () => path.join(resolveAnalyticsContextDir(db), '.onboarding');
  const sqlDir = () => path.join(workDir(), 'sql');
  const knowledgeDir = () => resolveAnalyticsContextDir(db);

  function update(next: Partial<EtlOnboardingStatus>): void {
    status = { ...status, ...next, progress: { ...status.progress, ...next.progress } };
  }

  // ── phase: discover the user's group ──────────────────────────────────────
  async function discoverGroup(explicit?: string): Promise<string | { error: string; nextAction: string }> {
    const given = (explicit ?? '').trim();
    if (given) return given;
    const cachedEnv = getSetting<{ group?: string }>(db, 'etl.adhoc.env');
    if (cachedEnv?.group) return cachedEnv.group;
    const identity = resolveOwnerIdentity(db);
    const alias = (identity.alias || '').trim();
    if (alias) {
      const result = await call('datanet_search', { query: alias, size: 25 });
      if (!result.isError) {
        const docs: Array<Record<string, any>> = (parseJson(result.text).searchResults ?? [])
          .map((r: any) => r?.document ?? {});
        const tally = new Map<string, number>();
        for (const doc of docs) {
          const group = String(doc.job_group_name ?? '').trim();
          if (group) tally.set(group, (tally.get(group) ?? 0) + 1);
        }
        const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
        if (best) return best[0];
      }
    }
    return {
      error: 'Could not determine the user\'s Datanet group (no cached environment and no Datanet footprint for their alias).',
      nextAction: 'Ask the user for their team\'s Datanet GROUP NAME (visible on any of the team\'s DataCentral job pages), then start again with the group parameter.',
    };
  }

  // ── phase: enumerate the own-group estate ─────────────────────────────────
  async function enumerateEstate(group: string): Promise<EstateProfile[]> {
    const estatePath = path.join(workDir(), 'estate.json');
    try {
      const cached = JSON.parse(fs.readFileSync(estatePath, 'utf8')) as { group: string; profiles: EstateProfile[] };
      if (cached.group === group && Array.isArray(cached.profiles) && cached.profiles.length > 0) return cached.profiles;
    } catch { /* no cache — enumerate */ }

    const byProfile = new Map<string, EstateProfile>();
    let start = 0;
    let found = Number.POSITIVE_INFINITY;
    while (start < found && byProfile.size < maxProfiles) {
      const page = await call('datanet_search', { query: group, size: pageSize, start });
      if (page.isError) break; // partial estate beats a dead run; count reflects reality
      const parsed = parseJson(page.text);
      found = Number(parsed.found ?? 0);
      const docs: Array<Record<string, any>> = (parsed.searchResults ?? []).map((r: any) => r?.document ?? {});
      if (docs.length === 0) break;
      for (const doc of docs) {
        // OWN-GROUP SCOPE (owner decision): search matches globally; keep
        // only documents whose job group IS the user's group.
        if (String(doc.job_group_name ?? '').trim() !== group) continue;
        const profileId = String(doc.profile_id ?? '').trim();
        if (!/^\d+$/.test(profileId) || byProfile.has(profileId)) continue;
        byProfile.set(profileId, {
          profileId,
          jobId: String(doc.job_id ?? '').trim() || undefined,
          description: String(doc.job_description ?? doc.description ?? '').trim(),
          scheduleType: String(doc.job_schedule_type ?? '').trim() || 'UNKNOWN',
        });
      }
      start += pageSize;
    }
    const profiles = [...byProfile.values()];
    fs.mkdirSync(workDir(), { recursive: true });
    fs.writeFileSync(estatePath, JSON.stringify({ group, enumeratedAt: new Date(now()).toISOString(), profiles }, null, 1));
    return profiles;
  }

  // ── phase: fetch every profile's SQL (disk-cached, resumable) ─────────────
  async function fetchSql(profiles: EstateProfile[]): Promise<Map<string, string>> {
    fs.mkdirSync(sqlDir(), { recursive: true });
    const sqlByProfile = new Map<string, string>();
    let fetched = 0;
    for (const profile of profiles) {
      const file = path.join(sqlDir(), `profile-${profile.profileId}.txt`);
      let sql: string | null = null;
      try { sql = fs.readFileSync(file, 'utf8'); } catch { /* not cached yet */ }
      if (sql === null) {
        const result = await call('datanet_get_profile_sql', { profile_id: profile.profileId });
        sql = result.isError ? '' : result.text;
        fs.writeFileSync(file, sql);
        if (fetchDelayMs > 0) await sleep(fetchDelayMs);
      }
      if (sql.trim().length > 0) sqlByProfile.set(profile.profileId, sql);
      fetched += 1;
      if (fetched % 10 === 0 || fetched === profiles.length) {
        update({ progress: { profilesFetched: fetched, profilesTotal: profiles.length } });
      }
    }
    return sqlByProfile;
  }

  // ── phase: cluster (pass 1 keywords, pass 2 LLM judgment) ─────────────────
  function keywordPass(profiles: EstateProfile[], sqlByProfile: Map<string, string>, seeds: string[]): Map<string, string> {
    const assignments = new Map<string, string>();
    const ordered = [...seeds].sort((a, b) => b.length - a.length); // longest first: "prime video" beats "prime"
    for (const profile of profiles) {
      const haystack = `${profile.description}\n${(sqlByProfile.get(profile.profileId) ?? '').slice(0, 4000)}`.toLowerCase();
      let best = '';
      let bestScore = 0;
      for (const seed of ordered) {
        const score = haystack.split(seed.toLowerCase()).length - 1;
        if (score > bestScore) { best = seed; bestScore = score; }
      }
      if (best) assignments.set(profile.profileId, best);
    }
    return assignments;
  }

  async function llmPass(
    unassigned: EstateProfile[],
    sqlByProfile: Map<string, string>,
    knownBusinesses: string[],
    assignments: Map<string, string>,
  ): Promise<void> {
    for (let index = 0; index < unassigned.length; index += classifyBatchSize) {
      const batch = unassigned.slice(index, index + classifyBatchSize);
      const items = batch.map(profile => ({
        id: profile.profileId,
        description: profile.description.slice(0, 240),
        sqlHead: (sqlByProfile.get(profile.profileId) ?? '').slice(0, 300),
      }));
      try {
        const response = await llm.chatCompletion({
          messages: [
            {
              role: 'system',
              content: 'You classify a team\'s data-engineering (Datanet ETL) profiles by the business, feature, or experience they serve. '
                + 'Reuse an existing business name whenever it fits. Introduce a NEW short lowercase name only for a clearly recurring theme. '
                + 'Use "uncategorized" when the purpose is unclear or one-off. '
                + 'Respond with JSON only: {"assignments":[{"id":"<profile id>","business":"<name>"}]} covering every input id.',
            },
            {
              role: 'user',
              content: JSON.stringify({ existingBusinesses: knownBusinesses, profiles: items }),
            },
          ],
          temperature: 0.1,
          maxTokens: 2000,
          responseFormat: { type: 'json_object' },
          think: false,
        });
        const parsed = parseJson(response.content);
        const list: Array<Record<string, any>> = Array.isArray(parsed.assignments) ? parsed.assignments : [];
        const byId = new Map(list.map(entry => [String(entry.id ?? ''), String(entry.business ?? '').trim().toLowerCase()]));
        for (const profile of batch) {
          const business = byId.get(profile.profileId);
          assignments.set(profile.profileId, business && business !== '' ? business : 'uncategorized');
        }
      } catch (error) {
        // Zero breaks: a failed judgment batch degrades to uncategorized.
        console.log(`[EtlOnboarding] classification batch failed (${String((error as Error)?.message ?? error).slice(0, 120)}) — ${batch.length} profiles → uncategorized`);
        for (const profile of batch) assignments.set(profile.profileId, 'uncategorized');
      }
    }
  }

  // ── phase: aggregate one cluster (deterministic counters) ─────────────────
  // Validation fixes (2026-09-03 cross-engine check, see etl-analytics.md):
  // 1. Names created INSIDE a profile (temp tables, CTEs) are staging idioms,
  //    not queryable warehouse tables — count them separately so the brief
  //    never presents them as tables an agent could query.
  // 2. `event IN ('a','b','c')` lists: every literal counts (the old regex
  //    took only the first — onlineRecomPlayExited sat in 122 profiles'
  //    IN-lists yet never surfaced). Recurring lists are counted whole as
  //    event FAMILIES: they are the actual unit of measurement.
  // 3. Recurring WHERE regimes (geo filter, playtime corruption guards, type
  //    guards) are counted — omitting them changed a real day's watchtime 2.9x.
  function aggregate(clusterSql: string[]): Record<string, unknown> {
    const stripped = clusterSql.map(sql => sql.replace(/--[^\n]*/g, ' '));
    const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
    const tables = new Map<string, number>();
    const staging = new Map<string, number>();
    const events = new Map<string, number>();
    const eventFamilies = new Map<string, number>();
    let noDeps = 0; let etlm = 0; let runDate = 0; let tempTables = 0;
    let geoFilter = 0; let playtimeGuard = 0; let typeGuard = 0;
    for (const sql of stripped) {
      // Names this profile creates itself: CREATE [TEMP] TABLE + WITH-clause CTEs.
      const internal = new Set<string>();
      for (const match of sql.matchAll(/\bcreate\s+(?:temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?([a-z_][\w]*)/gi)) {
        internal.add(match[1].toLowerCase());
      }
      for (const match of sql.matchAll(/(?:\bwith|,)\s+([a-z_][\w]*)\s+as\s*\(/gi)) {
        internal.add(match[1].toLowerCase());
      }
      const seenTables = new Set<string>();
      for (const match of sql.matchAll(/\b(?:from|join)\s+([a-z_][\w.]*)/gi)) {
        const table = match[1].toLowerCase();
        if (seenTables.has(table)) continue;
        seenTables.add(table);
        count(internal.has(table) ? staging : tables, table);
      }
      const seenEvents = new Set<string>();
      const noteEvent = (name: string) => {
        if (!seenEvents.has(name)) { seenEvents.add(name); count(events, name); }
      };
      for (const match of sql.matchAll(/\bevent\s*=\s*'([^']+)'/gi)) noteEvent(match[1]);
      for (const match of sql.matchAll(/\bevent\s+in\s*\(([^)]*)\)/gi)) {
        const members = [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
        for (const member of members) noteEvent(member);
        if (members.length > 1) count(eventFamilies, [...new Set(members)].sort().join(' + '));
      }
      if (/\/\*\s*no dependencies/i.test(sql)) noDeps += 1;
      if (/\/\*\+?\s*etlm/i.test(sql)) etlm += 1;
      if (/\{RUN_DATE_YYYYMMDD\}/.test(sql)) runDate += 1;
      if (/create\s+temp(orary)?\s+table/i.test(sql)) tempTables += 1;
      if (/countryname\s*=\s*'India'/i.test(sql)) geoFilter += 1;
      if (/playtime\s+not\s+like\s+'%E%'/i.test(sql) || /86400000/.test(sql)) playtimeGuard += 1;
      if (/\btype\s+in\s*\(/i.test(sql) || /\btype\s+is\s+null/i.test(sql)) typeGuard += 1;
    }
    const top = (map: Map<string, number>, n: number) =>
      [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, uses]) => ({ name, profiles: uses }));
    return {
      profilesWithSql: clusterSql.length,
      topTables: top(tables, 15),
      stagingIdioms: top(staging, 8),
      topEvents: top(events, 20),
      eventFamilies: top(eventFamilies, 6),
      conventions: {
        noDependenciesHeader: noDeps,
        etlmDependencyHeader: etlm,
        runDateTemplating: runDate,
        tempTableStaging: tempTables,
        geoFilterIndia: geoFilter,
        playtimeCorruptionGuard: playtimeGuard,
        streamTypeGuard: typeGuard,
      },
    };
  }

  // ── phase: synthesize one business brief ──────────────────────────────────
  const SYNTHESIS_SYSTEM = `You write a ZERO-PRIOR-CONTEXT knowledge brief for one business domain, derived from a team's production Datanet ETL SQL corpus. The reader is an AI agent that must write first-try-valid, metric-correct SQL for this domain without any discovery queries.

Write markdown with EXACTLY these sections, in order:
1. "# <Business> — Datanet ETL SQL Context" with a one-line purpose and a provenance line (corpus size, derived date given in the input).
2. "## Tables that matter" — a table of the top tables with their corpus profile-counts and what each appears to be for (infer roles ONLY from the provided SQL samples and names; mark inferences [UNVERIFIED]). The input's stagingIdioms are NOT tables: they are names profiles create internally (temp tables/CTEs). If any are present, add a short "Staging idioms (not queryable)" note listing them — an agent must NEVER select from these directly.
3. "## Event vocabulary" — the top events with counts and, where the samples make it clear, what they mean; otherwise list name+count only. The input's eventFamilies are recurring event IN-lists: when a family recurs, present it as the UNIT OF MEASUREMENT (profiles sum these events together — using one member alone undercounts the metric). Lead with families, then singles.
4. "## Canonical recipes" — 1-3 copy-paste SQL shapes taken FROM THE PROVIDED SAMPLES (simplified, never invented). State what each computes.
5. "## Conventions and gotchas" — dependency headers, run-date templating, staging style, and the measurement regimes (geo filter, playtime corruption guards, stream-type guards) with their convention counts: when a large share of the corpus applies a filter, say plainly that omitting it changes results and it should be treated as required.
6. "## What this brief cannot know" — honest limits: usage-derived columns, thin evidence, where to cross-check.

Rules: attach the given corpus counts inline to claims; use confidence tags [STRONG] (many profiles agree) / [SINGLE-SOURCE] / [UNVERIFIED]; NEVER invent tables, columns, or events not present in the input; do NOT write a profile-inventory section (it is appended by code). Keep it under 200 lines.`;

  async function synthesize(
    business: string,
    clusterProfiles: EstateProfile[],
    sqlByProfile: Map<string, string>,
    group: string,
  ): Promise<string> {
    const clusterSql = clusterProfiles
      .map(profile => sqlByProfile.get(profile.profileId) ?? '')
      .filter(sql => sql.trim().length > 0);
    const aggregates = aggregate(clusterSql);
    const samples = clusterProfiles
      .filter(profile => (sqlByProfile.get(profile.profileId) ?? '').trim().length > 0)
      .sort((a, b) => {
        const aScheduled = a.scheduleType !== 'NOT_SCHEDULED' ? 1 : 0;
        const bScheduled = b.scheduleType !== 'NOT_SCHEDULED' ? 1 : 0;
        if (aScheduled !== bScheduled) return bScheduled - aScheduled;
        return (sqlByProfile.get(b.profileId)?.length ?? 0) - (sqlByProfile.get(a.profileId)?.length ?? 0);
      })
      .slice(0, 4)
      .map(profile => ({
        profileId: profile.profileId,
        scheduleType: profile.scheduleType,
        description: profile.description.slice(0, 160),
        sql: (sqlByProfile.get(profile.profileId) ?? '').slice(0, sqlSampleChars),
      }));

    const response = await llm.chatCompletion({
      messages: [
        { role: 'system', content: SYNTHESIS_SYSTEM },
        {
          role: 'user',
          content: JSON.stringify({
            business,
            group,
            derivedAt: new Date(now()).toISOString().slice(0, 10),
            corpusSize: clusterProfiles.length,
            aggregates,
            samples,
          }),
        },
      ],
      temperature: 0.2,
      maxTokens: synthesisMaxTokens,
      think: false,
    });
    const body = response.content.trim();
    if (!body.startsWith('#')) throw new Error('synthesis did not return a markdown brief');

    // The inventory is APPENDED BY CODE — exact ids and reuse verdicts are
    // facts, not prose (reuse-first ladder, owner directive).
    const inventoryRows = clusterProfiles
      .sort((a, b) => (a.scheduleType === 'NOT_SCHEDULED' ? 1 : 0) - (b.scheduleType === 'NOT_SCHEDULED' ? 1 : 0))
      .map(profile => {
        const verdict = profile.scheduleType !== 'NOT_SCHEDULED' && profile.scheduleType !== 'UNKNOWN'
          ? 'REUSE FIRST: scheduled — fetch its latest run results before computing anything'
          : 'reference: read its SQL to ground new queries; resubmit its job for fresh data';
        return `| ${profile.profileId} | ${profile.scheduleType} | ${profile.description.slice(0, 80).replace(/\|/g, '/') || '(no description)'} | ${verdict} |`;
      });
    const inventory = [
      '',
      '## Profile inventory & reuse ladder',
      '',
      'FIRST decision on any data ask: does a profile below already answer it?',
      'Scheduled profiles ⇒ download latest results (`mcp_etl_latest_run` → `mcp_etl_download_results`).',
      'Fits but stale ⇒ resubmit its job. Only then write fresh SQL (`mcp_etl_run_query`).',
      '',
      '| Profile | Schedule | Description | Reuse verdict |',
      '|---|---|---|---|',
      ...inventoryRows,
      '',
    ].join('\n');
    return `${body}\n${inventory}`;
  }

  // ── manifest merge (never touches user-dropped entries) ───────────────────
  function mergeManifest(entries: Array<Record<string, unknown>>): void {
    const manifestPath = path.join(knowledgeDir(), 'manifest.json');
    let existing: Array<Record<string, unknown>> = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { files?: Array<Record<string, unknown>> };
      existing = Array.isArray(parsed.files) ? parsed.files : [];
    } catch { /* fresh manifest */ }
    const replacedFiles = new Set(entries.map(entry => String(entry.file)));
    const kept = existing.filter(entry => !(entry.source === 'etl-derived' && replacedFiles.has(String(entry.file))));
    fs.writeFileSync(manifestPath, JSON.stringify({ files: [...kept, ...entries] }, null, 1));
  }

  /** The manifest is the ledger of which FILE we own per generated business —
   * regeneration refreshes that file in place (one file per domain, even when
   * its name differs from the slug, e.g. a hand-seeded `fatafat-etl.md`). */
  function generatedFileByBusiness(): Map<string, string> {
    const manifestPath = path.join(knowledgeDir(), 'manifest.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { files?: Array<Record<string, unknown>> };
      const byBusiness = new Map<string, string>();
      for (const entry of parsed.files ?? []) {
        if (entry.source === 'etl-derived' && typeof entry.business === 'string' && typeof entry.file === 'string') {
          byBusiness.set(entry.business.toLowerCase(), entry.file);
        }
      }
      return byBusiness;
    } catch {
      return new Map();
    }
  }

  // ── the run loop ───────────────────────────────────────────────────────────
  async function run(optionsIn: { group?: string; regenerate?: boolean; businesses?: string[] }): Promise<void> {
    const regenerate = optionsIn.regenerate === true;
    try {
      if (regenerate) fs.rmSync(workDir(), { recursive: true, force: true });

      update({ phase: 'discover' });
      const group = await discoverGroup(optionsIn.group);
      if (typeof group !== 'string') {
        update({ state: 'failed', error: group.error, nextAction: group.nextAction, finishedAt: new Date(now()).toISOString() });
        return;
      }
      update({ group, phase: 'enumerate' });

      const profiles = await enumerateEstate(group);
      if (profiles.length === 0) {
        update({
          state: 'failed',
          error: `No profiles found for group "${group}".`,
          nextAction: 'Confirm the group name on a DataCentral job page and start again with the group parameter.',
          finishedAt: new Date(now()).toISOString(),
        });
        return;
      }
      update({ phase: 'fetch', progress: { profilesTotal: profiles.length, profilesFetched: 0 } });
      const sqlByProfile = await fetchSql(profiles);

      update({ phase: 'cluster' });
      const seeds = getSetting<string[]>(db, BUSINESS_SEEDS_KEY) ?? DEFAULT_BUSINESS_SEEDS;
      const assignments = keywordPass(profiles, sqlByProfile, seeds);
      const unassigned = profiles.filter(profile => !assignments.has(profile.profileId));
      await llmPass(unassigned, sqlByProfile, [...new Set([...seeds, ...assignments.values()])], assignments);
      fs.writeFileSync(path.join(workDir(), 'clusters.json'), JSON.stringify(
        { decidedAt: new Date(now()).toISOString(), assignments: Object.fromEntries(assignments) }, null, 1,
      ));

      const clusters = new Map<string, EstateProfile[]>();
      for (const profile of profiles) {
        const business = (assignments.get(profile.profileId) ?? 'uncategorized').toLowerCase();
        const list = clusters.get(business);
        if (list) list.push(profile); else clusters.set(business, [profile]);
      }
      const uncategorized = clusters.get('uncategorized')?.length ?? 0;
      clusters.delete('uncategorized');

      const ownedFiles = generatedFileByBusiness();
      // Optional targeted refresh: regenerate ONLY the named businesses
      // (implies regenerate for them; everything else is skipped untouched).
      const only = (optionsIn.businesses ?? []).map(b => b.toLowerCase().trim()).filter(Boolean);
      const skipped: string[] = [];
      const thin: string[] = [];
      const targets: Array<[string, EstateProfile[]]> = [];
      for (const [business, members] of clusters) {
        if (members.length < minClusterSize) { thin.push(`${business} (${members.length})`); continue; }
        if (only.length > 0) {
          if (!only.includes(business)) { skipped.push(business); continue; }
        } else if (!regenerate && ownedFiles.has(business)) { skipped.push(business); continue; }
        targets.push([business, members]);
      }

      update({ phase: 'synthesize', progress: { businessesTotal: targets.length, businessesDone: 0 } });
      const written: string[] = [];
      const errors: string[] = [];
      const manifestEntries: Array<Record<string, unknown>> = [];
      const presetsDir = path.join(knowledgeDir(), 'presets');
      fs.mkdirSync(presetsDir, { recursive: true });
      let done = 0;
      for (const [business, members] of targets) {
        update({ progress: { currentBusiness: business } });
        try {
          const brief = await synthesize(business, members, sqlByProfile, group);
          const clusterAggregates = aggregate(members.map(p => sqlByProfile.get(p.profileId) ?? '').filter(s => s.trim()));
          const topTables = (clusterAggregates.topTables as Array<{ name: string }>).slice(0, 5)
            .map(table => table.name.split('.').pop() ?? table.name);
          const topEvents = (clusterAggregates.topEvents as Array<{ name: string }>).slice(0, 5).map(event => event.name.toLowerCase());
          // Regeneration refreshes the file this business already owns per
          // the manifest ledger (one file per domain, even when its name is
          // not the slug). A file we do NOT own is never overwritten — a
          // user's own file sharing the slug gets the -generated variant.
          // (Validation fix 2026-09-03: the old check skipped the collision
          // guard under regenerate, which could clobber a user file.)
          let fileName = ownedFiles.get(business) ?? `presets/${slugOf(business)}.md`;
          if (!ownedFiles.has(business) && fs.existsSync(path.join(knowledgeDir(), fileName))) {
            fileName = `presets/${slugOf(business)}-generated.md`;
          }
          const header = `<!-- Generated by BotBoy ETL onboarding on ${new Date(now()).toISOString().slice(0, 10)} — group ${group}, ${members.length} profiles. Manual refresh: regenerate from the Datanet ETL connection page. -->\n\n`;
          fs.writeFileSync(path.join(knowledgeDir(), fileName), `${header}${brief}`);
          manifestEntries.push({
            file: fileName,
            business,
            keywords: [...new Set([business, ...business.split(/\s+/), ...topTables, ...topEvents])].slice(0, 12),
            source: 'etl-derived',
            appliesTo: ['mcp_etl_*', 'mcp_sql_*'],
            derivedAt: new Date(now()).toISOString().slice(0, 10),
            corpusSize: members.length,
          });
          written.push(business);
        } catch (error) {
          errors.push(`${business}: ${String((error as Error)?.message ?? error).slice(0, 160)}`);
        }
        done += 1;
        update({ progress: { businessesDone: done } });
      }
      if (manifestEntries.length > 0) mergeManifest(manifestEntries);

      const result: EtlOnboardingResult = {
        group,
        profiles: profiles.length,
        businesses: written,
        skipped,
        thin,
        uncategorized,
        presetsWritten: manifestEntries.length,
        errors,
        finishedAt: new Date(now()).toISOString(),
      };
      setSetting(db, LAST_RESULT_KEY, result);
      update({ state: 'completed', finishedAt: result.finishedAt, lastResult: result, progress: { currentBusiness: undefined } });
      console.log(`[EtlOnboarding] completed for ${group}: ${written.length} presets (${written.join(', ') || 'none'}), ${skipped.length} skipped, ${uncategorized} uncategorized`);
    } catch (error) {
      update({
        state: 'failed',
        error: String((error as Error)?.message ?? error).slice(0, 300),
        nextAction: 'Start again — completed phases resume from disk. If it fails at the same phase twice, report the error.',
        finishedAt: new Date(now()).toISOString(),
      });
      console.log(`[EtlOnboarding] failed: ${status.error}`);
    } finally {
      running = false;
    }
  }

  return {
    start(optionsIn = {}) {
      if (running) return { ...status, state: 'running' };
      running = true;
      status = {
        state: 'running',
        phase: 'discover',
        startedAt: new Date(now()).toISOString(),
        lastResult: status.lastResult,
      };
      void run(optionsIn);
      return status;
    },
    getStatus() {
      return status;
    },
  };
}
