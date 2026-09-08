/**
 * Harmony provisioning + viewer-access convergence (plan §5, 1c″).
 * Transport is scripted — the wire shapes themselves were pinned live
 * (2026-09-09 CDP probes); these tests hold the LOGIC to those shapes.
 */

import { describe, it, expect } from 'vitest';
import {
  ensureHarmonyViewerAccess,
  provisionHarmonyIdentity,
  provisioningPlan,
  type ProvisionTransport,
} from './harmony-provision.js';

const TEAM_ID = 'amzn1.abacus.team.abcdef1234567890';
const BINDLE_ID = 'amzn1.bindle.resource.abcdef1234567890';
const APP_RESOURCE = 'amzn1.bindle.resource.appappappapp1234';

interface Call { kind: 'graphql' | 'coral' | 'perms'; name: string; payload: any }

function transport(overrides: Partial<Record<string, (payload: any) => any>> = {}, rows: Array<{ op: string; ns: string; actorTypeId: string; actorId: string }> = []): { t: ProvisionTransport; calls: Call[] } {
  const calls: Call[] = [];
  const t: ProvisionTransport = {
    async managerAlias(alias) {
      calls.push({ kind: 'graphql', name: 'managerAlias', payload: alias });
      if (overrides.managerAlias) return overrides.managerAlias!(alias);
      return 'mgr';
    },
    async firstTeamCti(alias) {
      calls.push({ kind: 'graphql', name: 'firstTeamCti', payload: alias });
      if (overrides.firstTeamCti) return overrides.firstTeamCti!(alias);
      return { category: 'Website', type: 'MX Player', item: 'Team-SG', resolverGroup: 'MX-SG' };
    },
    async graphql(query, variables) {
      const name = query.includes('getTeamIdByTeamName') ? 'lookupTeam' : query.includes('createTeam') ? 'createTeam' : query.includes('evaluateTeam') ? 'evaluateTeam' : 'unknown';
      calls.push({ kind: 'graphql', name, payload: variables });
      if (overrides[name]) return overrides[name]!(variables);
      if (name === 'lookupTeam') return { data: { getTeamIdByTeamName: null } };
      if (name === 'createTeam') return { data: { createTeam: { teamId: TEAM_ID } } };
      if (name === 'evaluateTeam') return { data: { evaluateTeam: { teamId: TEAM_ID } } };
      return {};
    },
    async coral(operation, input) {
      calls.push({ kind: 'coral', name: operation, payload: input });
      if (overrides[operation]) return overrides[operation]!(input);
      if (operation === 'DescribeResource') throw new Error('NotFound');
      if (operation === 'CreateBindle') return { bindleId: BINDLE_ID };
      return {};
    },
    async readPermissions(resourceId) {
      calls.push({ kind: 'perms', name: 'read', payload: resourceId });
      return rows;
    },
  };
  return { t, calls };
}

describe('provisioning plan', () => {
  it('derives team/bindle/app names from the alias', () => {
    const plan = provisioningPlan('YBhagaab');
    expect(plan.teamName).toBe('botboy-dash-ybhagaab');
    expect(plan.bindleName).toBe('BotboyDashboardsYbhagaab');
    expect(plan.appName).toBe('ybhagaab-botboy-dashboard');
    expect(plan.summary).toContain('PERMANENTLY');
  });
});

