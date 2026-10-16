/**
 * Themes in chat (docs/maps/ui-themes.md): BotBoy proposes a colour theme for its own UI, and the owner decides.
 *
 *   ui_theme_propose {name, mode, accent, background?} → stages a proposal; the reply carries the card marker `[[theme:th_…]]`
 *
 * The model chooses four small things. The server derives every colour, nudges any that would be hard to read, and re-checks the
 * result (ui-theme-engine.ts); a seed that cannot be made readable is refused with the closest readable colour. The tool only
 * STAGES: Preview, Keep and Discard are the owner's buttons on the card, and nothing changes the UI until Keep. There is no CSS,
 * no file write and no way to touch the layout.
 *
 * Authority: a live owner turn about the look of the app (`uiThemeTurn`, set by the chat route from the owner's message), never
 * a background or continuation run. It is not in job-mandate.ts, so a job cannot use it either. At most 5 proposals per request.
 */
import type { ToolCall } from './llm-client.js';
import type { ToolExecutionContext, ToolExecutor, ToolResult } from './tool-executor.js';
import type { UiThemes } from './ui-theme.js';

export const UI_THEME_CHAT_TOOL_NAMES = ['ui_theme_propose'] as const;
const MAX_PROPOSALS_PER_REQUEST = 5;

export const uiThemeCardMarker = (id: string): string => `[[theme:${id}]]`;
export const THEME_MARKER_RE = /\[\[theme:(th_[0-9a-f]{12})\]\]/g;

/** Prompt guidance, added only on turns where the tool is offered. */
export const UI_THEME_GUIDANCE_BLOCK = [
  '## Themes for the BotBoy UI',
  '- For a new look (a theme, a colour scheme, an accent colour, dark or light variants) call ui_theme_propose with a short name, mode "dark" or "light", an accent colour as a hex like "#2dd4bf", and optionally a background tint. The server derives every other colour and checks that text stays readable. Never recolour the UI by editing dashboard.css or any other file.',
  '- It only STAGES a proposal. You cannot apply it. Reply in a sentence or two about the look, and put the card marker from the result (for example [[theme:th_0123456789ab]]) on its own line: the owner presses Preview to try it, then Keep or Discard.',
  '- If the result says the accent or background cannot be made readable, call again once with the colours it suggests. If it refuses twice, tell the owner what is in the way. When the owner asks for changes to a theme you just proposed ("greener", "darker", "less purple"), call ui_theme_propose again with adjusted colours and a new name.',
  '- Several options at once are fine (at most 5 per request); each gets its own card. Saved themes live in Settings → Appearance, where the owner applies, renames and deletes them.',
  '- BotBoy already ships two palettes, BotBoy Dark and BotBoy Light. When the owner only wants dark or light mode, point to the sun or moon button in the top bar (or Settings → Appearance) instead of proposing a theme.',
].join('\n');

const THEME_WORDS = /\b(?:themes?|theming|palettes?|colou?r\s*(?:scheme|palette|theme)s?|dark\s*(?:mode|theme)|light\s*(?:mode|theme)|night\s*mode|accent(?:\s*colou?r)?|look\s*(?:and|&|n)\s*feel|restyle|re-?skin|appearance|skin)\b/i;
const COLOUR_WORD = /\bcolou?rs?\b/i;
const UI_WORD = /\b(?:ui|app|botboy|dashboard|interface|screen|sidebar|background|everything)\b/i;

/**
 * Whether the owner's message is about how BotBoy looks. A heuristic on purpose: it only decides whether the one tool is OFFERED
 * this turn (the tool is a staging step, so a wrong guess costs a card, never a change). A follow-up on a recent proposal is
 * covered separately by `UiThemes.hasRecentProposal`.
 */
export function asksAboutAppearance(message: string): boolean {
  const text = String(message ?? '');
  return THEME_WORDS.test(text) || (COLOUR_WORD.test(text) && UI_WORD.test(text));
}

