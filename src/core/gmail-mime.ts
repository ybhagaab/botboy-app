/**
 * The RFC 5322 message BotBoy hands to Gmail for a draft or a send
 * (GMAIL_CHAT_TOOLS_PLAN.md §8, §13). Pure: no I/O.
 *
 * - The text is text/plain UTF-8, base64 in 76-column lines (safe for any text).
 * - With attachments the message is multipart/mixed: the text part, then one
 *   base64 part per file with its name in Content-Type `name` and
 *   Content-Disposition `filename` (RFC 2047 words for a non-ASCII name, as
 *   Gmail itself writes them).
 * - Non-ASCII subjects and display names become RFC 2047 B-words of at most
 *   75 characters, split on code points and folded onto continuation lines.
 * - No From, Date, or Message-ID header: Gmail adds them (From = the
 *   account's default send-as address and name).
 * - Bcc stays in the raw message; Gmail delivers to it and strips it.
 * - Header injection is refused, never cleaned: a CR, LF, or other control
 *   character in a subject, a name, or a file name is an input error.
 *
 * Replies follow Gmail's threading rules (users.messages reference): the
 * request carries the thread id, In-Reply-To/References name the original's
 * Message-ID, and the subject matches.
 */

import { createHash } from 'crypto';
import { splitAddressList } from '../monitors/gmail-message.js';

export const MAX_RECIPIENTS = 50;
export const MAX_SUBJECT_CHARS = 300;
export const MAX_BODY_CHARS = 20_000;
/** References keeps the newest ids only; long threads would otherwise grow it without bound. */
const MAX_REFERENCES = 20;
export const MAX_ATTACHMENTS = 10;
/**
 * Gmail's attachment limit: 25 MB (MiB) of files in one email. Gmail's SMTP
 * SIZE (35,882,577 bytes) fits exactly that once base64-encoded.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_NAME_CHARS = 200;

export interface MailAddress {
  name: string;
  /** Lowercase. */
  address: string;
}

export interface ComposeIssue {
  path: string;
  message: string;
}

/** Every problem in one pass, so the model fixes them in one retry. */
export class GmailComposeInputError extends Error {
  constructor(readonly issues: ComposeIssue[]) {
    super(issues.map(issue => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'GmailComposeInputError';
  }
}

const ADDRESS_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
// Any C0 control except tab, DEL, and the Unicode line/paragraph separators.
const HEADER_CONTROL = /[\u0000-\u0008\u000A-\u001F\u007F\u2028\u2029]/;
const MESSAGE_ID_PATTERN = /^<[^<>\s]{1,250}@[^<>\s]{1,250}>$/;

function brief(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

export function isMailAddress(value: string): boolean {
  return value.length <= 254 && ADDRESS_PATTERN.test(value);
}

/**
 * Recipients from the model: an array of entries or one comma/semicolon list.
 * Each entry is `addr`, `<addr>`, or `Name <addr>`. Invalid entries are
 * reported, never dropped.
 */
export function parseRecipients(value: unknown, path: string, issues: ComposeIssue[]): MailAddress[] {
  if (value === undefined || value === null || value === '') return [];
  const entries: string[] = [];
  if (typeof value === 'string') entries.push(...splitAddressList(value));
  else if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== 'string') {
        issues.push({ path: `${path}[${index}]`, message: 'must be an email address string' });
        continue;
      }
      entries.push(...splitAddressList(entry));
    }
  } else {
    issues.push({ path, message: 'must be an email address, a comma-separated list, or an array of addresses' });
    return [];
  }
  const out: MailAddress[] = [];
  for (const [index, entry] of entries.entries()) {
    const angle = entry.match(/^(.*?)<([^<>]*)>\s*$/s);
    const rawAddress = (angle ? angle[2] : entry).trim();
    const rawName = angle ? angle[1].trim() : '';
    const name = rawName.replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1').trim();
    if (!isMailAddress(rawAddress)) {
      issues.push({ path: `${path}[${index}]`, message: `not an email address: "${brief(entry)}"` });
      continue;
    }
    if (HEADER_CONTROL.test(name)) {
      issues.push({ path: `${path}[${index}]`, message: 'the display name contains a line break or control character' });
      continue;
    }
    out.push({ name, address: rawAddress.toLowerCase() });
  }
  return out;
}

