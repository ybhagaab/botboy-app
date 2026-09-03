/**
 * Owner identity — the single place BotBoy decides WHO its owner is and
 * whether a piece of text names them.
 *
 * Determination precedence (first hit wins per field):
 *   1. Explicit overrides: settings `owner_identity.name` / `owner_identity.alias`
 *      — any user can pin these when detection gets their name wrong.
 *   2. Feature-level legacy override: `sharepoint_sync.owner_name` (name only).
 *   3. Detected identity: `grasp_sync.owner_name` + `grasp_sync.owner_email`
 *      (written by GRASP's get_profile on first mail sync; alias = the email
 *      local part, e.g. ybhagaab@amazon.com → ybhagaab).
 *
 * Guardrails (why this module exists — 2026-09-01 incident: the owner was
 * @-mentioned in a Word comment and never flagged):
 *   - CHIP FUSION: Word mention chips glue to the next typed word when the
 *     author types no space ("@Bhagat, ABWhat is the latency?"). Boundary-
 *     only matching misses these; the chip rule below catches them for ANY
 *     display name, not one specific owner.
 *   - PREFIX COLLISIONS: fused matching must not make "AB" match
 *     "@Bhagat, Abhishek". Fusion is accepted only when the continuation
 *     looks like a NEW CamelCase word (uppercase letter followed by a
 *     lowercase letter). Lowercase or ALL-CAPS continuations are rejected.
 *   - SHORT TOKENS: names/aliases of ≤2 characters never match as standalone
 *     words (too collision-prone); they only count inside a full-name phrase
 *     or an @-prefixed form.
 *   - UNKNOWN IDENTITY: with no name and no alias configured or detected,
 *     the matcher matches NOTHING (fail-quiet, sharepoint spec R3.3) and
 *     `known=false` so surfaces can WARN instead of silently classifying
 *     everything as not-the-owner.
 */
import type Database from 'better-sqlite3';
import { getSetting } from './storage.js';

export interface OwnerIdentity {
  /** False when neither a name nor an alias could be determined. */
  known: boolean;
  /** Display name as configured/detected, e.g. "Bhagat, AB". */
  displayName: string;
  /** Login/alias, e.g. "ybhagaab" (email local part unless overridden). */
  alias: string;
  /** Full email when known. */
  email: string;
  /** Normalized lowercase name tokens, e.g. ["bhagat","ab"]. */
  nameTokens: string[];
  /** Where the name came from: override | sharepoint | grasp | none. */
  nameSource: 'override' | 'sharepoint' | 'grasp' | 'none';
  /** Where the alias came from: override | email | none. */
  aliasSource: 'override' | 'email' | 'none';
}

export interface OwnerMatcher {
  identity: OwnerIdentity;
  /** Is this author string the owner? (comment/mail author fields) */
  isOwner(author: string): boolean;
  /** Does this text @-mention or name the owner? */
  mentionsOwner(text: string): boolean;
  /**
   * True when the text contains '@' plus one of the owner's name tokens but
   * mentionsOwner said no — observability hook so the NEXT fusion-shaped
   * failure shows up in logs instead of vanishing as mentionedMe=false.
   */
  nearMiss(text: string): boolean;
}

