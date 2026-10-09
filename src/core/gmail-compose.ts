/**
 * Gmail drafts and sending for the owner (GMAIL_CHAT_TOOLS_PLAN.md §2, §7).
 *
 * One service behind both the chat tools (gmail_draft / gmail_send) and the
 * chat draft card's owner buttons. Authority is checked by the callers (the
 * live owner turn for tools, the same-origin owner page for the card); this
 * module owns what must hold for every caller:
 *
 *   - Compose only: drafts.create/update/get/delete/send and messages.send.
 *     Nothing changes labels or read state.
 *   - BotBoy updates, sends, and discards only drafts it created. The draft
 *     ledger (settings `gmail_compose.v1`) records each one with its account,
 *     current message id, and outcome, so a card still shows "Sent" after a
 *     restart.
 *   - A card send or discard acts on the exact version the owner saw: the
 *     draft's current message id must equal the one shown (Gmail replaces the
 *     message inside a draft on every update).
 *   - Every send has an effect class. A rejected request (4xx) or a connection
 *     that never opened is `none`; a timeout, a dropped connection, or a 5xx
 *     is `unknown` and is never retried here: the caller checks Sent. Mail
 *     with attachments goes through Gmail's resumable upload, which asks
 *     Google after an interruption and so usually knows (gmail-api.ts).
 *   - Per owner request, the same message is sent once (duplicates return the
 *     first receipt) and at most MAX_SENDS_PER_REQUEST messages go out.
 *   - Attachments come only through gmail-attachments.ts (its refusals are
 *     `attachment_not_allowed`). A draft update without `attachments` attaches
 *     the draft's files again, and only if their bytes are unchanged.
 */

import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { getSetting, setSetting } from './storage.js';
import {
  GOOGLE_NEVER_CONNECTED,
  GoogleApiError,
  type GmailClient,
  type GmailDraft,
  type GmailMessage,
  type GmailRawMessage,
} from './gmail-api.js';
import { GmailAuthError, gmailAccountName, type GmailAccountConnection, type GmailConnection } from './gmail-connection.js';
import {
  GmailComposeInputError,
  MAX_BODY_CHARS,
  MAX_RECIPIENTS,
  MAX_SUBJECT_CHARS,
  buildRawMessage,
  formatAddress,
  messageIdsIn,
  normalizeBody,
  parseRecipients,
  replySubject,
  sameThreadSubject,
  toBase64Url,
  uniqueAddresses,
  type ComposeIssue,
  type MailAddress,
} from './gmail-mime.js';
import {
  attachmentReceipt,
  defaultAttachmentPolicy,
  reattachStored,
  resolveAttachments,
  storedAttachment,
  storedAttachmentsOf,
  type AttachmentPolicy,
  type AttachmentProblems,
  type AttachmentReceipt,
  type ResolvedAttachment,
  type StoredAttachment,
} from './gmail-attachments.js';
import { decodeMimeWords, messageAttachments, messageBody, messageHeaders, parseAddressList } from '../monitors/gmail-message.js';

export const GMAIL_COMPOSE_KEY = 'gmail_compose.v1';
export const MAX_SENDS_PER_REQUEST = 5;
const MAX_LEDGER_DRAFTS = 200;
const REQUEST_LEDGER_TTL_MS = 6 * 3600_000;
const MAX_TRACKED_REQUESTS = 200;
const CARD_BODY_CHARS = 4_000;
/** An unanswered draft send stays blocked this long before a still-present draft counts as unsent. */
const SEND_UNKNOWN_SETTLE_MS = 120_000;
/** Gmail draft and message ids are short url-safe tokens (`r-123…`, hex). */
const GMAIL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const REPLY_HEADERS = ['From', 'Reply-To', 'To', 'Cc', 'Subject', 'Message-ID', 'References'] as const;

export type GmailComposeErrorCode =
  | 'not_connected'
  | 'reconnect_required'
  | 'compose_not_granted'
  | 'invalid_arguments'
  | 'attachment_not_allowed'
  | 'not_found'
  | 'unknown_draft'
  | 'other_account'
  | 'draft_not_open'
  | 'draft_changed'
  | 'rate_limited'
  | 'google_error'
  | 'send_unknown_effect'
  | 'draft_unknown_effect'
  | 'send_in_progress'
  | 'send_cap_reached';

export type GmailEffect = 'none' | 'unknown';

const NEXT_ACTION: Record<GmailComposeErrorCode, string> = {
  not_connected: 'Tell the owner Gmail is not connected: Connections → Gmail → Connect Gmail.',
  reconnect_required: 'Tell the owner Google ended BotBoy’s access: Connections → Gmail → Reconnect.',
  compose_not_granted: 'Tell the owner BotBoy can read Gmail but may not draft or send yet: Connections → Gmail → Reconnect, and allow “Manage drafts and send emails”.',
  invalid_arguments: 'Fix every listed issue, then call once more.',
  attachment_not_allowed: 'Do not send or draft without these files on your own. Tell the owner which file BotBoy will not email and why; they can attach it themselves in Gmail (Open in Gmail on the draft card).',
  not_found: 'Gmail has no such message or draft. Find the right one with gmail_search before trying again.',
  unknown_draft: 'BotBoy changes or sends only drafts it created. Call gmail_draft without draftId to make a new draft.',
  other_account: 'This draft belongs to a Gmail account that is no longer connected. Make a new draft.',
  draft_not_open: 'This draft was already sent or discarded. Make a new draft if the owner wants another message.',
  draft_changed: 'The draft changed since it was shown. Show the owner the current version before sending.',
  rate_limited: 'Gmail is limiting requests for this account. Wait a minute, then try once more; tell the owner if it repeats.',
  google_error: 'Tell the owner what Gmail said. Do not repeat the same call unchanged.',
  send_unknown_effect: 'Do NOT send again. Check with gmail_search (in:sent plus the subject), then tell the owner whether it went out.',
  draft_unknown_effect: 'Do not save it again. Check with gmail_search (in:drafts plus the subject), then tell the owner.',
  send_in_progress: 'This exact message is already being sent. Wait for that result; do not send it again.',
  send_cap_reached: `BotBoy sends at most ${MAX_SENDS_PER_REQUEST} messages per owner message. Tell the owner which messages went out and ask them to confirm the rest in a new message.`,
};

