import { ACAC_AXES, type AcacAxis, type AcacSnapshot } from '../../shared/contracts/emotion-contracts.js';

/**
 * Extract ONLY the ACAC axis scores from a self-report snapshot for the
 * companion emotion relay (bead psfn-framework-7ang.1).
 *
 * The axis `rationale` text is deliberately dropped here, at the source, so it
 * never enters the agent event bus, the RPC boundary, or a relay payload. Only
 * the canonical axes survive, in their fixed order. Returns `undefined` when no
 * ACAC snapshot is present so the caller omits the field entirely.
 */
export function extractRelayAcacAxisScores(
  acac: AcacSnapshot | undefined,
): Partial<Record<AcacAxis, number>> | undefined {
  if (!acac) return undefined;
  const scores: Partial<Record<AcacAxis, number>> = {};
  for (const axis of ACAC_AXES) {
    // `acac.axes` is a normalized full axis map; take only the score and drop
    // rationale. Guard against a non-finite score, never against a missing axis.
    const score = acac.axes[axis].score;
    if (Number.isFinite(score)) {
      scores[axis] = score;
    }
  }
  return Object.keys(scores).length > 0 ? scores : undefined;
}
