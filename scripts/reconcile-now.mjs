#!/usr/bin/env node
/**
 * reconcile-now — trigger a BotBoy orphan-reconciliation pass on demand.
 *
 * Reviews items that couldn't be routed to a project ("orphans") and lets the
 * LLM propose new projects from common themes. Heavier than process-now, so run
 * it less often (e.g. nightly).
 *
 * Usage:  node scripts/reconcile-now.mjs
 * Cron (nightly at 2am):
 *   0 2 * * * /usr/local/bin/node /path/to/scripts/reconcile-now.mjs >> /tmp/ppt-reconcile.log 2>&1
 */

const base = process.env.PPT_URL || `http://localhost:${process.env.PPT_PORT || 7778}`;

async function main() {
  const resp = await fetch(`${base}/api/pipeline/reconcile`, { method: 'POST' });
  if (!resp.ok) {
    console.error(`[reconcile-now] HTTP ${resp.status}: ${await resp.text()}`);
    process.exit(1);
  }
  await resp.json();
  // Fetch health to show the resulting picture.
  const health = await fetch(`${base}/api/pipeline/health`).then((r) => r.json()).catch(() => null);
  if (health) {
    console.log(`[reconcile-now] done — ${health.projectCount} projects, ${health.orphanCount} orphans remaining`);
  } else {
    console.log('[reconcile-now] done');
  }
}

main().catch((err) => {
  console.error(`[reconcile-now] failed: ${err?.message ?? err}`);
  process.exit(1);
});
