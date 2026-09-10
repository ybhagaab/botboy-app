/**
 * Harmony identity provisioning + viewer-access converger (plan §5, 1c″).
 *
 * Mints the deploy identity each BotBoy instance needs — a single-member
 * Amazon Team and a team-owned software-app bindle — and converges the
 * published app's viewer audience to the configured visibility toggle.
 *
 * Every wire shape below was pinned against LIVE systems on 2026-09-09
 * (CDP probes in the owner's Chrome; see DASHBOARD_SHARING_PLAN §5):
 *   - Atlantis GraphQL (prod.proxy.atlantis.permissions.a2z.com/graphql,
 *     header x-module-id: teams-ui, same-origin fetch from the proxy origin):
 *     createTeam/updateTeamOverrides/evaluateTeam all take (input: …Input!);
 *     CreateTeamInput.secondaryOwnerAliases is OPTIONAL (single-owner teams
 *     are schema-legal) and addOverrides rides team creation.
 *   - BindleService Coral envelope (POST https://bindle-service-sso.amazon.com/
 *     {Service, Operation, Input}) — DescribeResource round-tripped 200.
 *   - The "Can view app" audience row on a HarmonyApp resource, verbatim:
 *     { op: 'Can view app', ns: 'harmony', rtype: 'HarmonyApp',
 *       actor_id: 'amzn1.bindle.actor-type.principal',
 *       actor_type_id: 'amzn1.bindle.actor-type.public', actor_name: 'All People' }.
 *
 * Transport: the owner's debug Chrome (CDP 9222) — navigate a scratch tab to
 * the target host (Midway rides the owner's live session), then SAME-ORIGIN
 * fetch. No credentials ever touch BotBoy. Writes go only to the three
 * allowlisted hosts below. Idempotent: every create is preceded by a lookup.
 */

import type { HarmonyPublisherSettings } from './analytics-types.js';
import { harmonyAppName, harmonyOwnerAlias } from './publish-harmony.js';

// ── Wire constants (probe-pinned) ──
const GRAPHQL_ORIGIN = 'https://prod.proxy.atlantis.permissions.a2z.com';
const BINDLE_ORIGIN = 'https://bindle-service-sso.amazon.com';
const BINDLES_WEBSITE = 'https://bindles.amazon.com';
const BINDLE_SERVICE = 'com.amazon.bindle.coral.calls#BindleService';
const ALL_PEOPLE_ACTOR = { actorId: 'amzn1.bindle.actor-type.principal', actorType: 'amzn1.bindle.actor-type.public' };
const TEAM_ACTOR_TYPE = 'amzn1.bindle.actor-type.team';
const CAN_VIEW_APP = 'Can view app';

/** Injectable transport so the provisioning logic is unit-testable without Chrome. */
export interface ProvisionTransport {
  graphql(query: string, variables: Record<string, unknown>): Promise<any>;
  coral(operation: string, input: Record<string, unknown>): Promise<any>;
  /** Permission rows of a bindle resource (bindles.amazon.com website JSON). */
  readPermissions(resourceId: string): Promise<Array<{ op: string; ns: string; actorTypeId: string; actorId: string }>>;
  /** Hash one or more authenticated URLs in a single browser tab. */
  readUrlHashes(urls: string[]): Promise<Array<{ requestedUrl: string; responseUrl: string; status: number; bytes: number; sha256: string }>>;
  /** The user's manager login from PhoneTool (Teams REQUIRES a secondary owner — live-fire 2026-09-09). */
  managerAlias(alias: string): Promise<string | null>;
  /** CTI borrowed from the user's first CTI-bearing team (bindles REQUIRE a CTI — live-fire 2026-09-09). */
  firstTeamCti(alias: string): Promise<{ category: string; type: string; item: string; resolverGroup?: string } | null>;
}

export interface HarmonyViewerAccessReceipt {
  resourceId: string;
  owningTeamId: string;
  visibility: HarmonyPublisherSettings['visibility'];
  changed: boolean;
  verified: true;
}

export interface HarmonyArtifactVerificationReceipt {
  verified: true;
  files: Array<{ relativePath: string; bytes: number; sha256: string; status: number; responseUrl: string }>;
}

