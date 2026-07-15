/**
 * Gateway-owned fence/revocation seam for companion contact blocks.
 *
 * Implementations must resolve only after the authenticated companion's
 * pending initiation permits have been durably invalidated. The contact tool
 * invokes this on both sides of companion block persistence: first to fence
 * in-flight operations, then to drain the pre-persistence issue window.
 */
export interface ContactBlockPermitInvalidationPort {
  invalidatePendingInitiationPermitsForBlock(): Promise<{ revokedCount: number }>;
}
