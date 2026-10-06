import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * scripts/import-credentials.sh with a temporary HOME (GMAIL_CHAT_TOOLS_PLAN.md
 * §7): every section present is validated before anything is written, the
 * Gmail client is staged for the server (never .env), and the downloaded
 * attachment is deleted only after a complete import.
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
  const inbox = () => path.join(privateDir(), 'gmail-team-client.json');
  const download = (name = 'botboy-credentials.env') => path.join(home, 'Downloads', name);

  function run() {
    const result = spawnSync('/bin/bash', [SCRIPT], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    return result.stdout + result.stderr;
  }
  function deliver(lines: string[], name?: string, eol = '\n') {
    fs.writeFileSync(download(name), `${lines.join(eol)}${eol}`, { mode: 0o600 });
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
    expect(run()).toMatch(/Imported AI gateway sign-in .* \(downloaded attachment removed\)/);
    expect(fs.readFileSync(envFile(), 'utf8')).toBe(`OTHER_SETTING=keep\n${GATEWAY.join('\n')}\n`);
    expect(mode(envFile())).toBe(0o600);
    expect(fs.existsSync(download())).toBe(false);
    expect(fs.existsSync(inbox())).toBe(false);
  });

  it('stages a Gmail-only file (CRLF tolerated) for the server and never writes it into .env', () => {
    deliver(GMAIL, undefined, '\r\n');
    expect(run()).toMatch(/Imported BotBoy's Google client for Connections → Gmail/);
    expect(JSON.parse(fs.readFileSync(inbox(), 'utf8'))).toEqual({ schemaVersion: 1, clientId: GMAIL_ID, clientSecret: GMAIL_SECRET });
    expect(mode(inbox())).toBe(0o600);
    expect(fs.existsSync(envFile())).toBe(false);
    expect(fs.existsSync(download())).toBe(false);
  });

  it('imports both sections from one file or from an owner ZIP', () => {
    deliver([...GATEWAY, '# comment lines are ignored', ...GMAIL]);
    expect(run()).toMatch(/AI gateway sign-in .* and BotBoy's Google client/);
    expect(fs.readFileSync(envFile(), 'utf8')).toBe(`${GATEWAY.join('\n')}\n`);
    expect(JSON.parse(fs.readFileSync(inbox(), 'utf8')).clientId).toBe(GMAIL_ID);

    fs.rmSync(privateDir(), { recursive: true, force: true });
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-import-zip-'));
    try {
      fs.writeFileSync(path.join(staging, 'botboy-credentials.env'), `${[...GATEWAY, ...GMAIL].join('\n')}\n`);
      const zipped = spawnSync('/usr/bin/zip', ['-q', '-j', download('botboy-credentials.zip'), path.join(staging, 'botboy-credentials.env')]);
      expect(zipped.status).toBe(0);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    expect(run()).toMatch(/from ZIP botboy-credentials\.zip/);
    expect(JSON.parse(fs.readFileSync(inbox(), 'utf8')).clientSecret).toBe(GMAIL_SECRET);
    expect(fs.existsSync(download('botboy-credentials.zip'))).toBe(false);
    expect(fs.readdirSync(privateDir()).sort()).toEqual(['.env', 'gmail-team-client.json']);
  });

  it('refuses the whole file, writing nothing and keeping the download, when any present section is invalid', () => {
    const cases: string[][] = [
      [...GATEWAY, `BOTBOY_GMAIL_OAUTH_CLIENT_ID=878939412376-abc.example.com`, GMAIL[1]],
      [...GATEWAY, GMAIL[0]],
      [GMAIL[0], GMAIL[0], GMAIL[1]],
      [GATEWAY[0], ...GMAIL],
      [GMAIL[0], 'BOTBOY_GMAIL_OAUTH_CLIENT_SECRET=GOCSPX-has"quote'],
      [GMAIL[0], 'BOTBOY_GMAIL_OAUTH_CLIENT_SECRET=short'],
      ['SOMETHING_ELSE=1'],
    ];
    for (const lines of cases) {
      deliver(lines);
      expect(run()).toMatch(/not imported/);
      expect(fs.existsSync(download())).toBe(true);
      expect(fs.existsSync(envFile())).toBe(false);
      expect(fs.existsSync(inbox())).toBe(false);
    }
  });

  it('takes the newest download and replaces a planted link instead of writing through it', () => {
    fs.mkdirSync(privateDir(), { mode: 0o700 });
    const target = path.join(home, 'elsewhere.json');
    fs.writeFileSync(target, 'untouched');
    fs.symlinkSync(target, inbox());
    deliver(['BOTBOY_GMAIL_OAUTH_CLIENT_ID=111111111111-oldclient.apps.googleusercontent.com', GMAIL[1]], 'botboy-credentials (1).env');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(download('botboy-credentials (1).env'), old, old);
    fs.writeFileSync(path.join(home, 'Desktop', 'botboy-credentials.env'), `${GMAIL.join('\n')}\n`);

    run();
    expect(fs.lstatSync(inbox()).isSymbolicLink()).toBe(false);
    expect(JSON.parse(fs.readFileSync(inbox(), 'utf8')).clientId).toBe(GMAIL_ID);
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
    expect(fs.existsSync(path.join(home, 'Desktop', 'botboy-credentials.env'))).toBe(false);
    // The older download is left for the owner to clean up.
    expect(fs.existsSync(download('botboy-credentials (1).env'))).toBe(true);
  });
});
