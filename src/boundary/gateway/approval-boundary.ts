import { JSONRPCErrorException } from 'json-rpc-2.0';
import type { CapabilityTier } from '../../system/config/runtime-config-contracts.js';
import type { ChannelOutboundDock } from '../../channels/backplane/types.js';
import type { EventBus } from '../../shared/event-bus.js';
import type {
  ConfirmationQueueEntry,
  ConfirmationQueueHistoryEntry,
  ConfirmationQueueRequest,
  ConfirmationExecutionContext,
  ConfirmationApprovalOwner,
  ConfirmationResolverIdentity,
  ConfirmationResolveResult,
  ConfirmationQueueTerminalOutcome,
} from '../../system/capabilities/confirmation-queue.js';
import type {
  AuthenticatedShardWorkloadHandle,
  AuthenticatedShardWorkloadIdentity,
  PreparedShardRequestGrant,
} from '../../system/capabilities/shard-approval-grants.js';
import {
  isShardExceptionalAction,
  ShardApprovalGrantAuthority,
} from '../../system/capabilities/shard-approval-grants.js';
import {
  ConfirmationExecutionCommittedError,
  ConfirmationQueue,
  DEFAULT_CONFIRMATION_EXPIRY_MS,
} from '../../system/capabilities/confirmation-queue.js';
import type { ApprovalAttribution } from '../../shared/contracts/approval-envelope.js';
import { createCompanionDisplayIdentityResolver } from '../../shared/companion-display-identity.js';
import {
  redactApprovalRequested,
  redactApprovalResolved,
} from '../../channels/backplane/companion-relay/redaction.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { evaluatePolicy, type PolicyConfig } from './policy.js';
import { GatewayErrors, type GatewayPolicyDecision } from './protocol.js';
import {
  GatewayNtfyNotifier,
  notifyOperatorForPendingAction,
} from './ntfy-notifier.js';
import { executeQueuedAction, resolveCompanionReason } from './confirmation-actions.js';
import type { CanaryEgressGuard } from './canary-egress-guard.js';

const unknownCompanionDisplayIdentity = createCompanionDisplayIdentityResolver([]);

interface ApprovalBoundaryAuditHooks {
  audit(method: string, decision: GatewayPolicyDecision, params?: Record<string, unknown>): Promise<number>;
  auditComplete(id: number, startTime: number, error?: string): Promise<void>;
  recordMethodSuccess(method: string): void;
  recordMethodFailure(method: string, error: unknown): void;
}

interface ApprovalBoundaryOptions extends ApprovalBoundaryAuditHooks {
  policyConfig: PolicyConfig;
  ntfyNotifier: GatewayNtfyNotifier;
  discordAdapter: ChannelOutboundDock;
  // an52.3: resolved for the authenticated companion that owns the gated action
  // (see the gate's authenticatedCompanionId), so a fleet's autonomous
  // auto-clear reflects that companion's own tier — not the gateway's root.
  capabilityTierProvider: (companionId?: string) => CapabilityTier;
  confirmation?: Partial<GatewayConfirmationConfig>;
  /**
   * htm9.18 egress tripwire. Gated egress methods (e.g. web.fetch) run their
   * handlers through this boundary, so the canary scan must also apply here.
   */
  canaryEgressGuard?: CanaryEgressGuard;
  /**
   * Companion relay emission seam (w9hj.1): every confirmation-queue
   * enqueue/resolution/expiry is redacted at emission and published as a
   * typed `companion.approval.*` event.
   */
  eventBus: EventBus;
  /** Canonical presentation label resolved from runtime identity/roster data. */
  parentLabelProvider?: (companionId: string) => string | undefined;
  /**
   * Server-owned shard workload/grant registry. Absence keeps every shard
   * temporary-grant path disabled.
   */
  shardApprovalGrants?: ShardApprovalGrantAuthority;
}

export interface GatewayConfirmationConfig {
  expiryMs: number;
  operatorDiscordChannelId?: string;
  ntfyTopic?: string;
}

