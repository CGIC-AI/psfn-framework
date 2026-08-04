#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chartDir = resolve(repoRoot, 'deploy/helm/psfn');
const commonArgs = [
  '--namespace', 'psfn-test',
  '--skip-schema-validation',
  '--set', 'fleet.enabled=false',
  '--set', 'fleetAuth.enabled=false',
  '--set', 'ingress.gateway.tls.enabled=false',
  '--set-string', 'ingress.gateway.tls.secretName=',
  '--set', 'ingress.garden.enabled=true',
  '--set-string', 'runtime.systemDataDir=/app/system-data',
  '--set-string', 'runtime.companionDataDir=/app/companion-data',
  '--set-string', 'runtime.workspacePath=/app/workspace',
  '--set-string', 'runtime.logsDir=/app/logs',
  '--set-string', 'runtime.tempDir=/app/tmp',
  '--set-string', 'runtime.backupsDir=/app/backups',
  '--set-string', 'runtime.characterCardPath=/app/companion-data/companion.json',
  '--set', 'modelPrefetch.enabled=true',
];

function helm(args) {
  return execFileSync('helm', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function render(tag, release = 'psfn') {
  return helm([
    'template', release, chartDir,
    ...commonArgs,
    '--set-string', `psfnAppImage.tag=${tag}`,
  ]);
}

function prefetchJob(rendered) {
  return parseAllDocuments(rendered)
    .map(document => document.toJS())
    .find(document => document?.kind === 'Job'
      && document?.metadata?.labels?.['app.kubernetes.io/component'] === 'model-prefetch');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const oldTag = '0.1.0-kube-oldprefetch';
const newTag = '0.1.0-kube-newprefetch';
const oldJob = prefetchJob(render(oldTag));
const stableOldJob = prefetchJob(render(oldTag));
const newJob = prefetchJob(render(newTag));
assert(oldJob && newJob, 'image-upgrade regression render is missing its model-prefetch Job');
assert(
  /^psfn-model-prefetch-[a-f0-9]{16}$/.test(oldJob.metadata.name),
  `model-prefetch Job name must carry its immutable spec hash: ${oldJob.metadata.name}`,
);
assert(
  oldJob.metadata.labels['psfn.io/model-prefetch-spec-hash'] === oldJob.metadata.name.slice(-16),
  'model-prefetch Job hash label must match the hashed object identity',
);
assert(oldJob.metadata.name === stableOldJob?.metadata?.name, 'identical specs changed Job identity');
assert(oldJob.metadata.name !== newJob.metadata.name, 'changed pod image retained an immutable Job identity');

for (const [job, expectedImage] of [[oldJob, oldTag], [newJob, newTag]]) {
  const image = `localhost/psfn-framework:${expectedImage}`;
  assert(
    job.spec?.template?.spec?.containers?.every(container => container.image === image),
    `${job.metadata.name} did not render image ${image}`,
  );
  const claim = job.spec?.template?.spec?.volumes
    ?.find(volume => volume.name === 'model-cache')
    ?.persistentVolumeClaim?.claimName;
  assert(claim === 'psfn-model-cache', `${job.metadata.name} did not preserve psfn-model-cache`);
}

const longReleaseJob = prefetchJob(render(oldTag, 'psfn-model-prefetch-name-length-boundary'));
assert(longReleaseJob?.metadata?.name.length <= 63, 'hashed model-prefetch Job name exceeds 63 characters');

const notesTemplate = readFileSync(resolve(chartDir, 'templates/NOTES.txt'), 'utf8');
const jobNameInclude = '{{ include "psfn.modelPrefetchJobName" . }}';
assert(notesTemplate.includes(`- Job: ${jobNameInclude}`), 'Helm NOTES reports a stale Job name');
assert(
  notesTemplate.includes(`job/${jobNameInclude} --timeout=30m`),
  'Helm NOTES wait command does not use the Job object\'s canonical name helper',
);

const setupScript = readFileSync(
  resolve(repoRoot, 'scripts/ops/setup-local-artemis-shakedown.sh'),
  'utf8',
);
assert(
  setupScript.includes('model-prefetch-job.sh" delete "$NAMESPACE" "$RELEASE"')
    && setupScript.includes('model-prefetch-job.sh" wait "$NAMESPACE" "$RELEASE"'),
  'local shakedown must resolve the hashed Job by release/component labels',
);

const shipScript = readFileSync(resolve(repoRoot, 'scripts/ops/ship-kube-update.sh'), 'utf8');
const lifecycleFunction = shipScript.indexOf('complete_model_prefetch_lifecycle()');
const helmSetsInitialization = shipScript.indexOf('HELM_SETS=()');
const lifecycleCall = shipScript.indexOf('complete_model_prefetch_lifecycle', helmSetsInitialization);
const helmUpgrade = shipScript.indexOf('helm upgrade psfn');
assert(
  lifecycleFunction >= 0
    && lifecycleCall >= helmSetsInitialization
    && lifecycleCall < helmUpgrade,
  'ship-kube-update must close completed prefetch before Helm upgrade',
);
for (const guard of [
  'app.kubernetes.io/component=model-prefetch',
  'modelPrefetch.enabled=false',
  'refusing to ship while model prefetch is incomplete',
  'PREFETCH_LIFECYCLE_CLOSED=1',
  'rkubectl rollout status deploy/psfn-gateway',
  'invalid Kubernetes namespace',
  'missing required command: jq',
]) {
  assert(shipScript.includes(guard), `ship-kube-update is missing lifecycle guard: ${guard}`);
}

console.log('Helm model-prefetch lifecycle verification passed.');
