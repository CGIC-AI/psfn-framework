// Per-connection JSON-RPC method registration: builds the connection-bound
// GatewayMethodRuntime (identity-scoped workspace, policy, docks, tiers, shard
// lineage) and registers gateway client lifecycle, shard workload, companion
// lane, API stream tap, companion event relay, and shared-workspace methods.
import { isRecord } from '../../../shared/utils/types.js';
import { JSONRPCErrorException, type JSONRPCServerAndClient } from 'json-rpc-2.0';
import { readCanaryCarrier } from '../../../core/cogsec/canary/egress-scan.js';
import type { IntakeScreeningService } from '../../../core/cogsec/intake/screening.js';
import { parseCompanionRelayPublishParams } from '../../../channels/backplane/companion-relay/relay.js';
import type { ApiStreamDeltaNotification } from '../../../channels/api/types.js';
import { createCompanionId, type CompanionId } from '../../../shared/routing/companion-id.js';
import type { AuthenticatedShardWorkloadHandle } from '../../../system/capabilities/shard-approval-grants.js';
import { GatewayErrors, type GatewayCredentialPresenceResult } from '../protocol.js';
import { registerGatewayMethods } from '../methods/index.js';
import type { GatewayMethodRuntime } from '../methods/types.js';
import { registerGatewayIcpAutonomyRpc } from '../icp-autonomy-rpc.js';
import { GatewayInlineImageRetention } from '../inline-image-retention.js';
import { GatewayLLMRequestCancellation } from '../llm-request-cancellation.js';
import { GatewayMcpRequestCancellation } from '../methods/mcp.js';
import { GatewayMcpInvocationAuthority } from '../mcp/invocation-authority.js';
import type { GatewayVisionIntakeScreener } from '../intake/compose-screening.js';
import type { PolicyConfig } from '../policy.js';
import type { GatewayRpcConnection } from '../transport.js';
import type { GatewayServerPorts } from './ports.js';
import type { GatewayServerCollaboratorPorts } from './collaborator-ports.js';

const EMPTY_CREDENTIAL_PRESENCE: GatewayCredentialPresenceResult = {
  discordToken: false,
  apiKey: false,
  adminToken: false,
  openrouterApiKey: false,
  importProcessingLocalApiKey: false,
  falApiKey: false,
  telegramBotToken: false,
};

export class GatewayConnectionRpcMethods {
  private readonly apiStreamListeners = new Map<
    string,
    Set<(text: string, companionId?: string) => void>
  >();
  private readonly apiStreamCompanionTargets = new Map<string, CompanionId>();

  constructor(
    private readonly ports: Pick<
      GatewayServerPorts,
      | 'options'
      | 'multiCompanion'
      | 'connectionStatuses'
      | 'inlineImageRetentionByConnection'
      | 'llmRequestCancellationByConnection'
      | 'mcpRequestCancellationByConnection'
      | 'mcpInvocationAuthorityByConnection'
      | 'sessionHmacKeyring'
      | 'capabilityTierProvider'
      | 'approvalBoundary'
      | 'ntfyNotifier'
      | 'operatorAlertDispatcher'
      | 'icpAutonomyBroker'
      | 'canaryEgressGuard'
      | 'shardApprovalGrants'
      | 'shardWorkloadRegistrar'
      | 'nextStreamRequestCounter'
      | 'getRuntimeHealth'
      | 'identifyConnection'
      | 'markConnectionReady'
      | 'recordConnectionPosture'
      | 'alarmCompanionViolation'
    > & Pick<
      GatewayServerCollaboratorPorts,
      'auditTrail' | 'companionMessageLane' | 'connectionRouter' | 'connectionScope' | 'sharedSatellite'
    >,
  ) {}

