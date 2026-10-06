import { describe, expect, it } from 'vitest';
import {
  GmailComposeInputError,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_BODY_CHARS,
  MAX_RECIPIENTS,
  MAX_SUBJECT_CHARS,
  attachmentNameIssue,
  blockedAttachmentType,
  buildRawMessage,
  encodeHeaderText,
  extensionOf,
  formatByteSize,
  mimeTypeForName,
  formatAddress,
  isMailAddress,
  messageIdsIn,
  parseRecipients,
  replySubject,
  sameThreadSubject,
  toBase64Url,
  uniqueAddresses,
  type ComposeIssue,
} from './gmail-mime.js';
import { decodeMimeWords } from '../monitors/gmail-message.js';

/** The RFC 5322 text BotBoy hands to Gmail (GMAIL_CHAT_TOOLS_PLAN.md §8). */

const JANE = { name: 'Jane Doe', address: 'jane@example.com' };

function split(raw: string): { headers: string; body: string } {
  const at = raw.indexOf('\r\n\r\n');
  return { headers: raw.slice(0, at), body: raw.slice(at + 4) };
}

function unfold(headers: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of headers.replace(/\r\n(?=[ \t])/g, '').split('\r\n')) {
    const colon = line.indexOf(':');
    out.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return out;
}

function failure(run: () => unknown): GmailComposeInputError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(GmailComposeInputError);
    return error as GmailComposeInputError;
  }
  throw new Error('expected a GmailComposeInputError');
}

