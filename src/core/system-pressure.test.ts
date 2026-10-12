import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPerCpu, parsePressureLevel, readMemoryPressure, resetMemoryPressureCache } from './system-pressure.js';

describe('system-pressure', () => {
  beforeEach(() => resetMemoryPressureCache());

  it('parses the kernel levels 1, 2 and 4', () => {
    expect(parsePressureLevel('1\n')).toBe('normal');
    expect(parsePressureLevel('2\n')).toBe('warn');
    expect(parsePressureLevel('4\n')).toBe('critical');
    expect(parsePressureLevel('garbage')).toBe('normal');
    expect(parsePressureLevel('')).toBe('normal');
  });

  it('reads through /usr/sbin/sysctl with the pressure key', () => {
    const exec = vi.fn(() => '2\n');
    expect(readMemoryPressure(exec, () => 0, 'darwin')).toBe('warn');
    expect(exec).toHaveBeenCalledWith('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']);
  });

  it('caches for 15 seconds, then reads again', () => {
    let level = '2\n';
    const exec = vi.fn(() => level);
    let t = 1000;
    expect(readMemoryPressure(exec, () => t, 'darwin')).toBe('warn');
    level = '4\n';
    t += 14_999;
    expect(readMemoryPressure(exec, () => t, 'darwin')).toBe('warn');
    expect(exec).toHaveBeenCalledTimes(1);
    t += 1;
    expect(readMemoryPressure(exec, () => t, 'darwin')).toBe('critical');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('fails open to normal off macOS and on any error, without throwing', () => {
    const exec = vi.fn(() => '4\n');
    expect(readMemoryPressure(exec, () => 0, 'linux')).toBe('normal');
    expect(exec).not.toHaveBeenCalled();
    const broken = vi.fn(() => { throw new Error('no sysctl'); });
    expect(readMemoryPressure(broken, () => 0, 'darwin')).toBe('normal');
  });

  it('divides the one-minute load by the core count and fails open to 0', () => {
    expect(loadPerCpu({ loadavg: () => [6, 0, 0], cpus: () => new Array(4).fill({}) as any })).toBe(1.5);
    expect(loadPerCpu({ loadavg: () => [6, 0, 0], cpus: () => [] })).toBe(0);
    expect(loadPerCpu({ loadavg: () => { throw new Error('x'); }, cpus: () => [{}] as any })).toBe(0);
  });
});
