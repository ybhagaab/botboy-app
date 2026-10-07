// @vitest-environment jsdom
//
// Chat Gmail draft cards (app.js, GMAIL_CHAT_TOOLS_PLAN.md §7). The card
// helpers and their delegated click listener are evaluated straight from the
// shipped source against a stub api(), like gmail-sync-ui.test.ts does for
// dashboard.js.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const app = readFileSync(path.join(process.cwd(), 'src/ui/app.js'), 'utf8');

function topLevel(name: string): string {
  const start = app.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  const end = app.indexOf('\n}\n', start);
  return app.slice(start, end + 2);
}

function constLine(name: string): string {
  const match = app.match(new RegExp(`\\nconst ${name} = .*\\n`));
  expect(match, `missing const ${name}`).not.toBeNull();
  return match![0];
}

function gmailClickListener(): string {
  const start = app.indexOf("document.addEventListener('click', async (event) => {\n  const button = event.target.closest('[data-gmail-draft-action]');");
  expect(start, 'missing the draft card click listener').toBeGreaterThanOrEqual(0);
  return app.slice(start, app.indexOf('\n});\n', start) + 4);
}

type ApiCall = { path: string; options?: { method?: string; body?: unknown } };
const holder: { api: (path: string, options?: ApiCall['options']) => Promise<any> } = { api: async () => ({}) };
let hydrateChatCards: (root: Element) => void;
let calls: ApiCall[];

const DRAFT = {
  state: 'draft', draftId: 'r-1', account: 'owner@gmail.com', messageId: 'm-2', threadId: 't-1',
  to: ['Jane Doe <jane@x.com>'], cc: ['bob@x.com'], bcc: [], subject: 'Running late <img src=x onerror=alert(1)>',
  body: 'Hi Jane,\nI will be 10 minutes late.\n<script>alert(1)</script>', bodyTruncated: false,
  updatedAt: '2026-10-06T09:00:00.000Z', gmailUrl: 'https://mail.google.com/mail/u/owner@gmail.com/#drafts',
};

