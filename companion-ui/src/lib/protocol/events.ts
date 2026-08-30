/**
 * Canonical Companion UI event messages shared by the Hub and gateway-owned
 * transports. Action submission uses the gateway protocol; both transports
 * project inbound events into this one view-store contract.
 *
 * PROVENANCE: This file is a faithful client-side mirror of the hub's
 * authoritative wire types at:
 *   apps/satellite-hub/src/ts/shared/protocol.ts
 *
 * The hub is the source of truth for this retained mirror. Legacy clients
 * speak THESE message types — they do not invent shapes (charter §6.10:
 * the cockpit is an emanation node, not a mind; §8.3/Law 17: operational
 * state only).
 *
 * Transport reality (confirmed in hub/src/ts/hub/server.ts and
 * hub/src/ts/pi-client/client.ts): plain WebSocket, one JSON-serialized
 * message per text frame. Both directions call
 *   JSON.stringify(message) / JSON.parse(raw) as <Direction>Message
 * No envelope, no SSE, on the TS realtime path.
 *
 ///////////////////////////////////////////////////////////////////////////////////////////////////
 *
 * If this file and the hub's protocol.ts drift, the HUB WINS. Re-mirror.
 */
import type {
  ApprovalAttribution,
  ApprovalGrantMode,
  ApprovalSourceSystem,
} from '../../../../src/shared/contracts/approval-envelope.js';
import { COMPANION_APPROVALS_V2_CAPABILITY } from '../../../../src/shared/contracts/companion-relay.js';
import type { AcacAxis } from '../../../../src/shared/contracts/emotion-contracts.js';

export type { AcacAxis } from '../../../../src/shared/contracts/emotion-contracts.js';

export type {
  ApprovalAttribution,
  ApprovalGrantMode,
  ApprovalSourceSystem,
} from '../../../../src/shared/contracts/approval-envelope.js';

// ─────────────────────────────────────────────────────────────────────────────
// Client -> Hub
// ─────────────────────────────────────────────────────────────────────────────

export type ClientToHubMessage =
  | HelloMessage
  | AudioMessage
  | UserTextMessage
  | TextSignalMessage
  | PingMessage
  | InterruptMessage
  | RelaySttRequestMessage
  | RelayTtsRequestMessage
  | TurnStartMessage
  | TurnEndMessage
  | ApprovalDecisionMessage
  | ArtifactPreviewRequestMessage
  | TouchInteractionMessage
  | DeviceLocationMessage;

export interface HelloMessage {
  type: 'hello';
  capabilities: SatelliteCapabilities;
  eventCapabilities: CompanionEventCapability[];
}

export type CompanionEventCapability = typeof COMPANION_APPROVALS_V2_CAPABILITY;

export interface AudioMessage {
  type: 'audio';
  audio: string;
}

export interface UserTextMessage {
  type: 'user.text';
  text: string;
  interrupt?: boolean;
}

export interface TextSignalMessage {
  type: 'text';
  data: string;
}

export interface PingMessage {
  type: 'ping';
  sentAt: number;
}

export interface InterruptMessage {
  type: 'interrupt';
}

export interface RelaySttRequestMessage {
  type: 'relay.stt';
  requestId: string;
  audio: string;
  mimeType?: string;
  prompt?: string;
  language?: string;
}

export interface RelayTtsRequestMessage {
  type: 'relay.tts';
  requestId: string;
  text: string;
  voice?: string;
  model?: string;
}

export interface TurnStartMessage {
  type: 'turn.start';
  interrupt?: boolean;
}

export interface TurnEndMessage {
  type: 'turn.end';
  reason: string;
}

/**
 * Approval decision (approve/deny) for a hub-issued approval request.
 * Mirrors the hub control-plane message. The hub only relays approval
 * families to satellites that advertise the `approvals` control capability.
 */
export interface ApprovalDecisionMessage {
  type: 'approval.decision';
  id: string;
  decision: 'approve' | 'deny';
}

/**
 * Request to read a scoped artifact preview. Correlated back to the client
 * by `requestId` via `artifact.preview.result` / `artifact.preview.error`.
 */
export interface ArtifactPreviewRequestMessage {
  type: 'artifact.preview';
  requestId: string;
  artifactId: string;
}

export interface TouchInteractionMessage {
  type: 'touch.interaction';
  kind: 'headpat' | 'petting' | 'hug' | 'kiss';
  region: 'head' | 'cheek' | 'body';
  count: number;
  durationMs: number;
}

/**
 * Reduced GPS sample from a foregrounded phone satellite.
 *
 * RAW COORDINATES TERMINATE AT THE HUB. This is the only message in the union
 * that carries lat/lon, and it is only ever sent to a satellite hub that
 * geofences it into a place label. The hub NEVER forwards lat/lon toward PSFN
 * (privacy invariant, bead psfn-framework-7ang.8); transports that reach PSFN
 * directly (the gateway) fail closed rather than send this message.
 */
