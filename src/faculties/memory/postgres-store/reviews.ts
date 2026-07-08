import type { MemoryMaintenanceReview } from '../memory-store-port.js';
import { mapStoredMemoryMaintenanceReviewRow } from '../maintenance-review.js';
import type { MemoryMaintenanceReviewPgRow } from './rows.js';
import { serializeJsonValue } from './rows.js';

export function fromMaintenanceReviewRow(row: MemoryMaintenanceReviewPgRow): MemoryMaintenanceReview {
  return mapStoredMemoryMaintenanceReviewRow({
    id: row.id,
    kind: row.kind,
    status: row.status,
    subjectMemoryId: row.subject_memory_id,
    candidateMemoryIdsJson: serializeJsonValue(row.candidate_memory_ids),
    stateJson: serializeJsonValue(row.state_json),
    quarantineReason: row.quarantine_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
