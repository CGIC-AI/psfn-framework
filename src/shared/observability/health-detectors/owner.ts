// ── Health-event tenancy helpers (beads psfn-framework-7qeo1.24.2-.4) ──
//
// Ownership is the axis every part of the detector plane has to agree on: the
// ledger keys episodes by it, the cycle refuses to close another tenant's
// episode with it, and each detector filters the observations it counts by it.
// One definition here keeps those three from drifting apart, which would show
// up as a fleet incident silently attributed to the wrong companion.

import type { HealthEventOwner } from '../../contracts/health-event.js';

/** Flat tenancy key: a companion's routing identity, or the system itself. */
export function healthEventOwnerKey(owner: HealthEventOwner): string {
  return owner.kind === 'companion' ? owner.companionId : owner.kind;
}

export function sameHealthEventOwner(left: HealthEventOwner, right: HealthEventOwner): boolean {
  return healthEventOwnerKey(left) === healthEventOwnerKey(right);
}
