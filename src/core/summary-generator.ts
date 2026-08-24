/**
 * Summary Generator — produces a one-liner summary from item metadata
 * when no page content is available (e.g. app_activity items).
 */

import type { RawWorkItem } from './types.js';

export function generateFallbackSummary(item: RawWorkItem): string | null {
  const title = item.title?.trim();
  if (!title) return null;

  const app = item.sourceApp || '';

  // Bare app names → noise
  if (/^(Electron|Google Chrome|firefox|Cisco)$/i.test(title)) {
    return `[NOISE] ${title} window focus event — no meaningful content`;
  }

  // System prompts
  if (/^PIN required$/i.test(title)) return '[NOISE] System PIN prompt';
  if (/^\d+ Reminder/.test(title)) return `${app || 'System'} reminder: ${title}`;

  // File editing: "filename.ext — Project — Workspace"
  const fileMatch = title.match(/^(Preview\s+)?(.+?\.\w+)\s+—\s+(.+?)\s+—\s+(.+)$/);
  if (fileMatch) {
    const action = fileMatch[1] ? 'Previewing' : 'Editing';
    return `${action} file: ${fileMatch[2]} in project ${fileMatch[3]} (${fileMatch[4]} workspace)`;
  }

  // Generic "X — Y — Z" (no file extension)
  const tripleMatch = title.match(/^(.+?)\s+—\s+(.+?)\s+—\s+(.+)$/);
  if (tripleMatch) {
    return `Working on: ${tripleMatch[1]} in project ${tripleMatch[2]} (${tripleMatch[3]})`;
  }

  // Chrome with notification count: "(N) Title - Google Chrome"
  const chromeNotif = title.match(/^\((\d+)\)\s+(.+?)\s+-\s+Google Chrome$/);
  if (chromeNotif) {
    return `${chromeNotif[2]} in Chrome (${chromeNotif[1]} notification${chromeNotif[1] === '1' ? '' : 's'})`;
  }

  // Chrome browsing: "Title - Google Chrome"
  const chromeMatch = title.match(/^(.+?)\s+-\s+Google Chrome$/);
  if (chromeMatch) return `Browsing in Chrome: ${chromeMatch[1]}`;

  // Auth pages
  if (/signin|saml|login|authentication/i.test(title)) {
    return `Authentication/login activity: ${title.slice(0, 100)}`;
  }

  // Slack native (from app monitor metadata)
  if (item.type === 'slack_message') {
    const meta = item.metadata || {};
    const channel = meta.channelOrDm || title;
    const dir = meta.direction === 'sent' ? 'Sent message in' : 'Active in';
    if (channel.includes('(DM)')) return `Slack: DM conversation with ${channel.replace(/\s*\(DM\).*/, '')}`;
    if (channel.includes('(Channel)')) return `Slack: ${dir} #${channel.replace(/\s*\(Channel\).*/, '')}`;
    return `Slack activity: ${channel}`;
  }

  // Fallback
  return `App activity: ${title}${app ? ` (${app})` : ''}`;
}
