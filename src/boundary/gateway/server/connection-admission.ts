// Gateway connection admission and identity (moved verbatim from server.ts;
// psfn-framework-fptm remains the owner of any authorization state-machine
// refactor of this code). Covers per-frame role/identity enforcement,
// gateway.client.identify role proof and companion binding, runtime-ready and
// posture declarations, and fail-closed disconnect on malformed frames.
import { isRecord } from '../../../shared/utils/types.js';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { createCompanionId, type CompanionId } from '../../../shared/routing/companion-id.js';
import { GatewayErrors } from '../protocol.js';
import { verifyCompanionAuthToken } from '../companion-auth.js';
import type { GatewayRpcConnection } from '../transport.js';
import type { GatewayServerCollaboratorPorts } from './collaborator-ports.js';
import {
  isIdentifiableGatewayConnectionRole,
  type GatewayConnectionRole,
  type MalformedFrameKind,
} from './connection-status.js';
import type { GatewayServerPorts } from './ports.js';
import { hasOwn } from './rpc-frame-validation.js';

const log = createComponentLogger('Gateway');
const INVALID_FRAME_AUDIT_METHOD = 'gateway.ipc.frame.invalid';

const INTERNAL_SESSION_INTEGRITY_METHODS = new Set([
  'session.hmac.sign',
  'session.hmac.verify',
]);

export class GatewayConnectionAdmission {
  constructor(
    private readonly ports: Pick<
      GatewayServerPorts,
      | 'connections'
      | 'connectionStatuses'
      | 'companionConnections'
      | 'companionLastSeen'
      | 'companionPostures'
      | 'fatigueFencedCompanionIds'
      | 'multiCompanion'
      | 'fleetCompanionIds'
      | 'sessionHmacKeyring'
      | 'removeConnection'
      | 'companionDisplayLabel'
      | 'alarmCompanionViolation'
    > & Pick<
      GatewayServerCollaboratorPorts,
      'auditTrail' | 'connectionLifecycle' | 'icpInvalidations'
    >,
  ) {}

