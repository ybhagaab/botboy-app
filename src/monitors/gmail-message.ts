/**
 * One Gmail API message → the canonical email work item (pure, no I/O).
 *
 * The item matches GRASP's Outlook contract field for field
 * (grasp-sync.ts › buildEmailItem): same types, metadata keys and string
 * serialization, the shared rendered content (email-capture.ts), and the
 * shared noise and address rules. Differences are only where Gmail's data
 * differs: the conversation id is the Gmail threadId, the message time is
 * Gmail's internalDate, and owner aliases (send-as addresses, Gmail dot and
 * plus forms) are canonicalized to the account address in metadata so the
 * relational rules (sole-To owner, owner-authored sent mail) recognize them.
 */

import type { RawWorkItem } from '../core/types.js';
import type { GmailMessage, GmailMessagePart } from '../core/gmail-api.js';
import { normalizeOutlookAddress } from '../core/email-thread.js';
import { htmlToText, isNoiseEmail, renderCanonicalEmailContent } from '../core/email-capture.js';

export const GMAIL_PLATFORM = 'gmail_api';
export const GMAIL_SOURCE_APP = 'Gmail';

export function gmailItemUrl(messageId: string): string {
  return `gmail://mail/${messageId}`;
}

/** Labels that never become evidence, decided from the id/labels alone. */
const SKIP_LABELS = new Set(['DRAFT', 'SPAM', 'TRASH', 'CHAT']);
/** Received mail in these Gmail categories is bulk by Gmail's own sorting. */
const SKIP_RECEIVED_CATEGORIES = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL']);

export type GmailSkipReason = 'draft_spam_trash' | 'category' | 'noise' | 'not_addressed' | 'unreadable';

/** Cheap pre-check on list/history label ids: skip without fetching the message. */
export function skipByLabels(labelIds: readonly string[] | undefined): GmailSkipReason | null {
  const labels = new Set(labelIds ?? []);
  for (const label of labels) if (SKIP_LABELS.has(label)) return 'draft_spam_trash';
  if (!labels.has('SENT')) {
    for (const label of labels) if (SKIP_RECEIVED_CATEGORIES.has(label)) return 'category';
  }
  return null;
}

// ── Owner identity ───────────────────────────────────────────────────────

export interface GmailOwner {
  /** The connected account address, lowercase. */
  primary: string;
  /** Send-as aliases, lowercase (may include the primary). */
  aliases: ReadonlySet<string>;
}

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** Consumer Gmail ignores dots and +tags in the local part; googlemail.com is gmail.com. */
function gmailCanonical(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return address;
  const domain = address.slice(at + 1);
  if (!GMAIL_DOMAINS.has(domain)) return address;
  const local = address.slice(0, at).split('+')[0].replace(/\./g, '');
  return `${local}@gmail.com`;
}

export function isOwnerAddress(address: string, owner: GmailOwner): boolean {
  const value = address.trim().toLowerCase();
  if (!value) return false;
  if (value === owner.primary || owner.aliases.has(value)) return true;
  const canonical = gmailCanonical(value);
  if (canonical === gmailCanonical(owner.primary)) return true;
  for (const alias of owner.aliases) if (canonical === gmailCanonical(alias)) return true;
  return false;
}

// ── Headers and addresses ────────────────────────────────────────────────

function decodeBytes(bytes: Buffer, charset: string): string {
  const label = charset.trim().toLowerCase() || 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/** RFC 2047 encoded words (`=?utf-8?B?…?=`, `=?iso-8859-1?Q?…?=`) in a header value. */
export function decodeMimeWords(value: string): string {
  if (!value.includes('=?')) return value;
  const word = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
  // Whitespace between two adjacent encoded words is not part of the text.
  const joined = value.replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)/g, '$1');
  return joined.replace(word, (match, charset: string, encoding: string, text: string) => {
    try {
      const bytes = encoding.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64')
        : Buffer.from(
          text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))),
          'latin1',
        );
      return decodeBytes(bytes, charset.split('*')[0]);
    } catch {
      return match;
    }
  });
}

export interface ParsedAddress {
  name: string;
  /** Lowercase address; '' when the entry carried none. */
  address: string;
  /** The address as written (case kept), for the rendered From line. */
  rawAddress: string;
}