export interface DeviceLocationMessage {
  type: 'device.location';
  lat: number;
  lon: number;
  accuracyM: number;
  timestamp: number;
}

export type DeviceLocationRejectionReason =
  | 'unsupported_transport'
  | 'capability_unavailable'
  | 'configuration_unavailable'
  | 'invalid_sample'
  | 'transition_delivery_failed';

/** Coordinate-free Hub resolution state for recoverable phone feedback. */
export type DeviceLocationStatusMessage =
  | {
    type: 'device.location.status';
    status: 'located' | 'unzoned' | 'poor_accuracy';
  }
  | {
    type: 'device.location.status';
    status: 'rejected';
    reason: DeviceLocationRejectionReason;
  };

// ─────────────────────────────────────────────────────────────────────────────
// Hub -> Client
// ─────────────────────────────────────────────────────────────────────────────

export type HubToClientMessage =
  | SessionReadyMessage
  | HelloAckMessage
  | StatusMessage
  | TextMessage
  | AudioOutMessage
  | MessageEvent
  | ActionMessage
  | ErrorEventMessage
  | RelaySttResultMessage
  | RelayTtsChunkMessage
  | RelayTtsDoneMessage
  | RelayRequestErrorMessage
  | PongMessage
  | AssistantInterruptedCompatMessage
  | ApprovalRequestedMessage
  | ApprovalResolvedMessage
  | ArtifactCreatedMessage
  | ArtifactPreviewResultMessage
  | ArtifactPreviewErrorMessage
  | ToolActivityMessage
  | EmotionSnapshotMessage
  | DeviceLocationStatusMessage;

export interface SessionReadyMessage {
  type: 'session.ready';
  sessionId: string;
  channelId: string;
  deviceId: string;
  deviceName: string;
  satelliteId: string;
  audioFormat: string;
  place?: RuntimePlaceIdentity;
  identity?: RuntimeIdentity;
}

export interface HelloAckMessage {
  type: 'hello.ack';
  sessionId: string;
  channelId: string;
  deviceId: string;
  deviceName: string;
  satelliteId: string;
  satelliteName: string;
  capabilities: SatelliteCapabilities;
  eventCapabilities?: CompanionEventCapability[];
  place?: RuntimePlaceIdentity;
  identity?: RuntimeIdentity;
}

export interface StatusMessage {
  type: 'status';
  data: string;
}

export interface TextMessage {
  type: 'text';
  data: string;
}

export interface AudioOutMessage {
  type: 'audio';
  data: string;
}

export interface MessageEvent {
  type: 'message';
  data: {
    role: 'user' | 'assistant';
    content: string;
    live?: boolean;
    final?: boolean;
  };
}

export interface ActionMessage {
  type: 'action';
  data: 'interrupt' | 'pause-audio' | 'play-audio';
}

export interface ErrorEventMessage {
  type: 'error-event';
  data: {
    message: string;
  };
}

export interface RelaySttResultMessage {
  type: 'relay.stt.result';
  requestId: string;
  text: string;
  provider: string;
  latencyMs?: number;
}

export interface RelayTtsChunkMessage {
  type: 'relay.tts.chunk';
  requestId: string;
  audio: string;
}

export interface RelayTtsDoneMessage {
  type: 'relay.tts.done';
  requestId: string;
  mimeType: string;
}

export interface RelayRequestErrorMessage {
  type: 'relay.error';
  requestId: string;
  operation: 'stt' | 'tts';
  message: string;
}

export interface AssistantInterruptedCompatMessage {
  type: 'assistant.interrupted';
  sessionId: string;
}

