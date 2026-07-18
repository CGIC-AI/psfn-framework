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
} from '../../system/capabilities/confirmation-queue.js';
import {
  ConfirmationQueue,
  DEFAULT_CONFIRMATION_EXPIRY_MS,
} from '../../system/capabilities/confirmation-queue.js';
import type { ApprovalAttribution } from '../../shared/contracts/approval-envelope.js';
import {
  redactApprovalRequested,
  redactApprovalResolved,
} from '../../channels/backplane/companion-relay/redaction.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { evaluatePolicy, type PolicyConfig } from './policy.js';
import { GatewayErrors, type PolicyDecision } from './protocol.js';
import {
  GatewayNtfyNotifier,
  notifyOperatorForPendingAction,
} from './ntfy-notifier.js';
import { executeQueuedAction, resolveCompanionReason } from './confirmation-actions.js';
import type { CanaryEgressGuard } from './canary-egress-guard.js';

interface ApprovalBoundaryAuditHooks {
  audit(method: string, decision: PolicyDecision, params?: Record<string, unknown>): Promise<number>;
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
  /** Connection-scoped policy authority for multi-companion workspace isolation. */
  policyConfigProvider?: () => PolicyConfig;
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
     * Authenticated shard lineage for a shard-originated request (mus2.3).
     * Resolved SERVER-SIDE from shard workload registration — never from tool
     * params or client fields. Absent for ordinary companion approvals. When
     * present, `shardId` MUST be a non-empty authenticated shard-instance id;
     * an empty/whitespace id is an orphaned lineage and is refused BEFORE
     * enqueue. The parent owner is always `authenticatedCompanionId`.
     */
    shardLineage?: { shardId: string; shardLabel?: string };
    request: ConfirmationQueueRequest;
    execute: (
      params: Record<string, unknown>,
      entry: ConfirmationQueueEntry,
      context: ConfirmationExecutionContext,
    ) => Promise<unknown>;
  }): Promise<ConfirmationQueueEntry>;
  gate<P, R>(options: ApprovalBoundaryGateOptions<P, R>): (params: P) => Promise<R>;
}

const approvalLog = createComponentLogger('ApprovalBoundary');

export function createGatewayApprovalBoundaryService(
  options: ApprovalBoundaryOptions,
): ApprovalBoundaryService {
  const confirmationQueue = new ConfirmationQueue({
    defaultExpiryMs: options.confirmation?.expiryMs ?? DEFAULT_CONFIRMATION_EXPIRY_MS,
    observer: {
      onEnqueued: (entry) => {
        const owner = entry.approvalOwner;
        if (!owner) {
          approvalLog.error('Refusing to emit ownerless companion.approval.requested', {
            id: entry.id,
          });
          return;
        }
        // Attribution is resolved SERVER-SIDE before enqueue (see
        // resolveEnqueueAttribution) and stamped onto the entry. The parent id
        // is ALWAYS the authenticated enqueue owner. We re-verify that binding
        // here as defense-in-depth and refuse to route to a spoofed parent.
        const attribution = entry.attribution;
        if (!attribution) {
          approvalLog.error('Refusing to emit companion.approval.requested without a canonical parent label', {
            id: entry.id,
          });
          return;
        }
        if (attribution.parentId !== owner.companionId
          || attribution.shardId !== owner.shardId) {
          approvalLog.error('Refusing to emit companion.approval.requested with mismatched attribution parent', {
            id: entry.id,
          });
          return;
        }
        options.eventBus.emit('companion.approval.requested', {
          companionId: owner.companionId,
          ...(owner.shardId !== undefined ? { shardId: owner.shardId } : {}),
          payload: redactApprovalRequested(entry, {
            sourceSystem: entry.sourceSystem ?? 'tool-access',
            attribution,
            grantMode: { kind: 'once' },
          }),
          timestamp: Date.now(),
        }).catch((error) => {
          approvalLog.error('Failed to emit companion.approval.requested', {
            id: entry.id,
            error: toErrorMessage(error),
          });
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
    const parentLabel = options.parentLabelProvider?.(owner)?.trim() || owner;
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
    request: ConfirmationQueueRequest;
    execute: (
      params: Record<string, unknown>,
      entry: ConfirmationQueueEntry,
      context: ConfirmationExecutionContext,
    ) => Promise<unknown>;
  }): Promise<ConfirmationQueueEntry> => {
    if (!input.authenticatedCompanionId) {
      throw new Error(
        `Cannot queue ${input.request.method}: requesting connection has no authenticated companion owner`,
      );
    }
    // Resolve authenticated shard lineage. A shard request with an empty or
    // whitespace instance id is an orphaned lineage — refuse BEFORE enqueue.
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
    // Resolve + validate the immutable attribution BEFORE enqueue. A mismatched
    // parent or shard throws here, so nothing enqueues, emits, or notifies.
    const attribution = resolveEnqueueAttribution(
      input.authenticatedCompanionId,
      shard,
      input.request.attribution,
      input.request.method,
    );
    const request: ConfirmationQueueRequest = {
      ...input.request,
      attribution,
      approvalOwner: {
        companionId: input.authenticatedCompanionId,
        ...(shard ? { shardId: shard.shardId } : {}),
      },
    };
    if (input.request.approvalOwner
      && (input.request.approvalOwner.companionId !== request.approvalOwner.companionId
        || input.request.approvalOwner.shardId !== request.approvalOwner.shardId)) {
      throw new Error(
        `Cannot queue ${input.request.method}: supplied approval owner does not match authenticated lineage`,
      );
    }
    const queueEntry = confirmationQueue.enqueue(request, input.execute);
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
    approvalOwnerOfConfirmation: (id: string) => confirmationQueue.getApprovalOwner(id),
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
        const decision = evaluatePolicy(
          { method: gateOptions.method, params: params as unknown as Record<string, unknown> },
          gateOptions.policyConfigProvider?.() ?? options.policyConfig,
        );
        const summary = gateOptions.paramsSummary(params);
        const auditId = await options.audit(gateOptions.method, decision, summary);
        const startTime = Date.now();

        try {
          if (decision === 'DENY') {
            throw new JSONRPCErrorException('Policy denied', GatewayErrors.POLICY_DENIED);
          }

          const authenticatedCompanionId = gateOptions.authenticatedCompanionId();
          if (
            decision === 'NEEDS_APPROVAL'
            && options.capabilityTierProvider(authenticatedCompanionId) !== 'autonomous'
          ) {
            const paramsRecord = params as unknown as Record<string, unknown>;
            const queueEntry = await requestExplicitApproval({
              authenticatedCompanionId,
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
