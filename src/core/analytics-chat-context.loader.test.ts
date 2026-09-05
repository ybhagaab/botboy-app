/**
 * Briefing-loader union catalog (gap found live 2026-09-04): dashboard
 * creation grounded ONLY in sql-context presets — the knowledge directory's
 * ETL-derived business briefs were invisible at the decision point. The
 * catalog is now the union of both sources; these tests pin the union,
 * source degradation, fail-closed loads, and the clarification listing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createStorage, StorageLayer, setSetting } from './storage.js';
import { ANALYTICS_CONTEXT_DIR_KEY } from './analytics-context.js';
import { createAnalyticsSchemaBriefingLoader } from './analytics-chat-context.js';

const WINDOW = 1_000_000;

function runningMcp(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ tool: string; args: any }> = [];
  const manager = {
    calls,
    async getServer(_id: string) {
      return { enabled: true, configured: true, state: 'running', updatedAt: '2026-09-04T00:00:00Z', ...overrides };
    },
    async callTool(_server: string, tool: string, args: any) {
      calls.push({ tool, args });
      if (tool === 'list_presets') {
        return { isError: false, text: '- **fatafat**: Short-form video warehouse schema\n- **ott_133**: OTT streaming warehouse schema' };
      }
      if (tool === 'get_schema_context') {
        return { isError: false, text: `SCHEMA CONTEXT FOR ${args.preset}: tables, regimes, conventions.` };
      }
      return { isError: true, text: `unexpected tool ${tool}` };
    },
  };
  return manager;
}

describe('createAnalyticsSchemaBriefingLoader — union catalog', () => {
  let storage: StorageLayer;
  let tmpDir: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefing-union-'));
    setSetting(storage.getDb(), ANALYTICS_CONTEXT_DIR_KEY, tmpDir);
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const db = () => storage.getDb();

  const seedKnowledge = () => {
    fs.mkdirSync(path.join(tmpDir, 'presets'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'presets', 'ott.md'), '# OTT streaming business brief\nEvent families, playback trio, measurement regimes.');
    fs.writeFileSync(path.join(tmpDir, 'presets', 'membership.md'), '# Membership business brief\nSubscription cohorts and renewals.');
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({
      files: [
        { file: 'presets/ott.md', business: 'ott', keywords: ['ott', 'streaming', 'playback'], source: 'etl-derived', appliesTo: ['mcp_sql_*', 'mcp_etl_*'] },
        { file: 'presets/membership.md', business: 'membership', keywords: ['membership', 'subscription'], source: 'etl-derived', appliesTo: ['mcp_sql_*', 'mcp_etl_*'] },
      ],
    }));
  };

  it('selects and completely loads a knowledge-dir business the sql-context catalog does not know', async () => {
    seedKnowledge();
    const loader = createAnalyticsSchemaBriefingLoader(runningMcp() as any, { db: db(), contextWindowTokens: WINDOW });
    const briefing = await loader.load('build an ott streaming playback dashboard');
    expect(briefing.ready).toBe(true);
    expect(briefing.complete).toBe(true);
    expect(briefing.presets).toContain('presets/ott.md');
    expect(briefing.text).toContain('OTT streaming business brief');
    expect(briefing.text).toContain('source="knowledge-dir"');
    expect(briefing.text).toContain('[KNOWLEDGE FILE: presets/ott.md');
  });

  it('still resolves sql-context presets by exact name (regression)', async () => {
    seedKnowledge();
    const mcp = runningMcp();
    const loader = createAnalyticsSchemaBriefingLoader(mcp as any, { db: db(), contextWindowTokens: WINDOW });
    const briefing = await loader.load('build a fatafat dashboard');
    expect(briefing.ready).toBe(true);
    expect(briefing.presets).toContain('fatafat');
    expect(briefing.text).toContain('SCHEMA CONTEXT FOR fatafat');
    expect(mcp.calls.some(call => call.tool === 'get_schema_context' && call.args.preset === 'fatafat')).toBe(true);
  });

  it('briefs from knowledge alone when sql-context is not configured (teammate mode)', async () => {
    seedKnowledge();
    const mcp = {
      async getServer() { return { enabled: false, configured: false, state: 'stopped', updatedAt: 'x' }; },
      async callTool() { throw new Error('must not be called'); },
    };
    const loader = createAnalyticsSchemaBriefingLoader(mcp as any, { db: db(), contextWindowTokens: WINDOW });
    const briefing = await loader.load('membership subscription renewals dashboard');
    expect(briefing.ready).toBe(true);
    expect(briefing.presets).toEqual(['presets/membership.md']);
    expect(briefing.text).toContain('not configured');
    expect(briefing.text).toContain('Membership business brief');
  });

  it('lists BOTH sources in the clarification message when the ask is ambiguous', async () => {
    seedKnowledge();
    const loader = createAnalyticsSchemaBriefingLoader(runningMcp() as any, { db: db(), contextWindowTokens: WINDOW });
    const briefing = await loader.load('Help me construct something broadly useful please');
    expect(briefing.ready).toBe(false);
    expect(briefing.selectionStatus).toBe('clarification_required');
    expect(briefing.text).toContain('[SQL schema preset]');
    expect(briefing.text).toContain('[local knowledge]');
    expect(briefing.text).toContain('presets/ott.md');
    expect(briefing.text).toContain('fatafat');
  });

  it('rendered lesson files ride the union catalog like presets (lessons ledger)', async () => {
    seedKnowledge();
    fs.mkdirSync(path.join(tmpDir, 'lessons'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'lessons', 'ott.md'), '# Lessons — ott\n\nETLM rejects LIMIT — use ROW_NUMBER top-N.\n');
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'manifest.json'), 'utf8'));
    manifest.files.push({ file: 'lessons/ott.md', business: 'ott', keywords: ['ott', 'lessons'], source: 'lesson' });
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));

    const loader = createAnalyticsSchemaBriefingLoader(runningMcp() as any, { db: db(), contextWindowTokens: WINDOW });
    const briefing = await loader.load('build an ott streaming playback dashboard');
    expect(briefing.ready).toBe(true);
    // Both the preset and its lessons sibling matched the ott ask.
    expect(briefing.presets).toContain('presets/ott.md');
    expect(briefing.presets).toContain('lessons/ott.md');
    expect(briefing.text).toContain('ETLM rejects LIMIT');
    expect(briefing.text).toContain('BotBoy experiential lessons');
  });

  it('fails closed when nothing is available from either source', async () => {
    const mcp = {
      async getServer() { return { enabled: false, configured: false, state: 'stopped', updatedAt: 'x' }; },
      async callTool() { throw new Error('must not be called'); },
    };
    const loader = createAnalyticsSchemaBriefingLoader(mcp as any, { db: db(), contextWindowTokens: WINDOW });
    const briefing = await loader.load('build a dashboard');
    expect(briefing.ready).toBe(false);
    expect(briefing.selectionStatus).toBe('unavailable');
    expect(briefing.text).toContain('#/connections/sql-context');
    expect(briefing.text).toContain('knowledge');
  });

  it('fails closed when a selected sql preset cannot be loaded completely', async () => {
    seedKnowledge();
    const mcp = runningMcp();
    mcp.callTool = async (_server: string, tool: string, args: any) => {
      if (tool === 'list_presets') return { isError: false, text: '- **fatafat**: Short-form video warehouse schema' };
      return { isError: true, text: 'schema source exploded' };
    };
    const loader = createAnalyticsSchemaBriefingLoader(mcp as any, { db: db(), contextWindowTokens: WINDOW });
    const briefing = await loader.load('build a fatafat dashboard');
    expect(briefing.ready).toBe(false);
    expect(briefing.complete).toBe(false);
    expect(briefing.text).toContain('could not load these required context files completely');
    expect(briefing.text).toContain('fatafat');
  });

  it('degrades to knowledge with an honest note when preset listing fails on a running connector', async () => {
    seedKnowledge();
    const mcp = runningMcp();
    mcp.callTool = async (_server: string, tool: string) => {
      if (tool === 'list_presets') return { isError: true, text: 'boom' };
      return { isError: true, text: 'boom' };
    };
    const loader = createAnalyticsSchemaBriefingLoader(mcp as any, { db: db(), contextWindowTokens: WINDOW });
    const briefing = await loader.load('ott streaming playback dashboard');
    expect(briefing.ready).toBe(true);
    expect(briefing.presets).toEqual(['presets/ott.md']);
    expect(briefing.text).toContain('listing schema presets FAILED');
  });
});
