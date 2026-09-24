// Gateway connection authorization decisions (psfn-framework-fptm).
//
// Pure, typed decisions extracted verbatim from GatewayConnectionAdmission:
// per-frame role/identity authorization and the gateway.client.identify
// request/re-entry/role-proof rules. Every function here is side-effect free;
// GatewayConnectionAdmission stays the owner of effects (violation alarms,
// JSON-RPC error frames, connection-state transitions, disconnects, and the
// companion connection/posture bindings), applied in the same order as before.
import { isRecord } from '../../../shared/utils/types.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { createCompanionId, type CompanionId } from '../../../shared/routing/companion-id.js';
import { GatewayErrors } from '../protocol.js';
import {
  isIdentifiableGatewayConnectionRole,
  type GatewayConnectionRole,
  type GatewayConnectionStatus,
} from './connection-status.js';
import { hasOwn } from './rpc-frame-validation.js';

const INTERNAL_SESSION_INTEGRITY_METHODS = new Set([
  'session.hmac.sign',
  'session.hmac.verify',
]);

/** A companion-isolation violation to alarm (event, operator message, audit details). */
interface ConnectionAuthorizationViolation {
  readonly event: string;
  readonly message: string;
  readonly details: Record<string, unknown>;
}

export type FrameAuthorizationDecision =
  | Readonly<{ kind: 'pass' }>
  /** No connection status: reject without alarm or reply (connection is gone). */
  | Readonly<{ kind: 'reject_untracked' }>
  /** Alarm, answer a request frame with this JSON-RPC error, and drop the frame. */
  | Readonly<{
    kind: 'reject';
    violation: ConnectionAuthorizationViolation;
    error: Readonly<{ code: number; message: string }>;
  }>
  /** Alarm, transition degraded then offline with this reason, and disconnect. */
  | Readonly<{
    kind: 'disconnect';
    violation: ConnectionAuthorizationViolation;
    reason: 'companion_identity_claim_invalid' | 'companion_identity_mismatch';
  }>;

const PASS: FrameAuthorizationDecision = Object.freeze({ kind: 'pass' });

/**
 * Fail-closed authorization applied to every inbound frame:
 * - responses (no method) and gateway.client.identify pass;
 * - untracked connections are rejected;
 * - unidentified connections may call only gateway.client.identify;
 * - internal session-integrity connections may call only HMAC sign/verify, and
 *   agents may not call those internal signing methods;
 * - a malformed companionId claim disconnects in every topology;
 * - single-companion agents keep the socket-trust contract otherwise;
 * - a claim that differs from the bound companion disconnects (spoofing);
 * - multi-companion frames require an identified companionId.
 */
