import { isRecord } from '../../shared/utils/types.js';
import type {
  ConfirmationExecutionContext,
  ConfirmationQueueEntry,
  ConfirmationQueueRequest,
} from '../capabilities/confirmation-queue.js';
import { ConfirmationExecutionCommittedError } from '../capabilities/confirmation-queue.js';

export const KUBE_SELF_MANAGEMENT_ACTIONS = [
  'diagnose',
  'validate',
  'restart',
  'rebuild',
  'deploy',
  'rollback',
] as const;

export type KubeSelfManagementAction = typeof KUBE_SELF_MANAGEMENT_ACTIONS[number];

export interface KubeSelfManagementExecutionResult {
  validationResult: 'passed' | 'failed' | 'not_run';
  rollbackStatus: 'succeeded' | 'failed' | 'not_requested';
  details?: Record<string, unknown>;
}

export interface KubeSelfManagementExecutor {
  supports(action: KubeSelfManagementAction): boolean;
  execute(request: KubeSelfManagementRequest): Promise<KubeSelfManagementExecutionResult>;
}

export interface KubeSelfManagementApprovalQueue {
  enqueue(
    request: ConfirmationQueueRequest,
    execute: (
      params: Record<string, unknown>,
      entry: ConfirmationQueueEntry,
      context: ConfirmationExecutionContext,
    ) => Promise<unknown>,
  ): Promise<ConfirmationQueueEntry>;
}

export interface KubeSelfManagementAuditEvent {
  phase: 'attempt' | 'result';
  actor: string;
  requestedAction: KubeSelfManagementAction | 'invalid';
  namespace: string;
  release: string;
  decision: 'ALLOW' | 'DENY' | 'NEEDS_APPROVAL';
  validationResult: 'passed' | 'failed' | 'not_run';
  rollbackStatus: 'succeeded' | 'failed' | 'not_requested';
  outcome: 'pending' | 'succeeded' | 'failed';
  sourceRevision?: string;
  targetImage?: string;
  helmRevision?: number;
  approvalId?: string;
  errorCode?: string;
  resolverKind?: 'operator';
  resolverId?: string;
}

export type KubeSelfManagementReadAction = 'diagnose' | 'validate';
export type KubeSelfManagementMutationAction = Exclude<
  KubeSelfManagementAction,
  KubeSelfManagementReadAction
>;

export interface KubeSelfManagementReadRequest {
  action: KubeSelfManagementReadAction;
  namespace: string;
  release: string;
}

export interface KubeSelfManagementMutationRequest {
  action: KubeSelfManagementMutationAction;
  namespace: string;
  release: string;
  sourceRevision: string;
  targetImage: string;
  helmRevision: number;
  reason: string;
}

export type KubeSelfManagementRequest =
  | KubeSelfManagementReadRequest
  | KubeSelfManagementMutationRequest;

export type KubeSelfManagementResponse =
  | ({ status: 'completed' } & KubeSelfManagementExecutionResult)
  | {
    status: 'approval_required';
    approvalId: string;
    expiresAt: number;
  };

export interface KubeSelfManagementControllerOptions {
  namespace: string;
  release: string;
  executor: KubeSelfManagementExecutor;
  audit(event: KubeSelfManagementAuditEvent): Promise<void>;
}

export interface KubeSelfManagementInvocation {
  actor: string;
  params: unknown;
  approvals: KubeSelfManagementApprovalQueue;
}

function isKubeSelfManagementAction(value: unknown): value is KubeSelfManagementAction {
  return typeof value === 'string'
    && KUBE_SELF_MANAGEMENT_ACTIONS.some(action => action === value);
}

function isReadOnlyAction(action: KubeSelfManagementAction): boolean {
  return action === 'diagnose' || action === 'validate';
}