export interface ApprovalBoundaryGateOptions<P, R> {
  method: string;
  handler: (params: P) => Promise<R>;
  paramsSummary: (params: P) => Record<string, unknown>;
  /** Authenticated owner of the RPC that may enter the confirmation queue. */
  authenticatedCompanionId: () => string | undefined;
  approvalAction: string;
  approvalScope: (params: P) => string;
  approvalReason?: (params: P) => string;
  /** Runs on canonical raw-tool params before policy summaries or handler dispatch. */
  prePolicyGuard?: (params: P) => void;
  /** Connection-scoped policy authority for multi-companion workspace isolation. */
  policyConfigProvider?: () => PolicyConfig;
  /**
   * Authenticated server-owned shard workload bound to this dispatch,
   * resolved per-request from the shard-workload registry (2h6q.3). The
   * resolver receives the dispatch params only so it can read the
   * runtime-stamped correlation channel id as a lookup key into server-owned
   * registration state — params never carry authority, and the resolver MUST
   * throw (deny) for a recognizably shard-originated dispatch it cannot bind
   * to a live authenticated workload. A present binding disables autonomous
   * auto-clear unconditionally. The authority derives the required token from
   * the trusted method/action; a caller cannot select or substitute a
   * capability token.
   */
  shardApprovalGrant?: (params: P) => {
    workload: AuthenticatedShardWorkloadHandle;
    identity: AuthenticatedShardWorkloadIdentity;
  } | undefined;
}

export interface ApprovalBoundaryService {
  listPendingConfirmations(): ConfirmationQueueEntry[];
  listConfirmationHistory(): ConfirmationQueueHistoryEntry[];
  /** Pending entries owned by exactly one authenticated parent companion. */
  listPendingConfirmationsForOwner(companionId: string): ConfirmationQueueEntry[];
  /**
   * Read-only owner lookup for a pending/resolved confirmation id (companion
   * roster wire). Returns the authenticated companion that enqueued the
   * confirmation, or `undefined` when none is recorded. Used to attribute
   * approvals in the fleet-wide approvals view; a `undefined` result excludes
   * the entry (fail closed, never mis-attributed).
   */
  ownerOfConfirmation(id: string): string | undefined;
  /** Immutable parent/shard binding captured from authenticated enqueue lineage. */
  approvalOwnerOfConfirmation(id: string): ConfirmationApprovalOwner | undefined;
  /**
   * Resolve only when the pending record's immutable stored owner matches.
   * Mismatches are non-enumerating `not_found` outcomes and leave the request
   * pending.
   */
  resolveConfirmationForOwner(
    companionId: string,
    params: {
      id: string;
      decision: 'approve' | 'deny' | 'modify';
      modifiedParams?: Record<string, unknown>;
    },
    resolver?: ConfirmationResolverIdentity,
  ): Promise<{
    id: string;
    status: 'approved' | 'denied' | 'modified' | 'expired' | 'failed' | 'not_found';
    message: string;
    executed: boolean;
  }>;
  resolveConfirmation(params: { id: string; decision: 'approve' | 'deny' | 'modify'; modifiedParams?: Record<string, unknown> }, resolver?: ConfirmationResolverIdentity): Promise<{
    id: string;
    status: 'approved' | 'denied' | 'modified' | 'expired' | 'failed' | 'not_found';
    message: string;
    executed: boolean;
  }>;
  requestExplicitApproval(input: {
    authenticatedCompanionId: string | undefined;
    /**
     * Attribution-only seam retained for mus2.3 callers. This boundary validates
     * shape and owner consistency but cannot authenticate this object by itself;
     * consequently it MUST NOT confer temporary capability authority. Production
     * shard grants use `shardGrant.workload`, resolved through the gateway-owned
     * authenticated-workload registry populated by the agent's lifecycle RPC.
     */
    shardLineage?: { shardId: string; shardLabel?: string };
    shardGrant?: {
      workload: AuthenticatedShardWorkloadHandle;
    };
    request: ConfirmationQueueRequest;
    execute: (
      params: Record<string, unknown>,
      entry: ConfirmationQueueEntry,
      context: ConfirmationExecutionContext,
    ) => Promise<unknown>;
    /** Called after the existing confirmation surface has accepted and emitted the alert. */
    afterEnqueued?: (entry: ConfirmationQueueEntry) => Promise<void>;
    /** Security-sensitive requests may require every Partner-alert consumer to acknowledge delivery. */
    requirePartnerAlertDelivery?: boolean;
    /** Durable denial hook; failure leaves the confirmation pending and retryable. */
    onDenied?: (outcome: ConfirmationQueueTerminalOutcome) => Promise<void>;
    retainOnExecutionFailure?: boolean;
    renewOnExpiry?: boolean;
  }): Promise<ConfirmationQueueEntry>;
  refreshExplicitApproval(input: {
    authenticatedCompanionId: string | undefined;
    id: string;
    execute: (
      params: Record<string, unknown>,
      entry: ConfirmationQueueEntry,
      context: ConfirmationExecutionContext,
    ) => Promise<unknown>;
    afterRefreshed?: (entry: ConfirmationQueueEntry) => Promise<void>;
    onDenied?: (outcome: ConfirmationQueueTerminalOutcome) => Promise<void>;
    retainOnExecutionFailure?: boolean;
    renewOnExpiry?: boolean;
  }): Promise<ConfirmationQueueEntry>;
  reconcileExplicitApproval(input: {
    authenticatedCompanionId: string | undefined;
    id: string;
    status: 'approved' | 'denied';
  }): ConfirmationResolveResult;
  gate<P, R>(options: ApprovalBoundaryGateOptions<P, R>): (params: P) => Promise<R>;
}

