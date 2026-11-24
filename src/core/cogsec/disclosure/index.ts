// ── CogSec outbound disclosure: public surface ──
//
// Contract types for the destination-eligibility axis (bible §9) and the pure,
// fail-closed decision functions over them. Runtime accumulation/egress wiring
// lives in later beads; this module is contract + pure logic only.

export * from './contracts.js';
export {
  accumulateDisclosureSource,
  beginDisclosureAccumulation,
} from './decision.js';
export {
  composeEgressDisclosureDecision,
  deriveDisclosureDestination,
  deriveRoomDisclosureDestination,
  isDisclosureSocialEgressInvocation,
} from './egress-composition.js';
export {
  buildShareCandidate,
} from './capsule.js';
export {
  projectPublicationProvenance,
  type PublicationProvenanceView,
} from './publication-provenance.js';
export {
  egressContentSha256,
  evaluateEgressCustodyHold,
  type CompletedTurnEgressCustody,
  type CompletedTurnEgressCustodyCapture,
  type EgressCustodyHoldReason,
  type EgressDeliveryRecordStorePort,
} from './egress-delivery-record.js';
export { EgressDeliveryRecorder } from './egress-delivery-recorder.js';
export {
  createCapsuleCustodyService,
  createShareCapsuleCustodyStore,
} from './capsule-custody.js';
