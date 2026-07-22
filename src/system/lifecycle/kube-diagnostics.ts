import {
  resolveCurrentHelmRevision,
  type KubeHelmRevisionResolver,
} from './kube-helm-revision.js';
import type {
  KubeSelfManagementAction,
  KubeSelfManagementExecutionResult,
  KubeSelfManagementExecutor,
  KubeSelfManagementRequest,
} from './kube-self-management.js';

export interface KubeDeploymentDiagnostic {
  name: string;
  generation: number;
  observedGeneration: number;
  desiredReplicas: number;
  readyReplicas: number;
  updatedReplicas: number;
  availableReplicas: number;
}

export interface KubePodDiagnostic {
  name: string;
  phase: string;
  ready: boolean;
  restartCount: number;
  images: string[];
}

export interface KubeReadApiPort {
  getDeployment(namespace: string, name: string): Promise<KubeDeploymentDiagnostic>;
  listPods(namespace: string, labelSelector: string): Promise<KubePodDiagnostic[]>;
}

export interface KubeDiagnosticsExecutorOptions {
  namespace: string;
  release: string;
  /** Exact Helm fullname prefix used by the three managed Deployments. */
  resourcePrefix: string;
  /**
   * Live Helm revision lookup, invoked per diagnose so the report never repeats a
   * revision frozen at process start (psfn-framework-6187t). Only the
   * Helm-credentialed composition can supply one; where it is absent the report
   * says so explicitly rather than inventing a number.
   */
  resolveHelmRevision?: KubeHelmRevisionResolver;
  sourceRevision: string | null;
  targetImage: string | null;
  api: KubeReadApiPort;
}

/** Explains an absent `helmRevision` in the diagnose report. */
export const HELM_REVISION_UNAVAILABLE_NO_RESOLVER =
  'this runtime has no Helm release-history access; the revision is readable only from the operator job';

export function createKubeDiagnosticsExecutor(
  options: KubeDiagnosticsExecutorOptions,
): KubeSelfManagementExecutor {
  const deploymentNames = ['agent', 'gateway', 'garden']
    .map(component => `${options.resourcePrefix}-${component}`);

  return {
    supports: (action: KubeSelfManagementAction): boolean => action === 'diagnose',
    execute: async (
      request: KubeSelfManagementRequest,
    ): Promise<KubeSelfManagementExecutionResult> => {
      if (request.action !== 'diagnose'
        || request.namespace !== options.namespace
        || request.release !== options.release) {
        throw new Error('Kubernetes diagnostics request is outside the configured release scope.');
      }
      const resolveHelmRevision = options.resolveHelmRevision;
      const [deployments, pods, helmRevision] = await Promise.all([
        Promise.all(deploymentNames.map(name => (
          options.api.getDeployment(options.namespace, name)
        ))),
        options.api.listPods(
          options.namespace,
          `app.kubernetes.io/instance=${options.release}`,
        ),
        // A resolver that fails propagates: diagnose reporting a revision it
        // could not read would be the very fiction this replaced. Absent
        // resolver is a different case — a known, reported gap, not an error.
        resolveHelmRevision
          ? resolveCurrentHelmRevision(resolveHelmRevision, options.namespace, options.release)
          : Promise.resolve(null),
      ]);
      return {
        validationResult: 'not_run',
        rollbackStatus: 'not_requested',
        details: {
          namespace: options.namespace,
          release: options.release,
          helmRevision,
          ...(helmRevision === null
            ? { helmRevisionUnavailable: HELM_REVISION_UNAVAILABLE_NO_RESOLVER }
            : {}),
          sourceRevision: options.sourceRevision,
          targetImage: options.targetImage,
          deployments,
          pods,
        },
      };
    },
  };
}
