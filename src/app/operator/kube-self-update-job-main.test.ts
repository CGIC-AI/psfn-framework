import { describe, expect, it } from 'vitest';
import {
  buildKubeSelfUpdateJobOptions,
  resolveKubeSelfUpdateJobEnvConfig,
} from './kube-self-update-job-main.js';
import { lifecycleKubernetesSettingsFixture } from '../../test-support/lifecycle-kubernetes-settings.js';

const COMMIT = 'a'.repeat(40);

function validConfig(env: NodeJS.ProcessEnv) {
  return {
    ...resolveKubeSelfUpdateJobEnvConfig(env),
    lifecycleKubernetes: lifecycleKubernetesSettingsFixture(),
  };
}

function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    PSFN_KUBE_SELF_UPDATE_ENABLED: 'true',
    PSFN_HELM_NAMESPACE: 'psfn',
    PSFN_HELM_RELEASE_NAME: 'psfn',
    PSFN_KUBE_RESOURCE_PREFIX: 'psfn-runtime',
    PSFN_GIT_COMMIT: COMMIT,
    PSFN_SOURCE_BRANCH: 'feat/x5rt-kube-self-management',
    PSFN_KUBE_TARGET_IMAGE: 'localhost/psfn-framework:0.1.0-kube-abcd1234',
    PSFN_SYSTEM_DATA_DIR: '/srv/system-data',
    PSFN_REPO_DIR: '/srv/psfn',
    PSFN_DOCKERFILE: 'docker/Dockerfile',
    PSFN_CHART_PATH: 'deploy/helm/psfn',
    PSFN_GARDEN_HEALTH_URL: 'http://garden:8080/health',
    PSFN_MODEL_ROUTE_URL: 'http://gateway:8081/v1/models',
    PSFN_EXPECTED_MODEL_ID: 'psfn-companion',
    PSFN_CHAT_COMPLETIONS_URL: 'http://gateway:8081/v1/chat/completions',
    PSFN_CONFORMANCE_EXEC_CMD: '["node","dist/tool-conformance.js","--json"]',
    PSFN_DIAGNOSTICS_EXEC_CMD: '["node","dist/diagnostics.js","--json"]',
    ...overrides,
  };
}

describe('resolveKubeSelfUpdateJobEnvConfig (fail-closed operator config)', () => {
  it('is disabled unless explicitly enabled', () => {
    expect(() => resolveKubeSelfUpdateJobEnvConfig({})).toThrow(/disabled/);
    expect(() => resolveKubeSelfUpdateJobEnvConfig(validEnv({ PSFN_KUBE_SELF_UPDATE_ENABLED: 'yes' }))).toThrow(/disabled/);
  });

  it('rejects a non-DNS-label namespace', () => {
    expect(() => resolveKubeSelfUpdateJobEnvConfig(validEnv({ PSFN_HELM_NAMESPACE: 'Bad_NS' }))).toThrow(/DNS labels/);
  });

  it('rejects a floating (non-pinned) target image', () => {
    expect(() => resolveKubeSelfUpdateJobEnvConfig(validEnv({ PSFN_KUBE_TARGET_IMAGE: 'localhost/psfn-framework:latest' })))
      .toThrow(/pinned image reference/);
  });

  it('rejects a short (non-40-char) source commit', () => {
    expect(() => resolveKubeSelfUpdateJobEnvConfig(validEnv({ PSFN_GIT_COMMIT: 'abc123' }))).toThrow(/40-character/);
  });

  it('requires the in-pod conformance/diagnostics exec commands', () => {
    expect(() => resolveKubeSelfUpdateJobEnvConfig(validEnv({ PSFN_CONFORMANCE_EXEC_CMD: undefined })))
      .toThrow(/PSFN_CONFORMANCE_EXEC_CMD/);
    expect(() => resolveKubeSelfUpdateJobEnvConfig(validEnv({ PSFN_DIAGNOSTICS_EXEC_CMD: '{}' })))
      .toThrow(/JSON array/);
  });

  it('resolves a complete, valid environment into a deploy plan', () => {
    const config = resolveKubeSelfUpdateJobEnvConfig(validEnv());
    expect(config.plan).toMatchObject({
      action: 'deploy',
      namespace: 'psfn',
      release: 'psfn',
      sourceCommit: COMMIT,
      imageRepository: 'localhost/psfn-framework',
      imageTag: '0.1.0-kube-abcd1234',
      k3dValidation: { mode: 'skip' },
    });
    expect(config.autoRollbackEnabled).toBe(true);
  });
});

describe('buildKubeSelfUpdateJobOptions', () => {
  it('wires auto-rollback transports when enabled and omits them when disabled', () => {
    const deps = {
      importImage: async () => undefined,
      verifyBackup: async () => true,
    };
    const enabled = buildKubeSelfUpdateJobOptions(validConfig(validEnv()), deps);
    expect(enabled.autoRollback).toBeDefined();
    expect(enabled.postRolloutValidationRunner).toBeDefined();
    expect(enabled.deployRunner).toBeDefined();
    expect(enabled.lifecycleKubernetes).toEqual(lifecycleKubernetesSettingsFixture());

    const disabled = buildKubeSelfUpdateJobOptions(
      validConfig(validEnv({ PSFN_AUTO_ROLLBACK_ENABLED: 'false' })),
      deps,
    );
    expect(disabled.autoRollback).toBeUndefined();
  });
});
