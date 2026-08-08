import { readFileSync } from 'node:fs';
import { isRecord } from '../../shared/utils/types.js';
import {
  assertExactKubernetesHelmRecoveryKeys as assertExactKeys,
  assertHelmMetadataToken,
  assertKubernetesDnsLabel,
  readRequiredKubernetesHelmRecoveryString as readRequiredString,
  validateKubernetesHelmWorkloadImage,
  type KubernetesHelmBackupConfig,
  type KubernetesHelmWorkloadImage,
} from './kubernetes-helm-config.js';

export interface KubernetesHelmRecoveryDescriptor {
  schemaVersion: 1;
  platform: 'kubernetes';
  capturedAt: string;
  release: {
    name: string;
    namespace: string;
    /** Optional provenance; absent when the capturing process cannot know it. */
    revision?: number;
  };
  chart: {
    name: string;
    version: string;
    appVersion: string;
    path: 'chart';
    contentSha256: string;
  };
  images: {
    agent: KubernetesHelmWorkloadImage;
    gateway: KubernetesHelmWorkloadImage;
    garden: KubernetesHelmWorkloadImage;
  };
  exclusions: {
    liveHelmValues: true;
    kubernetesSecrets: true;
  };
}

export function createKubernetesHelmRecoveryDescriptor(
  config: KubernetesHelmBackupConfig,
  now: () => number,
): KubernetesHelmRecoveryDescriptor {
  return {
    schemaVersion: 1,
    platform: 'kubernetes',
    capturedAt: new Date(now()).toISOString(),
    release: {
      name: config.releaseName,
      namespace: config.namespace,
      ...(config.revision !== undefined ? { revision: config.revision } : {}),
    },
    chart: {
      name: config.chartName,
      version: config.chartVersion,
      appVersion: config.appVersion,
      path: 'chart',
      contentSha256: config.chartContentSha256,
    },
    images: config.images,
    exclusions: {
      liveHelmValues: true,
      kubernetesSecrets: true,
    },
  };
}

export function readKubernetesHelmRecoveryDescriptorFile(
  descriptorPath: string,
): KubernetesHelmRecoveryDescriptor {
  const parsed = JSON.parse(readFileSync(descriptorPath, 'utf-8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Invalid Kubernetes Helm recovery descriptor: ${descriptorPath}`);
  }
  assertExactKeys(
    parsed,
    ['schemaVersion', 'platform', 'capturedAt', 'release', 'chart', 'images', 'exclusions'],
    'descriptor',
  );
  if (parsed.schemaVersion !== 1 || parsed.platform !== 'kubernetes') {
    throw new Error(`Unsupported Kubernetes Helm recovery descriptor: ${descriptorPath}`);
  }
  const capturedAt = readRequiredString(parsed, 'capturedAt', 'descriptor');
  if (!Number.isFinite(Date.parse(capturedAt))) {
    throw new Error('Invalid Kubernetes Helm recovery descriptor.capturedAt');
  }
  if (!isRecord(parsed.release) || !isRecord(parsed.chart) || !isRecord(parsed.images) || !isRecord(parsed.exclusions)) {
    throw new Error(`Invalid Kubernetes Helm recovery descriptor: ${descriptorPath}`);
  }
  const images = parsed.images;
  assertExactKeys(
    parsed.release,
    ['name', 'namespace', ...(parsed.release.revision !== undefined ? ['revision'] : [])],
    'release',
  );
  assertExactKeys(parsed.chart, ['name', 'version', 'appVersion', 'path', 'contentSha256'], 'chart');
  assertExactKeys(images, ['agent', 'gateway', 'garden'], 'images');
  assertExactKeys(parsed.exclusions, ['liveHelmValues', 'kubernetesSecrets'], 'exclusions');

  const releaseRevision = parsed.release.revision;
  if (releaseRevision !== undefined
    && (!Number.isSafeInteger(releaseRevision) || (releaseRevision as number) < 1)) {
    throw new Error('Invalid Kubernetes Helm recovery release.revision');
  }
  if (
    parsed.chart.path !== 'chart'
    || parsed.exclusions.liveHelmValues !== true
    || parsed.exclusions.kubernetesSecrets !== true
  ) {
    throw new Error('Invalid Kubernetes Helm recovery exclusion or chart-path contract');
  }

  const releaseName = readRequiredString(parsed.release, 'name', 'release');
  const namespace = readRequiredString(parsed.release, 'namespace', 'release');
  const chartName = readRequiredString(parsed.chart, 'name', 'chart');
  const chartVersion = readRequiredString(parsed.chart, 'version', 'chart');
  const appVersion = readRequiredString(parsed.chart, 'appVersion', 'chart');
  const contentSha256 = readRequiredString(parsed.chart, 'contentSha256', 'chart');
  if (!/^[0-9a-f]{64}$/.test(contentSha256)) {
    throw new Error('Invalid Kubernetes Helm recovery chart.contentSha256');
  }
  assertKubernetesDnsLabel(releaseName, 'release name', 53);
  assertKubernetesDnsLabel(namespace, 'namespace');
  assertHelmMetadataToken(chartName, 'chart name');
  assertHelmMetadataToken(chartVersion, 'chart version');
  assertHelmMetadataToken(appVersion, 'app version');
  const readImage = (workload: 'agent' | 'gateway' | 'garden'): KubernetesHelmWorkloadImage => {
    const image = images[workload];
    if (!isRecord(image)) {
      throw new Error(`Invalid Kubernetes Helm recovery images.${workload}`);
    }
    assertExactKeys(
      image,
      [
        'repository',
        'tag',
        ...(image.digest !== undefined ? ['digest'] : []),
        ...(image.gitCommit !== undefined ? ['gitCommit'] : []),
      ],
      `images.${workload}`,
    );
    return validateKubernetesHelmWorkloadImage(image, workload);
  };
  return {
    schemaVersion: 1,
    platform: 'kubernetes',
    capturedAt,
    release: {
      name: releaseName,
      namespace,
      ...(releaseRevision !== undefined ? { revision: releaseRevision as number } : {}),
    },
    chart: {
      name: chartName,
      version: chartVersion,
      appVersion,
      path: 'chart',
      contentSha256,
    },
    images: {
      agent: readImage('agent'),
      gateway: readImage('gateway'),
      garden: readImage('garden'),
    },
    exclusions: {
      liveHelmValues: true,
      kubernetesSecrets: true,
    },
  };
}
