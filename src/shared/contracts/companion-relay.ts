import type { SatelliteTelemetryScope } from './satellite-registry.js';
import type {
  ApprovalAttribution,
  ApprovalGrantMode,
  ApprovalSourceSystem,
} from './approval-envelope.js';
import type { ToolCallOutcome } from './tool-call-outcome.js';
import type { AcacAxis } from './emotion-contracts.js';

export type {
  ApprovalAttribution,
  ApprovalGrantMode,
  ApprovalSourceSystem,
} from './approval-envelope.js';

/**
 * Companion event relay contract (bead w9hj.1).
 *
 * The companion runtime pushes REDACTED operational events to the Satellite Hub over an
 * authenticated SSE stream, and accepts approval decisions back. The hub is
 * always the HTTP client (same direction as `/v1/chat/completions` and the
 * satellite config pull).
 *
 * HTTP surface (served by the gateway-hosted API edge):
 * - `GET  /v1/companion/events`                 — authenticated SSE stream
 * - `POST /v1/companion/approvals/{id}`         — approval decision
 * - `POST /v1/companion/stimuli`                — typed physical interaction
 * - `GET  /v1/companion/artifacts/{id}/preview` — read-only artifact preview
 *
 * These payload shapes mirror hub protocol messages 1:1 — do not deviate.
 * Everything in a payload has passed through `companion/redaction.ts` before
 * emission; raw tool params, file contents, chain-of-thought, and transcript
 * text never enter these shapes.
 */

export const COMPANION_EVENT_KINDS = [
  'approval.requested',
  'approval.resolved',
  'artifact.created',
  'tool.activity',
  'emotion.snapshot',
] as const;

export type CompanionEventKind = typeof COMPANION_EVENT_KINDS[number];

/** Explicit wire capability for the complete approval-request envelope. */
export const COMPANION_APPROVALS_V2_CAPABILITY = 'approvals.v2' as const;

export const COMPANION_APPROVAL_RESOLUTION_STATUSES = [
  'approved',
  'denied',
  'expired',
  'blocked',
] as const;

export type CompanionApprovalResolutionStatus =
  typeof COMPANION_APPROVAL_RESOLUTION_STATUSES[number];

export const COMPANION_TOOL_ACTIVITY_PHASES = [
  'started',
  'progress',
  'completed',
  'failed',
  'rejected',
  'skipped',
] as const;

export type CompanionToolActivityPhase = typeof COMPANION_TOOL_ACTIVITY_PHASES[number];

/**
 * Approval-request wire payload.
 *
 * v1 fields (`id`, `title`, `requestedAt`, `expiresAt?`, `redactedContext`,
 * `status`) are the original contract and must never change shape. The v2
 * fields below (bead psfn-framework-13sk) are the unified-envelope projection
 * (`approval-envelope.ts`): all ADDITIVE and OPTIONAL, all server-resolved, all
 * built through the redaction whitelist by explicit construction. Emission of
 * the v2 fields is gated behind the client's `approvals.v2` advertisement at the
 * relay/route boundary — an old client only ever sees the v1 subset.
 */
export interface CompanionApprovalRequestedPayload {
  id: string;
  title: string;
  requestedAt: string;
  expiresAt?: string;
  redactedContext: string;
  status: 'pending';
  // ── v2 (approvals.v2) — additive, optional, server-resolved ──
  /** Which subsystem raised the request (tag only, never authority). */
  sourceSystem?: ApprovalSourceSystem;
  /** Server-resolved lineage; ids opaque, labels presentation-only. */
  attribution?: ApprovalAttribution;
  /** Redacted action verb (also folded into `title`). */
  action?: string;
  /** Redacted normalized resource scope (also folded into `title`). */
  scope?: string;
  /** Redacted companion-authored reason (also carried as `redactedContext`). */
  reason?: string;
  /** Offered grant mode. Server emits `{ kind: 'once' }` until TTL policy ships. */
  grantMode?: ApprovalGrantMode;
}

/**
 * A complete v2 approval request. Internal producers and v2-only browser
 * surfaces use this shape so missing attribution cannot silently degrade to
 * the legacy projection.
 */
export type CompanionApprovalRequestedV2Payload =
  CompanionApprovalRequestedPayload
  & Required<Pick<
  CompanionApprovalRequestedPayload,
  'sourceSystem' | 'attribution' | 'action' | 'scope' | 'reason' | 'grantMode'
  >>;

export interface CompanionApprovalResolvedPayload {
  id: string;
  status: CompanionApprovalResolutionStatus;
  resolvedAt: string;
  /**
   * Optional server-resolved shard provenance (bead psfn-framework-mus2.3).
   * Present iff the resolved request was a shard-originated approval; it is the
   * exact `shardId` captured at enqueue, never client-supplied. Opaque routing
   * key, not an owner. An ordinary companion resolution omits it, so old clients
   * keep parsing the unchanged v1 subset.
   */
  shardId?: string;
}

export interface CompanionArtifactCreatedPayload {
  id: string;
  label: string;
  mediaType: string;
  provenance: string;
  createdAt: string;
  previewable: boolean;
}

export interface CompanionToolActivityPayload {
  id: string;
  tool: string;
  phase: CompanionToolActivityPhase;
  outcome?: ToolCallOutcome;
  detail?: string;
  timestamp: string;
}

