#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments, stringify } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chartDir = join(repoRoot, 'deploy', 'helm', 'psfn');
const oldChartDir = join(repoRoot, 'scripts', 'fixtures', 'helm-owner-upgrade-old');
const configDir = join(repoRoot, 'config');
const namespace = 'psfn-owner-upgrade';
const clusterName = `psfn-owner-upgrade-${process.pid}`;
const kubectlContext = `k3d-${clusterName}`;
const workDir = mkdtempSync(join(tmpdir(), 'psfn-owner-upgrade-k3d-'));
const kubeconfigPath = join(workDir, 'kubeconfig.yaml');
const firstCompanionId = '11111111-1111-4111-8111-111111111111';
const secondCompanionId = '22222222-2222-4222-8222-222222222222';
const k3sImage = 'rancher/k3s@sha256:2074403abe1bded11ef3dde09d457e13be8e0b64c218b1c4f8269b4565cfbc65';
const toolPins = {
  k3d: {
    url: 'https://github.com/k3d-io/k3d/releases/download/v5.8.3/k3d-linux-amd64',
    sha256: 'dbaa79a76ace7f4ca230a1ff41dc7d8a5036a8ad0309e9c54f9bf3836dbe853e',
  },
  kubectl: {
    url: 'https://dl.k8s.io/release/v1.35.0/bin/linux/amd64/kubectl',
    sha256: 'a2e984a18a0c063279d692533031c1eff93a262afcc0afdc517375432d060989',
  },
  helm: {
    url: 'https://get.helm.sh/helm-v4.2.2-linux-amd64.tar.gz',
    sha256: '9adafecab4d406853bba163a70e9f104f47dbbf65ce24b7653bae7e36150bcb6',
  },
};

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 900_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (options.expectFailure) {
    if (result.status === 0) {
      throw new Error(`${file} ${args.join(' ')} unexpectedly succeeded`);
    }
    return `${result.stdout}${result.stderr}`;
  }
  if (result.status !== 0) {
    throw new Error(
      `${file} ${args.join(' ')} exited ${result.status}:\n${result.stderr}${result.stdout}`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function downloadPinned(url, expectedSha256, outputPath) {
  run('curl', ['--fail', '--silent', '--show-error', '--location', url, '--output', outputPath], {
    timeoutMs: 300_000,
  });
  const observed = sha256(readFileSync(outputPath));
  if (observed !== expectedSha256) {
    throw new Error(`Pinned download digest mismatch for ${url}: ${observed}`);
  }
}

function installPinnedTools() {
  const binDir = join(workDir, 'bin');
  run('mkdir', ['-p', binDir]);
  const k3dPath = join(binDir, 'k3d');
  const kubectlPath = join(binDir, 'kubectl');
  const helmArchive = join(workDir, 'helm.tar.gz');
  downloadPinned(toolPins.k3d.url, toolPins.k3d.sha256, k3dPath);
  downloadPinned(toolPins.kubectl.url, toolPins.kubectl.sha256, kubectlPath);
  downloadPinned(toolPins.helm.url, toolPins.helm.sha256, helmArchive);
  chmodSync(k3dPath, 0o755);
  chmodSync(kubectlPath, 0o755);
  run('tar', ['-xzf', helmArchive, '-C', workDir, 'linux-amd64/helm']);
  const helmPath = join(workDir, 'linux-amd64', 'helm');
  chmodSync(helmPath, 0o755);
  return { k3dPath, kubectlPath, helmPath };
}

const tools = installPinnedTools();
const kubeEnv = () => ({ ...process.env, KUBECONFIG: kubeconfigPath });

function kube(args, options = {}) {
  return run(tools.kubectlPath, ['--context', kubectlContext, ...args], {
    ...options,
    env: kubeEnv(),
  });
}

function helm(args, options = {}) {
  return run(tools.helmPath, args, { ...options, env: kubeEnv() });
}

function apply(value) {
  kube(['apply', '-f', '-'], { input: `${JSON.stringify(value)}\n` });
}

function pvc(name) {
  apply({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name, namespace },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '64Mi' } },
    },
  });
}

function writeValues(name, value) {
  const path = join(workDir, `${name}.yaml`);
  writeFileSync(path, stringify(value), 'utf8');
  return path;
}

function parseDocuments(value) {
  return parseAllDocuments(value).map(document => document.toJS()).filter(Boolean);
}

