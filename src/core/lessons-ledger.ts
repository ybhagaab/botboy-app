/**
 * Lessons ledger (LESSONS_LEDGER_PLAN.md) — BotBoy's experiential knowledge
 * loop. A lesson is a VERIFIED, DURABLE, GENERALIZABLE, ACTIONABLE,
 * NON-DUPLICATIVE, SCOPED operating rule learned from live work — the class
 * of knowledge the corpus-statistical preset generator CANNOT derive
 * (transient states, incident narratives, corpus-derivable facts, owner
 * preferences, and unverified hypotheses are explicitly NOT lessons).
 *
 * Two mechanical layers live here; the judgment layer lives in the
 * propose_lesson tool description (the six criteria), and adoption is the
 * owner's approval (nothing loads into briefings until adopted):
 *   - admission gates: known scope shape, one bounded rule, evidence
 *     required;
 *   - dedup-or-recurrence: a re-proposed rule bumps recurrence_count
 *     instead of inserting — a recurring lesson is itself a signal (it is
 *     not loading, or it is wrong).
 *
 * The table is the ledger of record. Adopted lessons render to
 * `<analytics-context>/lessons/<scope>.md` + manifest entries tagged
 * `source: 'lesson'` — the briefing union catalog picks them up exactly
 * like presets, and the onboarding generator never touches them (separate
 * knowledge lifecycles: presets are regenerable, lessons must survive
 * regeneration).
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { resolveAnalyticsContextDir } from './analytics-context.js';

export type LessonStatus = 'proposed' | 'adopted' | 'retired';

export interface Lesson {
  id: string;
  scope: string;
  rule: string;
  evidence: string;
  status: LessonStatus;
  recurrenceCount: number;
  provenance: string;
  firstSeenAt: string;
  lastSeenAt: string;
  adoptedAt: string | null;
}

export type ProposeLessonResult =
  | { ok: true; kind: 'proposed'; lesson: Lesson }
  | { ok: true; kind: 'recurrence'; lesson: Lesson }
  | { ok: false; error: string };

const MAX_RULE_CHARS = 500;
const MAX_EVIDENCE_CHARS = 1000;
const SCOPE_RE = /^[a-z0-9][a-z0-9 _-]{0,40}$/;

function mapRow(row: any): Lesson {
  return {
    id: row.id,
    scope: row.scope,
    rule: row.rule,
    evidence: row.evidence,
    status: row.status,
    recurrenceCount: Number(row.recurrence_count),
    provenance: row.provenance,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    adoptedAt: row.adopted_at ?? null,
  };
}

/** Dedup key: lowercase, collapse whitespace, strip punctuation variance. */
export function normalizeRule(rule: string): string {
  return rule
    .toLowerCase()
    .replace(/[`'"“”‘’()[\]{}.,;:!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function proposeLesson(
  db: Database.Database,
  input: { scope: string; rule: string; evidence: string; provenance?: string },
): ProposeLessonResult {
  const scope = String(input.scope ?? '').trim().toLowerCase();
  const rule = String(input.rule ?? '').trim();
  const evidence = String(input.evidence ?? '').trim();
  if (!SCOPE_RE.test(scope)) {
    return { ok: false, error: `scope "${scope}" is invalid — use a short lowercase tag (a business like "ott", a lane like "etl-lane", or "general")` };
  }
  if (!rule) return { ok: false, error: 'rule is required — one operating rule stating what to DO differently' };
  if (rule.length > MAX_RULE_CHARS) {
    return { ok: false, error: `rule is ${rule.length} chars (max ${MAX_RULE_CHARS}) — a lesson is ONE bounded rule, not an essay; split or tighten it` };
  }
  if (/\n\s*\n/.test(rule)) {
    return { ok: false, error: 'rule spans multiple paragraphs — a lesson is ONE rule; propose separately' };
  }
  if (!evidence) {
    return { ok: false, error: 'evidence is required — cite the observed outcome (error text, run id, verification) that makes this rule VERIFIED, not speculation' };
  }

  // Dedup within scope: an equivalent rule bumps recurrence instead of
  // inserting. Equivalence = normalized exact match OR high token overlap
  // (catches light rephrasings without an LLM call).
  const existing = (db.prepare('SELECT * FROM lessons WHERE scope = ? AND status != ?').all(scope, 'retired') as any[]).map(mapRow);
  const normalized = normalizeRule(rule);
  const tokens = new Set(normalized.split(' ').filter(token => token.length >= 3));
  for (const lesson of existing) {
    const otherNormalized = normalizeRule(lesson.rule);
    let duplicate = otherNormalized === normalized;
    if (!duplicate && tokens.size >= 4) {
      const otherTokens = new Set(otherNormalized.split(' ').filter(token => token.length >= 3));
      const overlap = [...tokens].filter(token => otherTokens.has(token)).length;
      duplicate = overlap / Math.max(tokens.size, otherTokens.size) >= 0.8;
    }
    if (duplicate) {
      db.prepare(`
        UPDATE lessons SET recurrence_count = recurrence_count + 1,
          last_seen_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(lesson.id);
      const bumped = mapRow(db.prepare('SELECT * FROM lessons WHERE id = ?').get(lesson.id));
      return { ok: true, kind: 'recurrence', lesson: bumped };
    }
  }

  const id = `lesson_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  db.prepare(`
    INSERT INTO lessons (id, scope, rule, evidence, status, provenance)
    VALUES (?, ?, ?, ?, 'proposed', ?)
  `).run(id, scope, rule, evidence.slice(0, MAX_EVIDENCE_CHARS), String(input.provenance ?? '').slice(0, 300));
  const lesson = mapRow(db.prepare('SELECT * FROM lessons WHERE id = ?').get(id));
  return { ok: true, kind: 'proposed', lesson };
}

export function listLessons(
  db: Database.Database,
  filter: { scope?: string; status?: LessonStatus } = {},
): Lesson[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.scope) { clauses.push('scope = ?'); params.push(filter.scope.toLowerCase()); }
  if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return (db.prepare(`SELECT * FROM lessons ${where} ORDER BY scope, first_seen_at`).all(...params) as any[]).map(mapRow);
}

export function getLesson(db: Database.Database, id: string): Lesson | null {
  const row = db.prepare('SELECT * FROM lessons WHERE id = ?').get(String(id ?? '').trim());
  return row ? mapRow(row) : null;
}

/** Adoption = the owner's approval; re-renders the scope projection. */
export function adoptLesson(db: Database.Database, id: string): Lesson {
  const lesson = getLesson(db, id);
  if (!lesson) throw new Error(`Lesson ${id} not found`);
  if (lesson.status === 'adopted') return lesson;
  db.prepare(`
    UPDATE lessons SET status = 'adopted', adopted_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(lesson.id);
  renderLessonScope(db, lesson.scope);
  return getLesson(db, id)!;
}