beforeAll(() => {
  const source = [
    constLine('LESSON_MARKER_RE'), constLine('GMAIL_DRAFT_MARKER_RE'), constLine('MCP_SERVER_MARKER_RE'),
    topLevel('hydrateChatCards'), topLevel('fillLessonCard'), topLevel('lessonEsc'), topLevel('paintLessonCard'),
    // hydrateChatCards also expands MCP server cards (app.mcp-server-card.test.ts).
    topLevel('fillMcpServerCard'), topLevel('mcpCardTransport'), topLevel('paintMcpServerCard'),
    topLevel('fillGmailDraftCard'), topLevel('gmailDraftWhen'), topLevel('gmailFileSize'), topLevel('paintGmailDraftCard'),
    gmailClickListener(),
    'return { hydrateChatCards };',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  ({ hydrateChatCards } = new Function('api', source)((p: string, o?: ApiCall['options']) => {
    calls.push({ path: p, options: o });
    return holder.api(p, o);
  }));
});

beforeEach(() => {
  calls = [];
  holder.api = async (p: string) => (p === '/gmail-sync/drafts/r-1' ? { draft: DRAFT } : {});
});

async function settle() {
  for (let index = 0; index < 5; index++) await new Promise(resolve => setTimeout(resolve, 0));
}

async function cardFor(markerHtml = '<p>Here is the draft.</p><p>[[gmail-draft:r-1]]</p>'): Promise<HTMLElement> {
  document.body.innerHTML = `<div id="chat-messages"><div class="chat-msg assistant">${markerHtml}</div></div>`;
  hydrateChatCards(document.getElementById('chat-messages')!);
  await settle();
  return document.querySelector('.gmail-draft-card') as HTMLElement;
}

const button = (card: HTMLElement, action: string) => card.querySelector(`[data-gmail-draft-action="${action}"]`) as HTMLButtonElement;

describe('Gmail draft card', () => {
  it('expands the marker into the exact draft, escaped, with Send, Open in Gmail, and Discard', async () => {
    const card = await cardFor();
    expect(card.dataset.gmailDraftId).toBe('r-1');
    expect(card.dataset.messageId).toBe('m-2');
    expect(card.getAttribute('aria-live')).toBe('polite');
    expect(calls).toEqual([{ path: '/gmail-sync/drafts/r-1', options: undefined }]);
    expect(card.querySelector('.gmail-draft-head')!.textContent).toBe('Gmail draft · not sent · owner@gmail.com');
    const fields = [...card.querySelectorAll('dt')].map(dt => `${dt.textContent}: ${dt.nextElementSibling!.textContent}`);
    expect(fields).toEqual(['To: Jane Doe <jane@x.com>', 'Cc: bob@x.com', 'Subject: Running late <img src=x onerror=alert(1)>']);
    expect(card.querySelector('img, script')).toBeNull();
    const body = card.querySelector('.gmail-draft-body') as HTMLElement;
    expect(body.textContent).toBe(DRAFT.body);
    expect(body.getAttribute('tabindex')).toBe('0');
    const open = card.querySelector('a') as HTMLAnchorElement;
    expect(open.textContent).toBe('Open in Gmail');
    expect(open.href).toBe(DRAFT.gmailUrl);
    expect(open.target).toBe('_blank');
    expect(open.rel).toBe('noopener noreferrer');
    expect(button(card, 'send').textContent).toBe('Send');
    expect(button(card, 'discard').textContent).toBe('Discard');
    expect(document.body.textContent).not.toContain('[[gmail-draft:');
  });

  it('lists the attached files, escaped, with their sizes, in the draft and after it is sent', async () => {
    const attachments = [
      { name: 'Q3 report.pdf', mimeType: 'application/pdf', sizeBytes: 1_258_291 },
      { name: '<img src=x onerror=alert(1)>.png', mimeType: 'image/png', sizeBytes: 87_040 },
      { name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 512 },
      { mimeType: 'text/plain', sizeBytes: 3 },
    ];
    holder.api = async (p: string) => (p === '/gmail-sync/drafts/r-1' ? { draft: { ...DRAFT, attachments } } : {});
    const card = await cardFor();
    const attached = [...card.querySelectorAll('dt')].find(dt => dt.textContent === 'Attached')!;
    expect(attached).toBeDefined();
    const files = [...attached.nextElementSibling!.querySelectorAll('li')].map(item => item.textContent);
    expect(files).toEqual(['Q3 report.pdf · 1.2 MB', '<img src=x onerror=alert(1)>.png · 85 KB', 'notes.txt · 512 bytes']);
    expect(card.querySelector('img, script')).toBeNull();

    holder.api = async () => ({ draft: { ...DRAFT, state: 'sent', sentAt: '2026-10-06T09:01:00.000Z', attachments: attachments.slice(0, 1) } });
    const sent = await cardFor();
    expect(sent.querySelector('.gmail-draft-files')!.textContent).toBe('Q3 report.pdf · 1.2 MB');
    // No files, no row.
    holder.api = async () => ({ draft: { ...DRAFT, attachments: [] } });
    expect([...(await cardFor()).querySelectorAll('dt')].map(dt => dt.textContent)).toEqual(['To', 'Cc', 'Subject']);
  });

  it('hydrates a lesson card and a draft card in the same bubble with one write', async () => {
    holder.api = async (p: string) => (p === '/gmail-sync/drafts/r-1'
      ? { draft: DRAFT }
      : { lesson: { id: 'lesson_abc123', scope: 'ott', rule: 'Use the preset', evidence: 'seen twice', status: 'proposed', recurrenceCount: 1 } });
    const card = await cardFor('<p>[[lesson:lesson_abc123]]</p><p>[[gmail-draft:r-1]]</p>');
    expect(card.querySelector('.gmail-draft-head')).not.toBeNull();
    expect(document.querySelector('.lesson-card .lesson-rule')!.textContent).toBe('Use the preset');
    expect(calls.map(entry => entry.path).sort()).toEqual(['/gmail-sync/drafts/r-1', '/lessons/lesson_abc123']);
  });

  it('Send posts the version shown as an object body and repaints the card as sent', async () => {
    const card = await cardFor();
    holder.api = async () => ({ receipt: { status: 'sent' }, draft: { ...DRAFT, state: 'sent', sentAt: '2026-10-06T09:01:00.000Z', gmailUrl: 'https://mail.google.com/mail/u/owner@gmail.com/#all/t-1' } });
    button(card, 'send').click();
    await settle();
    expect(calls.at(-1)).toEqual({ path: '/gmail-sync/drafts/r-1/send', options: { method: 'POST', body: { messageId: 'm-2' } } });
    expect(card.querySelector('.gmail-draft-state.sent')!.textContent).toMatch(/^✓ Sent/);
    expect(card.querySelector('[data-gmail-draft-action]')).toBeNull();
    expect((card.querySelector('a') as HTMLAnchorElement).href).toBe('https://mail.google.com/mail/u/owner@gmail.com/#all/t-1');
    expect(card.dataset.messageId).toBe('');
  });

  it('shows a changed draft again with a note instead of sending it unseen', async () => {
    const card = await cardFor();
    holder.api = async () => ({ error: 'The draft changed since it was shown.', code: 'draft_changed', effect: 'none', draft: { ...DRAFT, messageId: 'm-3', body: 'New text' } });
    button(card, 'send').click();
    await settle();
    expect(card.dataset.messageId).toBe('m-3');
    expect(card.querySelector('.gmail-draft-body')!.textContent).toBe('New text');
    expect(card.querySelector('.gmail-draft-note')!.textContent).toBe('This draft changed since it was shown. Review it, then choose Send again.');
    expect(button(card, 'send').disabled).toBe(false);
  });

  it('keeps Send disabled after an unanswered send, and re-enables it after a rejected one', async () => {
    const card = await cardFor();
    holder.api = async () => ({ error: 'Gmail draft send timed out after 30s.', code: 'send_unknown_effect', effect: 'unknown' });
    button(card, 'send').click();
    await settle();
    expect(button(card, 'send').disabled).toBe(true);
    expect(button(card, 'discard').disabled).toBe(true);
    const alert = card.querySelector('.gmail-draft-error') as HTMLElement;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe('Gmail did not confirm the send. Check Gmail Sent before sending again.');

    const showDraft = async (p: string) => (p === '/gmail-sync/drafts/r-1' ? { draft: DRAFT } : {});
    holder.api = showDraft;
    const fresh = await cardFor();
    holder.api = async () => ({ error: 'Gmail is limiting requests for this account.', code: 'rate_limited', effect: 'none' });
    button(fresh, 'send').click();
    await settle();
    expect(button(fresh, 'send').disabled).toBe(false);
    expect(fresh.querySelector('.gmail-draft-error')!.textContent).toBe('Not sent: Gmail is limiting requests for this account.');

    // A request that never got an answer from BotBoy itself counts as unknown too.
    holder.api = showDraft;
    const lost = await cardFor();
    holder.api = async () => { throw new Error('Failed to fetch'); };
    button(lost, 'send').click();
    await settle();
    expect(button(lost, 'send').disabled).toBe(true);
  });

  it('Discard asks first, then paints the discarded state', async () => {
    const card = await cardFor();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    button(card, 'discard').click();
    await settle();
    expect(calls.filter(entry => entry.path.endsWith('/discard'))).toEqual([]);
    confirm.mockReturnValueOnce(true);
    holder.api = async () => ({ draft: { ...DRAFT, state: 'discarded' } });
    button(card, 'discard').click();
    await settle();
    expect(calls.at(-1)).toEqual({ path: '/gmail-sync/drafts/r-1/discard', options: { method: 'POST', body: { messageId: 'm-2' } } });
    expect(card.querySelector('.gmail-draft-state')!.textContent).toBe('Discarded: deleted from Gmail Drafts, never sent.');
    confirm.mockRestore();
  });

  it('paints the other states without actions, and never links outside Gmail', async () => {
    const paint = async (draft: Record<string, unknown>) => {
      holder.api = async () => ({ draft: { ...DRAFT, ...draft } });
      return cardFor();
    };
    expect((await paint({ state: 'missing', gmailUrl: 'https://mail.google.com/mail/u/owner@gmail.com/#sent' })).textContent).toContain('No longer in Gmail Drafts');
    expect((await paint({ state: 'send_unknown' })).textContent).toContain('Gmail did not confirm the send');
    expect((await paint({ state: 'other_account', account: 'old@gmail.com' })).textContent).toContain('belongs to old@gmail.com');
    const offline = await paint({ state: 'not_connected' });
    expect((offline.querySelector('a') as HTMLAnchorElement).getAttribute('href')).toBe('#/connections/gmail-sync');
    expect((await paint({ state: 'unknown' })).textContent).toBe('This Gmail draft card is not available.');
    for (const state of ['missing', 'send_unknown', 'other_account', 'not_connected', 'unknown']) {
      const card = await paint({ state });
      expect(card.querySelector('[data-gmail-draft-action="send"]')).toBeNull();
    }
    const spoofed = await paint({ gmailUrl: 'https://evil.example/phish' });
    expect(spoofed.querySelector('a')).toBeNull();
    holder.api = async () => ({ error: 'Gmail sync is unavailable.' });
    expect((await cardFor()).textContent).toBe('Gmail draft unavailable.');
  });
});
