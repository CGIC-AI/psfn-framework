export interface TurnRecordEligibilityFenceKey {
  logicalSessionId: string;
  turnId: string;
}

/**
 * Serializes source-eligibility mutations with consumers of one canonical
 * TurnRecord. Implementations must coordinate across every runtime process
 * that can read or revoke the same companion session state.
 */
export interface TurnRecordEligibilityFencePort {
  withTurnRecordEligibilityFence<T>(
    key: TurnRecordEligibilityFenceKey,
    operation: () => Promise<T>,
  ): Promise<T>;
}
