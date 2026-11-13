import { describe, expect, it } from 'vitest';
import { createPromptManager } from './prompt-manager.js';

/**
 * Disk in data jobs (owner approval 2026-10-29, job #3's storage question): the files workspace on this Mac is the storage, a
 * one-tap answer is what BotBoy does when tapped, and a job deletes its own working files only through delete_working_file.
 */
describe('disk guidance and tools', () => {
  const prompt = createPromptManager().getSystemPrompt('chat');
  const names = (context: Record<string, unknown> = {}) => createPromptManager().getToolDefinitions('chat', context as any).map(tool => tool.function.name);
  const definition = (name: string) => createPromptManager().getToolDefinitions('chat', { jobTurn: true } as any).find(tool => tool.function.name === name)!;

  it('the files workspace on this Mac is the storage; never ask for dedicated or external storage', () => {
    expect(prompt).toContain('- Disk: downloads and working files go in the files workspace, on this Mac\'s own disk. That is the storage: use it without asking, and never ask the owner for dedicated or external storage.');
    expect(prompt).toContain('keep at least 25 GiB free');
    expect(prompt).toContain('one part at a time, compress each part (gzip -k), and in a job delete the raw copy with delete_working_file');
    expect(prompt).toContain('offer choices BotBoy carries out itself (for example "Use up to 50 GiB of this Mac\'s disk", "Narrow the scope")');
  });

  it('one-tap answers are worded as what BotBoy will do', () => {
    expect(prompt).toContain('add 2-4 one-tap options when there are clear choices, each worded as what BotBoy will do when it is tapped');
    const jobUpdate = definition('job_update');
    expect(jobUpdate.function.description).toContain('each worded as what BotBoy will do when it is tapped');
    expect((jobUpdate.function.parameters as any).properties.options.description).toContain('never something only the owner can do');
  });

  it('delete_working_file is offered only in a job\'s turns; run_command says honestly what it blocks', () => {
    expect(names()).not.toContain('delete_working_file');
    expect(names({ jobTurn: true })).toContain('delete_working_file');
    expect(definition('delete_working_file').function.description).toContain('BotBoy decompresses keptCopy and checks it holds exactly the same bytes before deleting');
    const runCommand = definition('run_command').function.description;
    expect(runCommand).toContain('Blocked: recursive deletes (rm -r), rmdir, unlink, sudo and system commands; in a job\'s automatic turns every delete');
    expect(runCommand).not.toContain('Blocked: rm, sudo, rmdir');
    expect(prompt).not.toContain('Blocked: rm, sudo.');
  });
});
