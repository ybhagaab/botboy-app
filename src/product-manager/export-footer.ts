/**
 * Document export footer (NON_AMAZON_PATHS_PLAN A1/D2).
 *
 * The text printed in the center of every page footer of PDF and Word
 * exports (and HTML exports when printed). Blank by default; the Amazon
 * Employee toggle never sets it. Installs that predate this build and were
 * ON at their first boot of it get a one-time stored "Amazon Confidential"
 * (setBy 'migration') so their exports do not silently change.
 */
import type Database from 'better-sqlite3';
import { getSetting, setSetting } from '../core/storage.js';

export const EXPORT_FOOTER_SETTING_KEY = 'documents.export_footer.v1';
export const EXPORT_FOOTER_MIGRATION_KEY = 'documents.export_footer.migration.v1';
export const LEGACY_AMAZON_FOOTER = 'Amazon Confidential';
export const EXPORT_FOOTER_MAX_CHARS = 120;
const FOOTER_NEXT_ACTION = 'Type one line of up to 120 characters, or leave it empty for no footer text.';

export type ExportFooterSetBy = 'settings' | 'chat' | 'migration';

interface StoredFooter {
  schema: 1;
  text: string;
  setBy: ExportFooterSetBy;
  updatedAt: string;
}

export interface ExportFooterStatus {
  text: string;
  source: 'owner' | 'kept' | 'default';
  setBy?: ExportFooterSetBy;
  updatedAt?: string;
}

export class ExportFooterError extends Error {
  readonly nextAction = FOOTER_NEXT_ACTION;
  constructor(readonly code: 'invalid_footer', message: string) {
    super(message);
    this.name = 'ExportFooterError';
  }
}

/** Authoritative footer validation (design §10.2, §23.6). */
export function normalizeExportFooterText(value: unknown): string {
  if (typeof value !== 'string') throw new ExportFooterError('invalid_footer', 'Footer text must be text.');
  const text = value.normalize('NFC').trim();
  if ([...text].length > EXPORT_FOOTER_MAX_CHARS) {
    throw new ExportFooterError('invalid_footer', 'Keep the footer to 120 characters or fewer.');
  }
  if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(text)) {
    throw new ExportFooterError('invalid_footer', 'Use one line of plain text.');
  }
  return text;
}

export interface ExportFooterSettings {
  seedLegacyFooterOnce(): void;
  effective(): string;
  status(): ExportFooterStatus;
  set(text: unknown, setBy: 'settings' | 'chat'): ExportFooterStatus;
}

function readStored(db: Database.Database): StoredFooter | null {
  const raw = getSetting<Partial<StoredFooter>>(db, EXPORT_FOOTER_SETTING_KEY);
  if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string') return null;
  return raw as StoredFooter;
}

export function createExportFooterSettings(deps: {
  db: Database.Database;
  amazonEmployee: () => boolean;
  now?: () => Date;
}): ExportFooterSettings {
  const now = deps.now ?? (() => new Date());

  const status = (): ExportFooterStatus => {
    const stored = readStored(deps.db);
    if (!stored) return { text: '', source: 'default' };
    return {
      text: stored.text,
      source: stored.setBy === 'migration' ? 'kept' : 'owner',
      setBy: stored.setBy,
      updatedAt: stored.updatedAt,
    };
  };

  return {
    seedLegacyFooterOnce() {
      try {
        if (getSetting<unknown>(deps.db, EXPORT_FOOTER_MIGRATION_KEY) !== null) return;
        const at = now().toISOString();
        let decision: 'kept_amazon_confidential' | 'blank' | 'already_set';
        if (readStored(deps.db)) {
          decision = 'already_set';
        } else if (deps.amazonEmployee() && deps.db.prepare('SELECT 1 FROM work_items LIMIT 1').get()) {
          setSetting(deps.db, EXPORT_FOOTER_SETTING_KEY, { schema: 1, text: LEGACY_AMAZON_FOOTER, setBy: 'migration', updatedAt: at } satisfies StoredFooter);
          decision = 'kept_amazon_confidential';
        } else {
          decision = 'blank';
        }
        setSetting(deps.db, EXPORT_FOOTER_MIGRATION_KEY, { schema: 1, decision, at });
      } catch (error) {
        console.warn(`[ExportFooter] seed skipped (${error instanceof Error ? error.name : 'error'})`);
      }
    },
    // D2: never reads the toggle. An empty stored string means "no footer text".
    effective: () => readStored(deps.db)?.text ?? '',
    status,
    set(text, setBy) {
      if (setBy !== 'settings' && setBy !== 'chat') {
        throw new ExportFooterError('invalid_footer', 'Only the owner can set the footer.');
      }
      const normalized = normalizeExportFooterText(text);
      setSetting(deps.db, EXPORT_FOOTER_SETTING_KEY, { schema: 1, text: normalized, setBy, updatedAt: now().toISOString() } satisfies StoredFooter);
      return status();
    },
  };
}
