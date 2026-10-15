/**
 * Reconciles and the writer (P2 review R4): a History reconcile fired by another caller (a second request, the Settings
 * page, knowledge_list) while the writer commits must never record BotBoy's own write as "edited outside BotBoy" or delete
 * its intent record; and a commit that fails ends cleanly, so later reconciles still see outside edits.
 * Real library, journal and changes store on a temp folder with a space in its name; scripted model; synthetic content.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeHarness, type Harness } from './knowledge-write.testutil.js';

let h: Harness;
const ADD_NOTE = { set: 'shop-data', file: 'orders.md', mode: 'edit', edits: [{ find: '- Always filter by channel.', replace: '- Always filter by channel.\n- Use placeholders.' }] };
beforeEach(async () => { h = await makeHarness(); });
afterEach(() => { h.close(); fs.rmSync(h.base, { recursive: true, force: true }); });

describe('R4: reconciles that overlap commits', () => {
  it('ten consecutive writes with a reconcile loop running all the while leave ten write entries and no outside or recovered entry', async () => {
    let stop = false;
    const hammer = (async () => {
      while (!stop) {
        await h.history.reconcile({ force: true });
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    for (let index = 0; index < 10; index += 1) {
      const reply = await h.write(h.turn('please add a note to shop-data'), { set: 'shop-data', file: `n${index}.md`, mode: 'create', content: `# n${index}\n\ntext\n` });
      expect(reply.status, `write ${index}`).toBe('applied');
    }
    stop = true;
    await hammer;
    const entries = h.history.list({ limit: 100 });
    expect(entries.filter((entry) => entry.kind === 'write')).toHaveLength(10);
    expect(entries.some((entry) => entry.kind === 'outside' || /recovered|outside/i.test(entry.summary))).toBe(false);
    expect(fs.existsSync(`${h.history.dir}/intent.json`)).toBe(false);
  });

  it('R11: History that cannot be prepared (a full disk) changes nothing and answers a structured error with effect none', async () => {
    await h.history.reconcile({ force: true });
    // The intent record is the first thing the commit writes into History's folder: it is the write that fails.
    const realWrite = fs.promises.writeFile.bind(fs.promises) as (...args: unknown[]) => Promise<void>;
    const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation((async (file: unknown, ...rest: unknown[]) => {
      if (String(file).includes('.intent.json.')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return realWrite(file, ...rest);
    }) as never);
    let reply;
    try { reply = await h.write(h.turn('please add a note to shop-data orders.md'), ADD_NOTE); } finally { spy.mockRestore(); }
    expect(reply).toMatchObject({ ok: false, code: 'internal_error', effect: 'none', message: expect.stringContaining('History could not be prepared'), nextAction: expect.stringContaining('free space') });
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
    expect(h.changes.get(String(reply.changeId))?.status).toBe('staged');
    expect(await h.history.reconcile({ force: true })).toEqual([]);
  });

  it('R11: History that cannot record a write that DID land answers effect unknown, marks the change applied, and the next reconcile finishes the entry', async () => {
    await h.history.reconcile({ force: true });
    const spy = vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
    let reply;
    try { reply = await h.write(h.turn('please add a note to shop-data orders.md'), ADD_NOTE); } finally { spy.mockRestore(); }
    expect(reply).toMatchObject({ ok: false, code: 'internal_error', effect: 'unknown', message: expect.stringContaining('written, but History could not record it'), nextAction: expect.stringContaining('do not repeat') });
    expect(h.read('shop-data/orders.md')).toContain('placeholders');
    expect(h.changes.get(String(reply.changeId))).toMatchObject({ status: 'applied' });
    const found = await h.history.reconcile({ force: true });
    expect(found).toEqual([expect.objectContaining({ kind: 'write', changeId: reply.changeId, summary: expect.stringContaining('recovered') })]);
  });

  it('R11: an Undo whose log line cannot be written reports it; the files are restored', async () => {
    const applied = await h.write(h.turn('please add a note to shop-data orders.md'), ADD_NOTE);
    expect(applied.status).toBe('applied');
    const spy = vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
    let undone;
    try { undone = await h.writer.undo(); } finally { spy.mockRestore(); }
    expect(undone).toMatchObject({ ok: false, code: 'io_error', message: expect.stringContaining('restored the files, but History could not record it') });
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
  });

  it('a commit that fails on disk rolls back, ends its write, and later reconciles still record outside edits', async () => {
    const folder = h.abs('shop-data');
    fs.chmodSync(folder, 0o500);
    let reply;
    try {
      reply = await h.write(h.turn('please add a note to shop-data orders.md'), { set: 'shop-data', file: 'orders.md', mode: 'edit', edits: [{ find: '- Always filter by channel.', replace: '- Always filter by channel.\n- Use placeholders.' }] });
    } finally {
      fs.chmodSync(folder, 0o700);
    }
    expect(reply).toMatchObject({ ok: false, code: 'internal_error' });
    expect(h.read('shop-data/orders.md')).not.toContain('placeholders');
    expect(fs.existsSync(`${h.history.dir}/intent.json`)).toBe(false);
    h.put('shop-data/orders.md', `${h.read('shop-data/orders.md')}\nEdited by hand.\n`);
    const found = await h.history.reconcile({ force: true });
    expect(found.some((entry) => entry.kind === 'outside' && entry.actor === 'outside')).toBe(true);
  });
});
