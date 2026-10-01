import { afterEach, describe, expect, it } from 'vitest';
import { createMainThreadWatchdog, type MainThreadWatchdog } from './main-thread-watchdog.js';

/** C9: stalls over the threshold are logged with the labeled subsystem. */
describe('main-thread watchdog', () => {
  let watchdog: MainThreadWatchdog | null = null;
  afterEach(() => { watchdog?.stop(); watchdog = null; });

  it('logs a labeled section that holds the main thread past the threshold', () => {
    const lines: string[] = [];
    let t = 0;
    watchdog = createMainThreadWatchdog({ stallMs: 1_000, log: line => lines.push(line), clock: () => t });
    const value = watchdog.measure('folder-import', () => { t += 1_500; return 42; });
    watchdog.measure('folder-live', () => { t += 200; });
    expect(value).toBe(42);
    expect(lines).toEqual(['[main-thread] folder-import held the main thread for 1.5 s']);
    expect(watchdog.stats()).toMatchObject({ stallCount: 1, recentStalls: [{ label: 'folder-import', durationMs: 1500, attributed: true }] });
  });

  it('still records the stall when the measured work throws', () => {
    const lines: string[] = [];
    let t = 0;
    watchdog = createMainThreadWatchdog({ stallMs: 100, log: line => lines.push(line), clock: () => t });
    expect(() => watchdog!.measure('folder-import', () => { t += 150; throw new Error('boom'); })).toThrow('boom');
    expect(lines).toHaveLength(1);
  });

  it('names an unattributed event-loop stall from the delay histogram', async () => {
    const lines: string[] = [];
    watchdog = createMainThreadWatchdog({ stallMs: 300, tickMs: 20, windowMs: 100, log: line => lines.push(line) });
    watchdog.start();
    await new Promise(resolve => setTimeout(resolve, 120));
    const until = Date.now() + 600;
    while (Date.now() < until) { /* block the loop, unlabeled */ }
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(lines.filter(line => line.startsWith('[main-thread] event loop stalled') && line.includes('no labeled work ran'))).toHaveLength(1);
    const stats = watchdog.stats();
    expect(stats.enabled).toBe(true);
    expect(stats.maxMs).toBeGreaterThanOrEqual(300);
    expect(stats.recentStalls.at(-1)).toMatchObject({ attributed: false, label: null });
  });

  it('does not echo a measured stall as an unattributed one', async () => {
    const lines: string[] = [];
    watchdog = createMainThreadWatchdog({ stallMs: 200, tickMs: 20, windowMs: 100, log: line => lines.push(line) });
    watchdog.start();
    await new Promise(resolve => setTimeout(resolve, 60));
    watchdog.measure('folder-import', () => {
      const until = Date.now() + 400;
      while (Date.now() < until) { /* labeled block */ }
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[main-thread\] folder-import held the main thread for 0\.4 s$/);
  });
});
