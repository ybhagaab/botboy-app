/**
 * Retroactive demotion of ambient-born projects.
 *
 * Before engagement tiers existed, any watched-channel Slack message could
 * create a project (e.g. a channel-wide announcement the owner never engaged
 * with). Those projects pollute the shelf with work that is not the owner's.
 *
 * A project qualifies for demotion only when EVERY evidence item is an
 * ambient, non-engaged channel Slack message under the current tier rules,
 * and nothing indicates the owner adopted it: no manual brain edit, no open
 * tasks or blockers, not pinned on Today. Demotion is reversible: the project
 * is archived (not deleted), and its evidence returns to the orphan pool
 * where the reconciler ignores ambient messages and channel digests pick
 * them up instead.
 */

import type Database from 'better-sqlite3';
import type { BrainStore } from './brain-store.js';
import { getSetting } from './storage.js';
import { createChannelTierResolver, isPersonallyRelevantSlackMessage } from './engagement.js';
import { isSourceContainerProjectTitle } from './project-scope.js';

export interface AmbientDemotionCandidate {
  projectId: string;
  title: string;
  itemCount: number;
  channels: string[];
  reason: string;
}

export interface AmbientDemotionResult {
  applied: boolean;
  candidates: AmbientDemotionCandidate[];
  archived: number;
  itemsReleased: number;
  skipped: { projectId: string; title: string; reason: string }[];
}

interface EvidenceRow {
  id: string;
  source: string;
  type: string;
  metadata: string | null;
  raw_text: string | null;
}

const normalizeText = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ');

/** A clipboard capture of exactly the project's own title is a UI echo
 * (copying the title out of the dashboard), not evidence the owner adopted
 * the work. It must not shield an otherwise ambient-born project. */
function isTitleEchoClipboard(item: EvidenceRow, projectTitle: string): boolean {
  if (item.source !== 'clipboard' || item.type !== 'clipboard_capture') return false;
  const text = normalizeText(item.raw_text ?? '');
  return text.length > 0 && text === normalizeText(projectTitle);
}

