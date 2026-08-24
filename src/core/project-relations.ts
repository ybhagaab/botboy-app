import type Database from 'better-sqlite3';
import { sharedTitleAnchorTokens, countTitlesMatchingToken } from './project-scope.js';

/**
 * Related projects — deterministic sibling detection.
 *
 * Two projects are "related but distinct" when their scopes demonstrably
 * touch. Routing already computes every signal this engine uses; it just
 * throws the insight away after each placement decision. This engine
 * aggregates those signals into persisted pair rows so the project page,
 * the brain synthesis prompt, and chat can all point at the sibling:
 *
 *   1. Mixed-scope evidence: the brain pass stamps `scope_alert` on items
 *      that lexically anchor a foreign project's scope. Advisory alerts
 *      ("related scopes genuinely touching") are the strongest relatedness
 *      signal; quarantined ones (probable misfiles) still hint weakly.
 *   2. Shared distinctive title vocabulary: both titles anchor the same
 *      subject token (same tokenizer/stemming as routing), weighted by
 *      rarity so a token shared by two titles links them but family words
 *      appearing across ten projects do not link every pair.
 *   3. Shared ambient channels: both projects cross-linked from the same
 *      channel's digests.
 *
 * Everything is lexical/SQL — no model call, so it can run after every
 * interpretation wave. The owner can dismiss a pair; the veto survives
 * recomputes for as long as the pair keeps being detected. Relations are
 * annotations only: they never move evidence and never affect routing.
 */

export interface RelatedProject {
  id: string;
  title: string;
  status: string;
  score: number;
  reasons: string[];
}

export interface RecomputeResult {
  pairs: number;
  created: number;
  removed: number;
}

export interface ProjectRelationsEngine {
  recompute(): RecomputeResult;
  /** Non-dismissed relations for one project, strongest first. */
  listForProject(projectId: string): RelatedProject[];
  dismiss(projectId: string, otherProjectId: string): boolean;
  restore(projectId: string, otherProjectId: string): boolean;
}

interface ProjectLite {
  id: string;
  title: string;
  founding_scope: string | null;
  status: string;
}

interface PairSignal {
  advisoryAlerts: number;
  quarantinedAlerts: number;
  sharedTokens: string[];
  rarestTokenSpread: number;
  sharedChannels: string[];
}

