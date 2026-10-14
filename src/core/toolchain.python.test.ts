/**
 * Python on demand (python-runtime.md; design §6 seams, review findings 8 and 9): the chat prompt's tool inventory names
 * BotBoy's own setup as the next step for python3 and uv, and carries the one "another Python version" line only while
 * BotBoy's uv is the uv in use. On every other Mac the block is byte-identical apart from the new `uv` row.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverToolchain, formatToolInventory, TOOL_REGISTRY, type ToolchainSnapshot } from './toolchain.js';

const GUIDANCE = 'Another Python version: uv python install 3.14 --install-dir ~/.botboy-python/python, then pass --python ~/.botboy-python/bin/python3.14 (by version it is not found).';
const snapshot = (missing: string[]): ToolchainSnapshot => ({
  resolvedAt: '2026-10-14T00:00:00.000Z',
  pathAdditions: [],
  tools: TOOL_REGISTRY.map((spec) => ({
    name: spec.name,
    purpose: spec.purpose,
    requirement: spec.requirement,
    path: missing.includes(spec.name) ? null : `/opt/tools/${spec.name}`,
    version: null,
    brewFormula: spec.brewFormula,
    installHint: spec.installHint,
    macBuiltin: spec.macBuiltin,
    internalOnly: spec.internalOnly,
  })),
});

afterEach(() => vi.unstubAllEnvs());

describe('the tool inventory and BotBoy\'s own Python', () => {
  it('python3 and uv name BotBoy\'s setup as the next step; uv is optional and probed like any tool', () => {
    const python = TOOL_REGISTRY.find((tool) => tool.name === 'python3')!;
    const uv = TOOL_REGISTRY.find((tool) => tool.name === 'uv')!;
    expect(python).toMatchObject({ requirement: 'recommended', versionArgs: ['--version'] });
    expect(python.brewFormula).toBeUndefined();
    expect(python.installHint).toBe('BotBoy sets up its own Python 3.13 when ./start.sh runs while online (./start.sh --doctor, row "python source"); or install Python 3.10+ from python.org');
    expect(uv).toMatchObject({ requirement: 'optional', versionArgs: ['--version'] });
    expect(uv.installHint).toContain('row "uv source"');
    const text = formatToolInventory(snapshot(['python3', 'uv']), false);
    expect(text).toContain('python3 (install: BotBoy sets up its own Python 3.13 when ./start.sh runs while online');
    expect(text).toContain('uv (install: BotBoy sets up its own uv when ./start.sh runs while online');
  });

  it('the "another Python version" line is sent only while BotBoy\'s uv is in use', () => {
    const off = formatToolInventory(snapshot([]), false);
    const on = formatToolInventory(snapshot([]), true);
    expect(off).not.toContain('botboy-python');
    expect(on.split('\n')).toEqual([off.split('\n')[0], GUIDANCE, ...off.split('\n').slice(1)]);
    // The pip half of the old resident line is gone (review finding 8): chat's plain pip install already works.
    expect(on).not.toMatch(/break-system-packages/);
    // By default the answer is this process's PATH: a Mac with its own uv (or none) gets no line.
    expect(formatToolInventory(snapshot([]))).toBe(off);
  });

  it('on a Mac without the Command Line Tools, Apple\'s python3 counts as not installed and is never run; the hint is BotBoy\'s', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-toolchain-py-')));
    try {
      const xcodeSelect = path.join(dir, 'xcode-select');
      fs.writeFileSync(xcodeSelect, '#!/bin/sh\nexit 2\n', { mode: 0o755 });
      vi.stubEnv('BOTBOY_TEST_XCODE_SELECT_BIN', xcodeSelect);
      const found = await discoverToolchain({ ...process.env, PATH: '/usr/bin:/bin' });
      const python = found.tools.find((tool) => tool.name === 'python3')!;
      expect(python.path).toBeNull();
      expect(python.installHint).toContain('BotBoy sets up its own Python 3.13');
      expect(python.brewFormula).toBeUndefined();
      // git keeps the Command Line Tools hint.
      expect(found.tools.find((tool) => tool.name === 'git')!.installHint).toBe('install the Command Line Tools (xcode-select --install)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
