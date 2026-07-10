/**
 * Companion Cockpit <-> PSFN-Satellite-Hub wire protocol.
 *
 * PROVENANCE: This file is a faithful client-side mirror of the hub's
 * authoritative wire types at:
 *   PSFN-Satellite-Hub/src/ts/shared/protocol.ts
 *
 * The hub is the source of truth. The cockpit is a client of the hub and
 * speaks THESE message types — it does not invent shapes (charter §6.10:
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
  | ArtifactPreviewRequestMessage;

export interface HelloMessage {
  type: 'hello';
  deviceId: string;
  deviceName: string;
  sessionId?: string;
  channelId?: string;
  satelliteId?: string;
  satelliteName?: string;
  capabilities?: SatelliteCapabilities;
}

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
  | ToolActivityMessage;

export interface SessionReadyMessage {
  type: 'session.ready';
  sessionId: string;
  channelId: string;
  deviceId: string;
  deviceName: string;
  satelliteId: string;
  audioFormat: string;
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

export interface ApprovalRequestedMessage {
  type: 'approval.requested';
  data: {
    id: string;
    title: string;
    requestedAt: string;
    expiresAt?: string;
    redactedContext: string;
    status: 'pending';
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
// Shared satellite capability + identity model (mirrors hub protocol.ts)
// ─────────────────────────────────────────────────────────────────────────────

export type SatelliteInputCapability =
  | 'text'
  | 'microphone_pcm'
  | 'final_transcript'
  | 'vision_upload'
  | 'wake_event';

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
  | 'approvals';

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

export interface RuntimeIdentity {
  companion?: RuntimeParticipantIdentity;
  user?: RuntimeUserIdentity;
  source: 'framework' | 'configured';
}
