/**
 * Narrow LLM interface used by the interpretation passes (librarian,
 * brain-updater, reconciler). Keeping it small makes the passes trivial to
 * unit-test with a mock and lets us adapt any concrete client
 * (llm-client / acp-client) behind it.
 */

export interface PipelineLlmAuditMetadata {
  provider?: string;
  model?: string;
  temperature?: number;
  activeEndpoint?: string;
}

export interface PipelineLlm {
  /** Whether the remote model is reachable right now. */
  isAvailable(): boolean;
  /** Single-shot completion; returns the model's text content. */
  complete(prompt: string): Promise<string>;
  /**
   * Maximum model-input budget available to an interpretation call. Optional
   * so focused test doubles remain tiny; production adapters expose the value
   * from the active inference client.
   */
  getContextBudgetTokens?(): number;
  /** Runtime identity persisted with interpretation decisions when available. */
  auditMetadata?(): PipelineLlmAuditMetadata;
}

/** Adapt an object exposing `isAvailable()` + `sendPrompt()` (the existing
 * LlmClient / AcpClient shape) to `PipelineLlm`. Static provider/model details
 * come from the composition root; activeEndpoint is sampled for every audit so
 * a configured local fallback is visible after a request. */
export function adaptSendPrompt(
  client: {
    isAvailable(): boolean;
    sendPrompt(prompt: string): Promise<{ content: string }>;
    getActiveEndpoint?(): string;
    getActiveModel?(): string | undefined;
    getContextBudgetTokens?(): number;
  },
  metadata: PipelineLlmAuditMetadata = {},
): PipelineLlm {
  return {
    isAvailable: () => client.isAvailable(),
    complete: async (prompt: string) => (await client.sendPrompt(prompt)).content,
    getContextBudgetTokens: () => client.getContextBudgetTokens?.() ?? 16_000,
    auditMetadata: () => {
      const activeEndpoint = client.getActiveEndpoint?.() ?? metadata.activeEndpoint;
      return {
        ...metadata,
        provider: activeEndpoint === 'ollama' ? 'ollama' : metadata.provider,
        model: client.getActiveModel?.() ?? metadata.model,
        activeEndpoint,
      };
    },
  };
}

/** Extract the first JSON value (array or object) from an LLM response that may
 *  wrap it in prose or markdown fences. Returns null if none parses. */
export function extractJson<T = unknown>(text: string): T | null {
  const s = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  // 1) The whole response is often exactly JSON.
  try {
    return JSON.parse(s) as T;
  } catch {
    /* fall through */
  }

  // 2) Otherwise extract the OUTERMOST bracketed value — whichever of '{' or '['
  //    appears first, matched greedily to its last matching close. Trying the
  //    first-occurring bracket avoids grabbing an inner array out of an object.
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  const order: ('obj' | 'arr')[] =
    firstArr === -1 ? ['obj'] :
    firstObj === -1 ? ['arr'] :
    firstObj < firstArr ? ['obj', 'arr'] : ['arr', 'obj'];

  for (const kind of order) {
    const m = kind === 'obj' ? s.match(/\{[\s\S]*\}/) : s.match(/\[[\s\S]*\]/);
    if (m) {
      try {
        return JSON.parse(m[0]) as T;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}
