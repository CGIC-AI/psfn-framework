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
import {
  createKubeHelmRollbackExecutor,
  type KubeHelmRollbackApiPort,
} from '../../system/lifecycle/kube-helm-rollback.js';
import type { KubeRollbackRecord } from '../../system/lifecycle/kube-rollback-store.js';
import { createInClusterKubernetesReadApi } from './kubernetes-read-api.js';
import { createInClusterKubernetesRolloutApi } from './kubernetes-rollout-api.js';
import type { LifecycleKubernetesSettings } from '../../system/config/runtime-config-contracts.js';
import { requireLifecycleKubernetesSettings } from '../../system/lifecycle/lifecycle-kubernetes-settings.js';

export interface ResolveKubeSelfManagementControllerOptions {
  env: NodeJS.ProcessEnv;
  lifecycleKubernetes?: LifecycleKubernetesSettings;
  audit(entry: AuditSummaryEntry): Promise<unknown>;
  createApi?: (env: NodeJS.ProcessEnv, requestTimeoutMs: number) => KubeReadApiPort;
  createRolloutApi?: (
    env: NodeJS.ProcessEnv,
    readRequestTimeoutMs: number,
    rolloutRequestTimeoutMs: number,
  ) => KubeRolloutApiPort;
  /**
   * Operator-job composition seam for the guarded build/deploy pipeline. When
   * supplied, the controller additionally dispatches `rebuild`/`deploy` through
   * the pipeline. This carries the operator-job's own build-host transport;
   * the agent runtime never supplies it, keeping the credential separation
   * from x5rt.10 intact (the agent path stays diagnose + restart only).
   */
  deployPipeline?: KubeDeployPipelineExecutorOptions;
  /**
   * Operator-job composition seam for the guarded manual `rollback` action. Like
   * the deploy pipeline this carries the operator-job's own Helm transport (helm
   * rollback needs full release-management credentials, unlike the RBAC-scoped
   * rollout restart), so it is composed ONLY here and never on the agent-only
   * path. The companion may request a rollback; an operator approves it; only
   * then does this executor enact it with the job's credentials.
   */
  helmRollback?: {
    /** Operator-job Helm rollback transport (holds release-management credentials). */
    api: KubeHelmRollbackApiPort;
    recordRollback?: (record: KubeRollbackRecord) => void;
  };
}

function parseEnabled(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '' || raw.trim().toLowerCase() === 'false') {
    return false;
  }
  if (raw.trim().toLowerCase() === 'true') return true;
  throw new Error('PSFN_KUBE_SELF_MANAGEMENT_ENABLED must be true or false.');
}

function auditSummary(event: KubeSelfManagementAuditEvent): AuditSummaryEntry {
  return {
    method: `kube.self_management.${event.phase}`,
    // Kube self-management events still use the legacy NEEDS_APPROVAL literal;
    // they always enqueue to the operator approval queue, so translate to the
    // current GatewayPolicyDecision vocabulary at the audit seam.
    decision: event.decision === 'NEEDS_APPROVAL' ? 'REQUIRES_HUMAN_APPROVAL' : event.decision,
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
  const settings = requireLifecycleKubernetesSettings(options);
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
  // The live Helm revision is readable only through a Helm release-history
  // transport, which the operator-job composition owns. Where it is supplied the
  // diagnostics executor resolves the revision per call; where it is not, the
  // report says the revision is unavailable rather than echoing a start-time
  // constant that goes stale on the next upgrade (psfn-framework-6187t).
  const helmRollbackApi = options.helmRollback?.api;
  const api = options.createApi
    ? options.createApi(options.env, settings.kubernetesReadRequestTimeoutMs)
    : createInClusterKubernetesReadApi(options.env, {
      requestTimeoutMs: settings.kubernetesReadRequestTimeoutMs,
    });
  const rolloutApi = options.createRolloutApi
    ? options.createRolloutApi(
      options.env,
      settings.kubernetesReadRequestTimeoutMs,
      settings.kubernetesRolloutRequestTimeoutMs,
    )
    : createInClusterKubernetesRolloutApi(options.env, {
      requestTimeoutMs: settings.kubernetesReadRequestTimeoutMs,
      rolloutRequestTimeoutMs: settings.kubernetesRolloutRequestTimeoutMs,
    });
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
      ...(helmRollbackApi
        ? {
          resolveHelmRevision: (ns: string, rel: string) => helmRollbackApi.currentRevision(ns, rel),
        }
        : {}),
      sourceRevision,
      targetImage,
      api,
    }),
    createKubeRolloutRestartExecutor({
      namespace,
      release,
      resourcePrefix,
      api: rolloutApi,
      waitTimeoutMs: settings.rolloutWaitTimeoutMs,
      pollIntervalMs: settings.rolloutPollIntervalMs,
    }),
  ];
  if (options.deployPipeline) {
    executors.push(createKubeDeployPipelineExecutor(options.deployPipeline));
  }
  if (options.helmRollback) {
    executors.push(createKubeHelmRollbackExecutor({
      namespace,
      release,
      resourcePrefix,
      api: options.helmRollback.api,
      ...(options.helmRollback.recordRollback
        ? { recordRollback: options.helmRollback.recordRollback }
        : {}),
      waitTimeoutMs: settings.rollbackWaitTimeoutMs,
      pollIntervalMs: settings.rollbackPollIntervalMs,
    }));
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
