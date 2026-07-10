import { isAbsolute, resolve } from 'node:path';
import { isRecord } from '../../shared/utils/types.js';

export interface KubernetesHelmWorkloadImage {
  repository: string;
  tag: string;
  digest?: string;
  gitCommit?: string;
}

export interface KubernetesHelmBackupConfig {
  chartSourceDir: string;
  releaseName: string;
  namespace: string;
  revision: number;
  chartName: string;
  chartVersion: string;
  appVersion: string;
  chartContentSha256: string;
  images: {
    agent: KubernetesHelmWorkloadImage;
    gateway: KubernetesHelmWorkloadImage;
    garden: KubernetesHelmWorkloadImage;
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Kubernetes Helm backup requires ${name}`);
  }
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`Kubernetes Helm backup ${name} contains control characters`);
  }
  return value;
}

function requiredConfigString(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || /[\0\r\n]/.test(normalized)) {
    throw new Error(`Kubernetes Helm backup ${label} is missing or invalid`);
  }
  return normalized;
}

export function assertExactKubernetesHelmRecoveryKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort((a, b) => a.localeCompare(b));
  const expected = [...expectedKeys].sort((a, b) => a.localeCompare(b));
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid Kubernetes Helm recovery ${label} fields: ${actual.join(', ')}`);
  }
}

export function readRequiredKubernetesHelmRecoveryString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const field = value[key];
  if (typeof field !== 'string' || !field.trim() || /[\0\r\n]/.test(field)) {
    throw new Error(`Invalid Kubernetes Helm recovery ${label}.${key}`);
  }
  return field;
}

export function assertKubernetesDnsLabel(
  value: string,
  label: string,
  maxLength = 63,
): void {
  if (
    value.length > maxLength
    || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value)
  ) {
    throw new Error(`Kubernetes Helm backup ${label} is invalid: ${value}`);
  }
}

export function assertHelmMetadataToken(value: string, label: string): void {
  if (value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/.test(value)) {
    throw new Error(`Kubernetes Helm backup ${label} is invalid: ${value}`);
  }
}

export function assertHelmImageRepository(value: string): void {
  if (value.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) {
    throw new Error(`Kubernetes Helm backup image repository is invalid: ${value}`);
  }
}

export function normalizeHelmImageDigest(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('Kubernetes Helm backup image digest must be an exact sha256 digest');
  }
  return normalized;
}

export function normalizeHelmGitCommit(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error('Kubernetes Helm backup PSFN_GIT_COMMIT must be a full lowercase commit hash');
  }
  return normalized;
}

function normalizeChartContentSha256(value: unknown): string {
  const normalized = requiredConfigString(value, 'chart content sha256');
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('Kubernetes Helm backup chart content sha256 must be an exact lowercase sha256');
  }
  return normalized;
}

export function validateKubernetesHelmWorkloadImage(
  value: unknown,
  workload: 'agent' | 'gateway' | 'garden',
): KubernetesHelmWorkloadImage {
  if (!isRecord(value)) {
    throw new Error(`Kubernetes Helm backup ${workload} image is missing or invalid`);
  }
  const repository = requiredConfigString(value.repository, `${workload} image repository`);
  const tag = requiredConfigString(value.tag, `${workload} image tag`);
  assertHelmImageRepository(repository);
  assertHelmMetadataToken(tag, `${workload} image tag`);
  if (value.digest !== undefined && typeof value.digest !== 'string') {
    throw new Error(`Kubernetes Helm backup ${workload} image digest is invalid`);
  }
  if (value.gitCommit !== undefined && typeof value.gitCommit !== 'string') {
    throw new Error(`Kubernetes Helm backup ${workload} image git commit is invalid`);
  }
  const digest = normalizeHelmImageDigest(value.digest);
  const gitCommit = normalizeHelmGitCommit(value.gitCommit);
  return {
    repository,
    tag,
    ...(digest ? { digest } : {}),
    ...(gitCommit ? { gitCommit } : {}),
  };
}

