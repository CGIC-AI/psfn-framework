import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  RECOVERY_CHART_SOURCE_DIR,
  checkKubernetesHelmRecoveryChartDigest,
  formatRecoveryChartDigestFailure,
  updateKubernetesHelmRecoveryChartDigest,
} from './verify-recovery-chart-digest.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shippedChartDir = join(repositoryRoot, RECOVERY_CHART_SOURCE_DIR);

function copyShippedChart(): string {
  const directory = mkdtempSync(join(tmpdir(), 'psfn-recovery-chart-'));
  const chartDir = join(directory, 'psfn');
  cpSync(shippedChartDir, chartDir, { recursive: true });
  return chartDir;
}

describe('Kubernetes Helm recovery chart digest gate', () => {
  it('matches the digest recorded for the shipped chart', () => {
    const check = checkKubernetesHelmRecoveryChartDigest(shippedChartDir);
    expect(check.recordedDigest).toBe(check.computedDigest);
    expect(check.matches).toBe(true);
    expect(check.includedPaths).toContain('Chart.yaml');
  });

  it('fails when a tracked chart file changes without a digest refresh', () => {
    const chartDir = copyShippedChart();
    const valuesPath = join(chartDir, 'values.yaml');
    writeFileSync(valuesPath, `${readFileSync(valuesPath, 'utf-8')}\n# drift marker\n`, 'utf-8');

    const check = checkKubernetesHelmRecoveryChartDigest(chartDir);
    expect(check.matches).toBe(false);
    expect(check.computedDigest).not.toBe(check.recordedDigest);
    expect(formatRecoveryChartDigestFailure(check)).toContain('digest is stale');
    expect(formatRecoveryChartDigestFailure(check)).toContain('--update');
  });

  it('refreshes the digest file in place and leaves a current chart untouched', () => {
    const chartDir = copyShippedChart();
    const valuesPath = join(chartDir, 'values.yaml');
    const digestPath = join(chartDir, 'recovery-chart.sha256');
    writeFileSync(valuesPath, `${readFileSync(valuesPath, 'utf-8')}\n# drift marker\n`, 'utf-8');
    const staleDigest = readFileSync(digestPath, 'utf-8');

    const before = updateKubernetesHelmRecoveryChartDigest(chartDir);
    expect(before.matches).toBe(false);
    expect(readFileSync(digestPath, 'utf-8')).toBe(`${before.computedDigest}\n`);
    expect(readFileSync(digestPath, 'utf-8')).not.toBe(staleDigest);
    expect(checkKubernetesHelmRecoveryChartDigest(chartDir).matches).toBe(true);

    const secondPass = updateKubernetesHelmRecoveryChartDigest(chartDir);
    expect(secondPass.matches).toBe(true);
    expect(readFileSync(digestPath, 'utf-8')).toBe(`${before.computedDigest}\n`);
  });
});
