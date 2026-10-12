/**
 * SharePoint publication destination (A7 seam).
 *
 * The SharePoint write path keeps its established, regression-tested code in
 * documents.ts › runDocumentCreate (probe read → write → exact-byte read-back,
 * observeSharePointTarget, lock retry). This plug gives the seam the parts it
 * dispatches on: availability (Amazon Employee ON + SharePoint connection
 * ready), stage addressing, observation through the router's observer, and
 * the completion key. `findPriorWrite` is always null and idempotency keys are
 * ignored: SharePoint writes go to an exact path, so a retry overwrites the
 * same item instead of creating another.
 */

import type { PublicationRemoteSnapshot } from './product-document-publications.js';
import type { ObservedRemote, PublicationDestinationProvider, PublicationTarget } from './publication-destination.js';

export function createSharePointDestination(deps: {
  amazonEmployee: () => boolean;
  connectionReady: () => boolean;
  /** documents.ts › observeSharePointTarget */
  observe?: (serverRelativeUrl: string, siteUrl: string | null, expectedItemId: string | null) => Promise<PublicationRemoteSnapshot>;
}): PublicationDestinationProvider {
  return {
    id: 'sharepoint',
    available() {
      if (!deps.amazonEmployee()) return { ok: false, reason: 'SharePoint publishing needs Settings → Workplace → Amazon Employee.' };
      if (!deps.connectionReady()) return { ok: false, reason: 'The SharePoint connection is not running.' };
      return { ok: true };
    },
    validateStageTarget(input) {
      const value = (input ?? {}) as { serverRelativeUrl?: unknown; siteUrl?: unknown };
      const address = typeof value.serverRelativeUrl === 'string' ? value.serverRelativeUrl.trim() : '';
      if (!address.startsWith('/')) throw new Error('A SharePoint target needs a server-relative path.');
      return { provider: 'sharepoint', container: typeof value.siteUrl === 'string' && value.siteUrl.trim() ? value.siteUrl.trim() : null, address, storedAs: 'native' };
    },
    async observe(target: PublicationTarget, options = {}): Promise<ObservedRemote | 'absent'> {
      if (!deps.observe) throw new Error('SharePoint observation is unavailable.');
      const snapshot = await deps.observe(target.address, target.container, options.expectedItemId ?? null);
      return { ...snapshot, verification: 'exact_bytes' };
    },
    async write() {
      // The SharePoint write stays in documents.ts › runDocumentCreate.
      return { kind: 'not_written', reason: 'SharePoint writes run through the established documents sync path.' };
    },
    async findPriorWrite() {
      return null;
    },
    async verify() {
      return { ok: false, kind: 'exact_bytes', reason: 'SharePoint read-back runs in documents.ts › runDocumentCreate.' };
    },
    captureUrl(target) {
      return target.address;
    },
  };
}
