import type Database from 'better-sqlite3';

export type PublicationDestinationDefaultSource =
  | 'completed_publication'
  | 'onedrive_capture'
  | 'sharepoint_list_files';

export interface PublicationDestinationDefault {
  status: 'resolved' | 'unresolved' | 'ambiguous' | 'unavailable';
  targetFolder: string | null;
  siteUrl: null;
  source: PublicationDestinationDefaultSource | null;
  evidenceCount: number;
  reason: string | null;
}

function unresolved(reason: string, status: PublicationDestinationDefault['status'] = 'unresolved'): PublicationDestinationDefault {
  return { status, targetFolder: null, siteUrl: null, source: null, evidenceCount: 0, reason };
}

export function decodeSharePointPath(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw.startsWith('/')) return null;
  if (/%(?![0-9A-Fa-f]{2})/.test(raw)) return null;
  try {
    return /%[0-9A-Fa-f]{2}/.test(raw) ? decodeURIComponent(raw) : raw;
  } catch {
    return null;
  }
}

export function personalDocumentsRoot(value: unknown): string | null {
  const decoded = decodeSharePointPath(value);
  if (!decoded) return null;
  const match = /^(\/personal\/[^/]+\/Documents)(?:\/.*)?$/.exec(decoded);
  return match?.[1] ?? null;
}

export function resolvePublicationDestinationCandidates(
  values: unknown[],
  source: PublicationDestinationDefaultSource,
): PublicationDestinationDefault {
  const roots = [...new Set(values.map(personalDocumentsRoot).filter((value): value is string => Boolean(value)))];
  if (!roots.length) return unresolved('No exact personal Documents root was found.');
  if (roots.length > 1) {
    return {
      status: 'ambiguous', targetFolder: null, siteUrl: null, source,
      evidenceCount: roots.length,
      reason: 'Multiple personal Documents roots were found; choose the destination explicitly.',
    };
  }
  return {
    status: 'resolved', targetFolder: roots[0], siteUrl: null, source,
    evidenceCount: values.length,
    reason: null,
  };
}

export function resolveLocalPublicationDestinationDefault(db: Database.Database): PublicationDestinationDefault {
  const completed = db.prepare(`
    SELECT server_relative_url AS path
    FROM product_document_publications
    WHERE status='complete' AND captured_work_item_id IS NOT NULL
      AND (site_url IS NULL OR trim(site_url)='')
    ORDER BY updated_at DESC
    LIMIT 200
  `).all() as Array<{ path: string }>;
  const fromPublications = resolvePublicationDestinationCandidates(
    completed.map(row => row.path), 'completed_publication',
  );
  if (fromPublications.status !== 'unresolved') return fromPublications;

  const captures = db.prepare(`
    SELECT json_extract(metadata,'$.serverRelativeUrl') AS path
    FROM work_items
    WHERE source='sharepoint' AND type='document_capture'
      AND json_extract(metadata,'$.sharePointSource')='onedrive'
      AND json_extract(metadata,'$.serverRelativeUrl') IS NOT NULL
    ORDER BY rowid DESC
    LIMIT 200
  `).all() as Array<{ path: string }>;
  const fromCaptures = resolvePublicationDestinationCandidates(
    captures.map(row => row.path), 'onedrive_capture',
  );
  if (fromCaptures.status !== 'unresolved') return fromCaptures;
  return unresolved('Connect or sync OneDrive once, or enter the folder explicitly.');
}

export function unavailablePublicationDestinationDefault(reason: string): PublicationDestinationDefault {
  return unresolved(reason, 'unavailable');
}

/** A provider-tagged Google Drive destination candidate (A7). */
export interface DriveDestinationCandidate {
  provider: 'gdrive';
  accountId: string;
  accountEmail: string;
  /** A Drive folder id, or 'botboy' for My Drive › BotBoy (created on first sync). */
  folderId: string;
  label: string;
  source: 'botboy_folder' | 'project_last_used';
  storedAs: 'docx' | 'google_doc';
}

/**
 * Drive candidates only for accounts whose grant has drive.file: the
 * project's last-used Drive folder first, then My Drive › BotBoy per account.
 */
export function resolveDriveDestinationCandidates(
  db: Database.Database,
  accounts: ReadonlyArray<{ id: string; email: string; canPublishDrive?: boolean }>,
  projectId: string,
): DriveDestinationCandidate[] {
  const publishable = accounts.filter(account => account.canPublishDrive === true);
  if (!publishable.length) return [];
  const out: DriveDestinationCandidate[] = [];
  let lastUsed: { container: string; path: string } | undefined;
  try {
    lastUsed = projectId ? db.prepare(`
      SELECT destination_container AS container, server_relative_url AS path
      FROM product_document_publications
      WHERE destination_provider='gdrive' AND publication_action='create' AND status='complete' AND project_id=?
      ORDER BY updated_at DESC LIMIT 1
    `).get(projectId) as { container: string; path: string } | undefined : undefined;
  } catch { lastUsed = undefined; }
  const lastAccount = lastUsed ? publishable.find(account => account.id === lastUsed!.container) : undefined;
  const lastFolder = lastUsed?.path.split('/')[0];
  if (lastAccount && lastFolder) {
    out.push({
      provider: 'gdrive', accountId: lastAccount.id, accountEmail: lastAccount.email, folderId: lastFolder,
      label: lastFolder === 'botboy' ? `My Drive › BotBoy (${lastAccount.email})` : `Last used folder (${lastAccount.email})`,
      source: 'project_last_used', storedAs: 'docx',
    });
  }
  for (const account of publishable) {
    if (out.some(entry => entry.accountId === account.id && entry.folderId === 'botboy')) continue;
    out.push({
      provider: 'gdrive', accountId: account.id, accountEmail: account.email, folderId: 'botboy',
      label: `My Drive › BotBoy (${account.email})`, source: 'botboy_folder', storedAs: 'docx',
    });
  }
  return out;
}