/** Split an RFC 5322 address list on commas outside quotes, angle brackets, and comments. */
export function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  let comment = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quoted) {
      current += char;
      if (char === '\\' && index + 1 < value.length) { current += value[++index]; continue; }
      if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; current += char; continue; }
    if (char === '(') comment++;
    else if (char === ')' && comment > 0) comment--;
    else if (char === '<') angle++;
    else if (char === '>' && angle > 0) angle--;
    if ((char === ',' || char === ';') && angle === 0 && comment === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map(part => part.trim()).filter(Boolean);
}

export function parseAddressList(value: string | undefined): ParsedAddress[] {
  if (!value) return [];
  const out: ParsedAddress[] = [];
  for (let entry of splitAddressList(value)) {
    // Group syntax "Team: a@x.com, b@y.com;" — drop the label before the first member.
    entry = entry.replace(/^[^:<>"@]*:\s*/, '');
    if (!entry) continue;
    const angle = entry.match(/<([^<>]*)>/);
    const rawCandidate = angle ? angle[1].trim() : entry.replace(/\([^)]*\)/g, '').trim();
    const address = normalizeOutlookAddress(rawCandidate);
    if (!address) continue;
    const rawAddress = rawCandidate.match(/[^\s<>()"]+@[^\s<>()"]+/)?.[0] ?? address;
    const namePart = angle ? entry.slice(0, angle.index).trim() : (entry.match(/\(([^)]*)\)/)?.[1] ?? '');
    const name = decodeMimeWords(namePart.replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1')).trim();
    out.push({ name, address, rawAddress });
  }
  return out;
}

export function messageHeaders(message: GmailMessage): Map<string, string> {
  const headers = new Map<string, string>();
  for (const header of message.payload?.headers ?? []) {
    const name = String(header?.name ?? '').toLowerCase();
    if (name && !headers.has(name)) headers.set(name, String(header?.value ?? ''));
  }
  return headers;
}

// ── Body ─────────────────────────────────────────────────────────────────

function partCharset(part: GmailMessagePart): string {
  const contentType = (part.headers ?? []).find(header => header.name?.toLowerCase() === 'content-type')?.value ?? '';
  return contentType.match(/charset\s*=\s*"?([^";\s]+)"?/i)?.[1] ?? 'utf-8';
}

function decodePartData(part: GmailMessagePart): string {
  const data = part.body?.data;
  if (!data) return '';
  return decodeBytes(Buffer.from(data, 'base64url'), partCharset(part));
}

function isAttachmentPart(part: GmailMessagePart): boolean {
  return Boolean(part.filename && part.filename.trim());
}

