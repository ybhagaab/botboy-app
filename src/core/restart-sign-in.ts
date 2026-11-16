/**
 * Whether restarting BotBoy now may cut Datanet off (docs/maps/midway-sentinel.md › Restart sign-in check).
 *
 * The a2-analytics connector keeps its Datanet (Sentry) sign-in while it runs. A restart starts a new connector, which signs
 * in again through the Midway cookie jar, and Midway refuses that while Amazon's device check (the jar's
 * `amazon_enterprise_access` rows, renewed for 2 hours at a time) has lapsed. Live 2026-11-14: the device check lapsed at
 * 14:57, Datanet kept working, a restart at 18:33 started a new connector, and every Datanet read was its sign-in page
 * until a new device check at 21:36.
 *
 * Only Macs that use Datanet are checked (the connector's own sign-in file exists). Cookie names, domains and expiries are
 * read, never values. The jar's expiries may not be the whole story (sign-ins through MCS keep their own), so the words say
 * "may". Same rule and words as start.sh › restart_sign_in_warning, which prints them before a restart; the in-app Update
 * asks first with them (app-update router). It never stops a restart.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A device check that lapses this soon counts as lapsed: the new connector signs in on its first Datanet call. */
export const DEVICE_CHECK_MARGIN_MS = 10 * 60_000;

export interface RestartSignInRisk {
  atRisk: boolean;
  /** The device check's latest expiry in the jar (epoch ms); null when the jar has none or one without an expiry. */
  deviceCheckExpiresAt: number | null;
  /** The owner-facing words, when at risk. */
  message: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const localDay = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/** "23:36" today, "Nov 13 23:36" on another day (local time; the launcher prints the same). */
export function lapseTime(expiresAtMs: number, nowMs: number): string {
  const at = new Date(expiresAtMs);
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return localDay(at) === localDay(new Date(nowMs)) ? clock : `${MONTHS[at.getMonth()]} ${at.getDate()} ${clock}`;
}

export function restartSignInMessage(expiresAtMs: number, nowMs: number): string {
  const when = lapseTime(expiresAtMs, nowMs);
  return expiresAtMs <= nowMs
    ? `Amazon's device check lapsed at ${when}. Datanet still works on its earlier sign-in, but a restart makes it sign in again, which may be refused until you run mwinit -o -s. Run it first to avoid that.`
    : `Amazon's device check lapses at ${when}. A restart makes Datanet sign in again, which may be refused once it lapses, until you run mwinit -o -s. Run it first to avoid that.`;
}

/** The latest `amazon_enterprise_access` expiry on a Midway domain (epoch s): 0 for one without an expiry, null for none. */
export function deviceCheckExpiry(jarText: string): number | null {
  let latest: number | null = null;
  for (const line of jarText.split('\n')) {
    let entry = line.trim();
    if (!entry) continue;
    if (entry.startsWith('#HttpOnly_')) entry = entry.slice('#HttpOnly_'.length);
    else if (entry.startsWith('#')) continue;
    const fields = entry.split(/\s+/);
    if (fields.length < 6) continue;
    const [domain, , , , expiryRaw, name] = fields;
    if (!domain.toLowerCase().includes('midway') || name !== 'amazon_enterprise_access' || !/^\d+$/.test(expiryRaw)) continue;
    const expiry = Number(expiryRaw);
    if (expiry === 0) return 0; // a cookie without an expiry lives as long as the jar: not lapsed
    if (latest === null || expiry > latest) latest = expiry;
  }
  return latest;
}

export function readRestartSignInRisk(options: { cookiePath?: string; sentryCookiePath?: string; nowMs?: number } = {}): RestartSignInRisk {
  const none: RestartSignInRisk = { atRisk: false, deviceCheckExpiresAt: null, message: null };
  const cookiePath = options.cookiePath ?? path.join(os.homedir(), '.midway', 'cookie');
  const sentryCookiePath = options.sentryCookiePath ?? path.join(os.homedir(), '.a2data', 'datanet_sentry_cookie');
  const nowMs = options.nowMs ?? Date.now();
  if (!fs.existsSync(sentryCookiePath)) return none; // this Mac does not use Datanet
  let jar: string;
  try {
    jar = fs.readFileSync(cookiePath, 'utf8');
  } catch {
    return none;
  }
  const expiry = deviceCheckExpiry(jar);
  if (!expiry) return none; // no device check in the jar, or one without an expiry: nothing to say
  const expiresAtMs = expiry * 1000;
  if (expiresAtMs > nowMs + DEVICE_CHECK_MARGIN_MS) return { atRisk: false, deviceCheckExpiresAt: expiresAtMs, message: null };
  return { atRisk: true, deviceCheckExpiresAt: expiresAtMs, message: restartSignInMessage(expiresAtMs, nowMs) };
}
