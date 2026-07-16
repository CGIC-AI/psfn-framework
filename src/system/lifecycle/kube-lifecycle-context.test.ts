import { describe, expect, it } from 'vitest';
import { resolveKubeLifecycleContext } from './kube-lifecycle-context.js';

const VALID_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const VALID_IMAGE = 'localhost/psfn-framework:0.1.0-kube-0ecaa08d';

function kubeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    KUBERNETES_SERVICE_HOST: '10.0.0.1',
    PSFN_KUBE_SELF_MANAGEMENT_ENABLED: 'true',
    PSFN_HELM_NAMESPACE: 'psfn',
    PSFN_HELM_RELEASE_NAME: 'psfn',
    PSFN_GIT_COMMIT: VALID_COMMIT,
    PSFN_KUBE_CURRENT_IMAGE: VALID_IMAGE,
    PSFN_HELM_REVISION: '8',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('resolveKubeLifecycleContext', () => {
  it('returns local mode when not in kube and self-management is unset', () => {
    expect(resolveKubeLifecycleContext({} as NodeJS.ProcessEnv)).toEqual({ deployment: 'local' });
  });

  it('resolves an enabled kube context with the exact self-management facts', () => {
    expect(resolveKubeLifecycleContext(kubeEnv())).toEqual({
      deployment: 'kube',
      selfManagement: {
        enabled: true,
        namespace: 'psfn',
        release: 'psfn',
        sourceRevision: VALID_COMMIT,
        targetImage: VALID_IMAGE,
        helmRevision: 8,
      },
    });
  });

  it('reports kube-but-disabled (fail closed, no local restart) when in kube without the flag', () => {
    const context = resolveKubeLifecycleContext({
      KUBERNETES_SERVICE_HOST: '10.0.0.1',
    } as NodeJS.ProcessEnv);
    expect(context.deployment).toBe('kube');
    if (context.deployment !== 'kube') throw new Error('expected kube deployment');
    expect(context.selfManagement.enabled).toBe(false);
    if (context.selfManagement.enabled) throw new Error('expected disabled self-management');
    expect(context.selfManagement.reason).toMatch(/not true/);
  });

  it('throws when self-management is enabled but not running under Kubernetes', () => {
    expect(() => resolveKubeLifecycleContext(kubeEnv({ KUBERNETES_SERVICE_HOST: undefined })))
      .toThrow(/KUBERNETES_SERVICE_HOST is absent/);
  });

  it('throws on a garbage self-management flag', () => {
    expect(() => resolveKubeLifecycleContext(kubeEnv({ PSFN_KUBE_SELF_MANAGEMENT_ENABLED: 'yes' })))
      .toThrow(/must be true or false/);
  });

  it.each([
    ['namespace', { PSFN_HELM_NAMESPACE: 'Not_A_Label' }],
    ['release', { PSFN_HELM_RELEASE_NAME: '-bad' }],
  ])('throws on malformed %s (fail closed at composition)', (_field, overrides) => {
    expect(() => resolveKubeLifecycleContext(kubeEnv(overrides))).toThrow(/DNS label/);
  });

  it('throws on a non-40-char git commit', () => {
    expect(() => resolveKubeLifecycleContext(kubeEnv({ PSFN_GIT_COMMIT: 'abc123' })))
      .toThrow(/40-character Git revision/);
  });

  it('throws on a floating (unpinned) image reference', () => {
    expect(() => resolveKubeLifecycleContext(kubeEnv({ PSFN_KUBE_CURRENT_IMAGE: 'psfn-framework:latest' })))
      .toThrow(/pinned image reference/);
  });

  it('throws on a non-positive helm revision', () => {
    expect(() => resolveKubeLifecycleContext(kubeEnv({ PSFN_HELM_REVISION: '0' })))
      .toThrow(/positive integer/);
  });
});