export interface GmailAttachmentInfo {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/** Every attachment's name, type, and size (never its content), in payload order. */
export function messageAttachments(message: GmailMessage): GmailAttachmentInfo[] {
  const out: GmailAttachmentInfo[] = [];
  const walk = (part: GmailMessagePart | undefined, depth: number): void => {
    if (!part || depth > 20) return;
    if (isAttachmentPart(part)) {
      const filename = part.filename!.trim();
      out.push({
        filename: filename.length > 200 ? `${filename.slice(0, 199)}…` : filename,
        mimeType: String(part.mimeType ?? ''),
        sizeBytes: Number(part.body?.size ?? 0) || 0,
      });
    }
    for (const child of part.parts ?? []) walk(child, depth + 1);
  };
  walk(message.payload, 0);
  return out;
}

export interface GmailBody {
  text: string;
  hasAttachments: boolean;
}

/** text/plain preferred, else stripped text/html, else the snippet. */
export function messageBody(message: GmailMessage): GmailBody {
  let plain = '';
  let html = '';
  let hasAttachments = false;
  const walk = (part: GmailMessagePart | undefined, depth: number): void => {
    if (!part || depth > 20) return;
    if (isAttachmentPart(part)) { hasAttachments = true; return; }
    const mime = String(part.mimeType ?? '').toLowerCase();
    if (mime === 'text/plain' && !plain) plain = decodePartData(part);
    else if (mime === 'text/html' && !html) html = decodePartData(part);
    for (const child of part.parts ?? []) walk(child, depth + 1);
  };
  walk(message.payload, 0);
  const text = plain.trim()
    ? plain.replace(/\r\n?/g, '\n').trim()
    : html.trim()
      ? htmlToText(html)
      : htmlToText(message.snippet ?? '');
  return { text, hasAttachments };
}

// ── Decision + item ──────────────────────────────────────────────────────

export function messageTimestampOf(message: GmailMessage): string {
  const millis = Number(message.internalDate);
  if (Number.isFinite(millis) && millis > 0) return new Date(millis).toISOString();
  return '';
}

export type GmailDecision =
  | { kind: 'emit'; item: RawWorkItem; direction: 'received' | 'sent' }
  | { kind: 'skip'; reason: GmailSkipReason };

/**
 * Same order as GRASP: label/category skips, noise BEFORE the address check
 * (automation addresses the owner directly), then received mail is kept only
 * when the owner is literally in To or Cc. Sent mail has no filters.
 */
export function decideGmailMessage(message: GmailMessage, owner: GmailOwner, noisePatterns: readonly string[]): GmailDecision {
  const labelSkip = skipByLabels(message.labelIds);
  if (labelSkip) return { kind: 'skip', reason: labelSkip };
  if (!message.id || !message.threadId) return { kind: 'skip', reason: 'unreadable' };

  const headers = messageHeaders(message);
  const subjectHeader = headers.has('subject') ? decodeMimeWords(headers.get('subject') ?? '').trim() : '';
  const from = parseAddressList(headers.get('from'))[0];
  const to = parseAddressList(headers.get('to'));
  const cc = parseAddressList(headers.get('cc'));
  const sent = (message.labelIds ?? []).includes('SENT') || Boolean(from && isOwnerAddress(from.address, owner) && !(message.labelIds ?? []).includes('INBOX'));
  const direction: 'received' | 'sent' = sent ? 'sent' : 'received';

  let directlyAddressed = false;
  if (direction === 'received') {
    if (isNoiseEmail({ subject: subjectHeader, fromAddress: from?.address, fromName: from?.name }, noisePatterns)) {
      return { kind: 'skip', reason: 'noise' };
    }
    directlyAddressed = to.some(entry => isOwnerAddress(entry.address, owner));
    const ccOwner = cc.some(entry => isOwnerAddress(entry.address, owner));
    if (!directlyAddressed && !ccOwner) return { kind: 'skip', reason: 'not_addressed' };
  }

  const body = messageBody(message);
  const messageTimestamp = messageTimestampOf(message);
  const capturedAt = messageTimestamp ? new Date(messageTimestamp) : new Date();
  // Metadata names the owner by the account address, whichever alias the
  // mail used; the rendered content keeps the addresses as written.
  const canonical = (address: string) => (isOwnerAddress(address, owner) ? owner.primary : address);
  const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
  const toMeta = unique(to.map(entry => canonical(entry.address)));
  const ccMeta = unique(cc.map(entry => canonical(entry.address)));
  const subject = subjectHeader || '(no subject)';
  const labels = new Set(message.labelIds ?? []);

  const item: RawWorkItem = {
    type: direction === 'sent' ? 'email_sent' : 'email_read',
    source: 'gmail',
    sourceApp: GMAIL_SOURCE_APP,
    url: gmailItemUrl(message.id),
    title: subject,
    content: renderCanonicalEmailContent({
      subject,
      fromLabel: `${from?.name ?? ''} <${from?.rawAddress ?? ''}>`.trim(),
      to: unique(to.map(entry => entry.address)),
      cc: unique(cc.map(entry => entry.address)),
      direction,
      messageTimestamp,
      body: body.text,
    }),
    metadata: {
      subject: subjectHeader,
      sender: from ? canonical(from.address) : '',
      senderName: from?.name ?? '',
      recipients: toMeta.join(','),
      toRecipients: toMeta.join(','),
      ccRecipients: ccMeta.join(','),
      direction,
      ownerEmail: owner.primary,
      directlyAddressedToOwner: directlyAddressed ? 'true' : 'false',
      conversationId: message.threadId,
      messageTimestamp,
      importance: '',
      hasAttachments: body.hasAttachments ? 'true' : 'false',
      folder: direction === 'sent' ? 'sent' : labels.has('INBOX') ? 'inbox' : 'archive',
      gmailId: message.id,
      rfcMessageId: (headers.get('message-id') ?? '').trim().slice(0, 998),
      inReplyTo: (headers.get('in-reply-to') ?? '').trim().slice(0, 998),
      platform: GMAIL_PLATFORM,
    },
    capturedAt: Number.isNaN(capturedAt.getTime()) ? new Date() : capturedAt,
  };
  return { kind: 'emit', item, direction };
}
