#!/usr/bin/env node
/**
 * rebuild-brains — regenerate project "brain" briefings from all their items.
 *
 * Folds every item of a project back through the (improved) brain-updater in
 * chronological chunks, producing a clean catch-up briefing: prose summary,
 * one-line status, key next actions, blockers/attention items, people, and a
 * de-duplicated recent-activity log.
 *
 * Usage:
 *   node scripts/rebuild-brains.mjs                       # all populated projects
 *   node scripts/rebuild-brains.mjs --project proj_xxxx   # one project
 *   node scripts/rebuild-brains.mjs --min 5               # only projects with >=5 items
 *   PPT_URL=http://localhost:7778 node scripts/rebuild-brains.mjs
 *
 * Requires BotBoy to be running (drives it via the HTTP API so it reuses the
 * live LLM client + stores).
 */

const base = process.env.PPT_URL || `http://localhost:${process.env.PPT_PORT || 7778}`;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const projectId = arg('--project');
  const minItems = arg('--min') ? Number(arg('--min')) : undefined;
  const chunkSize = arg('--chunk') ? Number(arg('--chunk')) : undefined;

  const body = {};
  if (projectId) body.projectId = projectId;
  if (minItems != null) body.minItems = minItems;
  if (chunkSize != null) body.chunkSize = chunkSize;

  const started = Date.now();
  console.log(`[rebuild-brains] ${projectId ? `project ${projectId}` : 'all populated projects'} — this can take a while...`);
  const resp = await fetch(`${base}/api/pipeline/rebuild-brains`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    console.error(`[rebuild-brains] HTTP ${resp.status}: ${await resp.text()}`);
    process.exit(1);
  }
  const r = await resp.json();
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (projectId) {
    console.log(`[rebuild-brains] done in ${secs}s — ${r.status}, ${r.items} items folded in.`);
  } else {
    console.log(`[rebuild-brains] done in ${secs}s — rebuilt ${r.projects} project(s), ${r.items} items total.`);
  }
}

main().catch((err) => {
  console.error(`[rebuild-brains] failed: ${err?.message ?? err}`);
  console.error('  Is BotBoy running? Set PPT_URL/PPT_PORT if it is on a non-default port.');
  process.exit(1);
});
