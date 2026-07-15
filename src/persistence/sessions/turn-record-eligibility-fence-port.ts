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

  /**
   * Holds one outer critical section across a bounded set of TurnRecords.
   * Implementations must deduplicate and acquire the keys in one stable total
   * order so overlapping consumers cannot form an AB-BA wait cycle.
   */
  withTurnRecordEligibilityFences<T>(
    keys: readonly TurnRecordEligibilityFenceKey[],
    operation: () => Promise<T>,
  ): Promise<T>;
}
