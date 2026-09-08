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
  /** The user's manager login from PhoneTool (Teams REQUIRES a secondary owner — live-fire 2026-09-09). */
  managerAlias(alias: string): Promise<string | null>;
  /** CTI borrowed from the user's first CTI-bearing team (bindles REQUIRE a CTI — live-fire 2026-09-09). */
  firstTeamCti(alias: string): Promise<{ category: string; type: string; item: string; resolverGroup?: string } | null>;
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
): Promise<void> {
  const { appName, settings } = context;
  let app: any;
  try {
    app = await transport.coral('DescribeResource', {
      resourceName: appName,
      resourceType: { namespaceName: 'harmony', resourceTypeName: 'HarmonyApp' },
    });
  } catch (error: any) {
    fail('viewer-access', `the Harmony app resource "${appName}" was not found after deploy (${String(error?.message ?? error).slice(0, 200)}). Check https://bindles.amazon.com/resource/harmony/HarmonyApp/${appName} and re-publish.`);
  }
  const resourceId = app?.resourceId;
  const owningTeamId = app?.owningTeam?.teamId ?? app?.owner?.owningTeam?.teamId ?? '';
  if (!resourceId) fail('viewer-access', `DescribeResource returned no id for harmony/HarmonyApp/${appName}`);

  const rows = await transport.readPermissions(resourceId);
  const viewRows = rows.filter(row => row.ns === 'harmony' && row.op === CAN_VIEW_APP);
  const hasAllPeople = viewRows.some(row => row.actorTypeId === ALL_PEOPLE_ACTOR.actorType);
  const hasTeam = viewRows.some(row => row.actorTypeId === TEAM_ACTOR_TYPE && row.actorId === owningTeamId);

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

  try {
    if (settings.visibility === 'everyone') {
      if (!hasAllPeople) await transport.coral('GrantPermission', permission(ALL_PEOPLE_ACTOR));
    } else {
      // private = only the publisher (via their single-member team)
      if (owningTeamId && !hasTeam) await transport.coral('GrantPermission', permission({ actorId: owningTeamId, actorType: TEAM_ACTOR_TYPE }));
      if (hasAllPeople) await transport.coral('RevokePermission', permission(ALL_PEOPLE_ACTOR));
    }
  } catch (error: any) {
    fail('viewer-access', `could not converge "Can view app" to "${settings.visibility}" — add/remove it by hand at https://bindles.amazon.com/resource/${resourceId} (Custom Permissions → Harmony App Permissions). Raw: ${String(error?.message ?? error).slice(0, 300)}`);
  }
}

// ── CDP transport (runtime implementation; tests inject a scripted one) ──

const PHONETOOL_ORIGIN = 'https://phonetool.amazon.com';
const ALLOWED_ORIGINS = [GRAPHQL_ORIGIN, BINDLE_ORIGIN, BINDLES_WEBSITE, PHONETOOL_ORIGIN];
const CDP_ENDPOINT = 'http://127.0.0.1:9222';

async function cdpHttp(pathname: string, method: 'GET' | 'PUT' = 'GET'): Promise<any> {
  const response = await fetch(`${CDP_ENDPOINT}${pathname}`, { method });
  const text = await response.text();
  if (!response.ok) throw new Error(`CDP ${pathname}: HTTP ${response.status}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function withInternalTab<T>(origin: string, landingPath: string, run: (evaluate: (expression: string) => Promise<any>) => Promise<T>): Promise<T> {
  if (!ALLOWED_ORIGINS.includes(origin)) throw new Error(`origin ${origin} is not on the provisioning allowlist`);
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
    // Wait out load + the Midway redirect chain.
    const startedAt = Date.now();
    while (Date.now() - startedAt < 45_000) {
      const state = await send('Runtime.evaluate', { expression: "document.readyState + '|' + location.href", returnByValue: true }, 5_000).catch(() => null);
      const value = String(state?.result?.value ?? '');
      if (value.startsWith('complete|') && value.includes(new URL(origin).host)) break;
      if (value.includes('midway-auth')) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, 750));
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

export function createCdpProvisionTransport(): ProvisionTransport {
  return {
    async graphql(query, variables) {
      return withInternalTab(GRAPHQL_ORIGIN, '/graphql', async evaluate => {
        const body = JSON.stringify({ query, variables });
        const raw = await evaluate(`
          fetch('${GRAPHQL_ORIGIN}/graphql', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'x-module-id': 'teams-ui' },
            body: ${JSON.stringify(body)}
          }).then(r => r.text())
        `);
        try { return JSON.parse(String(raw)); } catch { throw new Error(`Atlantis GraphQL returned non-JSON: ${String(raw).slice(0, 200)}`); }
      });
    },
    async coral(operation, input) {
      return withInternalTab(BINDLE_ORIGIN, '/', async evaluate => {
        const body = JSON.stringify({ Service: BINDLE_SERVICE, Operation: `${BINDLE_SERVICE.split('#')[0]}#${operation}`, Input: input });
        const raw = await evaluate(`
          fetch('${BINDLE_ORIGIN}/', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: ${JSON.stringify(body)}
          }).then(r => r.text())
        `);
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
        const raw = await evaluate(`
          fetch('/resource/${encodeURIComponent(resourceId)}/permissions.json', {
            credentials: 'include', headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
          }).then(r => r.text())
        `);
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
  };
}