export class GmailComposeError extends Error {
  readonly nextAction: string;
  constructor(
    readonly code: GmailComposeErrorCode,
    message: string,
    readonly effect: GmailEffect = 'none',
    readonly issues: ComposeIssue[] = [],
    nextAction?: string,
    /** Extra owner-safe facts (for example the fresh view after draft_changed). */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'GmailComposeError';
    this.nextAction = nextAction ?? NEXT_ACTION[code];
  }
}

export type DraftState = 'draft' | 'sent' | 'discarded' | 'send_unknown';

interface DraftEntry {
  draftId: string;
  account: string;
  messageId: string;
  threadId: string;
  subject: string;
  state: DraftState;
  /** Kept so an update stays in the same thread without repeating it. */
  replyToMessageId?: string;
  /** The send-as address the draft was written From (an alias or the named primary). */
  fromAddress?: string;
  createdAt: string;
  updatedAt: string;
  sentMessageId?: string;
  sentThreadId?: string;
  sentAt?: string;
  via?: 'chat' | 'card';
  /** Where each attached file came from and its SHA-256, so an update attaches the same bytes again. */
  attachments?: StoredAttachment[];
  /** The files Gmail held when the draft was sent (the owner may have changed them in Gmail). */
  sentAttachments?: AttachmentView[];
}

export interface ComposeArgs {
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: unknown;
  body?: unknown;
  /** Files (gmail-attachments.ts). On a draft update, omitted keeps the draft's files and [] removes them. */
  attachments?: unknown;
  replyToMessageId?: unknown;
  replyAll?: unknown;
  draftId?: unknown;
  /** The account to write from (address or label); required when several are connected. */
  from?: unknown;
}

