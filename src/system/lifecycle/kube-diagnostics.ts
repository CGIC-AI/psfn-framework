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
  helmRevision: number | null;
  sourceRevision: string | null;
  targetImage: string | null;
  api: KubeReadApiPort;
}

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
      const [deployments, pods] = await Promise.all([
        Promise.all(deploymentNames.map(name => (
          options.api.getDeployment(options.namespace, name)
        ))),
        options.api.listPods(
          options.namespace,
          `app.kubernetes.io/instance=${options.release}`,
        ),
      ]);
      return {
        validationResult: 'not_run',
        rollbackStatus: 'not_requested',
        details: {
          namespace: options.namespace,
          release: options.release,
          helmRevision: options.helmRevision,
          sourceRevision: options.sourceRevision,
          targetImage: options.targetImage,
          deployments,
          pods,
        },
      };
    },
  };
}
