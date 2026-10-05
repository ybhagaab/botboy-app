/**
 * The SharePoint MCP (AmazonSharePointMCP 1.0.7519+) adds its own text blocks
 * before a tool's payload:
 *
 *   - a rate-limit warning when the server nears its call budget
 *     ("⚠️ Rate limit: held request …" / "⚠️ Approaching SharePoint rate
 *     limit: …"), and
 *   - for tools that return other people's text (list_shared_with_me,
 *     read_file, read_loop, read_docx_comments, list_item_comments, read_page,
 *     search), a trust notice from `=== UNTRUSTED CONTENT BOUNDARY ===` to
 *     `=== END NOTICE, UNTRUSTED CONTENT FOLLOWS ===`.
 *
 * `mcp-manager` joins content blocks with a blank line, so these arrive as a
 * prefix of `result.text`. BotBoy's own consumers parse, hash, or capture the
 * payload and must read it without them; otherwise discovery JSON fails to
 * parse and captured documents would start with the notice. The chat agent's
 * generic `mcp_call_tool` keeps the full text, notice included.
 */

export interface SharePointToolText {
  payload: string;
  rateLimitWarnings: string[];
  hadUntrustedNotice: boolean;
}

const BLOCK_SEPARATOR = '\n\n';
const NOTICE_START = '=== UNTRUSTED CONTENT BOUNDARY ===';
const NOTICE_END = '=== END NOTICE, UNTRUSTED CONTENT FOLLOWS ===';
const RATE_LIMIT_PREFIXES = ['⚠️ Rate limit:', '⚠️ Approaching SharePoint rate limit:'];

/** Remove the server's leading warning/notice blocks; the payload is untouched. */
export function splitSharePointToolText(text: string): SharePointToolText {
  let rest = text;
  const rateLimitWarnings: string[] = [];
  let hadUntrustedNotice = false;
  for (;;) {
    if (RATE_LIMIT_PREFIXES.some((prefix) => rest.startsWith(prefix))) {
      const end = rest.indexOf(BLOCK_SEPARATOR);
      rateLimitWarnings.push((end >= 0 ? rest.slice(0, end) : rest).trim());
      rest = end >= 0 ? rest.slice(end + BLOCK_SEPARATOR.length) : '';
      continue;
    }
    if (rest.startsWith(NOTICE_START)) {
      hadUntrustedNotice = true;
      const end = rest.indexOf(NOTICE_END);
      if (end >= 0) {
        rest = rest.slice(end + NOTICE_END.length);
        if (rest.startsWith(BLOCK_SEPARATOR)) rest = rest.slice(BLOCK_SEPARATOR.length);
        else if (rest.startsWith('\n')) rest = rest.slice(1);
      } else {
        // Unterminated (a future wording): the notice is one block with no
        // blank line inside, so it ends at the first block separator.
        const gap = rest.indexOf(BLOCK_SEPARATOR);
        rest = gap >= 0 ? rest.slice(gap + BLOCK_SEPARATOR.length) : '';
      }
      continue;
    }
    return { payload: rest, rateLimitWarnings, hadUntrustedNotice };
  }
}

/** The tool payload without the server's leading warning/notice blocks. */
export function sharePointToolPayload(text: string): string {
  return splitSharePointToolText(text).payload;
}
