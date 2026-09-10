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
  | TouchInteractionMessage
  | DeviceLocationMessage
  | ApprovalDecisionMessage
  | ArtifactPreviewRequestMessage
  | WorldTravelRequestMessage
  | WorldBodyActionMessage;

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
  | DeviceLocationStatusMessage
  | WorldTravelResultMessage
  | WorldBodyActionResultMessage;

export interface HelloMessage {
  type: "hello";
  deviceId: string;
  deviceName: string;
  sessionId?: string;
  channelId?: string;
  satelliteId?: string;
  satelliteName?: string;
  capabilities?: SatelliteCapabilities;
  /** Per-device secret; consumed during hello and never echoed or logged. */
  credential?: string;
}

export interface AudioMessage {
  type: "audio";
  audio: string;
}

/**
 * Ask the Hub to move its world-avatar emanation to another world.
 *
 * The Hub, not the satellite, owns the move: it holds the door credential, the
 * place map, and the refusal policy. This message is only a request, and it is
 * answered by exactly one `world.travel.result`.
 */
export interface WorldTravelRequestMessage {
  type: "world.travel";
  world: string;
}

/**
 * Ask the Hub's world-avatar emanation to move its body inside the world it is
 * already in. The Hub owns the allowlist (`walk_to`, `face`, `stop`); a name
 * outside it is refused here rather than forwarded, so world-editing verbs stay
 * unreachable through this surface. Submission is fire-and-forget: a walk can
 * take a minute and reports its content-free outcome on a later turn.
 */
export interface WorldBodyActionMessage {
  type: "world.body";
  action: string;
  arguments?: unknown;
}

export interface UserTextMessage {
  type: "user.text";
  text: string;
  interrupt?: boolean;
}

export interface TextSignalMessage {
  type: "text";
  data: string;
}

export interface PingMessage {
  type: "ping";
  sentAt: number;
}

export interface InterruptMessage {
  type: "interrupt";
}

export interface RelaySttRequestMessage {
  type: "relay.stt";
  requestId: string;
  audio: string;
  mimeType?: string;
  prompt?: string;
  language?: string;
}

export interface RelayTtsRequestMessage {
  type: "relay.tts";
  requestId: string;
  text: string;
  voice?: string;
  model?: string;
}

export interface TurnStartMessage {
  type: "turn.start";
  interrupt?: boolean;
}

export interface TurnEndMessage {
  type: "turn.end";
  reason: string;
}

export type TouchStimulusKind = "headpat" | "petting" | "hug" | "kiss";

export type TouchRegion = "head" | "cheek" | "body";

export interface TouchInteractionMessage {
  type: "touch.interaction";
  kind: TouchStimulusKind;
  region: TouchRegion;
  count: number;
  durationMs: number;
}

/** Raw coordinates terminate at the authenticated Satellite Hub handler. */
export interface DeviceLocationMessage {
  type: "device.location";
  lat: number;
  lon: number;
  accuracyM: number;
  timestamp: number;
}

export interface SessionReadyMessage {
  type: "session.ready";
  sessionId: string;
  channelId: string;
  deviceId: string;
  deviceName: string;
  satelliteId: string;
  audioFormat: string;
  capabilities: SatelliteCapabilities;
  identity?: RuntimeIdentity;
}

export interface HelloAckMessage {
  type: "hello.ack";
  sessionId: string;
  channelId: string;
  deviceId: string;
  deviceName: string;
  satelliteId: string;
  satelliteName: string;
  capabilities: SatelliteCapabilities;
  identity?: RuntimeIdentity;
}

export interface StatusMessage {
  type: "status";
  data: string;
}

export interface TextMessage {
  type: "text";
  data: string;
}

export interface AudioOutMessage {
  type: "audio";
  data: string;
}

export interface MessageEvent {
  type: "message";
  data: {
    role: "user" | "assistant";
    content: string;
    live?: boolean;
    final?: boolean;
  };
}

export interface ActionMessage {
  type: "action";
  data: "interrupt" | "pause-audio" | "play-audio";
}

export interface ErrorEventMessage {
  type: "error-event";
  data: {
    message: string;
    /** A spoken-output failure leaves the chat session and text reply valid. */
    scope?: "speech";
  };
}

export type DeviceLocationRejectionReason =
  | "unsupported_transport"
  | "capability_unavailable"
  | "configuration_unavailable"
  | "invalid_sample"
  | "transition_delivery_failed";

