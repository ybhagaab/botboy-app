/**
 * Sensitive local files: credentials, private keys, and API tokens stay on
 * this Mac. BotBoy never sends them to a model.
 *
 * Two deterministic, local layers:
 *
 *  1. `sensitiveLocalPathReason` uses the path, name, type, and size only. A
 *     match means BotBoy never opens the file: the folder monitor holds it
 *     before any read, and the extractor re-checks before parsing.
 *  2. `detectSecrets` looks for high-confidence secret formats in text BotBoy
 *     has already read locally (inline parse or extraction). A match means the
 *     text is never stored or sent; the file is held instead.
 *
 * `redactSecrets` replaces the same formats, plus broader secret-shaped
 * assignments, in any evidence bound for a model prompt
 * (`prompt-redaction.ts`). Every finding names the kind of secret, never its
 * value.
 */

import { lstatSync, realpathSync } from 'fs';
import path from 'path';

// ── Layer 1: path, name, type, size ────────────────────────────────────────

/** `.key` is also Apple Keynote's extension; private keys are a few KB. */
const KEY_EXTENSION_MAX_BYTES = 64 * 1024;

const CREDENTIAL_DIRECTORIES: ReadonlyMap<string, string> = new Map([
  ['.ssh', 'SSH keys'],
  ['.aws', 'AWS credentials'],
  ['.gnupg', 'GPG keys'],
  ['.kube', 'Kubernetes credentials'],
  ['.docker', 'Docker credentials'],
  ['.azure', 'Azure credentials'],
  ['.password-store', 'a password store'],
  ['.midway', 'a Midway session'],
  ['.personal-productivity-tracker', "BotBoy's private data"],
]);

const CREDENTIAL_BASENAMES: ReadonlyMap<string, string> = new Map([
  ['id_rsa', 'an SSH private key'],
  ['id_dsa', 'an SSH private key'],
  ['id_ecdsa', 'an SSH private key'],
  ['id_ed25519', 'an SSH private key'],
  ['id_ecdsa_sk', 'an SSH private key'],
  ['id_ed25519_sk', 'an SSH private key'],
  ['credentials', 'a cloud credentials file'],
  ['credentials.json', 'a credentials file'],
  ['credentials.csv', 'a credentials file'],
  ['client_secret.json', 'an OAuth client secret'],
  ['client_secrets.json', 'an OAuth client secret'],
  ['service-account.json', 'a service account key'],
  ['service_account.json', 'a service account key'],
  ['token.json', 'an OAuth token file'],
  ['kubeconfig', 'a Kubernetes credentials file'],
  ['secrets.json', 'a secrets file'],
  ['secrets.yaml', 'a secrets file'],
  ['secrets.yml', 'a secrets file'],
  ['secrets.toml', 'a secrets file'],
  ['htpasswd', 'a password file'],
  ['netrc', 'a password file'],
  ['pgpass', 'a password file'],
  ['git-credentials', 'a password file'],
  ['wallet.dat', 'a wallet'],
]);

const CREDENTIAL_NAME_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^client_secret_.+\.json$/i, 'an OAuth client secret'],
  [/(?:^|[_-])accesskeys\.csv$/i, 'an AWS access key download'],
  [/^rootkey\.csv$/i, 'an AWS root key download'],
  [/\.kubeconfig$/i, 'a Kubernetes credentials file'],
  [/\.tfstate\.backup$/i, 'Terraform state'],
];

const CREDENTIAL_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['.pem', 'a private key or certificate file'],
  ['.p8', 'a private key file'],
  ['.p12', 'a certificate store'],
  ['.pfx', 'a certificate store'],
  ['.jks', 'a Java keystore'],
  ['.keystore', 'a keystore'],
  ['.ppk', 'a PuTTY private key'],
  ['.kdbx', 'a password database'],
  ['.kdb', 'a password database'],
  ['.keychain', 'a macOS keychain'],
  ['.keychain-db', 'a macOS keychain'],
  ['.ovpn', 'a VPN profile'],
  ['.tfstate', 'Terraform state'],
  ['.tfvars', 'Terraform variables'],
  ['.env', 'an environment file'],
]);

/**
 * Why a local file must never be opened, from its path and size alone, or
 * null when nothing marks it as a credential. Directory rules apply to every
 * segment, so a watched folder inside `~/.aws` holds all of its files.
 */