/** One attached file as the card shows it. */
export interface AttachmentView {
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface DraftReceipt {
  status: 'drafted';
  updated: boolean;
  draftId: string;
  messageId: string;
  threadId: string;
  account: string;
  /** The From line it went out with, when one was chosen (a send-as alias). */
  from?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyChars: number;
  attachments: AttachmentReceipt[];
  reply: boolean;
  card: string;
  gmailUrl: string;
}

export interface SendReceipt {
  status: 'sent';
  messageId: string;
  threadId: string;
  account: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  attachments: AttachmentReceipt[];
  labelIds: string[];
  /** A follow-up read found the message with the SENT label. */
  verified: boolean;
  sentAt: string;
  via: 'chat' | 'card';
  fromDraftId?: string;
  /** This exact message was already sent earlier in the same owner request (or from its card): no second send happened. */
  alreadySent?: boolean;
  gmailUrl: string;
}

export interface DraftView {
  state: DraftState | 'missing' | 'unknown' | 'other_account' | 'not_connected';
  /** The owner's label for the sending account, when it has one. */
  accountLabel?: string;
  /** The From line Gmail holds for the draft (a send-as alias or the account). */
  from?: string;
  draftId: string;
  account: string | null;
  messageId: string | null;
  threadId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  bodyTruncated: boolean;
  attachments: AttachmentView[];
  updatedAt: string | null;
  sentMessageId?: string;
  sentAt?: string;
  gmailUrl: string | null;
}

export interface GmailCompose {
  saveDraft(args: ComposeArgs): Promise<DraftReceipt>;
  send(args: ComposeArgs, request: { ownerRequestId: string }): Promise<SendReceipt>;
  viewDraft(draftId: string): Promise<DraftView>;
  sendDraftFromCard(draftId: string, expectedMessageId: string): Promise<SendReceipt>;
  discardDraft(draftId: string, expectedMessageId: string): Promise<DraftView>;
}

// ── Helpers ──────────────────────────────────────────────────────────────

export function gmailDraftMarker(draftId: string): string {
  return `[[gmail-draft:${draftId}]]`;
}

/** Gmail web for this account; `/u/<address>/` picks the right signed-in account. */
export function gmailWebUrl(account: string | null, fragment: string): string {
  const user = account && /^[a-z0-9._%+-]+@[a-z0-9.-]+$/i.test(account) ? account : '0';
  return `https://mail.google.com/mail/u/${user}/#${fragment}`;
}

function isGmailId(value: unknown): value is string {
  return typeof value === 'string' && GMAIL_ID_PATTERN.test(value);
}

/** Write effects: only a request Google provably never processed is `none`. */
export function writeEffectOf(error: unknown): GmailEffect {
  if (error instanceof GmailAuthError) return 'none';
  if (error instanceof GmailComposeError) return error.effect;
  if (error instanceof GoogleApiError) {
    // A resumable upload asked Google and knows.
    if (error.effect) return error.effect;
    if (error.code === 'network') return error.transportCode && GOOGLE_NEVER_CONNECTED.has(error.transportCode) ? 'none' : 'unknown';
    if (error.code === 'timeout') return 'unknown';
    if (error.status >= 400 && error.status < 500 && error.status !== 408) return 'none';
  }
  return 'unknown';
}

/** Any failure as a structured compose error with the effect the caller determined. */
export function composeFailure(error: unknown, effect: GmailEffect, what: string): GmailComposeError {
  if (error instanceof GmailComposeError) return error;
  if (error instanceof GmailComposeInputError) return new GmailComposeError('invalid_arguments', error.message, 'none', error.issues);
  if (error instanceof GmailAuthError) {
    return new GmailComposeError(error.code === 'reconnect_required' ? 'reconnect_required' : 'not_connected', error.message, 'none');
  }
  if (effect === 'unknown') {
    const message = error instanceof GoogleApiError ? error.message : `${what} ended without an answer from Gmail`;
    return new GmailComposeError('send_unknown_effect', `${message}. Gmail may or may not have done it.`, 'unknown');
  }
  if (error instanceof GoogleApiError) {
    if (error.status === 403 && /insufficient|scope/i.test(`${error.code} ${error.message}`)) {
      return new GmailComposeError('compose_not_granted', 'Gmail refused: this connection has no permission to draft or send.', 'none');
    }
    if (error.status === 429 || /rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/i.test(error.code)) {
      return new GmailComposeError('rate_limited', error.message, 'none');
    }
    if (error.status === 404) return new GmailComposeError('not_found', error.message, 'none');
    return new GmailComposeError('google_error', error.message, 'none');
  }
  return new GmailComposeError('google_error', `${what} failed unexpectedly`, 'none');
}

function addressStrings(list: readonly MailAddress[]): string[] {
  return list.map(formatAddress);
}

function headerAddresses(value: string | undefined): MailAddress[] {
  return parseAddressList(value).filter(entry => entry.address).map(entry => ({ name: entry.name, address: entry.address }));
}

interface ReplyContext {
  replyToMessageId: string;
  threadId: string;
  inReplyTo?: string;
  references: string[];
  subject: string;
  defaultTo: MailAddress[];
  others: MailAddress[];
}

interface Prepared {
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  body: string;
  attachments: ResolvedAttachment[];
  threadId?: string;
  reply?: ReplyContext;
  /** The From identity written into the message, when one was chosen. */
  from?: MailAddress;
  /** JSON `raw` for text-only mail; the bytes for a resumable upload with attachments. */
  message: GmailRawMessage;
}

function attachmentViews(list: readonly { name: string; mimeType: string; sizeBytes: number }[]): AttachmentView[] {
  return list.map(entry => ({ name: entry.name, mimeType: entry.mimeType, sizeBytes: entry.sizeBytes }));
}

/** A ledger entry's files: as sent when it went out, else as BotBoy attached them. Malformed rows are dropped. */
function entryAttachments(entry: DraftEntry): AttachmentView[] {
  if (entry.state === 'sent' && Array.isArray(entry.sentAttachments)) {
    return attachmentViews(entry.sentAttachments.filter(item => typeof item?.name === 'string'
      && typeof item?.mimeType === 'string' && Number.isInteger(item?.sizeBytes)));
  }
  return attachmentViews(storedAttachmentsOf(entry.attachments));
}

// ── Service ──────────────────────────────────────────────────────────────

export function createGmailCompose(deps: {
  db: Database.Database;
  connection: GmailConnection;
  now?: () => number;
  /** Where attachments may come from (default: the owner's home, BotBoy's files workspace, no chat images). */
  attachments?: AttachmentPolicy;
  /** An account's stored send-as identities (custom-domain aliases), so `from` can name one. */
  sendAsFor?: (accountId: string) => ReadonlyArray<{ email: string }>;
}): GmailCompose {
  const { db, connection } = deps;
  const now = deps.now ?? Date.now;
  const attachmentPolicy = deps.attachments ?? defaultAttachmentPolicy();
  const requests = new Map<string, { attempts: Map<string, { state: 'in_flight' | 'sent' | 'unknown'; receipt?: SendReceipt }>; started: number; touchedAt: number }>();
  const draftLocks = new Set<string>();

  // ── Draft ledger ──
  function ledger(): DraftEntry[] {
    const value = getSetting<{ drafts?: unknown }>(db, GMAIL_COMPOSE_KEY);
    const list = Array.isArray(value?.drafts) ? value!.drafts as any[] : [];
    return list.filter(entry => isGmailId(entry?.draftId) && typeof entry?.account === 'string'
      && ['draft', 'sent', 'discarded', 'send_unknown'].includes(entry?.state)) as DraftEntry[];
  }
  function entryFor(draftId: string): DraftEntry | undefined {
    return ledger().find(entry => entry.draftId === draftId);
  }
  function saveEntry(entry: DraftEntry): void {
    const list = ledger().filter(existing => existing.draftId !== entry.draftId);
    list.push(entry);
    setSetting(db, GMAIL_COMPOSE_KEY, { drafts: list.slice(-MAX_LEDGER_DRAFTS) });
  }

  /** "Work (a@x.com), Personal (b@y.com)" for issues and next actions. */
  function accountChoices(): string {
    return connection.accounts().map(account => gmailAccountName(account)).join(', ');
  }

  /**
   * The account a write uses (GMAIL_API_INTEGRATION_PLAN.md §13): a saved
   * draft's own account; else `from` (address or label); else the only
   * connected account. With several accounts and no `from`, the call is
   * refused with the choices, so the sender is always an explicit decision.
   */
  function requireCompose(selector: { from?: unknown; draftId?: unknown } = {}): { account: string; client: GmailClient; fromAddress?: string } {
    const accounts = connection.accounts();
    if (!accounts.length) throw new GmailComposeError('not_connected', 'Gmail is not connected.');
    const from = typeof selector.from === 'string' ? selector.from.trim() : '';
    if (selector.from !== undefined && selector.from !== null && selector.from !== '' && !from) {
      throw composeFailure(new GmailComposeInputError([{ path: 'from', message: `must be one of: ${accountChoices()}` }]), 'none', 'Choosing the account');
    }
    let view: GmailAccountConnection | null = null;
    let fromAddress: string | undefined;
    const entry = isGmailId(selector.draftId) ? entryFor(selector.draftId) : undefined;
    if (entry) {
      view = connection.account(entry.account);
      if (!view) throw new GmailComposeError('other_account', `Draft ${entry.draftId} belongs to a Gmail account that is not connected (${entry.account}).`);
      fromAddress = entry.fromAddress;
      const aliasOwner = from && from.includes('@') ? connection.accounts().find(account => (deps.sendAsFor?.(account.id) ?? []).some(identity => identity.email === from.toLowerCase())) : undefined;
      if (aliasOwner && aliasOwner.id === view.id) fromAddress = from.toLowerCase();
      else if (from && connection.account(from)?.id !== view.id) {
        throw composeFailure(new GmailComposeInputError([{ path: 'from', message: `this draft belongs to ${entry.account}; a draft cannot move to another account (make a new draft instead)` }]), 'none', 'Choosing the account');
      }
    } else if (from) {
      view = connection.account(from);
      // A send-as alias (custom domain) picks the account that owns it.
      const alias = from.toLowerCase();
      if (!view && alias.includes('@')) {
        const owner = accounts.find(account => (deps.sendAsFor?.(account.id) ?? []).some(identity => identity.email === alias));
        if (owner) { view = connection.account(owner.id); fromAddress = alias; }
      } else if (view && alias.includes('@')) {
        // The primary address named explicitly: write it into From too.
        fromAddress = alias;
      }
      if (!view) throw composeFailure(new GmailComposeInputError([{ path: 'from', message: `"${from.slice(0, 80)}" is not a connected account or one of its send-as addresses; use one of: ${accountChoices()}` }]), 'none', 'Choosing the account');
    } else if (accounts.length === 1) {
      view = connection.account(accounts[0].id);
    } else {
      throw composeFailure(new GmailComposeInputError([{
        path: 'from',
        message: `required with several Gmail accounts: one of ${accountChoices()}. Use the account the thread belongs to, the work account for work mail; ask the owner when it is not clear`,
      }]), 'none', 'Choosing the account');
    }
    const account = view?.accountEmail();
    if (!view || !account) throw new GmailComposeError('not_connected', 'Gmail is not connected.');
    if (view.status().needsReconnect) {
      throw new GmailComposeError('reconnect_required', `Google ended BotBoy’s access to ${account}.`);
    }
    if (!view.canCompose()) {
      throw new GmailComposeError('compose_not_granted', `The connection to ${account} allows reading only, not drafting or sending.`);
    }
    return { account, client: view.client(), ...(fromAddress ? { fromAddress } : {}) };
  }

  /**
   * The From identity, checked live against Gmail's verified send-as list
   * (the stored list can be stale). Gmail rejects an unverified From anyway;
   * checking first keeps the failure a fixable `from` issue with effect none.
   */
  async function senderIdentity(client: GmailClient, account: string, fromAddress: string | undefined): Promise<MailAddress | undefined> {
    if (!fromAddress) return undefined;
    let identities: Array<{ email: string; displayName: string }> = [];
    try {
      identities = await client.listSendAs();
    } catch (error) {
      if (fromAddress === account) return { name: '', address: account };
      throw composeFailure(error, 'none', 'Checking the send-as address');
    }
    const found = identities.find(identity => identity.email === fromAddress);
    if (!found) {
      if (fromAddress === account) return { name: '', address: account };
      throw composeFailure(new GmailComposeInputError([{
        path: 'from',
        message: `${fromAddress} is not a verified "Send mail as" address of ${account} (Gmail settings → Accounts); use one of: ${[account, ...identities.map(identity => identity.email).filter(email => email !== account)].join(', ')}`,
      }]), 'none', 'Choosing the sender');
    }
    return { name: found.displayName, address: found.email };
  }

  async function ownerAddresses(client: GmailClient, account: string): Promise<Set<string>> {
    const addresses = new Set([account]);
    try {
      for (const address of await client.listSendAsAddresses()) addresses.add(address);
    } catch {
      // The primary address alone still keeps the owner out of reply-all.
    }
    return addresses;
  }

  async function replyContext(client: GmailClient, messageId: string, owner: Set<string>): Promise<ReplyContext> {
    let original: GmailMessage;
    try {
      original = await client.getMessage(messageId, { format: 'metadata', metadataHeaders: REPLY_HEADERS });
    } catch (error) {
      const failure = composeFailure(error, 'none', 'Reading the original message');
      if (failure.code === 'not_found') {
        throw new GmailComposeError('not_found', `Gmail has no message ${messageId} to reply to.`, 'none', [{ path: 'replyToMessageId', message: 'no such message in this mailbox' }]);
      }
      throw failure;
    }
    if ((original.labelIds ?? []).includes('DRAFT')) {
      throw new GmailComposeInputError([{ path: 'replyToMessageId', message: 'names a draft, not a received or sent message' }]);
    }
    const headers = messageHeaders(original);
    const ownId = (headers.get('message-id') ?? '').match(/<[^<>\s]+@[^<>\s]+>/)?.[0];
    const references = [...new Set([...messageIdsIn(headers.get('references')), ...(ownId ? [ownId] : [])])];
    const from = headerAddresses(headers.get('from'));
    const replyTo = headerAddresses(headers.get('reply-to'));
    const to = headerAddresses(headers.get('to'));
    const cc = headerAddresses(headers.get('cc'));
    const fromOwner = from.some(entry => owner.has(entry.address));
    return {
      replyToMessageId: messageId,
      threadId: original.threadId,
      ...(ownId ? { inReplyTo: ownId } : {}),
      references,
      subject: decodeMimeWords(headers.get('subject') ?? '').trim(),
      // The owner's own message: a follow-up goes to its recipients.
      defaultTo: fromOwner ? to : (replyTo.length ? replyTo : from),
      others: [...to, ...cc],
    };
  }

  /** `existing` is the draft being updated: its thread and files carry over unless the call replaces them. */
  async function prepare(args: ComposeArgs, client: GmailClient, account: string, existing?: DraftEntry, fromAddress?: string): Promise<Prepared> {
    const keptReplyTo = existing?.replyToMessageId;
    const issues: ComposeIssue[] = [];
    const explicitTo = parseRecipients(args.to, 'to', issues);
    const explicitCc = parseRecipients(args.cc, 'cc', issues);
    const bcc = parseRecipients(args.bcc, 'bcc', issues);
    const subjectArg = args.subject === undefined || args.subject === null ? '' : args.subject;
    if (typeof subjectArg !== 'string') issues.push({ path: 'subject', message: 'must be a string' });
    const body = typeof args.body === 'string' ? normalizeBody(args.body) : '';
    if (typeof args.body !== 'string' || !body.trim()) issues.push({ path: 'body', message: 'the message text is required' });
    if (body.length > MAX_BODY_CHARS) issues.push({ path: 'body', message: `at most ${MAX_BODY_CHARS} characters (got ${body.length})` });
    if (args.replyAll !== undefined && typeof args.replyAll !== 'boolean') issues.push({ path: 'replyAll', message: 'must be true or false' });
    const replyToArg = args.replyToMessageId === undefined || args.replyToMessageId === null || args.replyToMessageId === ''
      ? keptReplyTo
      : args.replyToMessageId;
    if (replyToArg !== undefined && !isGmailId(replyToArg)) {
      issues.push({ path: 'replyToMessageId', message: 'must be a Gmail message id from gmail_search or gmail_read' });
    }
    if (args.replyAll === true && replyToArg === undefined) issues.push({ path: 'replyAll', message: 'needs replyToMessageId' });
    let subject = typeof subjectArg === 'string' ? subjectArg.trim() : '';
    if (replyToArg === undefined) {
      // A new message is fully checkable now, so its problems come in this one wave.
      const recipientIssue = issues.some(issue => /^(to|cc|bcc)\b/.test(issue.path));
      if (!explicitTo.length && !explicitCc.length && !bcc.length && !recipientIssue) {
        issues.push({ path: 'to', message: 'at least one recipient is required' });
      }
      if (!subject && typeof subjectArg === 'string') issues.push({ path: 'subject', message: 'a new message needs a subject' });
      if (subject.length > MAX_SUBJECT_CHARS) issues.push({ path: 'subject', message: `at most ${MAX_SUBJECT_CHARS} characters` });
      const total = explicitTo.length + explicitCc.length + bcc.length;
      if (total > MAX_RECIPIENTS) issues.push({ path: 'to', message: `at most ${MAX_RECIPIENTS} recipients in total (got ${total})` });
    }
    // Files are local, so their problems join this first wave too.
    const problems: AttachmentProblems = { issues, refusals: [] };
    const attachments = args.attachments === undefined || args.attachments === null
      ? reattachStored(existing?.attachments, attachmentPolicy, problems)
      : resolveAttachments(args.attachments, attachmentPolicy, problems);
    if (problems.refusals.length) {
      const count = problems.refusals.length;
      throw new GmailComposeError('attachment_not_allowed', `BotBoy will not email ${count === 1 ? 'this file' : `these ${count} files`}.`, 'none', [...problems.refusals, ...issues]);
    }
    if (issues.length) throw new GmailComposeInputError(issues);

    let to = explicitTo;
    let cc = explicitCc;
    let reply: ReplyContext | undefined;
    if (replyToArg !== undefined) {
      const owner = await ownerAddresses(client, account);
      reply = await replyContext(client, replyToArg as string, owner);
      if (subject && !sameThreadSubject(subject, reply.subject)) {
        issues.push({ path: 'subject', message: `a reply keeps the original subject ("${reply.subject.slice(0, 80)}") so Gmail threads it; omit subject, or send a new message instead` });
      }
      subject = replySubject(reply.subject || subject);
      if (!to.length) to = reply.defaultTo;
      if (!explicitCc.length && args.replyAll === true) {
        const exclude = new Set([...owner, ...to.map(entry => entry.address)]);
        cc = uniqueAddresses(reply.others, exclude);
      }
      if (!to.length) issues.push({ path: 'to', message: 'the original has no usable sender to reply to; give the recipients' });
    }
    to = uniqueAddresses(to);
    cc = uniqueAddresses(cc, new Set(to.map(entry => entry.address)));
    const total = to.length + cc.length + bcc.length;
    if (total > MAX_RECIPIENTS) issues.push({ path: 'to', message: `at most ${MAX_RECIPIENTS} recipients in total (got ${total})` });
    if (subject.length > MAX_SUBJECT_CHARS) issues.push({ path: 'subject', message: `at most ${MAX_SUBJECT_CHARS} characters` });
    if (issues.length) throw new GmailComposeInputError(issues);
    const from = await senderIdentity(client, account, fromAddress);
    const text = buildRawMessage({
      to, cc, bcc, subject, body, attachments,
      ...(from ? { from } : {}),
      ...(reply?.inReplyTo ? { inReplyTo: reply.inReplyTo } : {}),
      ...(reply?.references.length ? { references: reply.references } : {}),
    });
    const thread = reply ? { threadId: reply.threadId } : {};
    const message: GmailRawMessage = attachments.length
      ? { rfc822: Buffer.from(text, 'utf8'), ...thread }
      : { raw: toBase64Url(text), ...thread };
    return { to, cc, bcc, subject, body, attachments, ...(from ? { from } : {}), ...(reply ? { threadId: reply.threadId, reply } : {}), message };
  }

  function fingerprint(account: string, prepared: Prepared): string {
    const sorted = (list: MailAddress[]) => list.map(entry => entry.address).sort();
    return createHash('sha256').update(JSON.stringify({
      account,
      from: prepared.from?.address ?? null,
      to: sorted(prepared.to),
      cc: sorted(prepared.cc),
      bcc: sorted(prepared.bcc),
      subject: prepared.subject,
      body: prepared.body.trim(),
      threadId: prepared.threadId ?? null,
      // The same text with other files is another message.
      attachments: prepared.attachments.map(attachment => [attachment.name, attachment.sha256]),
    })).digest('hex');
  }

  function requestLedger(ownerRequestId: string) {
    const cutoff = now() - REQUEST_LEDGER_TTL_MS;
    for (const [id, entry] of requests) if (entry.touchedAt < cutoff) requests.delete(id);
    while (requests.size >= MAX_TRACKED_REQUESTS && !requests.has(ownerRequestId)) {
      const oldest = requests.keys().next().value;
      if (oldest === undefined) break;
      requests.delete(oldest);
    }
    let entry = requests.get(ownerRequestId);
    if (!entry) {
      entry = { attempts: new Map(), started: 0, touchedAt: now() };
      requests.set(ownerRequestId, entry);
    }
    entry.touchedAt = now();
    return entry;
  }

  async function verifySent(client: GmailClient, message: GmailMessage): Promise<{ verified: boolean; labelIds: string[] }> {
    try {
      const check = await client.getMessage(message.id, { format: 'metadata', metadataHeaders: ['Subject'] });
      const labelIds = check.labelIds ?? [];
      return { verified: labelIds.includes('SENT'), labelIds };
    } catch {
      return { verified: false, labelIds: message.labelIds ?? [] };
    }
  }

  function draftView(draft: GmailDraft, entry: DraftEntry, state: DraftState): DraftView {
    const headers = messageHeaders(draft.message);
    const list = (name: string) => headerAddresses(headers.get(name)).map(formatAddress);
    const text = messageBody(draft.message).text;
    return {
      state,
      draftId: entry.draftId,
      account: entry.account,
      messageId: draft.message.id,
      threadId: draft.message.threadId,
      ...(list('from')[0] ? { from: list('from')[0] } : {}),
      to: list('to'),
      cc: list('cc'),
      bcc: list('bcc'),
      subject: decodeMimeWords(headers.get('subject') ?? ''),
      body: text.slice(0, CARD_BODY_CHARS),
      bodyTruncated: text.length > CARD_BODY_CHARS,
      // What Gmail holds, including files the owner added or removed in Gmail.
      attachments: messageAttachments(draft.message).map(entry => ({ name: entry.filename, mimeType: entry.mimeType, sizeBytes: entry.sizeBytes })),
      updatedAt: entry.updatedAt,
      gmailUrl: gmailWebUrl(entry.account, state === 'draft' ? 'drafts' : 'sent'),
    };
  }

  function ledgerView(entry: DraftEntry, state: DraftView['state']): DraftView {
    return {
      state,
      draftId: entry.draftId,
      account: entry.account,
      messageId: entry.messageId,
      threadId: entry.sentThreadId ?? entry.threadId,
      to: [],
      cc: [],
      bcc: [],
      subject: entry.subject,
      body: '',
      bodyTruncated: false,
      attachments: entryAttachments(entry),
      updatedAt: entry.updatedAt,
      ...(entry.sentMessageId ? { sentMessageId: entry.sentMessageId } : {}),
      ...(entry.sentAt ? { sentAt: entry.sentAt } : {}),
      gmailUrl: state === 'sent'
        ? gmailWebUrl(entry.account, `all/${entry.sentThreadId ?? entry.threadId}`)
        : gmailWebUrl(entry.account, state === 'draft' ? 'drafts' : 'sent'),
    };
  }

  /** The ledger entry a write may act on, or the exact reason it may not. */
  function openEntry(draftId: unknown, account: string): DraftEntry {
    if (!isGmailId(draftId)) {
      throw composeFailure(new GmailComposeInputError([{ path: 'draftId', message: 'must be the draftId gmail_draft returned' }]), 'none', 'Draft');
    }
    const entry = entryFor(draftId);
    if (!entry) throw new GmailComposeError('unknown_draft', `Draft ${draftId} was not created by BotBoy.`);
    if (entry.account !== account) throw new GmailComposeError('other_account', `Draft ${draftId} belongs to another Gmail account.`);
    if (entry.state === 'send_unknown') {
      throw new GmailComposeError('send_unknown_effect', `An earlier send of draft ${draftId} got no answer from Gmail; it may have gone out.`, 'unknown');
    }
    if (entry.state !== 'draft') throw new GmailComposeError('draft_not_open', `Draft ${draftId} was already ${entry.state}.`);
    return entry;
  }

  function sentReceipt(input: {
    account: string; message: GmailMessage; verified: boolean; labelIds: string[]; via: 'chat' | 'card';
    to: string[]; cc: string[]; bcc: string[]; subject: string; attachments: AttachmentReceipt[]; fromDraftId?: string; from?: string;
  }): SendReceipt {
    return {
      status: 'sent',
      messageId: input.message.id,
      threadId: input.message.threadId,
      account: input.account,
      ...(input.from ? { from: input.from } : {}),
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      attachments: input.attachments,
      labelIds: input.labelIds,
      verified: input.verified,
      sentAt: new Date(now()).toISOString(),
      via: input.via,
      ...(input.fromDraftId ? { fromDraftId: input.fromDraftId } : {}),
      gmailUrl: gmailWebUrl(input.account, `all/${input.message.threadId}`),
    };
  }

  /** Sends one existing ledger draft; the caller holds the draft lock. */
  async function sendLedgerDraft(client: GmailClient, account: string, entry: DraftEntry, via: 'chat' | 'card', view: DraftView): Promise<SendReceipt> {
    let message: GmailMessage;
    try {
      message = await client.sendDraft(entry.draftId);
    } catch (error) {
      const effect = writeEffectOf(error);
      if (effect === 'unknown') {
        saveEntry({ ...entry, state: 'send_unknown', updatedAt: new Date(now()).toISOString() });
        console.warn(`[Gmail] Draft ${entry.draftId} send got no answer from Gmail (${via}); it may have gone out, so it is blocked from resending`);
      }
      throw composeFailure(error, effect, 'Sending the draft');
    }
    const check = await verifySent(client, message);
    console.log(`[Gmail] Sent draft ${entry.draftId} from ${via === 'card' ? 'its chat card' : 'chat'}: message ${message.id}${check.verified ? '' : ' (not yet listed in Sent)'}`);
    const receipt = sentReceipt({
      account, message, ...check, via, ...(view.from ? { from: view.from } : {}), to: view.to, cc: view.cc, bcc: view.bcc, subject: view.subject,
      attachments: view.attachments, fromDraftId: entry.draftId,
    });
    saveEntry({
      ...entry,
      state: 'sent',
      sentMessageId: message.id,
      sentThreadId: message.threadId,
      sentAt: receipt.sentAt,
      sentAttachments: view.attachments,
      via,
      updatedAt: receipt.sentAt,
    });
    return receipt;
  }

  async function currentDraft(client: GmailClient, entry: DraftEntry): Promise<GmailDraft | null> {
    try {
      return await client.getDraft(entry.draftId);
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) return null;
      throw composeFailure(error, 'none', 'Reading the draft');
    }
  }