/** Coordinate-free resolution state returned only to the originating phone. */
export type DeviceLocationStatusMessage =
  | {
    type: "device.location.status";
    status: "located" | "unzoned" | "poor_accuracy";
  }
  | {
    type: "device.location.status";
    status: "rejected";
    reason: DeviceLocationRejectionReason;
  };

/**
 * Why a `world.travel` request did not move the emanation. A fixed Hub-owned
 * vocabulary: the door's own prose never reaches a satellite.
 */
export type WorldTravelRejectionReason =
  | "not_configured"
  | "capability_denied"
  | "unavailable"
  | "invalid_world"
  | "unmapped_world"
  | "refused";

/** The single answer to one `world.travel` request. */
export type WorldTravelResultMessage =
  | {
    type: "world.travel.result";
    accepted: true;
    world: string;
    placeId?: string;
  }
  | {
    type: "world.travel.result";
    accepted: false;
    world: string;
    reason: WorldTravelRejectionReason;
  };

/** Why a `world.body` request was not submitted. */
export type WorldBodyRejectionReason =
  | "not_configured"
  | "capability_denied"
  | "not_allowlisted";

/** The single answer to one `world.body` request. Acceptance is submission,
 *  never completion — the outcome reaches the companion as a later turn's
 *  context note. */
export type WorldBodyActionResultMessage =
  | {
    type: "world.body.result";
    accepted: true;
    action: string;
  }
  | {
    type: "world.body.result";
    accepted: false;
    action: string;
    reason: WorldBodyRejectionReason;
  };

export interface RelaySttResultMessage {
  type: "relay.stt.result";
  requestId: string;
  text: string;
  provider: string;
  latencyMs?: number;
}

export interface RelayTtsChunkMessage {
  type: "relay.tts.chunk";
  requestId: string;
  audio: string;
}

export interface RelayTtsDoneMessage {
  type: "relay.tts.done";
  requestId: string;
  mimeType: string;
}

export interface RelayRequestErrorMessage {
  type: "relay.error";
  requestId: string;
  operation: "stt" | "tts";
  message: string;
}

export interface AssistantInterruptedCompatMessage {
  type: "assistant.interrupted";
  sessionId: string;
}

export interface PongMessage {
  type: "pong";
  sentAt: number;
}

export type ApprovalResolutionStatus = "approved" | "denied" | "expired" | "blocked";

export type ToolActivityPhase = "started" | "progress" | "completed" | "failed";

export interface ApprovalRequestedMessage {
  type: "approval.requested";
  data: {
    id: string;
    title: string;
    requestedAt: string;
    expiresAt?: string;
    redactedContext: string;
    status: "pending";
  };
}

export interface ApprovalResolvedMessage {
  type: "approval.resolved";
  data: {
    id: string;
    status: ApprovalResolutionStatus;
    resolvedAt: string;
  };
}

export interface ArtifactCreatedMessage {
  type: "artifact.created";
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
  type: "artifact.preview.result";
  requestId: string;
  artifactId: string;
  mediaType: string;
  data: string;
}

export interface ArtifactPreviewErrorMessage {
  type: "artifact.preview.error";
  requestId: string;
  artifactId: string;
  message: string;
}

export interface ToolActivityMessage {
  type: "tool.activity";
  data: {
    id: string;
    tool: string;
    phase: ToolActivityPhase;
    detail?: string;
    timestamp: string;
  };
}

export type EmotionSnapshotTrigger = "post_turn" | "vad_shift";

export type EmotionAcacAxis = "agency" | "connection" | "authenticity" | "curiosity";

export interface EmotionVector {
  valence: number;
  arousal: number;
  dominance: number;
}

export interface EmotionDiscreteScore {
  label: string;
  score: number;
}

export interface EmotionAcacAxisScore {
  axis: EmotionAcacAxis;
  score: number;
}

/**
 * PSFN-owned, already-redacted companion emotion telemetry. The hub validates
 * this shape but must not reshape or derive any of its fields.
 */
export interface EmotionSnapshotMessage {
  type: "emotion.snapshot";
  data: {
    trigger: EmotionSnapshotTrigger;
    vad: EmotionVector;
    mood: EmotionVector;
    discrete: EmotionDiscreteScore[];
    confidence: number;
    acacAxes?: EmotionAcacAxisScore[];
    timestamp: string;
  };
}

export interface ApprovalDecisionMessage {
  type: "approval.decision";
  id: string;
  decision: "approve" | "deny";
}

