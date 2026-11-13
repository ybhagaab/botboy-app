import { describe, expect, it } from 'vitest';
import { createPromptManager, JOB_UPDATES_GUIDANCE } from './prompt-manager.js';

/**
 * Jobs and the main chat (PARALLEL_JOBS_PLAN.md §11, owner decisions 2026-11-08): the main chat does the work itself unless it
 * will outlast the reply, reads and steers jobs with the jobs tool, and a finished job's closing reply is its report there.
 * Four of the owner's first eleven jobs were quick work, handed off because "takes several steps" stood in three places.
 */
describe('jobs guidance for the main chat', () => {
  const prompts = [
    createPromptManager().getSystemPrompt('chat'),
    createPromptManager().getSystemPrompt('chat', { amazonEmployee: false } as any),
  ];
  const definition = (name: string, context: Record<string, unknown>) => createPromptManager()
    .getToolDefinitions('chat', context as any).find(tool => tool.function.name === name)!;

  it('hands work off only when it will outlast the reply', () => {
    for (const prompt of prompts) {
      expect(prompt).toContain('The main chat (no ACTIVE JOB block) is the front desk and does the work itself');
      expect(prompt).toContain('Hand work off with job_update start (a 2-5 word title; model only when the owner named one) only when it will outlast this reply');
      expect(prompt).toContain('never hand off just in case');
      expect(prompt).toContain('its report comes back to this chat when it is done');
      expect(prompt).not.toContain('takes several steps');
    }
    const jobUpdate = definition('job_update', { mainChatTurn: true }).function;
    expect(jobUpdate.description).toContain('hand off a new owner request that will outlast this reply');
    expect(jobUpdate.description).toContain('short work you can finish in this reply are not jobs: do them yourself');
    expect(jobUpdate.description).not.toContain('takes several steps');
  });

  it('reads and steers jobs with the jobs tool, and never redoes a job\'s work', () => {
    for (const prompt of prompts) {
      expect(prompt).toContain('read it with jobs read and answer from what it says');
      expect(prompt).toContain('pass that on with jobs message and say in one line what you passed on');
      expect(prompt).toContain('A job\'s report and its replies arrive in this chat by themselves');
      expect(prompt).toContain('never start a new job to answer a question about a job');
    }
    const jobs = definition('jobs', { mainChatTurn: true }).function;
    expect((jobs.parameters as any).properties.action.enum).toEqual(['list', 'read', 'message', 'continue', 'ask_owner']);
    expect(Object.keys((jobs.parameters as any).properties).sort()).toEqual(['action', 'before', 'job', 'options', 'text']);
    expect(jobs.description).toContain('ask_owner (job updates only)');
    expect(jobs.description).toContain('with the job\'s own permissions (sending, publishing and sharing still need the owner)');
    expect(jobs.description).toContain('Never start a new job to answer a question about a job');
  });

  // PARALLEL_JOBS_PLAN.md §12 (owner decision 2026-11-09): the main chat decides on job updates; a dashboard refresh spends no turn.
  it('adds the JOB UPDATES section on the main chat\'s own look at a job only, and tells jobs not to poll a refresh', () => {
    for (const prompt of prompts) {
      expect(prompt).not.toContain('## JOB UPDATES');
      expect(prompt).toContain('- Dashboard refreshes: in a job, BotBoy waits for a refresh of one of its dashboards that is still running');
      expect(prompt).toContain('the job continues when the refresh ends (even if you said continue)');
    }
    const review = createPromptManager().getSystemPrompt('chat', { reviewTurn: true, mainChatTurn: true } as any);
    expect(review).toContain(JOB_UPDATES_GUIDANCE);
    expect(JOB_UPDATES_GUIDANCE).toContain('This turn is not from the owner.');
    expect(JOB_UPDATES_GUIDANCE).toContain('jobs continue');
    expect(JOB_UPDATES_GUIDANCE).toContain('jobs ask_owner');
    expect(JOB_UPDATES_GUIDANCE).toContain('Never do the job\'s work yourself here');
    // The update reaches the main chat before the owner (owner report 2026-11-09): it leads the job and asks him only what is his.
    expect(JOB_UPDATES_GUIDANCE).toContain('The update comes to you before the owner: you lead the job for him, so he is asked only what only he can decide.');
    expect(JOB_UPDATES_GUIDANCE).toContain('Look first, at what blocks the job, not only at the job');
    expect(JOB_UPDATES_GUIDANCE).toContain('is asking you for a new route: give it one');
    expect(JOB_UPDATES_GUIDANCE).toContain('A paused job never stays paused on your watch without one of these calls.');
    expect(JOB_UPDATES_GUIDANCE).not.toContain('leave it for him');
    expect(createPromptManager().getSystemPrompt('chat', { reviewTurn: false, mainChatTurn: true } as any)).not.toContain('## JOB UPDATES');
    // The section comes before the volatile job block, after the library block.
    const ordered = createPromptManager().getSystemPrompt('chat', { reviewTurn: true, knowledgeBlock: 'KNOWLEDGE-BLOCK', jobBlock: 'JOB-BLOCK' } as any);
    expect(ordered.indexOf('KNOWLEDGE-BLOCK')).toBeLessThan(ordered.indexOf('## JOB UPDATES'));
    expect(ordered.indexOf('## JOB UPDATES')).toBeLessThan(ordered.indexOf('JOB-BLOCK'));
  });

  it('a finished job\'s closing reply is its report, with up to three follow-ups', () => {
    for (const prompt of prompts) {
      expect(prompt).toContain('- Finishing a job: when you call job_update done, your closing reply is the job\'s report, posted in the owner\'s main chat.');
      expect(prompt).toContain('put up to 3 follow-ups the owner may want in nextSteps, each worded as what BotBoy will do');
    }
    const jobUpdate = definition('job_update', { jobTurn: true }).function;
    expect(jobUpdate.description).toContain('your closing reply is the job\'s report, posted in the owner\'s main chat');
    const nextSteps = (jobUpdate.parameters as any).properties.nextSteps;
    expect(nextSteps).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(nextSteps.description).toContain('up to 3 follow-ups the owner can start with one tap');
  });
});