export function sensitiveLocalPathReason(filePath: string, sizeBytes?: number): string | null {
  const segments = filePath.split(path.sep);
  for (let index = 0; index < segments.length - 1; index++) {
    const directory = CREDENTIAL_DIRECTORIES.get(segments[index]);
    if (directory) return `Stored with ${directory} (${segments[index]})`;
    if (segments[index] === '.config' && segments[index + 1] === 'gcloud') {
      return 'Stored with Google Cloud credentials (.config/gcloud)';
    }
  }
  const name = path.basename(filePath);
  const lower = name.toLowerCase();
  const byName = CREDENTIAL_BASENAMES.get(lower);
  if (byName) return `Named like ${byName} (${name})`;
  for (const [pattern, label] of CREDENTIAL_NAME_PATTERNS) {
    if (pattern.test(name)) return `Named like ${label} (${name})`;
  }
  const ext = path.extname(lower);
  const byType = CREDENTIAL_EXTENSIONS.get(ext);
  if (byType) return `File type of ${byType} (${ext})`;
  if (ext === '.key' && (sizeBytes === undefined || sizeBytes <= KEY_EXTENSION_MAX_BYTES)) {
    return 'File type of a private key (.key)';
  }
  return null;
}

/**
 * A symbolic link that resolves into a hidden location (for example
 * `~/.ssh/id_rsa` or BotBoy's own private data) is held like a credential:
 * the dot-folder rules that protect a watched folder's own tree would
 * otherwise be bypassed through the link.
 */
export function hiddenLinkTargetReason(realPath: string): string | null {
  for (const segment of realPath.split(path.sep)) {
    if (segment.startsWith('.') && segment !== '.' && segment !== '..') {
      return `Links into a hidden location (${segment})`;
    }
  }
  return sensitiveLocalPathReason(realPath);
}

/**
 * The path rule plus, for a symbolic link, where the link resolves. Costs one
 * `lstat` (and a `realpath` only for links); never opens the file.
 */
export function sensitiveLocalFileReason(filePath: string, sizeBytes?: number): string | null {
  const byPath = sensitiveLocalPathReason(filePath, sizeBytes);
  if (byPath) return byPath;
  try {
    if (!lstatSync(filePath).isSymbolicLink()) return null;
    return hiddenLinkTargetReason(realpathSync(filePath));
  } catch {
    return null;
  }
}

// ── Layer 2: high-confidence secret formats in text ───────────────────────

export type SecretKind =
  | 'private_key'
  | 'aws_access_key'
  | 'github_token'
  | 'gitlab_token'
  | 'slack_token'
  | 'slack_webhook'
  | 'openai_key'
  | 'anthropic_key'
  | 'api_key'
  | 'google_api_key'
  | 'google_oauth_secret'
  | 'google_access_token'
  | 'google_refresh_token'
  | 'stripe_key'
  | 'huggingface_token'
  | 'npm_token'
  | 'pypi_token'
  | 'sendgrid_key'
  | 'azure_storage_key';

const SECRET_LABELS: Record<SecretKind, string> = {
  private_key: 'a private key',
  aws_access_key: 'an AWS access key',
  github_token: 'a GitHub token',
  gitlab_token: 'a GitLab token',
  slack_token: 'a Slack token',
  slack_webhook: 'a Slack webhook URL',
  openai_key: 'an OpenAI API key',
  anthropic_key: 'an Anthropic API key',
  api_key: 'an API key',
  google_api_key: 'a Google API key',
  google_oauth_secret: 'a Google OAuth client secret',
  google_access_token: 'a Google OAuth access token',
  google_refresh_token: 'a Google OAuth refresh token',
  stripe_key: 'a Stripe secret key',
  huggingface_token: 'a Hugging Face token',
  npm_token: 'an npm token',
  pypi_token: 'a PyPI token',
  sendgrid_key: 'a SendGrid key',
  azure_storage_key: 'an Azure storage key',
};

/**
 * Real tokens are long and varied; documentation placeholders
 * (`ghp_xxxxxxxx…`, `sk-proj-YOUR_KEY_HERE…`) are not.
 */
function plausibleToken(value: string): boolean {
  if (/example|your|xxxx|placeholder|redacted|dummy|sample/i.test(value)) return false;
  return new Set(value).size >= 10 && /\d/.test(value) && /[A-Za-z]/.test(value);
}

/** One provider token format: a distinctive prefix plus length. */
interface TokenRule {
  kind: SecretKind;
  source: string;
}

