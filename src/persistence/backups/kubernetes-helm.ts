import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import { isStrictSubpath } from '../layout.js';
import {
  captureTreeSnapshot,
  verifyTreeSnapshot,
  type TreeSnapshotCaptureResult,
  type TreeSnapshotVerificationResult,
} from './companion-tree.js';
import {
  assertExactKubernetesHelmRecoveryKeys as assertExactKeys,
  readRequiredKubernetesHelmRecoveryString as readRequiredString,
  validateKubernetesHelmBackupConfig,
  type KubernetesHelmBackupConfig,
} from './kubernetes-helm-config.js';
import {
  readKubernetesHelmChartMetadata,
  verifyKubernetesHelmRecoveryChart,
} from './kubernetes-helm-chart.js';
import {
  createKubernetesHelmRecoveryDescriptor,
  readKubernetesHelmRecoveryDescriptorFile,
  type KubernetesHelmRecoveryDescriptor,
} from './kubernetes-helm-descriptor.js';

export {
  resolveKubernetesHelmBackupConfig,
  type KubernetesHelmBackupConfig,
} from './kubernetes-helm-config.js';
export type { KubernetesHelmRecoveryDescriptor } from './kubernetes-helm-descriptor.js';

export const KUBERNETES_HELM_RECOVERY_DIR_NAME = 'helm-recovery';
export const KUBERNETES_HELM_CHART_DIR_NAME = `${KUBERNETES_HELM_RECOVERY_DIR_NAME}/chart`;
export const KUBERNETES_HELM_CHART_MANIFEST_NAME = `${KUBERNETES_HELM_RECOVERY_DIR_NAME}/chart-manifest.json`;
export const KUBERNETES_HELM_DESCRIPTOR_NAME = `${KUBERNETES_HELM_RECOVERY_DIR_NAME}/deployment.json`;
export const KUBERNETES_HELM_RECOVERY_MANIFEST_NAME = 'helm-recovery-manifest.json';

const RECOVERY_MANIFEST_SCHEMA_VERSION = 1;

interface KubernetesHelmRecoveryManifest {
  schemaVersion: 1;
  capturedAt: string;
  descriptorFile: typeof KUBERNETES_HELM_DESCRIPTOR_NAME;
  descriptorSha256: string;
  chartManifestFile: typeof KUBERNETES_HELM_CHART_MANIFEST_NAME;
  chartManifestSha256: string;
}

export interface KubernetesHelmSnapshotCaptureResult {
  recoveryDir: string;
  manifestPath: string;
  descriptorPath: string;
  chart: TreeSnapshotCaptureResult;
}

export interface KubernetesHelmSnapshotVerificationResult {
  descriptor: KubernetesHelmRecoveryDescriptor;
  chart: TreeSnapshotVerificationResult;
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function canonicalizePotentialWritePath(path: string): string {
  let existingPath = resolve(path);
  const missingSegments: string[] = [];
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) break;
    missingSegments.unshift(basename(existingPath));
    existingPath = parent;
  }
  const canonicalBase = realpathSync(existingPath);
  return resolve(canonicalBase, ...missingSegments);
}

function assertChartAndBackupRootsDoNotOverlap(chartSourceDir: string, backupDir: string): void {
  const canonicalChartSource = realpathSync(chartSourceDir);
  const canonicalBackupDir = canonicalizePotentialWritePath(backupDir);
  if (
    canonicalChartSource === canonicalBackupDir
    || isStrictSubpath(canonicalChartSource, canonicalBackupDir)
    || isStrictSubpath(canonicalBackupDir, canonicalChartSource)
  ) {
    throw new Error(
      `Kubernetes Helm chart source (${chartSourceDir}) and backup destination (${backupDir}) must not overlap`,
    );
  }
}

