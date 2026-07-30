import type { Pool } from 'pg';
import { MEMORY_SUBJECT_CLASSIFIER_VERSION } from '../../../shared/contracts/memory-subject.js';
import type {
  MemorySubjectClassificationCoverage,
} from '../memory-store-port.js';
import { parsePgNumber } from './rows.js';

interface SubjectClassificationCoverageRow {
  total_memory_count: number | string;
  current_classification_count: number | string;
}

/**
 * Inspect the exact classification freshness conditions used by subject
 * authorization. A row with a missing, stale, or evidence-mismatched
 * classification is counted as missing rather than silently treated as
 * covered.
 */
export async function inspectMemorySubjectClassificationCoverage(
  pool: Pool,
  checkedAt = Date.now(),
): Promise<MemorySubjectClassificationCoverage> {
  if (!Number.isFinite(checkedAt)) {
    throw new Error('Memory subject classification coverage timestamp must be finite');
  }
  const result = await pool.query<SubjectClassificationCoverageRow>(`
    SELECT
      COUNT(*) AS total_memory_count,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1
          FROM l2_memory_subject_classifications classification
          WHERE classification.memory_id = memory.id
            AND classification.status = 'current'
            AND classification.classifier_version = $1
            AND classification.memory_revision = memory.authorization_revision
            AND classification.evidence_digest = memory.subject_evidence_digest
        )
      ) AS current_classification_count
    FROM l2_memories memory
  `, [MEMORY_SUBJECT_CLASSIFIER_VERSION]);
  if (result.rowCount !== 1) {
    throw new Error('Memory subject classification coverage query returned no aggregate row');
  }
  const row = result.rows[0]!;
  const totalMemoryCount = parsePgNumber(row.total_memory_count, 'total_memory_count');
  const currentClassificationCount = parsePgNumber(
    row.current_classification_count,
    'current_classification_count',
  );
  if (
    !Number.isSafeInteger(totalMemoryCount)
    || !Number.isSafeInteger(currentClassificationCount)
    || totalMemoryCount < 0
    || currentClassificationCount < 0
    || currentClassificationCount > totalMemoryCount
  ) {
    throw new Error('Memory subject classification coverage counts are internally inconsistent');
  }
  return {
    checkedAt,
    totalMemoryCount,
    currentClassificationCount,
    missingCurrentClassificationCount: totalMemoryCount - currentClassificationCount,
  };
}
