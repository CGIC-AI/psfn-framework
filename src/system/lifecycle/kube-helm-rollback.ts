// ── Kube Helm rollback executor (manual path) ──
//
// Gateway/operator-side executor for the guarded `rollback` self-management
// action. It runs `helm rollback <release> <targetRevision>` and waits for the
// three managed Deployments (agent, gateway, garden) to come back ready before
// reporting success — the manual counterpart to the x5rt.5 rollout-restart
// executor.
//
// Credential separation (x5rt.10): like the deploy pipeline, this executor holds
// the operator-job's Helm transport and is therefore composed ONLY in the
// operator-job composition, never on the agent-only path (which stays diagnose +
// restart). The companion may *request* a rollback (the action exists in the
// enum), an operator approves it through the x5rt.4 boundary, and only then does
// this executor enact it with the job's credentials.
//
// Fail-closed: the request must match the configured release scope, the Helm
// rollback command errors propagate (audited as an execution failure), and a
// release that does not come back ready is a FAILED rollback that escalates
// (rollbackStatus 'failed') rather than a silent success.

import type { KubeDeploymentDiagnostic } from './kube-diagnostics.js';
import { isDeploymentRolloutComplete } from './kube-rollout-restart.js';
import type {
  KubeSelfManagementAction,
  KubeSelfManagementExecutionResult,
  KubeSelfManagementExecutor,
  KubeSelfManagementRequest,
} from './kube-self-management.js';
import type { KubeRollbackRecord } from './kube-rollback-store.js';

/** Write surface required to enact a Helm rollback and observe recovery. */
export interface KubeHelmRollbackApiPort {
  /**
   * Perform `helm rollback <release> <targetRevision> --wait` in the namespace
   * and return the NEW Helm revision the rollback created (Helm records a
   * rollback as a fresh revision whose content is the target revision's).
   */
  rollback(
    namespace: string,
    release: string,
    targetRevision: number,
  ): Promise<{ helmRevision: number }>;
  /** Read Deployment rollout status for the post-rollback readiness wait. */
  getDeployment(namespace: string, name: string): Promise<KubeDeploymentDiagnostic>;
}

/** The three Deployments a rollback must bring back to ready. */
export const MANAGED_ROLLBACK_COMPONENTS = ['agent', 'gateway', 'garden'] as const;

export interface KubeReadinessWaitOptions {
  namespace: string;
  deploymentNames: readonly string[];
  api: Pick<KubeHelmRollbackApiPort, 'getDeployment'>;
  waitTimeoutMs: number;
  pollIntervalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export type KubeReadinessWaitResult =
  | { ready: true; deployments: KubeDeploymentDiagnostic[] }
  | { ready: false; pending: string };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
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

/**
 * Poll the managed Deployments until all report a complete rollout or the
 * deadline passes. Returns a discriminated result instead of throwing so the
 * caller can turn "did not converge" into an explicit FAILED rollback escalation
 * (the rollback command ran, the release did not recover). Probe errors from the
 * API still propagate — an unreadable cluster is not proof of readiness.
 */
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

export interface KubeHelmRollbackExecutorOptions {
  namespace: string;
  release: string;
  /** Exact Helm fullname prefix used by the three managed Deployments. */
  resourcePrefix: string;
  api: KubeHelmRollbackApiPort;
  /** Total time to wait for the three Deployments to become ready after rollback. */
  waitTimeoutMs: number;
  /** Delay between readiness polls. */
  pollIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional durable rollback ledger writer, supplied by the operator-job
   * composition (which owns `systemDataDir`). Records the manual rollback for
   * provenance and to inform the automatic surface's act-once ledger. Never
   * supplied on the agent path.
   */
  recordRollback?: (record: KubeRollbackRecord) => void;
}

/** Resolve the three managed Deployment names for a resource prefix. */
export function managedRollbackDeploymentNames(resourcePrefix: string): string[] {
  return MANAGED_ROLLBACK_COMPONENTS.map(component => `${resourcePrefix}-${component}`);
}

/**
 * Build the manual `rollback` executor. Mirrors the rollout-restart executor:
 * injected API port, no policy of its own beyond scope validation and a bounded
 * readiness wait (the x5rt.4 controller already approval-gated the request).
 */
export function createKubeHelmRollbackExecutor(
  options: KubeHelmRollbackExecutorOptions,
): KubeSelfManagementExecutor {
  const deploymentNames = managedRollbackDeploymentNames(options.resourcePrefix);
  const waitTimeoutMs = options.waitTimeoutMs;
  const pollIntervalMs = options.pollIntervalMs;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  return {
    supports: (action: KubeSelfManagementAction): boolean => action === 'rollback',
    execute: async (
      request: KubeSelfManagementRequest,
    ): Promise<KubeSelfManagementExecutionResult> => {
      if (request.action !== 'rollback'
        || request.namespace !== options.namespace
        || request.release !== options.release) {
        throw new Error('Kubernetes Helm rollback request is outside the configured release scope.');
      }
      // Mutation requests carry the target revision to roll back TO.
      const targetRevision = request.helmRevision;
      const startedAt = now();

      // A failing Helm rollback COMMAND propagates: the controller audits it as
      // an execution failure. A rollback that runs but does not recover the
      // release is a FAILED rollback escalation (below), not a throw.
      const rollbackResult = await options.api.rollback(
        options.namespace,
        options.release,
        targetRevision,
      );
      if (!Number.isSafeInteger(rollbackResult.helmRevision) || rollbackResult.helmRevision <= 0) {
        throw new Error('Kubernetes Helm rollback returned an invalid resulting release revision.');
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

      const baseRecord = {
        schemaVersion: 1 as const,
        namespace: options.namespace,
        release: options.release,
        trigger: 'manual' as const,
        targetHelmRevision: targetRevision,
        resultingHelmRevision: rollbackResult.helmRevision,
        reason: request.reason,
        startedAt,
      };

      if (!wait.ready) {
        const detail = `rollback did not recover the release within ${waitTimeoutMs}ms: ${wait.pending}`;
        options.recordRollback?.({
          ...baseRecord,
          validationResult: 'failed',
          outcome: 'failed',
          completedAt: now(),
          detail,
        });
        return {
          validationResult: 'failed',
          rollbackStatus: 'failed',
          details: {
            namespace: options.namespace,
            release: options.release,
            targetHelmRevision: targetRevision,
            resultingHelmRevision: rollbackResult.helmRevision,
            rolledBackDeployments: deploymentNames,
            escalation: detail,
          },
        };
      }

      options.recordRollback?.({
        ...baseRecord,
        validationResult: 'passed',
        outcome: 'succeeded',
        completedAt: now(),
      });
      return {
        validationResult: 'passed',
        rollbackStatus: 'succeeded',
        details: {
          namespace: options.namespace,
          release: options.release,
          targetHelmRevision: targetRevision,
          resultingHelmRevision: rollbackResult.helmRevision,
          rolledBackDeployments: deploymentNames,
          deployments: wait.deployments,
        },
      };
    },
  };
}
