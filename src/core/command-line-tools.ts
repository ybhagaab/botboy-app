/**
 * Whether this Mac has the Xcode Command Line Tools, as a CACHED answer for code that must not start a process to ask
 * (the sandboxed shell of run_command and the chat terminal, and the MCP manager's launch of a user-added server).
 *
 * Python on demand, design decision D6 with review finding 11: while BotBoy's uv or Python is in use on a Mac WITHOUT
 * the tools, sandboxed children are denied exec of Apple's two Xcode stand-ins (`/usr/bin/python3`,
 * `/usr/bin/install_name_tool`), which on such a Mac can only raise the "install developer tools" dialog.
 *  - The answer is refreshed asynchronously (`xcode-select -p`, 5 s limit): at boot and on refresh_toolchain
 *    (`toolchain.ts › initToolchain`), and when a reader finds it older than 60 s. A reader never waits for it.
 *  - Unknown counts as "no tools" (the deny applies), which is safe: on a Mac without the tools both programs can only
 *    raise the dialog, and an explicit `uv python install` still completes without install_name_tool (measured).
 *  - A Command Line Tools install while BotBoy runs lifts the deny within 60 s, without a restart.
 * `BOTBOY_TEST_XCODE_SELECT_BIN` (absolute) replaces the tool in tests, as in app-update.ts.
 */
import path from 'node:path';

const REFRESH_AFTER_MS = 60_000;
const CHECK_TIMEOUT_MS = 5_000;

let known: boolean | null = null;
let checkedAt = 0;
let pending: Promise<boolean> | null = null;

function xcodeSelectBin(): string {
  const override = process.env.BOTBOY_TEST_XCODE_SELECT_BIN;
  return override && path.isAbsolute(override) ? override : '/usr/bin/xcode-select';
}

/** Ask `xcode-select -p` now (one check at a time) and remember the answer. */
export function refreshCommandLineTools(): Promise<boolean> {
  if (pending) return pending;
  pending = (async () => {
    // Imported lazily, like toolchain.ts › probeVersion: tests mock child_process with partial exports.
    const { execFile } = await import('node:child_process');
    const ok = await new Promise<boolean>((resolve) => {
      try {
        execFile(xcodeSelectBin(), ['-p'], { timeout: CHECK_TIMEOUT_MS, killSignal: 'SIGKILL' }, (error) => resolve(!error));
      } catch {
        resolve(false);
      }
    });
    known = ok;
    checkedAt = Date.now();
    return ok;
  })().finally(() => {
    pending = null;
  });
  return pending;
}

/** The cached answer: true, false, or null while it is not known yet. A stale answer starts a refresh in the background. */
export function commandLineToolsKnown(now: number = Date.now()): boolean | null {
  if (known === null || now - checkedAt > REFRESH_AFTER_MS) void refreshCommandLineTools();
  return known;
}

/** Tests only: forget the answer. */
export function resetCommandLineToolsForTests(value: boolean | null = null, at: number = Date.now()): void {
  known = value;
  checkedAt = value === null ? 0 : at;
  pending = null;
}
