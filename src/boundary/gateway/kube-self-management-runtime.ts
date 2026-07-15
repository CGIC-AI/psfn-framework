import type { AuditSummaryEntry } from './audit-port.js';
import {
  KubeSelfManagementController,
  combineKubeSelfManagementExecutors,
  isKubeDnsLabel,
  isKubeSourceRevision,
  isPinnedKubeImageReference,
  type KubeSelfManagementAuditEvent,
  type KubeSelfManagementExecutor,
} from '../../system/lifecycle/kube-self-management.js';
import {
  createKubeDiagnosticsExecutor,
  type KubeReadApiPort,
} from '../../system/lifecycle/kube-diagnostics.js';
import {
  createKubeRolloutRestartExecutor,
  type KubeRolloutApiPort,
} from '../../system/lifecycle/kube-rollout-restart.js';
import {
  createKubeDeployPipelineExecutor,
  type KubeDeployPipelineExecutorOptions,
} from '../../system/lifecycle/kube-deploy-pipeline.js';
import { createInClusterKubernetesReadApi } from './kubernetes-read-api.js';
import { createInClusterKubernetesRolloutApi } from './kubernetes-rollout-api.js';

export interface ResolveKubeSelfManagementControllerOptions {
  env: NodeJS.ProcessEnv;
  audit(entry: AuditSummaryEntry): Promise<unknown>;
  createApi?: (env: NodeJS.ProcessEnv) => KubeReadApiPort;
  createRolloutApi?: (env: NodeJS.ProcessEnv) => KubeRolloutApiPort;
  /**
   * Operator-job composition seam for the guarded build/deploy pipeline. When
   * supplied, the controller additionally dispatches `rebuild`/`deploy` through
   * the pipeline. This carries the operator-job's own build-host transport;
   * the agent runtime never supplies it, keeping the credential separation
   * from x5rt.10 intact (the agent path stays diagnose + restart only).
   */
  deployPipeline?: KubeDeployPipelineExecutorOptions;
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
  const rolloutApi = (options.createRolloutApi ?? createInClusterKubernetesRolloutApi)(options.env);
  // Compose every applicable executor into ONE fail-closed combinator. The
  // diagnostics (read-only, x5rt.5) and rollout-restart (mutating, x5rt.5)
  // executors are always present; the guarded deploy pipeline (x5rt.6) is added
  // only when the operator-job composition supplies its build-host transport,
  // keeping the credential separation from x5rt.10 intact (the agent path stays
  // diagnose + restart only). The action sets never overlap, so the
  // unique-executor guard is transparent here and only fails closed on a
  // misconfigured runtime that wires two executors for the same action.
  const executors: KubeSelfManagementExecutor[] = [
    createKubeDiagnosticsExecutor({
      namespace,
      release,
      resourcePrefix,
      helmRevision,
      sourceRevision,
      targetImage,
      api,
    }),
    createKubeRolloutRestartExecutor({
      namespace,
      release,
      resourcePrefix,
      api: rolloutApi,
    }),
  ];
  if (options.deployPipeline) {
    executors.push(createKubeDeployPipelineExecutor(options.deployPipeline));
  }
  return new KubeSelfManagementController({
    namespace,
    release,
    executor: combineKubeSelfManagementExecutors(executors),
    audit: async event => {
      await options.audit(auditSummary(event));
    },
  });
}
