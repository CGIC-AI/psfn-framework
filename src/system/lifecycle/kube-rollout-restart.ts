// ── Kube rollout-restart executor ──
// Gateway-side executor for the guarded `restart` self-management action. It
// triggers a rollout restart of the three managed Deployments (agent, gateway,
// garden) and waits for each to become ready before reporting success.
//
// This is the mutating counterpart to the read-only diagnostics executor. It
// runs only after the KubeSelfManagementController has approval-gated the
// request (x5rt.4), so this module performs no policy of its own beyond scope
// validation and a bounded readiness wait.

import type { KubeDeploymentDiagnostic } from './kube-diagnostics.js';
import type {
  KubeSelfManagementAction,
  KubeSelfManagementExecutionResult,
  KubeSelfManagementExecutor,
  KubeSelfManagementRequest,
} from './kube-self-management.js';

/** Write surface required to trigger and observe a rollout restart. */
export interface KubeRolloutApiPort {
  /** Patch the Deployment pod template to trigger a rollout restart. */
  restartDeployment(namespace: string, name: string): Promise<void>;
  /** Read Deployment rollout status for the readiness wait. */
  getDeployment(namespace: string, name: string): Promise<KubeDeploymentDiagnostic>;
}

export interface KubeRolloutRestartExecutorOptions {
  namespace: string;
  release: string;
  /** Exact Helm fullname prefix used by the three managed Deployments. */
  resourcePrefix: string;
  api: KubeRolloutApiPort;
  /** Total time to wait for all three Deployments to become ready. */
  waitTimeoutMs?: number;
  /** Delay between readiness polls. */
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_WAIT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;

const MANAGED_COMPONENTS = ['agent', 'gateway', 'garden'] as const;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * A Deployment has completed its rollout when the controller has observed the
 * latest generation and every desired replica is updated, ready, and available.
 */
export function isDeploymentRolloutComplete(deployment: KubeDeploymentDiagnostic): boolean {
  return deployment.desiredReplicas > 0
    && deployment.observedGeneration >= deployment.generation
    && deployment.updatedReplicas === deployment.desiredReplicas
    && deployment.readyReplicas === deployment.desiredReplicas
    && deployment.availableReplicas === deployment.desiredReplicas;
}

export function createKubeRolloutRestartExecutor(
  options: KubeRolloutRestartExecutorOptions,
): KubeSelfManagementExecutor {
  const deploymentNames = MANAGED_COMPONENTS.map(component => `${options.resourcePrefix}-${component}`);
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  async function waitForReadiness(): Promise<KubeDeploymentDiagnostic[]> {
    const deadline = now() + waitTimeoutMs;
    for (;;) {
      const deployments = await Promise.all(
        deploymentNames.map(name => options.api.getDeployment(options.namespace, name)),
      );
      if (deployments.every(isDeploymentRolloutComplete)) {
        return deployments;
      }
      if (now() >= deadline) {
        const pending = deployments
          .filter(deployment => !isDeploymentRolloutComplete(deployment))
          .map(deployment => (
            `${deployment.name} (ready ${deployment.readyReplicas}/${deployment.desiredReplicas},`
            + ` updated ${deployment.updatedReplicas}/${deployment.desiredReplicas},`
            + ` observedGeneration ${deployment.observedGeneration}/${deployment.generation})`
          ))
          .join('; ');
        throw new Error(
          `Kubernetes rollout restart did not become ready within ${waitTimeoutMs}ms: ${pending}`,
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  return {
    supports: (action: KubeSelfManagementAction): boolean => action === 'restart',
    execute: async (
      request: KubeSelfManagementRequest,
    ): Promise<KubeSelfManagementExecutionResult> => {
      if (request.action !== 'restart'
        || request.namespace !== options.namespace
        || request.release !== options.release) {
        throw new Error('Kubernetes rollout restart request is outside the configured release scope.');
      }
      // Trigger the restart for every managed Deployment before waiting, so all
      // three roll in parallel rather than serially.
      for (const name of deploymentNames) {
        await options.api.restartDeployment(options.namespace, name);
      }
      const deployments = await waitForReadiness();
      return {
        validationResult: 'passed',
        rollbackStatus: 'not_requested',
        details: {
          namespace: options.namespace,
          release: options.release,
          restartedDeployments: deploymentNames,
          deployments,
        },
      };
    },
  };
}
