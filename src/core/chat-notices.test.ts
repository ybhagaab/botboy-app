import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { normalizeChatNotice, noticeSentence, parseChatNotice, postChatNotice } from './chat-notices.js';

// Token-shaped strings are built at run time (no secret-looking literals in the repo).
const QUERY_SECRET = 'to' + 'ken=' + 'abc123' + 'secretvalue';
const JWT = 'ey' + 'J' + 'hbGciOi' + '.eyJzdWIi' + '.c2lnbmF0dXJl';

const base = { topic: 'midway', state: 'open', severity: 'warning', title: 'Midway sign-in needed' };

describe('normalizeChatNotice', () => {
  it('fills the defaults: version 1, key = topic, no labels', () => {
    expect(normalizeChatNotice(base)).toEqual({ v: 1, key: 'midway', topic: 'midway', state: 'open', severity: 'warning', title: 'Midway sign-in needed', labels: [] });
  });

  it('rejects an unknown topic, state or severity, and an empty title', () => {
    expect(normalizeChatNotice({ ...base, topic: 'sql' })).toBeNull();
    expect(normalizeChatNotice({ ...base, state: 'pending' })).toBeNull();
    expect(normalizeChatNotice({ ...base, severity: 'critical' })).toBeNull();
    expect(normalizeChatNotice({ ...base, title: '   ' })).toBeNull();
    expect(normalizeChatNotice(null)).toBeNull();
    expect(normalizeChatNotice('notice')).toBeNull();
  });

  it('bounds every field and keeps labels unique (at most 6)', () => {
    const notice = normalizeChatNotice({
      ...base,
      title: 'T'.repeat(200),
      labels: ['GRASP', 'GRASP', 'Slack', '', 'L'.repeat(80), 'a', 'b', 'c', 'd'],
      next: 'N'.repeat(400),
      detail: 'D'.repeat(5_000),
    })!;
    expect(notice.title).toHaveLength(60);
    expect(notice.labels).toEqual(['GRASP', 'Slack', 'L'.repeat(28), 'a', 'b', 'c']);
    expect(notice.next).toHaveLength(160);
    expect(notice.detail!.length).toBeLessThanOrEqual(1_200);
  });

  it('plain detail keeps its lines but reduces URLs to their host and redacts secrets', () => {
    const notice = normalizeChatNotice({ ...base, detail: `Failed at https://midway-auth.amazon.com/SSO/redirect?${QUERY_SECRET}\nSecond line ${JWT}` })!;
    expect(notice.detail).toBe('Failed at <midway-auth.amazon.com>\nSecond line [REDACTED_TOKEN]');
    expect(JSON.stringify(notice)).not.toContain('secretvalue');
  });

  it('Markdown detail stays Markdown, longer, and is still redacted', () => {
    const notice = normalizeChatNotice({ ...base, topic: 'dashboard-refresh', detailMarkdown: true, detail: `**Why**\n\n- ${QUERY_SECRET}\n${'x'.repeat(7_000)}` })!;
    expect(notice.detailMarkdown).toBe(true);
    expect(notice.detail!.startsWith('**Why**\n\n- token=[REDACTED]')).toBe(true);
    expect(notice.detail!.length).toBe(6_000);
    expect(normalizeChatNotice({ ...base, detailMarkdown: true })).not.toHaveProperty('detailMarkdown'); // nothing to draw
  });

  it('keeps only code-owned actions; an open_route action needs an in-app route', () => {
    expect(normalizeChatNotice({ ...base, action: { kind: 'midway_reauth', label: 'Re-authenticate' } })!.action)
      .toEqual({ kind: 'midway_reauth', label: 'Re-authenticate' });
    expect(normalizeChatNotice({ ...base, action: { kind: 'open_route', label: 'Open GRASP', route: '#/connections/grasp-m365' } })!.action)
      .toEqual({ kind: 'open_route', label: 'Open GRASP', route: '#/connections/grasp-m365' });
    for (const route of ['https://example.com', 'javascript:alert(1)', '#/x" onclick="y', '/connections', '']) {
      expect(normalizeChatNotice({ ...base, action: { kind: 'open_route', label: 'Open', route } })).not.toHaveProperty('action');
    }
    expect(normalizeChatNotice({ ...base, action: { kind: 'run_command', label: 'Run' } })).not.toHaveProperty('action');
    expect(normalizeChatNotice({ ...base, action: { kind: 'midway_reauth', label: '' } })).not.toHaveProperty('action');
    expect(normalizeChatNotice({ ...base, action: { kind: 'midway_reauth', label: 'R'.repeat(50) } })!.action!.label).toHaveLength(32);
  });

  it('a key must look like one; otherwise the topic is the key', () => {
    expect(normalizeChatNotice({ ...base, topic: 'connection', key: 'connection:slack' })!.key).toBe('connection:slack');
    expect(normalizeChatNotice({ ...base, topic: 'connection', key: 'bad key with spaces' })!.key).toBe('connection');
    expect(normalizeChatNotice({ ...base, topic: 'connection', key: '<script>' })!.key).toBe('connection');
  });
});

describe('noticeSentence and parseChatNotice', () => {
  it('writes "Title (labels). Next" for readers that are not the panel', () => {
    expect(noticeSentence(normalizeChatNotice({ ...base, labels: ['GRASP', 'Slack'], next: 'Run mwinit.' })!))
      .toBe('Midway sign-in needed (GRASP, Slack). Run mwinit.');
    expect(noticeSentence(normalizeChatNotice(base)!)).toBe('Midway sign-in needed.');
  });

  it('a damaged stored value reads as no notice', () => {
    expect(parseChatNotice(null)).toBeNull();
    expect(parseChatNotice('{not json')).toBeNull();
    expect(parseChatNotice(JSON.stringify({ ...base, topic: 'nope' }))).toBeNull();
    expect(parseChatNotice(JSON.stringify(base))).toMatchObject({ v: 1, title: 'Midway sign-in needed' });
  });
});

describe('postChatNotice', () => {
  let storage: StorageLayer;
  beforeEach(() => { storage = createStorage(':memory:'); storage.initialize(); });
  afterEach(() => { try { storage.close(); } catch { /* closed by the test */ } });

  const rows = () => storage.getDb().prepare('SELECT id, role, content, notice_json, job_id FROM chat_messages').all() as any[];

  it('writes one assistant row with the sentence and the notice, in the main chat or a job thread', () => {
    const id = postChatNotice(storage.getDb(), { ...base, topic: 'midway', labels: ['GRASP'], next: 'Run mwinit.' } as any);
    const jobRow = postChatNotice(storage.getDb(), { topic: 'terminal', state: 'info', severity: 'info', title: 'Terminal ended' }, { jobId: 'job-1' });
    expect(id).toMatch(/^notice-\d+-[0-9a-f]{8}$/);
    expect(jobRow).toMatch(/^notice-/);
    const [main, job] = rows();
    expect(main).toMatchObject({ id, role: 'assistant', content: 'Midway sign-in needed (GRASP). Run mwinit.', job_id: null });
    expect(JSON.parse(main.notice_json)).toMatchObject({ v: 1, key: 'midway', labels: ['GRASP'], next: 'Run mwinit.' });
    expect(job).toMatchObject({ content: 'Terminal ended.', job_id: 'job-1' });
  });

  it('a malformed notice writes nothing, and a failed write never throws', () => {
    expect(postChatNotice(storage.getDb(), { ...base, topic: 'nope' } as any)).toBeNull();
    expect(rows()).toHaveLength(0);
    const db = storage.getDb();
    storage.close();
    expect(postChatNotice(db, base as any)).toBeNull();
  });
});
