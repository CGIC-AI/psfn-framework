import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiAuthPrincipal } from '../../backplane/http/auth.js';
import type {
  SatelliteClientCertIdentity,
  SatelliteRegistryConfig,
} from '../../../shared/contracts/satellite-registry.js';
import type {
  CompanionApprovalDecisionRequest,
  CompanionApprovalRequestedPayload,
  CompanionEventEnvelope,
} from '../../../shared/contracts/companion-relay.js';
import {
  companionEventKindsForScopes,
} from '../../../shared/contracts/companion-relay.js';
import { projectApprovalRequestedPayload } from '../../backplane/companion-relay/redaction.js';
import {
  resolveCompanionApprovalActor,
  resolveCompanionRelayAccess,
} from '../../backplane/satellite-registry.js';
import type { CompanionEventRelay } from '../../backplane/companion-relay/relay.js';
import type {
  ConfirmationQueueHistoryEntry,
  ConfirmationResolveResult,
} from '../../../system/capabilities/confirmation-queue.js';
import { readJsonBodyWithLimit, sendJson } from '../../backplane/http/primitives.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { isRecord } from '../../../shared/utils/types.js';
import { sendApiError } from './http.js';
import type { CompanionStimulusPort } from './companion-stimuli.js';

const log = createComponentLogger('CompanionRelayRoutes');

const APPROVAL_DECISION_MAX_BODY_BYTES = 16 * 1024;
const SSE_HEARTBEAT_INTERVAL_MS = 25_000;
/**
 * Control-capability token a client advertises (via the `caps` query param on
 * the events stream) to opt into the additive v2 approval-request fields
 * (psfn-framework-13sk). Deny by default: without it, only the v1 payload subset
 * is emitted, so deployed old clients (whose strict parser rejects unknown keys)
 * keep working. The Satellite Hub forwards its client's advertisement here — see
 * docs/approval-envelope.md.
 */
const APPROVALS_V2_CAPABILITY = 'approvals.v2';
const APPROVAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;

export interface CompanionApprovalDecisionPort {
  resolve(params: { id: string; decision: 'approve' | 'deny' }): Promise<ConfirmationResolveResult>;
  findHistory(id: string): ConfirmationQueueHistoryEntry | null;
}

export interface CompanionRelayAuditEntry {
  method: string;
  decision: 'ALLOW' | 'DENY';
  params?: Record<string, unknown>;
}

export interface CompanionRelayHttpDeps {
  relay: CompanionEventRelay;
  approvals: CompanionApprovalDecisionPort;
  /** Records an audit summary; failures must reject (fail closed). */
  audit: (entry: CompanionRelayAuditEntry) => Promise<void>;
  stimuli: CompanionStimulusPort;
}

export const COMPANION_EVENTS_PATH = '/v1/companion/events';
const COMPANION_APPROVALS_PREFIX = '/v1/companion/approvals/';
export const COMPANION_STIMULI_PATH = '/v1/companion/stimuli';
const COMPANION_ARTIFACTS_PREFIX = '/v1/companion/artifacts/';
const COMPANION_ARTIFACT_PREVIEW_SUFFIX = '/preview';

export interface CompanionRelayRouteMatch {
  route: 'events' | 'approval_decision' | 'artifact_preview' | 'touch_stimulus';
  id?: string;
}

function safeDecodePathSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    if (!decoded || decoded.includes('/')) return null;
    return decoded;
  } catch {
    return null;
  }
}

/** Matches `GET /v1/companion/*` routes; returns null when not a relay path. */
export function matchCompanionRelayRoute(
  method: string | undefined,
  path: string,
): CompanionRelayRouteMatch | null {
  if (method === 'GET' && path === COMPANION_EVENTS_PATH) {
    return { route: 'events' };
  }
  if (method === 'POST' && path.startsWith(COMPANION_APPROVALS_PREFIX)) {
    const id = safeDecodePathSegment(path.slice(COMPANION_APPROVALS_PREFIX.length));
    if (id) {
      return { route: 'approval_decision', id };
    }
  }
  if (method === 'POST' && path === COMPANION_STIMULI_PATH) {
    return { route: 'touch_stimulus' };
  }
  if (
    method === 'GET'
    && path.startsWith(COMPANION_ARTIFACTS_PREFIX)
    && path.endsWith(COMPANION_ARTIFACT_PREVIEW_SUFFIX)
  ) {
    const id = safeDecodePathSegment(path.slice(
      COMPANION_ARTIFACTS_PREFIX.length,
      path.length - COMPANION_ARTIFACT_PREVIEW_SUFFIX.length,
    ));
    if (id) {
      return { route: 'artifact_preview', id };
    }
  }
  return null;
}

interface CompanionRelayRequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  principal: ApiAuthPrincipal;
  registry?: SatelliteRegistryConfig;
  clientCert?: SatelliteClientCertIdentity;
  companionId: string;
  deps: CompanionRelayHttpDeps;
}

function relayQueryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value ? value : undefined;
}

/** True when the subscriber advertised the `approvals.v2` capability token. */
function advertisesApprovalsV2(url: URL): boolean {
  return url.searchParams
    .getAll('caps')
    .flatMap((value) => value.split(','))
    .some((token) => token.trim() === APPROVALS_V2_CAPABILITY);
}

/**
 * Project one outbound envelope for this subscriber's capabilities. Only
 * `approval.requested` carries capability-gated v2 fields; everything else
 * passes through unchanged.
 */
function projectEnvelopeForSubscriber(
  envelope: CompanionEventEnvelope,
  includeApprovalsV2: boolean,
): CompanionEventEnvelope {
  if (envelope.kind !== 'approval.requested') return envelope;
  return {
    ...envelope,
    payload: projectApprovalRequestedPayload(
      envelope.payload as CompanionApprovalRequestedPayload,
      { includeV2: includeApprovalsV2 },
    ),
  };
}

/** `GET /v1/companion/events` — scope-gated SSE stream of redacted events. */
export function handleCompanionEventsStream(ctx: CompanionRelayRequestContext): void {
  const access = resolveCompanionRelayAccess({
    principal: ctx.principal,
    registry: ctx.registry,
    ...(ctx.clientCert ? { clientCert: ctx.clientCert } : {}),
    satelliteId: relayQueryParam(ctx.url, 'satelliteId'),
    endpointId: relayQueryParam(ctx.url, 'endpointId'),
    claimType: relayQueryParam(ctx.url, 'claimType'),
  });
  if (!access.ok) {
    sendApiError(ctx.res, access.status, access.type, access.message);
    return;
  }

  const allowedKinds = companionEventKindsForScopes(access.value.telemetryScopes);
  if (allowedKinds.length === 0) {
    sendApiError(
      ctx.res,
      403,
      'companion_events_not_allowed',
      'Satellite endpoint has no companion event scopes (approvals, artifacts, tool_activity)',
    );
    return;
  }

  const includeApprovalsV2 = advertisesApprovalsV2(ctx.url);

  let unsubscribe: (() => void) | null = null;
  try {
    unsubscribe = ctx.deps.relay.subscribe({
      allowedKinds,
      onEvent: (envelope: CompanionEventEnvelope) => {
        const projected = projectEnvelopeForSubscriber(envelope, includeApprovalsV2);
        ctx.res.write(`event: companion\ndata: ${JSON.stringify(projected)}\n\n`);
      },
    });
  } catch (error) {
    sendApiError(ctx.res, 503, 'companion_events_unavailable', toErrorMessage(error));
    return;
  }

  ctx.res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  ctx.res.write(`: connected kinds=${allowedKinds.join(',')}\n\n`);

  const heartbeat = setInterval(() => {
    ctx.res.write(': keep-alive\n\n');
  }, SSE_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  ctx.res.on('close', cleanup);
  ctx.res.on('error', cleanup);

  log.info('Companion event stream opened', {
    satelliteId: access.value.satellite.satelliteId,
    endpointId: access.value.endpoint.endpointId,
    kinds: allowedKinds,
  });
}

function parseApprovalDecisionBody(body: unknown): CompanionApprovalDecisionRequest {
  if (!isRecord(body)) {
    throw new Error('Request body must be a JSON object');
  }
  const decision = body.decision;
  if (decision !== 'approve' && decision !== 'deny') {
    throw new Error('decision must be "approve" or "deny"');
  }
  const satelliteId = typeof body.satelliteId === 'string' ? body.satelliteId.trim() : '';
  if (!satelliteId) {
    throw new Error('satelliteId must be a non-empty string');
  }
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new Error('deviceId must be 1-128 characters of letters, numbers, dot, underscore, dash, colon, or @');
  }
  return { decision, satelliteId, deviceId };
}

/**
 * `POST /v1/companion/approvals/{id}` — resolves through the existing
 * confirmation queue (no bypass of the capability-tier/approval path).
 * Every accepted decision is audit-logged with satellite/device attribution
 * BEFORE resolution; an audit write failure fails the request closed.
 */