export function retireLesson(db: Database.Database, id: string): Lesson {
  const lesson = getLesson(db, id);
  if (!lesson) throw new Error(`Lesson ${id} not found`);
  db.prepare(`
    UPDATE lessons SET status = 'retired', updated_at = datetime('now') WHERE id = ?
  `).run(lesson.id);
  renderLessonScope(db, lesson.scope);
  return getLesson(db, id)!;
}

/**
 * Projection: adopted lessons of one scope → `lessons/<scope>.md` in the
 * analytics knowledge dir + a manifest entry (`source: 'lesson'`). Zero
 * adopted lessons removes the file and the entry. The onboarding
 * generator's mergeManifest only replaces `etl-derived` rows, so lesson
 * entries survive preset regeneration by construction.
 */
export function renderLessonScope(db: Database.Database, scope: string): void {
  const dir = resolveAnalyticsContextDir(db);
  const lessonsDir = path.join(dir, 'lessons');
  const fileName = `lessons/${scope.replace(/[^a-z0-9_-]+/g, '-')}.md`;
  const fullPath = path.join(dir, fileName);
  const adopted = listLessons(db, { scope, status: 'adopted' });

  const manifestPath = path.join(dir, 'manifest.json');
  let files: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { files?: Array<Record<string, unknown>> };
    files = Array.isArray(parsed.files) ? parsed.files : [];
  } catch { /* fresh manifest */ }
  files = files.filter(entry => entry.file !== fileName);

  if (adopted.length === 0) {
    try { fs.rmSync(fullPath, { force: true }); } catch { /* already gone */ }
    fs.writeFileSync(manifestPath, JSON.stringify({ files }, null, 1));
    return;
  }

  const lines = [
    `# Lessons — ${scope} (BotBoy experiential operating rules)`,
    '',
    'Owner-adopted rules learned from live incidents. Each is verified,',
    'durable, and actionable — apply them when writing queries, documents,',
    'or dashboard widgets in this scope. They complement (never repeat) the',
    'corpus-derived preset for the same business.',
    '',
    ...adopted.map(lesson => [
      `## ${lesson.id} (adopted ${String(lesson.adoptedAt ?? '').slice(0, 10)}${lesson.recurrenceCount > 1 ? `, seen ×${lesson.recurrenceCount}` : ''})`,
      '',
      lesson.rule,
      '',
      `Evidence: ${lesson.evidence}`,
      '',
    ].join('\n')),
  ];
  fs.mkdirSync(lessonsDir, { recursive: true });
  fs.writeFileSync(fullPath, lines.join('\n'));
  files.push({
    file: fileName,
    business: scope,
    keywords: [scope, 'lessons', 'gotchas', 'operating rules'],
    source: 'lesson',
    appliesTo: ['mcp_sql_*', 'mcp_etl_*'],
    derivedAt: new Date().toISOString().slice(0, 10),
  });
  fs.writeFileSync(manifestPath, JSON.stringify({ files }, null, 1));
}
