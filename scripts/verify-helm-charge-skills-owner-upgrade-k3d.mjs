#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chartDir = join(repoRoot, 'deploy', 'helm', 'psfn');
const configDir = join(repoRoot, 'config');
const kubectlContext = `k3d-psfn-owner-upgrade-${process.pid}`;
const clusterName = `psfn-owner-upgrade-${process.pid}`;
const namespace = 'psfn-owner-upgrade';
const k3d = process.env.K3D_BIN?.trim() || 'k3d';
const firstCompanionId = '11111111-1111-4111-8111-111111111111';
const secondCompanionId = '22222222-2222-4222-8222-222222222222';
const workDir = mkdtempSync(join(tmpdir(), 'psfn-owner-upgrade-k3d-'));
const localImage = `psfn-owner-upgrade-e2e:${randomUUID()}`;
const kubeconfigPath = join(workDir, 'kubeconfig.yaml');

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
  if (result.status !== (options.expectedStatus ?? 0)) {
    throw new Error(
      `${file} ${args.join(' ')} exited ${result.status}:\n${result.stderr}${result.stdout}`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}

function kube(args, options = {}) {
  return run('kubectl', ['--context', kubectlContext, ...args], {
    ...options,
    env: { ...process.env, KUBECONFIG: kubeconfigPath },
  });
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

const volumeClaims = {
  system: 'system-data',
  one: 'companion-one',
  two: 'companion-two',
  backups: 'owner-backups',
  restoreSystem: 'restore-system-data',
  restoreOne: 'restore-companion-one',
  restoreTwo: 'restore-companion-two',
};

function persistentMounts(includeSecond = true, restore = false) {
  if (restore) {
    return [
      ['backups', volumeClaims.backups, '/backups'],
      ['restore-system', volumeClaims.restoreSystem, '/restore/system-data'],
      ['restore-one', volumeClaims.restoreOne, '/restore/companions/one'],
      ['restore-two', volumeClaims.restoreTwo, '/restore/companions/two'],
    ];
  }
  return [
    ['system', volumeClaims.system, '/runtime/system-data'],
    ['one', volumeClaims.one, '/runtime/companions/one'],
    ...(includeSecond ? [['two', volumeClaims.two, '/runtime/companions/two']] : []),
    ['backups', volumeClaims.backups, '/backups'],
  ];
}

function job(name, image, command, input = {}) {
  const mounts = input.mounts ?? persistentMounts();
  apply({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace },
    spec: {
      backoffLimit: 0,
      template: {
        metadata: { labels: { app: name } },
        spec: {
          restartPolicy: 'Never',
          securityContext: { fsGroup: 999, fsGroupChangePolicy: 'OnRootMismatch' },
          containers: [{
            name: 'proof',
            image,
            imagePullPolicy: input.imagePullPolicy ?? 'Never',
            command,
            env: Object.entries(input.env ?? {}).map(([key, value]) => ({
              name: key,
              value: String(value),
            })),
            volumeMounts: [
              ...mounts.map(([volumeName, , mountPath]) => ({ name: volumeName, mountPath })),
              { name: 'scratch', mountPath: '/scratch' },
            ],
          }],
          volumes: [
            ...mounts.map(([volumeName, claimName]) => ({
              name: volumeName,
              persistentVolumeClaim: { claimName },
            })),
            { name: 'scratch', emptyDir: {} },
          ],
        },
      },
    },
  });
}

function jobLogs(name) {
  return kube(['logs', `job/${name}`, '-n', namespace], { expectedStatus: 0 });
}

function waitJob(name, condition = 'complete') {
  try {
    kube([
      'wait', `job/${name}`, '-n', namespace,
      `--for=condition=${condition}`, '--timeout=240s',
    ], { timeoutMs: 260_000 });
  } catch (error) {
    let details = '';
    try { details = jobLogs(name); } catch { /* preserve primary error */ }
    throw new Error(`${String(error)}\n${details}`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function runtimeEnv(companionId = firstCompanionId, companionRoot = '/runtime/companions/one') {
  return {
    NODE_ENV: 'production',
    PSFN_RUNTIME_LAYOUT_MODE: 'production',
    PSFN_RUNTIME_ROOT: '/runtime',
    SYSTEM_DATA_DIR: '/runtime/system-data',
    COMPANION_DATA_DIR: companionRoot,
    WORKSPACE_PATH: '/scratch/workspace',
    PSFN_LOGS_DIR: '/scratch/logs',
    PSFN_TEMP_DIR: '/scratch/tmp',
    BACKUP_ROOT_DIR: '/backups',
    CONFIG_DIR: '/app/config',
    PSFN_MULTI_COMPANION: 'true',
    PSFN_FLEET_AUTH: 'false',
    DATA_DIR: '',
    COMPANION_ID: companionId,
    CHARACTER_CARD_PATH: `${companionRoot}/companion.json`,
    COMPANION_PG_SCHEMA: companionId === firstCompanionId ? 'one' : 'two',
    POSTGRES_DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:5432/fixture',
  };
}

function renderedStartupCommand(image, companionId, companionRoot) {
  const separator = image.lastIndexOf('@');
  const tagged = image.slice(0, separator);
  const slash = tagged.lastIndexOf('/');
  const colon = tagged.lastIndexOf(':');
  const repository = colon > slash ? tagged.slice(0, colon) : tagged;
  const tag = colon > slash ? tagged.slice(colon + 1) : '';
  const digest = image.slice(separator + 1);
  const rendered = run('helm', [
    'template', 'psfn', chartDir, '--namespace', namespace,
    '--set-string', 'runtime.systemDataDir=/runtime/system-data',
    '--set-string', `runtime.companionDataDir=${companionRoot}`,
    '--set-string', `runtime.companionId=${companionId}`,
    '--set-string', `runtime.characterCardPath=${companionRoot}/companion.json`,
    '--set-string', 'runtime.workspacePath=/scratch/workspace',
    '--set-string', 'runtime.logsDir=/scratch/logs',
    '--set-string', 'runtime.tempDir=/scratch/tmp',
    '--set-string', 'runtime.backupsDir=/backups',
    '--set-string', 'runtime.modelCacheDir=/scratch/models',
    '--set-string', 'runtime.configDir=/app/config',
    '--set-string', `psfnAppImage.repository=${repository}`,
    '--set-string', `psfnAppImage.tag=${tag}`,
    '--set-string', `psfnAppImage.digest=${digest}`,
    '--set-string', 'psfnAppImage.pullPolicy=Never',
    '--set', 'bootstrap.seedOwnerFiles=false',
  ]);
  const deployment = parseAllDocuments(rendered)
    .map(document => document.toJS())
    .find(value => value?.kind === 'Deployment' && value?.metadata?.name === 'psfn-agent');
  const init = deployment?.spec?.template?.spec?.initContainers
    ?.find(container => container.name === 'seed-runtime-files');
  if (init?.image !== image || init?.command?.[0] !== 'sh' || init?.command?.[1] !== '-c') {
    throw new Error('Rendered Helm startup did not bind the exact immutable proof image');
  }
  return init.command[2];
}

function exactK3sImage() {
  const tag = 'rancher/k3s:v1.35.5-k3s1';
  run('docker', ['pull', tag]);
  const digest = run('docker', [
    'image', 'inspect', tag, '--format', '{{index .RepoDigests 0}}',
  ]).trim();
  if (!/^(?:docker\.io\/)?rancher\/k3s@sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new Error(`Unable to resolve immutable k3s image: ${digest}`);
  }
  return digest;
}

let clusterCreated = false;
try {
  run(k3d, ['version'], { timeoutMs: 30_000 });
  run('kubectl', ['version', '--client'], { timeoutMs: 30_000 });
  run('helm', ['version', '--short'], { timeoutMs: 30_000 });
  run('docker', ['version'], { timeoutMs: 30_000 });
  run('docker', [
    'buildx', 'build', '--load',
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
    throw new Error(`Docker archive did not contain one immutable OCI manifest: ${JSON.stringify(imageIndex)}`);
  }
  const exactImage = `${localImage}@${imageDigest}`;

  run(k3d, [
    'cluster', 'create', clusterName,
    '--image', exactK3sImage(),
    '--servers', '1', '--agents', '0', '--wait',
  ], { timeoutMs: 600_000 });
  clusterCreated = true;
  writeFileSync(kubeconfigPath, run(k3d, ['kubeconfig', 'get', clusterName]), 'utf8');
  run(k3d, ['image', 'import', localImage, '--cluster', clusterName], { timeoutMs: 600_000 });
  run('docker', [
    'exec', `k3d-${clusterName}-server-0`,
    'ctr', '-n', 'k8s.io', 'images', 'tag',
    `docker.io/library/${localImage}`,
    `docker.io/library/${localImage.slice(0, localImage.lastIndexOf(':'))}@${imageDigest}`,
  ]);
  kube(['create', 'namespace', namespace]);
  for (const claimName of Object.values(volumeClaims)) pvc(claimName);

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
  const setupJs = `
    const fs = require('node:fs');
    const path = require('node:path');
    const system = '/runtime/system-data';
    const roots = ['/runtime/companions/one', '/runtime/companions/two'];
    fs.writeFileSync(path.join(system, 'companions.json'), Buffer.from(process.env.FLEET_B64, 'base64'));
    for (const owner of ['settings','models','providers','trust-policy','backup','intake-policy']) {
      fs.copyFileSync('/app/config/' + owner + '.seed.json', path.join(system, owner + '.json'));
    }
    fs.writeFileSync(path.join(system, 'charge-policy.json'), Buffer.from(process.env.CHARGE_B64, 'base64'));
    fs.writeFileSync(path.join(system, 'skills.json'), Buffer.from(process.env.SKILLS_B64, 'base64'));
    roots.forEach((root, index) => {
      fs.copyFileSync('/app/config/scheduler.seed.json', path.join(root, 'scheduler.json'));
      fs.copyFileSync('/app/config/capability-tier.seed.json', path.join(root, 'capability-tier.json'));
      fs.writeFileSync(path.join(root, 'identity.txt'), 'companion-' + (index + 1) + '\\n');
    });
  `;
  job('seed-old-release', exactImage, ['node', '-e', setupJs], {
    env: {
      FLEET_B64: Buffer.from(`${JSON.stringify(fleet, null, 2)}\n`).toString('base64'),
      CHARGE_B64: Buffer.from(charge).toString('base64'),
      SKILLS_B64: Buffer.from(skills).toString('base64'),
    },
  });
  waitJob('seed-old-release');

  job(
    'capture-pre-migration',
    exactImage,
    ['node', '/app/dist/system-owner-fleet-snapshot.js', 'capture', '--output', '/backups/pre-migration'],
    { env: runtimeEnv() },
  );
  waitJob('capture-pre-migration');

  const migrationArgs = [
    'node', '/app/dist/migrate-system-owner-fleet.js', '--apply',
    '--approve', `charge-policy.json=${sha256(charge)}`,
    '--approve', `skills.json=${sha256(skills)}`,
  ];
  job('missing-pvc-root-refusal', exactImage, migrationArgs, {
    env: runtimeEnv(),
    mounts: persistentMounts(false),
  });
  waitJob('missing-pvc-root-refusal', 'failed');
  job('inspect-zero-mutation', exactImage, ['node', '-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    for (const owner of ['charge-policy.json','skills.json']) {
      if (!fs.existsSync(path.join('/runtime/system-data', owner))) throw new Error('source missing ' + owner);
      if (fs.existsSync(path.join('/runtime/companions/one', owner))) throw new Error('destination written ' + owner);
    }
    if (fs.existsSync('/runtime/system-data/migrations')) throw new Error('receipt/quarantine created');
    if (fs.readdirSync('/runtime/companions/one').some(name => name.includes('.system-owner-fleet-reroot-'))) {
      throw new Error('staging created');
    }
  `], { mounts: persistentMounts(false) });
  waitJob('inspect-zero-mutation');

  job('migrate-old-owners', exactImage, migrationArgs, { env: runtimeEnv() });
  waitJob('migrate-old-owners');

  job('evolve-distinct-owners', exactImage, ['node', '-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const values = [['/runtime/companions/one',31,41],['/runtime/companions/two',32,42]];
    for (const [root, quota, maxSkills] of values) {
      const chargePath = path.join(root, 'charge-policy.json');
      const chargeValue = JSON.parse(fs.readFileSync(chargePath, 'utf8'));
      chargeValue.runChargeQuotaByLane.interactive = quota;
      fs.writeFileSync(chargePath + '.next', JSON.stringify(chargeValue, null, 2) + '\\n');
      fs.renameSync(chargePath + '.next', chargePath);
      const skillsPath = path.join(root, 'skills.json');
      const skillsValue = JSON.parse(fs.readFileSync(skillsPath, 'utf8'));
      skillsValue.maxLoadedSkills = maxSkills;
      fs.writeFileSync(skillsPath + '.next', JSON.stringify(skillsValue, null, 2) + '\\n');
      fs.renameSync(skillsPath + '.next', skillsPath);
    }
  `]);
  waitJob('evolve-distinct-owners');

  for (const [name, companionId, root, expectedQuota, expectedSkills] of [
    ['one', firstCompanionId, '/runtime/companions/one', 31, 41],
    ['two', secondCompanionId, '/runtime/companions/two', 32, 42],
  ]) {
    const verifyJs = `
      const fs = require('node:fs');
      const path = require('node:path');
      const root = process.env.COMPANION_DATA_DIR;
      const quota = JSON.parse(fs.readFileSync(path.join(root, 'charge-policy.json'), 'utf8')).runChargeQuotaByLane.interactive;
      const skills = JSON.parse(fs.readFileSync(path.join(root, 'skills.json'), 'utf8')).maxLoadedSkills;
      if (quota !== Number(process.env.EXPECTED_QUOTA) || skills !== Number(process.env.EXPECTED_SKILLS)) {
        throw new Error('distinct owner read mismatch: ' + quota + '/' + skills);
      }
    `;
    const startup = renderedStartupCommand(exactImage, companionId, root);
    job(`helm-startup-${name}`, exactImage, [
      'sh', '-c', `${startup}\nnode /app/dist/preflight-startup-owner-files.js\nnode -e "$VERIFY_JS"`,
    ], {
      env: {
        ...runtimeEnv(companionId, root),
        VERIFY_JS: verifyJs,
        EXPECTED_QUOTA: expectedQuota,
        EXPECTED_SKILLS: expectedSkills,
      },
    });
    waitJob(`helm-startup-${name}`);
  }

  job('restore-pre-migration', exactImage, [
    'node', '/app/dist/system-owner-fleet-snapshot.js', 'restore',
    '--manifest', '/backups/pre-migration/system-owner-fleet-snapshot.json',
    '--restore-runtime-root', '/restore',
  ], { mounts: persistentMounts(true, true) });
  waitJob('restore-pre-migration');
  job('verify-restored-old-release', exactImage, ['node', '-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    for (const owner of ['charge-policy.json','skills.json']) {
      if (!fs.existsSync(path.join('/restore/system-data', owner))) throw new Error('restored source missing ' + owner);
      for (const root of ['/restore/companions/one','/restore/companions/two']) {
        if (fs.existsSync(path.join(root, owner))) throw new Error('fan-out survived rollback ' + owner);
      }
    }
    if (fs.existsSync('/restore/system-data/migrations')) throw new Error('migration receipt survived rollback');
    if (fs.readFileSync('/restore/companions/one/identity.txt','utf8') !== 'companion-1\\n') throw new Error('one state mismatch');
    if (fs.readFileSync('/restore/companions/two/identity.txt','utf8') !== 'companion-2\\n') throw new Error('two state mismatch');
  `], { mounts: persistentMounts(true, true) });
  waitJob('verify-restored-old-release');

  const missingImage = `${localImage}@sha256:${'0'.repeat(64)}`;
  job('broken-immutable-image', missingImage, ['node', '-e', 'process.exit(0)'], {
    mounts: [],
    imagePullPolicy: 'Never',
  });
  const deadline = Date.now() + 60_000;
  let brokenReason = '';
  while (Date.now() < deadline) {
    const raw = kube([
      'get', 'pods', '-n', namespace, '-l', 'job-name=broken-immutable-image', '-o', 'json',
    ]);
    const pods = JSON.parse(raw);
    brokenReason = pods.items?.[0]?.status?.containerStatuses?.[0]?.state?.waiting?.reason ?? '';
    if (brokenReason === 'ErrImageNeverPull' || brokenReason === 'ImagePullBackOff') break;
    run('sh', ['-c', 'sleep 2']);
  }
  if (brokenReason !== 'ErrImageNeverPull' && brokenReason !== 'ImagePullBackOff') {
    throw new Error(`Broken immutable image did not fail closed: ${brokenReason || 'no waiting reason'}`);
  }
  console.log(`Kubernetes owner upgrade verification passed with exact image ${exactImage}.`);
} finally {
  if (clusterCreated) {
    try { run(k3d, ['cluster', 'delete', clusterName], { timeoutMs: 300_000 }); } catch { /* best effort */ }
  }
  try { run('docker', ['image', 'rm', '--force', localImage], { timeoutMs: 120_000 }); } catch { /* best effort */ }
  rmSync(workDir, { recursive: true, force: true });
}
