import { JSONRPCErrorException } from 'json-rpc-2.0';
import type { CapabilityTier } from '../../system/config/runtime-config-contracts.js';
import type { ChannelOutboundDock } from '../../channels/backplane/types.js';
import type { EventBus } from '../../shared/event-bus.js';
import type {
  ConfirmationQueueEntry,
  ConfirmationQueueHistoryEntry,
} from '../../system/capabilities/confirmation-queue.js';
import {
  ConfirmationQueue,
  DEFAULT_CONFIRMATION_EXPIRY_MS,
} from '../../system/capabilities/confirmation-queue.js';
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
  capabilityTierProvider: () => CapabilityTier;
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
  approvalAction: string;
  approvalScope: (params: P) => string;
  approvalReason?: (params: P) => string;
}

export interface ApprovalBoundaryService {
  listPendingConfirmations(): ConfirmationQueueEntry[];
  listConfirmationHistory(): ConfirmationQueueHistoryEntry[];
  resolveConfirmation(params: { id: string; decision: 'approve' | 'deny' | 'modify'; modifiedParams?: Record<string, unknown> }): Promise<{
    id: string;
    status: 'approved' | 'denied' | 'modified' | 'expired' | 'failed' | 'not_found';
    message: string;
    executed: boolean;
  }>;
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
        options.eventBus.emit('companion.approval.requested', {
          payload: redactApprovalRequested(entry),
          timestamp: Date.now(),
        }).catch((error) => {
          approvalLog.error('Failed to emit companion.approval.requested', {
            id: entry.id,
            error: toErrorMessage(error),
          });
        });
      },
      onResolved: (outcome) => {
        options.eventBus.emit('companion.approval.resolved', {
          payload: redactApprovalResolved({
            id: outcome.id,
            status: outcome.status,
            resolvedAt: outcome.resolvedAt,
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

  return {
    listPendingConfirmations: () => confirmationQueue.listPending(),
    listConfirmationHistory: () => confirmationQueue.listHistory(),
    resolveConfirmation: (params) => confirmationQueue.resolve(params),
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
          options.policyConfig,
        );
        const summary = gateOptions.paramsSummary(params);
        const auditId = await options.audit(gateOptions.method, decision, summary);
        const startTime = Date.now();

        try {
          if (decision === 'DENY') {
            throw new JSONRPCErrorException('Policy denied', GatewayErrors.POLICY_DENIED);
          }

          if (decision === 'NEEDS_APPROVAL' && options.capabilityTierProvider() !== 'autonomous') {
            const paramsRecord = params as unknown as Record<string, unknown>;
            const queueEntry = confirmationQueue.enqueue(
              {
                method: gateOptions.method,
                action: gateOptions.approvalAction,
                scope: gateOptions.approvalScope(params),
                params: paramsRecord,
                companionReason: resolveCompanionReason(
                  paramsRecord,
                  gateOptions.approvalReason?.(params) ?? 'Outside workspace',
                ),
                expiresInMs: confirmationConfig.expiryMs,
              },
              async (approvedParams, entry) => executeQueuedAction({
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
            );
            await notifyOperatorForPendingAction({
              entry: queueEntry,
              discordAdapter: options.discordAdapter,
              operatorDiscordChannelId: confirmationConfig.operatorDiscordChannelId,
              ntfyTopic: confirmationConfig.ntfyTopic,
              ntfyNotifier: options.ntfyNotifier,
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
