import { describe, expect, it } from 'vitest';
import { createStorage } from '../core/storage.js';
import { createProductDocumentPublicationService, productDocumentPublicationIntentKey } from './product-document-publications.js';
import { createPublicationDestinations, type PublicationDestinationProvider } from './publication-destination.js';
import type { ProductDocumentService } from './types.js';

const NEW_COLUMNS = ['destination_provider', 'destination_container', 'destination_stored_as', 'idempotency_key', 'export_token_count', 'export_tokens_sha256', 'export_md5', 'verification_kind'];

describe('A7 ledger migration', () => {
  it('reads pre-existing rows as SharePoint with byte-identical intent keys', () => {
    const storage = createStorage(':memory:');
    storage.initialize();
    const db = storage.getDb();
    const service = { getArtifact: () => null } as unknown as ProductDocumentService;
    createProductDocumentPublicationService(db, service);
    // Recreate the table as it was before the seam (no destination columns).
    for (const column of NEW_COLUMNS) db.exec(`ALTER TABLE product_document_publications DROP COLUMN ${column}`);
    const intentKey = productDocumentPublicationIntentKey({ artifactId: 'a1', projectId: 'p1', action: 'create', format: 'docx', docKey: 'sp-doc-key' });
    db.prepare(`INSERT INTO product_document_publications
      (publication_id, artifact_id, project_id, publication_action, intent_key, format, pending_edit_id, status, server_relative_url, doc_key, created_at, updated_at)
      VALUES ('pub1','a1','p1','create',?,'docx','pe1','complete','/personal/u/Documents/a.docx','sp-doc-key','2026-01-01','2026-01-01')`).run(intentKey);
    const migrated = createProductDocumentPublicationService(db, service).get('pub1')!;
    expect(migrated).toMatchObject({ destinationProvider: 'sharepoint', destinationStoredAs: 'native', idempotencyKey: null, destinationContainer: null });
    expect(migrated.intentKey).toBe(intentKey);
    expect(() => db.prepare("UPDATE product_document_publications SET destination_provider='dropbox'").run()).toThrow();
    storage.close();
  });
});

describe('destination registry', () => {
  it('dispatches by provider id and lists only available plugs', () => {
    const plug = (id: 'sharepoint' | 'gdrive', ok: boolean) => ({ id, available: () => (ok ? { ok: true } : { ok: false, reason: 'off' }) }) as unknown as PublicationDestinationProvider;
    const registry = createPublicationDestinations({ sharepoint: plug('sharepoint', false), gdrive: plug('gdrive', true) });
    expect(registry.get('gdrive')?.id).toBe('gdrive');
    expect(registry.available()).toEqual(['gdrive']);
    expect(createPublicationDestinations({}).get('sharepoint')).toBeNull();
  });
});
