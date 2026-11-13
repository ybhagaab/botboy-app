import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorage, setSetting, type StorageLayer } from './storage.js';
import { createNodeManager } from './node-manager.js';
import { createChatJobStore, type ChatJobStore } from './chat-jobs.js';
import { resetEtlDownloadsForTests } from './etl-downloads.js';
import { recordWidgetSourceChange } from './data-origins.js';
import { createToolExecutor, type ToolExecutionContext } from './tool-executor.js';

/**
 * Owner decisions 2026-11-10: a job knows at its start whether it is data work; a scratch run's SQL is kept by run id; a job update
 * reads the Data Room; a dashboard read starts with where its data comes from, and one widget's read carries its earlier sources.
 */
describe('data origins through the tools', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  let resultsDir: string;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    setSetting(storage.getDb(), 'grasp_sync.owner_name', 'Bhagat, AB');
    setSetting(storage.getDb(), 'grasp_sync.owner_email', 'owner@example.com');
    jobs = createChatJobStore(storage.getDb());
    resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-origins-'));
    resetEtlDownloadsForTests();
  });
  afterEach(() => {
    storage.close();
    fs.rmSync(resultsDir, { recursive: true, force: true });
  });

  /** The scratch runner's ETL surface; the run stays EXECUTING, so the call hands it off. */
  function fakeMcp() {
    const searchDoc = { job_group_name: 'Team-Group-ETLM', job_logical_db_name: 'team-db', job_db_user_name: 'amzn:cdo:datanet-dbuser:team_etl_npe' };
    const reply = (toolName: string, text: string) => ({ isError: false, text, serverId: 'a2-analytics', toolName });
    return vi.fn(async (_server: string, toolName: string) => {
      switch (toolName) {
        case 'datanet_search': return reply(toolName, JSON.stringify({ found: 1, searchResults: [{ document: searchDoc }] }));
        case 'datanet_create_profile': return reply(toolName, JSON.stringify({ id: 101, type: 'TRANSFORM', revision: 1 }));
        case 'datanet_create_job': return reply(toolName, JSON.stringify({ id: 9001, schedule: { type: 'NOT_SCHEDULED' } }));
        case 'datanet_update_profile_sql': return reply(toolName, JSON.stringify({ id: 101, revision: 2 }));
        case 'datanet_submit_run': return reply(toolName, JSON.stringify({ jobRuns: [{ id: 777001 }] }));
        case 'datanet_get_job_run_status': return reply(toolName, JSON.stringify({ status: 'EXECUTING' }));
        default: return { isError: true, text: `no fake for ${toolName}`, serverId: 'a2-analytics', toolName };
      }
    });
  }

  const run = async (exec: ReturnType<typeof createToolExecutor>, name: string, args: Record<string, unknown>, context?: ToolExecutionContext) => {
    const result = await exec.executeTool({ id: `${name}-1`, type: 'function', function: { name, arguments: JSON.stringify(args) } }, context);
    try { return JSON.parse(result.content); } catch { return result.content; }
  };
  const owner: ToolExecutionContext = { callerKind: 'interactive', currentUserMessage: 'Weekly PV players for Local', ownerRequestId: 'req-00000001' };

  it('keeps a scratch run\'s SQL by its run id at submission', async () => {
    const exec = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      mcpManager: { callTool: fakeMcp() } as any, chatJobs: jobs, etlResultsDir: path.join(resultsDir, 'files', 'etl-results'),
    });
    const sql = 'select report_date, count(*) from events group by 1';
    await run(exec, 'mcp_etl_run_query', { sql, waitSeconds: 0, purpose: 'daily counts', ownerRequested: true }, owner);
    const row = storage.getDb().prepare('SELECT sql, purpose, job_id FROM etl_run_queries WHERE run_id = ?').get('777001') as any;
    expect(row).toMatchObject({ sql, purpose: 'daily counts' });
    expect(row.job_id).toBe(jobs.activeJobs()[0]!.id);
  });

  it('decides at hand-off whether the job is data work: its words, or what the turn did before', async () => {
    const exec = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), { chatJobs: jobs });
    const turn = (dataWork: boolean): ToolExecutionContext => ({ ...owner, heldJobIds: [], startedJobIds: [], turnDataWork: () => dataWork });
    const byWords = await run(exec, 'job_update', { action: 'start', goal: 'get both up & fresh', title: 'Repair both dashboard refreshes' }, turn(false));
    const byTurn = await run(exec, 'job_update', { action: 'start', goal: 'get both up & fresh', title: 'Both up' }, turn(true));
    const general = await run(exec, 'job_update', { action: 'start', goal: 'Draft the offsite note', title: 'Offsite note' }, turn(false));
    // The request names no data work, but its first step does.
    const byStep = await run(exec, 'job_update', { action: 'start', goal: 'Look after the Local launch', title: 'Local launch', nextStep: 'Pull last week\'s players from the warehouse' }, turn(false));
    const byNotes = await run(exec, 'job_update', { action: 'start', goal: 'Look after the Local launch', title: 'Launch two', notes: ['compare the retention of both cohorts'] }, turn(false));
    expect(jobs.get(byWords.job.id)!.dataWork).toBe(true);
    expect(jobs.get(byTurn.job.id)!.dataWork).toBe(true);
    expect(jobs.get(general.job.id)!.dataWork).toBe(false);
    expect(jobs.get(byStep.job.id)!.dataWork).toBe(true);
    expect(jobs.get(byNotes.job.id)!.dataWork).toBe(true);
  });

  it('starts the job that owns an ETL request as data work, even when the run never started', async () => {
    const failing = fakeMcp();
    const fake = failing.getMockImplementation()!;
    failing.mockImplementation(async (server: string, toolName: string, ...rest: any[]) => toolName === 'datanet_submit_run'
      ? { isError: true, text: 'submission rejected', serverId: 'a2-analytics', toolName }
      : (fake as any)(server, toolName, ...rest));
    const exec = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      mcpManager: { callTool: failing } as any, chatJobs: jobs, etlResultsDir: path.join(resultsDir, 'files', 'etl-results'),
    });
    await run(exec, 'mcp_etl_run_query', { sql: 'select 1', waitSeconds: 0, ownerRequested: true }, owner);
    const [job] = jobs.activeJobs();
    expect(jobs.watchesForJob(job!.id)).toEqual([]);
    expect(job!.dataWork).toBe(true);
    expect(storage.getDb().prepare('SELECT COUNT(*) AS n FROM etl_run_queries').get()).toEqual({ n: 0 });
  });

  it('lets the main chat\'s look at an active job read the Data Room, and no other caller without an owner turn', async () => {
    const list = vi.fn(() => ({ status: 'ok', datasets: [] }));
    const exec = createToolExecutor(storage.getDb(), createNodeManager(storage.getDb()), {
      chatJobs: jobs, analyticsDataRoomRead: { list, query: vi.fn() } as any,
    });
    const job = jobs.start({ goal: 'fix the dashboard' });
    const review = (jobId?: string): ToolExecutionContext => ({ callerKind: 'review', ...(jobId ? { reviewJobId: jobId } : {}), currentUserMessage: 'fix the dashboard' });
    expect(await run(exec, 'list_data_room_datasets', {}, review(job.id))).toMatchObject({ status: 'ok' });
    expect(list).toHaveBeenCalledTimes(1);
    expect(await run(exec, 'list_data_room_datasets', {}, review())).toMatchObject({ code: 'owner_context_required' });
    expect(await run(exec, 'list_data_room_datasets', {}, { callerKind: 'background', currentUserMessage: 'x' })).toMatchObject({ code: 'owner_context_required' });
    // Only the main chat's own look counts, and only with the update it decides on.
    expect(await run(exec, 'list_data_room_datasets', {}, { callerKind: 'background', reviewJobId: job.id, currentUserMessage: 'x' })).toMatchObject({ code: 'owner_context_required' });
    expect(await run(exec, 'list_data_room_datasets', {}, { callerKind: 'review', reviewJobId: job.id, currentUserMessage: '  ' })).toMatchObject({ code: 'owner_context_required' });
    jobs.end(job.id, 'done', 'finished');
    expect(await run(exec, 'list_data_room_datasets', {}, review(job.id))).toMatchObject({ code: 'owner_context_required' });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('starts a dashboard read with its sources and gives one widget its earlier sources and its dataset\'s origin', async () => {
    const db = storage.getDb();
    const dashboard = {
      id: 'dash_mix', title: 'Downloads', description: '', status: 'ready', recentRuns: [],
      widgets: [
        { id: 'w_room', revision: 5, position: 0, kind: 'table', title: 'Contribution', config: { dataSource: { version: 1, kind: 'data_room_query', datasetId: 'ds_room', versionId: 'dsv_old', sql: 'SELECT * FROM source.data' } },
          result: { rowCount: 28, rows: [], columns: [], source: { provider: 'data_room', datasetId: 'ds_room', versionId: 'dsv_new' } } },
        { id: 'w_wh', revision: 2, position: 1, kind: 'table', title: 'Lifecycle', sql: 'SELECT 1', config: {}, result: { rowCount: 28, rows: [], columns: [], lane: 'etl' } },
        { id: 'w_page', revision: 1, position: 2, kind: 'html', title: 'Overview', config: { html: '<p>hi</p>' } },
      ],
    };
    // The executor sets up the origin tables; the history is written after, as the dashboard service would.
    const exec = createToolExecutor(db, createNodeManager(db), {
      analyticsService: { getDashboard: () => dashboard } as any,
      analyticsDataRoom: { getDataset: () => ({ name: 'Contribution', head: { versionId: 'dsv_new' }, contract: { coverage: { watermark: '2026-11-08T23:59:59+05:30' } } }) } as any,
    });
    recordWidgetSourceChange(db, {
      widgetId: 'w_room', dashboardId: 'dash_mix', widgetRevision: 4,
      previous: { kind: 'warehouse_sql', sql: 'SELECT contribution FROM warehouse_table' },
      next: { kind: 'data_room_query', sql: 'SELECT * FROM source.data', datasetId: 'ds_room' },
    });
    const whole = await run(exec, 'get_analytics_dashboard', { dashboardId: 'dash_mix' });
    expect(Object.keys(whole)[0]).toBe('sources');
    expect(whole.sources.summary).toBe('3 widgets: 1 read warehouse queries (last loaded through etl 1), 1 read Data Room datasets (1 dataset), 1 are text or pages.');
    expect(whole.sources.dataRoom[0]).toMatchObject({
      widgetId: 'w_room', datasetId: 'ds_room', datasetName: 'Contribution', newestVersionId: 'dsv_new', shownVersionId: 'dsv_new',
      dataThrough: '2026-11-08T23:59:59+05:30', originalQuery: expect.stringContaining('warehouse_sql, 40 chars'),
    });
    expect(whole.sources.warehouse[0]).toMatchObject({ widgetId: 'w_wh', lastLane: 'etl', state: 'loaded' });
    const one = await run(exec, 'get_analytics_dashboard', { dashboardId: 'dash_mix', widgetId: 'w_room' });
    expect(one.sourceHistory[0]).toMatchObject({ kind: 'warehouse_sql', sql: 'SELECT contribution FROM warehouse_table', widgetRevision: 4 });
    expect(one.dataset).toMatchObject({ datasetId: 'ds_room', newestVersionId: 'dsv_new', origin: [] });
  });

  it('says a source change kept the previous source only when this change kept it', async () => {
    const db = storage.getDb();
    let revision = 0;
    const source = { version: 1, kind: 'data_room_query', datasetId: 'ds_room', sql: 'SELECT * FROM source.data' };
    const widget = () => ({ id: 'w_cfg', revision, position: 0, kind: 'table', title: 'Contribution', config: { dataSource: source } });
    const analyticsService = {
      configureWidgetSource: () => ({ run: { id: 'run_cfg', status: 'completed' }, widget: widget(), sourceConfigSha256: 'f'.repeat(64) }),
      getRun: () => ({ id: 'run_cfg', status: 'completed' }),
      getDashboard: () => ({ id: 'dash_cfg', widgets: [widget()] }),
    };
    const exec = createToolExecutor(db, createNodeManager(db), { analyticsService: analyticsService as any });
    const configure = () => run(exec, 'configure_analytics_widget_source', {
      dashboardId: 'dash_cfg', widgetId: 'w_cfg', expectedWidgetRevision: Math.max(1, revision - 1), source, ownerRequested: true,
    }, owner);
    // This change replaced revision 4 and kept its SQL: the widget is now at revision 5.
    recordWidgetSourceChange(db, {
      widgetId: 'w_cfg', dashboardId: 'dash_cfg', widgetRevision: 4,
      previous: { kind: 'warehouse_sql', sql: 'SELECT contribution FROM warehouse_table' }, next: { kind: 'data_room_query', sql: source.sql, datasetId: 'ds_room' },
    });
    revision = 5;
    expect((await configure()).previousSourceKept).toMatchObject({ kind: 'warehouse_sql', sqlChars: 40 });
    // The next change kept nothing (an unchanged source): the record it would point at is the older one.
    revision = 6;
    expect(await configure()).not.toHaveProperty('previousSourceKept');
  });
});