  return {
    async saveDraft(args) {
      const { account, client, fromAddress } = requireCompose({ from: args.from, draftId: args.draftId });
      const existing = args.draftId === undefined || args.draftId === null || args.draftId === ''
        ? undefined
        : openEntry(args.draftId, account);
      if (existing && draftLocks.has(existing.draftId)) {
        throw new GmailComposeError('send_in_progress', `Draft ${existing.draftId} is being sent right now.`);
      }
      let prepared: Prepared;
      try {
        prepared = await prepare(args, client, account, existing, fromAddress);
      } catch (error) {
        throw composeFailure(error, 'none', 'Preparing the draft');
      }
      let draft: GmailDraft;
      try {
        draft = existing
          ? await client.updateDraft(existing.draftId, prepared.message)
          : await client.createDraft(prepared.message);
      } catch (error) {
        const effect = writeEffectOf(error);
        if (existing && error instanceof GoogleApiError && error.status === 404) {
          throw new GmailComposeError('not_found', `Draft ${existing.draftId} is no longer in Gmail (sent or deleted there).`, 'none', [], 'Make a new draft with gmail_draft without draftId.');
        }
        if (effect === 'unknown') {
          const said = error instanceof GoogleApiError ? `${error.message}. ` : '';
          throw new GmailComposeError('draft_unknown_effect', `${said}Gmail did not confirm the draft, so it may or may not have been saved.`, 'unknown');
        }
        throw composeFailure(error, effect, existing ? 'Updating the draft' : 'Creating the draft');
      }
      const at = new Date(now()).toISOString();
      saveEntry({
        draftId: draft.id,
        account,
        messageId: draft.message.id,
        threadId: draft.message.threadId,
        subject: prepared.subject,
        state: 'draft',
        ...(prepared.reply ? { replyToMessageId: prepared.reply.replyToMessageId } : {}),
        ...(prepared.from ? { fromAddress: prepared.from.address } : {}),
        ...(prepared.attachments.length ? { attachments: prepared.attachments.map(storedAttachment) } : {}),
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      });
      return {
        status: 'drafted',
        updated: Boolean(existing),
        draftId: draft.id,
        messageId: draft.message.id,
        threadId: draft.message.threadId,
        account,
        to: addressStrings(prepared.to),
        cc: addressStrings(prepared.cc),
        bcc: addressStrings(prepared.bcc),
        subject: prepared.subject,
        bodyChars: prepared.body.length,
        attachments: prepared.attachments.map(attachmentReceipt),
        reply: Boolean(prepared.reply),
        card: gmailDraftMarker(draft.id),
        gmailUrl: gmailWebUrl(account, 'drafts'),
      };
    },

    async send(args, request) {
      const ownerRequestId = String(request.ownerRequestId ?? '').trim();
      if (!ownerRequestId) throw new GmailComposeError('invalid_arguments', 'A send needs the owner request id.', 'none', [], 'Send only from the owner’s live chat turn.');
      const { account, client, fromAddress } = requireCompose({ from: args.from, draftId: args.draftId });
      const fromDraft = !(args.draftId === undefined || args.draftId === null || args.draftId === '');
      const tracked = requestLedger(ownerRequestId);

      if (fromDraft) {
        const known = isGmailId(args.draftId) ? entryFor(args.draftId) : undefined;
        if (known && known.account === account && known.state === 'sent' && known.sentMessageId) {
          // Sent already (its card, or earlier in chat): report it, never resend.
          return {
            status: 'sent',
            messageId: known.sentMessageId,
            threadId: known.sentThreadId ?? known.threadId,
            account,
            to: [], cc: [], bcc: [],
            subject: known.subject,
            attachments: entryAttachments(known),
            labelIds: ['SENT'],
            verified: true,
            sentAt: known.sentAt ?? known.updatedAt,
            via: known.via ?? 'card',
            fromDraftId: known.draftId,
            alreadySent: true,
            gmailUrl: gmailWebUrl(account, `all/${known.sentThreadId ?? known.threadId}`),
          };
        }
        const entry = openEntry(args.draftId, account);
        const extra = ['to', 'cc', 'bcc', 'subject', 'body', 'attachments', 'replyToMessageId', 'replyAll']
          .filter(key => (args as Record<string, unknown>)[key] !== undefined && (args as Record<string, unknown>)[key] !== null && (args as Record<string, unknown>)[key] !== '');
        if (extra.length) {
          throw composeFailure(new GmailComposeInputError(extra.map(key => ({ path: key, message: 'send a draft by draftId alone; to change it, call gmail_draft with the draftId first' }))), 'none', 'Send');
        }
        if (draftLocks.has(entry.draftId)) throw new GmailComposeError('send_in_progress', `Draft ${entry.draftId} is being sent right now.`);
        if (tracked.started >= MAX_SENDS_PER_REQUEST) throw new GmailComposeError('send_cap_reached', `${tracked.started} messages were already sent for this owner message.`);
        draftLocks.add(entry.draftId);
        tracked.started++;
        try {
          const draft = await currentDraft(client, entry);
          if (!draft) {
            throw new GmailComposeError('not_found', `Draft ${entry.draftId} is no longer in Gmail (sent or deleted there).`, 'none', [], 'Check with gmail_search (in:sent plus the subject) and tell the owner.');
          }
          const view = draftView(draft, entry, 'draft');
          return await sendLedgerDraft(client, account, { ...entry, messageId: draft.message.id }, 'chat', view);
        } catch (error) {
          const failure = composeFailure(error, writeEffectOf(error), 'Sending the draft');
          if (failure.effect === 'none') tracked.started--;
          throw failure;
        } finally {
          draftLocks.delete(entry.draftId);
        }
      }

      let prepared: Prepared;
      try {
        prepared = await prepare(args, client, account, undefined, fromAddress);
      } catch (error) {
        throw composeFailure(error, 'none', 'Preparing the message');
      }
      const key = fingerprint(account, prepared);
      const previous = tracked.attempts.get(key);
      if (previous?.state === 'sent' && previous.receipt) return { ...previous.receipt, alreadySent: true };
      if (previous?.state === 'in_flight') throw new GmailComposeError('send_in_progress', 'This exact message is already being sent.');
      if (previous?.state === 'unknown') {
        throw new GmailComposeError('send_unknown_effect', 'An earlier send of this exact message got no answer from Gmail; it may have gone out.', 'unknown');
      }
      if (tracked.started >= MAX_SENDS_PER_REQUEST) throw new GmailComposeError('send_cap_reached', `${tracked.started} messages were already sent for this owner message.`);
      tracked.attempts.set(key, { state: 'in_flight' });
      tracked.started++;
      let message: GmailMessage;
      try {
        message = await client.sendMessage(prepared.message);
      } catch (error) {
        const effect = writeEffectOf(error);
        if (effect === 'unknown') {
          tracked.attempts.set(key, { state: 'unknown' });
          console.warn('[Gmail] A send from chat got no answer from Gmail; it may have gone out, so this request will not resend it');
        } else {
          tracked.attempts.delete(key);
          tracked.started--;
        }
        throw composeFailure(error, effect, 'Sending the message');
      }
      const check = await verifySent(client, message);
      console.log(`[Gmail] Sent from chat: message ${message.id}${check.verified ? '' : ' (not yet listed in Sent)'}`);
      const receipt = sentReceipt({
        account, message, ...check, via: 'chat',
        ...(prepared.from ? { from: formatAddress(prepared.from) } : {}),
        to: addressStrings(prepared.to), cc: addressStrings(prepared.cc), bcc: addressStrings(prepared.bcc), subject: prepared.subject,
        attachments: prepared.attachments.map(attachmentReceipt),
      });
      tracked.attempts.set(key, { state: 'sent', receipt });
      return receipt;
    },

    async viewDraft(draftId) {
      const view = await viewDraftOnly(draftId);
      const label = view.account ? connection.account(view.account)?.label() : '';
      return label ? { ...view, accountLabel: label } : view;
    },

    async sendDraftFromCard(draftId, expectedMessageId) {
      return sendDraftFromCardImpl(draftId, expectedMessageId);
    },

    async discardDraft(draftId, expectedMessageId) {
      return discardDraftImpl(draftId, expectedMessageId);
    },
  };

