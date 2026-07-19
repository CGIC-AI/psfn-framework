import type { PolicyReasonTag } from './trust-contracts.js';

export type MemoryWithheldReasonTag =
  | 'session_quarantine.blocked'
  | 'room_visibility.blocked'
  | 'contact_scope.high_intimacy'
  | Exclude<PolicyReasonTag, 'operator.approval_override' | 'default.within_bounds'>;

export type MemoryWithheldReasonCounts = Partial<Record<MemoryWithheldReasonTag, number>>;
export type MemoryWithheldRelevanceBand = 'high' | 'medium' | 'low';
export type MemoryWithheldRelevanceBandCounts = Partial<Record<MemoryWithheldRelevanceBand, number>>;

export interface MemoryWithheldSummary {
  totalCount: number;
  reasonCounts: MemoryWithheldReasonCounts;
  relevanceBands?: MemoryWithheldRelevanceBandCounts;
}