function certManagerCrd(plural, singular, kind) {
  return {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: { name: `${plural}.cert-manager.io` },
    spec: {
      group: 'cert-manager.io',
      scope: 'Namespaced',
      names: { plural, singular, kind },
      versions: [{
        name: 'v1',
        served: true,
        storage: true,
        schema: {
          openAPIV3Schema: {
            type: 'object',
            'x-kubernetes-preserve-unknown-fields': true,
          },
        },
      }],
    },
  };
}

const claims = {
  liveSystem: 'owner-live-system',
  liveOne: 'owner-live-one',
  liveTwo: 'owner-live-two',
  liveWorkspace: 'owner-live-workspace',
  liveRuntime: 'owner-live-runtime',
  backups: 'owner-backups',
  restoreSystem: 'owner-restore-system',
  restoreOne: 'owner-restore-one',
  restoreTwo: 'owner-restore-two',
};

const fleet = {
  companions: [
    {
      companionId: firstCompanionId,
      companionDataDir: 'companions/one',
      characterCardPath: 'companions/one/companion.json',
      postgresSchema: 'one',
    },
    {
      companionId: secondCompanionId,
      companionDataDir: 'companions/two',
      characterCardPath: 'companions/two/companion.json',
      postgresSchema: 'two',
    },
  ],
};

const charge = readFileSync(join(configDir, 'charge-policy.seed.json'), 'utf8')
  .replace('"interactive": 24', '"interactive": 27');
const skills = readFileSync(join(configDir, 'skills.seed.json'), 'utf8')
  .replace('"maxLoadedSkills": 32', '"maxLoadedSkills": 36');

function oldValues(image, mode, restore = false) {
  return {
    image,
    mode,
    expectedChargeQuota: 27,
    expectedMaxLoadedSkills: 36,
    runtime: {
      systemDataDir: '/runtime/system-data',
      companionDataDirs: ['/runtime/companions/one', '/runtime/companions/two'],
    },
    claims: {
      systemData: restore ? claims.restoreSystem : claims.liveSystem,
      companions: restore
        ? [claims.restoreOne, claims.restoreTwo]
        : [claims.liveOne, claims.liveTwo],
      backups: restore ? claims.backups : '',
    },
    fixture: {
      companionsJson: `${JSON.stringify(fleet, null, 2)}\n`,
      chargePolicyJson: charge,
      skillsJson: skills,
    },
    restore: {
      manifestPath: '/backups/pre-owner-migration/system-owner-fleet-snapshot.json',
      runtimeRoot: '/restore',
      systemDataDir: '/restore/system-data',
      companionDataDirs: ['/restore/companions/one', '/restore/companions/two'],
    },
  };
}

function finalValues(image, overrides = {}) {
  const secondClaim = overrides.secondClaim ?? claims.liveTwo;
  const secondMount = overrides.secondMount ?? '/runtime/companions/two';
  return {
    psfnAppImage: { ...image, gitCommit: 'owner-upgrade-e2e' },
    runtime: {
      companionId: firstCompanionId,
      systemDataDir: '/runtime/system-data',
      companionDataDir: '/runtime/companions/one',
      workspacePath: '/runtime/workspace',
      logsDir: '/runtime/run/logs',
      tempDir: '/runtime/run/tmp',
      backupsDir: '/runtime/run/backups',
      modelCacheDir: '/runtime/models',
      characterCardPath: '/runtime/companions/one/companion.json',
    },
    bootstrap: { seedOwnerFiles: overrides.seedOwnerFiles ?? false },
    ownerMigration: {
      required: overrides.required ?? true,
      enabled: overrides.enabled ?? true,
      runtimeRoot: '/runtime',
      systemDataDir: '/runtime/system-data',
      systemDataClaim: claims.liveSystem,
      backupsDir: '/backups',
      backupsClaim: claims.backups,
      snapshotOutputDir: `/backups/${overrides.snapshotName ?? 'pre-owner-migration'}`,
      activeDeadlineSeconds: 20,
      approvals: {
        'charge-policy.json': sha256(charge),
        'skills.json': sha256(skills),
      },
      companions: [
        {
          companionId: 'one',
          claimName: claims.liveOne,
          mountPath: '/runtime/companions/one',
          expectedIdentitySha256: sha256(Buffer.from(
            `${JSON.stringify({ fixtureIdentity: 'companion-1' })}\n`,
          )),
        },
        {
          companionId: 'two',
          claimName: secondClaim,
          mountPath: secondMount,
          expectedIdentitySha256: sha256(Buffer.from(
            `${JSON.stringify({ fixtureIdentity: 'companion-2' })}\n`,
          )),
        },
      ],
      verification: {
        enabled: true,
        initialChargeQuota: 27,
        initialMaxLoadedSkills: 36,
        timeoutSeconds: 15,
      },
    },
    workloads: {
      gateway: { replicaCount: 0 },
      agent: { replicaCount: 0 },
      garden: { replicaCount: 0 },
    },
    persistence: {
      systemData: { existingClaim: claims.liveSystem },
      companionData: { existingClaim: claims.liveOne },
      workspace: { existingClaim: claims.liveWorkspace },
      runtime: { existingClaim: claims.liveRuntime },
      modelCache: { enabled: false },
    },
    identity: { seedStarterCard: false },
    postgres: {
      enabled: false,
      external: {
        enabled: true,
        databaseUrlSecret: { name: 'owner-external-postgres', key: 'database-url' },
      },
    },
    redis: { enabled: false },
    liteLlm: { enabled: false },
    networkPolicy: { enabled: false },
    ingress: { enabled: false },
    modelPrefetch: { enabled: false },
  };
}

