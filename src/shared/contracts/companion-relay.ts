import type { SatelliteTelemetryScope } from './satellite-registry.js';

/**
 * Companion event relay contract (psfn-framework-w9hj.1).
 *
 * PSFN pushes REDACTED operational events to the Satellite Hub over an
 * authenticated SSE stream, and accepts approval decisions back. The hub is
 * always the HTTP client (same direction as `/v1/chat/completions` and the
 * satellite config pull).
 *
 * HTTP surface (served by the gateway-hosted API edge):
 * - `GET  /v1/companion/events`                 — authenticated SSE stream
 * - `POST /v1/companion/approvals/{id}`         — approval decision
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
] as const;

export type CompanionEventKind = typeof COMPANION_EVENT_KINDS[number];

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
] as const;

export type CompanionToolActivityPhase = typeof COMPANION_TOOL_ACTIVITY_PHASES[number];

export interface CompanionApprovalRequestedPayload {
  id: string;
  title: string;
  requestedAt: string;
  expiresAt?: string;
  redactedContext: string;
  status: 'pending';
}

export interface CompanionApprovalResolvedPayload {
  id: string;
  status: CompanionApprovalResolutionStatus;
  resolvedAt: string;
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
  detail?: string;
  timestamp: string;
}

export type CompanionEventPayload =
  | CompanionApprovalRequestedPayload
  | CompanionApprovalResolvedPayload
  | CompanionArtifactCreatedPayload
  | CompanionToolActivityPayload;

export interface CompanionEventEnvelope {
  kind: CompanionEventKind;
  payload: CompanionEventPayload;
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