export function decideFrameAuthorization(input: Readonly<{
  frame: Record<string, unknown>;
  status: Pick<GatewayConnectionStatus, 'role' | 'companionId'> | undefined;
  multiCompanionEnabled: boolean;
}>): FrameAuthorizationDecision {
  const { frame, status } = input;
  if (!hasOwn(frame, 'method')) {
    return PASS;
  }
  const method = typeof frame.method === 'string' ? frame.method : '';
  if (method === 'gateway.client.identify') {
    return PASS;
  }
  if (!status) {
    return { kind: 'reject_untracked' };
  }
  const boundCompanionId = status.companionId;
  const params = isRecord(frame.params) ? frame.params : undefined;
  const hasClaimedCompanionId = params !== undefined && Object.hasOwn(params, 'companionId');
  const claimedRaw = params?.companionId;

  if (status.role === 'unidentified') {
    return {
      kind: 'reject',
      violation: {
        event: 'identify_required',
        message: `RPC "${method}" rejected: connection has not authenticated a role`,
        details: { method },
      },
      error: {
        code: GatewayErrors.COMPANION_IDENTIFY_REQUIRED,
        message: 'gateway.client.identify is required before other RPC methods',
      },
    };
  }

  const isInternalMethod = INTERNAL_SESSION_INTEGRITY_METHODS.has(method);
  if (
    (status.role === 'internal_session_integrity' && !isInternalMethod)
    || (status.role === 'agent' && isInternalMethod)
  ) {
    return {
      kind: 'reject',
      violation: {
        event: 'connection_role_denied',
        message: `RPC "${method}" is not permitted for gateway role "${status.role}"`,
        details: { method, role: status.role, ...(boundCompanionId ? { companionId: boundCompanionId } : {}) },
      },
      error: {
        code: GatewayErrors.CONNECTION_ROLE_DENIED,
        message: `Gateway role "${status.role}" is not authorized for ${method}`,
      },
    };
  }

  let claimedCompanionId: CompanionId | undefined;
  if (hasClaimedCompanionId) {
    try {
      claimedCompanionId = createCompanionId(claimedRaw, 'RPC frame companionId');
    } catch (error) {
      return {
        kind: 'disconnect',
        violation: {
          event: 'identity_claim_invalid',
          message: 'RPC frame carried an invalid companionId claim; disconnecting connection',
          details: { method, boundCompanionId, reason: toErrorMessage(error) },
        },
        reason: 'companion_identity_claim_invalid',
      };
    }
  }

  // Single-companion mode retains its existing socket-trust contract for
  // normal agent methods, but a frame that explicitly carries a malformed
  // identity claim is still invalid and never reaches method dispatch.
  if (!input.multiCompanionEnabled && status.role === 'agent') {
    return PASS;
  }

  if (claimedCompanionId && boundCompanionId && claimedCompanionId !== boundCompanionId) {
    return {
      kind: 'disconnect',
      violation: {
        event: 'identity_mismatch',
        message: 'Companion identity mismatch on RPC frame; disconnecting connection',
        details: { method, boundCompanionId, claimedCompanionId },
      },
      reason: 'companion_identity_mismatch',
    };
  }

  if (input.multiCompanionEnabled && !boundCompanionId) {
    return {
      kind: 'reject',
      violation: {
        event: 'identify_required',
        message: `RPC "${method}" rejected: agent connection has not identified a companionId`,
        details: { method },
      },
      error: {
        code: GatewayErrors.COMPANION_IDENTIFY_REQUIRED,
        message: 'Multi-companion mode requires an authenticated companionId before other RPC methods',
      },
    };
  }

  return PASS;
}

/** A validated gateway.client.identify request. */
export interface IdentifyRequest {
  readonly role: Exclude<GatewayConnectionRole, 'unidentified'>;
  readonly companionId?: CompanionId;
  readonly authToken?: string;
}

/**
 * Parse gateway.client.identify params. Throws the same plain errors the
 * handler always threw; `assertActive` runs between role and companion
 * validation to preserve the original error precedence.
 */
export function parseIdentifyRequest(params: unknown, assertActive: () => void): IdentifyRequest {
  if (!isRecord(params) || !isIdentifiableGatewayConnectionRole(params.role)) {
    throw new Error('gateway.client.identify requires a valid role');
  }
  assertActive();
  if (params.companionId !== undefined
    && (typeof params.companionId !== 'string' || !params.companionId.trim())) {
    throw new Error('gateway.client.identify companionId must be a non-empty string');
  }
  const companionId = typeof params.companionId === 'string'
    ? createCompanionId(params.companionId, 'gateway.client.identify companionId')
    : undefined;
  if (params.authToken !== undefined && typeof params.authToken !== 'string') {
    throw new Error('gateway.client.identify authToken must be a string when provided');
  }
  const authToken = typeof params.authToken === 'string' ? params.authToken : undefined;
  return {
    role: params.role,
    ...(companionId ? { companionId } : {}),
    ...(authToken !== undefined ? { authToken } : {}),
  };
}

