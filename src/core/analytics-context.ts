/**
 * Analytics knowledge directory (etl-analytics A2) — the local, on-demand
 * knowledge layer for data work on BOTH lanes (SQL and ETL).
 *
 * One directory, two producers, one loader:
 *   - user-dropped files at the ROOT (schema notes, methodology docs — e.g.
 *     an export of warehouse context or the opted-out-GAID note);
 *   - generated business presets under `presets/` (written by the A3
 *     onboarding flow; tagged in manifest.json).
 *
 * Principles (practical-agent framework #6/#9): context files load in
 * ISOLATION — list first, load exactly the ONE file matching the task,
 * never all of them. Every load is prefixed with a PROVENANCE header so the
 * model knows which kind of knowledge it is holding and what transfers
 * between sources (source arbitration is mechanical, not judgment).
 *
 * manifest.json (optional, A3 writes it; user files work without it):
 *   { "files": [ { "file": "presets/fatafat.md", "business": "fatafat",
 *       "keywords": ["fatafat", ...], "source": "etl-derived",
 *       "appliesTo": ["mcp_etl_*", "mcp_sql_*"], "derivedAt": "...",
 *       "corpusSize": 85 } ] }
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getSetting, setSetting } from './storage.js';

export const ANALYTICS_CONTEXT_DIR_KEY = 'analytics_context.dir';
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt']);
const DEFAULT_MAX_CHARS = 60_000;

export type AnalyticsContextSource = 'etl-derived' | 'user-dropped';

export interface AnalyticsContextEntry {
  /** Relative name within the directory, e.g. `agent-note.md` or `presets/fatafat.md`. */
  name: string;
  /** First non-empty line with markdown heading markers stripped. */
  title: string;
  source: AnalyticsContextSource;
  appliesTo: string[];
  bytes: number;
  modifiedAt: string;
  business?: string;
  keywords?: string[];
  derivedAt?: string;
}

interface ManifestEntry {
  file: string;
  business?: string;
  keywords?: string[];
  source?: AnalyticsContextSource;
  appliesTo?: string[];
  derivedAt?: string;
  corpusSize?: number;
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** Directory resolution: explicit setting wins; default lives next to the rest of BotBoy's state. */
export function resolveAnalyticsContextDir(db: Database.Database): string {
  const configured = (getSetting<string>(db, ANALYTICS_CONTEXT_DIR_KEY) ?? '').trim();
  if (configured) return path.resolve(expandHome(configured));
  return path.join(os.homedir(), '.personal-productivity-tracker', 'analytics-context');
}

/** Set (or clear with '') the configured directory. Returns the resolved active dir. */
export function setAnalyticsContextDir(db: Database.Database, dir: string): string {
  const cleaned = String(dir ?? '').trim();
  if (cleaned.includes('\0')) throw new Error('directory contains a null byte');
  setSetting(db, ANALYTICS_CONTEXT_DIR_KEY, cleaned || null);
  const resolved = resolveAnalyticsContextDir(db);
  fs.mkdirSync(path.join(resolved, 'presets'), { recursive: true });
  return resolved;
}

function readManifest(dir: string): Map<string, ManifestEntry> {
  const byFile = new Map<string, ManifestEntry>();
  try {
    const raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as { files?: ManifestEntry[] };
    for (const entry of parsed.files ?? []) {
      if (entry && typeof entry.file === 'string') byFile.set(path.normalize(entry.file), entry);
    }
  } catch { /* absent or malformed manifest: user files still work */ }
  return byFile;
}

function titleOf(filePath: string): string {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const cleaned = line.replace(/^#+\s*/, '').trim();
      if (cleaned) return cleaned.slice(0, 160);
    }
  } catch { /* unreadable → empty title */ }
  return '';
}