const RELATION_THRESHOLD = 3;
const MAX_RELATIONS_PER_PROJECT = 4;

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function createProjectRelationsEngine(db: Database.Database): ProjectRelationsEngine {
  function activeProjects(): ProjectLite[] {
    return db.prepare(
      "SELECT id, title, founding_scope, status FROM projects WHERE status IN ('active','paused')",
    ).all() as ProjectLite[];
  }

  function collectSignals(projects: ProjectLite[]): Map<string, PairSignal> {
    const byId = new Map(projects.map((p) => [p.id, p]));
    // scope_alert titles are anchor strings (founding scope or title at the
    // time of the pass) — resolve against both, normalized.
    const idByAnchor = new Map<string, string>();
    for (const p of projects) {
      idByAnchor.set(normalizeTitle(p.title), p.id);
      if (p.founding_scope) idByAnchor.set(normalizeTitle(p.founding_scope), p.id);
    }

    const signals = new Map<string, PairSignal>();
    const signalFor = (a: string, b: string): PairSignal => {
      const [x, y] = pairKey(a, b);
      const key = `${x}|${y}`;
      let s = signals.get(key);
      if (!s) {
        s = { advisoryAlerts: 0, quarantinedAlerts: 0, sharedTokens: [], rarestTokenSpread: 0, sharedChannels: [] };
        signals.set(key, s);
      }
      return s;
    };

    // Signal 1 — mixed-scope evidence stamped by the brain pass.
    const alertRows = db.prepare(
      "SELECT project_id, scope_alert FROM work_items WHERE scope_alert IS NOT NULL AND project_id IS NOT NULL AND project_id != ''",
    ).all() as Array<{ project_id: string; scope_alert: string }>;
    for (const row of alertRows) {
      if (!byId.has(row.project_id)) continue;
      let alert: { titles?: unknown; quarantined?: unknown } | null = null;
      try { alert = JSON.parse(row.scope_alert); } catch { continue; }
      const titles = Array.isArray(alert?.titles) ? alert!.titles.map(String) : [];
      for (const foreignTitle of titles) {
        const otherId = idByAnchor.get(normalizeTitle(foreignTitle));
        if (!otherId || otherId === row.project_id) continue;
        const s = signalFor(row.project_id, otherId);
        if (alert?.quarantined) s.quarantinedAlerts++;
        else s.advisoryAlerts++;
      }
    }

    // Signal 2 — shared distinctive title vocabulary, weighted by rarity.
    const allTitles = projects.map((p) => p.title);
    for (let i = 0; i < projects.length; i++) {
      for (let j = i + 1; j < projects.length; j++) {
        const shared = sharedTitleAnchorTokens(projects[i].title, projects[j].title);
        if (shared.length === 0) continue;
        const spreads = shared.map((token) => countTitlesMatchingToken(token, allTitles));
        const rarest = Math.min(...spreads);
        const s = signalFor(projects[i].id, projects[j].id);
        s.sharedTokens = shared.slice(0, 3);
        s.rarestTokenSpread = rarest;
      }
    }

    // Signal 3 — both projects cross-linked from the same ambient channel.
    const channelRows = db.prepare(`
      SELECT a.project_id AS pa, b.project_id AS pb, a.channel_name AS channel
      FROM project_cross_links a
      JOIN project_cross_links b
        ON a.channel_id = b.channel_id AND a.project_id < b.project_id
      GROUP BY a.project_id, b.project_id, a.channel_id
    `).all() as Array<{ pa: string; pb: string; channel: string }>;
    for (const row of channelRows) {
      if (!byId.has(row.pa) || !byId.has(row.pb)) continue;
      const s = signalFor(row.pa, row.pb);
      if (!s.sharedChannels.includes(row.channel)) s.sharedChannels.push(row.channel);
    }

    return signals;
  }

  function scorePair(s: PairSignal): { score: number; reasons: string[] } {
    let score = 0;
    const reasons: string[] = [];
    if (s.advisoryAlerts > 0) {
      score += Math.min(9, s.advisoryAlerts * 3);
      reasons.push(`${s.advisoryAlerts} evidence item${s.advisoryAlerts === 1 ? '' : 's'} reference${s.advisoryAlerts === 1 ? 's' : ''} both scopes`);
    }
    if (s.quarantinedAlerts > 0) {
      score += Math.min(3, s.quarantinedAlerts);
      reasons.push(`${s.quarantinedAlerts} quarantined item${s.quarantinedAlerts === 1 ? '' : 's'} anchor${s.quarantinedAlerts === 1 ? 's' : ''} both scopes`);
    }
    if (s.sharedTokens.length > 0 && s.rarestTokenSpread > 0) {
      const tokenScore = s.rarestTokenSpread <= 3 ? 3 : s.rarestTokenSpread <= 6 ? 1 : 0;
      if (tokenScore > 0) {
        score += tokenScore;
        reasons.push(`titles share ${s.sharedTokens.map((t) => `“${t}”`).join(', ')}`);
      }
    }
    if (s.sharedChannels.length > 0) {
      score += Math.min(2, s.sharedChannels.length);
      reasons.push(`both discussed in ${s.sharedChannels.slice(0, 2).map((c) => `#${c.replace(/^#/, '')}`).join(', ')}`);
    }
    return { score, reasons };
  }

  function recompute(): RecomputeResult {
    const projects = activeProjects();
    const signals = collectSignals(projects);

    const detected = new Map<string, { a: string; b: string; score: number; reasons: string[] }>();
    for (const [key, signal] of signals) {
      const { score, reasons } = scorePair(signal);
      if (score < RELATION_THRESHOLD) continue;
      const [a, b] = key.split('|');
      detected.set(key, { a, b, score, reasons });
    }

    // Keep each project's list short: strongest pairs win, the rest are
    // dropped this cycle (they resurface if stronger pairs disappear).
    const perProject = new Map<string, number>();
    const kept = new Map<string, { a: string; b: string; score: number; reasons: string[] }>();
    for (const entry of [...detected.values()].sort((x, y) => y.score - x.score)) {
      const countA = perProject.get(entry.a) ?? 0;
      const countB = perProject.get(entry.b) ?? 0;
      if (countA >= MAX_RELATIONS_PER_PROJECT || countB >= MAX_RELATIONS_PER_PROJECT) continue;
      perProject.set(entry.a, countA + 1);
      perProject.set(entry.b, countB + 1);
      kept.set(`${entry.a}|${entry.b}`, entry);
    }

    const now = new Date().toISOString();
    let created = 0;
    let removed = 0;
    const apply = db.transaction(() => {
      const existing = db.prepare('SELECT project_a, project_b FROM project_relations').all() as Array<{ project_a: string; project_b: string }>;
      const existingKeys = new Set(existing.map((r) => `${r.project_a}|${r.project_b}`));
      const upsert = db.prepare(`
        INSERT INTO project_relations (project_a, project_b, score, reasons, detected_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_a, project_b)
        DO UPDATE SET score = excluded.score, reasons = excluded.reasons, updated_at = excluded.updated_at
      `);
      for (const entry of kept.values()) {
        if (!existingKeys.has(`${entry.a}|${entry.b}`)) created++;
        upsert.run(entry.a, entry.b, entry.score, JSON.stringify(entry.reasons), now, now);
      }
      const remove = db.prepare('DELETE FROM project_relations WHERE project_a = ? AND project_b = ?');
      for (const key of existingKeys) {
        if (kept.has(key)) continue;
        const [a, b] = key.split('|');
        remove.run(a, b);
        removed++;
      }
    });
    apply();

    return { pairs: kept.size, created, removed };
  }

  function listForProject(projectId: string): RelatedProject[] {
    const rows = db.prepare(`
      SELECT r.project_a, r.project_b, r.score, r.reasons,
             p.id AS other_id, p.title AS other_title, p.status AS other_status
      FROM project_relations r
      JOIN projects p ON p.id = CASE WHEN r.project_a = ? THEN r.project_b ELSE r.project_a END
      WHERE (r.project_a = ? OR r.project_b = ?) AND r.dismissed = 0
      ORDER BY r.score DESC
    `).all(projectId, projectId, projectId) as Array<{
      score: number; reasons: string; other_id: string; other_title: string; other_status: string;
    }>;
    return rows.map((row) => {
      let reasons: string[] = [];
      try { reasons = JSON.parse(row.reasons); } catch { /* tolerate */ }
      return { id: row.other_id, title: row.other_title, status: row.other_status, score: row.score, reasons };
    });
  }

  function setDismissed(projectId: string, otherProjectId: string, dismissed: 0 | 1): boolean {
    const [a, b] = pairKey(projectId, otherProjectId);
    const result = db.prepare(
      'UPDATE project_relations SET dismissed = ?, updated_at = ? WHERE project_a = ? AND project_b = ?',
    ).run(dismissed, new Date().toISOString(), a, b);
    return result.changes > 0;
  }

  return {
    recompute,
    listForProject,
    dismiss: (projectId, otherProjectId) => setDismissed(projectId, otherProjectId, 1),
    restore: (projectId, otherProjectId) => setDismissed(projectId, otherProjectId, 0),
  };
}