export type IdentifyReentryDecision =
  | Readonly<{ kind: 'identify' }>
  | Readonly<{ kind: 'already_identified'; role: GatewayConnectionRole; companionId?: CompanionId }>
  | Readonly<{ kind: 'reject'; message: string }>;

/**
 * An identified connection may repeat its exact identity (idempotent) but never
 * change role or companion. The only exception is a single-companion agent
 * still in its RPC-registered socket-trust state, which may select its role.
 */
export function decideIdentifyReentry(input: Readonly<{
  status: Pick<GatewayConnectionStatus, 'role' | 'companionId' | 'stateReason'>;
  request: IdentifyRequest;
  multiCompanionEnabled: boolean;
}>): IdentifyReentryDecision {
  const { status, request } = input;
  const maySelectSingleCompanionRole = !input.multiCompanionEnabled
    && status.role === 'agent'
    && status.stateReason === 'rpc_registered';
  if (status.role === 'unidentified' || maySelectSingleCompanionRole) {
    return { kind: 'identify' };
  }
  if (status.role !== request.role || status.companionId !== request.companionId) {
    return {
      kind: 'reject',
      message: 'Gateway connection is already identified and cannot change role or companion identity',
    };
  }
  return {
    kind: 'already_identified',
    role: status.role,
    ...(status.companionId ? { companionId: status.companionId } : {}),
  };
}

export type IdentifyRoleProofDecision =
  | Readonly<{ kind: 'accepted' }>
  /** Alarm the violation, then throw; `jsonRpcCode` selects a JSON-RPC error. */
  | Readonly<{
    kind: 'rejected';
    violation: ConnectionAuthorizationViolation;
    message: string;
    jsonRpcCode?: number;
  }>;

/**
 * Role proof for gateway.client.identify: required in multi-companion mode and
 * for the internal session-integrity role. The claimed companion must be named,
 * be a fleet member (multi-companion), and present a valid role-bound token.
 */
export function decideIdentifyRoleProof(input: Readonly<{
  request: IdentifyRequest;
  multiCompanionEnabled: boolean;
  isFleetMember: (companionId: CompanionId) => boolean;
  verifyAuthToken: (companionId: CompanionId, role: IdentifyRequest['role'], authToken: string | undefined) => boolean;
}>): IdentifyRoleProofDecision {
  const { request } = input;
  const requiresRoleProof = input.multiCompanionEnabled
    || request.role === 'internal_session_integrity';
  if (!requiresRoleProof) {
    return { kind: 'accepted' };
  }
  const companionId = request.companionId;
  if (!companionId) {
    return {
      kind: 'rejected',
      violation: {
        event: 'identify_missing_companion',
        message: 'Authenticated gateway role identified without a companionId; rejecting',
        details: {},
      },
      message: input.multiCompanionEnabled
        ? 'Multi-companion mode requires a companionId in gateway.client.identify'
        : 'The internal session-integrity role requires a companionId in gateway.client.identify',
    };
  }
  if (input.multiCompanionEnabled && !input.isFleetMember(companionId)) {
    return {
      kind: 'rejected',
      violation: {
        event: 'identify_unknown_companion',
        message: 'Connection claimed a companionId absent from companions.json; rejecting',
        details: { claimedCompanionId: companionId },
      },
      message: `Companion ${JSON.stringify(companionId)} is not a member of the active fleet`,
      jsonRpcCode: GatewayErrors.COMPANION_AUTH_FAILED,
    };
  }
  if (!input.verifyAuthToken(companionId, request.role, request.authToken)) {
    return {
      kind: 'rejected',
      violation: {
        event: 'identify_auth_failed',
        message: 'Connection presented invalid companion authentication; rejecting',
        details: { claimedCompanionId: companionId },
      },
      message: 'Companion authentication failed',
      jsonRpcCode: GatewayErrors.COMPANION_AUTH_FAILED,
    };
  }
  return { kind: 'accepted' };
}
