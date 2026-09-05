/**
 * LLM prompt log — every request body that leaves for an LLM endpoint,
 * complete and unmodified, written locally as ONE FILE PAIR PER REQUEST.
 *
 * Why: debugging prompt behavior needs the EXACT wire payload (system prompt,
 * full message history, tool definitions, sampling params) — not a truncated
 * console line. The console log stays lean; these files are the source of
 * truth, browsable directly in Finder or an editor.
 *
 * Location: ~/.personal-productivity-tracker/logs/llm-prompts/
 *   <local date>_<local time>_<apiMode>[-stream]_<suffix>.md    ← readable
 *   <local date>_<local time>_<apiMode>[-stream]_<suffix>.json  ← exact wire payload
 *   Example: 2026-08-20_13-00-54-148_responses_90z9.md
 *
 * The Markdown twin renders the same content with real newlines: metadata
 * header, the full system prompt verbatim, every conversation turn as its own
 * section, tool names plus full definitions, and the remaining params.
 * Auth headers are NEVER logged; bodies carry no credentials.
 *
 * Retention: files older than 7 days (mtime) are pruned once per process start.
 * Toggle: on by default; set BOTBOY_LLM_PROMPT_LOG=0 to disable.
 * Failure policy: logging is fire-and-forget and can never break a request.
 */

import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

const LOG_DIR = path.join(os.homedir(), '.personal-productivity-tracker', 'logs', 'llm-prompts');
const RETENTION_DAYS = 7;

function enabled(): boolean {
  return process.env.BOTBOY_LLM_PROMPT_LOG !== '0';
}

/** Absolute directory the prompt log writes into (for docs/diagnostics). */
export function llmPromptLogDir(): string {
  return LOG_DIR;
}

let prunedThisBoot = false;

async function pruneOldFiles(): Promise<void> {
  if (prunedThisBoot) return;
  prunedThisBoot = true;
  try {
    const entries = await fsp.readdir(LOG_DIR);
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of entries) {
      if (!name.endsWith('.json') && !name.endsWith('.jsonl') && !name.endsWith('.md')) continue;
      const full = path.join(LOG_DIR, name);
      try {
        const st = await fsp.stat(full);
        if (st.mtimeMs < cutoff) await fsp.unlink(full);
      } catch {
        // Racing deletes are fine.
      }
    }
  } catch {
    // Directory may not exist yet — created on first write.
  }
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local-time file stem: 2026-08-20_12-37-01-964 */
function localStamp(d: Date): string {
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}` +
    `_${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}` +
    `-${String(d.getMilliseconds()).padStart(3, '0')}`
  );
}

export interface LlmPromptLogEntry {
  url: string;
  model: string;
  apiMode: string;
  stream: boolean;
  /** The exact request body object (already serialized once for the wire). */
  request: unknown;
}

// ── Markdown rendering ───────────────────────────────────────────────────────

/** One message/turn content as readable text; structured parts pretty-printed. */
function renderContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') return p.text;
          return '```json\n' + JSON.stringify(p, null, 2) + '\n```';
        }
        return String(part);
      })
      .join('\n');
  }
  if (content == null) return '';
  return '```json\n' + JSON.stringify(content, null, 2) + '\n```';
}

/** Render one input/messages item (works for Responses and chat-completions shapes). */
function renderTurn(item: Record<string, unknown>, index: number): string {
  const role = typeof item.role === 'string' ? item.role : (typeof item.type === 'string' ? item.type : 'item');
  const lines: string[] = [`### [${index}] ${role}`];
  if ('content' in item) lines.push(renderContent(item.content));
  // Anything beyond role/content (tool_calls, function call payloads, ids)
  // still matters for debugging — show it structured, not lost.
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (k !== 'role' && k !== 'content' && k !== 'type') rest[k] = v;
  }
  if (Object.keys(rest).length > 0) {
    lines.push('```json\n' + JSON.stringify(rest, null, 2) + '\n```');
  }
  return lines.join('\n\n');
}