const approvalLog = createComponentLogger('ApprovalBoundary');

export function createGatewayApprovalBoundaryService(
  options: ApprovalBoundaryOptions,
): ApprovalBoundaryService {
  const emitApprovalRequested = async (
    entry: ConfirmationQueueEntry,
    required: boolean,
  ): Promise<void> => {
    const owner = entry.approvalOwner;
    if (!owner) {
      throw new Error(`Refusing to emit ownerless companion.approval.requested for ${entry.id}`);
    }
    const attribution = entry.attribution;
    if (!attribution) {
      throw new Error(`Refusing to emit companion.approval.requested without canonical attribution for ${entry.id}`);
    }
    if (attribution.parentId !== owner.companionId
      || attribution.shardId !== owner.shardId) {
      throw new Error(`Refusing to emit companion.approval.requested with mismatched attribution for ${entry.id}`);
    }
    const event = {
      companionId: owner.companionId,
      ...(owner.shardId !== undefined ? { shardId: owner.shardId } : {}),
      payload: redactApprovalRequested(entry, {
        sourceSystem: entry.sourceSystem ?? 'tool-access',
        attribution,
        grantMode: { kind: 'once' },
      }),
      timestamp: Date.now(),
    };
    if (required) {
      await options.eventBus.emitRequired('companion.approval.requested', event);
      return;
    }
    options.eventBus.emit('companion.approval.requested', event).catch((error) => {
      approvalLog.error('Failed to emit companion.approval.requested', {
        id: entry.id,
        error: toErrorMessage(error),
      });
    });
  };
  const confirmationQueue = new ConfirmationQueue({
    defaultExpiryMs: options.confirmation?.expiryMs ?? DEFAULT_CONFIRMATION_EXPIRY_MS,
    observer: {
      beforeTerminalized: (outcome) => {
        // The queue invokes this before deleting the pending entry or appending
        // terminal history. A failed security audit therefore leaves the
        // public resolution retryable instead of creating a partial commit.
        options.shardApprovalGrants?.recordRequestResolution({
          approvalId: outcome.id,
          status: outcome.status,
          ...(outcome.resolver ? { resolver: outcome.resolver } : {}),
        });
      },
      onResolved: (outcome) => {
        const owner = outcome.entry.approvalOwner;
        if (!owner) {
          approvalLog.error('Refusing to emit ownerless companion.approval.resolved', {
            id: outcome.id,
          });
          return;
        }
        options.eventBus.emit('companion.approval.resolved', {
          companionId: owner.companionId,
          ...(owner.shardId !== undefined ? { shardId: owner.shardId } : {}),
          payload: redactApprovalResolved({
            id: outcome.id,
            status: outcome.status,
            resolvedAt: outcome.resolvedAt,
            executed: outcome.executed,
            ...(owner.shardId !== undefined ? { shardId: owner.shardId } : {}),
          }),
          timestamp: Date.now(),
        }).catch((error) => {
          approvalLog.error('Failed to emit companion.approval.resolved', {
            id: outcome.id,
            error: toErrorMessage(error),
          });
        });
      },
    },
  });
  const confirmationConfig = {
    expiryMs: options.confirmation?.expiryMs ?? DEFAULT_CONFIRMATION_EXPIRY_MS,
    operatorDiscordChannelId: options.confirmation?.operatorDiscordChannelId?.trim() || undefined,
    ntfyTopic: options.confirmation?.ntfyTopic?.trim() || undefined,
  };

  /**
   * Resolve immutable, server-side approval attribution before enqueue and
   * fail closed on mismatched lineage. The authenticated stable companion id
   * is the presentation fallback when a cosmetic roster label is absent.
   */
  const resolveEnqueueAttribution = (
    owner: string,
    shard: { shardId: string; shardLabel?: string } | undefined,
    supplied: ApprovalAttribution | undefined,
    method: string,
  ): ApprovalAttribution => {
    // Defense-in-depth: a caller-supplied attribution is NEVER authority. It
    // must exactly match the authenticated lineage or the request is denied.
    if (supplied) {
      if (supplied.parentId !== owner) {
        throw new Error(
          `Cannot queue ${method}: supplied attribution parent does not match the authenticated owner`,
        );
      }
      const suppliedShardId = supplied.shardId?.trim() || undefined;
      if (suppliedShardId !== shard?.shardId) {
        throw new Error(
          `Cannot queue ${method}: supplied attribution shard does not match the authenticated shard lineage`,
        );
      }
    }
    const parentLabel = options.parentLabelProvider?.(owner)?.trim()
      || unknownCompanionDisplayIdentity.resolve(owner).displayLabel;
    return {
      parentId: owner,
      parentLabel,
      ...(shard ? { shardId: shard.shardId } : {}),
      ...(shard?.shardLabel ? { shardLabel: shard.shardLabel } : {}),
    };
  };

  const requestExplicitApproval = async (input: {
    authenticatedCompanionId: string | undefined;
    shardLineage?: { shardId: string; shardLabel?: string };
    shardGrant?: {
      workload: AuthenticatedShardWorkloadHandle;
    };
    request: ConfirmationQueueRequest;
    execute: (
      params: Record<string, unknown>,
      entry: ConfirmationQueueEntry,
      context: ConfirmationExecutionContext,
    ) => Promise<unknown>;
    afterEnqueued?: (entry: ConfirmationQueueEntry) => Promise<void>;
    requirePartnerAlertDelivery?: boolean;
    onDenied?: (outcome: ConfirmationQueueTerminalOutcome) => Promise<void>;
    retainOnExecutionFailure?: boolean;
    renewOnExpiry?: boolean;
  }): Promise<ConfirmationQueueEntry> => {
    if (!input.authenticatedCompanionId) {
      throw new Error(
        `Cannot queue ${input.request.method}: requesting connection has no authenticated companion owner`,
      );
    }
    // Resolve presentation lineage. shardLineage alone is attribution-only and
    // never grants authority; a temporary grant replaces it with identity read
    // from the opaque server-owned workload handle.
    let shard: { shardId: string; shardLabel?: string } | undefined;
    if (input.shardLineage !== undefined) {
      const shardId = input.shardLineage.shardId.trim();
      if (!shardId) {
        throw new Error(
          `Cannot queue ${input.request.method}: shard-originated request has no authenticated shard instance id`,
        );
      }
      const shardLabel = input.shardLineage.shardLabel?.trim();
      shard = { shardId, ...(shardLabel ? { shardLabel } : {}) };
    }
    let shardGrantAuthority: ShardApprovalGrantAuthority | undefined;
    if (input.shardGrant) {
      const grantAuthority = options.shardApprovalGrants;
      if (!grantAuthority) {
        throw new Error(
          `Cannot queue ${input.request.method}: shard approval grant authority is unavailable`,
        );
      }
      shardGrantAuthority = grantAuthority;
      const workload = grantAuthority.resolveAuthenticatedWorkload(input.shardGrant.workload);
      if (workload.parentCompanionId !== input.authenticatedCompanionId) {
        throw new Error(
          `Cannot queue ${input.request.method}: shard workload parent does not match the authenticated owner`,
        );
      }
      if (
        shard
        && (
          shard.shardId !== workload.shardId
          || (shard.shardLabel !== undefined && shard.shardLabel !== workload.shardLabel)
        )
      ) {
        throw new Error(
          `Cannot queue ${input.request.method}: supplied shard attribution does not match the authenticated workload`,
        );
      }
      shard = {
        shardId: workload.shardId,
        ...(workload.shardLabel ? { shardLabel: workload.shardLabel } : {}),
      };
    }
    // Resolve + validate the immutable attribution BEFORE enqueue. A mismatched
    // parent or shard throws here, so nothing enqueues, emits, or notifies.
    const attribution = resolveEnqueueAttribution(
      input.authenticatedCompanionId,
      shard,
      input.request.attribution,
      input.request.method,
    );
    const preparedShardGrant: PreparedShardRequestGrant | undefined =
      input.shardGrant && shardGrantAuthority
        ? shardGrantAuthority.prepareRequestGrant({
            workload: input.shardGrant.workload,
            method: input.request.method,
            action: input.request.action,
            scope: input.request.scope,
            params: input.request.params,
          })
        : undefined;
    const approvalOwner: ConfirmationApprovalOwner = {
      companionId: input.authenticatedCompanionId,
      ...(shard ? { shardId: shard.shardId } : {}),
    };
    const request: ConfirmationQueueRequest = {
      ...input.request,
      attribution,
      approvalOwner,
      ...(preparedShardGrant ? { resolutionAuthority: 'operator' as const } : {}),
    };
    if (input.request.approvalOwner
      && (input.request.approvalOwner.companionId !== approvalOwner.companionId
        || input.request.approvalOwner.shardId !== approvalOwner.shardId)) {
      throw new Error(
        `Cannot queue ${input.request.method}: supplied approval owner does not match authenticated lineage`,
      );
    }
    const execute = preparedShardGrant
      ? async (
          params: Record<string, unknown>,
          entry: ConfirmationQueueEntry,
          context: ConfirmationExecutionContext,
        ): Promise<unknown> => {
          const grantAuthority = options.shardApprovalGrants;
          const shardGrant = input.shardGrant;
          if (!grantAuthority || !shardGrant) {
            throw new Error('Shard request grant authority became unavailable before dispatch');
          }
          const grant = grantAuthority.activateRequestGrant(preparedShardGrant, context);
          grantAuthority.consumeRequestGrant({
            workload: shardGrant.workload,
            grantId: grant.grantId,
            approvalId: entry.id,
            method: entry.method,
            action: entry.action,
            scope: entry.scope,
            params,
          });
          let result: unknown;
          try {
            result = await input.execute(params, entry, context);
          } catch (error) {
            const executionCommitted = error instanceof ConfirmationExecutionCommittedError;
            try {
              grantAuthority.recordRequestExecution(
                grant.grantId,
                executionCommitted ? 'executed' : 'execution_failed',
              );
            } catch (auditError) {
              if (executionCommitted) {
                throw new ConfirmationExecutionCommittedError(
                  'Shard operation committed but its grant execution audit failed',
                  { cause: auditError },
                );
              }
              throw auditError;
            }
            throw error;
          }
          try {
            grantAuthority.recordRequestExecution(grant.grantId, 'executed');
          } catch (error) {
            throw new ConfirmationExecutionCommittedError(
              'Shard operation committed but its grant execution audit failed',
              { cause: error },
            );
          }
          return result;
        }
      : input.execute;
    const queueEntry = confirmationQueue.enqueue(request, execute, {
      ...(input.onDenied ? { onDenied: input.onDenied } : {}),
      ...(input.retainOnExecutionFailure ? { retainOnExecutionFailure: true } : {}),
      ...(input.renewOnExpiry ? { renewOnExpiry: true } : {}),
    });
    try {
      await emitApprovalRequested(queueEntry, input.requirePartnerAlertDelivery === true);
    } catch (error) {
      confirmationQueue.discardPending(queueEntry.id);
      throw error;
    }
    await input.afterEnqueued?.(queueEntry);
    if (preparedShardGrant && shardGrantAuthority) {
      shardGrantAuthority.bindRequestGrant(preparedShardGrant, {
        approvalId: queueEntry.id,
        expiresAt: queueEntry.expiresAt,
      });
    }
    await notifyOperatorForPendingAction({
      entry: queueEntry,
      discordAdapter: options.discordAdapter,
      operatorDiscordChannelId: confirmationConfig.operatorDiscordChannelId,
      ntfyTopic: confirmationConfig.ntfyTopic,
      ntfyNotifier: options.ntfyNotifier,
    });
    return queueEntry;
  };

  return {
    listPendingConfirmations: () => confirmationQueue.listPending(),
    listConfirmationHistory: () => confirmationQueue.listHistory(),
    listPendingConfirmationsForOwner: (companionId: string) => confirmationQueue
      .listPending()
      .filter(entry => entry.approvalOwner?.companionId === companionId),
    ownerOfConfirmation: (id: string) => confirmationQueue.getApprovalOwner(id)?.companionId,
    approvalOwnerOfConfirmation: (id: string) => confirmationQueue.getApprovalOwner(id) ?? undefined,
    resolveConfirmationForOwner: (companionId, params, resolver) => {
      const owner = confirmationQueue.getApprovalOwner(params.id);
      if (owner?.companionId !== companionId) {
        return Promise.resolve({
          id: params.id,
          status: 'not_found' as const,
          message: 'Confirmation request not found.',
          executed: false,
        });
      }
      return confirmationQueue.resolve(params, resolver);
    },
    resolveConfirmation: (params, resolver) => confirmationQueue.resolve(params, resolver),
    requestExplicitApproval,
    refreshExplicitApproval: async input => {
      if (!input.authenticatedCompanionId) {
        throw new Error('Cannot refresh confirmation with no authenticated companion owner');
      }
      const owner = confirmationQueue.getApprovalOwner(input.id);
      if (owner?.companionId !== input.authenticatedCompanionId) {
        throw new Error(`Cannot refresh confirmation ${input.id}: authenticated owner mismatch`);
      }
      const entry = confirmationQueue.refreshPending(input.id, input.execute, {
        ...(input.onDenied ? { onDenied: input.onDenied } : {}),
        ...(input.retainOnExecutionFailure ? { retainOnExecutionFailure: true } : {}),
        ...(input.renewOnExpiry ? { renewOnExpiry: true } : {}),
      });
      await input.afterRefreshed?.(entry);
      return entry;
    },
    reconcileExplicitApproval: input => {
      if (!input.authenticatedCompanionId) {
        throw new Error('Cannot reconcile confirmation with no authenticated companion owner');
      }
      const owner = confirmationQueue.getApprovalOwner(input.id);
      if (owner?.companionId !== input.authenticatedCompanionId) {
        throw new Error(`Cannot reconcile confirmation ${input.id}: authenticated owner mismatch`);
      }
      return confirmationQueue.reconcileRetainedResolution(input.id, input.status);
    },
    gate<P, R>(gateOptions: ApprovalBoundaryGateOptions<P, R>): (params: P) => Promise<R> {
      return async (rawParams: P) => {
        // htm9.18 egress tripwire: hold the action if the session canary leaked
        // into this outbound method, and strip the carrier before policy eval,
        // approval enqueue, or the handler ever sees it.
        let params: P;
        try {
          params = (options.canaryEgressGuard
            ? options.canaryEgressGuard.inspect(gateOptions.method, rawParams)
            : rawParams) as P;
        } catch (err) {
          options.recordMethodFailure(gateOptions.method, err);
          const heldAuditId = await options.audit(gateOptions.method, 'DENY', { canaryEgressHeld: true });
          await options.auditComplete(heldAuditId, Date.now(), toErrorMessage(err));
          throw err;
        }
        try {
          gateOptions.prePolicyGuard?.(params);
        } catch (err) {
          options.recordMethodFailure(gateOptions.method, err);
          const deniedAuditId = await options.audit(gateOptions.method, 'DENY', {
            prePolicyGuardDenied: true,
          });
          await options.auditComplete(deniedAuditId, Date.now(), toErrorMessage(err));
          throw err;
        }
        const summary = gateOptions.paramsSummary(params);
        let shardApprovalGrant: ReturnType<NonNullable<typeof gateOptions.shardApprovalGrant>>;
        try {
          shardApprovalGrant = gateOptions.shardApprovalGrant?.(params);
        } catch (err) {
          options.recordMethodFailure(gateOptions.method, err);
          const deniedAuditId = await options.audit(gateOptions.method, 'DENY', summary);
          await options.auditComplete(deniedAuditId, Date.now(), toErrorMessage(err));
          throw err;
        }
        const decision = evaluatePolicy(
          {
            method: gateOptions.method,
            params: params as unknown as Record<string, unknown>,
            callerClass: shardApprovalGrant ? 'shard' : 'companion',
          },
          gateOptions.policyConfigProvider?.() ?? options.policyConfig,
        );
        const auditId = await options.audit(gateOptions.method, decision, summary);
        const startTime = Date.now();

        try {
          if (decision === 'DENY') {
            throw new JSONRPCErrorException('Policy denied', GatewayErrors.POLICY_DENIED);
          }

          const authenticatedCompanionId = gateOptions.authenticatedCompanionId();
          // 2h6q.3: resolve authenticated shard lineage BEFORE any auto-clear
          // decision. The resolver throws (deny) when a recognizably
          // shard-originated dispatch cannot be bound to a live authenticated
          // workload — including when no grant authority/registry is
          // configured — so shard lineage can never fall through to the
          // parent's autonomous authority.
          const shardExceptionalAction = shardApprovalGrant !== undefined
            && isShardExceptionalAction(gateOptions.method, gateOptions.approvalAction);
          if (
            shardApprovalGrant !== undefined
            && !shardExceptionalAction
            && decision === 'NEEDS_APPROVAL'
          ) {
            // A shard fence is never auto-cleared, and a shard approval
            // without an exact-once grant binding is not offered: deny.
            throw new JSONRPCErrorException(
              `Shard-originated ${gateOptions.method} is not an eligible shard exceptional action`,
              GatewayErrors.POLICY_DENIED,
            );
          }
          if (
            shardExceptionalAction
            || (
              decision === 'NEEDS_APPROVAL'
              && shardApprovalGrant === undefined
              && options.capabilityTierProvider(authenticatedCompanionId) !== 'autonomous'
            )
          ) {
            const paramsRecord = params as unknown as Record<string, unknown>;
            const queueEntry = await requestExplicitApproval({
              authenticatedCompanionId,
              ...(shardApprovalGrant ? { shardGrant: shardApprovalGrant } : {}),
              request: {
                method: gateOptions.method,
                action: gateOptions.approvalAction,
                scope: gateOptions.approvalScope(params),
                params: paramsRecord,
                companionReason: resolveCompanionReason(
                  paramsRecord,
                  gateOptions.approvalReason?.(params) ?? 'Outside workspace',
                ),
                expiresInMs: confirmationConfig.expiryMs,
                // Gateway confirmation gate is the tool / information-access
                // escalation surface (psfn-framework-13sk). Attribution is
                // resolved from the authenticated owner in the emission observer.
                sourceSystem: 'tool-access',
              },
              execute: async (approvedParams, entry) => executeQueuedAction({
                method: gateOptions.method,
                handler: gateOptions.handler,
                paramsSummary: gateOptions.paramsSummary,
                params: approvedParams as P,
                entry,
                audit: options.audit,
                auditComplete: options.auditComplete,
              }).then((result) => {
                options.recordMethodSuccess(gateOptions.method);
                return result;
              }).catch((error) => {
                options.recordMethodFailure(gateOptions.method, error);
                throw error;
              }),
            });
            throw new JSONRPCErrorException(
              `Your action is pending operator approval (id: ${queueEntry.id}).`,
              GatewayErrors.NEEDS_APPROVAL,
            );
          }

          const result = await gateOptions.handler(params);
          options.recordMethodSuccess(gateOptions.method);
          await options.auditComplete(auditId, startTime);
          return result;
        } catch (error) {
          options.recordMethodFailure(gateOptions.method, error);
          const message = toErrorMessage(error);
          await options.auditComplete(auditId, startTime, message);
          throw error;
        }
      };
    },
  };
}