export function demoteAmbientProjects(
  db: Database.Database,
  brainStore: BrainStore,
  opts: { apply?: boolean; includePassive?: boolean } = {},
): AmbientDemotionResult {
  const apply = opts.apply === true;
  // Passive-born (telemetry-only) projects frequently ARE the owner's real
  // solo research — browser/filesystem/clipboard is how uncommunicated work
  // gets captured. They are reported for review but never archived unless
  // explicitly requested per call; the ambient-Slack class remains the only
  // auto-applicable one.
  const applyPassive = apply && opts.includePassive === true;
  const result: AmbientDemotionResult = { applied: apply, candidates: [], archived: 0, itemsReleased: 0, skipped: [] };
  const resolveTier = createChannelTierResolver(db);

  // Pinned projects on Today are explicit owner adoption.
  const todayPrefs = getSetting<{ items?: Record<string, { pinned?: boolean }> }>(db, 'today.attention.v1');
  const pinnedProjectIds = new Set(
    Object.entries(todayPrefs?.items ?? {})
      .filter(([id, pref]) => id.startsWith('project:') && pref?.pinned === true)
      .map(([id]) => id.slice('project:'.length)),
  );

  const itemsFor = db.prepare(
    'SELECT id, source, type, metadata, raw_text FROM work_items WHERE project_id = ?',
  );

  for (const project of brainStore.listProjects()) {
    if (project.status !== 'active' && project.status !== 'paused') continue;
    const items = itemsFor.all(project.id) as EvidenceRow[];
    if (items.length === 0) continue;

    // 'sharepoint' is passive here by design: background document sync must
    // not fake owner engagement. Phase 2 document_comment items get a
    // type-aware engagement exception (see docs/maps/sharepoint.md).
    const PASSIVE_SOURCES = new Set(['app', 'browser', 'clipboard', 'filesystem', 'sharepoint']);
    const channels = new Set<string>();
    let ambientSlackOnly = false;
    let purePassive = false;
    // Source-container titles (a DM, channel, inbox, or window as "project")
    // are illegitimate by title alone: routing already excludes them and their
    // brains are frozen. Dissolving them releases the evidence for
    // topic-based re-routing.
    const sourceContainer = isSourceContainerProjectTitle(project.title);
    if (!sourceContainer) {
      let ambientSlackCount = 0;
      let passiveCount = 0;
      let adopted = false;
      for (const item of items) {
        if (isTitleEchoClipboard(item, project.title)) continue; // UI echo — ignore
        if (item.source === 'slack' && item.type === 'slack_message') {
          let metadata: Record<string, unknown> = {};
          try { metadata = JSON.parse(item.metadata ?? '{}'); } catch { /* legacy rows */ }
          if (isPersonallyRelevantSlackMessage(metadata, resolveTier)) { adopted = true; break; }
          const channelName = typeof metadata.channelName === 'string' ? metadata.channelName : 'unknown';
          channels.add(channelName);
          ambientSlackCount++;
        } else if (item.source === 'sharepoint' && item.type === 'document_comment') {
          // Engaged document comments (the owner wrote one, or one names the
          // owner) are real adoption; other people's comments stay passive
          // like the synced document content itself (map: comments exception).
          let metadata: Record<string, unknown> = {};
          try { metadata = JSON.parse(item.metadata ?? '{}'); } catch { /* legacy rows */ }
          if (metadata.direction === 'sent' || metadata.mentionedMe === 'true') { adopted = true; break; }
          passiveCount++;
        } else if (PASSIVE_SOURCES.has(item.source)) {
          passiveCount++;
        } else {
          adopted = true; // manual, agent, or unknown sources indicate real adoption
          break;
        }
      }
      if (adopted) continue;
      // Exactly one illegitimate-origin class may qualify. Mixed ambient-slack +
      // passive-telemetry projects are left alone: partial telemetry alongside
      // channel discussion often reflects genuine (if uncaptured) involvement.
      ambientSlackOnly = ambientSlackCount > 0 && passiveCount === 0;
      purePassive = passiveCount > 0 && ambientSlackCount === 0;
      if (!ambientSlackOnly && !purePassive) continue;
    }

    if (pinnedProjectIds.has(project.id)) {
      result.skipped.push({ projectId: project.id, title: project.title, reason: 'pinned on Today' });
      continue;
    }
    if (brainStore.hasManualEdit(project.id)) {
      result.skipped.push({ projectId: project.id, title: project.title, reason: 'brain has manual edits' });
      continue;
    }
    const brain = brainStore.read(project.id);
    // Container brains are cross-topic soup by construction; their tasks are
    // misattributed and cannot shield the project. Real commitments re-derive
    // with citations once the evidence lands in its topical home.
    if (ambientSlackOnly) {
      // Ambient-channel discussion is at least human communication; open
      // tasks/blockers may reflect an owner intention we cannot verify, so
      // they block automatic demotion.
      const openTasks = (brain?.tasks ?? []).filter((task) => task.state !== 'done').length;
      const blockers = (brain?.blockers ?? []).length;
      if (openTasks > 0 || blockers > 0) {
        result.skipped.push({
          projectId: project.id,
          title: project.title,
          reason: `has ${openTasks} open task(s) and ${blockers} blocker(s)`,
        });
        continue;
      }
    }
    // purePassive: tasks/blockers were synthesized from telemetry alone, which
    // current rules forbid outright — they cannot shield the project.

    result.candidates.push({
      projectId: project.id,
      title: project.title,
      itemCount: items.length,
      channels: [...channels],
      reason: sourceContainer
        ? 'title names a communication surface (DM/channel/inbox/window), not a work topic; evidence will re-route by topic'
        : purePassive
          ? 'every evidence item is passive telemetry (app/browser/clipboard/filesystem); review manually — may be real solo research'
          : 'every evidence item is an ambient, non-engaged channel message',
    });

    if (!apply || (purePassive && !applyPassive)) continue;

    // Release evidence first, then archive. Direct SQL is deliberate: the
    // batcher's state machine forbids these transitions, but demotion is an
    // explicit owner-approved correction; the project-event trigger records
    // each unassignment so Today's cursor and audits stay consistent.
    // Container evidence goes back to 'extracted' so the librarian re-routes
    // it by topic; ambient/passive evidence goes to 'orphaned' (digest pool).
    const releaseState = sourceContainer ? 'extracted' : 'orphaned';
    const release = db.prepare(
      'UPDATE work_items SET project_id = NULL, process_state = ?, batch_id = NULL WHERE id = ?',
    );
    const tx = db.transaction(() => {
      for (const item of items) {
        release.run(releaseState, item.id);
        result.itemsReleased++;
      }
      if (brain) {
        brainStore.write({ ...brain, status: 'archived', updated: new Date().toISOString() }, project.one_liner ?? undefined);
      } else {
        db.prepare("UPDATE projects SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(project.id);
      }
    });
    tx();
    result.archived++;
  }

  return result;
}