function renderMarkdown(ts: Date, entry: LlmPromptLogEntry, bodyChars: number): string {
  const req = (entry.request ?? {}) as Record<string, unknown>;
  const parts: string[] = [];

  parts.push(`# LLM request — ${ts.toISOString()}`);
  parts.push(
    [
      `- **url**: ${entry.url}`,
      `- **model**: ${entry.model}`,
      `- **apiMode**: ${entry.apiMode}${entry.stream ? ' (streaming)' : ''}`,
      `- **bodyChars**: ${bodyChars.toLocaleString()}`,
    ].join('\n'),
  );

  // System prompt: Responses API carries it in `instructions`; chat-completions
  // as a system-role message (rendered with the turns below).
  if (typeof req.instructions === 'string') {
    parts.push('## Instructions (system prompt)\n\n' + req.instructions);
  }

  const turns = (Array.isArray(req.input) ? req.input : Array.isArray(req.messages) ? req.messages : []) as unknown[];
  if (turns.length > 0) {
    parts.push('## Conversation input (' + turns.length + ' items)');
    turns.forEach((t, i) => {
      if (t && typeof t === 'object') parts.push(renderTurn(t as Record<string, unknown>, i));
      else parts.push(`### [${i}]\n\n${String(t)}`);
    });
  }

  const tools = Array.isArray(req.tools) ? (req.tools as Record<string, unknown>[]) : [];
  if (tools.length > 0) {
    const names = tools
      .map((t) => {
        const fn = (t.function ?? t) as Record<string, unknown>;
        return typeof fn.name === 'string' ? fn.name : '(unnamed)';
      })
      .join(', ');
    parts.push(`## Tools (${tools.length})\n\n${names}\n\n\`\`\`json\n${JSON.stringify(tools, null, 2)}\n\`\`\``);
  }

  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req)) {
    if (!['instructions', 'input', 'messages', 'tools'].includes(k)) rest[k] = v;
  }
  if (Object.keys(rest).length > 0) {
    parts.push('## Other params\n\n```json\n' + JSON.stringify(rest, null, 2) + '\n```');
  }

  return parts.join('\n\n') + '\n';
}

// ── Writer ───────────────────────────────────────────────────────────────────

// Serialized writer chain: keeps directory creation + prune + writes ordered.
let writeChain: Promise<void> = Promise.resolve();

/**
 * Image data URLs (chat attachments) would bloat log files by megabytes per
 * request — elide the base64 payload, keep the shape and size visible.
 */
export function elideImageDataUrls<T>(request: T): T {
  try {
    const json = JSON.stringify(request);
    if (!json.includes('data:image/')) return request;
    return JSON.parse(json.replace(
      /data:image\/[a-z]+;base64,([A-Za-z0-9+/=]{64})[A-Za-z0-9+/=]*/g,
      (match, head) => `data:image-elided (${match.length} chars, starts ${head.slice(0, 24)}…)`,
    ));
  } catch {
    return request;
  }
}

/** Fire-and-forget: never throws, never blocks the request path. */
export function logLlmPrompt(rawEntry: LlmPromptLogEntry): void {
  if (!enabled()) return;
  const entry: LlmPromptLogEntry = { ...rawEntry, request: elideImageDataUrls(rawEntry.request) };
  const now = new Date();
  // Millisecond stamps can collide when pipeline calls fire together — a
  // short random suffix keeps every request its own file.
  const suffix = Math.random().toString(36).slice(2, 6);
  const stem = `${localStamp(now)}_${entry.apiMode}${entry.stream ? '-stream' : ''}_${suffix}`;
  const bodyChars = JSON.stringify(rawEntry.request).length;
  const jsonPayload = JSON.stringify(
    {
      ts: now.toISOString(),
      url: entry.url,
      model: entry.model,
      apiMode: entry.apiMode,
      stream: entry.stream,
      bodyChars,
      request: entry.request,
    },
    null,
    2,
  );
  let mdPayload: string;
  try {
    mdPayload = renderMarkdown(now, entry, bodyChars);
  } catch {
    mdPayload = `# LLM request — ${now.toISOString()}\n\n(markdown rendering failed — see the .json twin)\n`;
  }
  writeChain = writeChain
    .then(async () => {
      await fsp.mkdir(LOG_DIR, { recursive: true });
      await pruneOldFiles();
      await Promise.all([
        fsp.writeFile(path.join(LOG_DIR, `${stem}.json`), jsonPayload, 'utf-8'),
        fsp.writeFile(path.join(LOG_DIR, `${stem}.md`), mdPayload, 'utf-8'),
      ]);
    })
    .catch(() => {
      // Never let logging failures surface into the LLM call path.
    });
}