function installOldRelease(release, valuesPath) {
  try {
    helm([
      'install', release, oldChartDir,
      '--namespace', namespace,
      '--values', valuesPath,
      '--wait', '--timeout', '90s',
    ], { timeoutMs: 120_000 });
  } catch (error) {
    let diagnostics = '';
    try {
      diagnostics += kube(['get', 'pods', '-n', namespace, '-o', 'wide']);
      diagnostics += kube([
        'describe', 'deployment', `${release}-old-release`, '-n', namespace,
      ]);
      const pod = kube([
        'get', 'pods', '-n', namespace,
        '-l', `app.kubernetes.io/instance=${release}`,
        '-o', 'jsonpath={.items[0].metadata.name}',
      ]).trim();
      if (pod) {
        diagnostics += kube(['describe', 'pod', pod, '-n', namespace]);
        for (const container of ['seed-legacy-system-owners', 'old-release']) {
          try {
            diagnostics += kube(['logs', pod, '-n', namespace, '-c', container]);
          } catch {
            // Container may not have started; Pod status above remains authoritative.
          }
        }
      }
    } catch {
      // Preserve the Helm error if diagnostic collection itself fails.
    }
    throw new Error(`${String(error)}\nOld release diagnostics:\n${diagnostics}`);
  }
}

function upgradeFinal(release, valuesPath, expectFailure = false) {
  const args = [
    'upgrade', release, chartDir,
    '--namespace', namespace,
    '--values', valuesPath,
    '--rollback-on-failure', '--wait', '--wait-for-jobs', '--timeout', '35s',
  ];
  if (expectFailure) return helm(args, { expectFailure: true, timeoutMs: 60_000 });
  try {
    return helm(args, { timeoutMs: 60_000 });
  } catch (error) {
    let diagnostics = '';
    try {
      diagnostics += kube([
        'get', 'jobs,pods', '-n', namespace,
        '-l', 'app.kubernetes.io/component=owner-migration', '-o', 'wide',
      ]);
      const pod = kube([
        'get', 'pods', '-n', namespace,
        '-l', `app.kubernetes.io/instance=${release},app.kubernetes.io/component=owner-migration`,
        '-o', 'jsonpath={.items[0].metadata.name}',
      ]).trim();
      if (pod) {
        diagnostics += kube(['describe', 'pod', pod, '-n', namespace]);
        for (const container of [
          'snapshot-whole-fleet',
          'migrate-system-owner-fleet',
          'probe-0',
          'probe-1',
        ]) {
          try {
            diagnostics += `\n${container}:\n`;
            diagnostics += kube(['logs', pod, '-n', namespace, '-c', container]);
          } catch {
            // Container may not have started; Pod status above remains authoritative.
          }
        }
      }
    } catch {
      // Preserve the Helm error if diagnostic collection itself fails.
    }
    throw new Error(`${String(error)}\nOwner migration diagnostics:\n${diagnostics}`);
  }
}

function assertReleaseDeployed(release) {
  const status = JSON.parse(helm(['status', release, '--namespace', namespace, '--output', 'json']));
  if (status.info?.status !== 'deployed') {
    throw new Error(`${release} did not retain a deployed release: ${JSON.stringify(status.info)}`);
  }
}