export function validateKubernetesHelmBackupConfig(
  config: KubernetesHelmBackupConfig,
): KubernetesHelmBackupConfig {
  const chartSourceDir = requiredConfigString(config.chartSourceDir, 'chart source directory');
  if (!isAbsolute(chartSourceDir)) {
    throw new Error('Kubernetes Helm backup chart source directory must be absolute');
  }
  const releaseName = requiredConfigString(config.releaseName, 'release name');
  const namespace = requiredConfigString(config.namespace, 'namespace');
  const chartName = requiredConfigString(config.chartName, 'chart name');
  const chartVersion = requiredConfigString(config.chartVersion, 'chart version');
  const appVersion = requiredConfigString(config.appVersion, 'app version');
  const chartContentSha256 = normalizeChartContentSha256(config.chartContentSha256);
  assertKubernetesDnsLabel(releaseName, 'release name', 53);
  assertKubernetesDnsLabel(namespace, 'namespace');
  assertHelmMetadataToken(chartName, 'chart name');
  assertHelmMetadataToken(chartVersion, 'chart version');
  assertHelmMetadataToken(appVersion, 'app version');
  if (!Number.isSafeInteger(config.revision) || config.revision < 1) {
    throw new Error('Kubernetes Helm backup revision must be a positive safe integer');
  }
  if (!isRecord(config.images)) {
    throw new Error('Kubernetes Helm backup workload images are missing or invalid');
  }
  return {
    chartSourceDir: resolve(chartSourceDir),
    releaseName,
    namespace,
    revision: config.revision,
    chartName,
    chartVersion,
    appVersion,
    chartContentSha256,
    images: {
      agent: validateKubernetesHelmWorkloadImage(config.images.agent, 'agent'),
      gateway: validateKubernetesHelmWorkloadImage(config.images.gateway, 'gateway'),
      garden: validateKubernetesHelmWorkloadImage(config.images.garden, 'garden'),
    },
  };
}

function readWorkloadImageFromEnv(
  env: NodeJS.ProcessEnv,
  workload: 'agent' | 'gateway' | 'garden',
): KubernetesHelmWorkloadImage {
  const envPrefix = `PSFN_HELM_BACKUP_${workload.toUpperCase()}_IMAGE`;
  const repository = requiredEnv(env, `${envPrefix}_REPOSITORY`);
  const tag = requiredEnv(env, `${envPrefix}_TAG`);
  const digest = normalizeHelmImageDigest(env[`${envPrefix}_DIGEST`]);
  const image: KubernetesHelmWorkloadImage = {
    repository,
    tag,
    ...(digest ? { digest } : {}),
  };
  if (workload === 'agent') {
    const gitCommit = normalizeHelmGitCommit(env.PSFN_GIT_COMMIT);
    if (gitCommit) image.gitCommit = gitCommit;
  }
  return image;
}

export function resolveKubernetesHelmBackupConfig(
  env: NodeJS.ProcessEnv = process.env,
): KubernetesHelmBackupConfig | undefined {
  const enabled = env.PSFN_KUBERNETES_BACKUP_ENABLED?.trim();
  if (!enabled || enabled === 'false') return undefined;
  if (enabled !== 'true') {
    throw new Error('PSFN_KUBERNETES_BACKUP_ENABLED must be true or false');
  }

  const chartSourceDir = requiredEnv(env, 'PSFN_HELM_CHART_DIR');
  if (!isAbsolute(chartSourceDir)) {
    throw new Error('Kubernetes Helm backup PSFN_HELM_CHART_DIR must be absolute');
  }
  const releaseName = requiredEnv(env, 'PSFN_HELM_RELEASE_NAME');
  const namespace = requiredEnv(env, 'PSFN_HELM_NAMESPACE');
  assertKubernetesDnsLabel(releaseName, 'release name', 53);
  assertKubernetesDnsLabel(namespace, 'namespace');

  const revisionText = requiredEnv(env, 'PSFN_HELM_REVISION');
  if (!/^[1-9][0-9]*$/.test(revisionText)) {
    throw new Error('Kubernetes Helm backup PSFN_HELM_REVISION must be a positive integer');
  }
  const revision = Number(revisionText);
  if (!Number.isSafeInteger(revision)) {
    throw new Error('Kubernetes Helm backup PSFN_HELM_REVISION exceeds the safe integer range');
  }

  const chartName = requiredEnv(env, 'PSFN_HELM_CHART_NAME');
  const chartVersion = requiredEnv(env, 'PSFN_HELM_CHART_VERSION');
  const appVersion = requiredEnv(env, 'PSFN_HELM_APP_VERSION');
  const chartContentSha256 = requiredEnv(env, 'PSFN_HELM_CHART_CONTENT_SHA256');
  assertHelmMetadataToken(chartName, 'chart name');
  assertHelmMetadataToken(chartVersion, 'chart version');
  assertHelmMetadataToken(appVersion, 'app version');
  return validateKubernetesHelmBackupConfig({
    chartSourceDir,
    releaseName,
    namespace,
    revision,
    chartName,
    chartVersion,
    appVersion,
    chartContentSha256,
    images: {
      agent: readWorkloadImageFromEnv(env, 'agent'),
      gateway: readWorkloadImageFromEnv(env, 'gateway'),
      garden: readWorkloadImageFromEnv(env, 'garden'),
    },
  });
}
