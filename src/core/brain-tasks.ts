/**
 * Brain-task mutations shared by the chat tools (tool-executor) and the
 * project-page task actions (pipeline router). One matching rule everywhere:
 * exact normalized text, or unique substring — ambiguity and misses fail
 * with actionable messages instead of guessing (owner feature 2026-08-27:
 * clickable task rows with Done / Discard / "help me complete" actions).
 */
import type { BrainStore } from './brain-store.js';

export type BrainTaskState = 'todo' | 'doing' | 'blocked' | 'done';

export const normalizeTaskText = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

export interface BrainTaskMutation {
  ok: boolean;
  message: string;
}

type TaskMatch =
  | { kind: 'match'; task: { text: string; state: string } }
  | { kind: 'error'; error: string };

function matchTask(tasks: Array<{ text: string; state: string }>, taskText: string): TaskMatch {
  const wanted = normalizeTaskText(taskText);
  if (!wanted) return { kind: 'error', error: 'Error: task text required' };
  const matches = tasks.filter((task) =>
    normalizeTaskText(task.text) === wanted || normalizeTaskText(task.text).includes(wanted));
  if (matches.length === 0) {
    return { kind: 'error', error: `Error: no task matching "${taskText.slice(0, 80)}"` };
  }
  if (matches.length > 1) {
    return { kind: 'error', error: `Error: ${matches.length} tasks match — be more specific. Matches: ${matches.map((t) => t.text.slice(0, 70)).join(' | ')}` };
  }
  return { kind: 'match', task: matches[0] };
}

export function setBrainTaskState(
  brainStore: BrainStore,
  projectId: string,
  taskText: string,
  state: string,
): BrainTaskMutation {
  if (!['todo', 'doing', 'blocked', 'done'].includes(state)) {
    return { ok: false, message: 'Error: state must be todo|doing|blocked|done' };
  }
  const brain = brainStore.read(projectId);
  if (!brain) return { ok: false, message: `Error: project ${projectId} not found` };
  const found = matchTask(brain.tasks, taskText);
  if (found.kind === 'error') {
    const listing = found.error.startsWith('Error: no task matching')
      ? `${found.error} in ${brain.title}. Tasks: ${brain.tasks.map((t) => t.text.slice(0, 60)).join(' | ') || '(none)'}`
      : found.error;
    return { ok: false, message: listing };
  }
  found.task.state = state;
  brainStore.write({ ...brain, updated: new Date().toISOString() }, brainStore.getProject(projectId)?.one_liner ?? undefined);
  return { ok: true, message: `OK: task "${found.task.text.slice(0, 80)}" in ${brain.title} → ${state}` };
}

/**
 * Remove the task line entirely. The brain updater's fail-closed task
 * boundary preserves existing tasks by exact text and admits new ones only
 * with fresh evidence citations — so a removed task does not silently
 * resurrect on rebuild; it can only return if new evidence re-proposes it.
 */
export function removeBrainTask(
  brainStore: BrainStore,
  projectId: string,
  taskText: string,
): BrainTaskMutation {
  const brain = brainStore.read(projectId);
  if (!brain) return { ok: false, message: `Error: project ${projectId} not found` };
  const found = matchTask(brain.tasks, taskText);
  if (found.kind === 'error') {
    const listing = found.error.startsWith('Error: no task matching')
      ? `${found.error} in ${brain.title}. Tasks: ${brain.tasks.map((t) => t.text.slice(0, 60)).join(' | ') || '(none)'}`
      : found.error;
    return { ok: false, message: listing };
  }
  const removed = found.task;
  const tasks = brain.tasks.filter((task) => task !== removed);
  brainStore.write({ ...brain, tasks, updated: new Date().toISOString() }, brainStore.getProject(projectId)?.one_liner ?? undefined);
  return { ok: true, message: `OK: discarded task "${removed.text.slice(0, 80)}" from ${brain.title}` };
}
