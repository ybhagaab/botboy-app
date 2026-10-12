import { describe, expect, it, vi } from 'vitest';
import { withGdriveChatTools, GDRIVE_GUIDANCE_BLOCK } from './gdrive-chat-tools.js';
import { fakeGmailConnection, type FakeGmailAccount } from './gmail-connection.fake.js';
import { createFakeDrive } from './gdrive-api.fake.js';
import { GDRIVE_DOC_MIME } from './gdrive-api.js';
import { createPromptManager } from './prompt-manager.js';
import type { ToolExecutionContext } from './tool-executor.js';

const call = (name: string, args: object) => ({ id: 'c1', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
const live: ToolExecutionContext = { callerKind: 'interactive', currentUserMessage: 'find my plan doc' } as ToolExecutionContext;

function setup(canReadDrive = true) {
  const drive = createFakeDrive();
  drive.put({ id: 'doc1xxxxxx', name: 'Launch plan', mimeType: GDRIVE_DOC_MIME, exports: { 'text/markdown': 'Launch plan body text' } });
  drive.put({ id: 'cred1xxxxx', name: 'credentials.json', mimeType: 'application/json', content: Buffer.from('{"secret":"x"}') });
  const account: FakeGmailAccount = { id: 'default', email: 'jane@gmail.com', canReadDrive, client: {} as any };
  const readFile = vi.fn(async (_id: string, fileId: string) => {
    const file = await drive.getFile(fileId);
    const withheld = file.name === 'credentials.json';
    return { file, content: withheld ? 'Content withheld' : 'SOURCE: Google Drive\nLaunch plan body text', tier: withheld ? 'withheld' : 'full', withheld };
  });
  const base = { executeTool: vi.fn(async () => ({ toolCallId: 'c1', content: 'base', isError: false })) };
  const executor = withGdriveChatTools(base as any, {
    connection: fakeGmailConnection([account]),
    drive: { clientFor: () => drive, readFile } as any,
  });
  return { executor, base, readFile, drive };
}

describe('Google Drive chat tools', () => {
  it('search and read in a live owner turn, inside the untrusted envelope', async () => {
    const { executor } = setup();
    const found = JSON.parse((await executor.executeTool(call('gdrive_search', { query: 'Launch' }), live)).content);
    expect(found.trust).toBe('external_untrusted_data');
    expect(found.result.files.map((file: any) => file.fileId)).toEqual(['doc1xxxxxx']);
    const read = JSON.parse((await executor.executeTool(call('gdrive_read', { fileId: 'doc1xxxxxx', maxChars: 10 }), live)).content);
    expect(read.result).toMatchObject({ ok: true, truncated: true });
    expect(read.result.text).toHaveLength(10);
  });

  it('a sensitive file reads [withheld]', async () => {
    const { executor } = setup();
    const read = JSON.parse((await executor.executeTool(call('gdrive_read', { fileId: 'cred1xxxxx' }), live)).content);
    expect(read.result.text).toBe('[withheld]');
  });

  it('refuses unattended and continuation runs, and accounts without Drive', async () => {
    const { executor, readFile } = setup();
    for (const context of [{ callerKind: 'background' }, { callerKind: 'continuation', currentUserMessage: 'x' }, undefined] as Array<ToolExecutionContext | undefined>) {
      const result = await executor.executeTool(call('gdrive_read', { fileId: 'doc1xxxxxx' }), context);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).code).toBe('owner_turn_required');
    }
    expect(readFile).not.toHaveBeenCalled();
    const owned = await executor.executeTool(call('gdrive_search', { query: 'x' }), { ownerStartedRun: true, currentUserMessage: 'edit passage' } as ToolExecutionContext);
    expect(owned.isError).toBe(false);
    const none = setup(false);
    expect(JSON.parse((await none.executor.executeTool(call('gdrive_search', { query: 'x' }), live)).content).code).toBe('drive_not_connected');
  });

  it('bounds maxChars and limit, and passes other tools through', async () => {
    const { executor, base } = setup();
    expect((await executor.executeTool(call('gdrive_read', { fileId: 'doc1xxxxxx', maxChars: 60_001 }), live)).isError).toBe(true);
    expect((await executor.executeTool(call('gdrive_search', { query: 'x', limit: 21 }), live)).isError).toBe(true);
    await executor.executeTool(call('query_db', {}), live);
    expect(base.executeTool).toHaveBeenCalled();
  });
});

describe('prompt manager: Drive tools and guidance only while Drive is connected', () => {
  it('offers gdrive_* and the ## Google Drive block only with driveConnected', () => {
    const manager = createPromptManager();
    const names = (context: object) => manager.getToolDefinitions('chat', context as any).map(def => def.function.name);
    expect(names({})).not.toContain('gdrive_search');
    expect(names({ driveConnected: true })).toEqual(expect.arrayContaining(['gdrive_search', 'gdrive_read']));
    expect(names({ driveConnected: true, amazonEmployee: false })).toContain('gdrive_read');
    expect(manager.getSystemPrompt('chat', { nodes: [] } as any)).not.toContain('## Google Drive');
    expect(manager.getSystemPrompt('chat', { nodes: [], driveConnected: true } as any)).toContain(GDRIVE_GUIDANCE_BLOCK);
  });
});
