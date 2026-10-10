/**
 * Keep the Mac awake while BotBoy works (owner report 2026-10-10: a WhatsApp
 * job stalled for 17 minutes at a time because the laptop slept; each sleep cut
 * the chat stream and the model calls). While a chat turn runs or a job is
 * active, BotBoy holds `caffeinate -i -s -w <server pid>`: no idle sleep, and
 * no system sleep on power. The display may still turn off. `-w` ends the
 * assertion when the server exits, so a crash never leaves the Mac awake.
 * Closing the lid on battery still sleeps (macOS rule).
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface KeepAwake { tick(): void; stop(): void; holding(): boolean }

export function createKeepAwake(deps: {
  busy: () => boolean;
  spawner?: (cmd: string, args: string[]) => Pick<ChildProcess, 'kill' | 'on'>;
  platform?: NodeJS.Platform;
  pid?: number;
  intervalMs?: number;
  log?: (line: string) => void;
}): KeepAwake & { start(): void } {
  const platform = deps.platform ?? process.platform;
  const spawner = deps.spawner ?? ((cmd, args) => spawn(cmd, args, { stdio: 'ignore' }));
  const log = deps.log ?? ((line: string) => console.log(line));
  let child: Pick<ChildProcess, 'kill' | 'on'> | null = null;
  let timer: NodeJS.Timeout | null = null;
  function release() {
    if (!child) return;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    child = null;
    log('☾ Keep-awake released (no turn or job running)');
  }
  function tick() {
    if (platform !== 'darwin') return;
    let busy = false;
    try { busy = deps.busy(); } catch { busy = false; }
    if (busy && !child) {
      try {
        const c = spawner('/usr/bin/caffeinate', ['-i', '-s', '-w', String(deps.pid ?? process.pid)]);
        c.on('exit', () => { if (child === c) child = null; });
        c.on('error', () => { if (child === c) child = null; });
        child = c;
        log('☀ Keep-awake on while BotBoy works');
      } catch { child = null; }
    } else if (!busy && child) {
      release();
    }
  }
  return {
    tick,
    holding: () => child !== null,
    start() {
      if (timer || platform !== 'darwin') return;
      timer = setInterval(tick, deps.intervalMs ?? 15_000);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; release(); },
  };
}
