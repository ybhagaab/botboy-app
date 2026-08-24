/**
 * SigV4 signing for the Bedrock OpenAI-compatible endpoint.
 *
 * Why shell out to the AWS CLI instead of using an SDK credential provider:
 * this machine authenticates via `aws login` (Conduit `login_session` in
 * ~/.aws/config). The JS SDK's credential chain cannot resolve that session
 * type — the CLI is the only component that can mint credentials from it.
 * `aws configure export-credentials --format process` gives us exactly what
 * the CLI itself would use, with an Expiration timestamp for caching.
 *
 * Failure mode: when the login session is fully expired, the CLI exits
 * non-zero ("Credentials were refreshed, but the refreshed credentials are
 * still expired"). We surface a clear error and llm-client marks the endpoint
 * unhealthy; callers defer work unless local fallback was explicitly enabled.
 */
import { accessSync, constants } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { getTokenProvider } from '@aws/bedrock-token-generator';
import aws4 from 'aws4';

interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** epoch ms; 0 = unknown (treat as short-lived) */
  expiresAt: number;
}

let cached: AwsCreds | null = null;
let inflight: Promise<AwsCreds> | null = null;

/** Refresh 5 minutes before expiry; unknown expiry → re-fetch every 10 minutes. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const UNKNOWN_EXPIRY_TTL_MS = 10 * 60 * 1000;
const BEDROCK_TOKEN_TTL_SECONDS = 60 * 60;

interface CachedBearerToken {
  token: string;
  /** Do not reuse after this instant; already includes the refresh margin. */
  reusableUntil: number;
}

const cachedBearerTokens = new Map<string, CachedBearerToken>();
const bearerTokenInflight = new Map<string, Promise<string>>();

function mantleRegion(urlString: string): string {
  const hostname = new URL(urlString).hostname;
  const match = hostname.match(/^bedrock-mantle\.([a-z0-9-]+)\.api\.aws$/);
  if (!match) throw new Error(`Cannot derive region from Bedrock Mantle host: ${hostname}`);
  return match[1];
}

function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the AWS CLI without assuming a terminal shell PATH. macOS launches
 * .app bundles with a restricted environment, while user-managed Homebrew may
 * live under ~/homebrew rather than /opt/homebrew.
 */
export function resolveAwsCliPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AWS_CLI_BIN?.trim();
  if (configured) {
    if (isExecutable(configured)) return configured;
    throw new Error(`AWS_CLI_BIN is not executable: ${configured}`);
  }

  const pathCandidates = (env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map(directory => path.join(directory, 'aws'));
  const homeCandidates = env.HOME
    ? [path.join(env.HOME, 'homebrew', 'bin', 'aws'), path.join(env.HOME, '.local', 'bin', 'aws')]
    : [];
  const candidates = [
    ...pathCandidates,
    ...homeCandidates,
    '/opt/homebrew/bin/aws',
    '/usr/local/bin/aws',
    '/usr/bin/aws',
  ];

  for (const candidate of new Set(candidates)) {
    if (isExecutable(candidate)) return candidate;
  }
  throw new Error('AWS CLI executable not found. Install AWS CLI or set AWS_CLI_BIN to its absolute path.');
}

async function fetchCredsFromCli(): Promise<AwsCreds> {
  const awsCli = resolveAwsCliPath();
  // Load child_process only when credentials are actually needed. This keeps
  // non-AWS code paths independent from process-launch mocks and startup work.
  const { execFile } = await import('child_process');
  const execFileAsync = promisify(execFile);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(awsCli, ['configure', 'export-credentials', '--format', 'process'], {
      timeout: 15000,
    }));
  } catch (err: any) {
    const detail = String(err?.stderr || err?.message || err).trim().slice(0, 200);
    throw new Error(`AWS credential resolution failed (run \`aws login\`?): ${detail}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('AWS CLI export-credentials returned non-JSON output');
  }
  if (!parsed.AccessKeyId || !parsed.SecretAccessKey) {
    throw new Error('AWS CLI export-credentials returned no usable credentials');
  }
  const expiresAt = parsed.Expiration
    ? Date.parse(parsed.Expiration)
    : Date.now() + UNKNOWN_EXPIRY_TTL_MS;
  return {
    accessKeyId: parsed.AccessKeyId,
    secretAccessKey: parsed.SecretAccessKey,
    sessionToken: parsed.SessionToken,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + UNKNOWN_EXPIRY_TTL_MS,
  };
}

export async function getAwsCredentials(): Promise<AwsCreds> {
  if (cached && Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS) return cached;
  // Dedupe concurrent refreshes (health probe + live request racing)
  if (!inflight) {
    inflight = fetchCredsFromCli()
      .then(c => { cached = c; return c; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** Test hook: drop credential and derived bearer-token caches. */
export function clearCredentialCache(): void {
  cached = null;
  cachedBearerTokens.clear();
  bearerTokenInflight.clear();
}

/**
 * Return a short-lived bearer token for the Bedrock Mantle endpoint. Token
 * generation is local: the official generator signs with the same temporary
 * credentials exported by the AWS CLI and does not create or modify IAM
 * resources. Values are cached only while both token and source credentials
 * remain safely outside their expiry margins, and are never logged.
 */
export async function getBedrockBearerToken(urlString: string): Promise<string> {
  const region = mantleRegion(urlString);
  const existing = cachedBearerTokens.get(region);
  if (existing && Date.now() < existing.reusableUntil) return existing.token;

  const pending = bearerTokenInflight.get(region);
  if (pending) return pending;

  const refresh = (async () => {
    const credentials = await getAwsCredentials();
    const provideToken = getTokenProvider({
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
        expiration: new Date(credentials.expiresAt),
      },
      region,
      expiresInSeconds: BEDROCK_TOKEN_TTL_SECONDS,
    });
    const token = await provideToken();
    const reusableUntil = Math.min(
      Date.now() + BEDROCK_TOKEN_TTL_SECONDS * 1000,
      credentials.expiresAt,
    ) - EXPIRY_MARGIN_MS;
    cachedBearerTokens.set(region, { token, reusableUntil });
    return token;
  })().finally(() => {
    bearerTokenInflight.delete(region);
  });

  bearerTokenInflight.set(region, refresh);
  return refresh;
}

/**
 * Sign an HTTP request for the legacy Bedrock Runtime endpoint. Returns the
 * headers to send. The exact `body` string passed here MUST be the one sent on
 * the wire (payload hash). Region is derived from the hostname
 * (bedrock-runtime.<region>.amazonaws.com).
 */
export async function signBedrockRequest(
  urlString: string,
  method: 'GET' | 'POST',
  body?: string,
): Promise<Record<string, string>> {
  const url = new URL(urlString);
  const regionMatch = url.hostname.match(/bedrock-runtime\.([a-z0-9-]+)\.amazonaws\.com/);
  if (!regionMatch) throw new Error(`Cannot derive region from Bedrock host: ${url.hostname}`);

  const creds = await getAwsCredentials();
  const opts: aws4.Request = {
    host: url.hostname,
    path: url.pathname + url.search,
    service: 'bedrock',
    region: regionMatch[1],
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body } : {}),
  };
  aws4.sign(opts, {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  });
  // aws4 adds Host — undici derives Host from the URL itself and treats an
  // explicit header as forbidden, so drop it (values are identical either way).
  const headers = { ...(opts.headers as Record<string, string>) };
  delete headers['Host'];
  delete headers['host'];
  return headers;
}
