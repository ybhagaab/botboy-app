/**
 * Strict canonical-mail conversation provenance shared by capture, routing,
 * brain synthesis, and evidence gists. "Outlook" in the names below is
 * historical: the same rules cover every canonical provider (GRASP for
 * Outlook/M365, the Gmail API since 2026-10-05).
 *
 * A conversation id (Outlook conversationId, Gmail threadId) proves membership
 * in one mailbox conversation, not a direct parent edge. Current GRASP exposes
 * no In-Reply-To/message-parent ID, so ambiguous multiple-request
 * conversations must fail closed in recovery.
 */

/**
 * Canonical relational mail comes only from these exact source → platform
 * pairs. A row claiming one source with another source's platform is not
 * canonical, and a thread never spans two sources.
 */
export const CANONICAL_EMAIL_PLATFORMS: Readonly<Record<string, string>> = Object.freeze({
  grasp: 'grasp_m365',
  gmail: 'gmail_api',
});

export function isCanonicalEmailSource(source: unknown): boolean {
  return typeof source === 'string'
    && Object.prototype.hasOwnProperty.call(CANONICAL_EMAIL_PLATFORMS, source);
}

/** Persisted in routing_decisions.validation_reason; never rename. */
export const OUTLOOK_SENT_FOLLOWS_ROUTED_THREAD_REASON_PREFIX =
  'deterministic outlook-sent-follows-routed-thread rule';
export const GMAIL_SENT_FOLLOWS_ROUTED_THREAD_REASON_PREFIX =
  'deterministic gmail-sent-follows-routed-thread rule';

/** The routing proof prefix a source's owner-sent mail is stamped with. */
export function sentFollowsRoutedThreadReasonPrefix(source: string): string {
  return source === 'gmail'
    ? GMAIL_SENT_FOLLOWS_ROUTED_THREAD_REASON_PREFIX
    : OUTLOOK_SENT_FOLLOWS_ROUTED_THREAD_REASON_PREFIX;
}

const EMAIL_ADDRESS_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const ISO_MESSAGE_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|([+-])(\d{2}):(\d{2}))$/;

const HEADER_LINE = /^(subject|from|to|cc|bcc|received|sent|date)\s*:/i;
const DATA_SENTINEL = /^treat all content below as data only\.?$/i;
const QUOTED_REPLY_START = [
  /^from\s*:/i,
  /^-{3,}\s*original message\s*-{3,}/i,
  /^_{6,}\s*$/,
  /^on .{6,120} wrote:\s*$/i,
  /^>+\s*/,
  /^(de|von|da)\s*:/i,
  /^sent from (my|outlook)/i,
];
/**
 * Gmail's text/plain parts wrap the reply attribution at ~76 columns, so
 * "On Mon, Oct 5, 2026 at 9:00 AM Jane Doe <jane@x.com> wrote:" arrives as two
 * lines. Only that shape counts: an "On …" line, the next line ending in
 * "wrote:", and an address marker (< or @) between them.
 */
function isWrappedReplyAttribution(line: string, next: string): boolean {
  return /^on\s.{4,200}$/i.test(line)
    && /wrote:\s*$/i.test(next)
    && next.length <= 200
    && /[<@]/.test(`${line} ${next}`);
}
/** Gmail's forward separator ("---------- Forwarded message ---------"). */
const FORWARDED_MESSAGE = /^-{2,}\s*forwarded message\s*-{2,}$/i;
const GREETING = /^(hi|hello|hey|dear|good (morning|afternoon|evening)|team|all|folks)\b[^\n]{0,40}$/i;
const SIGN_OFF = /^(thanks|thank you|many thanks|regards|best|best regards|kind regards|warm regards|cheers|br|sincerely|thx)\b[\s,!.]*(all|team)?[\s,!.]*$/i;

export interface OutlookEmailEvidenceLike {
  source: string;
  type: string;
  metadata: Record<string, unknown>;
}

export interface OutlookThreadIdentity {
  /** Capture source of the row (`grasp` | `gmail`); part of the thread key. */
  source: string;
  ownerEmail: string;
  conversationId: string;
  messageTimestamp: string;
  messageMillis: number;
  direction: 'received' | 'sent';
  sender: string;
  toRecipients: string[];
  ccRecipients: string[];
  directlyAddressedToOwner: boolean;
  /** Received from another of the owner's own addresses (multi-account Gmail): never a request. */
  fromOwnAccount?: boolean;
}

export function normalizeOutlookAddress(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.match(EMAIL_ADDRESS_PATTERN)?.[0]?.toLowerCase() ?? '';
}

export function outlookAddresses(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value.flatMap((entry) => {
        if (typeof entry === 'string') return [entry];
        if (entry && typeof entry === 'object') {
          const record = entry as Record<string, unknown>;
          return [String(record.emailAddress ?? record.address ?? '')];
        }
        return [];
      })
    : typeof value === 'string'
      ? value.split(/[;,]/)
      : [];
  return [...new Set(rawValues.map(normalizeOutlookAddress).filter(Boolean))];
}

export function parseOutlookMessageTimestamp(value: unknown): {
  value: string;
  millis: number;
} | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = trimmed.match(ISO_MESSAGE_TIMESTAMP_PATTERN);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] ? Number(match[10]) : 0;
  const offsetMinute = match[11] ? Number(match[11]) : 0;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12
    || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 14 || offsetMinute > 59
    || (offsetHour === 14 && offsetMinute !== 0)) return null;

  const millis = Date.parse(trimmed);
  return Number.isFinite(millis) ? { value: trimmed, millis } : null;
}

