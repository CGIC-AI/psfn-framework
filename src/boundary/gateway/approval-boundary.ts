import { JSONRPCErrorException } from 'json-rpc-2.0';
import type { CapabilityTier } from '../../system/config/runtime-config-contracts.js';
import type { ChannelOutboundDock } from '../../channels/backplane/types.js';
import type { EventBus } from '../../shared/event-bus.js';
import type {
  ConfirmationQueueEntry,
  ConfirmationQueueHistoryEntry,
  ConfirmationQueueRequest,
  ConfirmationExecutionContext,
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
  /**
   * Read-only owner lookup for a pending/resolved confirmation id (companion
   * roster wire). Returns the authenticated companion that enqueued the
   * confirmation, or `undefined` when none is recorded. Used to attribute
   * approvals in the fleet-wide approvals view; a `undefined` result excludes
   * the entry (fail closed, never mis-attributed).
   */
  ownerOfConfirmation(id: string): string | undefined;
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
  // Immutable owner attribution captured at enqueue, keyed by confirmation id.
  // `companionId` is ALWAYS the authenticated parent owner (routing key);
  // `shardId` is optional authenticated shard provenance. The resolved event
  // reuses this captured attribution — a leaked/guessed approval id can never
  // re-attribute a request (SHARD_APPROVALS §Approval Event Contract).
  const confirmationOwners = new Map<string, { companionId: string; shardId?: string }>();
  let enqueueOwner: string | undefined;
  const confirmationQueue = new ConfirmationQueue({
    defaultExpiryMs: options.confirmation?.expiryMs ?? DEFAULT_CONFIRMATION_EXPIRY_MS,
    observer: {
      onEnqueued: (entry) => {
        if (!enqueueOwner) {
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
        if (attribution.parentId !== enqueueOwner) {
          approvalLog.error('Refusing to emit companion.approval.requested with mismatched attribution parent', {
            id: entry.id,
          });
          return;
        }
        const shardId = attribution.shardId;
        confirmationOwners.set(entry.id, {
          companionId: enqueueOwner,
          ...(shardId !== undefined ? { shardId } : {}),
        });
        options.eventBus.emit('companion.approval.requested', {
          companionId: enqueueOwner,
          ...(shardId !== undefined ? { shardId } : {}),
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
        const owner = confirmationOwners.get(outcome.id);
        if (!owner) {
          approvalLog.error('Refusing to emit ownerless companion.approval.resolved', {
            id: outcome.id,
          });
          return;
        }
        confirmationOwners.delete(outcome.id);
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
   * Resolve the immutable, server-side approval attribution BEFORE enqueue and
   * fail closed on any orphaned or mismatched lineage. Returns `undefined` only
   * when no canonical parent label is available for an ordinary companion
   * request — the action still enqueues for the operator Garden surface, but no
   * relay event can emit without a presentation label. A shard-originated
   * request without a resolvable parent label is refused outright: shard
   * provenance must never emit ownerless or unlabeled.
   */
  const resolveEnqueueAttribution = (
    owner: string,
    shard: { shardId: string; shardLabel?: string } | undefined,
    supplied: ApprovalAttribution | undefined,
    method: string,
  ): ApprovalAttribution | undefined => {
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
    const parentLabel = options.parentLabelProvider?.(owner)?.trim();
    if (!parentLabel) {
      if (shard) {
        throw new Error(
          `Cannot queue ${method}: shard-originated request has no resolvable parent companion label`,
        );
      }
      return undefined;
    }
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
    const request: ConfirmationQueueRequest = attribution
      ? { ...input.request, attribution }
      : input.request;
    let queueEntry: ConfirmationQueueEntry;
    enqueueOwner = input.authenticatedCompanionId;
    try {
      queueEntry = confirmationQueue.enqueue(request, input.execute);
    } finally {
      enqueueOwner = undefined;
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
    ownerOfConfirmation: (id: string) => confirmationOwners.get(id)?.companionId,
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
