#!/usr/bin/env node
/**
 * organize-now — trigger the project→area organization (hierarchy) pass now.
 *
 * Reads all projects and uses the LLM to cluster them into higher-level areas
 * by relevance. Safe to run repeatedly. Runs on its own every ~30 min too.
 *
 * Usage:  node scripts/organize-now.mjs
 */
const base = process.env.PPT_URL || `http://localhost:${process.env.PPT_PORT || 7778}`;

const resp = await fetch(`${base}/api/pipeline/organize`, { method: 'POST' }).catch((e) => {
  console.error(`[organize-now] request failed: ${e?.message ?? e}`);
  process.exit(1);
});
if (!resp.ok) { console.error(`[organize-now] HTTP ${resp.status}: ${await resp.text()}`); process.exit(1); }
await resp.json();
const areas = await fetch(`${base}/api/areas`).then((r) => r.json()).catch(() => null);
if (areas) {
  console.log(`[organize-now] done — ${areas.count} area(s):`);
  for (const a of areas.areas) console.log(`  ${a.title}  (${a.projects.length} projects)`);
} else {
  console.log('[organize-now] done');
}
