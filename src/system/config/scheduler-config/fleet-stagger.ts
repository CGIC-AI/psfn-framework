import { isRecord } from '../../../shared/utils/types.js';
import { toInterval } from './primitives.js';

/**
 * Fleet stagger for fixed wall-clock work (psfn-framework-vcq8v.7).
 *
 * In a multi-companion fleet every companion shares the same wall-clock slots
 * (daily/weekly reflection, episode synthesis, morning wake) and the same
 * relative poll phase after a fleet rollout (free-time checks). Each companion
 * is offset deterministically by its fleet-manifest ordinal, spread evenly
 * across `windowMs` after the slot, so the fleet does not fire together and
 * contend for the shared model-call gate. The offset is stable for a stable
 * manifest; a single-companion deployment has no fleet and no offset.
 */
export interface FleetStaggerConfig {
  /** Width of the window companions' slot offsets are spread across (ms). */
  windowMs: number;
}

export const DEFAULT_FLEET_STAGGER_CONFIG: FleetStaggerConfig = {
  windowMs: 3_600_000,
};

export function validateFleetStaggerConfig(
  value: unknown,
  sourcePath: string,
): FleetStaggerConfig {
  if (!isRecord(value)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: fleetStagger must be an object`);
  }
  return {
    windowMs: toInterval(value.windowMs, 'fleetStagger.windowMs'),
  };
}
