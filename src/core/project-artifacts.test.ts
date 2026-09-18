import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStorage, type StorageLayer } from './storage.js';
import { createProjectArtifactService } from './project-artifacts.js';

describe('project HTML artifact association', () => {
  let storage: StorageLayer;
  let root: string;

  beforeEach(() => {
    storage = createStorage(':memory:');
    storage.initialize();
    storage.getDb().prepare("INSERT INTO projects (id,title,one_liner,brain_path,status) VALUES ('p1','One','','/tmp/one','active'),('p2','Two','','/tmp/two','active')").run();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-project-artifacts-'));
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('groups one canonical HTML path, auto-assigns one validated context, and never silently moves it', () => {
    const file = path.join(root, 'demo.html');
    fs.writeFileSync(file, '<h1>v1</h1>');
    const service = createProjectArtifactService({ db: storage.getDb(), filesRoot: root });
    const first = service.registerFile(file, ['p1']);
    expect(first).toMatchObject({ projectId: 'p1', assignment: 'assigned', assignmentRequired: false });
    fs.writeFileSync(file, '<h1>v2</h1>');
    expect(service.registerFile(file, ['p2'])).toMatchObject({ projectId: 'p1', assignment: 'conflict', assignmentRequired: true });
    expect(service.listForProject('p1')).toHaveLength(1);
    expect(service.listForProject('p1')[0].local.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('discovers legacy HTML as unassigned and owner assignment is optimistic', () => {
    fs.writeFileSync(path.join(root, 'legacy.html'), '<h1>legacy</h1>');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'not an artifact');
    const service = createProjectArtifactService({ db: storage.getDb(), filesRoot: root });
    service.discoverExisting();
    const [legacy] = service.listUnassigned();
    expect(legacy.fileName).toBe('legacy.html');
    const assigned = service.assign(legacy.id, 'p1', legacy.version);
    expect(assigned.projectId).toBe('p1');
    expect(() => service.assign(legacy.id, 'p2', legacy.version)).toThrow(/changed/);
  });

  it('rejects phantom missing paths and links only the configured BotBoy origin', () => {
    const file = path.join(root, 'demo.html');
    fs.writeFileSync(file, '<h1>demo</h1>');
    const db = storage.getDb();
    const service = createProjectArtifactService({ db, filesRoot: root });
    expect(service.registerFile(path.join(root, 'never-created.html'))).toBeNull();
    fs.mkdirSync(path.join(root, 'folder.html'));
    expect(service.registerFile(path.join(root, 'folder.html'))).toBeNull();
    service.registerFile(file, ['p1']);
    db.prepare("INSERT INTO visual_assets (id) VALUES ('va1')").run();
    db.prepare(`INSERT INTO visual_asset_versions (id,asset_id,ordinal,source_sha256,source_bytes,mime,width,height,original_rel_path) VALUES ('vav1','va1',1,?,10,'image/png',100,80,'visuals/x.png')`).run('c'.repeat(64));
    expect(service.linkVisualByUrl('http://localhost:3000/api/files/demo.html', 'vav1')).toBe(false);
    expect(service.linkVisualByUrl('https://localhost:7778/api/files/demo.html', 'vav1')).toBe(false);
    expect(service.linkVisualByUrl('http://localhost:7778/api/files/demo.html', 'vav1')).toBe(true);
    expect(service.listForProject('p1')[0].screenshot).toMatchObject({ assetId: 'va1', versionId: 'vav1' });
  });

  it('keeps newest failed attempt visible beside the latest fully verified live URL', () => {
    const file = path.join(root, 'demo.html');
    fs.writeFileSync(file, '<h1>demo</h1>');
    const db = storage.getDb();
    const service = createProjectArtifactService({ db, filesRoot: root });
    service.registerFile(file, ['p1']);
    const insert = db.prepare(`INSERT INTO static_artifact_publications (id,source_path,slug,manifest_sha256,manifest_json,total_bytes,transformations_json,app_name,stage,visibility,url,phase,deployed,content_verified,visibility_converged,error,created_at,updated_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const canonicalFile = fs.realpathSync(file);
    insert.run('old', canonicalFile, 'demo', 'a'.repeat(64), '[]', 10, '{}', 'app', 'beta', 'everyone', 'https://example/a/demo/', 'published', 1, 1, 1, null, '2026-09-17T01:00:00Z', '2026-09-17T01:00:00Z', '2026-09-17T01:00:00Z');
    insert.run('new', canonicalFile, 'demo', 'b'.repeat(64), '[]', 11, '{}', 'app', 'beta', 'everyone', 'https://example/a/demo/', 'failed_pre_deploy', 0, 0, 0, 'auth expired', '2026-09-17T02:00:00Z', '2026-09-17T02:00:00Z', null);
    const artifact = service.listForProject('p1')[0];
    expect(artifact.latestAttempt?.attemptId).toBe('new');
    expect(artifact.latestSuccessful?.attemptId).toBe('old');
    expect(artifact.attempts).toHaveLength(2);
  });
});
