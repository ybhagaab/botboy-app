import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * scripts/import-credentials.sh with a temporary HOME: the gateway section is
 * validated before anything is written, and the downloaded attachment is
 * deleted only after a complete import. Gmail lines from older credential
 * files are skipped, because every install saves its own Google client
 * (GMAIL_CHAT_TOOLS_PLAN.md D12); nothing about Gmail is ever written.
 */

const SCRIPT = path.join(process.cwd(), 'scripts', 'import-credentials.sh');
const GATEWAY = ['BOTBOY_INFERENCE_OAUTH_CLIENT_ID=gateway-client-id', 'BOTBOY_INFERENCE_OAUTH_CLIENT_SECRET=gateway-secret-value'];
const GMAIL_ID = '878939412376-sharedclientabc.apps.googleusercontent.com';
const GMAIL_SECRET = 'GOCSPX-shared_secret+value/x=';
const GMAIL = [`BOTBOY_GMAIL_OAUTH_CLIENT_ID=${GMAIL_ID}`, `BOTBOY_GMAIL_OAUTH_CLIENT_SECRET=${GMAIL_SECRET}`];

describe('import-credentials.sh', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-import-creds-'));
    fs.mkdirSync(path.join(home, 'Downloads'));
    fs.mkdirSync(path.join(home, 'Desktop'));
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  const privateDir = () => path.join(home, '.personal-productivity-tracker');
  const envFile = () => path.join(privateDir(), '.env');
  const download = (name = 'botboy-credentials.env') => path.join(home, 'Downloads', name);

  function run() {
    const result = spawnSync('/bin/bash', [SCRIPT], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain(GMAIL_SECRET);
    return output;
  }
  function deliver(lines: string[], name?: string, eol = '\n') {
    fs.writeFileSync(download(name), `${lines.join(eol)}${eol}`, { mode: 0o600 });
  }
  function zipDelivery(lines: string[]) {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-import-zip-'));
    try {
      fs.writeFileSync(path.join(staging, 'botboy-credentials.env'), `${lines.join('\n')}\n`);
      const zipped = spawnSync('/usr/bin/zip', ['-q', '-j', download('botboy-credentials.zip'), path.join(staging, 'botboy-credentials.env')]);
      expect(zipped.status).toBe(0);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  const mode = (file: string) => fs.statSync(file).mode & 0o777;

  it('does nothing without a downloaded credential file', () => {
    expect(run()).toBe('');
    expect(fs.existsSync(privateDir())).toBe(false);
  });

  it('imports a gateway-only file into .env exactly as before, keeping unrelated lines', () => {
    fs.mkdirSync(privateDir(), { mode: 0o700 });
    fs.writeFileSync(envFile(), 'BOTBOY_INFERENCE_OAUTH_CLIENT_ID=old\nOTHER_SETTING=keep\nBOTBOY_INFERENCE_OAUTH_CLIENT_SECRET=old\n');
    deliver(GATEWAY);
    const output = run();
    expect(output).toMatch(/Imported AI gateway sign-in .* from file botboy-credentials\.env \(downloaded attachment removed\)\.\n$/);
    expect(output).not.toContain('Gmail');
    expect(fs.readFileSync(envFile(), 'utf8')).toBe(`OTHER_SETTING=keep\n${GATEWAY.join('\n')}\n`);
    expect(mode(envFile())).toBe(0o600);
    expect(fs.existsSync(download())).toBe(false);
    expect(fs.readdirSync(privateDir())).toEqual(['.env']);
  });

  it('imports the gateway section and skips the Gmail lines of an older file or owner ZIP', () => {
    deliver([...GATEWAY, '# comment lines are ignored', ...GMAIL]);
    expect(run()).toMatch(/Imported AI gateway sign-in .* \(downloaded attachment removed\)\. Its Gmail lines were skipped: Gmail uses your own Google client from Connections → Gmail\./);
    expect(fs.readFileSync(envFile(), 'utf8')).toBe(`${GATEWAY.join('\n')}\n`);
    expect(fs.readdirSync(privateDir())).toEqual(['.env']);

    fs.rmSync(privateDir(), { recursive: true, force: true });
    zipDelivery([...GATEWAY, ...GMAIL]);
    expect(run()).toMatch(/from ZIP botboy-credentials\.zip .*Gmail lines were skipped/);
    expect(fs.readFileSync(envFile(), 'utf8')).toBe(`${GATEWAY.join('\n')}\n`);
    expect(fs.existsSync(download('botboy-credentials.zip'))).toBe(false);
    expect(fs.readdirSync(privateDir())).toEqual(['.env']);
  });

  it('removes an older Gmail-only file or ZIP (CRLF tolerated) without writing anything', () => {
    deliver(GMAIL, undefined, '\r\n');
    expect(run()).toMatch(/Nothing to import from file botboy-credentials\.env: it only carries a Google client, and Gmail now uses your own client from Connections → Gmail \(downloaded attachment removed\)/);
    expect(fs.existsSync(download())).toBe(false);
    expect(fs.existsSync(envFile())).toBe(false);

    zipDelivery(GMAIL);
    expect(run()).toMatch(/Nothing to import from ZIP botboy-credentials\.zip/);
    expect(fs.existsSync(download('botboy-credentials.zip'))).toBe(false);
    expect(fs.readdirSync(privateDir())).toEqual([]);
  });

  it('refuses the whole file, writing nothing and keeping the download, when the gateway section is invalid', () => {
    const cases: string[][] = [
      [GATEWAY[0], ...GMAIL],
      [...GMAIL, GATEWAY[1]],
      [GATEWAY[0], GATEWAY[0], GATEWAY[1]],
      ['BOTBOY_INFERENCE_OAUTH_CLIENT_ID=', GATEWAY[1]],
      ['SOMETHING_ELSE=1'],
    ];
    for (const lines of cases) {
      deliver(lines);
      expect(run()).toMatch(/not imported/);
      expect(fs.existsSync(download())).toBe(true);
      expect(fs.existsSync(envFile())).toBe(false);
    }
    expect(fs.readdirSync(privateDir())).toEqual([]);
  });

  it('takes the newest download and replaces a planted .env link instead of writing through it', () => {
    fs.mkdirSync(privateDir(), { mode: 0o700 });
    const target = path.join(home, 'elsewhere.env');
    fs.writeFileSync(target, 'untouched');
    fs.symlinkSync(target, envFile());
    deliver(['BOTBOY_INFERENCE_OAUTH_CLIENT_ID=old-gateway-id', GATEWAY[1]], 'botboy-credentials (1).env');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(download('botboy-credentials (1).env'), old, old);
    fs.writeFileSync(path.join(home, 'Desktop', 'botboy-credentials.env'), `${GATEWAY.join('\n')}\n`);

    run();
    expect(fs.lstatSync(envFile()).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(envFile(), 'utf8').endsWith(`${GATEWAY.join('\n')}\n`)).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
    expect(fs.existsSync(path.join(home, 'Desktop', 'botboy-credentials.env'))).toBe(false);
    // The older download is left for the owner to clean up.
    expect(fs.existsSync(download('botboy-credentials (1).env'))).toBe(true);
  });
});