export interface PongMessage {
  type: 'pong';
  sentAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Approvals control plane (hub -> client). Relayed only to satellites that
// advertise the `approvals` control capability.
// ─────────────────────────────────────────────────────────────────────────────

export type ApprovalResolvedStatus = 'approved' | 'denied' | 'expired' | 'blocked';

/**
 * v1 fields are the original contract. The v2 fields (approvals.v2, server bead
 * psfn-framework-13sk) are ADDITIVE and OPTIONAL — present only when the server
 * saw this client advertise `approvals.v2`. The framing parser tolerates unknown
 * future keys on this message so a newer server never drops the whole frame.
 */
export interface ApprovalRequestedMessage {
  type: 'approval.requested';
  data: {
    id: string;
    title: string;
    requestedAt: string;
    expiresAt?: string;
    redactedContext: string;
    status: 'pending';
    // ── v2 (approvals.v2) — additive, optional ──
    sourceSystem?: ApprovalSourceSystem;
    attribution?: ApprovalAttribution;
    action?: string;
    scope?: string;
    reason?: string;
    grantMode?: ApprovalGrantMode;
  };
}

export interface ApprovalResolvedMessage {
  type: 'approval.resolved';
  data: {
    id: string;
    status: ApprovalResolvedStatus;
    resolvedAt: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Artifact output plane (hub -> client). Relayed only to satellites that
// advertise the `artifact` output capability.
// ─────────────────────────────────────────────────────────────────────────────

export interface ArtifactCreatedMessage {
  type: 'artifact.created';
  data: {
    id: string;
    label: string;
    mediaType: string;
    provenance: string;
    createdAt: string;
    previewable: boolean;
  };
}

export interface ArtifactPreviewResultMessage {
  type: 'artifact.preview.result';
  requestId: string;
  artifactId: string;
  mediaType: string;
  /** base64-encoded preview payload */
  data: string;
}

export interface ArtifactPreviewErrorMessage {
  type: 'artifact.preview.error';
  requestId: string;
  artifactId: string;
  message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool activity output plane (hub -> client). Relayed only to satellites that
// advertise the `tool_activity` output capability.
// ─────────────────────────────────────────────────────────────────────────────

export type ToolActivityPhase = 'started' | 'progress' | 'completed' | 'failed';

export interface ToolActivityMessage {
  type: 'tool.activity';
  data: {
    id: string;
    tool: string;
    phase: ToolActivityPhase;
    detail?: string;
    timestamp: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Emotion telemetry plane (hub -> client). Relayed only to satellites that
// advertise the `emotion` telemetry scope (deny-by-default privacy surface).
//
// PROVENANCE: this is the client-side projection of the PSFN companion-relay
// `CompanionEmotionSnapshotPayload` (src/shared/contracts/companion-relay.ts,
// bead psfn-framework-7ang.1), re-mirrored here per bead psfn-framework-7ang.3.
// The hub relays the redacted payload as a flat `{ type, data }` frame like
// `tool.activity`. It carries ONLY rounded VAD/mood, top-K discrete
// labels/scores, aggregate confidence, and ACAC axis SCORES — never ACAC
// rationale, active concerns, or salient entities (charter §8.3 / §6.10).
// The hub is the source of truth for this retained mirror; if it drifts, the
// HUB WINS — re-mirror.
// ─────────────────────────────────────────────────────────────────────────────

export type EmotionSnapshotTrigger = 'post_turn' | 'vad_shift';

/** Signed VAD/mood axis triple; every component is in [-1, 1]. */
export interface EmotionVector {
  valence: number;
  arousal: number;
  dominance: number;
}

/** One discrete-emotion label and its [0, 1] score. Open-vocabulary label. */
export interface EmotionDiscreteScore {
  label: string;
  score: number;
}

/** One ACAC axis and its [0, 1] self-report score. No rationale text. */
export interface EmotionAcacAxisScore {
  axis: AcacAxis;
  score: number;
}

export interface EmotionSnapshotMessage {
  type: 'emotion.snapshot';
  data: {
    trigger: EmotionSnapshotTrigger;
    vad: EmotionVector;
    mood: EmotionVector;
    /** Top-K discrete labels by score, descending. Bounded and rounded. */
    discrete: EmotionDiscreteScore[];
    confidence: number;
    /** ACAC axis scores only. Omitted when absent. */
    acacAxes?: EmotionAcacAxisScore[];
    /** ISO timestamp of the snapshot sample. */
    timestamp: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared satellite capability + identity model (mirrors hub protocol.ts)
// ─────────────────────────────────────────────────────────────────────────────

export type SatelliteInputCapability =
  | 'text'
  | 'microphone_pcm'
  | 'final_transcript'
  | 'vision_upload'
  | 'wake_event'
  | 'device_location';

export type SatelliteOutputCapability =
  | 'text'
  | 'subtitle'
  | 'streamed_audio'
  | 'local_file_audio'
  | 'animation'
  | 'action'
  | 'expression'
  | 'gaze'
  | 'servo'
  | 'artifact'
  | 'tool_activity';

export type SatelliteControlCapability =
  | 'interrupt'
  | 'mute'
  | 'sleep_wake'
  | 'presence'
  | 'session_attach'
  | 'approvals'
  | 'touch';

export type SatelliteSafetyCapability =
  | 'action_allowlist'
  | 'confirmation_required'
  | 'local_only';

export interface SatelliteCapabilities {
  input?: SatelliteInputCapability[];
  output?: SatelliteOutputCapability[];
  control?: SatelliteControlCapability[];
  safety?: SatelliteSafetyCapability[];
}

export interface RuntimeParticipantIdentity {
  id?: string;
  name?: string;
}

export interface RuntimeUserIdentity extends RuntimeParticipantIdentity {
  canonicalContactId?: string;
}

export interface RuntimePlaceIdentity {
  id: string;
  name: string;
}

export interface RuntimeIdentity {
  companion?: RuntimeParticipantIdentity;
  user?: RuntimeUserIdentity;
  source: 'framework' | 'configured';
}
