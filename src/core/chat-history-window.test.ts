import { describe, expect, it } from 'vitest';
import {
  CHAT_HISTORY_BOUNDARY_SLACK_TOKENS, CHAT_HISTORY_FLOOR_ROWS, CHAT_HISTORY_MAX_TOKENS, CHAT_HISTORY_OWNER_MESSAGES,
  chatHistoryBudgetTokens, chatHistoryWindowOptions, selectHistoryWindow, type HistoryRow, type HistoryWindowOptions,
} from './chat-history-window.js';

/**
 * The chat history a turn sends word for word (docs/maps/chat-agent.md "Chat history window"). Owner decisions 2026-10-19: size it by
 * tokens up to 50K, and always keep the owner's own messages. The incident behind it: during a job BotBoy's continuation triggers
 * took 7 of the 10 user messages the old 20-message window held, so the owner's corrections fell out after three of their messages.
 */
const TRIGGER = '[Automatic continuation — not a message from the owner]';
const isAutomatic = (row: HistoryRow) => String(row.content ?? '').startsWith(TRIGGER);

/** Builds a chronological history; `newestFirst` is what the selector reads. */
function history() {
  const rows: HistoryRow[] = [];
  let seq = 0;
  const add = (role: string, tokens: number, content?: string) => {
    seq += 1;
    const row = { id: `m${seq}`, role, content: content ?? `${role} ${seq}`, tokens };
    rows.push(row);
    return row;
  };
  return {
    rows,
    owner: (tokens = 250, text?: string) => add('user', tokens, text),
    automatic: (tokens = 100) => add('user', tokens, `${TRIGGER}\nWhy this turn started: next step ${seq + 1}`),
    reply: (tokens = 250, text?: string) => add('assistant', tokens, text),
    tool: (tokens = 100) => add('tool', tokens),
    newestFirst: () => [...rows].reverse(),
  };
}
const options = (over: Partial<HistoryWindowOptions> = {}): HistoryWindowOptions => ({
  budgetTokens: 50_000, floorRows: 20, ownerMessages: 15, pinBudgetTokens: 12_500, isAutomatic, ...over,
});
const ids = (rows: HistoryRow[]) => rows.map(row => row.id);
/** Positions of `picked` in the chronological list must only increase. */
const inOrder = (all: HistoryRow[], picked: HistoryRow[]) => picked.every((row, index) => index === 0 || all.indexOf(row) > all.indexOf(picked[index - 1]));

