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
import {
  defaultSleep,
  waitForDeploymentsReady,
} from './kube-readiness-wait.js';
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
  waitTimeoutMs: number;
  /** Delay between readiness polls. */
  pollIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const MANAGED_COMPONENTS = ['agent', 'gateway', 'garden'] as const;

export { isDeploymentRolloutComplete } from './kube-readiness-wait.js';

export function createKubeRolloutRestartExecutor(
  options: KubeRolloutRestartExecutorOptions,
): KubeSelfManagementExecutor {
  const deploymentNames = MANAGED_COMPONENTS.map(component => `${options.resourcePrefix}-${component}`);
  const waitTimeoutMs = options.waitTimeoutMs;
  const pollIntervalMs = options.pollIntervalMs;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

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
      const wait = await waitForDeploymentsReady({
        namespace: options.namespace,
        deploymentNames,
        api: options.api,
        waitTimeoutMs,
        pollIntervalMs,
        now,
        sleep,
      });
      if (!wait.ready) {
        throw new Error(
          `Kubernetes rollout restart did not become ready within ${waitTimeoutMs}ms: ${wait.pending}`,
        );
      }
      return {
        validationResult: 'passed',
        rollbackStatus: 'not_requested',
        details: {
          namespace: options.namespace,
          release: options.release,
          restartedDeployments: deploymentNames,
          deployments: wait.deployments,
        },
      };
    },
  };
}
