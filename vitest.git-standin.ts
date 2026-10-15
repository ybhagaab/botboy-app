/**
 * The macOS `git` stand-in, for the test hygiene net (vitest.no-ui-tools.setup.ts; Knowledge library P2-17).
 *
 * `/usr/bin/git` is an xcselect shim: with the Xcode Command Line Tools it runs Apple's git, WITHOUT them it raises the
 * "install developer tools" dialog on the owner's screen. A test must never start it in that case, exactly like
 * `/usr/bin/python3`. A Mac that has the tools (or Xcode) runs the same path harmlessly, so the net refuses it only when
 * neither is installed. Tests that need a real git use the tools' own, Homebrew's, or a tripwire script of their own.
 */
import fs from 'node:fs';

/** Where a working git lives once the Command Line Tools or Xcode are installed. */
export const DEVELOPER_GIT_PATHS: readonly string[] = Object.freeze([
  '/Library/Developer/CommandLineTools/usr/bin/git',
  '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
]);

/** True when a developer-tools git exists, so `/usr/bin/git` is not a bare stand-in. */
export function developerGitPresent(exists: (file: string) => boolean = fs.existsSync): boolean {
  // `BOTBOY_TEST_NO_DEVELOPER_GIT=1` pretends the tools are absent, so a nested run can prove the refusal on any Mac.
  if (process.env.BOTBOY_TEST_NO_DEVELOPER_GIT === '1') return false;
  return DEVELOPER_GIT_PATHS.some((candidate) => exists(candidate));
}

/** The `[absolute path, tool name]` pairs the net must refuse and record: `/usr/bin/git` only while it is a bare stand-in. */
export function gitStandIns(exists: (file: string) => boolean = fs.existsSync): ReadonlyArray<readonly [string, string]> {
  return developerGitPresent(exists) ? [] : [['/usr/bin/git', 'git']];
}
