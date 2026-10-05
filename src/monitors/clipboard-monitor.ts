/**
 * Clipboard Monitor — tracks macOS clipboard (NSPasteboard) changes.
 *
 * Polls the clipboard at regular intervals, captures text, URLs, and
 * file references. A copy is captured once per distinct content.
 *
 * Private copies are never captured: passwords, keys, and tokens are copied
 * often, and clipboard items reach routing, brains, and chat search like any
 * other evidence. Three local checks, cheapest first, decide before anything
 * is stored:
 *   1. high-confidence secret formats (`sensitive-files.ts › detectSecrets`);
 *   2. a lone token shaped like a generated password;
 *   3. the pasteboard's own privacy markers — password managers tag their
 *      copies `org.nspasteboard.ConcealedType` (nspasteboard.org), read from
 *      the type list without touching the contents.
 * A held copy is logged by kind only, never by value.
 */

import { execFile, execSync } from 'child_process';
import { createHash } from 'crypto';
import type { RawWorkItem } from '../core/types.js';
import { describeSecretKinds, detectSecrets } from '../core/sensitive-files.js';

export interface ClipboardMonitor {
  start(): void;
  stop(): void;
  onWorkItem(callback: (item: RawWorkItem) => void): void;
}

export interface ClipboardMonitorConfig {
  pollIntervalMs: number;
  dedupWindowMs: number;
}

export interface ClipboardMonitorDeps {
  /** Current clipboard text (default: `pbpaste`). */
  readText?: () => string | null;
  /** Pasteboard type identifiers, never contents (default: one `osascript` call). Null when unavailable. */
  readTypes?: () => Promise<string[] | null>;
  /** Called for every copy that is not captured, with an owner-safe reason. */
  onHeld?: (reason: string) => void;
}

const DEFAULT_CONFIG: ClipboardMonitorConfig = {
  pollIntervalMs: 1000,
  dedupWindowMs: 5000,
};

/** Pasteboard types that mark a copy as private (nspasteboard.org convention). */
const PRIVATE_PASTEBOARD_TYPES: ReadonlySet<string> = new Set([
  'org.nspasteboard.ConcealedType',
  'org.nspasteboard.TransientType',
  // 1Password before it adopted the shared marker.
  'com.agilebits.onepassword',
]);

/** JXA: the general pasteboard's type identifiers as JSON. Reads no contents. */
const PASTEBOARD_TYPES_SCRIPT = [
  "ObjC.import('AppKit');",
  'var t = $.NSPasteboard.generalPasteboard.types; var o = [];',
  'for (var i = 0; i < t.count; i++) o.push(ObjC.unwrap(t.objectAtIndex(i)));',
  'JSON.stringify(o)',
].join(' ');

function readPasteboardTypes(): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', PASTEBOARD_TYPES_SCRIPT], { timeout: 3000 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const parsed = JSON.parse(String(stdout).trim());
        resolve(Array.isArray(parsed) ? parsed.map(String) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

function readClipboardText(): string | null {
  try {
    return execSync('pbpaste', { encoding: 'utf-8', timeout: 2000 }).trim();
  } catch {
    return null;
  }
}

/**
 * A lone token shaped like a generated password: 10–64 characters, no
 * spaces, upper and lower case letters, a digit, and a symbol. URLs, paths,
 * email addresses, file names, and hex/UUID identifiers are excluded.
 */
export function looksLikeCopiedPassword(text: string): boolean {
  const value = text.trim();
  if (value.length < 10 || value.length > 64 || /\s/.test(value)) return false;
  if (value.includes('/') || value.startsWith('~') || value.startsWith('.')) return false;
  if (/^[^@]+@[^@]+\.[A-Za-z]{2,}$/.test(value)) return false;
  if (/^[\w-]+\.[A-Za-z0-9]{1,5}$/.test(value)) return false;
  if (/^[0-9a-f-]+$/i.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(value)).length;
  return classes === 4 && new Set(value).size >= 8;
}

/** Why a copy must not be captured, or null when it may be. */
export function privateCopyReasonFromText(text: string): string | null {
  const secrets = detectSecrets(text);
  if (secrets.length > 0) return describeSecretKinds(secrets);
  if (looksLikeCopiedPassword(text)) return 'Looks like a copied password';
  return null;
}

export function createClipboardMonitor(
  config?: Partial<ClipboardMonitorConfig>,
  deps: ClipboardMonitorDeps = {},
): ClipboardMonitor {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const readText = deps.readText ?? readClipboardText;
  const readTypes = deps.readTypes ?? readPasteboardTypes;
  const onHeld = deps.onHeld ?? ((reason: string) => console.log(`[clipboard] not captured: ${reason}`));
  const listeners: ((item: RawWorkItem) => void)[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  // A digest, not the text: a held password must not linger in memory.
  let lastContentDigest = '';
  let polling = false;

  function emit(item: RawWorkItem): void {
    for (const fn of listeners) {
      try { fn(item); } catch (err) { console.error('ClipboardMonitor listener error:', err); }
    }
  }

  function detectContentType(text: string): 'url' | 'file_reference' | 'text' {
    if (/^https?:\/\//i.test(text)) return 'url';
    if (/^\//.test(text) || /^~\//.test(text)) return 'file_reference';
    return 'text';
  }

  async function pollOnce(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const text = readText();
      if (!text || text.length === 0) return;

      // Only act when clipboard content actually changes
      const digest = createHash('sha256').update(text).digest('hex');
      if (digest === lastContentDigest) return;
      lastContentDigest = digest;

      const textReason = privateCopyReasonFromText(text);
      if (textReason) {
        onHeld(textReason);
        return;
      }
      const types = await readTypes();
      // The marker must describe this copy, not a newer one: if the clipboard
      // changed while the types were read, the next poll decides afresh.
      if (readText() !== text) {
        lastContentDigest = '';
        return;
      }
      if (types?.some((type) => PRIVATE_PASTEBOARD_TYPES.has(type))) {
        onHeld('Marked private by the app it was copied from');
        return;
      }

      // Lossless capture: store the full clipboard content, no size cap
      // (lossless-capture-brain-pipeline R1.1/R1.2). `title` and
      // `metadata.originalContent` remain short *derived previews* only.
      const content = text;
      const contentType = detectContentType(content);

      emit({
        type: 'clipboard_capture',
        source: 'clipboard',
        sourceApp: 'System',
        content,
        title: content.slice(0, 100),
        url: contentType === 'url' ? content : undefined,
        metadata: { contentType, originalContent: content.slice(0, 500) },
        capturedAt: new Date(),
      });
    } catch (err) {
      console.error('ClipboardMonitor poll error:', err);
    } finally {
      polling = false;
    }
  }

  return {
    start(): void {
      void pollOnce();
      pollTimer = setInterval(() => { void pollOnce(); }, cfg.pollIntervalMs);
    },

    stop(): void {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },

    onWorkItem(callback: (item: RawWorkItem) => void): void {
      listeners.push(callback);
    },
  };
}
