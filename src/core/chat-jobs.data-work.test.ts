import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import {
  createChatJobStore,
  detectJobDataWork,
  formatChatJobBlock,
  isDataWorkTool,
  recordToolOutcome,
  type ChatJobStore,
} from './chat-jobs.js';

/**
 * Owner decision 2026-11-10: "when a job is started see if it has a need for analytics or data & then add detailed in the brief
 * for the job". The store decides once at start, and a job that later records data work is data work from then on.
 */
describe('data work on a job', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
  });
  afterEach(() => storage.close());

  it('reads data work from the words of a request', () => {
    for (const text of ['Repair both dashboard refreshes', 'refresh the Data Room dataset', 'run the ETL again', 'check the SQL for Prime',
      'weekly retention cohort', 'monthly KPIs by region', 'analyze the churn', 'import this CSV', 'summarize the PV weekly data']) {
      expect(detectJobDataWork([text]), text).toBe(true);
    }
    for (const text of ['reply to Alice about Friday', 'write the offsite agenda', 'summarize my week', 'book a room']) {
      expect(detectJobDataWork([text]), text).toBe(false);
    }
    expect(detectJobDataWork([undefined, null, 'get both up & fresh', 'Repair both dashboard refreshes'])).toBe(true);
    expect(detectJobDataWork([])).toBe(false);
  });

  it('counts data tools, and only data tools', () => {
    for (const name of ['get_analytics_dashboard', 'configure_analytics_widget_source', 'create_data_room_dataset', 'query_data_room',
      'mcp_etl_run_query', 'mcp_sql_query', 'mcp_analytics_load_context', 'wait_for_etl_run']) {
      expect(isDataWorkTool(name), name).toBe(true);
    }
    for (const name of ['read_file', 'gmail_search', 'job_update', 'jobs', 'save_product_document', 'mcp_call_tool']) {
      expect(isDataWorkTool(name), name).toBe(false);
    }
  });

  it('decides at start from the goal and title, or from what the caller knows', () => {
    expect(jobs.start({ goal: 'get both up & fresh', title: 'Repair both dashboard refreshes' }).dataWork).toBe(true);
    expect(jobs.start({ goal: 'summarize my week' }).dataWork).toBe(false);
    expect(jobs.start({ goal: 'get both up & fresh', dataWork: true }).dataWork).toBe(true);
  });

  it('becomes data work the first time the job records a dataset, dashboard, ETL result or run, and stays so', () => {
    const record = [
      (id: string) => jobs.recordDataset(id, { datasetId: 'ds_prep_a' }),
      (id: string) => jobs.recordDashboard(id, { dashboardId: 'dash_a' }),
      (id: string) => jobs.recordFile(id, '/tmp/etl-results/run_1.tsv', 'ETL run 1'),
      (id: string) => jobs.addWatch({ runId: '13230001', jobId: id, source: 'run_query' }),
      (id: string) => jobs.addDashboardWait({ runId: 'run_abcd1234', jobId: id, dashboardId: 'dash_a' }),
    ];
    for (const step of record) {
      const job = jobs.start({ goal: 'tidy my notes' });
      expect(job.dataWork).toBe(false);
      step(job.id);
      expect(jobs.get(job.id)!.dataWork).toBe(true);
    }
    const job = jobs.start({ goal: 'tidy my notes' });
    jobs.markDataWork(job.id);
    jobs.update(job.id, { goal: 'tidy my notes again', notes: ['no data here'] });
    expect(jobs.get(job.id)!.dataWork).toBe(true);
  });

  it('marks data work from a recorded tool outcome', () => {
    const job = jobs.start({ goal: 'tidy my notes' });
    recordToolOutcome(jobs, job.id, 'configure_analytics_widget_source', JSON.stringify({ dashboardId: 'dash_b' }), JSON.stringify({ ok: true }));
    expect(jobs.get(job.id)!.dataWork).toBe(true);
  });

  it('says so in the job\'s brief, only for a data job', () => {
    const data = jobs.start({ goal: 'fix the dashboard' });
    const general = jobs.start({ goal: 'summarize my week' });
    expect(formatChatJobBlock(jobs.get(data.id)!, [])).toContain('Data work: BotBoy marked this job as data work');
    expect(formatChatJobBlock(jobs.get(general.id)!, [])).not.toContain('Data work:');
  });

  it('marks data work once on upgrade, from words, recorded work or runs', () => {
    const db = storage.getDb();
    const byWords = jobs.start({ goal: 'fix the dashboard' });
    const byRecord = jobs.start({ goal: 'get both up & fresh' });
    jobs.recordDataset(byRecord.id, { datasetId: 'ds_prep_b' });
    const byRun = jobs.start({ goal: 'get it done' });
    jobs.addWatch({ runId: '424242', jobId: byRun.id, source: 'run_query' });
    const general = jobs.start({ goal: 'summarize my week' });
    // A store from before the column: drop it, then open the store again.
    db.exec('ALTER TABLE chat_jobs DROP COLUMN data_work');
    const upgraded = createChatJobStore(db);
    expect(upgraded.get(byWords.id)!.dataWork).toBe(true);
    expect(upgraded.get(byRecord.id)!.dataWork).toBe(true);
    expect(upgraded.get(byRun.id)!.dataWork).toBe(true);
    expect(upgraded.get(general.id)!.dataWork).toBe(false);
  });
});
