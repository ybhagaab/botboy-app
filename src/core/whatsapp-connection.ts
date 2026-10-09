/**
 * WhatsApp connection (docs/maps/whatsapp-chat.md): onboarding for any
 * BotBoy user. WhatsApp Web runs in BotBoy's debug Chrome (launcher-owned,
 * CDP 9222); this module reports its state, opens its window, and keeps the
 * owner's choice of "BotBoy chat": the chat whose @botboy messages BotBoy
 * answers (default: the owner's own "Message yourself" chat, created by
 * WhatsApp if the owner never used it).
 *
 * Settings key `whatsapp.v1`: { enabled, chat?: { number, name } }.
 * `number` empty means the owner's own chat.
 */

import type Database from 'better-sqlite3';
import type { WhatsAppPage } from './whatsapp-send.js';

export const WHATSAPP_SETTINGS_KEY = 'whatsapp.v1';
export const WHATSAPP_WEB_URL = 'https://web.whatsapp.com/';

export interface WhatsAppSettings {
  enabled: boolean;
  /** The BotBoy chat: another number (digits), or null for the owner's own chat. */
  chatNumber: string | null;
}

export interface WhatsAppStatus {
  chrome: boolean;
  tabOpen: boolean;
  /** signed_in | qr (waiting for the phone scan) | loading */
  session: 'signed_in' | 'qr' | 'loading' | 'closed';
  me: { number: string; name: string } | null;
  enabled: boolean;
  chat: { number: string; name: string; self: boolean } | null;
}

/** What WhatsApp Web shows: signed in (with the owner's number and name), the QR code, or still loading. */
export const SESSION_READER = `(() => {
  try {
    const me = window.require && window.require('WAWebUserPrefsMeUser');
    const pn = me && me.getMaybeMePnUser && me.getMaybeMePnUser();
    if (pn) {
      let name = '';
      try {
        const C = window.require('WAWebCollections');
        const contact = C.Contact.get(pn._serialized);
        name = String((contact && (contact.pushname || contact.name)) || '');
        if (!name) { const conn = window.require('WAWebConnModel'); name = String(conn && conn.Conn && conn.Conn.pushname || ''); }
      } catch (e) {}
      return JSON.stringify({ session: 'signed_in', number: String(pn.user), name });
    }
  } catch (e) {}
  if (document.querySelector('canvas[aria-label*="Scan" i], [data-ref] canvas, div[data-ref]')) return JSON.stringify({ session: 'qr' });
  return JSON.stringify({ session: 'loading' });
})()`;

/** The display name of a number's chat or contact, '' when WhatsApp has none. */
export function contactNameScript(number: string): string {
  return `(() => {
    try {
      const C = window.require('WAWebCollections');
      const id = ${JSON.stringify(`${number}@c.us`)};
      const contact = C.Contact.get(id);
      const chat = C.Chat.get(id);
      return String((contact && (contact.name || contact.pushname)) || (chat && (chat.name || chat.formattedTitle)) || '');
    } catch (e) { return ''; }
  })()`;
}

export function readWhatsAppSettings(db: Database.Database): WhatsAppSettings {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(WHATSAPP_SETTINGS_KEY) as { value: string } | undefined;
  if (row) {
    try {
      const parsed = JSON.parse(row.value);
      return {
        enabled: parsed?.enabled === true,
        chatNumber: typeof parsed?.chatNumber === 'string' && /^\d{7,15}$/.test(parsed.chatNumber) ? parsed.chatNumber : null,
      };
    } catch { /* fall through to the default */ }
  }
  // An install that already answered WhatsApp requests (before this setting existed) stays on.
  const legacy = db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get('whatsapp_chat.v1');
  return { enabled: Boolean(legacy), chatNumber: null };
}

export function writeWhatsAppSettings(db: Database.Database, settings: WhatsAppSettings): void {
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(WHATSAPP_SETTINGS_KEY, JSON.stringify(settings));
}

export interface WhatsAppConnection {
  status(): Promise<WhatsAppStatus>;
  /** Opens WhatsApp Web in BotBoy's Chrome (or brings its tab forward). False when Chrome is not running. */
  openWindow(): Promise<boolean>;
  settings(): WhatsAppSettings;
  update(input: Partial<WhatsAppSettings>): WhatsAppSettings;
}

export function createWhatsAppConnection(deps: {
  db: Database.Database;
  page: () => Promise<WhatsAppPage | null>;
  cdpEndpoint?: string;
  fetchImpl?: typeof fetch;
}): WhatsAppConnection {
  const endpoint = deps.cdpEndpoint ?? 'http://127.0.0.1:9222';
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function chromeUp(): Promise<boolean> {
    try {
      const response = await fetchImpl(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  return {
    async status() {
      const settings = readWhatsAppSettings(deps.db);
      const chrome = await chromeUp();
      const page = chrome ? await deps.page() : null;
      let session: WhatsAppStatus['session'] = page ? 'loading' : 'closed';
      let me: WhatsAppStatus['me'] = null;
      let chatName = '';
      if (page) {
        try {
          const parsed = JSON.parse(String(await page.evaluate(SESSION_READER) ?? '{}'));
          session = parsed.session ?? 'loading';
          if (session === 'signed_in') me = { number: String(parsed.number), name: String(parsed.name ?? '') };
          if (settings.chatNumber && session === 'signed_in') chatName = String(await page.evaluate(contactNameScript(settings.chatNumber)) ?? '');
        } catch { session = 'loading'; }
      }
      const chat = settings.chatNumber
        ? { number: settings.chatNumber, name: chatName || `+${settings.chatNumber}`, self: false }
        : me ? { number: me.number, name: me.name ? `${me.name} (You)` : 'Message yourself', self: true } : null;
      return { chrome, tabOpen: Boolean(page), session, me, enabled: settings.enabled, chat };
    },

    async openWindow() {
      if (!(await chromeUp())) return false;
      const page = await deps.page();
      if (page) {
        await page.bringToFront?.().catch(() => undefined);
        return true;
      }
      const url = `${endpoint}/json/new?${encodeURIComponent(WHATSAPP_WEB_URL)}`;
      // Chrome 111+ needs PUT for /json/new; older builds accept GET.
      const response = await fetchImpl(url, { method: 'PUT' }).catch(() => null);
      if (response?.ok) return true;
      const fallback = await fetchImpl(url).catch(() => null);
      return Boolean(fallback?.ok);
    },

    settings: () => readWhatsAppSettings(deps.db),

    update(input) {
      const next = { ...readWhatsAppSettings(deps.db), ...input };
      writeWhatsAppSettings(deps.db, next);
      return next;
    },
  };
}

/** The next step for the owner when WhatsApp is not ready to send. */
export function onboardingStep(status: WhatsAppStatus): string {
  if (!status.chrome) return 'BotBoy’s Chrome is not running. Restart BotBoy with ./start.sh, then ask again.';
  if (!status.tabOpen) return 'BotBoy is opening WhatsApp Web in its Chrome window. Sign in there, then ask again.';
  if (status.session === 'qr') return 'WhatsApp Web is open in BotBoy’s Chrome window and waiting for sign-in: on your phone open WhatsApp → Settings → Linked devices → Link a device, and scan the QR code. Then ask again.';
  if (status.session === 'loading') return 'WhatsApp Web is still loading in BotBoy’s Chrome window. Wait a moment, then ask again.';
  return '';
}
