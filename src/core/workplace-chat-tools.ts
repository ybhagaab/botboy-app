/**
 * Settings → Workplace in chat (design §8.4, §10.4).
 *
 * Defense in depth for the per-turn tool filter in prompt-manager.ts: the
 * prompt is built once per turn while the Amazon Employee toggle can change
 * mid-turn, so an Amazon-only tool (or a dataset plan with an ETL source)
 * called while OFF gets one structured refusal with no effect. Also owns
 * the `export_footer` chat tool (get for anyone; set only in the owner's own
 * live turn, the gmail-chat-tools authority shape).
 */
import type { ToolCall } from './llm-client.js';
import type { ToolExecutionContext, ToolExecutor, ToolResult } from './tool-executor.js';
import { amazonEmployeeOffToolResult, isAmazonOnlyChatTool, type Workplace } from './workplace.js';
import { ExportFooterError, type ExportFooterSettings } from '../product-manager/export-footer.js';

const APPLIES_TO = ['pdf', 'docx', 'html (printed)'] as const;

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function reply(call: ToolCall, body: Record<string, unknown>, isError: boolean): ToolResult {
  return { toolCallId: call.id, content: JSON.stringify(body), isError };
}

/**
 * True only for a confirmed `export_footer` set. chat.ts counts it as a
 * write for the action-integrity gate; get and refusals never count.
 */
export function exportFooterSetConfirmed(resultContent: string): boolean {
  try {
    const parsed = JSON.parse(resultContent);
    return parsed?.ok === true && parsed?.action === 'set';
  } catch {
    return false;
  }
}

export function withWorkplaceChatTools(base: ToolExecutor, deps: {
  workplace?: Pick<Workplace, 'amazonEmployee'>;
  exportFooter?: ExportFooterSettings;
}): ToolExecutor {
  const amazon = () => deps.workplace?.amazonEmployee() !== false;

  function exportFooter(call: ToolCall, context?: ToolExecutionContext): ToolResult {
    const args = parseArgs(call);
    if (!deps.exportFooter) {
      return reply(call, { ok: false, code: 'unavailable', effect: 'none', nextAction: 'Tell the owner the footer can be changed in Settings → Workplace.' }, true);
    }
    if (args.action === 'get') {
      return reply(call, { ok: true, footer: deps.exportFooter.status(), appliesTo: APPLIES_TO, settingsPath: '#/settings/workplace' }, false);
    }
    if (args.action !== 'set') {
      return reply(call, { ok: false, code: 'invalid_request', effect: 'none', nextAction: 'Use action "get" or "set".' }, true);
    }
    const liveTurn = context?.callerKind === 'interactive' && Boolean(context?.currentUserMessage?.trim());
    if (!liveTurn || !context?.ownerRequestId?.trim() || args.ownerRequested !== true) {
      return reply(call, {
        ok: false,
        code: 'owner_request_required',
        effect: 'none',
        nextAction: 'Set the footer only when the owner asks in this message; otherwise tell them they can change it in Settings → Workplace.',
      }, true);
    }
    const previous = deps.exportFooter.status();
    try {
      const footer = deps.exportFooter.set(args.text, 'chat');
      return reply(call, {
        ok: true,
        action: 'set',
        footer: { text: footer.text, source: footer.source },
        previous: { text: previous.text, source: previous.source },
        appliesTo: APPLIES_TO,
        effect: 'future_exports',
      }, false);
    } catch (error) {
      if (error instanceof ExportFooterError) {
        return reply(call, { ok: false, code: error.code, effect: 'none', message: error.message, nextAction: error.nextAction }, true);
      }
      throw error;
    }
  }

  return {
    async executeTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
      const name = call.function.name;
      if (name === 'export_footer') return exportFooter(call, context);
      if (!amazon()) {
        if (isAmazonOnlyChatTool(name)) return reply(call, { ...amazonEmployeeOffToolResult(name) }, true);
        if (name === 'create_data_room_dataset') {
          const args = parseArgs(call);
          const sources = (args.plan as { sources?: unknown } | undefined)?.sources;
          if (args.action === 'create' && Array.isArray(sources)
            && sources.some(source => (source as { kind?: unknown } | null)?.kind === 'etl_query')) {
            return reply(call, {
              ...amazonEmployeeOffToolResult(name),
              message: 'ETL sources are part of Amazon internal paths, which are off on this install.',
              nextAction: 'Use a local_file, sql_query, Import Inbox, or existing-version source instead.',
            }, true);
          }
        }
      }
      return base.executeTool(call, context);
    },
  };
}
