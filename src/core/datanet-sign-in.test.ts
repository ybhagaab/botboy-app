import fs from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, setSetting, type StorageLayer } from './storage.js';
import { createEtlQueryRunner, createEtlToolCall } from './etl-adhoc.js';
import { createEtlRunWatcher } from './etl-run-watcher.js';
import { createChatJobStore } from './chat-jobs.js';
import { createQueryLedger } from './query-ledger.js';
import { isDashboardLaneUnavailable } from './analytics-runners.js';
import { DATANET_SIGN_IN_REFUSED, isDatanetSignInRefusal, primeDatanetSentrySession } from './sentry-session.js';
import { resetEtlDownloadsForTests } from './etl-downloads.js';

// The silent Kerberos re-prime spawns curl; here it fails the way it did live (no Kerberos ticket on the Mac).
vi.mock('./sentry-session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sentry-session.js')>()),
  primeDatanetSentrySession: vi.fn(async () => ({ ok: false, reason: 'no_kerberos' })),
}));

/**
 * A refused Datanet sign-in (live 2026-11-14): Amazon's device check lapsed at 14:57, and from a restart at 18:33 every
 * Datanet read came back as its 307 sign-in page, wrapped as data, until a new device check at 21:36. BotBoy said "Datanet
 * did not answer" and "returned no status". Every reader now names the cause and the owner's fix, and none treats it as a
 * run failure (docs/maps/query-control.md, datanet-etl.md).
 */
const PAGE = '{\n  "_raw": "<html>\\r\\n<head><title>307 Temporary Redirect</title></head>\\r\\n<body>\\r\\n<center><h1>307 Temporary Redirect</h1></center>\\r\\n</body>\\r\\n</html>\\r\\n"\n}';