export interface HarmonyRetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ProvisioningPlan {
  alias: string;
  teamName: string;
  bindleName: string;
  appName: string;
  summary: string;
}

export interface ProvisionResult {
  teamId: string;
  bindleId: string;
  teamName: string;
  bindleName: string;
  createdTeam: boolean;
  createdBindle: boolean;
  detail: string;
}

export function provisioningPlan(alias: string = harmonyOwnerAlias()): ProvisioningPlan {
  const cleaned = alias.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'botboy-user';
  const capitalized = cleaned.replace(/(^|-)([a-z])/g, (_m, _d, c) => c.toUpperCase());
  const teamName = `botboy-dash-${cleaned}`;
  const bindleName = `BotboyDashboards${capitalized}`;
  return {
    alias,
    teamName,
    bindleName,
    appName: harmonyAppName(alias),
    summary: `Creates Amazon Team "${teamName}" (you are the owner and only member; your manager is listed as secondary owner — a Teams requirement, ownership only, not membership) and software-app bindle "${bindleName}" owned by it. Both are yours, not BotBoy's. The bindle binds PERMANENTLY to Harmony app "${harmonyAppName(alias)}" at first publish.`,
  };
}

function firstGraphqlError(payload: any): string | null {
  const errors = payload?.errors;
  if (Array.isArray(errors) && errors.length) return String(errors[0]?.message ?? 'GraphQL error');
  return null;
}

/** Next-action-bearing failures — a step name plus what to do about it. */
function fail(step: string, detail: string): never {
  throw new Error(`${step}: ${detail}`);
}

async function lookupTeamId(transport: ProvisionTransport, teamName: string): Promise<string | null> {
  const payload = await transport.graphql(
    'query($name: String!) { getTeamIdByTeamName(teamName: $name) { teamId } }',
    { name: teamName },
  );
  // "not found" comes back as an error — treat any error here as absence and let creation decide.
  return payload?.data?.getTeamIdByTeamName?.teamId ?? null;
}

async function lookupBindleId(transport: ProvisionTransport, bindleName: string): Promise<string | null> {
  try {
    const document = await transport.coral('DescribeResource', {
      resourceName: bindleName,
      resourceType: { namespaceName: 'Bindle', resourceTypeName: 'SoftwareApp' },
    });
    return document?.resourceId ?? null;
  } catch {
    return null; // absent (or unreadable) — creation will surface real failures
  }
}

/**
 * Idempotent identity chain: team → membership materialization → bindle.
 * Re-runs converge on existing resources; nothing is ever deleted or renamed.
 */
