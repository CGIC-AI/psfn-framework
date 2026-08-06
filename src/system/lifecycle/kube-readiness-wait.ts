import type { KubeDeploymentDiagnostic } from './kube-diagnostics.js';

export interface KubeReadinessWaitOptions {
  namespace: string;
  deploymentNames: readonly string[];
  api: {
    getDeployment(namespace: string, name: string): Promise<KubeDeploymentDiagnostic>;
  };
  waitTimeoutMs: number;
  pollIntervalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export type KubeReadinessWaitResult =
  | { ready: true; deployments: KubeDeploymentDiagnostic[] }
  | { ready: false; pending: string };

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * A Deployment has completed its rollout when the controller has observed the
 * latest generation and every desired replica is updated, ready, and available.
 */
export function isDeploymentRolloutComplete(
  deployment: KubeDeploymentDiagnostic,
): boolean {
  return deployment.desiredReplicas > 0
    && deployment.observedGeneration >= deployment.generation
    && deployment.updatedReplicas === deployment.desiredReplicas
    && deployment.readyReplicas === deployment.desiredReplicas
    && deployment.availableReplicas === deployment.desiredReplicas;
}

function describePending(deployments: readonly KubeDeploymentDiagnostic[]): string {
  return deployments
    .filter(deployment => !isDeploymentRolloutComplete(deployment))
    .map(deployment => (
      `${deployment.name} (ready ${deployment.readyReplicas}/${deployment.desiredReplicas},`
      + ` updated ${deployment.updatedReplicas}/${deployment.desiredReplicas},`
      + ` observedGeneration ${deployment.observedGeneration}/${deployment.generation})`
    ))
    .join('; ');
}

export async function waitForDeploymentsReady(
  options: KubeReadinessWaitOptions,
): Promise<KubeReadinessWaitResult> {
  const deadline = options.now() + options.waitTimeoutMs;
  for (;;) {
    const deployments = await Promise.all(
      options.deploymentNames.map(name => options.api.getDeployment(options.namespace, name)),
    );
    if (deployments.every(isDeploymentRolloutComplete)) {
      return { ready: true, deployments };
    }
    if (options.now() >= deadline) {
      return { ready: false, pending: describePending(deployments) };
    }
    await options.sleep(options.pollIntervalMs);
  }
}