  subscribeApiStream(
    requestId: string,
    listener: (text: string, companionId?: string) => void,
    companionId?: string,
  ): () => void {
    if (companionId) {
      const exactCompanionId = createCompanionId(
        companionId,
        'API stream target companionId',
      );
      const existingTarget = this.apiStreamCompanionTargets.get(requestId);
      if (existingTarget && existingTarget !== exactCompanionId) {
        throw new Error(`API stream request ${requestId} is already bound to another companion`);
      }
      this.apiStreamCompanionTargets.set(requestId, exactCompanionId);
    }
    const listeners = this.apiStreamListeners.get(requestId) ?? new Set();
    listeners.add(listener);
    this.apiStreamListeners.set(requestId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.apiStreamListeners.delete(requestId);
        this.apiStreamCompanionTargets.delete(requestId);
      }
    };
  }

  private dispatchApiStreamDelta(
    notification: ApiStreamDeltaNotification,
    companionId?: string,
  ): void {
    const listeners = this.apiStreamListeners.get(notification.requestId);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(notification.text, companionId);
    }
  }

  registerMethods(target: JSONRPCServerAndClient, conn: GatewayRpcConnection): void {
    const inlineImageRetention = new GatewayInlineImageRetention();
    this.ports.inlineImageRetentionByConnection.set(conn, inlineImageRetention);
    const llmRequestCancellation = new GatewayLLMRequestCancellation();
    this.ports.llmRequestCancellationByConnection.set(conn, llmRequestCancellation);
    const mcpRequestCancellation = new GatewayMcpRequestCancellation();
    this.ports.mcpRequestCancellationByConnection.set(conn, mcpRequestCancellation);
    const mcpInvocationAuthority = new GatewayMcpInvocationAuthority();
    this.ports.mcpInvocationAuthorityByConnection.set(conn, mcpInvocationAuthority);
    const resolveWorkspacePath = (): string => this.ports.connectionScope.resolveConnectionWorkspacePath(conn);
    const resolvePolicyConfig = (): PolicyConfig => this.ports.connectionScope.resolveConnectionPolicyConfig(conn);
    const resolveIntakeScreening = (): IntakeScreeningService | undefined =>
      this.ports.options.intakeScreeningProvider
        ? this.ports.options.intakeScreeningProvider(this.ports.connectionRouter.authenticatedCompanionId(conn)) ?? undefined
        : this.ports.options.intakeScreening;
    const resolveVisionIntake = (): GatewayVisionIntakeScreener | undefined =>
      this.ports.options.visionIntakeProvider
        ? this.ports.options.visionIntakeProvider(this.ports.connectionRouter.authenticatedCompanionId(conn)) ?? undefined
        : this.ports.options.visionIntake;
    const runtime: GatewayMethodRuntime = {
      target,
      llmProvider: this.ports.options.llmProvider,
      llmRequestCancellation,
      mcpRequestCancellation,
      mcpInvocationAuthority,
      embeddingService: this.ports.options.embeddingService,
      ...(this.ports.options.modelDiscovery ? { modelDiscovery: this.ports.options.modelDiscovery } : {}),
      discordAdapter: this.ports.connectionScope.resolveConnectionDiscordDock(conn),
      ...(this.ports.options.telegramDock ? { telegramDock: this.ports.options.telegramDock } : {}),
      gitOps: this.ports.options.gitOps,
      imageConfig: this.ports.options.imageConfig,
      ...(this.ports.options.modelUsageRecorder ? { modelUsageRecorder: this.ports.options.modelUsageRecorder } : {}),
      ...(this.ports.options.credentialVault ? { credentialVault: this.ports.options.credentialVault } : {}),
      get intakeScreening() { return resolveIntakeScreening(); },
      ...(this.ports.options.quarantinedArtifactGuard
        ? { quarantinedArtifactGuard: this.ports.options.quarantinedArtifactGuard }
        : {}),
      ...(this.ports.options.personaMutationAttemptGuard
        ? { personaMutationAttemptGuard: this.ports.options.personaMutationAttemptGuard }
        : {}),
      get visionIntake() { return resolveVisionIntake(); },
      inlineImageRetention,
      get policyConfig() { return resolvePolicyConfig(); },
      get workspacePath() { return resolveWorkspacePath(); },
      personalWorkspaceIsolation: this.ports.multiCompanion.enabled,
      sessionHmacKeyring: this.ports.sessionHmacKeyring,
      // an52.3: bind the tier to THIS connection's authenticated companion so
      // shard.backend.request (and any gated method) resolves the caller's own
      // capability tier, not the gateway's single hydrated root.
      capabilityTierProvider: () => this.ports.capabilityTierProvider(this.ports.connectionRouter.authenticatedCompanionId(conn)),
      ...(this.ports.options.capabilityGrantSnapshotProvider
        ? {
            capabilityGrantSnapshotProvider: () =>
              this.ports.options.capabilityGrantSnapshotProvider!(this.ports.connectionRouter.authenticatedCompanionId(conn)),
          }
        : {}),
      ...(this.ports.options.shardBackendExecutor
        ? { shardBackendExecutor: this.ports.options.shardBackendExecutor }
        : {}),
      // 2h6q.3: per-dispatch authenticated shard lineage for gated methods.
      resolveShardWorkloadForChannel: (channelId) =>
        this.resolveShardWorkloadForGatedDispatch(conn, channelId),
      approvalBoundary: this.ports.approvalBoundary,
      ...(this.ports.options.kubeSelfManagement
        ? { kubeSelfManagement: this.ports.options.kubeSelfManagement }
        : {}),
      ...(this.ports.options.contactLifecycleAuthority
        ? { contactLifecycleAuthority: this.ports.options.contactLifecycleAuthority }
        : {}),
      ...(this.ports.options.systemDataWriter
        ? { systemDataWriter: this.ports.options.systemDataWriter }
        : {}),
      ...(this.ports.options.mcpBroker ? { mcpBroker: this.ports.options.mcpBroker } : {}),
      authenticatedCompanionId: () => this.ports.connectionRouter.authenticatedCompanionId(conn),
      ...(this.ports.options.welfareGrantVerifier
        ? {
            verifyWelfareGrant: (jobId: string, companionId: string) =>
              this.ports.options.welfareGrantVerifier!.verify(jobId, companionId),
          }
        : {}),
      notifyRequester: (method, params) => this.ports.connectionRouter.notifyRequestingConnection(conn, method, params),
      listPendingConfirmations: () => this.ports.approvalBoundary.listPendingConfirmations(),
      listConfirmationHistory: () => this.ports.approvalBoundary.listConfirmationHistory(),
      resolveConfirmation: (params) => {
        const companionId = this.ports.connectionRouter.authenticatedCompanionId(conn);
        if (!companionId) {
          return Promise.resolve({
            id: params.id,
            status: 'not_found' as const,
            message: 'Confirmation request not found.',
            executed: false,
          });
        }
        return this.ports.approvalBoundary.resolveConfirmationForOwner(
          companionId,
          params,
          { kind: 'companion', id: companionId },
        );
      },
      sendNtfy: (params) => this.ports.ntfyNotifier.send(params),
      sendOperatorAlert: (params) => this.ports.operatorAlertDispatcher.dispatch(params),
      getRuntimeHealth: () => this.ports.getRuntimeHealth(this.ports.connectionRouter.authenticatedCompanionId(conn)),
      getCredentialPresence: () => this.ports.options.credentialPresence ?? EMPTY_CREDENTIAL_PRESENCE,
      nextStreamRequestId: () => `gw-${this.ports.nextStreamRequestCounter()}`,
      authorizeIcpConversationCorrelation: async (correlation) => {
        if (!this.ports.icpAutonomyBroker) {
          throw new JSONRPCErrorException(
            'ICP autonomy broker is not configured',
            GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
          );
        }
        const companionId = this.ports.connectionRouter.requireAuthenticatedAgentCompanionId(conn);
        return await this.ports.icpAutonomyBroker.bindConversationCostCorrelation(
          companionId,
          correlation,
        );
      },
      recordAuditEvent: async (entry) => {
        if (this.ports.options.auditStore) {
          await this.ports.options.auditStore.recordSummary(entry);
        }
      },
      audited: (method, handler, paramsSummary) => this.ports.auditTrail.audited(method, handler, paramsSummary),
    };

    registerGatewayMethods(runtime);
    registerGatewayIcpAutonomyRpc({
      target,
      broker: this.ports.icpAutonomyBroker,
      requireAuthenticatedCompanionId: () => this.ports.connectionRouter.requireAuthenticatedAgentCompanionId(conn),
      audited: (method, handler, paramsSummary) => this.ports.auditTrail.audited(method, handler, paramsSummary),
    });
    target.addMethod('gateway.client.identify', (params: unknown) => this.ports.identifyConnection(conn, params));
    target.addMethod('gateway.client.ready', (params: unknown) => this.ports.markConnectionReady(conn, params));
    target.addMethod(
      'gateway.client.health',
      (params: unknown) => this.ports.recordConnectionPosture(conn, params),
    );
    target.addMethod('shard.workload.register', this.ports.auditTrail.audited(
      'shard.workload.register',
      async (params: unknown) => {
        const companionId = this.ports.connectionRouter.requireAuthenticatedAgentCompanionId(conn);
        if (!this.ports.shardWorkloadRegistrar) {
          throw new JSONRPCErrorException(
            'Shard workload registration is unavailable',
            GatewayErrors.POLICY_DENIED,
          );
        }
        return this.ports.shardWorkloadRegistrar.register(conn, companionId, params);
      },
      () => ({
        companionId: this.ports.connectionStatuses.get(conn)?.companionId ?? '(unidentified)',
      }),
    ));
    target.addMethod('shard.workload.end', this.ports.auditTrail.audited(
      'shard.workload.end',
      async (params: unknown) => {
        this.ports.connectionRouter.requireAuthenticatedAgentCompanionId(conn);
        if (!this.ports.shardWorkloadRegistrar) {
          throw new JSONRPCErrorException(
            'Shard workload registration is unavailable',
            GatewayErrors.POLICY_DENIED,
          );
        }
        return this.ports.shardWorkloadRegistrar.end(conn, params);
      },
      () => ({
        companionId: this.ports.connectionStatuses.get(conn)?.companionId ?? '(unidentified)',
      }),
    ));
    target.addMethod('companion.message.send', this.ports.auditTrail.audited(
      'companion.message.send',
      (params: unknown) => this.ports.companionMessageLane.handleCompanionMessageSend(conn, params),
      (params: unknown) => ({
        senderCompanionId: this.ports.connectionStatuses.get(conn)?.companionId ?? '(unidentified)',
        ...(isRecord(params) && typeof params.channelId === 'string' ? { channelId: params.channelId } : {}),
        ...(isRecord(params) && typeof params.content === 'string' ? { contentLength: params.content.length } : {}),
      }),
    ));
    target.addMethod('companion.message.report_failure', this.ports.auditTrail.audited(
      'companion.message.report_failure',
      (params: unknown) => this.ports.companionMessageLane.handleCompanionMessageFailureReport(conn, params),
      (params: unknown) => ({
        reportingCompanionId: this.ports.connectionStatuses.get(conn)?.companionId ?? '(unidentified)',
        ...(isRecord(params) && typeof params.channelId === 'string' ? { channelId: params.channelId } : {}),
        ...(isRecord(params) && typeof params.messageId === 'string' ? { messageId: params.messageId } : {}),
        ...(isRecord(params) && typeof params.reason === 'string' ? { reason: params.reason } : {}),
      }),
    ));
    target.addMethod('api.stream.delta', (params: unknown) => {
      if (!isRecord(params)
        || typeof params.requestId !== 'string'
        || typeof params.text !== 'string') {
        this.ports.alarmCompanionViolation(
          'api_stream_delta_rejected',
          'api.stream.delta rejected: notification shape is invalid',
          {
            senderCompanionId: this.ports.connectionStatuses.get(conn)?.companionId ?? '(unidentified)',
          },
        );
        return null;
      }
      const notification: ApiStreamDeltaNotification = {
        requestId: params.requestId,
        text: params.text,
      };
      if (this.ports.multiCompanion.enabled
        && !this.isConnectionAuthorizedForApiStream(conn, notification.requestId)) {
        const expectedCompanionId = this.apiStreamCompanionTargets.get(notification.requestId)
          ?? this.ports.sharedSatellite.sharedSatelliteChatRequests.get(notification.requestId)
          ?? this.ports.multiCompanion.channelRouting.api;
        this.ports.alarmCompanionViolation(
          'api_stream_delta_rejected',
          'api.stream.delta rejected: sending connection is not the request-bound api companion',
          {
            senderCompanionId: this.ports.connectionStatuses.get(conn)?.companionId ?? '(unidentified)',
            routedApiCompanionId: expectedCompanionId ?? '(unrouted)',
          },
        );
        return null;
      }
      // d269: streamed reply frames are main-reply egress. The agent attaches
      // the session canary under the reserved carrier key (never forwarded);
      // the guard scans the frame over a rolling per-request window and, in
      // enforce mode, a hit closes the stream tap for the request.
      const carrierToken = readCanaryCarrier(params);
      if (this.ports.canaryEgressGuard) {
        const verdict = this.ports.canaryEgressGuard.inspectApiStreamDelta({
          requestId: notification.requestId,
          text: notification.text,
          token: carrierToken,
        });
        if (!verdict.forward) return null;
      }
      this.dispatchApiStreamDelta(
        notification,
        this.ports.connectionStatuses.get(conn)?.companionId,
      );
      return null;
    });
    target.addMethod('companion.event.publish', async (params: unknown) => {
      await this.dispatchCompanionEventPublish(conn, params);
      return null;
    });
    target.addMethod('shared.workspace.list', this.ports.auditTrail.audited(
      'shared.workspace.list',
      (params: unknown) => this.ports.connectionScope.listSharedWorkspaceArtifacts(conn, params),
      (params: unknown) => ({
        ...(isRecord(params) && typeof params.cursor === 'string'
          ? { cursor: params.cursor }
          : {}),
      }),
    ));
    target.addMethod('shared.workspace.read', this.ports.auditTrail.audited(
      'shared.workspace.read',
      (params: unknown) => this.ports.connectionScope.readSharedWorkspaceArtifact(conn, params),
      (params: unknown) => ({
        ...(isRecord(params) && typeof params.artifactPath === 'string'
          ? { artifactPath: params.artifactPath }
          : {}),
      }),
    ));
  }

  /**
   * Agent-forwarded redacted companion events (tool activity, artifacts,
   * emotion snapshots). The params are re-validated and payloads reconstructed
   * field-by-field at this process boundary; malformed frames are rejected,
   * never partially published. Approval events cannot arrive here — they
   * originate inside the gateway approval boundary.
   */
  private async dispatchCompanionEventPublish(
    conn: GatewayRpcConnection,
    params: unknown,
  ): Promise<void> {
    const parsed = parseCompanionRelayPublishParams(params);
    const companionId = this.ports.connectionStatuses.get(conn)?.companionId;
    if (this.ports.multiCompanion.enabled && !companionId) {
      throw new Error('companion.event.publish requires an authenticated companion identity');
    }
    if (parsed.kind === 'tool.activity') {
      await this.ports.options.eventBus.emit('companion.tool.activity', {
        payload: parsed.payload,
        ...(parsed.channelId ? { channelId: parsed.channelId } : {}),
        ...(companionId ? { companionId } : {}),
        timestamp: Date.now(),
      });
      return;
    }
    if (parsed.kind === 'emotion.snapshot') {
      await this.ports.options.eventBus.emit('companion.emotion.snapshot', {
        payload: parsed.payload,
        ...(parsed.channelId ? { channelId: parsed.channelId } : {}),
        ...(companionId ? { companionId } : {}),
        timestamp: Date.now(),
      });
      return;
    }
    await this.ports.options.eventBus.emit('companion.artifact.created', {
      payload: parsed.payload,
      ...(parsed.preview ? { preview: parsed.preview } : {}),
      ...(parsed.channelId ? { channelId: parsed.channelId } : {}),
      ...(companionId ? { companionId } : {}),
      timestamp: Date.now(),
    });
  }

  private isConnectionAuthorizedForApiStream(
    conn: GatewayRpcConnection,
    requestId: string,
  ): boolean {
    const routedCompanionId = this.apiStreamCompanionTargets.get(requestId)
      ?? this.ports.sharedSatellite.sharedSatelliteChatRequests.get(requestId)
      ?? this.ports.multiCompanion.channelRouting.api;
    if (!routedCompanionId) {
      return false;
    }
    return this.ports.connectionStatuses.get(conn)?.companionId === routedCompanionId;
  }

  /**
   * 2h6q.3: bind a gated dispatch to its authenticated shard workload. The
   * runtime-stamped correlation channel id is only a lookup key into the
   * server-owned workload registry; every authority value (parent binding,
   * generation, frozen derived access) comes from registration state. Fail
   * closed: a recognizably shard-originated channel that cannot be bound to
   * a live workload of THIS connection's authenticated companion is denied —
   * it must never fall through to the parent's own (possibly autonomous)
   * authority. Recognition is registry-backed, not just prefix-based:
   * satellite/Wyoming shard workloads register arbitrary channel schemes, so
   * the registry's ever-hosted tombstones (live, ended, or superseded
   * generations) deny alongside the `shard:` scheme rule, which alone covers
   * the no-registry configuration.
   */
  private resolveShardWorkloadForGatedDispatch(
    conn: GatewayRpcConnection,
    channelId: string | undefined,
  ): {
    workload: AuthenticatedShardWorkloadHandle;
    identity: import('../../../system/capabilities/shard-approval-grant-contracts.js').AuthenticatedShardWorkloadIdentity;
  } | undefined {
    const normalized = channelId?.trim();
    if (!normalized) {
      return undefined;
    }
    const registry = this.ports.options.shardApprovalWorkloads;
    const companionId = this.ports.connectionRouter.authenticatedCompanionId(conn);
    if (registry && companionId) {
      // May throw on ambiguous channel lineage — ambiguity is a denial.
      const workload = registry.resolveWorkloadForChannel(companionId, normalized);
      if (workload) {
        if (!this.ports.shardApprovalGrants) {
          throw new JSONRPCErrorException(
            'Shard-originated request denied: authenticated shard authority is unavailable',
            GatewayErrors.POLICY_DENIED,
          );
        }
        return {
          workload,
          identity: this.ports.shardApprovalGrants.resolveAuthenticatedWorkload(workload),
        };
      }
    }
    const shardRecognizable = normalized.startsWith('shard:')
      || (registry !== undefined
        && companionId !== undefined
        && registry.hasHostedWorkloadForChannel(companionId, normalized));
    if (shardRecognizable) {
      throw new JSONRPCErrorException(
        'Shard-originated request denied: no live authenticated shard workload matches this dispatch',
        GatewayErrors.POLICY_DENIED,
      );
    }
    return undefined;
  }
}