function waitPodSucceeded(name) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const pod = JSON.parse(kube(['get', 'pod', name, '-n', namespace, '-o', 'json']));
    if (pod.status?.phase === 'Succeeded') return pod;
    if (pod.status?.phase === 'Failed') throw new Error(`${name} failed: ${JSON.stringify(pod.status)}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error(`${name} did not succeed before timeout`);
}

function assertHookProof(release, hookImage, imageDigest) {
  const hooks = parseDocuments(helm(['get', 'hooks', release, '--namespace', namespace]));
  const hook = hooks.find(document => (
    document.kind === 'Job'
    && document.metadata?.labels?.['app.kubernetes.io/component'] === 'owner-migration'
  ));
  if (!hook) throw new Error('Final release is missing the owner-migration Helm hook');
  const initContainers = hook.spec?.template?.spec?.initContainers ?? [];
  const containers = hook.spec?.template?.spec?.containers ?? [];
  if (initContainers.map(container => container.name).join(',')
      !== 'snapshot-whole-fleet,migrate-system-owner-fleet') {
    throw new Error(`Owner migration init ordering changed: ${JSON.stringify(initContainers)}`);
  }
  if (containers.map(container => container.name).join(',') !== 'probe-0,probe-1') {
    throw new Error(`Two packaged companion probes are required: ${JSON.stringify(containers)}`);
  }
  for (const probe of containers) {
    const ownerMount = probe.volumeMounts.find(mount => mount.name.startsWith('companion-'));
    if (!ownerMount?.readOnly) {
      throw new Error(`${probe.name} did not mount its companion owner root read-only`);
    }
  }
  for (const container of [...initContainers, ...containers]) {
    if (container.image !== hookImage) {
      throw new Error(`${container.name} did not use exact image ${hookImage}: ${container.image}`);
    }
  }
  const migration = initContainers[1];
  if (migration.command?.[1] !== '/app/dist/migrate-system-owner-fleet.js') {
    throw new Error('Helm hook did not execute the canonical compiled migration entrypoint');
  }
  const mounts = new Map(migration.volumeMounts.map(mount => [mount.name, mount.mountPath]));
  for (const [name, path] of [
    ['system-data', '/runtime/system-data'],
    ['companion-0', '/runtime/companions/one'],
    ['companion-1', '/runtime/companions/two'],
    ['backups', '/backups'],
  ]) {
    if (mounts.get(name) !== path) throw new Error(`Migration mount mismatch for ${name}: ${mounts.get(name)}`);
  }
  const pod = kube([
    'get', 'pods', '-n', namespace,
    '-l', `job-name=${hook.metadata.name}`,
    '-o', 'jsonpath={.items[0].metadata.name}',
  ]).trim();
  if (!pod) throw new Error(`Owner migration hook Pod is missing for ${hook.metadata.name}`);
  const podValue = JSON.parse(kube(['get', 'pod', pod, '-n', namespace, '-o', 'json']));
  for (const status of [
    ...(podValue.status?.initContainerStatuses ?? []),
    ...(podValue.status?.containerStatuses ?? []),
  ]) {
    if (status.state?.terminated?.exitCode !== 0) {
      throw new Error(`Hook container ${status.name} did not terminate successfully`);
    }
    if (!String(status.imageID).includes(imageDigest)) {
      throw new Error(`Hook container ${status.name} did not resolve ${hookImage}: ${status.imageID}`);
    }
  }
  for (const probe of ['probe-0', 'probe-1']) {
    const logs = kube(['logs', pod, '-n', namespace, '-c', probe]);
    if (!logs.includes('"status":"companion-ready"')) {
      throw new Error(`${probe} did not report packaged companion readiness: ${logs}`);
    }
  }
  return pod;
}

function assertFinalReleaseManifest(release, exactImage) {
  const manifest = parseDocuments(helm(['get', 'manifest', release, '--namespace', namespace]));
  const deployments = manifest.filter(document => document.kind === 'Deployment');
  for (const component of ['gateway', 'agent', 'garden']) {
    const deployment = deployments.find(value => value.metadata?.name === `${release}-${component}`);
    if (!deployment || deployment.spec?.replicas !== 0) {
      throw new Error(`Final chart did not admit the ${component} Deployment`);
    }
    const images = [
      ...(deployment.spec.template.spec.initContainers ?? []),
      ...(deployment.spec.template.spec.containers ?? []),
    ].map(container => container.image);
    if (!images.every(image => image === exactImage)) {
      throw new Error(`${component} did not render the immutable app image: ${images.join(',')}`);
    }
  }
  const pvcNames = manifest.filter(document => document.kind === 'PersistentVolumeClaim')
    .map(document => document.metadata?.name);
  if (pvcNames.some(name => [
    `${release}-system-data`,
    `${release}-companion-data`,
    `${release}-workspace`,
    `${release}-runtime`,
  ].includes(name))) {
    throw new Error(`Final release recreated externally provisioned owner PVCs: ${pvcNames.join(',')}`);
  }
  const values = JSON.parse(helm(['get', 'values', release, '--namespace', namespace, '--output', 'json']));
  if (values.bootstrap?.seedOwnerFiles !== false) {
    throw new Error('Final release did not persist bootstrap.seedOwnerFiles=false');
  }
}

function verifyLiveRootsUnchanged(hookImage) {
  const name = 'verify-live-roots-after-rollback';
  apply({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace },
    spec: {
      restartPolicy: 'Never',
      securityContext: { fsGroup: 999, fsGroupChangePolicy: 'OnRootMismatch' },
      containers: [{
        name: 'verify',
        image: hookImage,
        imagePullPolicy: 'Never',
        command: ['node', '-e', `
          const fs = require('node:fs');
          const path = require('node:path');
          for (const [root, identity] of [['/live/one','companion-1'],['/live/two','companion-2']]) {
            const charge = JSON.parse(fs.readFileSync(path.join(root, 'charge-policy.json')));
            const loadedSkills = JSON.parse(fs.readFileSync(path.join(root, 'skills.json')));
            if (charge.runChargeQuotaByLane.interactive !== 27 || loadedSkills.maxLoadedSkills !== 36
                || JSON.parse(fs.readFileSync(path.join(root, 'companion.json'), 'utf8')).fixtureIdentity !== identity) {
              throw new Error('Live root was overwritten during rollback: ' + root);
            }
          }
        `],
        volumeMounts: [
          { name: 'one', mountPath: '/live/one', readOnly: true },
          { name: 'two', mountPath: '/live/two', readOnly: true },
        ],
      }],
      volumes: [
        { name: 'one', persistentVolumeClaim: { claimName: claims.liveOne } },
        { name: 'two', persistentVolumeClaim: { claimName: claims.liveTwo } },
      ],
    },
  });
  waitPodSucceeded(name);
}

let clusterCreated = false;
let localImage;
let gatePassed = false;
try {
  run('docker', ['version'], { timeoutMs: 30_000 });
  run(tools.k3dPath, ['version'], { timeoutMs: 30_000 });
  run(tools.kubectlPath, ['version', '--client=true'], { timeoutMs: 30_000 });
  run(tools.helmPath, ['version', '--short'], { timeoutMs: 30_000 });

  const imageTag = 'dut9-9-proof';
  const imageRepository = 'docker.io/library/psfn-owner-upgrade-e2e';
  localImage = `${imageRepository}:${imageTag}`;
  run('docker', [
    'build',
    '--file', 'docker/Dockerfile.agent', '--tag', localImage,
    '--build-arg', 'PSFN_GIT_COMMIT=owner-upgrade-e2e', '.',
  ], { timeoutMs: 1_800_000 });
  const imageArchive = join(workDir, 'exact-image.tar');
  run('docker', ['save', '--output', imageArchive, localImage], { timeoutMs: 600_000 });
  const imageIndex = JSON.parse(run('tar', ['-xOf', imageArchive, 'index.json']));
  const imageDigest = imageIndex.manifests?.length === 1
    ? imageIndex.manifests[0]?.digest
    : undefined;
  if (typeof imageDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(imageDigest)) {
    throw new Error(`Built image did not expose one immutable OCI manifest: ${JSON.stringify(imageIndex)}`);
  }
  const image = {
    repository: imageRepository,
    tag: imageTag,
    digest: imageDigest,
    pullPolicy: 'Never',
  };
  const exactImage = `${localImage}@${imageDigest}`;
  const hookImage = `${imageRepository}@${imageDigest}`;

  run(tools.k3dPath, [
    'cluster', 'create', clusterName,
    '--image', k3sImage,
    '--servers', '1', '--agents', '0', '--wait',
  ], { timeoutMs: 600_000 });
  clusterCreated = true;
  writeFileSync(kubeconfigPath, run(tools.k3dPath, ['kubeconfig', 'get', clusterName]), 'utf8');
  run(tools.k3dPath, ['image', 'import', localImage, '--cluster', clusterName], {
    timeoutMs: 600_000,
  });
  for (const target of [hookImage]) {
    run('docker', [
      'exec', `k3d-${clusterName}-server-0`,
      'ctr', '--namespace', 'k8s.io', 'images', 'tag', localImage, target,
    ]);
  }
  kube(['create', 'namespace', namespace]);
  apply(certManagerCrd('issuers', 'issuer', 'Issuer'));
  apply(certManagerCrd('certificates', 'certificate', 'Certificate'));
  for (const claim of Object.values(claims)) pvc(claim);
  apply({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'owner-external-postgres', namespace },
    stringData: { 'database-url': 'postgresql://unused:unused@invalid/unused' },
  });

  const seedValuesPath = writeValues('old-seed', oldValues(image, 'seed'));
  for (const scenario of ['disabled', 'seed', 'missing', 'broken', 'wrong', 'proof']) {
    installOldRelease(`psfn-${scenario}`, seedValuesPath);
  }

  const disabledValues = writeValues('disabled', finalValues(image, {
    enabled: false,
    required: true,
  }));
  const disabledFailure = upgradeFinal('psfn-disabled', disabledValues, true);
  if (!disabledFailure.includes('ownerMigration.required=true requires ownerMigration.enabled=true')) {
    throw new Error(`Disabled owner migration did not fail closed: ${disabledFailure}`);
  }
  assertReleaseDeployed('psfn-disabled');

  const seedRelianceValues = writeValues('seed-reliance', finalValues(image, {
    seedOwnerFiles: true,
  }));
  const seedFailure = upgradeFinal('psfn-seed', seedRelianceValues, true);
  if (!seedFailure.includes('requires bootstrap.seedOwnerFiles=false')) {
    throw new Error(`Owner seed reliance did not fail closed: ${seedFailure}`);
  }
  assertReleaseDeployed('psfn-seed');

  const missingValues = writeValues('missing-pvc', finalValues(image, {
    secondClaim: 'owner-missing-two',
    snapshotName: 'negative-missing',
  }));
  upgradeFinal('psfn-missing', missingValues, true);
  assertReleaseDeployed('psfn-missing');

  const brokenImage = { ...image, digest: `sha256:${'0'.repeat(64)}` };
  const brokenValues = writeValues('broken-digest', finalValues(brokenImage, {
    snapshotName: 'negative-broken',
  }));
  upgradeFinal('psfn-broken', brokenValues, true);
  assertReleaseDeployed('psfn-broken');

  const wrongMountValues = writeValues('wrong-mount', finalValues(image, {
    secondMount: '/runtime/companions/not-two',
    snapshotName: 'negative-wrong-mount',
  }));
  upgradeFinal('psfn-wrong', wrongMountValues, true);
  assertReleaseDeployed('psfn-wrong');

  const proofValues = writeValues('proof', finalValues(image));
  upgradeFinal('psfn-proof', proofValues);
  assertReleaseDeployed('psfn-proof');
  assertFinalReleaseManifest('psfn-proof', exactImage);
  assertHookProof('psfn-proof', hookImage, imageDigest);

  const restoreValuesPath = writeValues('old-restore', oldValues(image, 'restore', true));
  helm([
    'upgrade', 'psfn-proof', oldChartDir,
    '--namespace', namespace,
    '--values', restoreValuesPath,
    '--atomic', '--wait', '--timeout', '90s',
  ], { timeoutMs: 120_000 });
  assertReleaseDeployed('psfn-proof');
  const rollbackRelease = JSON.parse(helm([
    'list', '--namespace', namespace, '--filter', '^psfn-proof$', '--output', 'json',
  ]));
  if (rollbackRelease[0]?.chart !== 'psfn-0.0.1') {
    throw new Error(`Whole-fleet rollback did not restore the old chart: ${JSON.stringify(rollbackRelease)}`);
  }
  kube([
    'rollout', 'status', 'deployment/psfn-proof-old-release',
    '-n', namespace, '--timeout=60s',
  ]);
  verifyLiveRootsUnchanged(hookImage);

  console.log(`Real Helm owner upgrade and whole-fleet rollback passed with ${exactImage}.`);
  gatePassed = true;
} finally {
  if (clusterCreated) {
    try {
      run(tools.k3dPath, ['cluster', 'delete', clusterName], { timeoutMs: 300_000 });
    } catch {
      // Preserve the primary gate error; k3d deletion is best-effort cleanup.
    }
  }
  if (localImage && gatePassed) {
    try {
      run('docker', ['image', 'rm', '--force', localImage], { timeoutMs: 120_000 });
    } catch {
      // Preserve the primary gate error; the content-addressed test image is disposable.
    }
  }
  rmSync(workDir, { recursive: true, force: true });
}