describe('Gmail MIME builder', () => {
  it('renders a plain ASCII message exactly: no From/Date/Message-ID, base64 UTF-8 body with CRLF lines', () => {
    const raw = buildRawMessage({ to: [JANE], subject: 'Lunch on Friday', body: 'Hi Jane,\nSee you at noon.\n' });
    const { headers, body } = split(raw);
    expect(headers).toBe([
      'To: Jane Doe <jane@example.com>',
      'Subject: Lunch on Friday',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
    ].join('\r\n'));
    expect(raw.endsWith('\r\n')).toBe(true);
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Hi Jane,\r\nSee you at noon.\r\n');
    expect(raw).not.toMatch(/^(From|Date|Message-ID):/im);
  });

  it('wraps a long body in 76-column base64 lines that decode to the exact text', () => {
    const text = 'Ünïcode line — ☕\r\nsecond line\nthird\r'.repeat(40);
    const { body } = split(buildRawMessage({ to: [JANE], subject: 's', body: text }));
    const lines = body.trimEnd().split('\r\n');
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.every(line => line.length <= 76)).toBe(true);
    expect(Buffer.from(lines.join(''), 'base64').toString('utf8')).toBe(text.replace(/\r\n?|\n/g, '\r\n'));
  });

  it('encodes a non-ASCII subject as folded B-words of at most 75 characters that decode back exactly', () => {
    const subject = 'Café résumé — 会議の議事録 ☕ '.repeat(4).trim();
    const encoded = encodeHeaderText(subject);
    const words = encoded.split('\r\n ');
    expect(words.length).toBeGreaterThan(2);
    for (const word of words) {
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(word.length).toBeLessThanOrEqual(75);
    }
    expect(decodeMimeWords(words.join(' '))).toBe(subject);
    const headers = unfold(split(buildRawMessage({ to: [JANE], subject, body: 'x' })).headers);
    expect(decodeMimeWords(headers.get('subject')!)).toBe(subject);
    expect(encodeHeaderText('Plain ASCII subject')).toBe('Plain ASCII subject');
  });

  it('quotes or encodes display names as RFC 5322 needs', () => {
    expect(formatAddress({ name: '', address: 'a@x.com' })).toBe('a@x.com');
    expect(formatAddress(JANE)).toBe('Jane Doe <jane@example.com>');
    expect(formatAddress({ name: 'Doe, Jane', address: 'jane@example.com' })).toBe('"Doe, Jane" <jane@example.com>');
    expect(formatAddress({ name: 'J. "Jay" Doe\\', address: 'j@x.com' })).toBe('"J. \\"Jay\\" Doe\\\\" <j@x.com>');
    const encoded = formatAddress({ name: 'Zoë Ñúñez', address: 'zoe@x.com' });
    expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?= <zoe@x\.com>$/);
    expect(decodeMimeWords(encoded.replace(/ <zoe@x\.com>$/, ''))).toBe('Zoë Ñúñez');
  });

  it('writes reply headers and keeps only the newest 20 References, folded', () => {
    const references = Array.from({ length: 25 }, (_, index) => `<id-${index}@mail.example>`);
    const headers = unfold(split(buildRawMessage({
      to: [JANE], cc: [{ name: '', address: 'cc@x.com' }], bcc: [{ name: '', address: 'bcc@x.com' }],
      subject: 'Re: Plan', body: 'ok', inReplyTo: '<id-24@mail.example>', references,
    })).headers);
    expect(headers.get('in-reply-to')).toBe('<id-24@mail.example>');
    const kept = headers.get('references')!.split(/\s+/);
    expect(kept).toEqual(references.slice(-20));
    expect(headers.get('cc')).toBe('cc@x.com');
    // Bcc stays in the raw message: Gmail delivers to it and strips it.
    expect(headers.get('bcc')).toBe('bcc@x.com');
    expect(buildRawMessage({ to: [JANE], subject: 's', body: 'b', references }).includes('References: <id-5@mail.example>\r\n <id-6@mail.example>')).toBe(true);
  });

  it('refuses header injection in a subject, a name, or a Message-ID instead of cleaning it', () => {
    expect(failure(() => buildRawMessage({ to: [JANE], subject: 'Hello\r\nBcc: spy@evil.example', body: 'x' })).issues)
      .toContainEqual({ path: 'subject', message: 'contains a line break or control character' });
    expect(failure(() => buildRawMessage({ to: [{ name: 'Eve\nBcc: spy@evil.example', address: 'eve@x.com' }], subject: 's', body: 'x' })).issues)
      .toContainEqual({ path: 'to', message: 'invalid recipient' });
    expect(failure(() => buildRawMessage({ to: [JANE], subject: 's', body: 'x', inReplyTo: '<a@b>\r\nBcc: spy@evil.example' })).issues)
      .toContainEqual(expect.objectContaining({ path: 'replyToMessageId' }));
    const issues: ComposeIssue[] = [];
    expect(parseRecipients(['"Eve\r\nBcc: spy@evil.example" <eve@x.com>'], 'to', issues)).toEqual([]);
    expect(issues).toEqual([{ path: 'to[0]', message: 'the display name contains a line break or control character' }]);
    expect(isMailAddress('eve@x.com\r\nBcc: spy@evil.example')).toBe(false);
  });

  it('enforces the recipient, subject, and body limits together', () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, index) => ({ name: '', address: `p${index}@x.com` }));
    const error = failure(() => buildRawMessage({ to: many, subject: 's'.repeat(MAX_SUBJECT_CHARS + 1), body: 'b'.repeat(MAX_BODY_CHARS + 1) }));
    expect(error.issues.map(issue => issue.path).sort()).toEqual(['body', 'subject', 'to']);
    expect(failure(() => buildRawMessage({ to: [], subject: 's', body: 'b' })).issues).toEqual([{ path: 'to', message: 'at least one recipient is required' }]);
    expect(() => buildRawMessage({ to: many.slice(0, MAX_RECIPIENTS), subject: 's'.repeat(MAX_SUBJECT_CHARS), body: 'b'.repeat(MAX_BODY_CHARS) })).not.toThrow();
  });
});

/** A multipart/mixed message as its boundary and parts (headers unfolded, content decoded). */
function mixedParts(raw: string) {
  const { headers, body } = split(raw);
  const boundary = /^multipart\/mixed; boundary="([^"]+)"$/.exec(unfold(headers).get('content-type')!)![1];
  expect(body.startsWith(`--${boundary}\r\n`)).toBe(true);
  expect(body.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
  const sections = body.slice(`--${boundary}\r\n`.length, -`\r\n--${boundary}--\r\n`.length).split(`\r\n--${boundary}\r\n`);
  return {
    boundary,
    parts: sections.map(section => {
      const at = section.indexOf('\r\n\r\n');
      return { rawHeaders: section.slice(0, at), headers: unfold(section.slice(0, at)), lines: section.slice(at + 4).split('\r\n'), content: Buffer.from(section.slice(at + 4).replace(/\r\n/g, ''), 'base64') };
    }),
  };
}

