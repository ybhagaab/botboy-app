import { describe, it, expect } from 'vitest';
import { createKeepAwake } from './keep-awake.js';
import { whatsAppTurnMessage } from './whatsapp-chat.js';

function fakeSpawner() {
  const calls: Array<{ cmd: string; args: string[]; killed: boolean }> = [];
  const spawner = (cmd: string, args: string[]) => {
    const entry = { cmd, args, killed: false };
    calls.push(entry);
    return { kill: () => { entry.killed = true; return true; }, on: () => undefined } as any;
  };
  return { calls, spawner };
}

describe('keep-awake', () => {
  it('holds caffeinate tied to the server pid only while busy', () => {
    let busy = false;
    const { calls, spawner } = fakeSpawner();
    const k = createKeepAwake({ busy: () => busy, spawner, platform: 'darwin', pid: 4242, log: () => {} });
    k.tick();
    expect(calls).toHaveLength(0);
    busy = true;
    k.tick(); k.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cmd: '/usr/bin/caffeinate', args: ['-i', '-s', '-w', '4242'] });
    expect(k.holding()).toBe(true);
    busy = false;
    k.tick();
    expect(calls[0].killed).toBe(true);
    expect(k.holding()).toBe(false);
  });

  it('does nothing off macOS', () => {
    const { calls, spawner } = fakeSpawner();
    const k = createKeepAwake({ busy: () => true, spawner, platform: 'linux', log: () => {} });
    k.tick();
    expect(calls).toHaveLength(0);
  });
});

describe('WhatsApp turn note', () => {
  it('tells the model it has every tool, including browser clicks and typing', () => {
    const note = whatsAppTurnMessage('continue the form');
    expect(note).toMatch(/every tool is available/);
    expect(note).toMatch(/browser_hands click, type/);
  });
});