  /**
   * Fail-closed connection authorization applied to every inbound method:
   * - unidentified connections may call only gateway.client.identify;
   * - internal session-integrity connections may call only HMAC sign/verify;
   * - normal agents may not call those internal signing methods;
   * - multi-companion frames remain pinned to the authenticated companion id.
   * - a frame claiming a companionId different from the connection's identified
   *   companionId is treated as identity spoofing → audit + disconnect;
   * - agent-role connections must identify with a companionId before any other
   *   RPC → requests are rejected with COMPANION_IDENTIFY_REQUIRED.
   * Responses to gateway-originated requests pass through untouched.
   */
  enforceCompanionFrameIdentity(
    conn: GatewayRpcConnection,
    frame: Record<string, unknown>,
  ): 'pass' | 'rejected' | 'disconnected' {
    if (!hasOwn(frame, 'method')) {
      return 'pass';
    }
    const method = typeof frame.method === 'string' ? frame.method : '';
    if (method === 'gateway.client.identify') {
      return 'pass';
    }
    const status = this.ports.connectionStatuses.get(conn);
    if (!status) {
      return 'rejected';
    }
    const boundCompanionId = status.companionId;
    const params = isRecord(frame.params) ? frame.params : undefined;
    const hasClaimedCompanionId = params !== undefined && Object.hasOwn(params, 'companionId');
    const claimedRaw = params?.companionId;

    if (status.role === 'unidentified') {
      this.ports.alarmCompanionViolation(
        'identify_required',
        `RPC "${method}" rejected: connection has not authenticated a role`,
        { method },
      );
      if (hasOwn(frame, 'id')) {
        conn.send({
          jsonrpc: '2.0' as const,
          id: frame.id as string | number | null,
          error: {
            code: GatewayErrors.COMPANION_IDENTIFY_REQUIRED,
            message: 'gateway.client.identify is required before other RPC methods',
          },
        });
      }
      return 'rejected';
    }

    const isInternalMethod = INTERNAL_SESSION_INTEGRITY_METHODS.has(method);
    if (
      (status.role === 'internal_session_integrity' && !isInternalMethod)
      || (status.role === 'agent' && isInternalMethod)
    ) {
      this.ports.alarmCompanionViolation(
        'connection_role_denied',
        `RPC "${method}" is not permitted for gateway role "${status.role}"`,
        { method, role: status.role, ...(boundCompanionId ? { companionId: boundCompanionId } : {}) },
      );
      if (hasOwn(frame, 'id')) {
        conn.send({
          jsonrpc: '2.0' as const,
          id: frame.id as string | number | null,
          error: {
            code: GatewayErrors.CONNECTION_ROLE_DENIED,
            message: `Gateway role "${status.role}" is not authorized for ${method}`,
          },
        });
      }
      return 'rejected';
    }

    let claimedCompanionId: CompanionId | undefined;
    if (hasClaimedCompanionId) {
      try {
        claimedCompanionId = createCompanionId(claimedRaw, 'RPC frame companionId');
      } catch (error) {
        this.ports.alarmCompanionViolation(
          'identity_claim_invalid',
          'RPC frame carried an invalid companionId claim; disconnecting connection',
          { method, boundCompanionId, reason: toErrorMessage(error) },
        );
        this.ports.connectionLifecycle.transitionConnectionState(conn, 'degraded', 'companion_identity_claim_invalid');
        this.ports.connectionLifecycle.transitionConnectionState(conn, 'offline', 'companion_identity_claim_invalid');
        this.ports.removeConnection(conn);
        if (!conn.destroyed) {
          conn.destroy();
        }
        return 'disconnected';
      }
    }

    // Single-companion mode retains its existing socket-trust contract for
    // normal agent methods, but a frame that explicitly carries a malformed
    // identity claim is still invalid and never reaches method dispatch.
    if (!this.ports.multiCompanion.enabled && status.role === 'agent') {
      return 'pass';
    }

    if (claimedCompanionId && boundCompanionId && claimedCompanionId !== boundCompanionId) {
      this.ports.alarmCompanionViolation(
        'identity_mismatch',
        'Companion identity mismatch on RPC frame; disconnecting connection',
        { method, boundCompanionId, claimedCompanionId },
      );
      this.ports.connectionLifecycle.transitionConnectionState(conn, 'degraded', 'companion_identity_mismatch');
      this.ports.connectionLifecycle.transitionConnectionState(conn, 'offline', 'companion_identity_mismatch');
      this.ports.removeConnection(conn);
      if (!conn.destroyed) {
        conn.destroy();
      }
      return 'disconnected';
    }

    if (this.ports.multiCompanion.enabled && !boundCompanionId) {
      this.ports.alarmCompanionViolation(
        'identify_required',
        `RPC "${method}" rejected: agent connection has not identified a companionId`,
        { method },
      );
      if (hasOwn(frame, 'id')) {
        conn.send({
          jsonrpc: '2.0' as const,
          id: frame.id as string | number | null,
          error: {
            code: GatewayErrors.COMPANION_IDENTIFY_REQUIRED,
            message: 'Multi-companion mode requires an authenticated companionId before other RPC methods',
          },
        });
      }
      return 'rejected';
    }

    return 'pass';
  }

