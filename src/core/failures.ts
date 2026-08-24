/**
 * Failure recorder — central, non-silent failure/incomplete tracking for the
 * lossless-capture-brain-pipeline (Requirement 9).
 *
 * Every capture/parse/OCR/route/brain/content error MUST be recorded here
 * rather than swallowed by an empty catch. Recording writes a row to the
 * `failures` table and (optionally) flags the owning work item as incomplete so
 * it stays eligible for reprocessing. Aggregate counts are exposed for the
 * health endpoint.
 */

import type Database from 'better-sqlite3';

export type FailureStep =
  | 'capture'
  | 'parse'
  | 'ocr'
  | 'route'
  | 'brain'
  | 'content'
  | 'migration';

export interface FailureInput {
  itemId?: string;
  step: FailureStep;
  message: string;
  /** Whether the item can be retried later (default true). */
  retryable?: boolean;
  /** Also mark the work item as incomplete (partial content). Default false. */
  markIncomplete?: boolean;
}

export interface FailureHealth {
  totalFailures: number;
  failuresByStep: Record<string, number>;
  retryableFailures: number;
  incompleteItems: number;
}

export interface FailureRecorder {
  record(input: FailureInput): void;
  health(): FailureHealth;
}

export function createFailureRecorder(db: Database.Database): FailureRecorder {
  const insertStmt = db.prepare(
    `INSERT INTO failures (item_id, step, message, retryable) VALUES (?, ?, ?, ?)`,
  );
  const markIncompleteStmt = db.prepare(
    `UPDATE work_items SET incomplete = 1 WHERE id = ?`,
  );

  return {
    record(input: FailureInput): void {
      const retryable = input.retryable === false ? 0 : 1;
      // Truncate the stored message defensively — the message is diagnostic,
      // not content, so a bound here does not violate losslessness.
      const message = (input.message ?? '').slice(0, 2000);
      try {
        insertStmt.run(input.itemId ?? null, input.step, message, retryable);
        if (input.markIncomplete && input.itemId) {
          markIncompleteStmt.run(input.itemId);
        }
      } catch (err) {
        // Last-resort: never throw from the failure recorder itself, but make
        // the meta-failure visible on the console rather than fully silent.
        console.error(
          `[failures] could not record failure (${input.step}): ${(err as Error).message}`,
        );
      }
    },

    health(): FailureHealth {
      const total = (db.prepare('SELECT COUNT(*) AS c FROM failures').get() as { c: number }).c;
      const retryable = (
        db.prepare('SELECT COUNT(*) AS c FROM failures WHERE retryable = 1').get() as { c: number }
      ).c;
      const incomplete = (
        db.prepare('SELECT COUNT(*) AS c FROM work_items WHERE incomplete = 1').get() as { c: number }
      ).c;
      const byStepRows = db
        .prepare('SELECT step, COUNT(*) AS c FROM failures GROUP BY step')
        .all() as { step: string; c: number }[];
      const failuresByStep: Record<string, number> = {};
      for (const r of byStepRows) failuresByStep[r.step] = r.c;

      return {
        totalFailures: total,
        failuresByStep,
        retryableFailures: retryable,
        incompleteItems: incomplete,
      };
    },
  };
}
