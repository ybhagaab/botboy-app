/**
 * The chat history a turn sends word for word (docs/maps/chat-agent.md › "Chat history window").
 *
 * Owner job: BotBoy keeps the recent conversation in mind, and the owner's own instructions are not pushed out by its automatic
 * continuation turns. Owner decisions 2026-10-19: size the window by tokens, up to 50K; always keep the owner's own messages.
 *
 * Knowledge (Runtime Context): a chat turn sends the system prompt (with the rolling summary of everything older), then this window,
 * then the turn's own tool work. Until 2026-10-19 the window was the newest 20 stored messages, a size chosen for the old 32K-token
 * model. On today's 1M-token models those 20 messages were about 3% of a prompt, and during a job BotBoy's own continuation triggers
 * took most of them (7 of the 10 user messages in the owner's prompt that day), so the owner's corrections fell out after about three
 * of their own messages and lived on only as the summary's paraphrase.
 *
 * The window, newest first:
 *  1. the newest `floorRows` messages always, whatever their size (the old window);
 *  2. then older messages while the total stays within `budgetTokens`, stopping at the first that does not fit, so the window has no
 *     holes;
 *  3. it starts at a user message when the one just before is small, so the model sees what the first reply answered;
 *  4. the owner's own last `ownerMessages` messages are always there: older ones the window missed are added, each with the reply right
 *     after it, within `pinBudgetTokens`, newest owner message first. A continuation trigger is BotBoy's text, never the owner's, and is
 *     never kept this way. The automatic turns between kept messages are left out; the summary covers them.
 * Token counts are BotBoy's own estimate (4 characters a token, the stored `token_count`), which runs above the provider's own count.
 */

/** The most the window holds, by BotBoy's count (owner decision 2026-10-19). */
export const CHAT_HISTORY_MAX_TOKENS = 50_000;
/** The newest messages always sent: the old window. */
export const CHAT_HISTORY_FLOOR_ROWS = 20;
/** The owner's own messages always sent word for word, however many automatic turns ran in between. */
export const CHAT_HISTORY_OWNER_MESSAGES = 15;
/** The window takes at most a tenth of the model's context window: a 200K model keeps 20K, a 32K model about the old 20 messages. */
const WINDOW_SHARE = 10;
/** The owner's older messages kept beyond the window take at most a quarter of its budget. */
const PIN_SHARE = 4;
/** A user message at the start of the window is added past the budget only up to this size. */
export const CHAT_HISTORY_BOUNDARY_SLACK_TOKENS = 2_000;

export interface HistoryRow {
  id: string;
  role: string;
  content: string | null;
  /** BotBoy's estimate for the row (the stored `token_count`). */
  tokens: number;
  toolCallId?: string;
}

export interface HistoryWindowOptions {
  /** The window grows past the floor up to this many tokens. */
  budgetTokens: number;
  /** The newest rows always kept. */
  floorRows: number;
  /** The owner's own messages always kept. */
  ownerMessages: number;
  /** The most tokens the owner's older messages (and their replies) may add beyond the window. */
  pinBudgetTokens: number;
  /** A user row BotBoy wrote itself (a continuation trigger): never counted or kept as the owner's. */
  isAutomatic: (row: HistoryRow) => boolean;
}

export interface HistoryWindow {
  /** Oldest first, ready to send. */
  rows: HistoryRow[];
  /** Rows of the unbroken newest stretch. */
  contiguousRows: number;
  /** Older rows kept for the owner's messages (each message and its reply). */
  pinnedRows: number;
  tokens: number;
  /** Owner messages in `rows`. */
  ownerMessages: number;
  /** True when some rows between kept ones were left out (only the summary has them). */
  omittedBetween: boolean;
}

