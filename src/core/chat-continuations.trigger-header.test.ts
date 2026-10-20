import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageLayer } from './storage.js';
import { createChatJobStore, type ChatJobStore } from './chat-jobs.js';
import {
  CONTINUATION_TRIGGER_HEADER, buildContinuationTrigger, buildSelfContinuationTrigger, isContinuationTrigger,
} from './chat-continuations.js';

/**
 * Every continuation trigger starts with one line, and that line is how the chat history window tells BotBoy's own messages from the
 * owner's (chat-history-window.ts). If a builder ever stopped starting with it, its triggers would count as the owner's messages and
 * push the owner's real ones out again.
 */
describe('continuation trigger header', () => {
  let storage: StorageLayer;
  let jobs: ChatJobStore;
  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    jobs = createChatJobStore(storage.getDb());
  });
  afterEach(() => storage.close());

  it('is the first line of both triggers, and recognises them', () => {
    const job = jobs.start({ goal: 'Weekly players dashboard' });
    jobs.addWatch({ runId: '7', jobId: job.id, source: 'run_query', purpose: 'weekly' });
    jobs.finishWatch('7', { remoteStatus: 'SUCCESS', savedTo: '/x/run_7.tsv', rowCount: 3 });
    const finished = jobs.watchesForJob(job.id);
    const triggers = [
      buildContinuationTrigger(jobs.get(job.id)!, finished, finished).message,
      buildSelfContinuationTrigger(jobs.get(job.id)!, 'The previous turn said the job continues.', []).message,
      buildSelfContinuationTrigger(jobs.get(job.id)!, 'The previous turn ended without saying whether the job is done.', []).message,
    ];
    for (const trigger of triggers) {
      expect(trigger.split('\n')[0]).toBe(CONTINUATION_TRIGGER_HEADER);
      expect(isContinuationTrigger(trigger)).toBe(true);
    }
  });

  it('never mistakes the owner\'s words for a trigger', () => {
    for (const text of ['start work on this', '', `Quoting it: ${CONTINUATION_TRIGGER_HEADER}`, ` ${CONTINUATION_TRIGGER_HEADER}`]) {
      expect(isContinuationTrigger(text), JSON.stringify(text)).toBe(false);
    }
    for (const value of [null, undefined, 42, {}, [CONTINUATION_TRIGGER_HEADER]]) expect(isContinuationTrigger(value)).toBe(false);
  });
});
