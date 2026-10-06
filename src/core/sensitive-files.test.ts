import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  describeSecretKinds,
  detectSecrets,
  redactSecrets,
  sensitiveLocalFileReason,
  sensitiveLocalPathReason,
} from './sensitive-files.js';
import { redactSensitiveText } from './prompt-redaction.js';

// Synthetic secrets are generated at run time from split prefixes, so no
// token-shaped literal lives in the repository (secret scanners stay quiet).
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const ALNUM = UPPER + LOWER + DIGITS;
function chars(count: number, alphabet = ALNUM, seed = 11): string {
  const random = seeded(seed);
  let out = '';
  for (let index = 0; index < count; index++) out += alphabet[Math.floor(random() * alphabet.length)];
  return out;
}
const join = (...parts: string[]) => parts.join('');
const fake = {
  github: join('gh', 'p_', chars(36, ALNUM, 1)),
  slack: join('xo', 'xb-', chars(12, DIGITS, 2), '-', chars(13, DIGITS, 3), '-', chars(24, ALNUM, 4)),
  openai: join('sk', '-proj-', chars(48, `${ALNUM}_-`, 5)),
  deepseek: join('sk', '-', chars(32, '0123456789abcdef', 6)),
  google: join('AI', 'za', chars(35, `${ALNUM}_-`, 7)),
  awsId: join('AK', 'IA', chars(16, UPPER + DIGITS, 8)),
  awsSecret: join('aB3', chars(37, `${ALNUM}/+`, 9)),
  privateKey: [
    join('-----BEGIN ', 'RSA PRIVATE', ' KEY-----'),
    ...[10, 11, 12, 13].map(seed => chars(64, `${ALNUM}+/`, seed)),
    join('-----END ', 'RSA PRIVATE', ' KEY-----'),
  ].join('\n'),
};

describe('sensitive local paths (no read)', () => {
  const home = '/Users/someone';
  it.each([
    [`${home}/Desktop/id_rsa`, 'Named like an SSH private key (id_rsa)'],
    [`${home}/Downloads/server.pem`, 'File type of a private key or certificate file (.pem)'],
    [`${home}/Downloads/AuthKey_ABCD1234.p8`, 'File type of a private key file (.p8)'],
    [`${home}/Downloads/jane_accessKeys.csv`, 'Named like an AWS access key download (jane_accessKeys.csv)'],
    [`${home}/Downloads/credentials.csv`, 'Named like a credentials file (credentials.csv)'],
    [`${home}/Downloads/botboy-credentials (1).env`, 'File type of an environment file (.env)'],
    [`${home}/Downloads/client_secret_123-abc.apps.googleusercontent.com.json`, 'Named like an OAuth client secret (client_secret_123-abc.apps.googleusercontent.com.json)'],
    [`${home}/infra/terraform.tfstate.backup`, 'Named like Terraform state (terraform.tfstate.backup)'],
    [`${home}/infra/prod.kubeconfig`, 'Named like a Kubernetes credentials file (prod.kubeconfig)'],
    [`${home}/.aws/config`, 'Stored with AWS credentials (.aws)'],
    [`${home}/.config/gcloud/application_default_credentials.json`, 'Stored with Google Cloud credentials (.config/gcloud)'],
    [`${home}/.personal-productivity-tracker/files/notes.md`, "Stored with BotBoy's private data (.personal-productivity-tracker)"],
  ])('holds %s', (filePath, reason) => {
    expect(sensitiveLocalPathReason(filePath, 1_000)).toBe(reason);
  });

  it.each([
    `${home}/Desktop/id_rsa.pub`,
    `${home}/Documents/credentials-design.md`,
    `${home}/Documents/secrets-management.md`,
    `${home}/Documents/token-budget.xlsx`,
    `${home}/Documents/environment.md`,
    `${home}/Documents/AWS LLM Inference.pdf`,
  ])('reads ordinary files like %s', (filePath) => {
    expect(sensitiveLocalPathReason(filePath, 1_000)).toBeNull();
  });

  it('holds a small .key file but not a Keynote-sized deck', () => {
    expect(sensitiveLocalPathReason(`${home}/Downloads/tls.key`, 1_700)).toBe('File type of a private key (.key)');
    expect(sensitiveLocalPathReason(`${home}/Documents/Roadmap.key`, 4 * 1024 * 1024)).toBeNull();
  });

  describe('symbolic links', () => {
    let dir: string | null = null;
    afterEach(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      dir = null;
    });
    it('holds a link that resolves into a hidden folder, and reads a link to an ordinary file', () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-sensitive-'));
      fs.mkdirSync(path.join(dir, '.secret-store'));
      fs.writeFileSync(path.join(dir, '.secret-store', 'notes.txt'), 'x');
      fs.writeFileSync(path.join(dir, 'plain.txt'), 'x');
      fs.symlinkSync(path.join(dir, '.secret-store', 'notes.txt'), path.join(dir, 'linked-notes.txt'));
      fs.symlinkSync(path.join(dir, 'plain.txt'), path.join(dir, 'linked-plain.txt'));
      expect(sensitiveLocalFileReason(path.join(dir, 'linked-notes.txt'))).toBe('Links into a hidden location (.secret-store)');
      expect(sensitiveLocalFileReason(path.join(dir, 'linked-plain.txt'))).toBeNull();
    });
  });
});