/** The same address once, first spelling wins. */
export function uniqueAddresses(list: readonly MailAddress[], exclude: ReadonlySet<string> = new Set()): MailAddress[] {
  const seen = new Set(exclude);
  const out: MailAddress[] = [];
  for (const entry of list) {
    if (seen.has(entry.address)) continue;
    seen.add(entry.address);
    out.push(entry);
  }
  return out;
}

function isPrintableAscii(value: string): boolean {
  return /^[\x20-\x7E]*$/.test(value);
}

/** Code-point chunks whose UTF-8 form is at most `maxBytes` (45 bytes → 60 base64 chars). */
function utf8Chunks(value: string, maxBytes = 45): string[] {
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes && current) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** RFC 2047 B-words for a non-ASCII value, folded; ASCII passes through. */
export function encodeHeaderText(value: string): string {
  if (isPrintableAscii(value)) return value;
  return utf8Chunks(value)
    .map(chunk => `=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
}

/** `Name <addr>` with the name quoted or encoded as RFC 5322 needs. */
export function formatAddress(entry: MailAddress): string {
  if (!entry.name) return entry.address;
  let phrase: string;
  if (!isPrintableAscii(entry.name)) phrase = encodeHeaderText(entry.name);
  else if (/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/.test(entry.name)) phrase = entry.name;
  else phrase = `"${entry.name.replace(/(["\\])/g, '\\$1')}"`;
  return `${phrase} <${entry.address}>`;
}

function addressHeader(name: string, list: readonly MailAddress[]): string | null {
  return list.length ? `${name}: ${list.map(formatAddress).join(',\r\n ')}` : null;
}

export function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, '\n');
}

/** Base64 in 76-column lines (RFC 2045); a slice loop, so a 25 MB file stays linear. */
function base64Lines(bytes: Buffer): string {
  const encoded = bytes.toString('base64');
  const lines: string[] = [];
  for (let at = 0; at < encoded.length; at += 76) lines.push(encoded.slice(at, at + 76));
  return lines.join('\r\n');
}

// ── Attachments ──────────────────────────────────────────────────────────

export interface MimeAttachment {
  /** The file name the recipient sees. */
  name: string;
  /** Lowercase `type/subtype`. */
  mimeType: string;
  content: Buffer;
}

/** Content types by lowercase extension; anything else is application/octet-stream. */
const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroenabled.12',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  pages: 'application/vnd.apple.pages',
  numbers: 'application/vnd.apple.numbers',
  key: 'application/vnd.apple.keynote',
  epub: 'application/epub+zip',
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  sql: 'application/sql',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
});

/**
 * File types Gmail refuses to send, even zipped (support.google.com/mail/answer/6590,
 * read 2026-10-06). Gmail would reject the whole message.
 */
export const GMAIL_BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  'ade', 'adp', 'apk', 'appx', 'appxbundle', 'bat', 'cab', 'chm', 'cmd', 'com', 'cpl', 'diagcab', 'diagcfg',
  'diagpkg', 'dll', 'dmg', 'ex', 'ex_', 'exe', 'hta', 'img', 'ins', 'iso', 'isp', 'jar', 'jnlp', 'js', 'jse',
  'lib', 'lnk', 'mde', 'mjs', 'msc', 'msi', 'msix', 'msixbundle', 'msp', 'mst', 'nsh', 'pif', 'ps1', 'scr',
  'sct', 'shb', 'sys', 'vb', 'vbe', 'vbs', 'vhd', 'vxd', 'wsc', 'wsf', 'wsh', 'xll',
]);

const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** Lowercase extension without its dot, or '' (a leading-dot name has none). */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

