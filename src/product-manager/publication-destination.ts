/**
 * Publication destination seam (NON_AMAZON_PATHS_PLAN.md A7, D3; design §6.3).
 *
 * The ledger (product-document-publications.ts) owns the state machine,
 * pinned export bytes, and owner-UI approval. A destination provider owns only
 * the remote side: whether it is available, how a stage target is addressed,
 * observing the target, one write, finding an earlier write, verifying, and
 * the completion-capture key.
 *
 * Plugs: `sharepoint` (publication-destination-sharepoint.ts; Amazon Employee
 * ON + SharePoint connection ready) and `gdrive`
 * (publication-destination-gdrive.ts; an account whose grant has drive.file).
 */

import type { PublicationProviderId, PublicationRemoteSnapshot, PublicationStoredAs } from './product-document-publications.js';

export type { PublicationProviderId } from './product-document-publications.js';

export interface PublicationTarget {
  provider: PublicationProviderId;
  /** sharepoint: siteUrl; gdrive: Google account id */
  container: string | null;
  /** sharepoint: serverRelativeUrl; gdrive: `<folderId>/<filename>` (create) or `file/<fileId>/<filename>` (bound update) */
  address: string;
  /** gdrive: 'google_doc' | 'docx'; sharepoint: always 'native' */
  storedAs: PublicationStoredAs;
}

export interface ObservedRemote extends PublicationRemoteSnapshot {
  /** How verify() compares content: bytes, or normalized text tokens. */
  verification: 'exact_bytes' | 'normalized_text';
}

export type WriteOutcome =
  | { kind: 'written'; remoteItemId: string; webUrl?: string; etag?: string }
  /** Proven no effect: safe to retry. */
  | { kind: 'not_written'; reason: string }
  /** Effect unknown: never resend; only an explicit check may continue. */
  | { kind: 'unknown'; reason: string };

export class PublicationTargetConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicationTargetConflict';
  }
}

export interface PublicationDestinationProvider {
  id: PublicationProviderId;
  available(): { ok: true } | { ok: false; reason: string };
  validateStageTarget(input: unknown): PublicationTarget;
  /** create: prove absent (or adopt our own earlier file); update: observe the bound item. */
  observe(target: PublicationTarget, options?: { expectedItemId?: string | null; idempotencyKey?: string | null }): Promise<ObservedRemote | 'absent'>;
  write(input: {
    target: PublicationTarget;
    bytes: Buffer;
    filename: string;
    /** gdrive: required; sharepoint: null and ignored */
    idempotencyKey: string | null;
    publicationId: string;
    bound?: ObservedRemote;
  }): Promise<WriteOutcome>;
  /** gdrive: an earlier attempt by idempotency key; sharepoint: always null. */
  findPriorWrite(target: PublicationTarget, idempotencyKey: string): Promise<{ remoteItemId: string; webUrl?: string } | null>;
  /** Re-read after write. `ok` says whether the remote copy matches what BotBoy exported. */
  verify(target: PublicationTarget, remoteItemId: string, expected: {
    bytesSha256: string;
    md5?: string | null;
    tokensSha256?: string | null;
    tokenCount?: number | null;
  }): Promise<{ ok: boolean; kind: string; reason?: string; webUrl?: string; detail?: Record<string, unknown> }>;
  captureUrl(target: PublicationTarget, remoteItemId: string): string;
}

export interface PublicationDestinations {
  get(id: PublicationProviderId): PublicationDestinationProvider | null;
  /** Providers usable now (gating: SharePoint only with Amazon Employee ON; Drive only when connected). */
  available(): PublicationProviderId[];
}

export function createPublicationDestinations(plugs: Partial<Record<PublicationProviderId, PublicationDestinationProvider>>): PublicationDestinations {
  return {
    get: id => plugs[id] ?? null,
    available: () => (Object.keys(plugs) as PublicationProviderId[]).filter(id => plugs[id]?.available().ok),
  };
}