function parseResult(content: unknown): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(content ?? ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The proposal a ui_theme_propose receipt names, or null (a refusal has none). */
export function uiThemeIdFromToolResult(toolName: string, content: unknown): string | null {
  if (toolName !== 'ui_theme_propose') return null;
  const id = parseResult(content)?.proposalId;
  return typeof id === 'string' && /^th_[0-9a-f]{12}$/.test(id) ? id : null;
}

/** Every proposal this turn staged gets its card: a missing `[[theme:th_…]]` marker is appended, so the owner can always decide. */
export function withUiThemeCards(content: string, proposalIds: Iterable<string>, themes: Pick<UiThemes, 'proposal'> | null | undefined): string {
  const ids = [...new Set(proposalIds)];
  if (ids.length === 0 || !themes) return content;
  const missing: string[] = [];
  for (const id of ids) {
    const proposal = themes.proposal(id);
    if (!proposal || proposal.status === 'discarded') continue;
    const marker = uiThemeCardMarker(id);
    if (!content.includes(marker)) missing.push(marker);
  }
  return missing.length ? `${content.trimEnd()}\n\n${missing.join('\n')}` : content;
}

function reply(call: ToolCall, content: unknown, isError = false): ToolResult {
  return { toolCallId: call.id, content: typeof content === 'string' ? content : JSON.stringify(content, null, 1), isError };
}
function failure(call: ToolCall, code: string, message: string, nextAction: string, extra?: Record<string, unknown>): ToolResult {
  return reply(call, { ok: false, tool: call.function.name, status: 'failed', code, message, effect: 'none', nextAction, ...(extra ?? {}) }, true);
}

export function withUiThemeChatTools(base: ToolExecutor, deps: { themes?: UiThemes }): ToolExecutor {
  // The per-request count of proposals. A Map keyed by the server's request id, trimmed so it cannot grow without bound.
  const perRequest = new Map<string, number>();

  return {
    ...base,
    async executeTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
      if (call.function.name !== 'ui_theme_propose') return base.executeTool(call, context);
      if (context?.callerKind !== 'interactive' || !context.currentUserMessage?.trim()) {
        return failure(call, 'owner_turn_required', 'Themes are proposed only in the owner’s own chat.', 'Do not propose a theme from background work. Tell the owner to ask in chat.');
      }
      if (context.uiThemeTurn !== true) {
        return failure(call, 'not_requested', 'The owner has not asked about how BotBoy looks in this message.', 'Answer the owner’s message without a theme. If they want a new look, they can ask for a theme.');
      }
      if (!deps.themes) {
        return failure(call, 'themes_unavailable', 'Themes are not available in this session.', 'Tell the owner themes cannot be made right now.');
      }
      let args: Record<string, unknown>;
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { return failure(call, 'invalid_arguments', 'Arguments must be one JSON object.', 'Fix the arguments, then call once more.'); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) return failure(call, 'invalid_arguments', 'Arguments must be one JSON object.', 'Fix the arguments, then call once more.');
      const allowed = new Set(['name', 'mode', 'accent', 'background']);
      const stray = Object.keys(args).filter((key) => !allowed.has(key));
      if (stray.length > 0) return failure(call, 'invalid_arguments', `${stray.slice(0, 3).join(', ')} is not an argument of ui_theme_propose.`, 'Send only name, mode, accent and optionally background. Every other colour is derived by the server.');

      const requestKey = context.ownerRequestId ?? '';
      if (requestKey) {
        const used = perRequest.get(requestKey) ?? 0;
        if (used >= MAX_PROPOSALS_PER_REQUEST) {
          return failure(call, 'too_many_proposals', `At most ${MAX_PROPOSALS_PER_REQUEST} themes can be proposed in one request.`, 'Stop proposing. Tell the owner which cards to look at.');
        }
      }
      const result = deps.themes.propose({ name: args.name, mode: args.mode, accent: args.accent, background: args.background });
      if (!result.ok) {
        return failure(call, result.code, result.message, result.nextAction, result.suggestion ? { suggestion: result.suggestion } : undefined);
      }
      if (requestKey && !result.value.existing) {
        perRequest.set(requestKey, (perRequest.get(requestKey) ?? 0) + 1);
        if (perRequest.size > 64) perRequest.delete(perRequest.keys().next().value as string);
      }
      const proposal = result.value.proposal;
      return reply(call, {
        ok: true,
        tool: 'ui_theme_propose',
        status: 'staged',
        effect: 'none',
        proposalId: proposal.id,
        existing: result.value.existing,
        name: proposal.name,
        mode: proposal.mode,
        accent: proposal.accent,
        background: proposal.background,
        swatch: proposal.swatch,
        readability: { checksPassed: proposal.checks.filter((check) => check.ok).length, checks: proposal.checks.length },
        adjustments: proposal.adjustments.map((adjustment) => ({ token: adjustment.token, from: adjustment.from, to: adjustment.to, reason: adjustment.reason })),
        card: uiThemeCardMarker(proposal.id),
        nextAction: `Put ${uiThemeCardMarker(proposal.id)} on its own line in your reply, with a sentence about the look${proposal.adjustments.length ? ` (mention that ${proposal.adjustments.map((adjustment) => adjustment.token).join(' and ')} was adjusted slightly so text stays readable)` : ''}. The owner presses Preview, then Keep or Discard. You cannot apply it.`,
      });
    },
  };
}
