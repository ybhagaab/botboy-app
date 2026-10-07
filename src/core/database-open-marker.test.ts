import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeDatabaseOpenMarker } from './database-open-marker.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botboy-db-open-marker-'));
  roots.push(root);
  return root;
}

describe('writeDatabaseOpenMarker', () => {
  it('writes nothing when the launcher passed no marker path', () => {
    const root = tempRoot();
    expect(writeDatabaseOpenMarker(undefined)).toBe(false);
    expect(writeDatabaseOpenMarker('')).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('writes a private marker atomically and leaves no temporary file', () => {
    const root = tempRoot();
    const marker = path.join(root, 'ppt-db-open-6f1c2b9e-7a43-4c1e-9d55-0b6a8f3e2d10.json');
    const now = new Date('2026-10-07T18:00:00.000Z');
    expect(writeDatabaseOpenMarker(marker, 4242, now)).toBe(true);
    expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toEqual({ schemaVersion: 1, pid: 4242, writtenAt: now.toISOString() });
    expect(fs.statSync(marker).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root)).toEqual([path.basename(marker)]);
  });

  it('rejects a relative path or another file name, and writes nothing', () => {
    const root = tempRoot();
    expect(() => writeDatabaseOpenMarker('ppt-db-open-12345678.json')).toThrow(/absolute path/);
    expect(() => writeDatabaseOpenMarker(path.join(root, 'tracker.db'))).toThrow(/ppt-db-open-<id>\.json/);
    expect(() => writeDatabaseOpenMarker(path.join(root, 'ppt-db-open-../x.json'))).toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('throws when the marker cannot be written, so the database is never opened', () => {
    const root = tempRoot();
    const marker = path.join(root, 'missing-dir', 'ppt-db-open-12345678.json');
    expect(() => writeDatabaseOpenMarker(marker, 4242)).toThrow();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('never writes through a link planted at its temporary name', () => {
    const root = tempRoot();
    const marker = path.join(root, 'ppt-db-open-12345678.json');
    const victim = path.join(root, 'victim.txt');
    fs.writeFileSync(victim, 'keep me\n');
    fs.symlinkSync(victim, `${marker}.4242.tmp`);
    expect(writeDatabaseOpenMarker(marker, 4242)).toBe(true);
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me\n');
    expect(JSON.parse(fs.readFileSync(marker, 'utf8')).pid).toBe(4242);
  });
});

describe('database-open marker seam in index.ts', () => {
  it('writes the marker immediately before the first tracker.db open', () => {
    const source = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const markerAt = source.indexOf('writeDatabaseOpenMarker(process.env.PPT_DB_OPEN_MARKER);');
    const storageAt = source.indexOf('const storage = createStorage();');
    expect(markerAt).toBeGreaterThan(0);
    expect(storageAt).toBeGreaterThan(markerAt);
    // Only comments and whitespace may sit between them.
    const between = source.slice(markerAt + 'writeDatabaseOpenMarker(process.env.PPT_DB_OPEN_MARKER);'.length, storageAt)
      .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//'));
    expect(between).toEqual([]);
    // main() opens tracker.db only through this one storage.
    expect(source.match(/createStorage\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/new Database\(/);
  });
});