describe('a refused Datanet sign-in', () => {
  let storage: StorageLayer;
  let tmpDir: string;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    setSetting(storage.getDb(), 'grasp_sync.owner_name', 'Bhagat, AB');
    setSetting(storage.getDb(), 'grasp_sync.owner_email', 'ybhagaab@amazon.com');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'datanet-sign-in-'));
    resetEtlDownloadsForTests();
    vi.mocked(primeDatanetSentrySession).mockClear();
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** The a2-analytics server behind createEtlToolCall: the happy path, with status reads answered by `status()`. */
  function datanet(status: () => string) {
    const calls: string[] = [];
    const searchDoc = { job_group_name: 'Team-Group-ETLM', job_logical_db_name: 'team-db', job_db_user_name: 'amzn:cdo:datanet-dbuser:team_etl_npe' };
    const answers: Record<string, () => string> = {
      datanet_search: () => JSON.stringify({ found: 1, searchResults: [{ document: searchDoc }] }),
      datanet_create_profile: () => JSON.stringify({ id: 101, type: 'TRANSFORM', revision: 1 }),
      datanet_create_job: () => JSON.stringify({ id: 9001, owner: 'ybhagaab', schedule: { type: 'NOT_SCHEDULED' } }),
      datanet_update_profile_sql: () => JSON.stringify({ id: 101, revision: 2 }),
      datanet_submit_run: () => JSON.stringify({ jobRuns: [{ id: 555001 }] }),
      datanet_get_latest_run: () => JSON.stringify({ id: 554000, status: 'SUCCESS' }),
      datanet_get_job_run_status: status,
    };
    const mcp = {
      callTool: async (_server: string, tool: string) => {
        calls.push(tool);
        const answer = answers[tool];
        if (!answer) throw new Error(`no fake for ${tool}`);
        return { isError: false, text: answer(), serverId: 'a2-analytics', toolName: tool };
      },
    };
    return { call: createEtlToolCall(mcp as any), calls };
  }

  it('the call path turns the sign-in page into an error that names the cause, says nothing happened, and names the fix', async () => {
    const { call } = datanet(() => PAGE);
    const answer = await call('datanet_get_job_run_status', { run_id: '13257595845' });
    expect(answer.isError).toBe(true);
    expect(answer.text).toBe(`Error: ${DATANET_SIGN_IN_REFUSED}: Datanet answered with its sign-in page, so the Datanet ETL connection needs re-authentication; Datanet did not act on this call. Tell the owner to run \`mwinit -o -s\` (or use Connections → Datanet ETL → Refresh Midway + Sentry), then retry this tool.`);
    expect(primeDatanetSentrySession).toHaveBeenCalledTimes(1);
    // The dashboard lanes still read it as the ETL lane being down (analytics-runners.ts), and the reader names it as a refusal.
    expect(isDashboardLaneUnavailable(answer.text, 'etl')).toBe(true);
    expect(isDatanetSignInRefusal(answer.text)).toBe(true);
  });

  it('a sign-in failure the connector throws names the cause and the failed re-prime', async () => {
    const call = createEtlToolCall({ callTool: async () => { throw new Error('Non-JSON response: <!doctype html><title>HTTP Status 401 – Unauthorized</title>'); } } as any);
    const answer = await call('datanet_get_job_run_status', { run_id: '1' });
    expect(answer).toMatchObject({ isError: true });
    expect(answer.text).toBe(`Error: ${DATANET_SIGN_IN_REFUSED}, and the silent Kerberos re-prime failed (no_kerberos), so the Datanet ETL connection needs re-authentication; Datanet did not act on this call. Tell the owner to run \`mwinit -o -s\` (or use Connections → Datanet ETL → Refresh Midway + Sentry), then retry this tool.`);
    expect(isDashboardLaneUnavailable(answer.text, 'etl')).toBe(true);
  });

  it('tells a refusal from a slow or broken Datanet and from data', () => {
    expect(isDatanetSignInRefusal(PAGE)).toBe(true);
    expect(isDatanetSignInRefusal(`Error: ${DATANET_SIGN_IN_REFUSED}, and the silent Kerberos re-prime failed (timeout)`)).toBe(true);
    expect(isDatanetSignInRefusal('Error: the Datanet ETL call datanet_get_job_run_status timed out after 5 min — the transport, not the query.')).toBe(false);
    expect(isDatanetSignInRefusal('{"status":"EXECUTING","note":"redirect 307"}')).toBe(false);
    expect(isDatanetSignInRefusal('')).toBe(false);
    expect(isDatanetSignInRefusal(undefined)).toBe(false);
  });

  it('a read of an existing run names the refusal, keeps the run open, and says not to resubmit', async () => {
    const ledger = createQueryLedger(storage.getDb());
    ledger.beginEtl({ runId: '13257595845', origin: { kind: 'job', jobId: 'cj_5' } });
    const { call } = datanet(() => PAGE);
    const read = await createEtlQueryRunner({ db: storage.getDb(), call, downloadDir: tmpDir }).readRun!({ runId: '13257595845' });
    expect(read).toEqual({
      ok: false,
      code: 'status_unavailable',
      runId: '13257595845',
      signInRefused: true,
      error: `${DATANET_SIGN_IN_REFUSED}, so BotBoy could not read run 13257595845; the run itself is not affected.`,
      nextAction: 'Do not resubmit the query. Ask the owner to run mwinit -o -s in Terminal (or Connections → Datanet ETL → Refresh Midway + Sentry), then read this run again.',
    });
    expect(ledger.forRun('13257595845')?.endState ?? null).toBeNull();
  });

  it('a read whose failure is not a sign-in keeps its plain words', async () => {
    const call = async () => ({ isError: true, text: 'Error: the Datanet ETL call timed out after 5 min — the transport, not the query.' });
    const read = await createEtlQueryRunner({ db: storage.getDb(), call, downloadDir: tmpDir }).readRun!({ runId: '42' });
    expect(read).toMatchObject({ code: 'status_unavailable', error: expect.stringMatching(/^Could not read existing run 42: Error: the Datanet ETL call timed out/) });
    expect(read.signInRefused).toBeUndefined();
  });

  it('a run whose status reads turn into sign-in refusals is handed off as last seen, with the fix, and never resubmitted', async () => {
    createQueryLedger(storage.getDb());
    let reads = 0;
    const { call, calls } = datanet(() => (++reads === 1 ? JSON.stringify({ status: 'EXECUTING' }) : PAGE));
    const result = await createEtlQueryRunner({ db: storage.getDb(), call, pollIntervalMs: 1, pollBudgetMs: 60, downloadDir: tmpDir }).runQuery({ sql: 'select 1' });
    expect(result).toMatchObject({ ok: false, code: 'alive_handoff', runId: '555001', remoteStatus: 'EXECUTING', signInRefused: true });
    expect(result.error).toBe(`Run 555001 was last seen EXECUTING; then ${DATANET_SIGN_IN_REFUSED}, so BotBoy cannot read its state now. The run itself is not affected.`);
    expect(result.nextAction).toBe('Do NOT resubmit — the run goes on in Datanet. Ask the owner to run mwinit -o -s in Terminal (or Connections → Datanet ETL → Refresh Midway + Sentry), then check it with mcp_etl_job_run (runId 555001).');
    expect(calls.filter(tool => tool === 'datanet_submit_run')).toHaveLength(1);
  });

  it('a read that works again clears the refusal: the hand-off reads as a plain one', async () => {
    createQueryLedger(storage.getDb());
    let reads = 0;
    const { call } = datanet(() => (++reads === 1 ? PAGE : JSON.stringify({ status: 'EXECUTING' })));
    const result = await createEtlQueryRunner({ db: storage.getDb(), call, pollIntervalMs: 1, pollBudgetMs: 60, downloadDir: tmpDir }).runQuery({ sql: 'select 1' });
    expect(reads).toBeGreaterThan(1);
    expect(result).toMatchObject({ code: 'alive_handoff', remoteStatus: 'EXECUTING' });
    expect(result.signInRefused).toBeUndefined();
    expect(result.error).toMatch(/^Run 555001 still EXECUTING after/);
  });

  it('the run watcher keeps waiting through a refusal and logs it once per episode', async () => {
    const jobs = createChatJobStore(storage.getDb());
    const jobId = jobs.start({ goal: 'OTT CX study' }).id;
    jobs.addWatch({ runId: '13257595845', jobId, source: 'run_query' });
    const logs: string[] = [];
    let refused = true;
    const watcher = createEtlRunWatcher({
      jobs,
      readRun: async runId => (refused
        ? { ok: false, code: 'status_unavailable', runId, signInRefused: true, error: 'refused' }
        : { ok: false, code: 'alive_handoff', runId, remoteStatus: 'EXECUTING' }),
      etlAvailable: async () => true,
      onRunsFinished: () => {},
      log: line => logs.push(line),
    });
    for (let tick = 0; tick < 3; tick += 1) await watcher.tick();
    expect(jobs.watch('13257595845')).toMatchObject({ status: 'pending', pollFailures: 3 });
    const refusals = () => logs.filter(line => line.includes(DATANET_SIGN_IN_REFUSED));
    expect(refusals()).toEqual([`[EtlWatch] run 13257595845: ${DATANET_SIGN_IN_REFUSED}; BotBoy keeps waiting and reads it again once Datanet answers`]);
    refused = false;
    await watcher.tick();
    refused = true;
    await watcher.tick();
    expect(refusals()).toHaveLength(2);
  });
});
