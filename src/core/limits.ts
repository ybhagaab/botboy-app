import {
  defaultInferenceMaxContextTokens,
  resolveInferenceProviderId,
} from './inference-provider.js';

/**
 * Shared runtime limits that depend on the active model's context window.
 *
 * Kept in its own module so both the tool executor (which enforces the limit)
 * and the prompt manager (which advertises it to the model) read the SAME
 * number — a mismatch between the two is how models end up making calls the
 * server rejects.
 */

/** Context window of the active provider (product setting, then legacy alias). */
export function endpointContextTokens(): number {
  const configured = process.env.BOTBOY_INFERENCE_MAX_CONTEXT_TOKENS
    ?? process.env.VLLM_MAX_CONTEXT_TOKENS;
  const parsed = parseInt(configured || '', 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return defaultInferenceMaxContextTokens(resolveInferenceProviderId());
}

/** True when the model has a large (100K+) context window. */
export function isLargeContext(): boolean {
  return endpointContextTokens() >= 100_000;
}

/**
 * Max `content` chars accepted by a single write_file call.
 *
 * The cap exists so a tool call replayed in conversation history can't blow
 * the context window. It was hard-coded at 8000 for the 32K Qwen deployment;
 * Kimi's 262K window safely supports 40000-character calls, reducing needless
 * chunk turns while the chat loop still shrinks completed write arguments
 * before replay (post-mortem 2026-08-05). Override with PPT_WRITE_FILE_MAX_CHARS.
 */
export function writeFileMaxChars(): number {
  const override = parseInt(process.env.PPT_WRITE_FILE_MAX_CHARS || '', 10);
  if (Number.isFinite(override) && override > 0) return override;
  return isLargeContext() ? 40_000 : 8_000;
}