/** List the knowledge files (root + presets/), manifest tags folded in. */
export function listAnalyticsContext(db: Database.Database): { dir: string; files: AnalyticsContextEntry[] } {
  const dir = resolveAnalyticsContextDir(db);
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  const manifest = readManifest(dir);
  const files: AnalyticsContextEntry[] = [];
  const scan = (subdir: string): void => {
    const absolute = path.join(dir, subdir);
    let names: string[] = [];
    try { names = fs.readdirSync(absolute); } catch { return; }
    for (const fileName of names.sort()) {
      if (fileName.startsWith('.')) continue;
      const relative = subdir ? path.join(subdir, fileName) : fileName;
      const fullPath = path.join(dir, relative);
      let stat: fs.Stats;
      try { stat = fs.statSync(fullPath); } catch { continue; }
      if (!stat.isFile()) continue;
      if (!ALLOWED_EXTENSIONS.has(path.extname(fileName).toLowerCase())) continue;
      const tagged = manifest.get(path.normalize(relative));
      files.push({
        name: relative,
        title: titleOf(fullPath),
        source: tagged?.source ?? (subdir === 'presets' ? 'etl-derived' : 'user-dropped'),
        appliesTo: Array.isArray(tagged?.appliesTo) && tagged.appliesTo.length > 0
          ? tagged.appliesTo.map(String)
          : ['mcp_sql_*', 'mcp_etl_*'],
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        ...(tagged?.business ? { business: tagged.business } : {}),
        ...(Array.isArray(tagged?.keywords) && tagged.keywords.length > 0 ? { keywords: tagged.keywords.map(String) } : {}),
        ...(tagged?.derivedAt ? { derivedAt: tagged.derivedAt } : {}),
      });
    }
  };
  scan('');
  scan('presets');
  return { dir, files };
}

const SOURCE_LABEL: Record<AnalyticsContextSource, string> = {
  'etl-derived': 'generated from your team\'s production ETL profiles (Datanet)',
  'user-dropped': 'user-supplied warehouse/schema knowledge',
};

const ARBITRATION_LINE =
  'Source rules: schema facts transfer across sources; wrapper/submission mechanics are ETL-only; '
  + 'when numbers depend on filters, name the regime used (report-matching vs analytical).';

export type LoadAnalyticsContextResult =
  | { ok: true; name: string; source: AnalyticsContextSource; content: string; truncated: boolean }
  | { ok: false; error: string };

/** Load ONE file with the provenance header. Traversal-safe, size-capped. */
export function loadAnalyticsContext(
  db: Database.Database,
  name: string,
  maxChars = DEFAULT_MAX_CHARS,
): LoadAnalyticsContextResult {
  const cleaned = String(name ?? '').trim();
  if (!cleaned) return { ok: false, error: 'name required — call mcp_analytics_list_context for the available files' };
  // Traversal guard: relative names only, resolved inside the directory.
  if (cleaned.includes('\0') || cleaned.includes('\\') || path.isAbsolute(cleaned)
    || cleaned.split('/').some(segment => segment === '..' || segment === '')) {
    return { ok: false, error: `invalid name "${cleaned}" — use a relative file name exactly as listed by mcp_analytics_list_context` };
  }
  const dir = resolveAnalyticsContextDir(db);
  const fullPath = path.resolve(dir, cleaned);
  if (fullPath !== dir && !fullPath.startsWith(dir + path.sep)) {
    return { ok: false, error: `invalid name "${cleaned}" — it resolves outside the analytics knowledge directory` };
  }
  if (!ALLOWED_EXTENSIONS.has(path.extname(fullPath).toLowerCase())) {
    return { ok: false, error: 'only .md and .txt knowledge files can be loaded' };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(fullPath, 'utf8');
  } catch {
    return { ok: false, error: `"${cleaned}" not found — call mcp_analytics_list_context for the current files` };
  }
  const manifest = readManifest(dir);
  const tagged = manifest.get(path.normalize(cleaned));
  const source: AnalyticsContextSource = tagged?.source
    ?? (cleaned.startsWith(`presets${path.sep}`) || cleaned.startsWith('presets/') ? 'etl-derived' : 'user-dropped');
  const truncated = raw.length > maxChars;
  const body = truncated
    ? `${raw.slice(0, maxChars)}\n\n[Truncated at ${maxChars} of ${raw.length} characters — the full file is at ${fullPath}.]`
    : raw;
  const header = `[KNOWLEDGE FILE: ${cleaned} — ${SOURCE_LABEL[source]}]\n${ARBITRATION_LINE}\n---\n`;
  return { ok: true, name: cleaned, source, content: `${header}${body}`, truncated };
}
