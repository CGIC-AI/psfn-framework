// Gateway connection admission and identity. Authorization DECISIONS (per-frame
// role/identity rules, identify parsing, re-entry, and role proof) live in
// ./connection-authorization.ts as pure typed functions (psfn-framework-fptm);
// this class applies their effects (alarms, error frames, state transitions,
// disconnects, companion connection/posture bindings) and owns runtime-ready
// and posture declarations and fail-closed disconnect on malformed frames.
import { isRecord } from '../../../shared/utils/types.js';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { CompanionId } from '../../../shared/routing/companion-id.js';
import { verifyCompanionAuthToken } from '../companion-auth.js';
import type { GatewayRpcConnection } from '../transport.js';
import type { GatewayServerCollaboratorPorts } from './collaborator-ports.js';
import type {
  GatewayConnectionRole,
  GatewayConnectionStatus,
  MalformedFrameKind,
} from './connection-status.js';
import {
  decideFrameAuthorization,
  decideIdentifyReentry,
  decideIdentifyRoleProof,
  parseIdentifyRequest,
  type IdentifyReentryDecision,
  type IdentifyRequest,
} from './connection-authorization.js';
import type { GatewayServerPorts } from './ports.js';
import { hasOwn } from './rpc-frame-validation.js';

const log = createComponentLogger('Gateway');
const INVALID_FRAME_AUDIT_METHOD = 'gateway.ipc.frame.invalid';

export class GatewayConnectionAdmission {
  private readonly pendingIdentifies = new WeakMap<GatewayRpcConnection, PendingIdentify>();

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
    const decision = decideFrameAuthorization({
      frame,
      status: this.ports.connectionStatuses.get(conn),
      multiCompanionEnabled: this.ports.multiCompanion.enabled,
    });
    switch (decision.kind) {
      case 'pass':
        return 'pass';
      case 'reject_untracked':
        return 'rejected';
      case 'reject':
        this.ports.alarmCompanionViolation(
          decision.violation.event,
          decision.violation.message,
          decision.violation.details,
        );
        if (hasOwn(frame, 'id')) {
          conn.send({
            jsonrpc: '2.0' as const,
            id: frame.id as string | number | null,
            error: { code: decision.error.code, message: decision.error.message },
          });
        }
        return 'rejected';
      case 'disconnect':
        this.ports.alarmCompanionViolation(
          decision.violation.event,
          decision.violation.message,
          decision.violation.details,
        );
        this.ports.connectionLifecycle.transitionConnectionState(conn, 'degraded', decision.reason);
        this.ports.connectionLifecycle.transitionConnectionState(conn, 'offline', decision.reason);
        this.ports.removeConnection(conn);
        if (!conn.destroyed) {
          conn.destroy();
        }
        return 'disconnected';
    }
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

  /**
   * Identify is single-flight per connection: multi-companion agent identify
   * awaits pending ICP invalidations, so a second identify arriving meanwhile
   * could otherwise pass the same re-entry/rebind checks and overwrite the
   * binding. It is rejected (fail closed) while one is pending.
   */
  async identifyConnection(
    conn: GatewayRpcConnection,
    params: unknown,
  ): Promise<{ success: true; role: GatewayConnectionRole; companionId?: CompanionId }> {
    const pending = this.pendingIdentifies.get(conn);
    if (pending) {
      this.ports.alarmCompanionViolation(
        'identify_concurrent_rejected',
        'Connection sent gateway.client.identify while another identify was pending; rejecting',
        pending.companionId ? { companionId: pending.companionId } : {},
      );
      throw new Error('Gateway connection already has an identify request in flight; concurrent identify rejected');
    }
    const inFlight: PendingIdentify = {};
    this.pendingIdentifies.set(conn, inFlight);
    try {
      return await this.identifyConnectionOnce(conn, params, inFlight);
    } finally {
      this.pendingIdentifies.delete(conn);
    }
  }