  handleMalformedFrame(
    conn: GatewayRpcConnection,
    frameKind: MalformedFrameKind,
    reason: string,
    preview?: string,
  ): void {
    if (!this.ports.connectionStatuses.has(conn)) {
      return;
    }

    const startedAt = Date.now();
    const params: Record<string, unknown> = {
      frameKind,
      reason,
      ...(preview ? { preview } : {}),
    };
    void (async (): Promise<void> => {
      const auditId = await this.ports.auditTrail.audit(INVALID_FRAME_AUDIT_METHOD, 'DENY', params);
      await this.ports.auditTrail.auditComplete(auditId, startedAt, reason);
    })().catch((auditError: unknown) => {
      log.error('Malformed IPC frame audit persistence failed after disconnecting peer fail closed', {
        ...params,
        error: toErrorMessage(auditError),
      });
    });

    log.error('Malformed IPC frame received; disconnecting agent connection', params);
    this.ports.connectionLifecycle.transitionConnectionState(conn, 'degraded', 'malformed_frame', reason);
    this.ports.connectionLifecycle.transitionConnectionState(conn, 'offline', 'malformed_frame', reason);
    this.ports.removeConnection(conn);
    if (!conn.destroyed) {
      conn.destroy();
    }
  }

  async recordConnectionPosture(
    conn: GatewayRpcConnection,
    params: unknown,
  ): Promise<{ success: true }> {
    const status = this.ports.connectionStatuses.get(conn);
    if (status?.role !== 'agent' || !status.companionId) {
      throw new Error('gateway.client.health requires an authenticated companion agent');
    }
    if (!isRecord(params)
      || !Object.hasOwn(params, 'posture')
      || Object.keys(params).length !== 1) {
      throw new Error('gateway.client.health accepts only the bounded posture envelope');
    }
    const posture = this.ports.companionPostures.record(
      conn,
      status.companionId,
      params.posture,
    );
    if (posture.fatigue.state === 'exhausted'
      && !this.ports.fatigueFencedCompanionIds.has(status.companionId)) {
      await this.ports.icpInvalidations.queueIcpInvalidation(status.companionId, 'fatigue_exhausted');
      this.ports.fatigueFencedCompanionIds.add(status.companionId);
    } else if (posture.fatigue.state !== 'exhausted') {
      this.ports.fatigueFencedCompanionIds.delete(status.companionId);
    }
    return { success: true };
  }

  markConnectionReady(
    conn: GatewayRpcConnection,
    params: unknown,
  ): { success: true } {
    if (!isRecord(params) || Object.keys(params).length !== 0) {
      throw new Error('gateway.client.ready accepts only an empty object');
    }
    const status = this.ports.connectionStatuses.get(conn);
    if (status?.role !== 'agent') {
      throw new Error('gateway.client.ready requires an authenticated companion agent');
    }
    if (this.ports.multiCompanion.enabled && !status.companionId) {
      throw new Error('gateway.client.ready requires an identified companion agent');
    }
    status.runtimeReadyDeclared = true;
    this.ports.connectionLifecycle.transitionConnectionState(conn, 'ready', 'agent_runtime_ready');
    return { success: true };
  }