describe('Gmail MIME attachments', () => {
  const PDF = { name: 'Q3 "final".pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF-1.4 synthetic report') };
  const NOTE = { name: 'Résumé café — 会議.txt', mimeType: 'text/plain', content: Buffer.from('hello\n', 'utf8') };

  it('renders multipart/mixed: the text part first, then each file as a named base64 part, all ASCII', () => {
    const raw = buildRawMessage({ to: [JANE], subject: 'Report', body: 'See attached.\n', attachments: [PDF, NOTE] });
    expect(raw).toMatch(/^[\x00-\x7F]*$/);
    const { headers } = split(raw);
    expect(headers.split('\r\n').slice(0, 3)).toEqual(['To: Jane Doe <jane@example.com>', 'Subject: Report', 'MIME-Version: 1.0']);
    expect(unfold(headers).has('content-transfer-encoding')).toBe(false);

    const { boundary, parts } = mixedParts(raw);
    expect(boundary).toMatch(/^botboy_mixed_[a-f0-9]{32}$/);
    expect(parts).toHaveLength(3);
    expect(parts[0].rawHeaders).toBe('Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64');
    expect(parts[0].content.toString('utf8')).toBe('See attached.\r\n');

    expect(parts[1].rawHeaders).toBe([
      'Content-Type: application/pdf;\r\n name="Q3 \\"final\\".pdf"',
      'Content-Disposition: attachment;\r\n filename="Q3 \\"final\\".pdf"',
      'Content-Transfer-Encoding: base64',
    ].join('\r\n'));
    expect(parts[1].content.equals(PDF.content)).toBe(true);

    // A non-ASCII name is RFC 2047 words inside the quotes, as Gmail writes it.
    const name = /^text\/plain; name="(.+)"$/.exec(parts[2].headers.get('content-type')!)![1];
    expect(name).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeMimeWords(name)).toBe(NOTE.name);
    expect(decodeMimeWords(/^attachment; filename="(.+)"$/.exec(parts[2].headers.get('content-disposition')!)![1])).toBe(NOTE.name);
    expect(parts[2].content.toString('utf8')).toBe('hello\n');
  });

  it('wraps file content in 76-column lines that decode to the exact bytes, and renders the same message identically', () => {
    const bytes = Buffer.from(Array.from({ length: 100_000 }, (_, index) => (index * 7919) % 256));
    const input = { to: [JANE], subject: 's', body: 'b', attachments: [{ name: 'data.bin', mimeType: 'application/octet-stream', content: bytes }] };
    const raw = buildRawMessage(input);
    const { boundary, parts } = mixedParts(raw);
    expect(parts[1].lines.every(line => line.length <= 76)).toBe(true);
    expect(parts[1].content.equals(bytes)).toBe(true);
    // Base64 never holds - or _, so no line can be the boundary.
    expect(parts.flatMap(part => part.lines).some(line => line.includes(boundary))).toBe(false);
    expect(buildRawMessage(input)).toBe(raw);
    const changed = Buffer.from(bytes);
    changed[0] ^= 1;
    expect(mixedParts(buildRawMessage({ ...input, attachments: [{ ...input.attachments[0], content: changed }] })).boundary).not.toBe(boundary);
    // Without files the message stays the single text/plain part.
    expect(unfold(split(buildRawMessage({ ...input, attachments: [] })).headers).get('content-type')).toBe('text/plain; charset="UTF-8"');
  });

  it('refuses unusable files instead of cleaning them: count, total size, names, blocked types, empty content, content type', () => {
    const tiny = (name: string, extra: Partial<{ mimeType: string; content: Buffer }> = {}) => ({ name, mimeType: 'text/plain', content: Buffer.from('x'), ...extra });
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => tiny(`f${index}.txt`));
    expect(failure(() => buildRawMessage({ to: [JANE], subject: 's', body: 'b', attachments: many })).issues)
      .toContainEqual({ path: 'attachments', message: `at most ${MAX_ATTACHMENTS} files in one email (got ${MAX_ATTACHMENTS + 1})` });
    const half = Buffer.alloc(13 * 1024 * 1024);
    expect(failure(() => buildRawMessage({ to: [JANE], subject: 's', body: 'b', attachments: [tiny('a.bin', { content: half }), tiny('b.bin', { content: half })] })).issues)
      .toEqual([{ path: 'attachments', message: 'at most 25 MB of files in one email (got 26 MB)' }]);
    expect(() => buildRawMessage({ to: [JANE], subject: 's', body: 'b', attachments: [tiny('a.bin', { content: half.subarray(0, MAX_ATTACHMENT_BYTES / 2) }), tiny('b.bin', { content: half.subarray(0, MAX_ATTACHMENT_BYTES / 2) })] })).not.toThrow();
    const issues = failure(() => buildRawMessage({
      to: [JANE], subject: 's', body: 'b',
      attachments: [tiny('a\r\nBcc: spy@evil.example.txt'), tiny('dir/a.txt'), tiny('setup.exe'), tiny('empty.txt', { content: Buffer.alloc(0) }), tiny('x.eml', { mimeType: 'message/rfc822' })],
    })).issues;
    expect(issues).toEqual([
      { path: 'attachments[0].name', message: 'the file name contains a line break or control character' },
      { path: 'attachments[1].name', message: 'a file name, not a path: no / or \\' },
      { path: 'attachments[2].name', message: 'Gmail blocks .exe files' },
      { path: 'attachments[3]', message: 'the file is empty' },
      { path: 'attachments[4]', message: 'unusable content type' },
    ]);
  });

  it('names types, sizes, and blocked extensions', () => {
    expect(extensionOf('Report.Final.PDF')).toBe('pdf');
    expect(extensionOf('.env')).toBe('');
    expect(extensionOf('README')).toBe('');
    expect(mimeTypeForName('deck.pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(mimeTypeForName('photo.JPEG')).toBe('image/jpeg');
    expect(mimeTypeForName('mystery.qqq')).toBe('application/octet-stream');
    expect(formatByteSize(512)).toBe('512 bytes');
    expect(formatByteSize(87_040)).toBe('85 KB');
    expect(formatByteSize(1_258_291)).toBe('1.2 MB');
    expect(formatByteSize(MAX_ATTACHMENT_BYTES)).toBe('25 MB');
    expect(blockedAttachmentType('tool.JS')).toBe('.js');
    expect(blockedAttachmentType('notes.txt')).toBeNull();
    expect(attachmentNameIssue('x'.repeat(201))).toMatch(/at most 200 characters/);
    expect(attachmentNameIssue('..')).toBe('not a file name');
    expect(attachmentNameIssue('   ')).toBe('the file name is empty');
    expect(attachmentNameIssue('Q3 report.pdf')).toBeNull();
  });
});