export function mimeTypeForName(name: string): string {
  return MIME_TYPES[extensionOf(name)] ?? 'application/octet-stream';
}

/**
 * "512 bytes", "85 KB", "1.2 MB" (1024-based, as Gmail's 25 MB limit is).
 * Megabytes round up, so a file just over the limit never reads as "25 MB".
 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(Math.ceil((bytes / (1024 * 1024)) * 10) / 10).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** Why `name` cannot be an attachment's file name, or null. */
export function attachmentNameIssue(name: string): string | null {
  if (!name.trim()) return 'the file name is empty';
  if ([...name].length > MAX_ATTACHMENT_NAME_CHARS) return `a file name has at most ${MAX_ATTACHMENT_NAME_CHARS} characters`;
  if (HEADER_CONTROL.test(name)) return 'the file name contains a line break or control character';
  if (/[\\/]/.test(name)) return 'a file name, not a path: no / or \\';
  if (/^\.+$/.test(name.trim())) return 'not a file name';
  return null;
}

/** A Gmail-blocked type in `name`, as `.exe`, or null. */
export function blockedAttachmentType(name: string): string | null {
  const extension = extensionOf(name);
  return GMAIL_BLOCKED_EXTENSIONS.has(extension) ? `.${extension}` : null;
}

function attachmentIssues(list: readonly MimeAttachment[]): ComposeIssue[] {
  const issues: ComposeIssue[] = [];
  if (list.length > MAX_ATTACHMENTS) issues.push({ path: 'attachments', message: `at most ${MAX_ATTACHMENTS} files in one email (got ${list.length})` });
  let total = 0;
  for (const [index, attachment] of list.entries()) {
    const nameIssue = attachmentNameIssue(String(attachment.name ?? ''));
    if (nameIssue) issues.push({ path: `attachments[${index}].name`, message: nameIssue });
    const blocked = blockedAttachmentType(String(attachment.name ?? ''));
    if (blocked) issues.push({ path: `attachments[${index}].name`, message: `Gmail blocks ${blocked} files` });
    if (!MIME_TYPE_PATTERN.test(String(attachment.mimeType ?? '')) || /^(?:multipart|message)\//.test(attachment.mimeType)) {
      issues.push({ path: `attachments[${index}]`, message: 'unusable content type' });
    }
    const size = Buffer.isBuffer(attachment.content) ? attachment.content.length : 0;
    if (!size) issues.push({ path: `attachments[${index}]`, message: 'the file is empty' });
    total += size;
  }
  if (total > MAX_ATTACHMENT_BYTES) {
    issues.push({ path: 'attachments', message: `at most ${formatByteSize(MAX_ATTACHMENT_BYTES)} of files in one email (got ${formatByteSize(total)})` });
  }
  return issues;
}

/** `"name"` quoted for a MIME parameter; a non-ASCII name as folded RFC 2047 words inside the quotes. */
function quotedParameter(value: string): string {
  return isPrintableAscii(value)
    ? `"${value.replace(/(["\\])/g, '\\$1')}"`
    : `"${encodeHeaderText(value)}"`;
}

function attachmentPart(attachment: MimeAttachment): string {
  const name = quotedParameter(attachment.name);
  return [
    `Content-Type: ${attachment.mimeType};\r\n name=${name}`,
    `Content-Disposition: attachment;\r\n filename=${name}`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(attachment.content),
  ].join('\r\n');
}

/**
 * A boundary no part can contain: base64 lines never hold `-` or `_`, and a
 * folded header line starts with a space. Derived from the content, so the
 * same message always renders the same bytes.
 */
function mixedBoundary(text: string, attachments: readonly MimeAttachment[]): string {
  const hash = createHash('sha256').update(text, 'utf8');
  for (const attachment of attachments) hash.update('\0').update(attachment.name, 'utf8').update('\0').update(attachment.content);
  return `botboy_mixed_${hash.digest('hex').slice(0, 32)}`;
}

