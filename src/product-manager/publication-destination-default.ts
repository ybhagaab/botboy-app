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
