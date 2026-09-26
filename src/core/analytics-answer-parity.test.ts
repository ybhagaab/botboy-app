import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorage, setSetting, type StorageLayer } from './storage.js';
import { createEtlQueryRunner, type EtlToolCall } from './etl-adhoc.js';
import { etlResultToWidgetResult, parseSqlMcpResult } from './analytics-dashboard.js';
import {
  analyticsRequestSha256,
  analyticsSha256,
  compareAnalyticsAnswers,
} from './analytics-data-room-policy.js';
import type {
  AnalyticsAnswerSourceKind,
  AnalyticsCanonicalAnswer,
  AnalyticsCanonicalResult,
  AnalyticsDataCell,
  AnalyticsRequest,
} from './analytics-data-room-types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '../../evaluations/analytics-data-room-parity-v1/fixtures');
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected-results.json'), 'utf8')) as {
  columns: string[];
  rows: AnalyticsDataCell[][];
  rowCount: number;
  semanticRules: { completePartitions: string[] };
};
const routing = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'routing-fixture.json'), 'utf8')) as {
  request: AnalyticsRequest;
};
const rawEvents = fs.readFileSync(path.join(FIXTURES, 'raw-events.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line)) as Array<Record<string, unknown>>;

const temporaryDirs: string[] = [];
const storages: StorageLayer[] = [];
const databases: Database.Database[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (storages.length) storages.pop()?.close();
  while (temporaryDirs.length) fs.rmSync(temporaryDirs.pop()!, { recursive: true, force: true });
});

function result(columns: string[], rows: AnalyticsDataCell[][]): AnalyticsCanonicalResult {
  return {
    columns,
    rows,
    rowCount: rows.length,
    displayedRowCount: rows.length,
    truncated: false,
  };
}

function answer(
  sourceKind: AnalyticsAnswerSourceKind,
  canonicalResult: AnalyticsCanonicalResult,
  suffix: string,
): AnalyticsCanonicalAnswer {
  const request = routing.request;
  return {
    result: canonicalResult,
    receipt: {
      requestSha256: analyticsRequestSha256(request),
      sourceKind,
      executionKind: sourceKind === 'sql_context' || sourceKind === 'datanet_etl'
        ? 'remote_query'
        : sourceKind === 'data_room_derived' ? 'local_derivation' : 'materialized_answer',
      metric: request.metric,
      regime: request.regime,
      countingKey: request.countingKey,
      grain: request.requiredGrain,
      dimensions: [...request.dimensions],
      unit: request.metric.unit,
      timeZone: request.timeZone,
      requestedRange: request.dateRange,
      coveredPartitions: [...expected.semanticRules.completePartitions],
      watermark: '2026-09-02T23:59:59.000Z',
      datasetIds: [`ds_${suffix}`],
      versionIds: [`dsv_${suffix}`],
      contractSha256: request.requiredContractSha256!,
      definitionSha256: '6666666666666666666666666666666666666666666666666666666666666666',
      contentSha256: analyticsSha256({ sourceKind, suffix, canonicalResult }),
      materializedAt: '2026-09-03T00:00:00.000Z',
      qualityWarnings: [],
      limitations: [],
    },
  };
}

function directSqlAnswer(): AnalyticsCanonicalAnswer {
  const lines = [
    'event_date | qualified_streamers',
    '-----------+--------------------',
    ...expected.rows.map(row => `${row[0]} | ${row[1]}`),
    `${expected.rowCount} rows returned. (3ms)`,
  ];
  const parsed = parseSqlMcpResult(lines.join('\n'), '2026-09-03T00:00:00.000Z');
  return answer('sql_context', {
    columns: parsed.columns,
    rows: parsed.rows,
    rowCount: parsed.rowCount,
    displayedRowCount: parsed.displayedRowCount,
    truncated: parsed.rowCount > parsed.displayedRowCount,
  }, 'sql');
}

async function etlAnswer(): Promise<AnalyticsCanonicalAnswer> {
  const storage = createStorage(':memory:');
  storage.initialize();
  storages.push(storage);
  setSetting(storage.getDb(), 'grasp_sync.owner_name', 'Test Owner');
  setSetting(storage.getDb(), 'grasp_sync.owner_email', 'owner@example.test');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-parity-etl-'));
  temporaryDirs.push(tmpDir);
  const calls: string[] = [];
  const call: EtlToolCall = async (tool, args) => {
    calls.push(tool);
    if (tool === 'datanet_search') {
      return { isError: false, text: JSON.stringify({ searchResults: [{ document: {
        job_group_name: 'TEST-GROUP', job_logical_db_name: 'test-db', job_db_user_name: 'test-user',
      } }] }) };
    }
    if (tool === 'datanet_create_profile') return { isError: false, text: JSON.stringify({ id: 101 }) };
    if (tool === 'datanet_create_job') return { isError: false, text: JSON.stringify({ id: 9001 }) };
    if (tool === 'datanet_get_latest_run') return { isError: false, text: JSON.stringify({ id: 1, status: 'SUCCESS' }) };
    if (tool === 'datanet_update_profile_sql') return { isError: false, text: JSON.stringify({ id: 101, revision: 2 }) };
    if (tool === 'datanet_submit_run') return { isError: false, text: JSON.stringify({ jobRuns: [{ id: 7001 }] }) };
    if (tool === 'datanet_get_job_run_status') return { isError: false, text: JSON.stringify({ status: 'SUCCESS' }) };
    if (tool === 'datanet_download_results') {
      const body = [expected.columns.join('\t'), ...expected.rows.map(row => row.join('\t')), ''].join('\n');
      fs.writeFileSync(String(args.output), body);
      return { isError: false, text: JSON.stringify({ savedTo: args.output }) };
    }
    return { isError: true, text: `Unexpected fake tool ${tool}` };
  };
  const runner = createEtlQueryRunner({
    db: storage.getDb(), call, pollIntervalMs: 1, pollBudgetMs: 100, downloadDir: tmpDir,
  });
  const outcome = await runner.runQuery({ sql: 'SELECT event_date, qualified_streamers FROM fixture' });
  expect(outcome.ok).toBe(true);
  expect(calls.filter(tool => tool === 'datanet_submit_run')).toHaveLength(1);
  const parsed = etlResultToWidgetResult(outcome);
  return answer('datanet_etl', {
    columns: parsed.columns,
    rows: parsed.rows,
    rowCount: parsed.rowCount,
    displayedRowCount: parsed.displayedRowCount,
    truncated: parsed.rowCount > parsed.displayedRowCount,
  }, 'etl');
}

function materializedAnswer(): AnalyticsCanonicalAnswer {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec('CREATE TABLE daily (event_date TEXT NOT NULL, qualified_streamers INTEGER NOT NULL)');
  const insert = db.prepare('INSERT INTO daily VALUES (?, ?)');
  expected.rows.forEach(row => insert.run(row[0], row[1]));
  const rows = db.prepare('SELECT event_date, qualified_streamers FROM daily ORDER BY event_date').all()
    .map((row: any) => [row.event_date, row.qualified_streamers] as AnalyticsDataCell[]);
  return answer('data_room_materialized', result([...expected.columns], rows), 'materialized');
}

function derivedAnswer(): AnalyticsCanonicalAnswer {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(`
    CREATE TABLE raw_events (
      event_id TEXT NOT NULL, event_date TEXT NOT NULL, event_ts TEXT NOT NULL,
      user_id TEXT NOT NULL, region TEXT NOT NULL, type TEXT,
      event_name TEXT NOT NULL, play_minutes REAL NOT NULL, corrupt INTEGER NOT NULL
    )
  `);
  const insert = db.prepare(`
    INSERT INTO raw_events
      (event_id,event_date,event_ts,user_id,region,type,event_name,play_minutes,corrupt)
    VALUES (@event_id,@event_date,@event_ts,@user_id,@region,@type,@event_name,@play_minutes,@corrupt)
  `);
  const seed = db.transaction(() => rawEvents.forEach(event => insert.run({
    ...event,
    corrupt: event.corrupt ? 1 : 0,
  })));
  seed();
  const rows = db.prepare(`
    SELECT event_date, COUNT(DISTINCT user_id) AS qualified_streamers
    FROM raw_events
    WHERE event_date BETWEEN '2026-09-01' AND '2026-09-02'
      AND region = 'IN'
      AND (type IS NULL OR type = 'player')
      AND event_name IN ('play_started','play_progress','play_exit')
      AND corrupt = 0
      AND user_id != '00000000-0000-0000-0000-000000000000'
    GROUP BY event_date
    ORDER BY event_date
  `).all().map((row: any) => [row.event_date, row.qualified_streamers] as AnalyticsDataCell[]);
  return answer('data_room_derived', result([...expected.columns], rows), 'derived');
}

describe('analytics data-room four-path operational parity R0', () => {
  it('matches direct SQL, Datanet ETL, materialized room, and local derivation exactly', async () => {
    const answers = [directSqlAnswer(), await etlAnswer(), materializedAnswer(), derivedAnswer()];
    for (let left = 0; left < answers.length; left++) {
      for (let right = left + 1; right < answers.length; right++) {
        const parity = compareAnalyticsAnswers(answers[left], answers[right]);
        expect(parity.equal, `${answers[left].receipt.sourceKind} vs ${answers[right].receipt.sourceKind}: ${JSON.stringify(parity.mismatches)}`)
          .toBe(true);
        expect(parity.leftRowSetSha256).toBe(parity.rightRowSetSha256);
      }
    }
  });

  it('does not confuse row order with a data difference, but preserves duplicate multiplicity and types', () => {
    const left = materializedAnswer();
    const reversed = structuredClone(left);
    reversed.result.rows.reverse();
    expect(compareAnalyticsAnswers(left, reversed).equal).toBe(true);

    const stringified = structuredClone(left);
    stringified.result.rows[0][1] = String(stringified.result.rows[0][1]);
    expect(compareAnalyticsAnswers(left, stringified).mismatches.map(item => item.code)).toContain('rows');

    const duplicate = structuredClone(left);
    duplicate.result.rows.push([...duplicate.result.rows[0]]);
    duplicate.result.rowCount += 1;
    duplicate.result.displayedRowCount += 1;
    expect(compareAnalyticsAnswers(left, duplicate).mismatches.map(item => item.code))
      .toEqual(expect.arrayContaining(['rows', 'row_count', 'displayed_row_count']));
  });

  it('fails semantic parity even when result values are identical', () => {
    const baseline = materializedAnswer();
    const wrongRegime = structuredClone(baseline);
    wrongRegime.receipt.regime.id = 'single_event_only';
    expect(compareAnalyticsAnswers(baseline, wrongRegime).mismatches.map(item => item.code)).toContain('regime');

    const wrongCountingKey = structuredClone(baseline);
    wrongCountingKey.receipt.countingKey = 'event_id';
    expect(compareAnalyticsAnswers(baseline, wrongCountingKey).mismatches.map(item => item.code)).toContain('counting_key');

    const missingPartition = structuredClone(baseline);
    missingPartition.receipt.coveredPartitions = ['2026-09-01'];
    expect(compareAnalyticsAnswers(baseline, missingPartition).mismatches.map(item => item.code)).toContain('coverage');

    const hiddenWarning = structuredClone(baseline);
    hiddenWarning.receipt.qualityWarnings = ['volume_drift'];
    expect(compareAnalyticsAnswers(baseline, hiddenWarning).mismatches.map(item => item.code)).toContain('quality_warnings');
  });
});