describe('chat history window', () => {
  describe('budget', () => {
    it('is a tenth of the model window, at most 50K; an unknown window gets the floor only', () => {
      expect(CHAT_HISTORY_MAX_TOKENS).toBe(50_000);
      expect(chatHistoryBudgetTokens(1_000_000)).toBe(50_000);
      expect(chatHistoryBudgetTokens(400_000)).toBe(40_000);
      expect(chatHistoryBudgetTokens(262_144)).toBe(26_214);
      expect(chatHistoryBudgetTokens(200_000)).toBe(20_000);
      expect(chatHistoryBudgetTokens(32_768)).toBe(3_276);
      for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(chatHistoryBudgetTokens(bad), String(bad)).toBe(0);
    });

    it('the turn options keep the old 20 newest, 15 owner messages, and a quarter of the budget for them', () => {
      const chosen = chatHistoryWindowOptions(1_000_000, isAutomatic);
      expect(chosen).toEqual({ budgetTokens: 50_000, floorRows: CHAT_HISTORY_FLOOR_ROWS, ownerMessages: CHAT_HISTORY_OWNER_MESSAGES, pinBudgetTokens: 12_500, isAutomatic });
      expect([CHAT_HISTORY_FLOOR_ROWS, CHAT_HISTORY_OWNER_MESSAGES]).toEqual([20, 15]);
      expect(chatHistoryWindowOptions(32_768, isAutomatic)).toMatchObject({ budgetTokens: 3_276, pinBudgetTokens: 819 });
    });
  });

  describe('the unbroken newest stretch', () => {
    it('an ordinary long chat sends everything up to the budget and starts at a question', () => {
      const h = history();
      for (let i = 0; i < 300; i += 1) { h.owner(250); h.reply(250); }
      h.owner(250); // the current message
      const window = selectHistoryWindow(h.newestFirst(), options());
      // 200 rows reach exactly 50,000; the 200th is a reply, so its question (250) is added within the slack.
      expect(window.contiguousRows).toBe(201);
      expect(window.tokens).toBe(50_250);
      expect(window.rows[0].role).toBe('user');
      expect(window.rows.at(-1)!.id).toBe(h.rows.at(-1)!.id);
      expect(inOrder(h.rows, window.rows)).toBe(true);
      expect(window).toMatchObject({ pinnedRows: 0, omittedBetween: false, ownerMessages: 101 });
    });

    it('far more than the old window: 20 rows were about 5K tokens, 50K holds about ten times as much', () => {
      const h = history();
      for (let i = 0; i < 300; i += 1) { h.owner(250); h.reply(250); }
      expect(selectHistoryWindow(h.newestFirst(), options()).rows.length).toBeGreaterThan(CHAT_HISTORY_FLOOR_ROWS * 9);
    });

    it('always keeps the 20 newest, even when they alone exceed the budget, and adds nothing past them', () => {
      const h = history();
      for (let i = 0; i < 13; i += 1) { h.owner(10_000); h.reply(10_000); }
      const window = selectHistoryWindow(h.newestFirst(), options());
      expect(window.contiguousRows).toBe(20);
      expect(window.tokens).toBe(200_000);
      expect(ids(window.rows)).toEqual(ids(h.rows.slice(-20)));
    });

    it('stops at the first message that does not fit, so there is no hole in it', () => {
      const h = history();
      for (let i = 0; i < 40; i += 1) { h.owner(100); h.reply(100); }
      const big = h.reply(49_900); // a long report in the middle
      for (let i = 0; i < 15; i += 1) { h.owner(100); h.reply(100); }
      const window = selectHistoryWindow(h.newestFirst(), options({ ownerMessages: 0 }));
      expect(window.contiguousRows).toBe(30);
      expect(ids(window.rows)).not.toContain(big.id);
      expect(ids(window.rows)).toEqual(ids(h.rows.slice(-30)));
    });

    it('starts at the question its first reply answered, unless that question is long', () => {
      // The newest message (1,000) and a long reply (48,000) fill 49,000; the question before the reply (1,500) goes past the
      // budget but within the slack, so the window starts at the question instead of an answer with nothing before it.
      const small = history();
      small.owner(1_500, 'the question'); small.reply(48_000); small.owner(1_000);
      const window = selectHistoryWindow(small.newestFirst(), options({ floorRows: 1, ownerMessages: 0 }));
      expect(ids(window.rows)).toEqual(ids(small.rows));
      expect(window.tokens).toBe(50_500);

      // A question longer than the slack allows is not added: the window starts at the reply, as the old window often did.
      const long = history();
      long.owner(CHAT_HISTORY_BOUNDARY_SLACK_TOKENS + 1_001, 'a pasted document'); long.reply(48_000); long.owner(1_000);
      const capped = selectHistoryWindow(long.newestFirst(), options({ floorRows: 1, ownerMessages: 0 }));
      expect(ids(capped.rows)).toEqual(ids(long.rows.slice(1)));
      expect(capped.rows[0].role).toBe('assistant');

      // Nothing is added when the window already reaches the start of the session.
      const whole = history();
      whole.reply(10); whole.owner(100); whole.reply(100);
      expect(selectHistoryWindow(whole.newestFirst(), options({ floorRows: 1, ownerMessages: 0 })).rows.length).toBe(3);

      // Only a question is added. Two replies in a row happen (BotBoy posts a note between turns): the older one is not taken.
      const notes = history();
      // The earlier reply (1,500) misses the budget but would fit the slack: only its role keeps it out.
      notes.owner(100); notes.reply(1_500, 'an earlier reply'); notes.reply(48_000, 'a note BotBoy posted'); notes.owner(1_000);
      const afterNote = selectHistoryWindow(notes.newestFirst(), options({ floorRows: 1, ownerMessages: 0 }));
      expect(afterNote.rows.map(row => row.content)).toEqual(['a note BotBoy posted', notes.rows[3].content]);
    });

    it('keeps tool rows where they are in the newest stretch', () => {
      const h = history();
      h.owner(); h.reply(); h.tool(); h.owner();
      expect(selectHistoryWindow(h.newestFirst(), options()).rows.map(row => row.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    });

    it('an empty session gives an empty window', () => {
      expect(selectHistoryWindow([], options())).toEqual({ rows: [], contiguousRows: 0, pinnedRows: 0, tokens: 0, ownerMessages: 0, omittedBetween: false });
    });
  });

  describe('the owner\'s own messages (the job incident)', () => {
    /** 30 of the owner's exchanges, then a long automatic job, then the owner's newest message. */
    function longJob(automaticExchanges = 120) {
      const h = history();
      const owners: HistoryRow[] = [];
      for (let i = 0; i < 30; i += 1) { owners.push(h.owner(25, `owner message ${i}`)); h.reply(50); }
      for (let i = 0; i < automaticExchanges; i += 1) { h.automatic(100); h.reply(1_000); }
      owners.push(h.owner(25, 'the newest instruction'));
      return { h, owners };
    }

    it('keeps the owner\'s last 15 messages, each with its reply, however long the job ran in between', () => {
      const { h, owners } = longJob();
      const window = selectHistoryWindow(h.newestFirst(), options({ budgetTokens: 10_000, pinBudgetTokens: 2_500 }));
      const sent = ids(window.rows);
      for (const kept of owners.slice(-15)) expect(sent, kept.content!).toContain(kept.id);
      expect(sent).not.toContain(owners.at(-16)!.id);
      expect(window.ownerMessages).toBe(15);
      expect(window.pinnedRows).toBe(28); // 14 older owner messages and their replies
      expect(window.omittedBetween).toBe(true);
      // Kept in order, each older owner message followed by its reply, and no automatic trigger among them.
      expect(inOrder(h.rows, window.rows)).toBe(true);
      const pinned = window.rows.slice(0, window.pinnedRows);
      pinned.forEach((row, index) => expect(row.role).toBe(index % 2 === 0 ? 'user' : 'assistant'));
      expect(pinned.some(isAutomatic)).toBe(false);
      for (let index = 0; index < pinned.length; index += 2) expect(h.rows[h.rows.indexOf(pinned[index]) + 1]).toBe(pinned[index + 1]);
    });

    it('a continuation trigger is never counted or kept as one of the owner\'s messages', () => {
      const h = history();
      for (let i = 0; i < 40; i += 1) { h.automatic(10); h.reply(10); }
      h.owner(10, 'the only message the owner wrote');
      const window = selectHistoryWindow(h.newestFirst(), options());
      expect(window.ownerMessages).toBe(1);
      expect(window.pinnedRows).toBe(0);
    });

    it('needs nothing extra when the window already holds 15 of the owner\'s messages', () => {
      const { h } = longJob(3);
      const window = selectHistoryWindow(h.newestFirst(), options());
      expect(window.pinnedRows).toBe(0);
      expect(window.omittedBetween).toBe(false);
    });

    it('older owner messages take at most their own budget, newest first', () => {
      const h = history();
      for (let i = 0; i < 5; i += 1) { h.owner(5_000, `big ${i}`); h.reply(1_000); }
      for (let i = 0; i < 60; i += 1) { h.automatic(100); h.reply(1_000); }
      h.owner(25, 'now');
      const window = selectHistoryWindow(h.newestFirst(), options({ budgetTokens: 10_000, pinBudgetTokens: 12_500 }));
      // 6,000 per pair: two fit in 12,500; the third does not, so it stops there.
      expect(window.pinnedRows).toBe(4);
      expect(window.rows.slice(0, 4).map(row => row.content)).toEqual(['big 3', 'assistant 8', 'big 4', 'assistant 10']);
      expect(window.ownerMessages).toBe(3);
    });

    it('stops at the first older message that does not fit: never an older small one in place of a newer long one', () => {
      const h = history();
      h.owner(25, 'an old, short message'); h.reply(25);
      h.owner(20_000, 'a newer, very long message'); h.reply(100);
      for (let i = 0; i < 60; i += 1) { h.automatic(100); h.reply(1_000); }
      h.owner(25, 'now');
      const window = selectHistoryWindow(h.newestFirst(), options({ budgetTokens: 10_000, pinBudgetTokens: 12_500 }));
      expect(window.pinnedRows).toBe(0);
      expect(window.rows.map(row => row.content)).not.toContain('an old, short message');
    });

    it('an owner message right before the window comes without a copy of its reply, and leaves no gap', () => {
      const h = history();
      const old = h.owner(2_500, 'an older, long instruction');
      const answer = h.reply(100);
      const now = h.owner(100);
      const window = selectHistoryWindow(h.newestFirst(), options({ budgetTokens: 300, floorRows: 2, pinBudgetTokens: 3_000 }));
      expect(ids(window.rows)).toEqual([old.id, answer.id, now.id]);
      expect(window).toMatchObject({ contiguousRows: 2, pinnedRows: 1, omittedBetween: false, ownerMessages: 2 });
    });

    it('never sends a row twice', () => {
      const { h } = longJob();
      const window = selectHistoryWindow(h.newestFirst(), options({ budgetTokens: 10_000, pinBudgetTokens: 2_500 }));
      expect(new Set(ids(window.rows)).size).toBe(window.rows.length);
      expect(window.rows.length).toBe(window.contiguousRows + window.pinnedRows);
    });
  });
});
