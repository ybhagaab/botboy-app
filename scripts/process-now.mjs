#!/usr/bin/env node
/**
 * process-now — trigger a full BotBoy pipeline sweep on demand.
 *
 * Forces the running app to: drain extraction of all `captured` items, then
 * route every `extracted` item into projects and refresh the touched brains —
 * without waiting for the built-in timers. Safe to run repeatedly (idempotent;
 * nothing is lost if the LLM is down — items just stay queued).
 *
 * Usage:
 *   node scripts/process-now.mjs               # uses http://localhost:7778
 *   PPT_URL=http://localhost:7799 node scripts/process-now.mjs
 *
 * Cron example (every 30 min):
 *   *\/30 * * * * /usr/local/bin/node /path/to/scripts/process-now.mjs >> /tmp/ppt-process.log 2>&1
 */

const base = process.env.PPT_URL || `http://localhost:${process.env.PPT_PORT || 7778}`;

async function main() {
  const started = Date.now();
  const resp = await fetch(`${base}/api/pipeline/process`, { method: 'POST' });
  if (!resp.ok) {
    console.error(`[process-now] HTTP ${resp.status}: ${await resp.text()}`);
    process.exit(1);
  }
  const r = await resp.json();
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[process-now] done in ${secs}s — extracted ${r.extracted}, ${r.waves} wave(s): ` +
    `routed ${r.routed}, created ${r.created}, orphaned ${r.orphaned}, noise ${r.noise}, ` +
    `brains updated ${r.projectsUpdated}`,
  );
}

main().catch((err) => {
  console.error(`[process-now] failed: ${err?.message ?? err}`);
  console.error('  Is BotBoy running? Set PPT_URL/PPT_PORT if it is on a non-default port.');
  process.exit(1);
});