describe('secret formats in text', () => {
  it('finds each high-confidence format and names it', () => {
    const text = [
      `GITHUB_TOKEN=${fake.github}`,
      `slack: ${fake.slack}`,
      `openai ${fake.openai}`,
      `deepseek ${fake.deepseek}`,
      `maps ${fake.google}`,
      `aws_access_key_id = ${fake.awsId}`,
      `aws_secret_access_key = ${fake.awsSecret}`,
      fake.privateKey,
    ].join('\n');
    const kinds = detectSecrets(text);
    expect(kinds).toEqual(['private_key', 'aws_access_key', 'github_token', 'slack_token', 'openai_key', 'api_key', 'google_api_key']);
    expect(describeSecretKinds(['private_key'])).toBe('Contains what looks like a private key');
    expect(describeSecretKinds(['aws_access_key', 'github_token'])).toBe('Contains what looks like an AWS access key and a GitHub token');
  });

  it('finds a service-account key inside JSON', () => {
    const json = JSON.stringify({ type: 'service_account', private_key: `${fake.privateKey.replace(/RSA /g, '')}\n` });
    expect(detectSecrets(json)).toEqual(['private_key']);
  });

  it('pairs an AWS key ID with a secret-shaped value in a credentials download', () => {
    const csv = `Access key ID,Secret access key\n${fake.awsId},${fake.awsSecret}\n`;
    expect(detectSecrets(csv)).toEqual(['aws_access_key']);
  });

  it('does not treat a presigned S3 link as an AWS credential', () => {
    // Owner-live 2026-10-01: every AWS hit in the prompt logs was a presigned
    // link (key ID in X-Amz-Credential, session-token segments nearby).
    const link = `https://bucket.s3.amazonaws.com/report.csv?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${fake.awsId}%2F20261001%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Security-Token=${chars(40, ALNUM, 41)}%2F${fake.awsSecret}%2B${chars(60, ALNUM, 42)}&X-Amz-Signature=${chars(64, '0123456789abcdef', 43)}`;
    expect(detectSecrets(link)).toEqual([]);
    expect(redactSecrets(link)).toContain(`X-Amz-Credential=${fake.awsId}`);
  });

  it('finds a Google OAuth client secret in a downloaded client JSON', () => {
    const client = JSON.stringify({ installed: { client_id: '1234-abc.apps.googleusercontent.com', client_secret: join('GOC', 'SPX-', chars(28, `${ALNUM}_-`, 44)) } });
    expect(detectSecrets(client)).toEqual(['google_oauth_secret']);
    expect(describeSecretKinds(['google_oauth_secret'])).toBe('Contains what looks like a Google OAuth client secret');
  });

  it('finds and redacts Google OAuth access and refresh tokens (Gmail connection)', () => {
    const access = join('ya', '29.', chars(60, `${ALNUM}_-`, 45));
    const refresh = join('1//', '0', chars(60, `${ALNUM}_-`, 46));
    const text = `{"access_token":"${access}","refresh_token":"${refresh}"}`;
    expect(detectSecrets(text)).toEqual(['google_access_token', 'google_refresh_token']);
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain(access);
    expect(redacted).not.toContain(refresh);
    // A URL path segment such as https://host//0abc… is not a refresh token.
    expect(detectSecrets(`see https://example.com/a1//0${chars(40, ALNUM, 47)}`)).toEqual([]);
  });

  it('ignores documentation examples, placeholders, and look-alikes', () => {
    const docs = [
      // The AWS documentation example pair.
      join('AKIA', 'IOSFODNN7', 'EXAMPLE'), join('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCY', 'EXAMPLEKEY'),
      // A key ID next to a lowercase git digest.
      `${fake.awsId} commit ${chars(40, '0123456789abcdef', 21)}`,
      // A header named in prose, with no key body.
      `Paste the block that starts with ${join('-----BEGIN ', 'RSA PRIVATE', ' KEY-----')} into the box.`,
      join('gh', 'p_', 'x'.repeat(36)),
      join('sk', '-proj-', 'YOUR_KEY_HERE_', 'x'.repeat(30)),
      join('xo', 'xb-', 'your-token-here'),
      'We used sk-learn-based-classification-pipelines for the baseline.',
    ].join('\n');
    expect(detectSecrets(docs)).toEqual([]);
  });

  it('scans a 2.4M-character file quickly', () => {
    const text = `${'{"step": 1, "loss": 0.123456, "phase": "warmup"},\n'.repeat(48_000)}`;
    const started = Date.now();
    expect(detectSecrets(text)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('prompt redaction', () => {
  it('keeps the existing query-credential and JWT rules', () => {
    expect(redactSensitiveText(
      'https://example.test/cb?code=secret-code&state=secret-state token=secret-token eyJabc.def_ghi.jkl-123',
    )).toBe('https://example.test/cb?code=[REDACTED]&state=[REDACTED] token=[REDACTED] [REDACTED_TOKEN]');
  });

  it('replaces secret values and keeps the surrounding evidence', () => {
    const text = [
      `Use ${fake.github} for the deploy bot.`,
      `OPENAI_API_KEY=${fake.openai}`,
      `password: ${chars(14, ALNUM, 31)}`,
      `Authorization: Bearer ${chars(32, ALNUM, 32)}`,
      `postgres://svc:${chars(12, ALNUM, 33)}@db.internal:5432/app`,
      fake.privateKey,
      'Ship the catalog API on Friday.',
    ].join('\n');
    const redacted = redactSensitiveText(text);
    for (const secret of [fake.github, fake.openai, fake.privateKey]) expect(redacted).not.toContain(secret);
    expect(redacted).toContain('Use [REDACTED_SECRET] for the deploy bot.');
    expect(redacted).toContain('OPENAI_API_KEY=[REDACTED_SECRET]');
    expect(redacted).toContain('password: [REDACTED]');
    expect(redacted).toContain('Authorization: Bearer [REDACTED]');
    expect(redacted).toContain('postgres://svc:[REDACTED]@db.internal:5432/app');
    expect(redacted).toContain('[REDACTED_PRIVATE_KEY]');
    expect(redacted).toContain('Ship the catalog API on Friday.');
  });

  it('keeps placeholders and prose after a header without a body', () => {
    expect(redactSecrets('password: <your-password>')).toBe('password: <your-password>');
    expect(redactSecrets('API_KEY=${OPENAI_API_KEY}')).toBe('API_KEY=${OPENAI_API_KEY}');
    const prose = `Starts with ${join('-----BEGIN ', 'PRIVATE', ' KEY-----')}. Then press Save.`;
    expect(redactSecrets(prose)).toBe(prose);
    // An excerpt cut before the END line still loses the key body.
    const cut = fake.privateKey.split('\n').slice(0, 3).join('\n');
    expect(redactSecrets(`before\n${cut}`)).toBe('before\n[REDACTED_PRIVATE_KEY]');
  });

  it('stays linear on long underscore chains', () => {
    const chain = `${'a_'.repeat(200_000)}x`;
    const started = Date.now();
    redactSecrets(chain);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
