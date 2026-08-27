import { describe, it, expect } from 'vitest';
import {
  getBuiltInMcpProfile,
  isBuiltInMcpProfileId,
  listBuiltInMcpProfiles,
  getTerminalCommandDefinition,
  resolveAimPackageScript,
  SHAREPOINT_MCP_PROFILE_ID,
  SHAREPOINT_MCP_REQUIRED_TOOLS,
} from './mcp-profiles.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyMcpTool } from './mcp-policy.js';

describe('Built-in MCP profile registry', () => {
  it('registers exactly the five built-in profiles', () => {
    expect(listBuiltInMcpProfiles().map(p => p.id).sort())
      .toEqual(['a2-analytics', 'grasp-m365', 'sharepoint', 'slack', 'sql-context']);
  });

  it('recognizes sharepoint as a built-in id (custom-id collision guard depends on this)', () => {
    expect(isBuiltInMcpProfileId('sharepoint')).toBe(true);
    expect(isBuiltInMcpProfileId('sharepoint-2')).toBe(false);
  });
});

describe('SharePoint profile (sharepoint-docs-brain R1)', () => {
  const profile = getBuiltInMcpProfile(SHAREPOINT_MCP_PROFILE_ID)!;

  it('launches the fixed executable with no arguments (closed configuration)', () => {
    expect(profile.launch).toEqual({
      type: 'local-executable',
      executableName: 'amazon-sharepoint-mcp',
      args: [],
    });
  });

  it('declares the R1.2 required tools — and every one classifies as a free read', () => {
    expect([...profile.requiredTools].sort()).toEqual([
      'sharepoint_list_files',
      'sharepoint_list_libraries',
      'sharepoint_list_shared_with_me',
      'sharepoint_list_sites',
      'sharepoint_read_file',
      'sharepoint_resolve_url',
      'sharepoint_search',
    ]);
    // Registry/policy coherence: a required tool that classified as write
    // would make the sync unbuildable again (the §8.5 build blocker).
    for (const tool of SHAREPOINT_MCP_REQUIRED_TOOLS) {
      expect(classifyMcpTool('sharepoint', tool), tool).toBe('read');
    }
  });

  it('redacts errors and discards stderr (R1.3)', () => {
    expect(profile.policy.redactErrors).toBe(true);
    expect(profile.policy.discardStderr).toBe(true);
    expect(profile.policy.allowGenericToolCalls).toBe(true);
  });

  it('exposes the three setup terminal commands in dependency order', () => {
    expect(profile.terminalCommands.map(c => c.id)).toEqual(['update-toolbox', 'install', 'midway']);
    expect(getTerminalCommandDefinition(profile, 'install')?.argv)
      .toEqual(['aim', 'mcp', 'install', 'amazon-sharepoint-mcp']);
    expect(getTerminalCommandDefinition(profile, 'midway')?.argv).toEqual(['mwinit']);
  });

  it('has no setup actions (auth is Midway; nothing to initialize)', () => {
    expect(profile.setupActions).toEqual([]);
  });
});

describe('aim-package-script resolution (a2-analytics launch)', () => {
  it('resolves the launcher inside the newest eventId directory that has it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-packages-'));
    const pkg = path.join(root, 'A2AnalyticsAgent-1.0');
    const older = path.join(pkg, 'eventId-1111', 'context', 'scripts');
    const newer = path.join(pkg, 'eventId-2222', 'context', 'scripts');
    fs.mkdirSync(older, { recursive: true });
    fs.mkdirSync(newer, { recursive: true });
    fs.writeFileSync(path.join(older, 'mcp-run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(newer, 'mcp-run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    // Make the 2222 dir demonstrably newer.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(pkg, 'eventId-2222'), future, future);

    const resolved = await resolveAimPackageScript('A2AnalyticsAgent-1.0', 'context/scripts/mcp-run.sh', root);
    expect(resolved).toBe(path.join(newer, 'mcp-run.sh'));
  });

  it('falls back to an older eventId when the newest lacks the script', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-packages-'));
    const pkg = path.join(root, 'A2AnalyticsAgent-1.0');
    const complete = path.join(pkg, 'eventId-aaaa', 'context', 'scripts');
    fs.mkdirSync(complete, { recursive: true });
    fs.writeFileSync(path.join(complete, 'mcp-run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    fs.mkdirSync(path.join(pkg, 'eventId-bbbb'), { recursive: true }); // empty, newer
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(pkg, 'eventId-bbbb'), future, future);

    const resolved = await resolveAimPackageScript('A2AnalyticsAgent-1.0', 'context/scripts/mcp-run.sh', root);
    expect(resolved).toBe(path.join(complete, 'mcp-run.sh'));
  });

  it('returns null (not_installed) for a missing package, and ignores non-executable scripts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-packages-'));
    expect(await resolveAimPackageScript('A2AnalyticsAgent-1.0', 'context/scripts/mcp-run.sh', root)).toBeNull();
    const scripts = path.join(root, 'A2AnalyticsAgent-1.0', 'eventId-1', 'context', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'mcp-run.sh'), '#!/bin/sh\n', { mode: 0o644 }); // not executable
    expect(await resolveAimPackageScript('A2AnalyticsAgent-1.0', 'context/scripts/mcp-run.sh', root)).toBeNull();
  });

  it('the registry profile launches through the AIM artifact and requires the download tool', () => {
    const profile = getBuiltInMcpProfile('a2-analytics');
    expect(profile.launch).toEqual({
      type: 'aim-package-script',
      packageName: 'A2AnalyticsAgent-1.0',
      relativeScriptPath: 'context/scripts/mcp-run.sh',
    });
    expect(profile.requiredTools).toContain('datanet_download_results');
    expect(profile.requiredTools).toContain('datanet_get_job_run');
    // The setup terminal must carry the Sentry-aware Midway command and the
    // PEP 668 pip workaround — both were live findings, not decoration.
    const argvs = profile.terminalCommands.map(command => command.argv.join(' '));
    expect(argvs.some(argv => argv === 'mwinit -o -s')).toBe(true);
    expect(argvs.some(argv => argv.includes('--break-system-packages'))).toBe(true);
    expect(argvs.some(argv => argv === 'aim agents install A2AnalyticsAgent')).toBe(true);
  });
});
