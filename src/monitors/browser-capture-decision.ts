/**
 * Browser capture decisions: given what one read of a tab produced and what
 * BotBoy remembers about that address, say whether to wait, skip, or emit.
 *
 * Pure: no sockets, no clock, no maps. The monitor reads a tab in two phases
 * (a cheap probe, then the page's HTML only when a capture will be emitted),
 * so the decision is made from the probe alone; the one exception is a page
 * whose text never arrived, where the HTML is the last resort and the
 * decision asks for it (`need-html`) before it can finish.
 *
 * These rules were moved here from `browser-monitor.ts › pollOnce`
 * unchanged (the differential oracle in `browser-monitor.differential.test.ts`
 * holds the equivalence): growth, field debounce, settle attempts, and the
 * per-address recapture cap.
 */
import { htmlToText } from '../core/email-capture.js';

/** Below this, a page is still rendering (or is a shell) and is checked again. */
export const THIN_PAGE_CHARS = 200;
/** A captured static page is captured again once its text grows this much (an app that kept rendering). */
export const GROWTH_RATIO = 1.5;
export const GROWTH_MIN_CHARS = 300;
export const MAX_RECAPTURES = 3;

/**
 * What BotBoy remembers about a captured static page. `chars` is prose length
 * (the growth rule never sees field values); `fields` is the captured field
 * fingerprint, `pendingFields` a changed one waiting for a second equal poll,
 * and `segments` the last read of each field segment (a frame that fails one
 * poll keeps its previous read).
 */
export interface CapturedState {
  chars: number;
  recaptures: number;
  fields: string;
  pendingFields?: string;
  segments: Map<string, string>;
}

/** Everything the decision knows about one static address. */
export interface StaticTabState {
  captured?: CapturedState;
  /** Field segments read while the page was still thin (nothing captured yet). */
  lastSegments?: Map<string, string>;
  /** Polls spent waiting for real text. */
  settleAttempts: number;
}

/** What one probe of a static tab read. */
export interface StaticProbe {
  /** Page text plus Fields section plus frame blocks, as read (not yet trimmed). */
  text: string;
  /** Prose characters (page and frame text without Fields lines): the growth rule's measure. */
  proseChars: number;
  /** Characters of rendered Fields lines (counted by the thin-page settle). */
  fieldsChars: number;
  /** Field fingerprint per segment (`main`, then `frame:<i>:<url>`); null = not read this poll. */
  fieldSegments: Array<[string, string | null]>;
  /** True when the tab's text could not be read at all, so its HTML is not a fallback either. */
  unavailable?: boolean;
}

export type StaticDecision =
  /** Nothing to emit; `next` is the state to keep. */
  | { action: 'skip'; next: StaticTabState }
  /** A thin page that gets more polls before BotBoy settles for it. */
  | { action: 'settle-wait'; next: StaticTabState }
  /** A page with no text at its last attempt: ask for its HTML and decide again with it. */
  | { action: 'need-html'; next: StaticTabState }
  /** Capture it: `content` is the trimmed text to store; `next` is the state after capturing. */
  | { action: 'emit'; next: StaticTabState; content: string };

/** A static page settled and re-captured enough: leave it (checked before any read). */
export function isStaticCaptureExhausted(state: StaticTabState): boolean {
  return !!state.captured && state.captured.recaptures >= MAX_RECAPTURES;
}

/** The tab's combined field fingerprint, filling unread segments from the previous poll. */
export function mergeFieldSegments(
  previous: Map<string, string> | undefined,
  read: Array<[string, string | null]>,
): { fingerprint: string; segments: Map<string, string> } {
  const segments = new Map<string, string>();
  for (const [key, value] of read) segments.set(key, value ?? previous?.get(key) ?? `${key}|unread`);
  return { fingerprint: [...segments].map(([key, value]) => `${key}=${value}`).join('\n'), segments };
}

/**
 * Decides one static (non-mail, non-chat) tab. `html` is supplied only on the
 * second call after a `need-html`; the same `state` and `probe` are passed
 * again, so the outcome is a pure function of the three.
 */
export function decideStaticCapture(input: {
  state: StaticTabState;
  probe: StaticProbe;
  html?: string;
  maxSettleAttempts: number;
}): StaticDecision {
  const { state, probe, html, maxSettleAttempts } = input;
  const previous = state.captured;
  const { fingerprint, segments } = mergeFieldSegments(previous?.segments ?? state.lastSegments, probe.fieldSegments);
  let chars = probe.proseChars;
  let content = probe.text.trim();

  // An app still rendering returns a shell ("Loading…") or nothing. Wait for
  // real text a few polls before settling for what there is; the page's HTML
  // is the last resort (text read from it here). A mostly-form page counts
  // its fields as real content.
  if (probe.proseChars + probe.fieldsChars < THIN_PAGE_CHARS && !previous) {
    const attempts = state.settleAttempts + 1;
    const waiting: StaticTabState = { captured: undefined, lastSegments: segments, settleAttempts: attempts };
    if (attempts < maxSettleAttempts) return { action: 'settle-wait', next: waiting };
    if (!content) {
      if (probe.unavailable) return { action: 'skip', next: waiting };
      if (html === undefined) return { action: 'need-html', next: waiting };
      if (html) { content = htmlToText(html).trim(); chars = content.length; }
    }
    if (!content) return { action: 'skip', next: waiting };
  }

  if (previous) {
    const reread: CapturedState = { ...previous, segments };
    // Captured before: a page that kept rendering much more prose is
    // captured again; field values never count toward growth.
    const grew = chars >= previous.chars * GROWTH_RATIO && chars - previous.chars >= GROWTH_MIN_CHARS;
    if (!grew) {
      // A field change is captured once it holds for two consecutive polls,
      // so a form mid-typing is never captured.
      if (fingerprint === previous.fields) {
        return { action: 'skip', next: { ...state, captured: { ...reread, pendingFields: undefined } } };
      }
      if (previous.pendingFields !== fingerprint) {
        return { action: 'skip', next: { ...state, captured: { ...reread, pendingFields: fingerprint } } };
      }
    }
  }

  return {
    action: 'emit',
    content,
    next: {
      captured: { chars, recaptures: previous ? previous.recaptures + 1 : 0, fields: fingerprint, pendingFields: undefined, segments },
      lastSegments: undefined,
      settleAttempts: 0,
    },
  };
}

export function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

export type DynamicDecision =
  | { action: 'skip' }
  | { action: 'emit'; hash: string };

/** Dynamic pages (mail, chat) emit on a text-hash change; empty text is never captured. */
export function decideDynamicCapture(lastHash: string | undefined, content: string): DynamicDecision {
  if (!content) return { action: 'skip' };
  const hash = simpleHash(content);
  if (lastHash === hash) return { action: 'skip' };
  return { action: 'emit', hash };
}
