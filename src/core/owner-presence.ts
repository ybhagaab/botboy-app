/**
 * Is the owner at the Mac right now? (MIDWAY_NOTICES_PLAN.md §5.) macOS keeps the time since the last keyboard, mouse or trackpad
 * input in the HID system's `HIDIdleTime` (nanoseconds); `ioreg` reads it in about 10 ms with no permission prompt. BotBoy uses it
 * only to decide whether opening a terminal for the owner makes sense now, never to record anything.
 */
import { execFile } from 'node:child_process';

/** Seconds since the owner's last input, from `ioreg -c IOHIDSystem` output; null when the value is absent. */
export function parseHidIdleSeconds(ioregOutput: string): number | null {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(ioregOutput ?? ''));
  if (!match) return null;
  const nanoseconds = Number(match[1]);
  return Number.isFinite(nanoseconds) ? Math.floor(nanoseconds / 1e9) : null;
}

/** Seconds since the owner's last input, or null where it cannot be read (not a Mac, ioreg missing or slow). Never throws. */
export function ownerIdleSeconds(timeoutMs = 2_000): Promise<number | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        resolve(error ? null : parseHidIdleSeconds(String(stdout)));
      });
    } catch {
      resolve(null);
    }
  });
}