describe('provisionHarmonyIdentity', () => {
  it('creates team (with membership override riding creation) then bindle', async () => {
    const { t, calls } = transport();
    const result = await provisionHarmonyIdentity(t, 'jdoe');
    expect(result).toMatchObject({ teamId: TEAM_ID, bindleId: BINDLE_ID, createdTeam: true, createdBindle: true });

    const createTeam = calls.find(call => call.name === 'createTeam')!;
    expect(createTeam.payload.input.primaryOwnerAlias).toBe('jdoe');
    // Teams REJECTS zero secondary owners (live-fire): manager rides as ownership-only secondary.
    expect(createTeam.payload.input.secondaryOwnerAliases).toEqual(['mgr']);
    expect(createTeam.payload.input.addOverrides).toEqual([expect.objectContaining({ userAlias: 'jdoe', overrideAction: 'ADD' })]);

    expect(calls.some(call => call.name === 'evaluateTeam')).toBe(true); // membership materialization
    const createBindle = calls.find(call => call.name === 'CreateBindle')!;
    expect(createBindle.payload.owningTeam).toEqual({ teamId: TEAM_ID });
    expect(createBindle.payload.name).toBe('BotboyDashboardsJdoe');
    // Bindles REQUIRE a CTI (live-fire): borrowed from the first CTI-bearing team membership.
    expect(createBindle.payload.contact).toEqual({ cti: { category: 'Website', type: 'MX Player', item: 'Team-SG', resolverGroup: 'MX-SG' } });
  });

  it('is idempotent: existing team and bindle are reused, nothing is created', async () => {
    const { t, calls } = transport({
      lookupTeam: () => ({ data: { getTeamIdByTeamName: { teamId: TEAM_ID } } }),
      DescribeResource: () => ({ resourceId: BINDLE_ID }),
    });
    const result = await provisionHarmonyIdentity(t, 'jdoe');
    expect(result).toMatchObject({ createdTeam: false, createdBindle: false, teamId: TEAM_ID, bindleId: BINDLE_ID });
    expect(calls.some(call => call.name === 'createTeam')).toBe(false);
    expect(calls.some(call => call.name === 'CreateBindle')).toBe(false);
  });

  it('no CTI-bearing team anywhere → fails BEFORE CreateBindle, naming the manual path', async () => {
    const { t, calls } = transport({ firstTeamCti: () => null });
    await expect(provisionHarmonyIdentity(t, 'jdoe')).rejects.toThrow(/require a CTI.*bindles\.amazon\.com/s);
    expect(calls.some(call => call.name === 'CreateBindle')).toBe(false);
  });

  it('failures name the console URL to finish by hand', async () => {
    const { t } = transport({ createTeam: () => ({ errors: [{ message: 'name too long' }] }) });
    await expect(provisionHarmonyIdentity(t, 'jdoe')).rejects.toThrow(/permissions\.amazon\.com\/a\/team\/new/);

    const denied = transport({ CreateBindle: () => { throw new Error('PermissionDenied: nope'); } });
    await expect(provisionHarmonyIdentity(denied.t, 'jdoe')).rejects.toThrow(/bindles\.amazon\.com\/v2\/software_app\/new/);
  });

  it('unresolvable manager fails BEFORE any write, naming the manual team path', async () => {
    const { t, calls } = transport({ managerAlias: () => null });
    await expect(provisionHarmonyIdentity(t, 'jdoe')).rejects.toThrow(/secondary owner.*permissions\.amazon\.com/s);
    expect(calls.some(call => call.name === 'createTeam')).toBe(false);
  });
});

describe('ensureHarmonyViewerAccess', () => {
  const app = { resourceId: APP_RESOURCE, owningTeam: { teamId: TEAM_ID } };
  const allPeopleRow = { op: 'Can view app', ns: 'harmony', actorTypeId: 'amzn1.bindle.actor-type.public', actorId: 'amzn1.bindle.actor-type.principal' };
  const teamRow = { op: 'Can view app', ns: 'harmony', actorTypeId: 'amzn1.bindle.actor-type.team', actorId: TEAM_ID };
  const settings = (visibility: 'everyone' | 'private') => ({ bindleId: BINDLE_ID, stage: 'beta' as const, visibility });

  it('everyone: grants All People when missing, no-ops when present', async () => {
    const missing = transport({ DescribeResource: () => app });
    await ensureHarmonyViewerAccess(missing.t, { appName: 'x-botboy-dashboard', settings: settings('everyone') }, 'jdoe');
    const grant = missing.calls.find(call => call.name === 'GrantPermission')!;
    expect(grant.payload.permission).toMatchObject({
      actorId: 'amzn1.bindle.actor-type.principal',
      actorType: 'amzn1.bindle.actor-type.public',
      permissionNamespace: 'harmony',
      permissionResourceType: 'HarmonyApp',
      permissionOperation: ['Can view app'],
    });

    const present = transport({ DescribeResource: () => app }, [allPeopleRow]);
    await ensureHarmonyViewerAccess(present.t, { appName: 'x-botboy-dashboard', settings: settings('everyone') }, 'jdoe');
    expect(present.calls.some(call => call.name === 'GrantPermission')).toBe(false);
  });

  it('private: grants the owning team and revokes All People', async () => {
    const { t, calls } = transport({ DescribeResource: () => app }, [allPeopleRow]);
    await ensureHarmonyViewerAccess(t, { appName: 'x-botboy-dashboard', settings: settings('private') }, 'jdoe');
    const grant = calls.find(call => call.name === 'GrantPermission')!;
    expect(grant.payload.permission.actorId).toBe(TEAM_ID);
    expect(grant.payload.permission.actorType).toBe('amzn1.bindle.actor-type.team');
    const revoke = calls.find(call => call.name === 'RevokePermission')!;
    expect(revoke.payload.permission.actorType).toBe('amzn1.bindle.actor-type.public');
  });

  it('private converge is idempotent when already converged', async () => {
    const { t, calls } = transport({ DescribeResource: () => app }, [teamRow]);
    await ensureHarmonyViewerAccess(t, { appName: 'x-botboy-dashboard', settings: settings('private') }, 'jdoe');
    expect(calls.some(call => call.name === 'GrantPermission')).toBe(false);
    expect(calls.some(call => call.name === 'RevokePermission')).toBe(false);
  });

  it('grant failures name the bindle resource URL', async () => {
    const { t } = transport({ DescribeResource: () => app, GrantPermission: () => { throw new Error('PermissionDenied'); } });
    await expect(ensureHarmonyViewerAccess(t, { appName: 'x-botboy-dashboard', settings: settings('everyone') }, 'jdoe'))
      .rejects.toThrow(new RegExp(`bindles\\.amazon\\.com/resource/${APP_RESOURCE}`));
  });
});
