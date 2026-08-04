#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shipScriptPath = join(repoRoot, 'scripts/ops/ship-kube-update.sh');
const shipScript = readFileSync(shipScriptPath, 'utf-8');
const agentDockerfilePath = join(repoRoot, 'docker/Dockerfile.agent');
const agentDockerfile = readFileSync(agentDockerfilePath, 'utf-8');
const globalSkillManifestGate = 'find /app/skills -type f -name SKILL.md -print -quit | grep -q .';
for (const [surface, text] of [
  ['docker/Dockerfile.agent', agentDockerfile],
  ['scripts/ops/ship-kube-update.sh', shipScript],
]) {
  if (!text.includes(globalSkillManifestGate)) {
    throw new Error(`${surface} must require at least one bundled global SKILL.md manifest`);
  }
  if (text.includes('/app/skills/conversation/SKILL.md')) {
    throw new Error(`${surface} must not bind the global skills gate to one named skill`);
  }
}
const provenanceGuard = 'git diff --quiet "$LIVE_AGENT_COMMIT" HEAD -- deploy/helm/psfn';
const forceAgent = 'SELECTED+=(agent)';
const guardIndex = shipScript.indexOf(provenanceGuard);
const forceIndex = shipScript.indexOf(forceAgent);
const buildIndex = shipScript.indexOf('docker buildx build');
if (guardIndex < 0 || forceIndex < guardIndex || buildIndex < forceIndex) {
  throw new Error('ship-kube-update.sh does not force an agent refresh before building when the chart changes');
}
if (!shipScript.includes('helm upgrade psfn') || !shipScript.includes('--take-ownership --timeout 10m')) {
  throw new Error('ship-kube-update.sh must adopt chart-declared resources during Helm upgrades');
}
const prefetchLifecycleFunction = shipScript.indexOf('complete_model_prefetch_lifecycle()');
const helmSetsInitialization = shipScript.indexOf('HELM_SETS=()');
const prefetchLifecycleCall = shipScript.indexOf('complete_model_prefetch_lifecycle', helmSetsInitialization);
const helmUpgrade = shipScript.indexOf('helm upgrade psfn');
if (prefetchLifecycleFunction < 0
  || helmSetsInitialization < 0
  || prefetchLifecycleCall < helmSetsInitialization
  || prefetchLifecycleCall > helmUpgrade) {
  throw new Error('ship-kube-update.sh must close completed model prefetch before Helm upgrade');
}
for (const requiredPrefetchGuard of [
  'app.kubernetes.io/component=model-prefetch',
  'modelPrefetch.enabled=false',
  'refusing to ship while model prefetch is incomplete',
  'PREFETCH_LIFECYCLE_CLOSED=1',
  'rkubectl rollout status deploy/psfn-gateway',
]) {
  if (!shipScript.includes(requiredPrefetchGuard)) {
    throw new Error(`ship-kube-update.sh missing model-prefetch lifecycle guard: ${requiredPrefetchGuard}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'psfn-kube-chart-provenance-'));
const runGit = (...args) => execFileSync('git', args, {
  cwd: root,
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

try {
  runGit('init', '--initial-branch=main');
  runGit('config', 'user.name', 'PSFN Verification');
  runGit('config', 'user.email', 'verify@psfn.invalid');
  mkdirSync(join(root, 'deploy/helm/psfn'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'deploy/helm/psfn/Chart.yaml'), 'version: 1\n', 'utf-8');
  writeFileSync(join(root, 'src/runtime.ts'), 'export const revision = 1;\n', 'utf-8');
  runGit('add', '.');
  runGit('commit', '-m', 'initial chart');
  const embeddedRevision = runGit('rev-parse', 'HEAD');

  writeFileSync(join(root, 'src/runtime.ts'), 'export const revision = 2;\n', 'utf-8');
  runGit('add', '.');
  runGit('commit', '-m', 'runtime only');
  const runtimeOnlyRevision = runGit('rev-parse', 'HEAD');
  const unchanged = spawnSync(
    'git',
    ['diff', '--quiet', embeddedRevision, runtimeOnlyRevision, '--', 'deploy/helm/psfn'],
    { cwd: root },
  );
  if (unchanged.status !== 0) {
    throw new Error('runtime-only revision was incorrectly classified as a chart change');
  }

  writeFileSync(join(root, 'deploy/helm/psfn/Chart.yaml'), 'version: 2\n', 'utf-8');
  runGit('add', '.');
  runGit('commit', '-m', 'chart revision');
  const chartRevision = runGit('rev-parse', 'HEAD');
  const changed = spawnSync(
    'git',
    ['diff', '--quiet', embeddedRevision, chartRevision, '--', 'deploy/helm/psfn'],
    { cwd: root },
  );
  if (changed.status !== 1) {
    throw new Error('second chart revision did not force the chart-change path');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('Kubernetes selective-rollout chart provenance verification passed.');