export function captureKubernetesHelmSnapshot(options: {
  config: KubernetesHelmBackupConfig;
  backupDir: string;
  now?: () => number;
}): KubernetesHelmSnapshotCaptureResult {
  const config = validateKubernetesHelmBackupConfig(options.config);
  assertChartAndBackupRootsDoNotOverlap(config.chartSourceDir, options.backupDir);
  const chartInspection = verifyKubernetesHelmRecoveryChart(
    config.chartSourceDir,
    config.chartContentSha256,
  );
  const chartMetadata = readKubernetesHelmChartMetadata(config.chartSourceDir);
  if (
    chartMetadata.name !== config.chartName
    || chartMetadata.version !== config.chartVersion
    || chartMetadata.appVersion !== config.appVersion
  ) {
    throw new Error(
      'Kubernetes Helm deployment metadata does not match the chart source being backed up',
    );
  }
  const now = options.now ?? (() => Date.now());
  const chart = captureTreeSnapshot({
    sourceDir: config.chartSourceDir,
    backupDir: options.backupDir,
    treeDirName: KUBERNETES_HELM_CHART_DIR_NAME,
    manifestName: KUBERNETES_HELM_CHART_MANIFEST_NAME,
    sourceDescription: 'Kubernetes Helm chart',
    excludePaths: chartInspection.excludedPaths,
    now,
  });
  if (chart.skippedSpecialPaths.length > 0) {
    throw new Error(
      `Kubernetes Helm chart contains unsupported non-regular paths: ${chart.skippedSpecialPaths.join(', ')}`,
    );
  }
  if (chart.fileCount !== chartInspection.includedPaths.length) {
    throw new Error('Kubernetes Helm chart capture did not preserve the complete recovery file set');
  }

  const recoveryDir = join(options.backupDir, KUBERNETES_HELM_RECOVERY_DIR_NAME);
  const descriptorPath = join(options.backupDir, KUBERNETES_HELM_DESCRIPTOR_NAME);
  writeJsonAtomic(
    descriptorPath,
    createKubernetesHelmRecoveryDescriptor(config, now),
  );
  const manifestPath = join(options.backupDir, KUBERNETES_HELM_RECOVERY_MANIFEST_NAME);
  const manifest: KubernetesHelmRecoveryManifest = {
    schemaVersion: RECOVERY_MANIFEST_SCHEMA_VERSION,
    capturedAt: new Date(now()).toISOString(),
    descriptorFile: KUBERNETES_HELM_DESCRIPTOR_NAME,
    descriptorSha256: hashFile(descriptorPath),
    chartManifestFile: KUBERNETES_HELM_CHART_MANIFEST_NAME,
    chartManifestSha256: hashFile(chart.manifestPath),
  };
  writeJsonAtomic(manifestPath, manifest);
  return { recoveryDir, manifestPath, descriptorPath, chart };
}

export function readKubernetesHelmRecoveryDescriptor(
  backupDir: string,
): KubernetesHelmRecoveryDescriptor {
  const descriptorPath = join(backupDir, KUBERNETES_HELM_DESCRIPTOR_NAME);
  if (!existsSync(descriptorPath)) {
    throw new Error(`Kubernetes Helm recovery descriptor missing: ${descriptorPath}`);
  }
  return readKubernetesHelmRecoveryDescriptorFile(descriptorPath);
}