const TOKEN_RULES: readonly TokenRule[] = [
  { kind: 'github_token', source: String.raw`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b` },
  { kind: 'github_token', source: String.raw`\bgithub_pat_[A-Za-z0-9_]{60,255}\b` },
  { kind: 'gitlab_token', source: String.raw`\bglpat-[A-Za-z0-9_-]{20,}` },
  // Real Slack tokens carry numeric workspace/user IDs after the prefix.
  { kind: 'slack_token', source: String.raw`\bxox[abposr]-\d{6,}-[A-Za-z0-9-]{8,}` },
  { kind: 'slack_token', source: String.raw`\bxoxe\.xox[bp]-1-[A-Za-z0-9-]{20,}` },
  { kind: 'slack_webhook', source: String.raw`https://hooks\.slack\.com/(?:services|workflows|triggers)/[A-Za-z0-9/_-]{20,}` },
  { kind: 'anthropic_key', source: String.raw`\bsk-ant-[a-z]+\d{2}-[A-Za-z0-9_-]{60,}` },
  { kind: 'openai_key', source: String.raw`\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}` },
  { kind: 'openai_key', source: String.raw`\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b` },
  // DeepSeek-style keys: sk- plus 32 lowercase hex characters.
  { kind: 'api_key', source: String.raw`\bsk-[a-f0-9]{32}\b` },
  { kind: 'google_api_key', source: String.raw`\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])` },
  { kind: 'google_oauth_secret', source: String.raw`\bGOCSPX-[A-Za-z0-9_-]{24,}` },
  // Google OAuth access tokens (ya29.…) and refresh tokens (1//0…), as the
  // Gmail connection holds them (gmail-connection.ts).
  { kind: 'google_access_token', source: String.raw`\bya29\.[A-Za-z0-9_-]{30,}` },
  { kind: 'google_refresh_token', source: String.raw`(?<![A-Za-z0-9_/-])1//0[A-Za-z0-9_-]{30,}` },
  { kind: 'stripe_key', source: String.raw`\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b` },
  { kind: 'huggingface_token', source: String.raw`\bhf_[A-Za-z0-9]{34,}\b` },
  { kind: 'npm_token', source: String.raw`\bnpm_[A-Za-z0-9]{36}\b` },
  { kind: 'pypi_token', source: String.raw`\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}` },
  { kind: 'sendgrid_key', source: String.raw`\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])` },
  { kind: 'azure_storage_key', source: String.raw`AccountKey=[A-Za-z0-9+/]{86}==` },
];

// One pass over the text finds every provider token: each rule is a named
// alternative, so the matched group names the kind.
const TOKEN_PATTERN_SOURCE = TOKEN_RULES.map((rule, index) => `(?<t${index}>${rule.source})`).join('|');

function tokenPattern(): RegExp {
  return new RegExp(TOKEN_PATTERN_SOURCE, 'g');
}

function tokenRuleOf(match: RegExpMatchArray): TokenRule | null {
  const groups = match.groups ?? {};
  for (let index = 0; index < TOKEN_RULES.length; index++) {
    if (groups[`t${index}`] !== undefined) return TOKEN_RULES[index];
  }
  return null;
}

// A key block, not a format description: real keys have a 64-character
// base64 line shortly after the header (PEM 64, OpenSSH 70).
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,300}?[A-Za-z0-9+/]{64}/;
// Redaction: a whole terminated block, then the base64 lines after any
// header left without its END line (a truncated excerpt). Prose that only
// names the header keeps the rest of its text.
const PRIVATE_KEY_BLOCK = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----[\s\S]{0,20000}?-----END \1-----/g;
const PRIVATE_KEY_OPEN_BODY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:(?:\\n|\s)+[A-Za-z0-9+/=]{16,})+/g;