/**
 * What caused an `emotion.snapshot` to be emitted (bead psfn-framework-7ang.1):
 * either the steady per-turn cadence (`post_turn`) or a large enough VAD
 * movement detected by the emotion appraisal gate (`vad_shift`). Descriptive
 * only — never an authorization signal.
 */
export const COMPANION_EMOTION_SNAPSHOT_TRIGGERS = ['post_turn', 'vad_shift'] as const;

export type CompanionEmotionSnapshotTrigger = typeof COMPANION_EMOTION_SNAPSHOT_TRIGGERS[number];

/** Rounded VAD/mood axis triple. Every component is in `[-1, 1]`. */
export interface CompanionEmotionVector {
  valence: number;
  arousal: number;
  dominance: number;
}

/** One discrete-emotion label and its rounded `[0, 1]` score. */
export interface CompanionEmotionDiscreteScore {
  label: string;
  score: number;
}

/** One ACAC axis and its rounded `[0, 1]` self-report SCORE. No rationale text. */
export interface CompanionEmotionAcacAxisScore {
  axis: AcacAxis;
  score: number;
}

/**
 * Redacted emotion snapshot (bead psfn-framework-7ang.1). Sourced from
 * `InternalState.emotional`, this payload crosses the companion relay as a
 * PRIVACY SURFACE and is built field-by-field from a whitelist in
 * `companion/redaction.ts`. It carries ONLY the rounded VAD + mood vectors, the
 * top-K discrete labels/scores, the aggregate confidence, and the ACAC axis
 * SCORES. It never carries ACAC rationale text, active concerns, salient
 * entities, telemetry provenance, or any other private internal-state field.
 */
export interface CompanionEmotionSnapshotPayload {
  trigger: CompanionEmotionSnapshotTrigger;
  vad: CompanionEmotionVector;
  mood: CompanionEmotionVector;
  /** Top-K discrete labels by score, descending. Bounded and rounded. */
  discrete: CompanionEmotionDiscreteScore[];
  confidence: number;
  /** ACAC axis scores only (rationale is dropped at redaction). Omitted when absent. */
  acacAxes?: CompanionEmotionAcacAxisScore[];
  /** ISO timestamp of the snapshot sample. */
  timestamp: string;
}

export type CompanionEventPayload =
  | CompanionApprovalRequestedPayload
  | CompanionApprovalResolvedPayload
  | CompanionArtifactCreatedPayload
  | CompanionToolActivityPayload
  | CompanionEmotionSnapshotPayload;

export interface CompanionEventEnvelope {
  kind: CompanionEventKind;
  payload: CompanionEventPayload;
  /** Authenticated parent routing owner retained through relay fan-out. */
  companionId?: string;
  /** Optional authenticated shard provenance; never an authorization key. */
  shardId?: string;
  sessionId?: string;
  channelId?: string;
  /** ISO timestamp. */
  emittedAt: string;
}

/**
 * Registry telemetry scope required to receive each event kind. Deny by
 * default: a satellite endpoint sees an event kind only when `satellites.json`
 * grants the mapped scope to that endpoint.
 */
export const COMPANION_EVENT_SCOPE_BY_KIND: Readonly<
  Record<CompanionEventKind, SatelliteTelemetryScope>
> = Object.freeze({
  'approval.requested': 'approvals',
  'approval.resolved': 'approvals',
  'artifact.created': 'artifacts',
  'tool.activity': 'tool_activity',
  'emotion.snapshot': 'emotion',
});

export function companionEventKindsForScopes(
  scopes: readonly SatelliteTelemetryScope[],
): CompanionEventKind[] {
  const granted = new Set(scopes);
  return COMPANION_EVENT_KINDS.filter(
    (kind) => granted.has(COMPANION_EVENT_SCOPE_BY_KIND[kind]),
  );
}

/** Body of `POST /v1/companion/approvals/{id}`. */
export interface CompanionApprovalDecisionRequest {
  decision: 'approve' | 'deny';
  satelliteId: string;
  deviceId: string;
}

/** 200 body of `POST /v1/companion/approvals/{id}`. */
export interface CompanionApprovalDecisionResponse {
  id: string;
  status: string;
}

export const COMPANION_TOUCH_STIMULUS_KINDS = [
  'headpat',
  'petting',
  'hug',
  'kiss',
] as const;

export type CompanionTouchStimulusKind = typeof COMPANION_TOUCH_STIMULUS_KINDS[number];

export const COMPANION_TOUCH_REGIONS = ['head', 'cheek', 'body'] as const;

export type CompanionTouchRegion = typeof COMPANION_TOUCH_REGIONS[number];

/** Body of `POST /v1/companion/stimuli`. No caller-authored prompt text is accepted. */
export interface CompanionTouchStimulusRequest {
  satelliteId: string;
  endpointId: string;
  claimType: string;
  sessionId: string;
  deviceId: string;
  kind: CompanionTouchStimulusKind;
  region: CompanionTouchRegion;
  count: number;
  durationMs: number;
  responseMode: 'respond' | 'observe';
}

/** 200 body of `POST /v1/companion/stimuli`. */
export interface CompanionTouchStimulusResponse {
  status: 'accepted';
  messageId: string;
  response?: string;
}

/**
 * Internal (agent → gateway) sidecar describing where a previewable artifact
 * lives on disk. This NEVER enters a `CompanionEventEnvelope`; the gateway
 * strips it into its preview registry before publishing the redacted payload.
 */
export interface CompanionArtifactPreviewSource {
  artifactId: string;
  localPath: string;
  mediaType: string;
  sizeBytes: number;
}
