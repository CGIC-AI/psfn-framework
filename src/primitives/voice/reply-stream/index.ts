// VoiceReplyStream core (psfn-framework-mmo9.8.1) — pure, decision-independent.
// See reply-stream.ts for the Law 18 state machine and reconciliation tripwire.

export { isStreamEligible } from './eligibility.js';
export { createReplySegmenter, type ReplySegmenter } from './segmenter.js';
export { evaluateSegmentGates } from './content-gate.js';
export { createVoiceReplyStream, ReplyStreamReconciliationError } from './reply-stream.js';
export type {
  AbortResult,
  CommittedSegment,
  ContactContext,
  ContentGateConfig,
  ContentGateOutcome,
  ContentGateReason,
  EligibilityCriterion,
  EligibilityResult,
  FinalResult,
  PushResult,
  ReplyStreamAbortReason,
  ReplyStreamState,
  SegmenterConfig,
  TurnPreparation,
  TurnRiskSnapshot,
  VoiceReplyStream,
  VoiceReplyStreamOptions,
} from './types.js';