/** The window's token budget for a model with this context window: a tenth of it, at most 50K. Unknown windows get the floor only. */
export function chatHistoryBudgetTokens(contextWindowTokens: number): number {
  const window = Number.isFinite(contextWindowTokens) && contextWindowTokens > 0 ? contextWindowTokens : 0;
  return Math.min(CHAT_HISTORY_MAX_TOKENS, Math.floor(window / WINDOW_SHARE));
}

/** The options a chat turn uses, from its model's context window. */
export function chatHistoryWindowOptions(contextWindowTokens: number, isAutomatic: HistoryWindowOptions['isAutomatic']): HistoryWindowOptions {
  const budgetTokens = chatHistoryBudgetTokens(contextWindowTokens);
  return {
    budgetTokens,
    floorRows: CHAT_HISTORY_FLOOR_ROWS,
    ownerMessages: CHAT_HISTORY_OWNER_MESSAGES,
    pinBudgetTokens: Math.floor(budgetTokens / PIN_SHARE),
    isAutomatic,
  };
}

const sizeOf = (row: HistoryRow): number => {
  const tokens = Number(row.tokens);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
};

/** Picks the rows to send from the session's rows, NEWEST FIRST. Pure: the same rows and options give the same window. */
export function selectHistoryWindow(newestFirst: readonly HistoryRow[], options: HistoryWindowOptions): HistoryWindow {
  const isOwner = (row: HistoryRow): boolean => row.role === 'user' && !options.isAutomatic(row);

  // 1 and 2: the unbroken newest stretch, rows [0, end).
  let end = 0;
  let tokens = 0;
  while (end < newestFirst.length) {
    const cost = sizeOf(newestFirst[end]);
    if (end >= options.floorRows && tokens + cost > options.budgetTokens) break;
    tokens += cost;
    end += 1;
  }

  // 3: start at a user message when the one just before the window is small.
  if (end > 0 && end < newestFirst.length && newestFirst[end - 1].role === 'assistant' && newestFirst[end].role === 'user'
    && tokens + sizeOf(newestFirst[end]) <= options.budgetTokens + CHAT_HISTORY_BOUNDARY_SLACK_TOKENS) {
    tokens += sizeOf(newestFirst[end]);
    end += 1;
  }

  let owners = 0;
  for (let index = 0; index < end; index += 1) if (isOwner(newestFirst[index])) owners += 1;

  // 4: the owner's older messages the window missed, newest first, each with the reply right after it.
  const pinned = new Set<number>();
  let pinTokens = 0;
  for (let index = end; index < newestFirst.length && owners < options.ownerMessages; index += 1) {
    const row = newestFirst[index];
    if (!isOwner(row)) continue;
    // The reply is the next newer row. Right before the window that row is already in it.
    const replyIndex = index - 1;
    const reply = replyIndex >= end && newestFirst[replyIndex].role === 'assistant' ? replyIndex : -1;
    const cost = sizeOf(row) + (reply >= 0 ? sizeOf(newestFirst[reply]) : 0);
    if (pinTokens + cost > options.pinBudgetTokens) break;
    pinned.add(index);
    if (reply >= 0) pinned.add(reply);
    pinTokens += cost;
    owners += 1;
  }

  const pinnedOldestFirst = [...pinned].sort((a, b) => b - a);
  let omittedBetween = false;
  if (pinnedOldestFirst.length) {
    for (let index = end; index <= pinnedOldestFirst[0]; index += 1) {
      if (!pinned.has(index)) { omittedBetween = true; break; }
    }
  }
  const rows = [
    ...pinnedOldestFirst.map(index => newestFirst[index]),
    ...newestFirst.slice(0, end).reverse(),
  ];
  return { rows, contiguousRows: end, pinnedRows: pinned.size, tokens: tokens + pinTokens, ownerMessages: owners, omittedBetween };
}

/** The line the system prompt gets when automatic turns between kept messages were left out. */
export const CHAT_HISTORY_OMITTED_NOTE = 'Some automatic continuation turns between the owner\'s older messages below are left out to save space; the Conversation Summary covers them, and get_chat_messages returns any range in full.';