export async function provisionHarmonyIdentity(transport: ProvisionTransport, alias: string = harmonyOwnerAlias()): Promise<ProvisionResult> {
  const plan = provisioningPlan(alias);

  // 1 — Team (the user as owner+member; manager as secondary owner — the
  // service REJECTS zero secondary owners even though the schema allows it:
  // verbatim live-fire error "There must be at least one secondary owner").
  let teamId = await lookupTeamId(transport, plan.teamName);
  const createdTeam = !teamId;
  if (!teamId) {
    const manager = await transport.managerAlias(alias);
    if (!manager) {
      fail('create-team', `Teams requires a secondary owner and your manager could not be resolved from PhoneTool. Create the team by hand at https://permissions.amazon.com/a/team/new (name: ${plan.teamName}, secondary owner: your manager), then retry — BotBoy will pick it up.`);
    }
    const created = await transport.graphql(
      'mutation($input: CreateTeamInput!) { createTeam(input: $input) { teamId } }',
      {
        input: {
          id: alias,
          name: plan.teamName,
          description: `BotBoy dashboard publishing identity for ${alias}. Owns the ${plan.bindleName} bindle. Created by BotBoy with the owner's confirmation.`,
          primaryOwnerAlias: alias,
          secondaryOwnerAliases: [manager],
          // Membership gotcha (measured upstream): owner fields alone do NOT
          // materialize membership — an explicit ADD override does.
          addOverrides: [{ userAlias: alias, overrideAction: 'ADD', reason: 'BotBoy dashboard publishing (bindle-backed Harmony deploys)' }],
        },
      },
    );
    const error = firstGraphqlError(created);
    if (error) {
      fail('create-team', /NOT_AUTHORIZED|unauthoriz/i.test(error)
        ? `permissions.amazon.com rejected the caller — is Midway fresh in Chrome? (mwinit -o, reload a permissions page, retry). Raw: ${error}`
        : `${error} — you can also create the team by hand at https://permissions.amazon.com/a/team/new (name: ${plan.teamName})`);
    }
    teamId = created?.data?.createTeam?.teamId ?? null;
    if (!teamId) fail('create-team', 'createTeam returned no teamId — retry, or create it at https://permissions.amazon.com/a/team/new');
  }

  // 2 — Force membership recompute (BRASS answers false indefinitely otherwise).
  const evaluated = await transport.graphql(
    'mutation($input: EvaluateTeamInput!) { evaluateTeam(input: $input) { teamId } }',
    { input: { id: alias, teamId } },
  );
  const evalError = firstGraphqlError(evaluated);
  if (evalError && createdTeam) {
    // Non-fatal on re-runs (already materialized), fatal on first creation.
    fail('evaluate-team', `${evalError} — membership may not be active yet; open https://permissions.amazon.com/a/team/${teamId} and use "Sync now", then retry.`);
  }

  // 3 — Bindle owned by that team.
  let bindleId = await lookupBindleId(transport, plan.bindleName);
  const createdBindle = !bindleId;
  if (!bindleId) {
    // Bindles REQUIRE a CTI (live-fire verbatim: "Either useTeamCti or custom
    // CTI must be defined") and our fresh team deliberately has none — borrow
    // the CTI from the user's first CTI-bearing team membership. It is ticket
    // routing metadata on the bindle, nothing more.
    const cti = await transport.firstTeamCti(alias);
    if (!cti) {
      fail('create-bindle', `bindles require a CTI and none of your teams carries one. Create the bindle by hand at https://bindles.amazon.com/v2/software_app/new (owning team: ${plan.teamName}, CTI: pick your org's), then paste its ID.`);
    }
    const input = {
      requester: { login: alias },
      name: plan.bindleName,
      type: { namespaceName: 'Bindle', resourceTypeName: 'SoftwareApp' },
      description: `BotBoy dashboard publishing bindle for ${alias} (parent of the ${plan.appName} Harmony app).`,
      owningTeam: { teamId },
      contact: { cti },
    };
    try {
      const created = await transport.coral('CreateBindle', input);
      bindleId = created?.bindleId ?? null;
    } catch (error: any) {
      const message = String(error?.message ?? error);
      fail('create-bindle', /PermissionDenied|not authorized/i.test(message)
        ? `BindleService refused — team membership may still be propagating (60s, then retry), or create the bindle at https://bindles.amazon.com/v2/software_app/new (owning team: ${plan.teamName}). Raw: ${message}`
        : `${message} — manual path: https://bindles.amazon.com/v2/software_app/new (owning team: ${plan.teamName})`);
    }
    if (!bindleId) fail('create-bindle', 'CreateBindle returned no bindleId — retry, or create it at https://bindles.amazon.com/v2/software_app/new');
  }

  return {
    teamId,
    bindleId,
    teamName: plan.teamName,
    bindleName: plan.bindleName,
    createdTeam,
    createdBindle,
    detail: `${createdTeam ? 'Created' : 'Reusing'} team ${plan.teamName}; ${createdBindle ? 'created' : 'reusing'} bindle ${plan.bindleName} (${bindleId}).`,
  };
}

/**
 * Converge the app's viewer audience to the toggle — runs INSIDE every
 * publish (owner ruling): everyone → All People holds Can-view-app;
 * private → the owning single-member team holds it and All People does not.
 */