function isMutationRequest(
  request: KubeSelfManagementRequest,
): request is KubeSelfManagementMutationRequest {
  return !isReadOnlyAction(request.action);
}

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const ACTOR_PATTERN = /^[A-Za-z0-9][-A-Za-z0-9._:]{0,127}$/;
const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const IMAGE_REPOSITORY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\:[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const IMAGE_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const FLOATING_IMAGE_TAGS = new Set(['latest', 'main', 'main-latest']);

export function isKubeDnsLabel(value: unknown): value is string {
  return typeof value === 'string' && DNS_LABEL_PATTERN.test(value);
}

function isActor(value: unknown): value is string {
  return typeof value === 'string' && ACTOR_PATTERN.test(value);
}

export function isKubeSourceRevision(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_REVISION_PATTERN.test(value);
}

export function isPinnedKubeImageReference(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  if (value.includes('://') || /\s/.test(value)) return false;
  const atSeparator = value.indexOf('@');
  if (atSeparator !== value.lastIndexOf('@')) return false;
  const hasDigest = atSeparator >= 0;
  const nameAndTag = hasDigest ? value.slice(0, atSeparator) : value;
  const digest = hasDigest ? value.slice(atSeparator + 1) : '';
  if (hasDigest && !IMAGE_DIGEST_PATTERN.test(digest)) return false;
  const lastSlash = nameAndTag.lastIndexOf('/');
  const lastColon = nameAndTag.lastIndexOf(':');
  const hasTag = lastColon > lastSlash;
  const repository = hasTag ? nameAndTag.slice(0, lastColon) : nameAndTag;
  const tag = hasTag ? nameAndTag.slice(lastColon + 1) : undefined;
  if (!IMAGE_REPOSITORY_PATTERN.test(repository)) return false;
  if (tag !== undefined && (!IMAGE_TAG_PATTERN.test(tag) || FLOATING_IMAGE_TAGS.has(tag.toLowerCase()))) {
    return false;
  }
  return tag !== undefined || hasDigest;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every(key => allowedSet.has(key));
}

function parseRequest(value: unknown): KubeSelfManagementRequest | null {
  if (!isRecord(value)
    || !isKubeSelfManagementAction(value.action)
    || !isKubeDnsLabel(value.namespace)
    || !isKubeDnsLabel(value.release)) {
    return null;
  }
  if (isReadOnlyAction(value.action)) {
    if (!hasOnlyKeys(value, ['action', 'namespace', 'release'])) return null;
    return {
      action: value.action as KubeSelfManagementReadAction,
      namespace: value.namespace,
      release: value.release,
    };
  }
  if (!hasOnlyKeys(value, [
    'action',
    'namespace',
    'release',
    'sourceRevision',
    'targetImage',
    'helmRevision',
    'reason',
  ])) return null;
  if (!isKubeSourceRevision(value.sourceRevision)
    || !isPinnedKubeImageReference(value.targetImage)
    || typeof value.helmRevision !== 'number'
    || !Number.isSafeInteger(value.helmRevision)
    || value.helmRevision <= 0
    || typeof value.reason !== 'string'
    || value.reason.trim().length === 0
    || value.reason.trim().length > 500
    || /[\u0000-\u001f\u007f]/.test(value.reason)) {
    return null;
  }
  return {
    action: value.action as KubeSelfManagementMutationAction,
    namespace: value.namespace,
    release: value.release,
    sourceRevision: value.sourceRevision,
    targetImage: value.targetImage,
    helmRevision: value.helmRevision,
    reason: value.reason.trim(),
  };
}

export function summarizeKubeSelfManagementParams(
  value: unknown,
): Record<string, unknown> {
  const request = parseRequest(value);
  if (!request) return { invalidRequest: true };
  return {
    requestedAction: request.action,
    namespace: request.namespace,
    release: request.release,
    ...(isMutationRequest(request) ? {
      sourceRevision: request.sourceRevision,
      targetImage: request.targetImage,
      helmRevision: request.helmRevision,
    } : {}),
  };
}

function bindingParams(request: KubeSelfManagementMutationRequest): Record<string, unknown> {
  return {
    action: request.action,
    namespace: request.namespace,
    release: request.release,
    sourceRevision: request.sourceRevision,
    targetImage: request.targetImage,
    helmRevision: request.helmRevision,
  };
}

function bindingsMatch(
  expected: KubeSelfManagementMutationRequest,
  actual: KubeSelfManagementMutationRequest,
): boolean {
  return expected.action === actual.action
    && expected.namespace === actual.namespace
    && expected.release === actual.release
    && expected.sourceRevision === actual.sourceRevision
    && expected.targetImage === actual.targetImage
    && expected.helmRevision === actual.helmRevision;
}

function invalidAuditEvent(actor: string): KubeSelfManagementAuditEvent {
  return {
    phase: 'attempt',
    actor: isActor(actor) ? actor : '(invalid)',
    requestedAction: 'invalid',
    namespace: '(invalid)',
    release: '(invalid)',
    decision: 'DENY',
    validationResult: 'not_run',
    rollbackStatus: 'not_requested',
    outcome: 'failed',
    errorCode: 'invalid_request',
  };
}

function requestAuditEvent(
  actor: string,
  request: KubeSelfManagementRequest,
  overrides: Partial<KubeSelfManagementAuditEvent>,
): KubeSelfManagementAuditEvent {
  return {
    phase: 'attempt',
    actor,
    requestedAction: request.action,
    namespace: request.namespace,
    release: request.release,
    decision: 'DENY',
    validationResult: 'not_run',
    rollbackStatus: 'not_requested',
    outcome: 'failed',
    ...(isMutationRequest(request) ? {
      sourceRevision: request.sourceRevision,
      targetImage: request.targetImage,
      helmRevision: request.helmRevision,
    } : {}),
    ...overrides,
  };
}

export class KubeSelfManagementController {
  constructor(private readonly options: KubeSelfManagementControllerOptions) {
    if (!isKubeDnsLabel(options.namespace) || !isKubeDnsLabel(options.release)) {
      throw new Error('Kubernetes self-management scope must use DNS-label namespace and release names.');
    }
  }

  async invoke(input: KubeSelfManagementInvocation): Promise<KubeSelfManagementResponse> {
    if (!isRecord(input.params) || !isKubeSelfManagementAction(input.params.action)) {
      await this.options.audit(invalidAuditEvent(input.actor));
      throw new Error('Unsupported Kubernetes self-management action.');
    }
    const request = parseRequest(input.params);
    if (!isActor(input.actor) || !request) {
      await this.options.audit(invalidAuditEvent(input.actor));
      throw new Error('Invalid Kubernetes self-management request.');
    }
    if (request.namespace !== this.options.namespace || request.release !== this.options.release) {
      await this.options.audit(requestAuditEvent(input.actor, request, {
        errorCode: 'scope_mismatch',
      }));
      throw new Error('Kubernetes self-management request is outside the configured Kubernetes release scope.');
    }
    if (!this.options.executor.supports(request.action)) {
      await this.options.audit(requestAuditEvent(input.actor, request, {
        errorCode: 'unsupported_action',
      }));
      throw new Error('Kubernetes self-management action is not configured in this runtime.');
    }
    if (isReadOnlyAction(request.action)) {
      return await this.executeApproved(input.actor, request);
    }
    if (!isMutationRequest(request)) {
      throw new Error('Kubernetes self-management action is not configured in this runtime.');
    }
    await this.options.audit(requestAuditEvent(input.actor, request, {
      decision: 'NEEDS_APPROVAL',
      outcome: 'pending',
    }));
    let approval: ConfirmationQueueEntry;
    try {
      approval = await input.approvals.enqueue({
        method: 'kube.self_management',
        action: request.action,
        scope: `${request.namespace}/${request.release}`,
        params: bindingParams(request),
        companionReason: request.reason,
        resolutionAuthority: 'operator',
      }, async (approvedParams, entry, context) => {
        const resolver = context.resolver;
        if (resolver?.kind !== 'operator') {
          await this.options.audit(requestAuditEvent(input.actor, request, {
            phase: 'result',
            decision: 'DENY',
            outcome: 'failed',
            approvalId: entry.id,
            errorCode: 'operator_resolution_required',
          }));
          throw new Error('Kubernetes self-management requires an authenticated operator resolution.');
        }
        const approvedRequest = parseRequest({
          ...approvedParams,
          reason: request.reason,
        });
        if (!approvedRequest
          || !isMutationRequest(approvedRequest)
          || !bindingsMatch(request, approvedRequest)) {
          await this.options.audit(requestAuditEvent(input.actor, request, {
            phase: 'result',
            decision: 'DENY',
            outcome: 'failed',
            approvalId: entry.id,
            errorCode: 'approval_mismatch',
            resolverKind: 'operator',
            resolverId: resolver.id,
          }));
          throw new Error('Kubernetes self-management approval does not match the queued action.');
        }
        await this.executeApproved(input.actor, approvedRequest, entry.id, resolver.id);
      });
    } catch {
      await this.options.audit(requestAuditEvent(input.actor, request, {
        phase: 'result',
        decision: 'DENY',
        outcome: 'failed',
        errorCode: 'approval_enqueue_failed',
      }));
      throw new Error('Kubernetes self-management approval could not be queued.');
    }
    await this.options.audit(requestAuditEvent(input.actor, request, {
      phase: 'result',
      decision: 'NEEDS_APPROVAL',
      outcome: 'pending',
      approvalId: approval.id,
    }));
    return {
      status: 'approval_required',
      approvalId: approval.id,
      expiresAt: approval.expiresAt,
    };
  }

  private async executeApproved(
    actor: string,
    request: KubeSelfManagementRequest,
    approvalId?: string,
    resolverId?: string,
  ): Promise<KubeSelfManagementResponse> {
    await this.options.audit(requestAuditEvent(actor, request, {
      decision: 'ALLOW',
      outcome: 'pending',
      ...(approvalId ? { approvalId } : {}),
      ...(resolverId ? { resolverKind: 'operator', resolverId } : {}),
    }));
    let result: KubeSelfManagementExecutionResult;
    try {
      result = await this.options.executor.execute(request);
    } catch (executionError) {
      try {
        await this.options.audit(requestAuditEvent(actor, request, {
          phase: 'result',
          decision: 'DENY',
          validationResult: 'failed',
          outcome: 'failed',
          errorCode: 'execution_failed',
          ...(approvalId ? { approvalId } : {}),
          ...(resolverId ? { resolverKind: 'operator', resolverId } : {}),
        }));
      } catch (auditError) {
        throw new AggregateError(
          [executionError, auditError],
          'Kubernetes self-management execution and failure audit failed.',
        );
      }
      throw new Error('Kubernetes self-management execution failed.', { cause: executionError });
    }

    try {
      await this.options.audit(requestAuditEvent(actor, request, {
        phase: 'result',
        decision: 'ALLOW',
        validationResult: result.validationResult,
        rollbackStatus: result.rollbackStatus,
        outcome: 'succeeded',
        ...(approvalId ? { approvalId } : {}),
        ...(resolverId ? { resolverKind: 'operator', resolverId } : {}),
      }));
    } catch (auditError) {
      if (isMutationRequest(request)) {
        throw new ConfirmationExecutionCommittedError(
          'Kubernetes self-management action executed, but result audit failed; do not retry.',
          { cause: auditError },
        );
      }
      throw new Error('Kubernetes self-management result audit failed.', { cause: auditError });
    }

    return {
      status: 'completed',
      ...result,
    };
  }
}