  async function viewDraftOnly(draftId: string): Promise<DraftView> {
      const blank = (state: DraftView['state'], account: string | null): DraftView => ({
        state, draftId, account, messageId: null, threadId: null, to: [], cc: [], bcc: [], subject: '', body: '',
        bodyTruncated: false, attachments: [], updatedAt: null, gmailUrl: null,
      });
      if (!isGmailId(draftId)) return blank('unknown', null);
      const entry = entryFor(draftId);
      if (!entry) return blank('unknown', null);
      if (!connection.accounts().length) return { ...ledgerView(entry, 'not_connected'), gmailUrl: null };
      const owning = connection.account(entry.account);
      if (!owning) return { ...ledgerView(entry, 'other_account'), gmailUrl: null };
      if (entry.state === 'sent' || entry.state === 'discarded') return ledgerView(entry, entry.state);
      const draft = await currentDraft(owning.client(), entry);
      if (!draft) return ledgerView(entry, 'missing');
      if (entry.state === 'send_unknown') {
        // A send that Gmail never answered removes the draft once it lands.
        // Still there after the settle window: that send did not happen.
        const since = Date.parse(entry.updatedAt);
        if (Number.isFinite(since) && now() - since < SEND_UNKNOWN_SETTLE_MS) {
          return draftView(draft, { ...entry, messageId: draft.message.id }, 'send_unknown');
        }
        saveEntry({ ...entry, state: 'draft', messageId: draft.message.id, updatedAt: new Date(now()).toISOString() });
      } else if (draft.message.id !== entry.messageId) {
        // Edited in Gmail or by a later update: the card shows (and may send) this version.
        saveEntry({ ...entry, messageId: draft.message.id });
      }
      return draftView(draft, { ...entry, messageId: draft.message.id }, 'draft');
  }

