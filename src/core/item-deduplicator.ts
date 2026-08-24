/**
 * Item Deduplicator — URL normalization, content hash, title similarity, noise detection.
 * Merges duplicates and transfers node assignments.
 */

import Database from 'better-sqlite3';
import type { AcpClient } from './acp-client.js';
import type { WorkItem, DuplicateGroup, DeduplicationResult } from './types.js';

export interface ItemDeduplicator {
  findDuplicates(items: WorkItem[]): DuplicateGroup[];
  findNoiseItems(items: WorkItem[]): string[];
  mergeItems(keepId: string, removeIds: string[]): void;
  removeNoiseItems(itemIds: string[]): void;
}

const NOISE_PATTERNS = [
  /^electron$/i, /^google chrome$/i, /^safari$/i, /^firefox$/i,
  /^finder$/i, /^desktop$/i, /^system preferences$/i, /^terminal$/i,
  /^new tab$/i, /^untitled$/i, /^about:blank$/i,
];

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Strip tracking params
    const strip = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid', 'gclid'];
    for (const p of strip) u.searchParams.delete(p);
    // Normalize: lowercase host, strip trailing slash, strip fragment
    let normalized = `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
    const params = u.searchParams.toString();
    if (params) normalized += `?${params}`;
    return normalized;
  } catch {
    return url.toLowerCase().trim();
  }
}

function levenshtein(a: string, b: string): number {
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  const dp: number[][] = Array.from({ length: la + 1 }, () => Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[la][lb];
}

export function createItemDeduplicator(db: Database.Database, acpClient?: AcpClient): ItemDeduplicator {
  return {
    findDuplicates(items: WorkItem[]): DuplicateGroup[] {
      const groups: DuplicateGroup[] = [];
      const claimed = new Set<string>();

      // URL dedup
      const urlMap = new Map<string, WorkItem[]>();
      for (const item of items) {
        if (!item.url) continue;
        const norm = normalizeUrl(item.url);
        if (!urlMap.has(norm)) urlMap.set(norm, []);
        urlMap.get(norm)!.push(item);
      }
      for (const [, group] of urlMap) {
        if (group.length < 2) continue;
        const sorted = group.sort((a, b) => (b.summary?.length ?? 0) - (a.summary?.length ?? 0));
        const canonical = sorted[0];
        const dupes = sorted.slice(1).map(i => i.id);
        groups.push({ canonical: canonical.id, duplicates: dupes, reason: 'same_url', confidence: 1.0 });
        for (const i of group) claimed.add(i.id);
      }

      // Content hash dedup
      const hashMap = new Map<string, WorkItem[]>();
      for (const item of items) {
        if (!item.contentHash || claimed.has(item.id)) continue;
        if (!hashMap.has(item.contentHash)) hashMap.set(item.contentHash, []);
        hashMap.get(item.contentHash)!.push(item);
      }
      for (const [, group] of hashMap) {
        if (group.length < 2) continue;
        const sorted = group.sort((a, b) => (b.summary?.length ?? 0) - (a.summary?.length ?? 0));
        groups.push({ canonical: sorted[0].id, duplicates: sorted.slice(1).map(i => i.id), reason: 'same_content_hash', confidence: 1.0 });
        for (const i of group) claimed.add(i.id);
      }

      // Title similarity dedup (Levenshtein < 3)
      const unclaimed = items.filter(i => !claimed.has(i.id) && i.title);
      for (let i = 0; i < unclaimed.length; i++) {
        if (claimed.has(unclaimed[i].id)) continue;
        const similar: WorkItem[] = [unclaimed[i]];
        for (let j = i + 1; j < unclaimed.length; j++) {
          if (claimed.has(unclaimed[j].id)) continue;
          const titleA = (unclaimed[i].title ?? '').toLowerCase();
          const titleB = (unclaimed[j].title ?? '').toLowerCase();
          if (titleA && titleB && levenshtein(titleA, titleB) < 3) {
            similar.push(unclaimed[j]);
          }
        }
        if (similar.length >= 2) {
          const sorted = similar.sort((a, b) => (b.summary?.length ?? 0) - (a.summary?.length ?? 0));
          groups.push({ canonical: sorted[0].id, duplicates: sorted.slice(1).map(x => x.id), reason: 'similar_title', confidence: 0.8 });
          for (const s of similar) claimed.add(s.id);
        }
      }

      return groups;
    },

    findNoiseItems(items: WorkItem[]): string[] {
      return items
        .filter(item => {
          const title = (item.title ?? '').trim();
          if (!title) return true;
          return NOISE_PATTERNS.some(p => p.test(title));
        })
        .map(i => i.id);
    },

    mergeItems(keepId: string, removeIds: string[]): void {
      db.transaction(() => {
        // Find the most enriched version
        const allIds = [keepId, ...removeIds];
        const rows = allIds.map(id => db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as any).filter(Boolean);
        const best = rows.sort((a, b) => ((b.parsed_text?.length ?? 0) + (b.summary?.length ?? 0)) - ((a.parsed_text?.length ?? 0) + (a.summary?.length ?? 0)))[0];

        if (best && best.id !== keepId) {
          // Update canonical with best content
          db.prepare('UPDATE work_items SET parsed_text = ?, summary = ? WHERE id = ?')
            .run(best.parsed_text, best.summary, keepId);
        }

        // Transfer node assignments from duplicates to canonical
        for (const removeId of removeIds) {
          const assocs = db.prepare('SELECT node_id, assigned_by FROM node_work_items WHERE work_item_id = ?').all(removeId) as any[];
          for (const a of assocs) {
            db.prepare('INSERT OR IGNORE INTO node_work_items (node_id, work_item_id, assigned_by) VALUES (?, ?, ?)')
              .run(a.node_id, keepId, a.assigned_by);
          }
          db.prepare('DELETE FROM node_work_items WHERE work_item_id = ?').run(removeId);
          db.prepare('DELETE FROM work_items WHERE id = ?').run(removeId);
        }
      })();
    },

    removeNoiseItems(itemIds: string[]): void {
      db.transaction(() => {
        for (const id of itemIds) {
          db.prepare('DELETE FROM node_work_items WHERE work_item_id = ?').run(id);
          db.prepare('DELETE FROM work_items WHERE id = ?').run(id);
        }
      })();
    },
  };
}
