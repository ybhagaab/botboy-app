import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer, setSetting } from './storage.js';
import { createEtlQueryRunner, type EtlToolCall } from './etl-adhoc.js';

/**
 * The mcp_etl_run_query composite (etl-analytics A1): one scratch pair per
 * user created once and reused via SQL revisions; structured errors that
 * name the next action; timeout ≠ failure; self-heal exactly once.
 */
describe('etl-adhoc query runner', () => {
  let storage: StorageLayer;
  let tmpDir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    setSetting(storage.getDb(), 'grasp_sync.owner_name', 'Bhagat, AB');
    setSetting(storage.getDb(), 'grasp_sync.owner_email', 'ybhagaab@amazon.com');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-adhoc-test-'));
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Scripted fake for the a2-analytics surface, with call recording. */
  function fakeEtl() {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const handlers = new Map<string, (args: Record<string, unknown>) => { isError: boolean; text: string }>();
    const searchDoc = {
      job_group_name: 'Team-Group-ETLM',
      job_logical_db_name: 'team-db',
      job_db_user_name: 'amzn:cdo:datanet-dbuser:team_etl_npe',
    };
    // Defaults: the happy path.
    handlers.set('datanet_search', () => ({ isError: false, text: JSON.stringify({ found: 2, searchResults: [{ document: searchDoc }, { document: searchDoc }] }) }));
    let profileSeq = 100;
    let jobSeq = 9000;
    handlers.set('datanet_create_profile', () => { profileSeq += 1; return { isError: false, text: JSON.stringify({ id: profileSeq, type: 'TRANSFORM', revision: 1 }) }; });
    handlers.set('datanet_create_job', () => { jobSeq += 1; return { isError: false, text: JSON.stringify({ id: jobSeq, owner: 'ybhagaab', schedule: { type: 'NOT_SCHEDULED' } }) }; });
    handlers.set('datanet_update_profile_sql', () => ({ isError: false, text: JSON.stringify({ id: 101, revision: 2 }) }));
    handlers.set('datanet_submit_run', () => ({ isError: false, text: JSON.stringify({ jobRuns: [{ id: 555001 }] }) }));
    handlers.set('datanet_get_job_run_status', () => ({ isError: false, text: JSON.stringify({ status: 'SUCCESS' }) }));
    handlers.set('datanet_download_results', (args) => {
      fs.writeFileSync(String(args.output), 'dt\tstreamers\n2026-09-01\t1234\n2026-09-02\t2345\n');
      return { isError: false, text: `saved to ${args.output}` };
    });
    handlers.set('datanet_get_job_run_error', () => ({ isError: false, text: JSON.stringify({ error: 'column "nope" does not exist' }) }));
    handlers.set('datanet_get_latest_run', () => ({ isError: false, text: JSON.stringify({ id: 554000, status: 'SUCCESS' }) }));
    const call: EtlToolCall = async (tool, args) => {
      calls.push({ tool, args });
      const handler = handlers.get(tool);
      if (!handler) return { isError: true, text: `Error: no fake for ${tool}` };
      return handler(args);
    };
    return {
      call,
      calls,
      countOf: (tool: string) => calls.filter(c => c.tool === tool).length,
      when: (tool: string, fn: (args: Record<string, unknown>) => { isError: boolean; text: string }) => handlers.set(tool, fn),
    };
  }

  function runner(fake: ReturnType<typeof fakeEtl>, extra: Partial<Parameters<typeof createEtlQueryRunner>[0]> = {}) {
    return createEtlQueryRunner({
      db: storage.getDb(),
      call: fake.call,
      pollIntervalMs: 1,
      pollBudgetMs: 100,
      downloadDir: tmpDir,
      ...extra,
    });
  }

  it('creates the scratch pair ONCE and reuses it: second query submits without any create calls', async () => {
    const fake = fakeEtl();
    const q = runner(fake);
    const first = await q.runQuery({ sql: 'select 1 as x' });
    expect(first.ok).toBe(true);
    expect(first.runId).toBe('555001');
    expect(first.columns).toEqual(['dt', 'streamers']);
    expect(first.rowCount).toBe(2);
    expect(first.savedTo).toContain('adhoc_555001.tsv');
    expect(fake.countOf('datanet_create_profile')).toBe(1);
    expect(fake.countOf('datanet_create_job')).toBe(1);

    const second = await q.runQuery({ sql: 'select 2 as y' });
    expect(second.ok).toBe(true);
    expect(fake.countOf('datanet_create_profile')).toBe(1); // still one — pinned pair reused
    expect(fake.countOf('datanet_create_job')).toBe(1);
    expect(fake.countOf('datanet_update_profile_sql')).toBe(2); // a revision per query
  });

  it('prepends the NO DEPENDENCIES header when missing and preserves an existing dependency header', async () => {
    const fake = fakeEtl();
    const staged: string[] = [];
    fake.when('datanet_update_profile_sql', (args) => {
      staged.push(String(args.sql));
      return { isError: false, text: JSON.stringify({ id: 101 }) };
    });
    const q = runner(fake);
    await q.runQuery({ sql: 'select 1' });
    expect(staged[0].startsWith('/* NO DEPENDENCIES */')).toBe(true);
    await q.runQuery({ sql: '/*+ETLM { depend:{ replace:[ {name:"andes.x.y"} ] } }*/\nselect 2' });
    expect(staged[1].startsWith('/*+ETLM')).toBe(true);
    expect(staged[1].includes('NO DEPENDENCIES')).toBe(false);
  });

  it('ERROR runs return the root cause and a fix-once next action — never an auto-resubmit', async () => {
    const fake = fakeEtl();
    fake.when('datanet_get_job_run_status', () => ({ isError: false, text: JSON.stringify({ status: 'ERROR' }) }));
    const q = runner(fake);
    const result = await q.runQuery({ sql: 'select broken' });
    expect(result.ok).toBe(false);
    expect(result.runId).toBe('555001');
    expect(result.error).toContain('column "nope" does not exist');
    expect(result.nextAction).toContain('ONCE');
    expect(fake.countOf('datanet_submit_run')).toBe(1); // the runner never resubmits on its own
  });

  it('a run outliving the poll budget is reported alive with the exact follow-up — not a failure', async () => {
    const fake = fakeEtl();
    fake.when('datanet_get_job_run_status', () => ({ isError: false, text: JSON.stringify({ status: 'EXECUTING' }) }));
    const q = runner(fake, { pollBudgetMs: 10 });
    const result = await q.runQuery({ sql: 'select long_running' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('still');
    expect(result.nextAction).toContain('Do NOT resubmit');
    expect(result.nextAction).toContain('555001');
    expect(fake.countOf('datanet_download_results')).toBe(0);
  });

  it('self-heals a vanished scratch profile exactly once (recreate → restage → proceed)', async () => {
    const fake = fakeEtl();
    const q = runner(fake);
    await q.runQuery({ sql: 'select 1' }); // pins pair (profile 101 / job 9001)

    let updateCalls = 0;
    fake.when('datanet_update_profile_sql', () => {
      updateCalls += 1;
      return updateCalls === 1
        ? { isError: true, text: 'ProfileNotFoundException: profile 101 not found' }
        : { isError: false, text: JSON.stringify({ id: 102 }) };
    });
    const result = await q.runQuery({ sql: 'select 2' });
    expect(result.ok).toBe(true);
    expect(fake.countOf('datanet_create_profile')).toBe(2); // initial + one heal, never more
    expect(updateCalls).toBe(2);
  });

  it('no Datanet footprint → structured error asking for the group; retry with group succeeds', async () => {
    const fake = fakeEtl();
    fake.when('datanet_search', (args) =>
      String(args.query) === 'Team-Group-ETLM'
        ? {
            isError: false,
            text: JSON.stringify({ found: 1, searchResults: [{ document: { job_group_name: 'Team-Group-ETLM', job_logical_db_name: 'team-db', job_db_user_name: 'amzn:cdo:datanet-dbuser:team_etl_npe' } }] }),
          }
        : { isError: false, text: JSON.stringify({ found: 0, searchResults: [] }) });
    const q = runner(fake);
    const blocked = await q.runQuery({ sql: 'select 1' });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('GROUP NAME');
    expect(blocked.nextAction).toContain('group parameter');

    const retried = await q.runQuery({ sql: 'select 1', group: 'Team-Group-ETLM' });
    expect(retried.ok).toBe(true);
  });

  it('creates the scratch job at HIGH priority — LOW starves in the compute-slot queue (live 2026-09-02)', async () => {
    const fake = fakeEtl();
    const q = runner(fake);
    await q.runQuery({ sql: 'select 1' });
    const createJob = fake.calls.find(c => c.tool === 'datanet_create_job');
    expect(createJob?.args.priority).toBe('HIGH');
  });

  it('rescues a run stuck in WAITING_FOR_RESOURCES with ONE uppercase PRIORITIZE — never a restart', async () => {
    const fake = fakeEtl();
    let polls = 0;
    fake.when('datanet_get_job_run_status', () => {
      polls += 1;
      return polls < 6
        ? { isError: false, text: JSON.stringify({ status: 'WAITING_FOR_RESOURCES' }) }
        : { isError: false, text: JSON.stringify({ status: 'SUCCESS' }) };
    });
    fake.when('datanet_alter_run', (args) => {
      expect(args.action).toBe('PRIORITIZE'); // case-sensitive server validation
      expect(String(args.run_id)).toBe('555001');
      return { isError: false, text: JSON.stringify({ jobRunId: 555001, status: 'WAITING_FOR_RESOURCES' }) };
    });
    const q = runner(fake, { prioritizeAfterMs: 2, pollBudgetMs: 5_000 });
    const result = await q.runQuery({ sql: 'select queued' });
    expect(result.ok).toBe(true);
    expect(fake.countOf('datanet_alter_run')).toBe(1); // exactly once, then back to polling
    expect(fake.countOf('datanet_submit_run')).toBe(1); // never restarted — queue position is sacred
  });

  it('a busy pair is SKIPPED, not waited on: the pool grows and the query runs on a fresh pair', async () => {
    const fake = fakeEtl();
    const q = runner(fake);
    await q.runQuery({ sql: 'select 1' }); // pins pair 1 (profile 101 / job 9001)
    // Pair 1's job now has a live queued run (e.g. a chat query handed off alive).
    fake.when('datanet_get_latest_run', (args) => String(args.job_id) === '9001'
      ? { isError: false, text: JSON.stringify({ id: 555001, status: 'WAITING_FOR_RESOURCES' }) }
      : { isError: false, text: JSON.stringify({ id: 554000, status: 'SUCCESS' }) });
    const staged: Array<{ profile: string; sql: string }> = [];
    fake.when('datanet_update_profile_sql', (args) => {
      staged.push({ profile: String(args.profile_id), sql: String(args.sql) });
      return { isError: false, text: JSON.stringify({ id: args.profile_id }) };
    });
    const result = await q.runQuery({ sql: 'select 2' });
    expect(result.ok).toBe(true);
    expect(fake.countOf('datanet_create_profile')).toBe(2); // pool grew by exactly one
    expect(staged).toEqual([{ profile: '102', sql: expect.stringContaining('select 2') }]); // fresh pair, busy one untouched
    const submitJobs = fake.calls.filter(c => c.tool === 'datanet_submit_run').map(c => String(c.args.job_id));
    expect(submitJobs).toEqual(['9001', '9002']); // first query's job, then the new pair's
  });

  it('parallel queries claim DISTINCT pairs: SQL never crosses pairs, both run concurrently', async () => {
    const fake = fakeEtl();
    const q = runner(fake);
    const staged: Array<{ profile: string; sql: string }> = [];
    fake.when('datanet_update_profile_sql', (args) => {
      staged.push({ profile: String(args.profile_id), sql: String(args.sql) });
      return { isError: false, text: JSON.stringify({ id: args.profile_id }) };
    });
    const [a, b] = await Promise.all([
      q.runQuery({ sql: 'select aaa' }),
      q.runQuery({ sql: 'select bbb' }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(fake.countOf('datanet_create_profile')).toBe(2); // one pair per concurrent query
    const submitJobs = fake.calls.filter(c => c.tool === 'datanet_submit_run').map(c => String(c.args.job_id)).sort();
    expect(submitJobs).toEqual(['9001', '9002']);
    // Each SQL landed on exactly one profile, and the profile↔job pairing held.
    expect(new Set(staged.map(s => s.profile)).size).toBe(2);

    // Both settle → the pool is reusable: a third query creates NOTHING new.
    const third = await q.runQuery({ sql: 'select ccc' });
    expect(third.ok).toBe(true);
    expect(fake.countOf('datanet_create_profile')).toBe(2);
  });

  it('the legacy single-pair settings migrate into pool slot 1 (no re-create)', async () => {
    const fake = fakeEtl();
    setSetting(storage.getDb(), 'etl.adhoc.alias', 'ybhagaab');
    setSetting(storage.getDb(), 'etl.adhoc.profile_id', 777);
    setSetting(storage.getDb(), 'etl.adhoc.job_id', '8888');
    const staged: string[] = [];
    fake.when('datanet_update_profile_sql', (args) => {
      staged.push(String(args.profile_id));
      return { isError: false, text: JSON.stringify({ id: args.profile_id }) };
    });
    const q = runner(fake);
    const result = await q.runQuery({ sql: 'select legacy' });
    expect(result.ok).toBe(true);
    expect(fake.countOf('datanet_create_profile')).toBe(0); // migrated, not recreated
    expect(staged).toEqual(['777']);
  });

  it('the pool fuse is a runaway guard: at the cap with everything busy, a structured error names the state', async () => {
    const fake = fakeEtl();
    setSetting(storage.getDb(), 'etl.adhoc.alias', 'ybhagaab');
    setSetting(storage.getDb(), 'etl.adhoc.pairs',
      Array.from({ length: 32 }, (_, i) => ({ profileId: 200 + i, jobId: String(7000 + i), slot: i + 1 })));
    fake.when('datanet_get_latest_run', () => ({ isError: false, text: JSON.stringify({ id: 1, status: 'EXECUTING' }) }));
    const q = runner(fake);
    const result = await q.runQuery({ sql: 'select overload' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('runaway fuse');
    expect(result.nextAction).toContain('mcp_etl_latest_run');
    expect(fake.countOf('datanet_create_profile')).toBe(0); // the fuse means NO more creation
  });

  it('the busy check fails OPEN: an unreadable latest-run never bricks the tool (pair treated as free)', async () => {
    const fake = fakeEtl();
    fake.when('datanet_get_latest_run', () => ({ isError: true, text: 'Error: transient' }));
    const q = runner(fake);
    const result = await q.runQuery({ sql: 'select 1' });
    expect(result.ok).toBe(true);
    expect(fake.countOf('datanet_create_profile')).toBe(1); // no spiral of replacements either
  });

  it('a DELETED run is terminal with a submit-once-then-stop next action', async () => {
    const fake = fakeEtl();
    fake.when('datanet_get_job_run_status', () => ({ isError: false, text: JSON.stringify({ status: 'DELETED' }) }));
    const q = runner(fake);
    const result = await q.runQuery({ sql: 'select gone' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('deleted server-side');
    expect(result.nextAction).toContain('ONCE');
  });

  it('caps returned rows and reports the true row count with the on-disk path', async () => {
    const fake = fakeEtl();
    fake.when('datanet_download_results', (args) => {
      const body = Array.from({ length: 250 }, (_, i) => `2026-09-01\t${i}`).join('\n');
      fs.writeFileSync(String(args.output), `dt\tvalue\n${body}\n`);
      return { isError: false, text: 'saved' };
    });
    const q = runner(fake, { maxRows: 200 });
    const result = await q.runQuery({ sql: 'select many' });
    expect(result.ok).toBe(true);
    expect(result.rowCount).toBe(250);
    expect(result.rows).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(fs.existsSync(String(result.savedTo))).toBe(true);
  });

  it('uses the dataset date given and defaults to today when omitted', async () => {
    const fake = fakeEtl();
    const q = runner(fake, { now: () => Date.parse('2026-09-02T10:00:00Z') });
    await q.runQuery({ sql: 'select 1', datasetDate: '2026-08-28' });
    await q.runQuery({ sql: 'select 2' });
    const submits = fake.calls.filter(c => c.tool === 'datanet_submit_run');
    expect(submits[0].args.dataset_date).toBe('2026-08-28');
    expect(submits[1].args.dataset_date).toBe('2026-09-02');
  });
});

/**
 * The managed a2-analytics call path (createEtlToolCall): structured-errors
 * invariant — no raw transport error may leave it (live 2026-09-04: three
 * dashboard widgets surfaced bare "MCP error -32001: Request timed out"
 * with no next action while the VPN was down mid-run).
 */
describe('createEtlToolCall transport errors', () => {
  it('wraps MCP timeouts as a structured error naming the next action', async () => {
    const { createEtlToolCall } = await import('./etl-adhoc.js');
    const mcp = {
      callTool: async () => { throw new Error('MCP error -32001: Request timed out'); },
    } as any;
    const call = createEtlToolCall(mcp);
    const result = await call('datanet_submit_run', {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('timed out');
    expect(result.text).toContain('the transport, not the query');
    expect(result.text).toContain('poll it');
    expect(result.text).toContain('instead of resubmitting');
  });

  it('still rethrows non-timeout, non-auth transport errors raw', async () => {
    const { createEtlToolCall } = await import('./etl-adhoc.js');
    const mcp = {
      callTool: async () => { throw new Error('spawn ENOENT: aim binary missing'); },
    } as any;
    const call = createEtlToolCall(mcp);
    await expect(call('datanet_submit_run', {})).rejects.toThrow('spawn ENOENT');
  });
});