export async function ensureHarmonyViewerAccess(
  transport: ProvisionTransport,
  context: { appName: string; settings: HarmonyPublisherSettings },
  alias: string = harmonyOwnerAlias(),
  retry: HarmonyRetryOptions = {},
): Promise<HarmonyViewerAccessReceipt> {
  const { appName, settings } = context;
  const maxAttempts = Math.max(1, retry.maxAttempts ?? 5);
  const delayMs = Math.max(0, retry.delayMs ?? 1_500);
  const sleep = retry.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let app: any;
  let discoveryError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const candidate = await transport.coral('DescribeResource', {
        resourceName: appName,
        resourceType: { namespaceName: 'harmony', resourceTypeName: 'HarmonyApp' },
      });
      if (candidate?.resourceId) {
        app = candidate;
        break;
      }
      discoveryError = 'DescribeResource returned no resourceId';
    } catch (error: any) {
      discoveryError = String(error?.message ?? error);
    }
    if (attempt < maxAttempts) await sleep(delayMs * attempt);
  }
  if (!app?.resourceId) {
    fail('viewer-access', `could not discover Harmony app "${appName}" after ${maxAttempts} attempt(s). Last error: ${discoveryError.slice(0, 400)}. Browser fallback: open https://bindles.amazon.com/resource/harmony/HarmonyApp/${appName}, repair Can view app if needed, then retry the same publish call (it resumes without redeploying).`);
  }

  const resourceId = String(app.resourceId);
  const owningTeamId = String(app?.owningTeam?.teamId ?? app?.owner?.owningTeam?.teamId ?? '');
  if (settings.visibility === 'private' && !owningTeamId) {
    fail('viewer-access', `Harmony app ${resourceId} has no owning team id; refusing to remove All People until a private owner grant can be verified.`);
  }

  const readViewRows = async (): Promise<Array<{ op: string; ns: string; actorTypeId: string; actorId: string }>> => {
    let lastError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return (await transport.readPermissions(resourceId)).filter(row => row.ns === 'harmony' && row.op === CAN_VIEW_APP);
      } catch (error: any) {
        lastError = String(error?.message ?? error);
        if (attempt < maxAttempts) await sleep(delayMs * attempt);
      }
    }
    fail('viewer-access', `could not read permissions for ${resourceId}: ${lastError.slice(0, 400)}. Browser fallback: https://bindles.amazon.com/resource/${resourceId}`);
  };

  const hasAllPeople = (rows: Array<{ actorTypeId: string; actorId: string }>) =>
    rows.some(row => row.actorTypeId === ALL_PEOPLE_ACTOR.actorType && row.actorId === ALL_PEOPLE_ACTOR.actorId);
  const hasTeam = (rows: Array<{ actorTypeId: string; actorId: string }>) =>
    rows.some(row => row.actorTypeId === TEAM_ACTOR_TYPE && row.actorId === owningTeamId);
  const permission = (actor: { actorId: string; actorType: string }) => ({
    requester: { login: alias },
    resource: { resourceId },
    permission: {
      actorId: actor.actorId,
      actorType: actor.actorType,
      permissionNamespace: 'harmony',
      permissionResourceType: 'HarmonyApp',
      permissionOperation: [CAN_VIEW_APP],
    },
  });

  let rows = await readViewRows();
  let changed = false;
  try {
    if (settings.visibility === 'everyone') {
      if (!hasAllPeople(rows)) {
        await transport.coral('GrantPermission', permission(ALL_PEOPLE_ACTOR));
        changed = true;
      }
    } else {
      if (!hasTeam(rows)) {
        await transport.coral('GrantPermission', permission({ actorId: owningTeamId, actorType: TEAM_ACTOR_TYPE }));
        changed = true;
      }
      if (hasAllPeople(rows)) {
        await transport.coral('RevokePermission', permission(ALL_PEOPLE_ACTOR));
        changed = true;
      }
    }
  } catch (error: any) {
    fail('viewer-access', `could not converge "Can view app" to "${settings.visibility}" — repair it at https://bindles.amazon.com/resource/${resourceId} (Custom Permissions → Harmony App Permissions), then retry the same publish call. Raw: ${String(error?.message ?? error).slice(0, 300)}`);
  }

  let verified = false;
  let verificationError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      rows = (await transport.readPermissions(resourceId)).filter(row => row.ns === 'harmony' && row.op === CAN_VIEW_APP);
      verified = settings.visibility === 'everyone'
        ? hasAllPeople(rows)
        : hasTeam(rows) && !hasAllPeople(rows);
      verificationError = verified ? '' : 'desired permission row state is not visible yet';
    } catch (error: any) {
      verificationError = String(error?.message ?? error);
    }
    if (verified) break;
    if (attempt < maxAttempts) await sleep(delayMs * attempt);
  }
  if (!verified) {
    fail('viewer-access', `permission write completed but "${settings.visibility}" was not observable after ${maxAttempts} verification attempt(s). Last observation: ${verificationError.slice(0, 300)}. Repair/verify at https://bindles.amazon.com/resource/${resourceId}, then retry the same publish call.`);
  }
  return { resourceId, owningTeamId, visibility: settings.visibility, changed, verified: true };
}

