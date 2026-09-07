#!/usr/bin/env tsx
// Repository gate for deploy/helm/psfn/recovery-chart.sha256.
//
// The runtime backup path (verifyKubernetesHelmRecoveryChart) refuses to record
// a Kubernetes cluster unit when the shipped chart no longer hashes to the
// recorded digest, so a chart edit that forgets the digest refresh breaks every
// scheduled fleet backup on a Kubernetes deployment. This script recomputes the
// digest with the exact runtime function and fails the hygiene gate on drift.
// `--update` rewrites the digest file from the same computation.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  KUBERNETES_HELM_CHART_DIGEST_FILE_NAME,
  inspectKubernetesHelmRecoveryChart,
  readKubernetesHelmRecoveryChartDigestFile,
} from '../src/persistence/backups/kubernetes-helm-chart.js';

export const RECOVERY_CHART_SOURCE_DIR = join('deploy', 'helm', 'psfn');

export interface RecoveryChartDigestCheck {
  chartSourceDir: string;
  computedDigest: string;
  recordedDigest: string;
  matches: boolean;
  includedPaths: string[];
}

export function checkKubernetesHelmRecoveryChartDigest(
  chartSourceDir: string,
): RecoveryChartDigestCheck {
  const inspection = inspectKubernetesHelmRecoveryChart(chartSourceDir);
  const recordedDigest = readKubernetesHelmRecoveryChartDigestFile(chartSourceDir);
  return {
    chartSourceDir,
    computedDigest: inspection.contentSha256,
    recordedDigest,
    matches: inspection.contentSha256 === recordedDigest,
    includedPaths: inspection.includedPaths,
  };
}

/** Rewrites the digest file from the chart contents. Returns the check taken before the write. */
export function updateKubernetesHelmRecoveryChartDigest(
  chartSourceDir: string,
): RecoveryChartDigestCheck {
  const before = checkKubernetesHelmRecoveryChartDigest(chartSourceDir);
  if (!before.matches) {
    const digestPath = join(chartSourceDir, KUBERNETES_HELM_CHART_DIGEST_FILE_NAME);
    writeFileSync(digestPath, `${before.computedDigest}\n`, 'utf-8');
  }
  return before;
}

export function formatRecoveryChartDigestFailure(check: RecoveryChartDigestCheck): string {
  return [
    'Kubernetes Helm recovery chart digest is stale.',
    `  chart:    ${check.chartSourceDir}`,
    `  recorded: ${check.recordedDigest}`,
    `  computed: ${check.computedDigest}`,
    '',
    'A tracked chart file changed without refreshing the digest, which fails every',
    'Kubernetes fleet backup cluster unit at runtime. Refresh it with:',
    '  npm run verify:recovery-chart-digest -- --update',
  ].join('\n');
}

function resolveRepositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function main(argv: readonly string[]): void {
  const update = argv.includes('--update');
  const unknown = argv.filter(argument => argument !== '--update');
  if (unknown.length > 0) {
    console.error(`Unsupported argument: ${unknown[0]}. Usage: verify-recovery-chart-digest [--update]`);
    process.exit(2);
  }

  const chartSourceDir = join(resolveRepositoryRoot(), RECOVERY_CHART_SOURCE_DIR);
  if (update) {
    const before = updateKubernetesHelmRecoveryChartDigest(chartSourceDir);
    if (before.matches) {
      console.log(`Kubernetes Helm recovery chart digest already current (${before.recordedDigest}).`);
      return;
    }
    console.log(
      `Refreshed ${RECOVERY_CHART_SOURCE_DIR}/${KUBERNETES_HELM_CHART_DIGEST_FILE_NAME}: `
      + `${before.recordedDigest} -> ${before.computedDigest}`,
    );
    return;
  }

  const check = checkKubernetesHelmRecoveryChartDigest(chartSourceDir);
  if (!check.matches) {
    console.error(formatRecoveryChartDigestFailure(check));
    process.exit(1);
  }
  console.log(
    `Kubernetes Helm recovery chart digest check passed over ${check.includedPaths.length} chart files `
    + `(${check.computedDigest}).`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `Kubernetes Helm recovery chart digest check failed to complete: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }
}
