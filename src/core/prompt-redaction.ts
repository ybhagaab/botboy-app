/**
 * Shared last-mile redaction for untrusted evidence before it enters a model
 * prompt. Keep this boundary centralized: drift between routing/synthesis
 * prompts can otherwise expose bearer/query credentials in one lane.
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/((?:id_token|access_token|refresh_token|samlresponse|token|code|state)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_TOKEN]');
}