/** "Re: …" exactly once, as Gmail and mail clients expect. */
export function replySubject(original: string): string {
  const trimmed = original.trim();
  return /^re\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/** Subjects equal after dropping Re:/Fwd: prefixes and spacing. */
export function sameThreadSubject(a: string, b: string): boolean {
  const core = (value: string) => value.replace(/^(?:\s*(?:re|fwd?|aw|wg)\s*(?:\[\d+\])?\s*:)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return core(a) === core(b);
}

/** Message-ID tokens (`<…@…>`) from a References or In-Reply-To value. */
export function messageIdsIn(value: string | undefined): string[] {
  return (value ?? '').match(/<[^<>\s]+@[^<>\s]+>/g) ?? [];
}

export interface RawMessageInput {
  to: readonly MailAddress[];
  cc?: readonly MailAddress[];
  bcc?: readonly MailAddress[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: readonly string[];
  /** The send-as identity to write From with; omitted lets Gmail use the account's default. */
  from?: MailAddress;
  /** Files, in order; none keeps the single text/plain message. */
  attachments?: readonly MimeAttachment[];
}

/**
 * Validates the message once more (defense in depth) and renders RFC 5322
 * text with CRLF line ends. The text is ASCII throughout.
 */
export function buildRawMessage(input: RawMessageInput): string {
  const issues: ComposeIssue[] = [];
  const total = input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0);
  if (!total) issues.push({ path: 'to', message: 'at least one recipient is required' });
  if (total > MAX_RECIPIENTS) issues.push({ path: 'to', message: `at most ${MAX_RECIPIENTS} recipients in total (got ${total})` });
  if (HEADER_CONTROL.test(input.subject)) issues.push({ path: 'subject', message: 'contains a line break or control character' });
  if (input.subject.length > MAX_SUBJECT_CHARS) issues.push({ path: 'subject', message: `at most ${MAX_SUBJECT_CHARS} characters` });
  if (input.body.length > MAX_BODY_CHARS) issues.push({ path: 'body', message: `at most ${MAX_BODY_CHARS} characters` });
  for (const entry of [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]) {
    if (!isMailAddress(entry.address) || HEADER_CONTROL.test(entry.name)) issues.push({ path: 'to', message: 'invalid recipient' });
  }
  if (input.from && (!isMailAddress(input.from.address) || HEADER_CONTROL.test(input.from.name))) issues.push({ path: 'from', message: 'invalid sender address' });
  const ids = [...(input.inReplyTo ? [input.inReplyTo] : []), ...(input.references ?? [])];
  if (ids.some(id => !MESSAGE_ID_PATTERN.test(id))) issues.push({ path: 'replyToMessageId', message: 'the original message has an unusable Message-ID' });
  const attachments = input.attachments ?? [];
  issues.push(...attachmentIssues(attachments));
  if (issues.length) throw new GmailComposeInputError(issues);

  const references = (input.references ?? []).slice(-MAX_REFERENCES);
  const headers = [
    input.from ? addressHeader('From', [input.from]) : null,
    addressHeader('To', input.to),
    addressHeader('Cc', input.cc ?? []),
    addressHeader('Bcc', input.bcc ?? []),
    `Subject: ${encodeHeaderText(input.subject)}`,
    input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : null,
    references.length ? `References: ${references.join('\r\n ')}` : null,
    'MIME-Version: 1.0',
  ].filter((line): line is string => Boolean(line));
  const body = normalizeBody(input.body).split('\n').join('\r\n');
  const text = ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', base64Lines(Buffer.from(body, 'utf8'))].join('\r\n');
  if (!attachments.length) return `${headers.join('\r\n')}\r\n${text}\r\n`;
  const boundary = mixedBoundary(body, attachments);
  const parts = [text, ...attachments.map(attachmentPart)];
  return `${headers.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`
    + parts.map(part => `--${boundary}\r\n${part}\r\n`).join('')
    + `--${boundary}--\r\n`;
}

export function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}