export async function verifyHarmonyArtifactContent(
  transport: ProvisionTransport,
  context: {
    url: string;
    files: Array<{ relativePath: string; bytes: number; sha256: string }>;
  },
  retry: HarmonyRetryOptions = {},
): Promise<HarmonyArtifactVerificationReceipt> {
  const maxAttempts = Math.max(1, retry.maxAttempts ?? 5);
  const delayMs = Math.max(0, retry.delayMs ?? 1_500);
  const sleep = retry.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const base = context.url.endsWith('/') ? context.url : `${context.url}/`;
  let lastDetail = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const nonce = `${Date.now()}-${attempt}`;
      const requested = context.files.map(file => `${new URL(file.relativePath, base).toString()}?botboy_verify=${nonce}`);
      const observed = await transport.readUrlHashes(requested);
      const byRequested = new Map(observed.map(row => [row.requestedUrl, row]));
      const verifiedFiles = context.files.map((file, index) => {
        const row = byRequested.get(requested[index]);
        if (!row) throw new Error(`no response for ${file.relativePath}`);
        if (row.status !== 200 || row.bytes !== file.bytes || row.sha256 !== file.sha256) {
          throw new Error(`${file.relativePath}: expected 200/${file.bytes}/${file.sha256}, observed ${row.status}/${row.bytes}/${row.sha256}`);
        }
        return { relativePath: file.relativePath, bytes: row.bytes, sha256: row.sha256, status: row.status, responseUrl: row.responseUrl };
      });
      return { verified: true, files: verifiedFiles };
    } catch (error: any) {
      lastDetail = String(error?.message ?? error);
      if (attempt < maxAttempts) await sleep(delayMs * attempt);
    }
  }
  fail('content-verification', `deployed artifact did not match its bundle after ${maxAttempts} attempt(s): ${lastDetail.slice(0, 500)}. Browser fallback: open ${context.url} with browser_hands, verify it loads, then retry the same publish call.`);
}

// ── CDP transport (runtime implementation; tests inject a scripted one) ──

const PHONETOOL_ORIGIN = 'https://phonetool.amazon.com';
const ALLOWED_ORIGINS = [GRAPHQL_ORIGIN, BINDLE_ORIGIN, BINDLES_WEBSITE, PHONETOOL_ORIGIN];
const CDP_ENDPOINT = 'http://127.0.0.1:9222';

function isAllowedInternalOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && (url.hostname === 'harmony.a2z.com' || url.hostname.endsWith('.harmony.a2z.com'));
  } catch {
    return false;
  }
}

