import { redactSecrets } from './sensitive-files.js';

/**
 * Shared last-mile redaction for untrusted evidence before it enters a model
 * prompt. Keep this boundary centralized: drift between routing/synthesis
 * prompts can otherwise expose bearer/query credentials in one lane.
 *
 * Query credentials and JWTs first (unchanged), then the secret formats in
 * `sensitive-files.ts`: private keys, provider tokens, AWS keys,
 * credential-shaped assignments, Authorization headers, and URL passwords.
 */
export function redactSensitiveText(value: string): string {
  return redactSecrets(value
    .replace(/((?:id_token|access_token|refresh_token|samlresponse|token|code|state)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_TOKEN]'));
}
