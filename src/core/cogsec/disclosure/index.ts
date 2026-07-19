// ── CogSec outbound disclosure: public surface ──
//
// Contract types for the destination-eligibility axis (bible §9) and the pure,
// fail-closed decision functions over them. Runtime accumulation/egress wiring
// lives in later beads; this module is contract + pure logic only.

export * from './contracts.js';
export {
  accumulateDisclosureSource,
  assessDisclosure,
  beginDisclosureAccumulation,
  destinationPermitted,
  intersectDestinationConstraints,
  maxSensitivity,
} from './decision.js';