  private async identifyConnectionOnce(
    conn: GatewayRpcConnection,
    params: unknown,
    inFlight: PendingIdentify,
  ): Promise<{ success: true; role: GatewayConnectionRole; companionId?: CompanionId }> {
    const status = this.ports.connectionStatuses.get(conn);
    const request = parseIdentifyRequest(params, () => {
      if (!status || status.state === 'offline') {
        throw new Error('Cannot identify an inactive gateway connection');
      }
    });
    if (!status) {
      throw new Error('Cannot identify an inactive gateway connection');
    }
    const companionId = request.companionId;
    if (companionId) {
      inFlight.companionId = companionId;
    }

    const reentry = this.decideReentry(status, request);
    if (reentry.kind === 'already_identified') {
      return {
        success: true,
        role: reentry.role,
        ...(reentry.companionId ? { companionId: reentry.companionId } : {}),
      };
    }

    const proof = decideIdentifyRoleProof({
      request,
      multiCompanionEnabled: this.ports.multiCompanion.enabled,
      isFleetMember: candidate => this.ports.fleetCompanionIds.has(candidate),
      verifyAuthToken: (candidate, role, authToken) => (
        verifyCompanionAuthToken(candidate, role, authToken, this.ports.sessionHmacKeyring)
      ),
    });
    if (proof.kind === 'rejected') {
      this.ports.alarmCompanionViolation(proof.violation.event, proof.violation.message, proof.violation.details);
      throw proof.jsonRpcCode === undefined
        ? new Error(proof.message)
        : new JSONRPCErrorException(proof.message, proof.jsonRpcCode);
    }

    if (this.ports.multiCompanion.enabled) {
      if (!companionId) {
        throw new Error('Multi-companion identification invariant violated: companionId is missing');
      }
      const authenticatedCompanionId = companionId;
      if (request.role === 'agent') {
        await this.ports.icpInvalidations.awaitIcpInvalidationBeforeReconnect(authenticatedCompanionId);
        // Re-verify everything decided before the await (fail closed): the
        // connection may have closed, or its identity changed, meanwhile.
        this.assertStillIdentifiable(conn, status, request);
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
        role: request.role,
      });
    } else if (companionId) {
      // Flag off (or non-agent role): record for observability only — routing
      // semantics stay byte-identical to single-companion behavior.
      status.companionId = companionId;
      this.ports.companionLastSeen.set(companionId, Date.now());
      if (request.role === 'agent') {
        this.ports.companionPostures.bind(conn, companionId);
      }
    }

    status.role = request.role;
    if (request.role === 'agent' && this.ports.multiCompanion.enabled) {
      this.ports.connectionLifecycle.transitionConnectionState(conn, 'registering', 'client_identified:agent');
    } else {
      this.ports.connectionLifecycle.transitionConnectionState(conn, 'ready', `client_identified:${request.role}`);
    }
    return {
      success: true,
      role: request.role,
      ...(companionId ? { companionId } : {}),
    };
  }

  private decideReentry(
    status: GatewayConnectionStatus,
    request: IdentifyRequest,
  ): Exclude<IdentifyReentryDecision, { kind: 'reject' }> {
    const reentry = decideIdentifyReentry({
      status,
      request,
      multiCompanionEnabled: this.ports.multiCompanion.enabled,
    });
    if (reentry.kind === 'reject') {
      this.ports.alarmCompanionViolation(reentry.violation.event, reentry.violation.message, reentry.violation.details);
      throw new Error(reentry.message);
    }
    return reentry;
  }

  private assertStillIdentifiable(
    conn: GatewayRpcConnection,
    status: GatewayConnectionStatus,
    request: IdentifyRequest,
  ): void {
    if (
      this.ports.connectionStatuses.get(conn) !== status
      || status.state === 'offline'
      || !this.ports.connections.has(conn)
    ) {
      throw new Error('Gateway connection closed while identify was pending; identify rejected');
    }
    if (this.decideReentry(status, request).kind !== 'identify') {
      throw new Error('Gateway connection identified while identify was pending; identify rejected');
    }
  }
}

/** Claimed identity of the identify currently pending on a connection. */
interface PendingIdentify {
  companionId?: CompanionId;
}