export interface ArtifactPreviewRequestMessage {
  type: "artifact.preview";
  requestId: string;
  artifactId: string;
}

export type SatelliteInputCapability =
  | "text"
  | "microphone_pcm"
  | "final_transcript"
  | "vision_upload"
  | "wake_event"
  | "device_location";

export type SatelliteOutputCapability =
  | "text"
  | "subtitle"
  | "streamed_audio"
  | "local_file_audio"
  | "animation"
  | "action"
  | "expression"
  | "gaze"
  | "servo"
  | "artifact"
  | "tool_activity"
  | "emotion";

export type SatelliteControlCapability =
  | "interrupt"
  | "mute"
  | "sleep_wake"
  | "presence"
  | "session_attach"
  | "touch"
  | "approvals"
  /**
   * Authority to move the Hub's world-avatar emanation between worlds. Granted
   * per device in the server-owned registry: a satellite that merely asks for
   * it in its hello does not receive it.
   */
  | "world_travel"
  /**
   * Authority to move the world avatar's body inside its current world. Granted
   * per device in the server-owned registry, separately from `world_travel`:
   * walking across a room and moving to another world are different powers.
   */
  | "world_body";

export type SatelliteSafetyCapability =
  | "action_allowlist"
  | "confirmation_required"
  | "local_only";

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

export interface RuntimeIdentity {
  companion?: RuntimeParticipantIdentity;
  user?: RuntimeUserIdentity;
  source: "framework" | "configured";
}

export function encodeAudioChunk(chunk: Buffer): string {
  return chunk.toString("base64");
}

export function decodeAudioChunk(encoded: string): Buffer {
  return Buffer.from(encoded, "base64");
}

// ── Hub control port: the companion's own world-avatar surface ──
//
// Reached by the PSFN gateway with the Hub control credential over
// `POST /internal/v1/world/{perceive,move,act}`. This is the companion moving
// its OWN body; no Hub device assertion is involved (that is the external-
// device `world.body` / `world.travel` path above, which stays device-gated).
// Additive contract mirrored in the framework's
// `src/shared/contracts/world-avatar.ts`.

export interface WorldAvatarPosition {
  x: number;
  z: number;
}

export interface WorldAvatarPerson {
  id: string;
  /** The world's own classification; unknown participants are assumed ai. */
  kind?: "human" | "ai";
  kindSource?: "world" | "assumed";
  positionKnown: boolean;
  x?: number;
  z?: number;
  distanceM?: number;
  bearing?: string;
  doing?: string;
}

export interface WorldAvatarThing {
  id: string;
  label: string;
  positionKnown: boolean;
  x?: number;
  y?: number;
  z?: number;
  distanceM?: number;
  bearing?: string;
  detail?: string;
}

export interface WorldAvatarPerceiveResult {
  world: string;
  placeId?: string;
  region?: string;
  capturedAt: string;
  self: {
    id: string;
    world: string;
    positionKnown: boolean;
    x?: number;
    z?: number;
    groundHeightM?: number;
    facing?: string;
  } | null;
  people: WorldAvatarPerson[];
  things: WorldAvatarThing[];
  recent: string[];
  raw: string;
}

export interface WorldAvatarMoveRequest {
  world?: string;
  region?: string;
  position?: WorldAvatarPosition;
  participant?: string;
  waitMs?: number;
}

/** `no_position`: the region is mapped to a place but carries no coordinates, so nothing walked (psfn-framework-zsoo8). */
export type WorldAvatarWalkStatus = "arrived" | "walking" | "interrupted" | "failed" | "already_there" | "no_position";

export type WorldAvatarMoveRejectionReason =
  | "not_configured"
  | "unavailable"
  | "invalid_world"
  | "unmapped_world"
  | "refused"
  | "participant_unknown"
  | "participant_position_unknown"
  | "position_unknown";

export type WorldAvatarMoveResult =
  | {
    accepted: true;
    world: string;
    placeId?: string;
    walk?: { status: WorldAvatarWalkStatus; x?: number; z?: number; target?: WorldAvatarPosition };
  }
  | { accepted: false; world: string; reason: WorldAvatarMoveRejectionReason };

export interface WorldAvatarActRequest {
  verb: string;
  arguments?: Record<string, unknown>;
}

export type WorldAvatarActResult =
  | { accepted: true; verb: string; outcome: string; reply: string | null }
  | { accepted: false; verb: string; reason: "not_configured" | "not_allowlisted" | "unavailable" };
