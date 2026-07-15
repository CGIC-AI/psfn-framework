import type { AuditSummaryEntry } from './audit-port.js';
import {
  KubeSelfManagementController,
  isKubeDnsLabel,
  isKubeSourceRevision,
  isPinnedKubeImageReference,
  type KubeSelfManagementAuditEvent,
} from '../../system/lifecycle/kube-self-management.js';
import {
  createKubeDiagnosticsExecutor,
  type KubeReadApiPort,
} from '../../system/lifecycle/kube-diagnostics.js';
import { createInClusterKubernetesReadApi } from './kubernetes-read-api.js';

export interface ResolveKubeSelfManagementControllerOptions {
  env: NodeJS.ProcessEnv;
  audit(entry: AuditSummaryEntry): Promise<unknown>;
  createApi?: (env: NodeJS.ProcessEnv) => KubeReadApiPort;
}

function parseEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '' || raw.trim().toLowerCase() === 'false') {
    return false;
  }
  if (raw.trim().toLowerCase() === 'true') return true;
  throw new Error('PSFN_KUBE_SELF_MANAGEMENT_ENABLED must be true or false.');
}

function requirePositiveRevision(raw: string | undefined): number {
  const revision = Number(raw);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new Error('PSFN_HELM_REVISION must be a positive integer for Kubernetes self-management.');
  }
  return revision;
}

function auditSummary(event: KubeSelfManagementAuditEvent): AuditSummaryEntry {
  return {
    method: `kube.self_management.${event.phase}`,
    decision: event.decision,
    params: {
      actor: event.actor,
      requestedAction: event.requestedAction,
      namespace: event.namespace,
      release: event.release,
      validationResult: event.validationResult,
      rollbackStatus: event.rollbackStatus,
      outcome: event.outcome,
      ...(event.sourceRevision ? { sourceRevision: event.sourceRevision } : {}),
      ...(event.targetImage ? { targetImage: event.targetImage } : {}),
      ...(event.helmRevision !== undefined ? { helmRevision: event.helmRevision } : {}),
      ...(event.approvalId ? { approvalId: event.approvalId } : {}),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    },
    durationMs: 0,
  };
}

export function resolveKubeSelfManagementController(
  options: ResolveKubeSelfManagementControllerOptions,
): KubeSelfManagementController | undefined {
  if (!parseEnabled(options.env.PSFN_KUBE_SELF_MANAGEMENT_ENABLED)) {
    return undefined;
  }
  const namespace = options.env.PSFN_HELM_NAMESPACE?.trim() ?? '';
  const release = options.env.PSFN_HELM_RELEASE_NAME?.trim() ?? '';
  const resourcePrefix = options.env.PSFN_KUBE_RESOURCE_PREFIX?.trim() ?? '';
  const sourceRevision = options.env.PSFN_GIT_COMMIT?.trim() ?? '';
  const targetImage = options.env.PSFN_KUBE_CURRENT_IMAGE?.trim() ?? '';
  if (!isKubeDnsLabel(namespace) || !isKubeDnsLabel(release)) {
    throw new Error(
      'PSFN_HELM_NAMESPACE and PSFN_HELM_RELEASE_NAME must be DNS labels for Kubernetes self-management.',
    );
  }
  if (!isKubeDnsLabel(resourcePrefix)) {
    throw new Error('PSFN_KUBE_RESOURCE_PREFIX must be the exact Helm resource prefix for Kubernetes self-management.');
  }
  if (!isKubeSourceRevision(sourceRevision)) {
    throw new Error('PSFN_GIT_COMMIT must be an exact 40-character Git revision for Kubernetes self-management.');
  }
  if (!isPinnedKubeImageReference(targetImage)) {
    throw new Error('PSFN_KUBE_CURRENT_IMAGE must be an exact pinned image reference for Kubernetes self-management.');
  }
  const helmRevision = requirePositiveRevision(options.env.PSFN_HELM_REVISION);
  const api = (options.createApi ?? createInClusterKubernetesReadApi)(options.env);
  return new KubeSelfManagementController({
    namespace,
    release,
    executor: createKubeDiagnosticsExecutor({
      namespace,
      release,
      resourcePrefix,
      helmRevision,
      sourceRevision,
      targetImage,
      api,
    }),
    audit: async event => {
      await options.audit(auditSummary(event));
    },
  });
}