async function cdpHttp(pathname: string, method: 'GET' | 'PUT' = 'GET'): Promise<any> {
  const response = await fetch(`${CDP_ENDPOINT}${pathname}`, { method });
  const text = await response.text();
  if (!response.ok) throw new Error(`CDP ${pathname}: HTTP ${response.status}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function withInternalTab<T>(origin: string, landingPath: string, run: (evaluate: (expression: string) => Promise<any>) => Promise<T>): Promise<T> {
  if (!isAllowedInternalOrigin(origin)) throw new Error(`origin ${origin} is not on the provisioning allowlist`);
  try {
    await cdpHttp('/json/version');
  } catch {
    throw new Error('debug Chrome (CDP 9222) is unreachable — provisioning and viewer-access changes ride the owner\u2019s browser session');
  }
  const { default: WebSocket } = await import('ws');
  let tab: any;
  try { tab = await cdpHttp('/json/new?about:blank', 'PUT'); } catch { tab = await cdpHttp('/json/new?about:blank', 'GET'); }
  if (!tab?.webSocketDebuggerUrl) throw new Error('CDP scratch tab has no debugger URL');

  const ws: any = new (WebSocket as any)(tab.webSocketDebuggerUrl);
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
  });
  ws.on('message', (raw: unknown) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.id && pending.has(msg.id)) {
        const entry = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message)); else entry.resolve(msg.result);
      }
    } catch { /* non-JSON frame */ }
  });
  const send = (method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }, timeoutMs);
      pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  try {
    await send('Runtime.enable');
    await send('Page.enable').catch(() => undefined);
    await send('Page.navigate', { url: `${origin}${landingPath}` });
    // Wait out load + the Midway redirect chain, then REQUIRE the requested
    // origin. The old path fell through after 45s and attempted a cross-origin
    // fetch, collapsing auth/origin failures into an opaque "Failed to fetch".
    const startedAt = Date.now();
    let finalUrl = '';
    let reachedOrigin = false;
    while (Date.now() - startedAt < 45_000) {
      const state = await send('Runtime.evaluate', { expression: "document.readyState + '|' + location.href", returnByValue: true }, 5_000).catch(() => null);
      const value = String(state?.result?.value ?? '');
      const separator = value.indexOf('|');
      const readyState = separator >= 0 ? value.slice(0, separator) : '';
      finalUrl = separator >= 0 ? value.slice(separator + 1) : '';
      let currentOrigin = '';
      try { currentOrigin = new URL(finalUrl).origin; } catch { /* mid-navigation */ }
      if (readyState === 'complete' && currentOrigin === origin) {
        reachedOrigin = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, value.includes('midway-auth') ? 1_000 : 750));
    }
    if (!reachedOrigin) {
      throw new Error(`[AUTH_ORIGIN_TIMEOUT] expected ${origin} after browser authentication, final URL was ${finalUrl || 'unknown'}`);
    }
    const evaluate = async (expression: string): Promise<any> => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 60_000);
      if (result?.exceptionDetails) throw new Error(`page evaluation failed: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`);
      return result?.result?.value;
    };
    return await run(evaluate);
  } finally {
    try { ws.close(); } catch { /* closed */ }
    await cdpHttp(`/json/close/${tab.id}`).catch(() => undefined);
  }
}

function checkedBrowserFetch(value: any, label: string): string {
  if (value?.fetchError) {
    throw new Error(`[FETCH_FAILED] ${label}: ${String(value.fetchError)} (page ${String(value.pageUrl ?? 'unknown')})`);
  }
  if (!value || typeof value.status !== 'number') {
    throw new Error(`[FETCH_INVALID] ${label}: browser returned no structured response`);
  }
  if (!value.ok) {
    throw new Error(`[HTTP_${value.status}] ${label}: ${String(value.text ?? '').slice(0, 300)} (response ${String(value.url ?? 'unknown')})`);
  }
  return String(value.text ?? '');
}

export function createCdpProvisionTransport(): ProvisionTransport {
  return {
    async graphql(query, variables) {
      return withInternalTab(GRAPHQL_ORIGIN, '/graphql', async evaluate => {
        const body = JSON.stringify({ query, variables });
        const response = await evaluate(`
          fetch('${GRAPHQL_ORIGIN}/graphql', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'x-module-id': 'teams-ui' },
            body: ${JSON.stringify(body)}
          }).then(async r => ({ ok: r.ok, status: r.status, url: r.url, text: await r.text() }))
            .catch(e => ({ fetchError: String(e), pageUrl: location.href }))
        `);
        const raw = checkedBrowserFetch(response, 'Atlantis GraphQL');
        try { return JSON.parse(String(raw)); } catch { throw new Error(`Atlantis GraphQL returned non-JSON: ${String(raw).slice(0, 200)}`); }
      });
    },
    async coral(operation, input) {
      return withInternalTab(BINDLE_ORIGIN, '/', async evaluate => {
        const body = JSON.stringify({ Service: BINDLE_SERVICE, Operation: `${BINDLE_SERVICE.split('#')[0]}#${operation}`, Input: input });
        const response = await evaluate(`
          fetch('${BINDLE_ORIGIN}/', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: ${JSON.stringify(body)}
          }).then(async r => ({ ok: r.ok, status: r.status, url: r.url, text: await r.text() }))
            .catch(e => ({ fetchError: String(e), pageUrl: location.href }))
        `);
        const raw = checkedBrowserFetch(response, `BindleService ${operation}`);
        let document: any;
        try { document = JSON.parse(String(raw)); } catch { throw new Error(`BindleService returned non-JSON: ${String(raw).slice(0, 200)}`); }
        if (document?.Output?.__type && /exception|denied|error/i.test(String(document.Output.__type))) {
          throw new Error(`${document.Output.__type}: ${document.Output.message ?? 'refused'}`);
        }
        if (document?.__type && /exception|denied|error/i.test(String(document.__type))) {
          throw new Error(`${document.__type}: ${document.message ?? 'refused'}`);
        }
        return document?.Output ?? document;
      });
    },
    async firstTeamCti(alias) {
      const query = 'query($login: ID!) { user(id: $login) { listTeamsForMember(input: {first: 50}) { edges { node { name cti { category type item resolverGroup } } } } } }';
      const payload = await this.graphql(query, { login: alias });
      const nodes: any[] = (payload?.data?.user?.listTeamsForMember?.edges ?? []).map((edge: any) => edge?.node);
      const hit = nodes.find(node => node?.cti?.category && node?.cti?.type && node?.cti?.item);
      if (!hit) return null;
      const { category, type, item, resolverGroup } = hit.cti;
      return { category, type, item, ...(resolverGroup ? { resolverGroup } : {}) };
    },
    async managerAlias(alias) {
      return withInternalTab(PHONETOOL_ORIGIN, `/users/${encodeURIComponent(alias)}`, async evaluate => {
        const raw = await evaluate(`
          fetch('/users/${encodeURIComponent(alias)}.json', { credentials: 'include', headers: { 'Accept': 'application/json' } })
            .then(r => r.text())
        `);
        try {
          const document = JSON.parse(String(raw));
          const manager = String(document?.manager?.login ?? '').trim();
          return manager || null;
        } catch {
          return null; // PhoneTool unreadable → caller fails with the manual-team next action
        }
      });
    },
    async readPermissions(resourceId) {
      return withInternalTab(BINDLES_WEBSITE, `/resource/${encodeURIComponent(resourceId)}`, async evaluate => {
        const response = await evaluate(`
          fetch('/resource/${encodeURIComponent(resourceId)}/permissions.json', {
            credentials: 'include', headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
          }).then(async r => ({ ok: r.ok, status: r.status, url: r.url, text: await r.text() }))
            .catch(e => ({ fetchError: String(e), pageUrl: location.href }))
        `);
        const raw = checkedBrowserFetch(response, `permissions for ${resourceId}`);
        let document: any;
        try { document = JSON.parse(String(raw)); } catch { throw new Error(`permissions.json returned non-JSON: ${String(raw).slice(0, 160)}`); }
        return (document?.permissions ?? []).map((row: any) => ({
          op: String(row?.permission_operation ?? ''),
          ns: String(row?.permission_namespace ?? ''),
          actorTypeId: String(row?.actor?.actor_type_id ?? ''),
          actorId: String(row?.actor?.actor_id ?? ''),
        }));
      });
    },
    async readUrlHashes(urls) {
      if (!urls.length) return [];
      const parsed = urls.map(value => new URL(value));
      const origin = parsed[0].origin;
      if (!isAllowedInternalOrigin(origin) || parsed.some(url => url.origin !== origin || url.username || url.password)) {
        throw new Error('artifact verification URLs must share one allowlisted HTTPS origin');
      }
      return withInternalTab(origin, `${parsed[0].pathname}${parsed[0].search}`, async evaluate => {
        const result = await evaluate(`
          Promise.all(${JSON.stringify(urls)}.map(async requestedUrl => {
            try {
              const response = await fetch(requestedUrl, { credentials: 'include', cache: 'reload' });
              const bytes = await response.arrayBuffer();
              const digest = await crypto.subtle.digest('SHA-256', bytes);
              const sha256 = Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');
              return { requestedUrl, responseUrl: response.url, status: response.status, bytes: bytes.byteLength, sha256 };
            } catch (error) {
              return { requestedUrl, fetchError: String(error), pageUrl: location.href };
            }
          }))
        `);
        if (!Array.isArray(result)) throw new Error('[FETCH_INVALID] artifact verification returned no result array');
        const failed = result.find((row: any) => row?.fetchError);
        if (failed) throw new Error(`[FETCH_FAILED] artifact verification: ${failed.fetchError} (page ${failed.pageUrl ?? 'unknown'})`);
        return result;
      });
    },
  };
}
