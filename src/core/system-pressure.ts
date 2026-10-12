/**
 * System pressure signals for the browser monitor's pacing: macOS memory
 * pressure and CPU load per core. Both fail open: a missing tool, a
 * non-macOS host, or any error reads as "normal" / zero load, because a
 * failed measurement must never slow capture down.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';

export type MemoryPressure = 'normal' | 'warn' | 'critical';

/** Runs a command and returns its stdout; injectable for tests. */
export type PressureExec = (file: string, args: string[]) => string;

const SYSCTL = '/usr/sbin/sysctl';
const SYSCTL_ARGS = ['-n', 'kern.memorystatus_vm_pressure_level'];
/** The kernel's level changes slowly; one read per 15 s is plenty. */
export const PRESSURE_CACHE_MS = 15_000;

const defaultExec: PressureExec = (file, args) =>
  execFileSync(file, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });

let cached: { at: number; level: MemoryPressure; exec: PressureExec } | null = null;

/** Maps the kernel's level (1 normal, 2 warn, 4 critical) to a name; anything else is normal. */
export function parsePressureLevel(raw: string): MemoryPressure {
  const level = Number.parseInt(raw.trim(), 10);
  if (level === 2) return 'warn';
  if (level === 4) return 'critical';
  return 'normal';
}

/** Current memory pressure, cached for 15 s per executor. Never throws. */
export function readMemoryPressure(exec: PressureExec = defaultExec, now: () => number = Date.now, platform: string = process.platform): MemoryPressure {
  if (platform !== 'darwin') return 'normal';
  const t = now();
  if (cached && cached.exec === exec && t - cached.at >= 0 && t - cached.at < PRESSURE_CACHE_MS) return cached.level;
  let level: MemoryPressure = 'normal';
  try {
    level = parsePressureLevel(exec(SYSCTL, SYSCTL_ARGS));
  } catch { /* fail open */ }
  cached = { at: t, level, exec };
  return level;
}

/** Test seam: forget the cached reading. */
export function resetMemoryPressureCache(): void {
  cached = null;
}

/** One-minute load average divided by the core count; 0 when unknown. Never throws. */
export function loadPerCpu(source: Pick<typeof os, 'loadavg' | 'cpus'> = os): number {
  try {
    const cores = source.cpus().length;
    const load = source.loadavg()[0];
    if (!cores || !Number.isFinite(load) || load < 0) return 0;
    return load / cores;
  } catch {
    return 0;
  }
}
