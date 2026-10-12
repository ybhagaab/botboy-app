/**
 * Static guard: on a Mac without Xcode Command Line Tools, /usr/bin/swiftc,
 * lipo, otool and git are shims that raise the macOS "install developer tools"
 * dialog the moment anything runs them. start.sh and the scripts it runs may
 * reach those tools only through `xcrun --find` (after `xcode-select -p`
 * succeeded) or behind a gate (`clt_toolchain_ok`, `git_usable`, `gitUsable`).
 * This test reads the sources, ignoring comments, and fails on a bare use.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const startSh = fs.readFileSync(path.join(root, 'start.sh'), 'utf8');
const scriptsDir = path.join(root, 'scripts');
const mjsFiles = fs.readdirSync(scriptsDir).filter((name) => name.endsWith('.mjs')).sort();

const SHIMS = 'swiftc|lipo|otool|swift|clang|xcodebuild';
// A shim at command position: start of line or after a shell separator.
const SHELL_COMMAND = new RegExp(`(?:^|&&|\\|\\||;|\\||\\$\\(|\`|\\bthen\\b|\\bdo\\b|!)\\s*(?:command\\s+-v\\s+|which\\s+)?(${SHIMS})\\b`);
const SHELL_GIT = /(?:^|&&|\|\||;|\||\$\(|`|\bthen\b|\bdo\b|!)\s*(?:command\s+-v\s+|which\s+)?git\s/;

const codeLines = (text: string) => text.split('\n')
  .map((line, index) => ({ line, number: index + 1 }))
  .filter(({ line }) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#') && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
  });

describe('no Xcode shim on the start and doctor paths', () => {
  it('start.sh never runs swiftc, lipo, otool, or which/command -v for them', () => {
    const offenders = codeLines(startSh)
      .filter(({ line }) => !line.includes('--find'))
      .filter(({ line }) => SHELL_COMMAND.test(line) || new RegExp(`\\b(?:which|command -v)\\s+(?:${SHIMS})\\b`).test(line));
    expect(offenders).toEqual([]);
  });
  it('start.sh reaches git only behind git_usable', () => {
    const lines = startSh.split('\n');
    const offenders = codeLines(startSh)
      .filter(({ line }) => SHELL_GIT.test(line) && !/GIT_SHIM/.test(line))
      .filter(({ number }) => {
        // The gate must appear shortly before the call, in the same block.
        const window = lines.slice(Math.max(0, number - 90), number).join('\n');
        return !/git_usable/.test(window);
      });
    expect(offenders).toEqual([]);
    // The gate itself refuses the /usr/bin shim unless Command Line Tools answer.
    expect(startSh).toMatch(/git_usable\(\) \{[\s\S]*?\[ "\$found" = "\$GIT_SHIM" \][\s\S]*?clt_installed/);
  });
  it('start.sh asks xcode-select first and never touches xcrun without it', () => {
    expect(startSh).toMatch(/clt_toolchain_ok\(\) \{\n\s+clt_installed && "\$XCRUN_BIN" --find swiftc/);
    const xcrunUses = codeLines(startSh).filter(({ line }) => line.includes('XCRUN_BIN'));
    expect(xcrunUses.map(({ line }) => line.trim())).toEqual([
      'XCRUN_BIN="${BOTBOY_TEST_XCRUN_BIN:-/usr/bin/xcrun}"',
      'clt_installed && "$XCRUN_BIN" --find swiftc >/dev/null 2>&1',
    ]);
  });
  for (const name of mjsFiles) {
    it(`scripts/${name} runs no bare Xcode shim`, () => {
      const text = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
      const code = codeLines(text);
      const offenders = code
        .filter(({ line }) => !line.includes('--find') && !line.includes('findTool('))
        .filter(({ line }) => new RegExp(`(['"\`])(?:${SHIMS})\\1`).test(line) || new RegExp(`\\b(?:which|command -v)\\s+(?:${SHIMS})\\b`).test(line));
      expect(offenders).toEqual([]);
      // git: allowed only in a file that checks Command Line Tools first.
      if (code.some(({ line }) => /(['"`])git\1/.test(line))) {
        expect(text, `${name} runs git without a gitUsable() gate`).toMatch(/function gitUsable\b/);
        expect(text).toMatch(/xcode-select/);
      }
    });
  }
});
