import { resolve } from 'node:path';
import { verifyKubernetesHelmRecoveryChart } from '../src/persistence/backups/kubernetes-helm-chart.js';

const chartDir = resolve('deploy/helm/psfn');
const inspection = verifyKubernetesHelmRecoveryChart(chartDir);
console.log(JSON.stringify({
  chartDir,
  recoveryChartSha256: inspection.contentSha256,
  includedFiles: inspection.includedPaths.length,
  excludedDocumentationFiles: inspection.excludedPaths,
}, null, 2));