const normalize = (value: string): string[] =>
  value.toLowerCase().replace(/[.,;:'"()@<>]/g, ' ').split(/\s+/).filter(Boolean);

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isLower = (ch: string | undefined): boolean => !!ch && ch >= 'a' && ch <= 'z';
const isUpper = (ch: string | undefined): boolean => !!ch && ch >= 'A' && ch <= 'Z';
const isLetter = (ch: string | undefined): boolean => isLower(ch) || isUpper(ch) || (!!ch && ch.toLowerCase() !== ch.toUpperCase());

/** Resolve the owner's identity from settings (see precedence above). */
export function resolveOwnerIdentity(db: Database.Database): OwnerIdentity {
  const overrideName = (getSetting<string>(db, 'owner_identity.name') ?? '').trim();
  const sharepointName = (getSetting<string>(db, 'sharepoint_sync.owner_name') ?? '').trim();
  const graspName = (getSetting<string>(db, 'grasp_sync.owner_name') ?? '').trim();
  const displayName = overrideName || sharepointName || graspName;
  const nameSource: OwnerIdentity['nameSource'] =
    overrideName ? 'override' : sharepointName ? 'sharepoint' : graspName ? 'grasp' : 'none';

  const email = (getSetting<string>(db, 'grasp_sync.owner_email') ?? '').trim().toLowerCase();
  const overrideAlias = (getSetting<string>(db, 'owner_identity.alias') ?? '').trim().toLowerCase();
  const emailAlias = email.includes('@') ? email.split('@')[0] : '';
  const alias = overrideAlias || emailAlias;
  const aliasSource: OwnerIdentity['aliasSource'] =
    overrideAlias ? 'override' : emailAlias ? 'email' : 'none';

  const nameTokens = normalize(displayName);
  return {
    known: nameTokens.length > 0 || alias.length > 0,
    displayName,
    alias,
    email,
    nameTokens,
    nameSource,
    aliasSource,
  };
}

/** Pure matcher construction — unit-testable without a database. */
export function createMatcher(identity: OwnerIdentity): OwnerMatcher {
  const { nameTokens, alias, email } = identity;

  // ---- boundary phrases (normalized-haystack containment) ----------------
  // Multi-token names match in both orders ("bhagat ab" / "ab bhagat").
  // Standalone single words require length ≥3 (short-token guard).
  const phrases = new Set<string>();
  if (nameTokens.length >= 2) {
    phrases.add(nameTokens.join(' '));
    phrases.add([...nameTokens].reverse().join(' '));
  } else if (nameTokens.length === 1 && nameTokens[0].length >= 3) {
    phrases.add(nameTokens[0]);
  }
  if (alias.length >= 3) phrases.add(alias);

  // ---- @-chip patterns (raw-text, fusion-tolerant) ------------------------
  // "@" + token sequence separated by commas/whitespace. The final token may
  // fuse into the next word ("...ABWhat") — validated by the CamelCase test
  // on the characters that follow the match.
  const chipPatterns: RegExp[] = [];
  const addChip = (tokens: string[]): void => {
    if (tokens.length === 0) return;
    chipPatterns.push(new RegExp(`@\\s*${tokens.map(escapeRegex).join('[,\\s]+')}`, 'gi'));
  };
  if (nameTokens.length >= 2) {
    addChip(nameTokens);
    addChip([...nameTokens].reverse());
  } else if (nameTokens.length === 1) {
    addChip(nameTokens);
  }
  if (alias) addChip([alias]);

  const chipMatches = (text: string): boolean => {
    for (const pattern of chipPatterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const next = text[match.index + match[0].length];
        const after = text[match.index + match[0].length + 1];
        // Clean boundary: end of text or a non-letter — a real mention.
        if (!isLetter(next)) return true;
        // Fused continuation: accept only a fresh CamelCase word ("ABWhat").
        // Lowercase ("Abhishek…") = we matched a prefix of a longer name;
        // ALL-CAPS ("ABHISHEK") = same risk. Both rejected.
        if (isUpper(next) && isLower(after)) return true;
        // Otherwise keep scanning later occurrences.
        if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
      }
    }
    return false;
  };

  // Author-field extras allowed beyond the name itself: the alias and email
  // fragments ("Bhagat, AB (ybhagaab)", "AB Bhagat <ybhagaab@amazon.com>").
  const allowedExtras = new Set<string>([
    ...(alias ? [alias] : []),
    ...normalize(email),
  ]);
  const sortedNameTokens = [...nameTokens].sort();

  return {
    identity,
    isOwner(author: string): boolean {
      if (!identity.known) return false;
      const authorTokens = normalize(author);
      if (authorTokens.length === 0) return false;
      // Alias-only author string.
      if (alias && authorTokens.length === 1 && authorTokens[0] === alias) return true;
      if (sortedNameTokens.length === 0) return false;
      // Exact token-set equality (any order).
      const sortedAuthor = [...authorTokens].sort();
      if (sortedAuthor.length === sortedNameTokens.length
        && sortedNameTokens.every((t, i) => t === sortedAuthor[i])) return true;
      // Name tokens all present; every extra token must be alias/email debris.
      const authorSet = new Set(authorTokens);
      if (!sortedNameTokens.every(t => authorSet.has(t))) return false;
      return authorTokens.every(t => sortedNameTokens.includes(t) || allowedExtras.has(t));
    },
    mentionsOwner(text: string): boolean {
      if (!identity.known || !text) return false;
      if (phrases.size > 0) {
        const haystack = ` ${text.toLowerCase().replace(/[.,;:'"()@<>]/g, ' ').replace(/\s+/g, ' ')} `;
        for (const phrase of phrases) {
          if (haystack.includes(` ${phrase} `)) return true;
        }
      }
      return chipMatches(text);
    },
    nearMiss(text: string): boolean {
      if (!identity.known || !text || !text.includes('@')) return false;
      if (this.mentionsOwner(text)) return false;
      const lower = text.toLowerCase();
      return nameTokens.some(t => t.length >= 3 && lower.includes(t))
        || (alias.length >= 3 && lower.includes(alias));
    },
  };
}

/** Convenience: resolve identity from settings and build the matcher. */
export function createOwnerMatcher(db: Database.Database): OwnerMatcher {
  return createMatcher(resolveOwnerIdentity(db));
}
