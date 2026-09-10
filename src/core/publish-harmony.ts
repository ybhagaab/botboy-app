/**
 * Harmony publish adapter (DASHBOARD_SHARING_PLAN §5, reworked 2026-09-09).
 *
 * Amazon-internal sharing. BotBoy owns the ENTIRE app lifecycle — the owner
 * never touches a terminal:
 *
 *   - App name is DERIVED, not chosen: `<alias>-botboy-dashboard`.
 *   - The app tree lives in BotBoy's data dir and is scaffolded/refreshed
 *     deterministically (package.json + .harmony/harmony-metadata.json).
 *     Hand-edits do not survive, by design.
 *   - The metadata file (appName, bindleId, CSP, …) makes beta/gamma deploys
 *     fully non-interactive; `harmony app create` is never run.
 *   - The FIRST deploy carries `--parentBindleId <bindleId>` (team bindle —
 *     Harmony rejects personal bindles with a verbatim error we classify).
 *   - PROD deploys refuse non-interactive mode (TTY check). Owner ruling:
 *     run them under a real PTY via /usr/bin/expect (ships with macOS),
 *     answering only the expected confirm prompt. Anything unexpected times
 *     out and fails WITH the transcript — never a guessed answer. The human
 *     gate is BotBoy's own two-phase confirmation, already clicked.
 *   - After deploy, viewer access CONVERGES to the configured visibility
 *     (everyone | private) — Harmony viewing is deny-by-default; the grant
 *     rides the deploy step (owner ruling). The grant transport (CDP
 *     owner-Chrome → BindleService) is injected by the caller; publish
 *     fails honestly when it is required and unavailable.
 *
 * Failure philosophy: every error names the next action — the model/UI must
 * never see a bare failure.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AnalyticsDashboard } from './analytics-types.js';
import { renderDashboardBundle, writeBundle } from './publish-bundle.js';
import { writeStaticArtifactBundle, type StaticArtifactBundle } from './publish-static-artifact.js';
import { escapeHtml, SNAPSHOT_CSS } from './snapshot-render.js';

import type { HarmonyPublisherSettings } from './analytics-types.js';

export type HarmonySettings = HarmonyPublisherSettings;

export interface HarmonyProbe {
  cliPresent: boolean;
  cliVersion?: string;
  bindleConfigured: boolean;
  /** CLI deploys ride the ~/.midway jar — browser Midway is NOT enough (live-fire 2026-09-09). */
  midwayLive: boolean;
  ready: boolean;
  /** Which setup step the UI stepper should light up. */
  nextAction: 'install-cli' | 'configure-bindle' | 'ready';
  detail: string;
}

/** Is there a live Midway SSO row in the CLI cookie jar? Only domains, names,
 * and expiries are read — never values (pattern: sentry-session.ts). */
export function hasLiveMidwayCliSession(
  cookiePath = path.join(os.homedir(), '.midway', 'cookie'),
  nowMs = Date.now(),
): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(cookiePath, 'utf8');
  } catch {
    return false;
  }
  for (const line of raw.split('\n')) {
    let entry = line.trim();
    if (!entry) continue;
    if (entry.startsWith('#HttpOnly_')) entry = entry.slice('#HttpOnly_'.length);
    else if (entry.startsWith('#')) continue;
    const fields = entry.split(/\t+|\s{2,}|\s/).filter(Boolean);
    if (fields.length < 6) continue;
    const [domain, , , , expiryRaw, name] = fields;
    if (!domain.toLowerCase().includes('midway-auth.amazon.com')) continue;
    if (!/session|amzn_sso/i.test(name)) continue;
    const expiry = Number(expiryRaw);
    if (expiry === 0) return true;
    if (Number.isFinite(expiry) && expiry * 1000 > nowMs) return true;
  }
  return false;
}

export interface PublishedEntry {
  dashboardId: string;
  title: string;
  description: string;
  publishedAt: string;
}

export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecFn = (command: string, args: string[], options: { cwd?: string; timeoutMs: number }) => Promise<ExecResult>;

const DEPLOY_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
export const HARMONY_INSTALL_COMMAND = 'toolbox install harmonycli';

export const defaultExec: ExecFn = (command, args, options) => new Promise((resolve) => {
  const child = execFile(command, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CI: '1' }, // beta/gamma deploys must never prompt; metadata answers the rest
  }, (error, stdout, stderr) => {
    const code = error ? ((error as any).code === 'ETIMEDOUT' || (child.killed ?? false) ? -1 : Number((error as any).code ?? 1)) : 0;
    resolve({ code: Number.isFinite(code) ? code : 1, stdout: String(stdout), stderr: String(stderr) });
  });
});