function readRecoveryManifest(backupDir: string): KubernetesHelmRecoveryManifest {
  const manifestPath = join(backupDir, KUBERNETES_HELM_RECOVERY_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`Kubernetes Helm recovery manifest missing: ${manifestPath}`);
  }
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Invalid Kubernetes Helm recovery manifest: ${manifestPath}`);
  }
  assertExactKeys(
    parsed,
    [
      'schemaVersion',
      'capturedAt',
      'descriptorFile',
      'descriptorSha256',
      'chartManifestFile',
      'chartManifestSha256',
    ],
    'manifest',
  );
  if (
    parsed.schemaVersion !== 1
    || parsed.descriptorFile !== KUBERNETES_HELM_DESCRIPTOR_NAME
    || parsed.chartManifestFile !== KUBERNETES_HELM_CHART_MANIFEST_NAME
  ) {
    throw new Error(`Unsupported Kubernetes Helm recovery manifest: ${manifestPath}`);
  }
  const descriptorSha256 = readRequiredString(parsed, 'descriptorSha256', 'manifest');
  const chartManifestSha256 = readRequiredString(parsed, 'chartManifestSha256', 'manifest');
  const capturedAt = readRequiredString(parsed, 'capturedAt', 'manifest');
  if (!Number.isFinite(Date.parse(capturedAt))) {
    throw new Error(`Invalid Kubernetes Helm recovery manifest capturedAt: ${manifestPath}`);
  }
  if (!/^[0-9a-f]{64}$/.test(descriptorSha256) || !/^[0-9a-f]{64}$/.test(chartManifestSha256)) {
    throw new Error(`Invalid Kubernetes Helm recovery manifest hashes: ${manifestPath}`);
  }
  return {
    schemaVersion: 1,
    capturedAt,
    descriptorFile: KUBERNETES_HELM_DESCRIPTOR_NAME,
    descriptorSha256,
    chartManifestFile: KUBERNETES_HELM_CHART_MANIFEST_NAME,
    chartManifestSha256,
  };
}

export function verifyKubernetesHelmSnapshot(
  backupDir: string,
): KubernetesHelmSnapshotVerificationResult {
  const manifest = readRecoveryManifest(backupDir);
  const descriptorPath = join(backupDir, KUBERNETES_HELM_DESCRIPTOR_NAME);
  const chartManifestPath = join(backupDir, KUBERNETES_HELM_CHART_MANIFEST_NAME);
  if (!existsSync(descriptorPath) || hashFile(descriptorPath) !== manifest.descriptorSha256) {
    throw new Error('Kubernetes Helm recovery descriptor hash mismatch');
  }
  if (!existsSync(chartManifestPath) || hashFile(chartManifestPath) !== manifest.chartManifestSha256) {
    throw new Error('Kubernetes Helm chart manifest hash mismatch');
  }

  const recoveryDir = join(backupDir, KUBERNETES_HELM_RECOVERY_DIR_NAME);
  if (!existsSync(recoveryDir)) {
    throw new Error(`Kubernetes Helm recovery directory missing: ${recoveryDir}`);
  }
  const recoveryEntries = readdirSync(recoveryDir).sort((a, b) => a.localeCompare(b));
  const expectedEntries = ['chart', 'chart-manifest.json', 'deployment.json'];
  if (
    recoveryEntries.length !== expectedEntries.length
    || recoveryEntries.some((entry, index) => entry !== expectedEntries[index])
  ) {
    throw new Error(`Unexpected Kubernetes Helm recovery files: ${recoveryEntries.join(', ')}`);
  }

  const descriptor = readKubernetesHelmRecoveryDescriptor(backupDir);
  const chart = verifyTreeSnapshot(
    backupDir,
    KUBERNETES_HELM_CHART_DIR_NAME,
    KUBERNETES_HELM_CHART_MANIFEST_NAME,
    'Kubernetes Helm chart',
  );
  const recoveredChartDir = join(backupDir, KUBERNETES_HELM_CHART_DIR_NAME);
  const chartInspection = verifyKubernetesHelmRecoveryChart(
    recoveredChartDir,
    descriptor.chart.contentSha256,
  );
  if (chart.verifiedFileCount !== chartInspection.includedPaths.length) {
    throw new Error('Kubernetes Helm recovery chart manifest does not match the recovery file set');
  }
  const chartMetadata = readKubernetesHelmChartMetadata(recoveredChartDir);
  if (
    chartMetadata.name !== descriptor.chart.name
    || chartMetadata.version !== descriptor.chart.version
    || chartMetadata.appVersion !== descriptor.chart.appVersion
  ) {
    throw new Error('Kubernetes Helm recovery descriptor does not match the captured chart metadata');
  }
  return { descriptor, chart };
}
