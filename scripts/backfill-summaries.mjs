#!/usr/bin/env node
/**
 * Backfill summaries for work_items where summary IS NULL.
 * Pure pattern-matching — no LLM needed.
 * 
 * Usage: node scripts/backfill-summaries.mjs [--dry-run]
 */

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DB_PATH = path.join(os.homedir(), '.personal-productivity-tracker', 'tracker.db');
const dryRun = process.argv.includes('--dry-run');

// ── Pattern matchers for app_activity ──

function summarizeAppActivity(title, sourceApp, metadata) {
  if (!title) return `App activity: (untitled) (${sourceApp || 'unknown'})`;

  const t = title.trim();

  // 1. Pure noise: bare app names
  if (/^(Electron|Google Chrome|firefox|Cisco)$/i.test(t)) {
    return `[NOISE] ${t} window focus event — no meaningful content`;
  }

  // 2. Reminder / system
  if (/^\d+ Reminder/.test(t)) {
    return `${sourceApp || 'System'} reminder: ${t}`;
  }
  if (/^PIN required$/i.test(t)) {
    return `[NOISE] System PIN prompt`;
  }

  // 3. File editing: "filename.ext — Project — Workspace"
  const fileMatch = t.match(/^(Preview\s+)?(.+?\.\w+)\s+—\s+(.+?)\s+—\s+(.+)$/);
  if (fileMatch) {
    const [, preview, filename, project, workspace] = fileMatch;
    const action = preview ? 'Previewing' : 'Editing';
    return `${action} file: ${filename} in project ${project} (${workspace} workspace)`;
  }

  // 4. "tasks.md — Project — Workspace" variant (no extension match above catches most)
  const simpleFileMatch = t.match(/^(.+?)\s+—\s+(.+?)\s+—\s+(.+)$/);
  if (simpleFileMatch) {
    const [, file, project, workspace] = simpleFileMatch;
    return `Working on: ${file} in project ${project} (${workspace})`;
  }

  // 5. Chrome tabs with notification count: "(N) Title - Google Chrome"
  const chromeNotif = t.match(/^\((\d+)\)\s+(.+?)\s+-\s+Google Chrome$/);
  if (chromeNotif) {
    const [, count, page] = chromeNotif;
    return `${page} in Chrome (${count} notification${count === '1' ? '' : 's'})`;
  }

  // 6. Chrome browsing: "Title - Google Chrome"
  const chromeMatch = t.match(/^(.+?)\s+-\s+Google Chrome$/);
  if (chromeMatch) {
    return `Browsing in Chrome: ${chromeMatch[1]}`;
  }

  // 7. SAML / auth pages
  if (/signin|saml|login|authentication/i.test(t)) {
    return `Authentication/login activity: ${t.slice(0, 100)}`;
  }

  // 8. Fallback
  return `App activity: ${t}${sourceApp ? ` (${sourceApp})` : ''}`;
}

// ── Pattern matchers for website_visit ──

function summarizeWebsiteVisit(title, url) {
  if (!title && !url) return 'Website visit: (unknown)';

  if (url && url.includes('sharepoint.com')) {
    return `SharePoint document: ${title || 'untitled'}`;
  }
  if (url && url.includes('localhost:7778')) {
    return `Productivity Tracker dashboard visit`;
  }

  return `Website visit: ${title || url}`;
}

// ── Pattern matchers for slack_message ──

function summarizeSlackMessage(title, metadata) {
  let meta = {};
  try { meta = typeof metadata === 'string' ? JSON.parse(metadata) : (metadata || {}); } catch {}

  const channel = meta.channelOrDm || title || 'unknown';
  const direction = meta.direction === 'sent' ? 'Sent message in' : 'Active in';

  if (channel.includes('(DM)')) {
    const person = channel.replace(/\s*\(DM\).*/, '');
    return `Slack: DM conversation with ${person}`;
  }
  if (channel.includes('(Channel)')) {
    const ch = channel.replace(/\s*\(Channel\).*/, '');
    return `Slack: ${direction} #${ch}`;
  }

  return `Slack activity: ${channel}`;
}

// ── Main ──

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}`);
    process.exit(1);
  }

  // Backup
  if (!dryRun) {
    const backupPath = DB_PATH + '.backup-' + Date.now();
    fs.copyFileSync(DB_PATH, backupPath);
    console.log(`✅ Backup created: ${backupPath}`);
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const items = db.prepare(`
    SELECT id, type, title, source_app, url, metadata 
    FROM work_items 
    WHERE summary IS NULL
  `).all();

  console.log(`\n📊 Found ${items.length} items without summaries\n`);

  const stats = { total: 0, byType: {}, patterns: {} };
  const updates = [];

  for (const item of items) {
    let summary;

    switch (item.type) {
      case 'app_activity':
        summary = summarizeAppActivity(item.title, item.source_app, item.metadata);
        break;
      case 'website_visit':
        summary = summarizeWebsiteVisit(item.title, item.url);
        break;
      case 'slack_message':
        summary = summarizeSlackMessage(item.title, item.metadata);
        break;
      default:
        summary = `${item.type}: ${item.title || '(untitled)'}`;
    }

    updates.push({ id: item.id, summary });
    stats.total++;
    stats.byType[item.type] = (stats.byType[item.type] || 0) + 1;

    // Track pattern usage
    const pattern = summary.split(':')[0] || 'other';
    stats.patterns[pattern] = (stats.patterns[pattern] || 0) + 1;
  }

  // Show preview
  console.log('📋 Sample summaries:');
  const samples = updates.filter((_, i) => i % Math.max(1, Math.floor(updates.length / 10)) === 0).slice(0, 10);
  for (const s of samples) {
    const orig = items.find(i => i.id === s.id);
    console.log(`  [${orig.type}] "${orig.title?.slice(0, 50)}..."`);
    console.log(`  → ${s.summary}\n`);
  }

  console.log('📊 Stats by type:', stats.byType);
  console.log('📊 Stats by pattern:', stats.patterns);

  if (dryRun) {
    console.log('\n🔍 DRY RUN — no changes written. Remove --dry-run to execute.');
    db.close();
    return;
  }

  // Batch update in a transaction
  const update = db.prepare('UPDATE work_items SET summary = ? WHERE id = ?');
  const batchUpdate = db.transaction((rows) => {
    for (const row of rows) {
      update.run(row.summary, row.id);
    }
  });

  batchUpdate(updates);

  // Verify
  const remaining = db.prepare('SELECT COUNT(*) as cnt FROM work_items WHERE summary IS NULL').get();
  console.log(`\n✅ Updated ${stats.total} items`);
  console.log(`📊 Remaining without summary: ${remaining.cnt}`);

  db.close();
}

main();