  async identifyConnection(
    conn: GatewayRpcConnection,
    params: unknown,
  ): Promise<{ success: true; role: GatewayConnectionRole; companionId?: CompanionId }> {
    if (!isRecord(params) || !isIdentifiableGatewayConnectionRole(params.role)) {
      throw new Error('gateway.client.identify requires a valid role');
    }

    const status = this.ports.connectionStatuses.get(conn);
    if (!status || status.state === 'offline') {
      throw new Error('Cannot identify an inactive gateway connection');
    }

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

    const maySelectSingleCompanionRole = !this.ports.multiCompanion.enabled
      && status.role === 'agent'
      && status.stateReason === 'rpc_registered';
    if (status.role !== 'unidentified' && !maySelectSingleCompanionRole) {
      if (status.role !== params.role || status.companionId !== companionId) {
        throw new Error('Gateway connection is already identified and cannot change role or companion identity');
      }
      return {
        success: true,
        role: status.role,
        ...(status.companionId ? { companionId: status.companionId } : {}),
      };
    }

    const requiresRoleProof = this.ports.multiCompanion.enabled
      || params.role === 'internal_session_integrity';
    if (requiresRoleProof) {
      if (!companionId) {
        const missingCompanionMessage = this.ports.multiCompanion.enabled
          ? 'Multi-companion mode requires a companionId in gateway.client.identify'
          : 'The internal session-integrity role requires a companionId in gateway.client.identify';
        this.ports.alarmCompanionViolation(
          'identify_missing_companion',
          'Authenticated gateway role identified without a companionId; rejecting',
          {},
        );
        throw new Error(missingCompanionMessage);
      }
      if (this.ports.multiCompanion.enabled && !this.ports.fleetCompanionIds.has(companionId)) {
        this.ports.alarmCompanionViolation(
          'identify_unknown_companion',
          'Connection claimed a companionId absent from companions.json; rejecting',
          { claimedCompanionId: companionId },
        );
        throw new JSONRPCErrorException(
          `Companion ${JSON.stringify(companionId)} is not a member of the active fleet`,
          GatewayErrors.COMPANION_AUTH_FAILED,
        );
      }
      if (!verifyCompanionAuthToken(companionId, params.role, authToken, this.ports.sessionHmacKeyring)) {
        this.ports.alarmCompanionViolation(
          'identify_auth_failed',
          'Connection presented invalid companion authentication; rejecting',
          { claimedCompanionId: companionId },
        );
        throw new JSONRPCErrorException(
          'Companion authentication failed',
          GatewayErrors.COMPANION_AUTH_FAILED,
        );
      }
    }

    if (this.ports.multiCompanion.enabled) {
      if (!companionId) {
        throw new Error('Multi-companion identification invariant violated: companionId is missing');
      }
      const authenticatedCompanionId = companionId;
      if (status.companionId && status.companionId !== companionId) {
        this.ports.alarmCompanionViolation(
          'identify_rebind_rejected',
          'Connection attempted to re-identify as a different companion; rejecting',
          { boundCompanionId: status.companionId, claimedCompanionId: companionId },
        );
        throw new Error(
          `Connection is already identified as companion "${status.companionId}" and cannot rebind to "${companionId}"`,
        );
      }
      if (params.role === 'agent') {
        await this.ports.icpInvalidations.awaitIcpInvalidationBeforeReconnect(authenticatedCompanionId);
        const existing = this.ports.companionConnections.get(authenticatedCompanionId);
        if (existing && existing !== conn) {
          if (this.ports.connections.has(existing)) {
            this.ports.alarmCompanionViolation(
              'duplicate_identify',
              `Duplicate identify for companion "${companionId}"; keeping the existing connection and rejecting the new one`,
              { companionId },
            );
            throw new Error(
              `Companion "${companionId}" already has an active gateway connection; duplicate identify rejected`,
            );
          }
          this.ports.companionConnections.delete(authenticatedCompanionId);
        }
        this.ports.companionConnections.set(authenticatedCompanionId, conn);
        this.ports.companionPostures.bind(conn, authenticatedCompanionId);
      }
      status.companionId = authenticatedCompanionId;
      this.ports.companionLastSeen.set(authenticatedCompanionId, Date.now());
      log.info(`${this.ports.companionDisplayLabel(authenticatedCompanionId)} connection authenticated`, {
        companionId: authenticatedCompanionId,
        role: params.role,
      });
    } else if (companionId) {
      // Flag off (or non-agent role): record for observability only — routing
      // semantics stay byte-identical to single-companion behavior.
      status.companionId = companionId;
      this.ports.companionLastSeen.set(companionId, Date.now());
      if (params.role === 'agent') {
        this.ports.companionPostures.bind(conn, companionId);
      }
    }

    status.role = params.role;
    if (params.role === 'agent' && this.ports.multiCompanion.enabled) {
      this.ports.connectionLifecycle.transitionConnectionState(conn, 'registering', 'client_identified:agent');
    } else {
      this.ports.connectionLifecycle.transitionConnectionState(conn, 'ready', `client_identified:${params.role}`);
    }
    return {
      success: true,
      role: params.role,
      ...(companionId ? { companionId } : {}),
    };
  }
}