describe('Gmail recipients and subjects', () => {
  it('parses strings and arrays, lowercases addresses, and reports every invalid entry instead of dropping it', () => {
    const issues: ComposeIssue[] = [];
    expect(parseRecipients('a@x.com; "Doe, Jane" <JANE@Example.com>, bad-address', 'to', issues)).toEqual([
      { name: '', address: 'a@x.com' },
      { name: 'Doe, Jane', address: 'jane@example.com' },
    ]);
    expect(issues).toEqual([{ path: 'to[2]', message: 'not an email address: "bad-address"' }]);

    const more: ComposeIssue[] = [];
    expect(parseRecipients(['Bo <bo@x.com>', 42, 'c@x.com, d@x'], 'cc', more)).toEqual([
      { name: 'Bo', address: 'bo@x.com' },
      { name: '', address: 'c@x.com' },
    ]);
    expect(more).toEqual([
      { path: 'cc[1]', message: 'must be an email address string' },
      { path: 'cc[2]', message: 'not an email address: "d@x"' },
    ]);
    const shape: ComposeIssue[] = [];
    expect(parseRecipients({ to: 'a@x.com' }, 'bcc', shape)).toEqual([]);
    expect(shape[0].path).toBe('bcc');
    expect(parseRecipients(undefined, 'to', shape)).toEqual([]);
  });

  it('dedups addresses keeping the first spelling and honoring an exclusion set', () => {
    const list = [{ name: 'A', address: 'a@x.com' }, { name: 'A again', address: 'a@x.com' }, { name: 'Me', address: 'me@x.com' }];
    expect(uniqueAddresses(list, new Set(['me@x.com']))).toEqual([{ name: 'A', address: 'a@x.com' }]);
  });

  it('prefixes Re: once and compares subjects without reply/forward prefixes', () => {
    expect(replySubject('Lunch')).toBe('Re: Lunch');
    expect(replySubject('RE: Lunch ')).toBe('RE: Lunch');
    expect(sameThreadSubject('Re: Lunch', 'Fwd:  lunch ')).toBe(true);
    expect(sameThreadSubject('Re: Re: Lunch', 'Lunch')).toBe(true);
    expect(sameThreadSubject('Lunch', 'Dinner')).toBe(false);
  });

  it('extracts Message-ID tokens and base64url-encodes without padding or URL-unsafe characters', () => {
    expect(messageIdsIn('<a@b.c> junk <d@e.f>\r\n <g@h.i>')).toEqual(['<a@b.c>', '<d@e.f>', '<g@h.i>']);
    expect(messageIdsIn(undefined)).toEqual([]);
    const encoded = toBase64Url('Subject: ??>>~~\r\n\r\n\u00ff\u00fe');
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).toBe('Subject: ??>>~~\r\n\r\n\u00ff\u00fe');
  });
});