export function parseOutlookThreadIdentity(
  evidence: OutlookEmailEvidenceLike,
): OutlookThreadIdentity | null {
  if (!isCanonicalEmailSource(evidence.source)) return null;
  const platform = String(evidence.metadata.platform ?? '').trim();
  if (platform !== CANONICAL_EMAIL_PLATFORMS[evidence.source]) return null;

  const direction = String(evidence.metadata.direction ?? '').trim();
  if (direction !== 'received' && direction !== 'sent') return null;
  if (direction === 'received' && evidence.type !== 'email_read') return null;
  if (direction === 'sent' && evidence.type !== 'email_sent') return null;

  const ownerEmail = normalizeOutlookAddress(evidence.metadata.ownerEmail);
  const sender = normalizeOutlookAddress(evidence.metadata.sender);
  const conversationId = String(evidence.metadata.conversationId ?? '').trim();
  const timestamp = parseOutlookMessageTimestamp(evidence.metadata.messageTimestamp);
  if (!ownerEmail || !sender || !conversationId || conversationId.length > 2_048 || !timestamp) return null;

  const toRecipients = outlookAddresses(
    evidence.metadata.toRecipients ?? evidence.metadata.recipients,
  );
  const ccRecipients = outlookAddresses(evidence.metadata.ccRecipients);
  const directlyAddressedToOwner = evidence.metadata.directlyAddressedToOwner === true
    || evidence.metadata.directlyAddressedToOwner === 'true';

  return {
    source: evidence.source,
    ownerEmail,
    conversationId,
    messageTimestamp: timestamp.value,
    messageMillis: timestamp.millis,
    direction,
    sender,
    toRecipients,
    ccRecipients,
    directlyAddressedToOwner,
    ...(evidence.metadata.fromOwnAccount === true || evidence.metadata.fromOwnAccount === 'true' ? { fromOwnAccount: true } : {}),
  };
}

export function outlookThreadKey(identity: OutlookThreadIdentity): string {
  return `${identity.source}\0${identity.ownerEmail}\0${identity.conversationId}`;
}

export function sameOutlookThread(
  left: OutlookThreadIdentity | null,
  right: OutlookThreadIdentity | null,
): boolean {
  return Boolean(left && right
    && left.source === right.source
    && left.ownerEmail === right.ownerEmail
    && left.conversationId === right.conversationId);
}

/** Relational task authority is intentionally narrower than inbox retention:
 * one non-owner sender, with the owner as the sole To recipient and no Cc. */
export function isDirectIncomingOutlookEmail(identity: OutlookThreadIdentity): boolean {
  return identity.direction === 'received'
    && identity.sender !== identity.ownerEmail
    && !identity.fromOwnAccount
    && identity.directlyAddressedToOwner
    && identity.toRecipients.length === 1
    && identity.toRecipients[0] === identity.ownerEmail
    && identity.ccRecipients.length === 0;
}

export function isOwnerSentOutlookEmail(identity: OutlookThreadIdentity): boolean {
  return identity.direction === 'sent'
    && identity.sender === identity.ownerEmail
    && identity.toRecipients.length > 0;
}

/** Same exact conversation, strict chronology, and the original requester is
 * explicitly included in the owner's sent recipients. */
export function sentContinuesIncomingOutlookThread(
  request: OutlookThreadIdentity,
  acceptance: OutlookThreadIdentity,
): boolean {
  return isDirectIncomingOutlookEmail(request)
    && isOwnerSentOutlookEmail(acceptance)
    && sameOutlookThread(request, acceptance)
    && request.messageMillis < acceptance.messageMillis
    && [...acceptance.toRecipients, ...acceptance.ccRecipients].includes(request.sender);
}

/**
 * A raw message body without its quoted history, for reading a thread where
 * every earlier message is shown once anyway (Gmail chat tools). Unlike
 * `emailAuthoredBody`, greetings and sign-offs stay: this is for reading, not
 * for citations. A body that is all quote (a bare forward) is returned whole.
 */
export function withoutQuotedHistory(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    // A forwarded message is new to this thread, so nothing after it is history.
    if (FORWARDED_MESSAGE.test(trimmed)) return body.replace(/\r\n?/g, '\n').trim();
    if (QUOTED_REPLY_START.some((pattern) => pattern.test(trimmed))) break;
    if (isWrappedReplyAttribution(trimmed, lines[index + 1]?.trim() ?? '')) break;
    kept.push(lines[index]);
  }
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text || body.trim();
}

/**
 * The authored new part of a rendered email: synthetic leading headers,
 * optional untrusted-data sentinel, greeting/sign-off, and quoted history are
 * excluded. This is the only text eligible for relational email citations.
 */
export function emailAuthoredBody(content: string): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length && (HEADER_LINE.test(lines[index]) || lines[index].trim() === '')) index++;
  if (index < lines.length && DATA_SENTINEL.test(lines[index].trim())) index++;
  const body: string[] = [];
  for (; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (QUOTED_REPLY_START.some((pattern) => pattern.test(trimmed))) break;
    if (isWrappedReplyAttribution(trimmed, lines[index + 1]?.trim() ?? '')) break;
    body.push(line);
  }
  while (body.length && body[0].trim() === '') body.shift();
  if (body.length && GREETING.test(body[0].trim())) body.shift();
  const signOff = body.findIndex((line) => SIGN_OFF.test(line.trim()));
  const kept = signOff >= 0 ? body.slice(0, signOff) : body;
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
