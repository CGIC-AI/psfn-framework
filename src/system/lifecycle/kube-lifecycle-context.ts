// ── Agent-side kube lifecycle context ──
// Resolves whether the companion runtime is running under a guarded Kubernetes
// deployment and, if so, the exact facts needed to route lifecycle actions
// (restart) through the gateway's approval-gated KubeSelfManagementController.
//
// Fail-closed rules (x5rt.5):
//   - A pod running under Kubernetes (KUBERNETES_SERVICE_HOST present) must never
//     fall back to the local reexec/supervisor restart path. Either guarded kube
//     self-management is available, or lifecycle mutation refuses loudly.
//   - When kube self-management is declared enabled but its deployment facts are
//     missing or malformed, resolution throws so composition fails closed rather
//     than silently degrading.

import {
  isKubeDnsLabel,
  isKubeSourceRevision,
  isPinnedKubeImageReference,
} from './kube-self-management.js';

// The live Helm revision is deliberately NOT a fact here. It is a property of
// the release, not of this process: a pod only ever knows the revision it was
// created at, so freezing it at startup made it stale the moment the release
// moved on (psfn-framework-6187t). Surfaces that need it read it live from the
// gateway's diagnose report.
export interface KubeLifecycleSelfManagementFacts {
  namespace: string;
  release: string;
  sourceRevision: string;
  targetImage: string;
}

export type KubeLifecycleContext =
  | { deployment: 'local' }
  | {
    deployment: 'kube';
    selfManagement:
      | ({ enabled: true } & KubeLifecycleSelfManagementFacts)
      | { enabled: false; reason: string };
  };

function normalize(raw: string | undefined): string {
  return raw?.trim() ?? '';
}

function parseSelfManagementEnabled(raw: string | undefined): boolean {
  const value = normalize(raw).toLowerCase();
  if (value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('PSFN_KUBE_SELF_MANAGEMENT_ENABLED must be true or false.');
}

function runningUnderKubernetes(env: NodeJS.ProcessEnv): boolean {
  return normalize(env.KUBERNETES_SERVICE_HOST).length > 0;
}

/**
 * Resolve the deployment-mode lifecycle context from process env.
 *
 * @throws when the deployment mode cannot be determined (e.g. self-management
 *   declared enabled but not running under Kubernetes, or facts malformed).
 */
export function resolveKubeLifecycleContext(
  env: NodeJS.ProcessEnv = process.env,
): KubeLifecycleContext {
  const enabled = parseSelfManagementEnabled(env.PSFN_KUBE_SELF_MANAGEMENT_ENABLED);
  const inKube = runningUnderKubernetes(env);

  if (!inKube && !enabled) {
    return { deployment: 'local' };
  }

  if (!enabled) {
    return {
      deployment: 'kube',
      selfManagement: {
        enabled: false,
        reason: 'Running under Kubernetes but PSFN_KUBE_SELF_MANAGEMENT_ENABLED is not true; guarded kube self-management is unavailable.',
      },
    };
  }

  if (!inKube) {
    throw new Error(
      'PSFN_KUBE_SELF_MANAGEMENT_ENABLED=true but KUBERNETES_SERVICE_HOST is absent; cannot determine the Kubernetes deployment scope.',
    );
  }

  const namespace = normalize(env.PSFN_HELM_NAMESPACE);
  const release = normalize(env.PSFN_HELM_RELEASE_NAME);
  const sourceRevision = normalize(env.PSFN_GIT_COMMIT);
  const targetImage = normalize(env.PSFN_KUBE_CURRENT_IMAGE);

  if (!isKubeDnsLabel(namespace) || !isKubeDnsLabel(release)) {
    throw new Error(
      'PSFN_HELM_NAMESPACE and PSFN_HELM_RELEASE_NAME must be DNS labels for Kubernetes self-management.',
    );
  }
  if (!isKubeSourceRevision(sourceRevision)) {
    throw new Error('PSFN_GIT_COMMIT must be an exact 40-character Git revision for Kubernetes self-management.');
  }
  if (!isPinnedKubeImageReference(targetImage)) {
    throw new Error('PSFN_KUBE_CURRENT_IMAGE must be an exact pinned image reference for Kubernetes self-management.');
  }

  return {
    deployment: 'kube',
    selfManagement: {
      enabled: true,
      namespace,
      release,
      sourceRevision,
      targetImage,
    },
  };
}