  async function sendDraftFromCardImpl(draftId: string, expectedMessageId: string): Promise<SendReceipt> {
      const { account, client } = requireCompose({ draftId });
      const entry = openEntry(draftId, account);
      if (draftLocks.has(entry.draftId)) throw new GmailComposeError('send_in_progress', 'This draft is being sent right now.');
      draftLocks.add(entry.draftId);
      try {
        const draft = await currentDraft(client, entry);
        if (!draft) throw new GmailComposeError('not_found', 'This draft is no longer in Gmail (sent or deleted there).', 'none', [], 'Check Gmail Sent.');
        const view = draftView(draft, { ...entry, messageId: draft.message.id }, 'draft');
        if (draft.message.id !== expectedMessageId) {
          saveEntry({ ...entry, messageId: draft.message.id });
          throw new GmailComposeError('draft_changed', 'The draft changed since it was shown. Review the new version, then send.', 'none', [], undefined, { view });
        }
        return await sendLedgerDraft(client, account, { ...entry, messageId: draft.message.id }, 'card', view);
      } finally {
        draftLocks.delete(entry.draftId);
      }
  }

  async function discardDraftImpl(draftId: string, expectedMessageId: string): Promise<DraftView> {
      const { account, client } = requireCompose({ draftId });
      const entry = openEntry(draftId, account);
      if (draftLocks.has(entry.draftId)) throw new GmailComposeError('send_in_progress', 'This draft is being sent right now.');
      draftLocks.add(entry.draftId);
      try {
        const draft = await currentDraft(client, entry);
        const at = new Date(now()).toISOString();
        // Already gone (sent or deleted in Gmail): nothing to discard, and the
        // ledger is not told a story it cannot know.
        if (!draft) return ledgerView(entry, 'missing');
        if (draft.message.id !== expectedMessageId) {
          const view = draftView(draft, { ...entry, messageId: draft.message.id }, 'draft');
          saveEntry({ ...entry, messageId: draft.message.id });
          throw new GmailComposeError('draft_changed', 'The draft changed since it was shown. Review the new version first.', 'none', [], undefined, { view });
        }
        try {
          await client.deleteDraft(entry.draftId);
        } catch (error) {
          if (!(error instanceof GoogleApiError && error.status === 404)) throw composeFailure(error, 'none', 'Discarding the draft');
        }
        const discarded: DraftEntry = { ...entry, state: 'discarded', updatedAt: at };
        saveEntry(discarded);
        return ledgerView(discarded, 'discarded');
      } finally {
        draftLocks.delete(entry.draftId);
      }
  }
}