/** The owner's Amazon alias — macOS username on Amazon-managed machines. */
export function harmonyOwnerAlias(): string {
  return (process.env.BOTBOY_ALIAS || os.userInfo().username || 'botboy-user').toLowerCase();
}

/** App name is DERIVED (owner ruling 2026-09-09), never a user choice. */
export function harmonyAppName(alias: string = harmonyOwnerAlias()): string {
  const cleaned = alias.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'botboy-user';
  return `${cleaned}-botboy-dashboard`;
}

/** BotBoy-owned app directory (never user-supplied). */
export function harmonyAppRoot(appName: string = harmonyAppName()): string {
  return path.join(os.homedir(), '.personal-productivity-tracker', 'harmony-app', appName);
}

/** The asset root the Harmony CLI deploys (Getting Started layout). */
export function harmonyAssetRoot(appRoot: string, appName: string): string {
  return path.join(appRoot, 'src', appName, 'src');
}

/**
 * Scaffold/refresh the app tree. package.json + .harmony/harmony-metadata.json
 * are REWRITTEN on every publish (deterministic; the metadata file is what
 * makes deploys non-interactive). Deployed assets under src/<app>/src persist
 * between publishes — each dashboard owns only its own d/<id>/ subtree.
 */
export function scaffoldHarmonyApp(settings: HarmonySettings, options: { appName?: string; appRoot?: string } = {}): { appRoot: string; assetRoot: string; appName: string } {
  const appName = options.appName ?? harmonyAppName();
  const appRoot = options.appRoot ?? harmonyAppRoot(appName);
  const assetRoot = harmonyAssetRoot(appRoot, appName);
  fs.mkdirSync(assetRoot, { recursive: true });
  fs.mkdirSync(path.join(appRoot, '.harmony'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'package.json'), `${JSON.stringify({
    name: `@amzn/${appName}`,
    version: '1.0.0',
    private: true,
    description: 'BotBoy dashboard snapshots (generated — do not hand-edit; BotBoy rewrites this tree on every publish)',
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(appRoot, '.harmony', 'harmony-metadata.json'), `${JSON.stringify({
    appName,
    displayName: 'BotBoy Dashboards',
    description: `Interactive dashboard snapshots published from ${harmonyOwnerAlias()}'s BotBoy workspace`,
    bindleId: settings.bindleId,
    // Default Harmony CSP only — the bundle is fully self-contained ('self' assets, no inline script).
    'content-security-policy': {},
    // Serve each directory's OWN index.html. Harmony's default routing sends
    // every directory path to the app ROOT index.html (SPA fallback), which
    // made /d/<id>/ render the listing page (live-fire 2026-09-09). Patterns
    // are the documented trio: file extensions untouched, trailing-slash
    // paths get index.html, bare paths get /index.html.
    routes: [
      { pattern: '(\\.\\w+)$', uri: '$1' },
      { pattern: '(.+/)$', uri: '$1index.html' },
      { pattern: '(\\w+)$', uri: '$1/index.html' },
    ],
  }, null, 2)}\n`);
  return { appRoot, assetRoot, appName };
}

/** Structured, next-action-bearing error strings (chat + UI both surface these). */
export function classifyHarmonyFailure(stdout: string, stderr: string): string {
  const text = `${stdout}\n${stderr}`;
  if (/command not found|ENOENT/i.test(text)) {
    return `Harmony CLI is not installed. Use the Install button in Settings → Dashboard sharing (it runs: ${HARMONY_INSTALL_COMMAND}).`;
  }
  if (/not a valid non-personal bindle/i.test(text)) {
    return 'Harmony rejected the bindle: personal bindles are not allowed. Use the automated setup in Dashboard sharing settings (BotBoy creates a team + team bindle for you), or paste a team-owned bindle ID.';
  }
  if (/midway|mwinit|authenticat|unauthorized|401/i.test(text)) {
    return 'The Harmony CLI\u2019s Midway session is missing or expired. Use the "Sign in (mwinit)" button in Settings \u2192 Dashboard sharing (or run mwinit -o in any terminal), then retry the publish.';
  }
  if (/not allowed in non-interactive mode/i.test(text)) {
    return 'Harmony refused a non-interactive prod deploy — the PTY wrapper did not engage. Retry; if it persists this is a BotBoy bug (publish-harmony prod path).';
  }
  if (/bindle|permission|forbidden|403|not authorized/i.test(text)) {
    return 'The Harmony app rejected the deploy — your user may not have deploy rights on the app\u2019s bindle. Check it on bindles.amazon.com (the app resource is harmony/HarmonyApp/<app-name>).';
  }
  return `Harmony deploy failed: ${text.trim().slice(0, 500) || 'no output'}`;
}

export async function probeHarmony(settings: Partial<HarmonySettings>, exec: ExecFn = defaultExec, midwayLiveCheck: () => boolean = hasLiveMidwayCliSession): Promise<HarmonyProbe> {
  const version = await exec('harmony', ['--version'], { timeoutMs: 20_000 });
  const cliPresent = version.code === 0;
  const bindleConfigured = Boolean(settings.bindleId);
  const midwayLive = midwayLiveCheck();
  const ready = cliPresent && bindleConfigured;
  const nextAction: HarmonyProbe['nextAction'] = !cliPresent ? 'install-cli' : !bindleConfigured ? 'configure-bindle' : 'ready';
  const detail = !cliPresent
    ? `Harmony CLI not found. BotBoy can install it for you (${HARMONY_INSTALL_COMMAND}).`
    : !bindleConfigured
      ? `CLI ${version.stdout.trim()} ready. Next: a team bindle ID (automated setup, or paste one).`
      : midwayLive
        ? `CLI ${version.stdout.trim()} ready. App "${harmonyAppName()}" deploys on the next publish.`
        : `CLI ${version.stdout.trim()} ready — but the CLI's Midway session is missing/expired. Run mwinit -o in any terminal before publishing (browser Midway is separate).`;
  return { cliPresent, cliVersion: cliPresent ? version.stdout.trim() : undefined, bindleConfigured, midwayLive, ready, nextAction, detail };
}

/** One-click CLI install (the 99% path: harmony is missing on first setup). */
export async function installHarmonyCli(exec: ExecFn = defaultExec): Promise<{ ok: boolean; detail: string }> {
  const probe = await exec('harmony', ['--version'], { timeoutMs: 20_000 });
  if (probe.code === 0) return { ok: true, detail: `Harmony CLI already installed (${probe.stdout.trim()}).` };
  const result = await exec('toolbox', ['install', 'harmonycli'], { timeoutMs: INSTALL_TIMEOUT_MS });
  if (result.code !== 0) {
    const text = `${result.stdout}\n${result.stderr}`;
    if (/command not found|ENOENT/i.test(text)) {
      return { ok: false, detail: 'toolbox is not installed on this machine. Install Amazon Toolbox first (https://docs.hub.amazon.dev/builder-toolbox/user-guide/getting-started/), then retry.' };
    }
    return { ok: false, detail: `toolbox install harmonycli failed: ${text.trim().slice(0, 400) || 'no output'}` };
  }
  const verify = await exec('harmony', ['--version'], { timeoutMs: 20_000 });
  return verify.code === 0
    ? { ok: true, detail: `Harmony CLI installed (${verify.stdout.trim()}).` }
    : { ok: false, detail: 'toolbox reported success but `harmony --version` still fails — open a new terminal-free retry, or check toolbox PATH setup.' };
}

/** Public viewer URL for a dashboard on the configured stage. Apps created
 * since Oct 2025 are SUBDOMAIN-served — the classic console path answers
 * "app doesn't exist" for them (owner live-fire 2026-09-09). */
export function harmonyDashboardUrl(settings: HarmonySettings, dashboardId: string, appName: string = harmonyAppName()): string {
  const base = settings.stage === 'prod'
    ? `https://${appName}.harmony.a2z.com`
    : `https://${appName}.${settings.stage}.harmony.a2z.com`;
  return `${base}/d/${encodeURIComponent(dashboardId)}/`;
}

/** Stable public URL for a non-dashboard static artifact in the same owner app. */
export function harmonyStaticArtifactUrl(settings: HarmonySettings, slug: string, appName: string = harmonyAppName()): string {
  const base = settings.stage === 'prod'
    ? `https://${appName}.harmony.a2z.com`
    : `https://${appName}.${settings.stage}.harmony.a2z.com`;
  return `${base}/a/${encodeURIComponent(slug)}/`;
}

function renderListingPage(entries: PublishedEntry[]): string {
  const items = entries
    .slice()
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .map(entry => `<article class="widget"><header><div><span>dashboard</span><h2><a href="d/${escapeHtml(encodeURIComponent(entry.dashboardId))}/">${escapeHtml(entry.title)}</a></h2>${entry.description ? `<p>${escapeHtml(entry.description)}</p>` : ''}</div></header><footer>Published ${escapeHtml(new Date(entry.publishedAt).toLocaleString())}</footer></article>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>BotBoy Dashboards</title><link rel="stylesheet" href="assets/style.css"></head><body><main><header><span class="snapshot">BotBoy dashboards</span><h1>Shared dashboards</h1><p>Interactive snapshots published from a local BotBoy workspace.</p></header><section class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">${items || '<div class="empty">Nothing published yet.</div>'}</section></main></body></html>`;
}

/** Does the app already exist on this stage? Decides `--parentBindleId` on
 * first deploy. CLI 1.8.x: `display-versions` takes `-s <stage>` only (no
 * `--app-name` — the app comes from the cwd's metadata) and prints its
 * usage with exit 0 on unknown flags, so success = version lines present,
 * not exit code (owner live-fire 2026-09-09). */
async function appExists(appRoot: string, stage: string, exec: ExecFn): Promise<{ exists: boolean; raw: ExecResult }> {
  const result = await exec('harmony', ['app', 'display-versions', '-s', stage], { cwd: appRoot, timeoutMs: 60_000 });
  const usageOnly = /Usage:/i.test(result.stdout) && !/live version|deployed/i.test(result.stdout);
  const notFound = /not found|does not exist|no such app|no deployed versions/i.test(`${result.stdout}\n${result.stderr}`);
  return { exists: result.code === 0 && !usageOnly && !notFound, raw: result };
}

/**
 * Package the asset tree into app.tar EXACTLY as the CLI's validator demands
 * (learned live 2026-09-09, taught by the validator itself): entries under an
 * `app/` prefix — NO leading `./` (the check is an exact string match on
 * `app/.harmony/harmony-metadata.json`) — with the `.harmony` metadata folder
 * INSIDE the tar (Harmony registers the app from it). We always deploy with
 * `-B`: BotBoy's assets are pre-built; the CLI's npm build pipeline is for
 * framework apps and demands scripts we don't have.
 */
async function buildAppTar(appRoot: string, assetRoot: string, exec: ExecFn): Promise<void> {
  const stage = path.join(appRoot, '.tar-stage');
  const stagedApp = path.join(stage, 'app');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stagedApp, { recursive: true });
  fs.cpSync(assetRoot, stagedApp, { recursive: true });
  fs.cpSync(path.join(appRoot, '.harmony'), path.join(stagedApp, '.harmony'), { recursive: true });
  const result = await exec('tar', ['-cf', 'app.tar', '-C', '.tar-stage', 'app'], { cwd: appRoot, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`packaging app.tar failed: ${result.stderr.trim().slice(0, 300) || 'tar error'}`);
}

/**
 * Prod deploys demand a real terminal. /usr/bin/expect (ships with macOS)
 * gives the CLI a PTY and answers ONLY a deploy-confirmation prompt; any
 * other prompt hits the hard timeout and fails with the transcript.
 */
function buildProdExpectScript(appRoot: string, deployArgs: string[]): string {
  // deployArgs are BotBoy-built (fixed flags + a validated bindle id) — never raw user text.
  const script = `set timeout ${Math.floor(DEPLOY_TIMEOUT_MS / 1000)}
log_user 1
spawn harmony ${deployArgs.join(' ')}
expect {
  -re {(\\[y/N\\]|\\[Y/n\\]|\\(y/N\\)|yes/no|proceed\\?|deploy to prod)} { send "y\\r"; exp_continue }
  timeout { exit 124 }
  eof
}
catch wait result
exit [lindex $result 3]
`;
  const scriptPath = path.join(appRoot, '.botboy-prod-deploy.expect');
  fs.writeFileSync(scriptPath, script);
  return scriptPath;
}

async function deployHarmonyAssetTree(options: {
  settings: HarmonySettings;
  appRoot: string;
  assetRoot: string;
  appName: string;
  exec: ExecFn;
  ensureViewerAccess?: (context: { appName: string; settings: HarmonySettings }) => Promise<void>;
}): Promise<void> {
  const probe = await probeHarmony(options.settings, options.exec);
  if (!probe.ready) throw new Error(probe.detail);

  await buildAppTar(options.appRoot, options.assetRoot, options.exec);
  const existing = await appExists(options.appRoot, options.settings.stage, options.exec);
  const deployArgs = ['app', 'deploy', '--stage', options.settings.stage, '-B'];
  if (!existing.exists) deployArgs.push('--parentBindleId', options.settings.bindleId);

  const deploy = options.settings.stage === 'prod'
    ? await options.exec('/usr/bin/expect', [buildProdExpectScript(options.appRoot, deployArgs)], { cwd: options.appRoot, timeoutMs: DEPLOY_TIMEOUT_MS + 30_000 })
    : await options.exec('harmony', deployArgs, { cwd: options.appRoot, timeoutMs: DEPLOY_TIMEOUT_MS });
  if (deploy.code !== 0) throw new Error(classifyHarmonyFailure(deploy.stdout, deploy.stderr));

  if (options.ensureViewerAccess) {
    await options.ensureViewerAccess({ appName: options.appName, settings: options.settings });
  }
}

/**
 * Stage the bundle + listing into the app tree and deploy; then converge
 * viewer access to the configured visibility (injected transport). Returns
 * the dashboard's viewer URL. The caller (publisher service) owns publication
 * rows, tokens, and error persistence.
 */
export async function publishToHarmony(options: {
  settings: HarmonySettings;
  dashboard: AnalyticsDashboard;
  snapshotCreatedAt: string;
  /** All dashboards that should exist in the app (incl. this one) for the listing page. */
  publishedEntries: PublishedEntry[];
  vendorDir?: string;
  /** Test injection points. */
  appName?: string;
  appRoot?: string;
  exec?: ExecFn;
  /** Converge Can-view-app rows to settings.visibility (task 1c″ wires the real transport). */
  ensureViewerAccess?: (context: { appName: string; settings: HarmonySettings }) => Promise<void>;
}): Promise<{ url: string }> {
  const { settings, dashboard } = options;
  const exec = options.exec ?? defaultExec;

  const { appRoot, assetRoot, appName } = scaffoldHarmonyApp(settings, { appName: options.appName, appRoot: options.appRoot });
  const bundle = renderDashboardBundle(dashboard, options.snapshotCreatedAt, { vendorDir: options.vendorDir });
  const dashboardDir = path.join(assetRoot, 'd', dashboard.id);
  fs.rmSync(dashboardDir, { recursive: true, force: true });
  fs.mkdirSync(dashboardDir, { recursive: true });
  writeBundle(bundle, dashboardDir);
  // Shared stylesheet + listing at the app root (listing links use it).
  fs.mkdirSync(path.join(assetRoot, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(assetRoot, 'assets', 'style.css'), SNAPSHOT_CSS);
  fs.writeFileSync(path.join(assetRoot, 'index.html'), renderListingPage(options.publishedEntries));

  await deployHarmonyAssetTree({
    settings,
    appRoot,
    assetRoot,
    appName,
    exec,
    ensureViewerAccess: options.ensureViewerAccess,
  });

  return { url: harmonyDashboardUrl(settings, dashboard.id, appName) };
}

/**
 * Stage an already-built static HTML artifact under a/<slug>/ in the same
 * owner app, then ride the exact dashboard tar/deploy/audience path.
 */
export async function publishStaticArtifactToHarmony(options: {
  settings: HarmonySettings;
  bundle: StaticArtifactBundle;
  appName?: string;
  appRoot?: string;
  exec?: ExecFn;
  ensureViewerAccess?: (context: { appName: string; settings: HarmonySettings }) => Promise<void>;
}): Promise<{ url: string; appName: string; artifactPath: string }> {
  const exec = options.exec ?? defaultExec;
  const { appRoot, assetRoot, appName } = scaffoldHarmonyApp(options.settings, {
    appName: options.appName,
    appRoot: options.appRoot,
  });
  const artifactPath = path.join(assetRoot, 'a', options.bundle.slug);
  writeStaticArtifactBundle(options.bundle, artifactPath);

  await deployHarmonyAssetTree({
    settings: options.settings,
    appRoot,
    assetRoot,
    appName,
    exec,
    ensureViewerAccess: options.ensureViewerAccess,
  });

  return {
    url: harmonyStaticArtifactUrl(options.settings, options.bundle.slug, appName),
    appName,
    artifactPath,
  };
}