export async function handleCompanionApprovalDecision(
  ctx: CompanionRelayRequestContext,
  approvalId: string,
): Promise<void> {
  if (!APPROVAL_ID_PATTERN.test(approvalId)) {
    sendApiError(ctx.res, 404, 'approval_not_found', 'Unknown approval id');
    return;
  }

  const bodyResult = await readJsonBodyWithLimit(ctx.req, ctx.res, {
    maxBytes: APPROVAL_DECISION_MAX_BODY_BYTES,
    logger: log,
    logMeta: { route: 'companion.approval.decision' },
  });
  if (!bodyResult.ok) {
    if (bodyResult.errorCode === 'payload_too_large') return; // 413 already sent
    sendApiError(ctx.res, 400, 'invalid_request', 'Request body must be valid JSON');
    return;
  }

  let decisionRequest: CompanionApprovalDecisionRequest;
  try {
    decisionRequest = parseApprovalDecisionBody(bodyResult.value);
  } catch (error) {
    sendApiError(ctx.res, 400, 'invalid_request', toErrorMessage(error));
    return;
  }

  const actor = resolveCompanionApprovalActor({
    principal: ctx.principal,
    registry: ctx.registry,
    ...(ctx.clientCert ? { clientCert: ctx.clientCert } : {}),
    satelliteId: decisionRequest.satelliteId,
  });
  if (!actor.ok) {
    try {
      await ctx.deps.audit({
        method: 'companion.approval.decision',
        decision: 'DENY',
        params: {
          approvalId,
          decision: decisionRequest.decision,
          satelliteId: decisionRequest.satelliteId,
          deviceId: decisionRequest.deviceId,
          reason: actor.type,
        },
      });
    } catch (error) {
      log.error('Failed to audit denied companion approval decision', {
        approvalId,
        error: toErrorMessage(error),
      });
    }
    sendApiError(ctx.res, actor.status, actor.type, actor.message);
    return;
  }

  // Fail closed: the decision executes only after the actor attribution is
  // durably audited.
  try {
    await ctx.deps.audit({
      method: 'companion.approval.decision',
      decision: 'ALLOW',
      params: {
        approvalId,
        decision: decisionRequest.decision,
        satelliteId: actor.value.satellite.satelliteId,
        endpointId: actor.value.endpoint.endpointId,
        deviceId: decisionRequest.deviceId,
      },
    });
  } catch (error) {
    log.error('Refusing companion approval decision: audit write failed', {
      approvalId,
      error: toErrorMessage(error),
    });
    sendApiError(ctx.res, 503, 'audit_unavailable', 'Approval decision could not be audited');
    return;
  }

  const result = await ctx.deps.approvals.resolve({
    id: approvalId,
    decision: decisionRequest.decision,
  });

  switch (result.status) {
    case 'approved':
    case 'modified':
    case 'denied':
    case 'failed':
      sendJson(ctx.res, 200, { id: result.id, status: result.status });
      return;
    case 'expired':
      sendApiError(ctx.res, 409, 'approval_expired', 'Approval request expired before resolution', {
        id: result.id,
        status: result.status,
      });
      return;
    case 'not_found': {
      const history = ctx.deps.approvals.findHistory(approvalId);
      if (history) {
        sendApiError(ctx.res, 409, 'approval_already_resolved', 'Approval request was already resolved', {
          id: approvalId,
          status: history.status,
        });
        return;
      }
      sendApiError(ctx.res, 404, 'approval_not_found', 'Unknown approval id');
      return;
    }
    default: {
      const exhausted: never = result.status;
      sendApiError(ctx.res, 500, 'internal_error', `Unexpected approval status ${String(exhausted)}`);
    }
  }
}

/**
 * `GET /v1/companion/artifacts/{id}/preview` — read-only, deny-by-default,
 * size-capped preview of an artifact previously announced on the stream.
 */
export async function handleCompanionArtifactPreview(
  ctx: CompanionRelayRequestContext,
  artifactId: string,
): Promise<void> {
  const access = resolveCompanionRelayAccess({
    principal: ctx.principal,
    registry: ctx.registry,
    ...(ctx.clientCert ? { clientCert: ctx.clientCert } : {}),
    satelliteId: relayQueryParam(ctx.url, 'satelliteId'),
    endpointId: relayQueryParam(ctx.url, 'endpointId'),
    claimType: relayQueryParam(ctx.url, 'claimType'),
  });
  if (!access.ok) {
    sendApiError(ctx.res, access.status, access.type, access.message);
    return;
  }
  if (!access.value.telemetryScopes.includes('artifacts')) {
    sendApiError(ctx.res, 403, 'companion_artifacts_not_allowed', 'Satellite endpoint lacks the artifacts scope');
    return;
  }
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
    sendApiError(ctx.res, 404, 'artifact_not_found', 'Unknown artifact id');
    return;
  }

  const source = ctx.deps.relay.getPreviewSource(artifactId);
  if (!source) {
    sendApiError(ctx.res, 404, 'artifact_not_found', 'Unknown artifact id');
    return;
  }
  if (!source.previewable) {
    sendApiError(ctx.res, 403, 'artifact_preview_denied', 'Artifact is not previewable');
    return;
  }

  if (!source.bytes || source.sizeBytes > ctx.deps.relay.maxPreviewSizeBytes()) {
    sendApiError(ctx.res, 403, 'artifact_preview_denied', 'Artifact exceeds the preview size cap');
    return;
  }

  ctx.res.writeHead(200, {
    'Content-Type': source.mediaType,
    'Content-Length': String(source.bytes.length),
    'Cache-Control': 'no-store',
    'Content-Disposition': 'inline',
  });
  ctx.res.end(source.bytes);
}

export type { CompanionRelayRequestContext };