const AWS_KEY_ID = /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g;
const AWS_SECRET_SHAPE = /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;
const AWS_SECRET_ASSIGNMENT = /(aws_?secret_?access_?key["']?\s*[:=]\s*["']?)([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gi;

/** AWS secret keys mix cases and digits; hex digests (git, SHA-1) do not. */
function looksLikeAwsSecret(value: string): boolean {
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9/+]/.test(value) && !/EXAMPLE/i.test(value);
}

/**
 * A key ID that signs a request (`X-Amz-Credential=` in a presigned URL,
 * `Credential=` in a SigV4 header) travels with a signature, not a secret;
 * presigned links in chat and notes are not credential files.
 */
function isSigningKeyId(text: string, index: number): boolean {
  return /Credential=$/i.test(text.slice(Math.max(0, index - 16), index));
}

function hasAwsKeyId(text: string): boolean {
  for (const match of text.matchAll(AWS_KEY_ID)) {
    if (!/EXAMPLE/.test(match[0]) && !isSigningKeyId(text, match.index ?? 0)) return true;
  }
  return false;
}

function hasAwsCredential(text: string): boolean {
  for (const match of text.matchAll(AWS_SECRET_ASSIGNMENT)) {
    if (looksLikeAwsSecret(match[2])) return true;
  }
  if (!hasAwsKeyId(text)) return false;
  for (const match of text.matchAll(AWS_SECRET_SHAPE)) {
    if (looksLikeAwsSecret(match[0])) return true;
  }
  return false;
}

/**
 * The distinct kinds of high-confidence secrets in `text`, in a stable order.
 * Empty means nothing secret-shaped was found.
 */
export function detectSecrets(text: string): SecretKind[] {
  const found = new Set<SecretKind>();
  if (PRIVATE_KEY_PATTERN.test(text)) found.add('private_key');
  if (hasAwsCredential(text)) found.add('aws_access_key');
  for (const match of text.matchAll(tokenPattern())) {
    const rule = tokenRuleOf(match);
    if (rule && plausibleToken(match[0])) found.add(rule.kind);
  }
  const order = Object.keys(SECRET_LABELS) as SecretKind[];
  return order.filter((kind) => found.has(kind));
}

/** Owner-facing reason for a held file: names the kinds, never the values. */
export function describeSecretKinds(kinds: readonly SecretKind[]): string {
  const labels = kinds.map((kind) => SECRET_LABELS[kind]);
  if (labels.length === 0) return 'Contains what looks like a credential';
  const list = labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  return `Contains what looks like ${list}`;
}

// ── Prompt redaction (broader than the hold rules) ─────────────────────────

// The name prefix is bounded (≤6 segments of ≤40 characters), so a long
// a_b_c_… run cannot make the scan quadratic.
const SECRET_ASSIGNMENT = /\b((?:[A-Za-z0-9]{1,40}[_-]){0,6}(?:api[_-]?key|apikey|secret(?:[_-]?key)?|client[_-]?secret|private[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer[_-]?token|password|passwd|pwd|passphrase)["']?\s*[:=]\s*["']?)([^\s"'<>,;)}\]]{8,})/gi;
const AUTHORIZATION_HEADER = /(\bAuthorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
const BEARER_TOKEN = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{20,})/g;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]{3,})@/gi;

/** Template variables, documentation placeholders, and earlier redactions stay. */
function isPlaceholderValue(value: string): boolean {
  return /^[[<{$%*]/.test(value)
    || /^(?:your|my|example|sample|dummy|changeme|placeholder|redacted|none|null|undefined|true|false)/i.test(value)
    || /^(.)\1+$/.test(value);
}

/**
 * Replace secret values in model-bound evidence. Covers every hold format
 * plus credential-shaped assignments (`password: …`, `API_KEY=…`),
 * Authorization/Bearer headers, and passwords embedded in URLs.
 */
export function redactSecrets(text: string): string {
  let out = text.replace(PRIVATE_KEY_BLOCK, '[REDACTED_PRIVATE_KEY]');
  out = out.replace(PRIVATE_KEY_OPEN_BODY, '[REDACTED_PRIVATE_KEY]');
  out = out.replace(tokenPattern(), (match: string) => (plausibleToken(match) ? '[REDACTED_SECRET]' : match));
  out = out.replace(AWS_SECRET_ASSIGNMENT, (whole: string, prefix: string, value: string) => (
    looksLikeAwsSecret(value) ? `${prefix}[REDACTED]` : whole
  ));
  if (hasAwsKeyId(out)) {
    out = out.replace(AWS_SECRET_SHAPE, (value: string) => (looksLikeAwsSecret(value) ? '[REDACTED_SECRET]' : value));
    out = out.replace(AWS_KEY_ID, (value: string, offset: number, whole: string) => (
      /EXAMPLE/.test(value) || isSigningKeyId(whole, offset) ? value : '[REDACTED_AWS_KEY_ID]'
    ));
  }
  out = out.replace(AUTHORIZATION_HEADER, '$1[REDACTED]');
  out = out.replace(BEARER_TOKEN, (whole: string, prefix: string, value: string) => (
    value.startsWith('[REDACTED') ? whole : `${prefix}[REDACTED]`
  ));
  out = out.replace(SECRET_ASSIGNMENT, (whole: string, prefix: string, value: string) => (
    isPlaceholderValue(value) ? whole : `${prefix}[REDACTED]`
  ));
  out = out.replace(URL_CREDENTIALS, (whole: string, prefix: string, value: string) => (
    isPlaceholderValue(value) ? whole : `${prefix}[REDACTED]@`
  ));
  return out;
}
