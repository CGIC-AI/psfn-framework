// ── VoiceReplyStream core types (psfn-framework-mmo9.8.1) ──
//
// Pure, decision-independent contract for committed-segment voice streaming.
// Law 18 (load-bearing): provisional/uncommitted text must NEVER be releasable
// to a TTS sink through this module — only `committedSegment`s are speakable.
// The ordered concatenation of committed segments MUST equal the disposed
// `final.content`; a divergence is a fail-closed reconciliation tripwire.
//
// This file defines only shapes. Behaviour lives in eligibility.ts (the pure
// predicate), segmenter.ts (bounded-look-ahead segmentation), content-gate.ts
// (per-segment gate runner), and reply-stream.ts (the state machine).

import type { RuntimeDatetimePromptContextLike } from '../../../core/agent/substrate-agent/runtime-datetime-contradiction-guard.js';

// ── Eligibility (E1..E6) input snapshot ──────────────────────────────────────

/**
 * Conservative contact classification for the high-risk gate (E5). Only a
 * known-contact DM voice context is treated as low-risk; everything else is
 * high-risk and therefore stream-ineligible.
 */
export type ContactContext =
  | 'dm_known_contact'
  | 'group_known'
  | 'group_unknown'
  | 'unknown_contact';

/** Components of the E5 (not high-risk) decision, kept explicit for testability. */
export interface TurnRiskSnapshot {
  /** Normalized trust score for the counterparty of this turn. */
  readonly trustLevel: number;
  /** Minimum trust required to be considered low-risk for streaming. */
  readonly trustThreshold: number;
  /** True if there is an outstanding paid deliverable in this context. */
  readonly hasPendingPaidDeliverable: boolean;
  /** Conversational context classification. */
  readonly contactContext: ContactContext;
}

/**
 * Immutable up-front snapshot the eligibility predicate is a pure total function
 * of. Every field is decidable before/at dispatch with no content inspection.
 * (mmo9.8.2 formalizes the full TurnPreparation producer/contract; mmo9.8.1
 * owns the fields the eligibility predicate needs and this type is the seam
 * they share.)
 */
export interface TurnPreparation {
  readonly turnId: string;
  readonly cancellationId: string;
  /** E1: dispatch tool set. Only `tool_free` (structurally single-round) is eligible. */
  readonly toolDispatch: 'tool_free' | 'tool_capable';
  /** E2: any inbound attachment on the message. */
  readonly hasAttachmentInput: boolean;
  /** E2: the turn's purpose is vision (image understanding). */
  readonly isVisionTurn: boolean;
  /** E3: the channel is a broadcast channel (classified up front). */
  readonly broadcast: boolean;
  /** E4: fatigue hard-cap suppressed this turn before generation. */
  readonly fatigueSuppressed: boolean;
  /** E6: the turn is actually generating (not served from dedup / in-flight cache). */
  readonly liveGeneration: boolean;
  /** E5 components. */
  readonly risk: TurnRiskSnapshot;
}

export type EligibilityCriterion =
  | 'E1_tool_free'
  | 'E2_no_vision_attachment'
  | 'E3_not_broadcast'
  | 'E4_not_fatigue_suppressed'
  | 'E5_not_high_risk'
  | 'E6_live_generation';

export interface EligibilityResult {
  /** True iff every criterion passed (equivalently, `failed` is empty). */
  readonly eligible: boolean;
  /** All failing criteria in deterministic E1..E6 order (empty iff eligible). */
  readonly failed: readonly EligibilityCriterion[];
}

// ── Segmentation ─────────────────────────────────────────────────────────────

export interface SegmenterConfig {
  /**
   * Minimum length (chars) a mid-stream segment must reach before a sentence
   * boundary is allowed to release it. Prevents micro-fragments. Does not apply
   * to the final tail at flush.
   */
  readonly minSegmentLength: number;
  /**
   * Maximum buffered length before a clause/word break is forced (runaway
   * relief). Must be greater than `minSegmentLength`.
   */
  readonly maxBufferLength: number;
  /**
   * Additional lowercase, dot-stripped abbreviations that must not be treated
   * as sentence terminators (merged with the built-in set).
   */
  readonly extraAbbreviations?: readonly string[];
}

// ── Content gates (per-segment) ──────────────────────────────────────────────

export type ContentGateReason =
  | 'missing_image_attachment_claim'
  | 'runtime_datetime_contradiction';

export type ContentGateOutcome =
  | { readonly action: 'commit' }
  | { readonly action: 'abort'; readonly reason: ContentGateReason };

export interface ContentGateConfig {
  /**
   * Attachment count for the image-claim guard. For a stream-eligible turn E2
   * guarantees this is 0; the gate remains independent and accepts it as input.
   */
  readonly attachmentCount: number;
  /**
   * Turn-constant prompt snapshot used by the datetime detector to decide
   * whether a runtime datetime anchor was present. Content-local: the anchor is
   * a function of the (fixed) prompt and the contradiction is a pure function of
   * the asserted text. `null` disables the datetime gate (no anchor).
   */
  readonly datetimePromptContext: RuntimeDatetimePromptContextLike | null;
}

// ── State machine ────────────────────────────────────────────────────────────

export type ReplyStreamState = 'idle' | 'streaming' | 'finalized' | 'aborted';

export type ReplyStreamAbortReason =
  | ContentGateReason
  | 'cancelled'
  | 'external';

/** The ONLY object that may be handed to a TTS sink. */
export interface CommittedSegment {
  readonly seq: number;
  readonly text: string;
  readonly turnId: string;
  readonly cancellationId: string;
}

export interface PushResult {
  /** Newly committed segments (in order). Empty if nothing crossed a boundary. */
  readonly committed: readonly CommittedSegment[];
  /** Set when a gate tripped: the stream has forward-aborted. */
  readonly aborted?: { readonly reason: ReplyStreamAbortReason };
}

export interface FinalResult {
  readonly kind: 'final';
  /** Ordered concatenation of all committed segments; equals disposed content. */
  readonly content: string;
  readonly segments: readonly CommittedSegment[];
}

export interface AbortResult {
  readonly kind: 'abort';
  readonly reason: ReplyStreamAbortReason;
  /** Segments committed (and thus already speakable) before the abort. */
  readonly segments: readonly CommittedSegment[];
}

export interface VoiceReplyStreamOptions {
  readonly segmenter?: Partial<SegmenterConfig>;
  readonly gate: ContentGateConfig;
  /**
   * Optional telemetry sink for provisional deltas. These are the raw model
   * deltas — text-surface/telemetry ONLY. They are NEVER releasable to a TTS
   * sink through this module (Law 18).
   */
  readonly onProvisionalDelta?: (delta: string) => void;
}

export interface VoiceReplyStream {
  readonly state: ReplyStreamState;
  begin(turnId: string, cancellationId: string): void;
  pushDelta(text: string): PushResult;
  finalize(finalContent: string): FinalResult | AbortResult;
  abort(reason?: ReplyStreamAbortReason): AbortResult;
  readonly committedSegments: readonly CommittedSegment[];
  readonly committedContent: string;
}
