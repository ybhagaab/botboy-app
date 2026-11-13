import { describe, it, expect } from 'vitest';
import { ownerIdleSeconds, parseHidIdleSeconds } from './owner-presence.js';

describe('owner presence (HIDIdleTime)', () => {
  it('reads the idle time in whole seconds from ioreg output', () => {
    const output = '+-o IOHIDSystem  <class IOHIDSystem, id 0x100000465>\n    {\n      "HIDIdleTime" = 125403000000\n      "HIDParameters" = {}\n    }';
    expect(parseHidIdleSeconds(output)).toBe(125);
    expect(parseHidIdleSeconds('"HIDIdleTime" = 999999999')).toBe(0);
  });

  it('is null when the value is absent', () => {
    expect(parseHidIdleSeconds('')).toBeNull();
    expect(parseHidIdleSeconds('"HIDIdleTime" = <unknown>')).toBeNull();
  });

  it('never throws, and answers a number or null on this machine', async () => {
    const seconds = await ownerIdleSeconds(5_000);
    expect(seconds === null || (Number.isInteger(seconds) && seconds >= 0)).toBe(true);
  });
});
