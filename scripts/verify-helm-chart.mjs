#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { verifyFleetGatewayCompanionMountContract } from './verify-helm-fleet-gateway-mounts.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chartDir = resolve(repoRoot, 'deploy/helm/psfn');
const ownerUpgradeGatePath = resolve(
  repoRoot,
  'scripts/verify-helm-charge-skills-owner-upgrade-k3d.mjs',
);
const recoveryChartDigest = readFileSync(
  resolve(chartDir, 'recovery-chart.sha256'),
  'utf8',
).trim();

const nonFleetContractRenderArgs = [
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
];

function assertRealOwnerUpgradeGate() {
  const gate = readFileSync(ownerUpgradeGatePath, 'utf8');
  assertIncludes(gate, 'installOldRelease(', 'owner-upgrade Helm install');
  assertIncludes(gate, 'upgradeFinal(', 'owner-upgrade Helm upgrade');
  assertIncludes(gate, 'required: true', 'required owner migration');
  assertIncludes(
    gate,
    'seedOwnerFiles: overrides.seedOwnerFiles ?? false',
    'owner seeding disabled',
  );
  assertNotIncludes(gate, 'renderedStartupCommand(', 'extracted init command surrogate');
  assertNotIncludes(gate, 'helm-startup-', 'standalone Helm startup Job surrogate');
}

function renderHelm(args = []) {
  return execFileSync('helm', [
    'template',
    'psfn',
    chartDir,
    '--namespace',
    'psfn-test',
    ...args,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function render(args = []) {
  return renderHelm(['--skip-schema-validation', ...nonFleetContractRenderArgs, ...args]);
}

function assertRenderFails(args, expectedMessage) {
  try {
    render(args);
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    assertIncludes(output, expectedMessage, 'Helm validation failure');
    return;
  }

  throw new Error(`Helm render unexpectedly succeeded: ${args.join(' ')}`);
}

function assertDefaultFleetRenderFails(args, expectedMessage) {
  try {
    renderHelm(args);
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    assertIncludes(output, expectedMessage, 'default Fleet Helm validation failure');
    return;
  }

  throw new Error(`Default Fleet Helm render unexpectedly succeeded: ${args.join(' ')}`);
}

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label} missing: ${needle}`);
  }
}

function assertNotIncludes(haystack, needle, label) {
  if (haystack.includes(needle)) {
    throw new Error(`${label} unexpectedly contains: ${needle}`);
  }
}

function documents(rendered) {
  return rendered
    .split(/^---$/m)
    .map(doc => doc.trim())
    .filter(Boolean);
}

function findDocument(rendered, name) {
  return documents(rendered).find(doc => doc.includes(`\n  name: ${name}\n`)) ?? '';
}

function findDocumentsByKind(rendered, kind) {
  return documents(rendered).filter(doc => doc.includes(`kind: ${kind}\n`));
}

function findDocumentByKindName(rendered, kind, name) {
  return documents(rendered).find(doc => (
    doc.includes(`kind: ${kind}\n`) &&
    doc.includes(`\n  name: ${name}\n`)
  )) ?? '';
}

function findParsedDocumentByKindName(rendered, kind, name) {
  return parseAllDocuments(rendered)
    .map(document => document.toJS())
    .find(document => document?.kind === kind && document?.metadata?.name === name);
}

function parseRenderedDocuments(rendered, label) {
  const parsed = parseAllDocuments(rendered);
  const errors = parsed.flatMap(document => document.errors);
  if (errors.length > 0) {
    throw new Error(`${label} contains malformed YAML: ${errors[0].message}`);
  }
  return parsed.map(document => document.toJS()).filter(Boolean);
}

function assertContainerVolumeMount(deployment, containerField, containerName, expected, label) {
  const container = deployment?.spec?.template?.spec?.[containerField]
    ?.find(candidate => candidate.name === containerName);
  if (!container) {
    throw new Error(`${label} container missing: ${containerName}`);
  }
  const mount = container.volumeMounts?.find(candidate => candidate.name === expected.name);
  if (!mount
    || mount.mountPath !== expected.mountPath
    || mount.subPath !== expected.subPath) {
    throw new Error(
      `${label} must mount ${expected.name} at ${expected.mountPath} with subPath ${expected.subPath}`,
    );
  }
}

function assertSharedWorkspaceBootstrap(deployment, label) {
  const initContainers = deployment?.spec?.template?.spec?.initContainers ?? [];
  const bootstrapIndex = initContainers.findIndex(
    container => container.name === 'bootstrap-shared-workspace',
  );
  if (bootstrapIndex !== 0) {
    throw new Error(`${label} shared workspace bootstrap must be the first init container`);
  }

  const bootstrap = initContainers[bootstrapIndex];
  const runtimeMount = bootstrap.volumeMounts?.find(mount => mount.name === 'runtime');
  if (!runtimeMount
    || runtimeMount.mountPath !== '/bootstrap/runtime'
    || Object.hasOwn(runtimeMount, 'subPath')
    || runtimeMount.readOnly !== false) {
    throw new Error(
      `${label} shared workspace bootstrap must mount the runtime PVC root writable at /bootstrap/runtime`,
    );
  }

  const command = bootstrap.command;
  if (!Array.isArray(command)
    || command[0] !== 'sh'
    || command[1] !== '-c'
    || command[2]?.trim() !== 'set -eu\nmkdir -p /bootstrap/runtime/workspaces-shared') {
    throw new Error(
      `${label} shared workspace bootstrap must create only workspaces-shared`,
    );
  }

  const seedIndex = initContainers.findIndex(container => container.name === 'seed-runtime-files');
  if (seedIndex >= 0 && bootstrapIndex >= seedIndex) {
    throw new Error(`${label} shared workspace bootstrap must run before owner seeding`);
  }
}

function assertContainerEnvNames(deployment, containerName, expectedNames, label) {
  const container = deployment?.spec?.template?.spec?.containers
    ?.find(candidate => candidate.name === containerName);
  if (!container) {
    throw new Error(`${label} container missing: ${containerName}`);
  }
  const actualNames = new Set((container.env ?? []).map(entry => entry.name));
  for (const expectedName of expectedNames) {
    if (!actualNames.has(expectedName)) {
      throw new Error(`${label} env missing: ${expectedName}`);
    }
  }
}

function renderedSeedCommand(rendered) {
  const commands = [];
  for (const deploymentName of ['psfn-agent', 'psfn-gateway', 'psfn-garden']) {
    const deployment = findParsedDocumentByKindName(rendered, 'Deployment', deploymentName);
    const initContainer = deployment?.spec?.template?.spec?.initContainers
      ?.find(container => container.name === 'seed-runtime-files');
    const command = initContainer?.command;
    if (!Array.isArray(command) || command[0] !== 'sh' || command[1] !== '-c') {
      throw new Error(
        `${deploymentName} seed-runtime-files init command is not a rendered sh -c command`,
      );
    }
    const mounts = new Map(
      (initContainer.volumeMounts ?? []).map(mount => [mount.name, mount]),
    );
    for (const volumeName of ['system-data', 'companion-data']) {
      const mount = mounts.get(volumeName);
      if (!mount || mount.readOnly === true) {
        throw new Error(
          `${deploymentName} seed-runtime-files must mount ${volumeName} writable`,
        );
      }
    }
    commands.push(command[2]);
  }
  if (commands.some(command => command !== commands[0])) {
    throw new Error('agent, gateway, and Garden owner migration commands differ');
  }
  return commands[0];
}

function renderOwnerMigrationFixture(rootDir, seedOwnerFiles) {
  const systemDataDir = join(rootDir, 'system-data');
  const companionDataDir = join(rootDir, 'companion-data');
  mkdirSync(systemDataDir, { recursive: true });
  writeFileSync(join(systemDataDir, 'companions.json'), JSON.stringify({
    companions: [{
      companionId: '11111111-1111-4111-8111-111111111111',
      companionDataDir: 'companion-data',
      characterCardPath: 'companion-data/companion.json',
      postgresSchema: 'companion_default',
    }],
  }));
  if (!seedOwnerFiles) {
    writeFileSync(
      join(systemDataDir, 'settings.json'),
      readFileSync(resolve(repoRoot, 'config/settings.seed.json'), 'utf8'),
      'utf8',
    );
  }
  const renderedFixture = render([
    '--set-string', `runtime.systemDataDir=${systemDataDir}`,
    '--set-string', `runtime.companionDataDir=${companionDataDir}`,
    '--set-string', `runtime.workspacePath=${join(rootDir, 'workspace')}`,
    '--set-string', `runtime.logsDir=${join(rootDir, 'runtime', 'logs')}`,
    '--set-string', `runtime.tempDir=${join(rootDir, 'runtime', 'tmp')}`,
    '--set-string', `runtime.backupsDir=${join(rootDir, 'runtime', 'backups')}`,
    '--set-string', `runtime.modelCacheDir=${join(rootDir, 'models')}`,
    '--set-string', `runtime.configDir=${resolve(repoRoot, 'config')}`,
    '--set-string', `runtime.characterCardPath=${join(companionDataDir, 'companion.json')}`,
    '--set', `bootstrap.seedOwnerFiles=${seedOwnerFiles}`,
  ]);
  const containerMigrationCommand = 'node /app/dist/migrate-scheduler-owner.js';
  const containerSettingsMigrationCommand =
    'node /app/dist/migrate-required-settings-blocks.js';
  const testMigrationCommand = [
    process.execPath,
    '--import',
    'tsx',
    resolve(repoRoot, 'src/app/maintenance/migrate-scheduler-owner.ts'),
  ].join(' ');
  const testSettingsMigrationCommand = [
    process.execPath,
    '--import',
    'tsx',
    resolve(repoRoot, 'src/app/maintenance/migrate-required-settings-blocks.ts'),
  ].join(' ');
  return {
    command: renderedSeedCommand(renderedFixture)
      .replaceAll(containerMigrationCommand, testMigrationCommand)
      .replaceAll(containerSettingsMigrationCommand, testSettingsMigrationCommand),
    systemDataDir,
    companionDataDir,
  };
}

function ownerMigrationRenderArgs(companions = [
  {
    companionId: 'one',
    claimName: 'owner-one',
    mountPath: '/runtime/companions/one',
    expectedIdentitySha256: '1'.repeat(64),
  },
  {
    companionId: 'two',
    claimName: 'owner-two',
    mountPath: '/runtime/companions/two',
    expectedIdentitySha256: '2'.repeat(64),
  },
], approvals = {
  'charge-policy.json': 'a'.repeat(64),
  'skills.json': 'b'.repeat(64),
}) {
  return [
    '--set', 'ownerMigration.required=true',
    '--set', 'ownerMigration.enabled=true',
    '--set-string', 'ownerMigration.systemDataClaim=owner-system',
    '--set-string', 'ownerMigration.backupsClaim=owner-backups',
    '--set-json', `ownerMigration.approvals=${JSON.stringify(approvals)}`,
    '--set-json', `ownerMigration.companions=${JSON.stringify(companions)}`,
    '--set', 'ownerMigration.verification.enabled=true',
    '--set', 'ownerMigration.verification.initialChargeQuota=27',
    '--set', 'ownerMigration.verification.initialMaxLoadedSkills=36',
    '--set-string', `psfnAppImage.digest=sha256:${'d'.repeat(64)}`,
    '--set-string', 'persistence.systemData.existingClaim=owner-system',
    '--set-string', 'persistence.companionData.existingClaim=owner-one',
    '--set-string', 'persistence.workspace.existingClaim=owner-workspace',
    '--set-string', 'persistence.runtime.existingClaim=owner-runtime',
    '--set', 'persistence.modelCache.enabled=false',
  ];
}

const fleetGardenCompanions = [
  {
    companionId: '11111111-1111-4111-8111-111111111111',
    postgresSchema: 'companion_a',
    companionDataClaim: 'companion-a-data',
    workspaceClaim: 'companion-a-workspace',
    authSecret: {
      name: 'companion-a-auth',
      sessionIntegrityKey: 'session-integrity-token',
      companionAuthKey: 'companion-auth-token',
    },
  },
  {
    companionId: '22222222-2222-4222-8222-222222222222',
    postgresSchema: 'companion_b',
    companionDataClaim: 'companion-b-data',
    workspaceClaim: 'companion-b-workspace',
    authSecret: {
      name: 'companion-b-auth',
      sessionIntegrityKey: 'session-integrity-token',
      companionAuthKey: 'companion-auth-token',
    },
  },
];

function fleetGardenRenderArgs(companions = fleetGardenCompanions) {
  const first = companions[0];
  return [
    '--set', 'fleet.enabled=true',
    '--set-json', `fleet.companions=${JSON.stringify(companions)}`,
    '--set', 'fleetAuth.enabled=true',
    '--set', 'ingress.gateway.tls.enabled=true',
    '--set-string', 'ingress.gateway.tls.secretName=fleet-gateway-tls',
    '--set-string', `runtime.companionId=${first?.companionId ?? ''}`,
    '--set-string', `runtime.companionDataDir=/runtime/companions/${first?.companionId ?? ''}`,
    '--set-string', `runtime.characterCardPath=/runtime/companions/${first?.companionId ?? ''}/companion.json`,
    '--set-string', `runtime.workspacePath=/runtime/workspaces/personal/${first?.companionId ?? ''}`,
    '--set-string', 'runtime.systemDataDir=/runtime/system-data',
    '--set-string', 'runtime.logsDir=/runtime/logs',
    '--set-string', 'runtime.tempDir=/runtime/tmp',
    '--set-string', 'runtime.backupsDir=/runtime/backups',
    '--set-string', `persistence.companionData.existingClaim=${first?.companionDataClaim ?? ''}`,
    '--set-string', `persistence.workspace.existingClaim=${first?.workspaceClaim ?? ''}`,
  ];
}

function renderFleetOwnerUpgradeHook() {
  return render(ownerMigrationRenderArgs());
}

function runOwnerMigrationCommand(command, expectedStatus = 0) {
  const result = spawnSync('sh', ['-c', command], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== expectedStatus) {
    throw new Error(
      `owner migration command exit ${result.status}, expected ${expectedStatus}: `
      + `${result.stderr}${result.stdout}`,
    );
  }
  return `${result.stderr}${result.stdout}`;
}

function runOwnerMigrationCommandAsync(command) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('sh', ['-c', command], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', status => {
      if (status !== 0) {
        reject(new Error(`concurrent owner migration exited ${status}: ${output}`));
        return;
      }
      resolvePromise(output);
    });
  });
}

function assertDocumentDoesNotSelectComponent(document, component, label) {
  assertNotIncludes(
    document,
    `app.kubernetes.io/component: ${component}`,
    `${label} component selector`,
  );
  assertNotIncludes(
    document,
    `component: ${component}`,
    `${label} short component selector`,
  );
}

function assertServiceSelectorsDoNotSelectPrefetch(rendered, label) {
  const serviceDocuments = findDocumentsByKind(rendered, 'Service');
  for (const serviceDocument of serviceDocuments) {
    assertIncludes(serviceDocument, 'selector:', `${label} Service selector`);
    assertIncludes(
      serviceDocument,
      'app.kubernetes.io/component:',
      `${label} Service component selector`,
    );
    assertDocumentDoesNotSelectComponent(serviceDocument, 'model-prefetch', label);
  }
}

const rendered = render();
const defaultFleetRendered = renderHelm();
const defaultFleetDocuments = parseRenderedDocuments(defaultFleetRendered, 'default fleet render');
const defaultFleetCertificates = defaultFleetDocuments.filter(document => (
  document.kind === 'Certificate'
));
if (defaultFleetCertificates.length !== 7) {
  throw new Error(
    `default fleet render must contain seven Certificates, got ${defaultFleetCertificates.length}`,
  );
}
if (!defaultFleetCertificates.some(document => document.metadata?.name === 'psfn-gateway-rpc')) {
  throw new Error('default fleet render omitted the psfn-gateway-rpc Certificate');
}
const defaultFleetGatewayCertificate = defaultFleetCertificates.find(document => (
  document.metadata?.name === 'psfn-gateway-rpc'
));
const expectedFleetGatewaySpiffeUri = 'spiffe://cluster.local/psfn/gateway/fleet';
if (defaultFleetGatewayCertificate?.spec?.uris?.length !== 1
  || defaultFleetGatewayCertificate.spec.uris[0] !== expectedFleetGatewaySpiffeUri) {
  throw new Error(
    'fleet gateway Certificate must carry only the shared gateway SPIFFE identity',
  );
}
const defaultFleetAgents = defaultFleetDocuments.filter(document => (
  document.kind === 'Deployment'
  && document.spec?.selector?.matchLabels?.['app.kubernetes.io/component'] === 'agent'
));
if (defaultFleetAgents.length !== 1) {
  throw new Error(`default fleet-of-one render must contain one agent, got ${defaultFleetAgents.length}`);
}
if (defaultFleetAgents[0]?.metadata?.name
  !== 'psfn-agent-11111111-1111-4111-8111-111111111111') {
  throw new Error('default fleet-of-one render did not use the fleet agent naming contract');
}
const defaultFleetGateway = defaultFleetDocuments.find(document => (
  document.kind === 'Deployment' && document.metadata?.name === 'psfn-gateway'
));
const defaultFleetGarden = defaultFleetDocuments.find(document => (
  document.kind === 'Deployment' && document.metadata?.name === 'psfn-garden'
));
const sharedWorkspaceMount = {
  name: 'runtime',
  mountPath: '/runtime/workspaces/shared',
  subPath: 'workspaces-shared',
};
for (const [deployment, containerName] of [
  [defaultFleetGateway, 'gateway'],
  [defaultFleetGarden, 'garden'],
  [defaultFleetAgents[0], 'agent'],
]) {
  assertSharedWorkspaceBootstrap(deployment, containerName);
  assertContainerVolumeMount(
    deployment,
    'containers',
    containerName,
    sharedWorkspaceMount,
    `${containerName} shared workspace`,
  );
}
for (const [deployment, label] of [
  [defaultFleetGateway, 'gateway owner seeding'],
  [defaultFleetAgents[0], 'fleet agent owner seeding'],
]) {
  assertContainerVolumeMount(
    deployment,
    'initContainers',
    'seed-runtime-files',
    sharedWorkspaceMount,
    label,
  );
}
const helmBackupImageEnvNames = ['AGENT', 'GATEWAY', 'GARDEN'].flatMap(workload => (
  ['REPOSITORY', 'TAG', 'DIGEST'].map(field => `PSFN_HELM_BACKUP_${workload}_IMAGE_${field}`)
));
for (const [deployment, containerName] of [
  [defaultFleetGateway, 'gateway'],
  [defaultFleetGarden, 'garden'],
  [defaultFleetAgents[0], 'agent'],
]) {
  assertContainerEnvNames(
    deployment,
    containerName,
    helmBackupImageEnvNames,
    `${containerName} Helm recovery provenance`,
  );
}
if (findDocumentByKindName(defaultFleetRendered, 'Deployment', 'psfn-agent')) {
  throw new Error('default fleet-of-one render must not contain the legacy unbound agent Deployment');
}
if (findDocumentByKindName(defaultFleetRendered, 'Ingress', 'psfn-garden')) {
  throw new Error('default fleet-of-one render must expose Garden only through the gateway portal');
}
assertIncludes(
  findDocumentByKindName(defaultFleetRendered, 'Deployment', 'psfn-garden'),
  'name: FLEET_GARDEN_TARGET_IDS',
  'default fleet-of-one Garden target registry',
);
assertIncludes(
  findDocumentByKindName(defaultFleetRendered, 'Deployment', 'psfn-gateway'),
  'name: PSFN_FLEET_AUTH',
  'default fleet-of-one gateway authentication wiring',
);

// bead ge7g: the gateway's ntfy operator-notifier config must be portable into
// the pod. When both baseUrl and topic are set, NTFY_BASE_URL/NTFY_TOPIC are
// wired into the gateway container; when unset the pod carries no ntfy env and
// the notify tool fails closed with a clear message instead of a raw error.
const ntfyConfiguredGateway = findDocumentByKindName(
  render([
    '--set-string', 'ntfy.baseUrl=https://ntfy.example.com',
    '--set-string', 'ntfy.topic=psfn-alerts',
  ]),
  'Deployment',
  'psfn-gateway',
);
assertIncludes(ntfyConfiguredGateway, 'name: NTFY_BASE_URL', 'ntfy gateway base URL env');
assertIncludes(ntfyConfiguredGateway, 'value: "https://ntfy.example.com"', 'ntfy gateway base URL value');
assertIncludes(ntfyConfiguredGateway, 'name: NTFY_TOPIC', 'ntfy gateway topic env');
assertIncludes(ntfyConfiguredGateway, 'value: "psfn-alerts"', 'ntfy gateway topic value');
const ntfyUnsetGateway = findDocumentByKindName(render(), 'Deployment', 'psfn-gateway');
assertNotIncludes(ntfyUnsetGateway, 'name: NTFY_BASE_URL', 'ntfy gateway base URL omitted when unset');
assertNotIncludes(ntfyUnsetGateway, 'name: NTFY_TOPIC', 'ntfy gateway topic omitted when unset');
assertDefaultFleetRenderFails(
  [
    '--set', 'secrets.allowMissingRequired=false',
    '--set-string', 'secrets.values.gatewaySessionIntegrityAuthToken=verify-session-proof',
    '--set-string', 'secrets.values.backupEncryptionKey=verify-backup-key',
  ],
  'secrets.values.gatewayCompanionAuthToken is required when secrets.allowMissingRequired=false',
);
assertDefaultFleetRenderFails(
  ['--set', 'fleet.enabled=false'],
  "at '/fleet/enabled': value must be true",
);
assertDefaultFleetRenderFails(
  ['--set', 'fleetAuth.enabled=false'],
  "at '/fleetAuth/enabled': value must be true",
);

assertRealOwnerUpgradeGate();

const ownerUpgradeRendered = renderFleetOwnerUpgradeHook();
const ownerUpgradeJob = parseAllDocuments(ownerUpgradeRendered)
  .map(document => document.toJS())
  .find(document => (
    document?.kind === 'Job'
    && document?.metadata?.labels?.['app.kubernetes.io/component'] === 'owner-migration'
  ));
if (!ownerUpgradeJob) throw new Error('ownerMigration.enabled did not render the pre-upgrade Job');
if (ownerUpgradeJob.metadata.annotations?.['helm.sh/hook'] !== 'pre-upgrade') {
  throw new Error('owner migration Job is not ordered as a pre-upgrade hook');
}
const ownerUpgradeInit = ownerUpgradeJob.spec.template.spec.initContainers;
if (ownerUpgradeInit.map(container => container.name).join(',')
    !== 'snapshot-whole-fleet,migrate-system-owner-fleet') {
  throw new Error('owner migration snapshot/migration init ordering changed');
}
if (ownerUpgradeInit[1].command?.[1] !== '/app/dist/migrate-system-owner-fleet.js') {
  throw new Error('owner migration hook does not use the canonical compiled entrypoint');
}
const ownerUpgradeMounts = new Map(
  ownerUpgradeInit[1].volumeMounts.map(mount => [mount.name, mount.mountPath]),
);
for (const [name, path] of [
  ['system-data', '/runtime/system-data'],
  ['companion-0', '/runtime/companions/one'],
  ['companion-1', '/runtime/companions/two'],
]) {
  if (ownerUpgradeMounts.get(name) !== path) {
    throw new Error(`owner migration exact mount changed for ${name}`);
  }
}
if (ownerUpgradeJob.spec.template.spec.containers.length !== 2) {
  throw new Error('owner migration hook must render two packaged companion probes');
}
for (const probe of ownerUpgradeJob.spec.template.spec.containers) {
  if (probe.command?.[1] !== '/app/dist/owner-upgrade-readiness-probe.js') {
    throw new Error(`${probe.name} is not the packaged owner readiness probe`);
  }
  const ownerMount = probe.volumeMounts.find(mount => mount.name.startsWith('companion-'));
  if (!ownerMount?.readOnly) {
    throw new Error(`${probe.name} must observe its companion owner root read-only`);
  }
}

const singleOwnerUpgradeRendered = render(ownerMigrationRenderArgs([
  {
    companionId: '11111111-1111-4111-8111-111111111111',
    claimName: 'owner-one',
    mountPath: '/runtime/companions/11111111-1111-4111-8111-111111111111',
    expectedIdentitySha256: '1'.repeat(64),
  },
]));
const singleOwnerUpgradeJob = parseAllDocuments(singleOwnerUpgradeRendered)
  .map(document => document.toJS())
  .find(document => (
    document?.kind === 'Job'
    && document?.metadata?.labels?.['app.kubernetes.io/component'] === 'owner-migration'
  ));
if (!singleOwnerUpgradeJob) {
  throw new Error('single-companion ownerMigration did not render the pre-upgrade Job');
}
const singleOwnerEnv = new Map(
  singleOwnerUpgradeJob.spec.template.spec.initContainers[0].env
    .map(entry => [entry.name, entry.value]),
);
if (singleOwnerEnv.has('PSFN_MULTI_COMPANION')) {
  throw new Error('ownerMigration must not set the retired PSFN_MULTI_COMPANION flag; topology is derived from companions.json presence');
}
if (singleOwnerEnv.get('COMPANION_ID') !== '11111111-1111-4111-8111-111111111111') {
  throw new Error('single-companion ownerMigration did not bind its explicit companion identity');
}
if (singleOwnerUpgradeJob.spec.template.spec.containers.length !== 1) {
  throw new Error('single-companion ownerMigration must render one packaged readiness probe');
}
assertRenderFails(
  ownerMigrationRenderArgs([]),
  'ownerMigration.enabled=true requires at least one explicit companion PVC',
);
assertRenderFails(
  [...ownerMigrationRenderArgs(), '--set', 'ownerMigration.verification.enabled=false'],
  'ownerMigration.enabled=true requires ownerMigration.verification.enabled=true',
);
assertRenderFails(
  [...ownerMigrationRenderArgs(), '--set-string', 'ownerMigration.snapshotOutputDir=/other/snapshot'],
  'ownerMigration.snapshotOutputDir must be beneath ownerMigration.backupsDir',
);
assertRenderFails(
  [...ownerMigrationRenderArgs(), '--set-string', 'ownerMigration.backupsSubPath=../escape'],
  'ownerMigration.backupsSubPath must be a safe relative PVC subPath',
);
assertRenderFails(
  ownerMigrationRenderArgs(undefined, { 'scheduler.json': 'c'.repeat(64) }),
  'ownerMigration.approvals contains an unsupported fleet-migration owner: scheduler.json',
);

const subPathOwnerUpgrade = parseAllDocuments(render([
  ...ownerMigrationRenderArgs(),
  '--set-string', 'ownerMigration.backupsSubPath=backups',
]))
  .map(document => document.toJS())
  .find(document => (
    document?.kind === 'Job'
    && document?.metadata?.labels?.['app.kubernetes.io/component'] === 'owner-migration'
  ));
const snapshotBackupsMount = subPathOwnerUpgrade.spec.template.spec.initContainers[0]
  .volumeMounts.find(mount => mount.name === 'backups');
if (snapshotBackupsMount?.mountPath !== '/backups' || snapshotBackupsMount?.subPath !== 'backups') {
  throw new Error('owner migration backups subPath did not stay mounted at backupsDir');
}
for (const claimName of ['psfn-system-data', 'psfn-companion-data', 'psfn-workspace', 'psfn-runtime']) {
  if (findDocumentByKindName(ownerUpgradeRendered, 'PersistentVolumeClaim', claimName)) {
    throw new Error(`existing owner claim was unexpectedly recreated: ${claimName}`);
  }
}
assertRenderFails(
  ['--set', 'ownerMigration.required=true'],
  'ownerMigration.required=true requires ownerMigration.enabled=true',
);
assertRenderFails(
  [
    '--set', 'ownerMigration.required=true',
    '--set', 'ownerMigration.enabled=true',
    '--set', 'bootstrap.seedOwnerFiles=true',
  ],
  'ownerMigration.enabled=true requires bootstrap.seedOwnerFiles=false',
);
assertRenderFails(
  ownerMigrationRenderArgs([
    {
      companionId: 'one',
      claimName: 'owner-shared',
      mountPath: '/runtime/companions/one',
      expectedIdentitySha256: '1'.repeat(64),
    },
    {
      companionId: 'two',
      claimName: 'owner-shared',
      mountPath: '/runtime/companions/two',
      expectedIdentitySha256: '2'.repeat(64),
    },
  ]),
  'ownerMigration companion claimName is duplicated: owner-shared',
);

for (const spiffe of [
  'spiffe://cluster.local/psfn/gateway/11111111-1111-4111-8111-111111111111',
  'spiffe://cluster.local/psfn/agent/11111111-1111-4111-8111-111111111111',
  'spiffe://cluster.local/psfn/garden/11111111-1111-4111-8111-111111111111',
]) {
  assertIncludes(rendered, spiffe, 'SPIFFE URI SAN contract');
}

for (const envName of [
  'SYSTEM_DATA_DIR',
  'COMPANION_DATA_DIR',
  'WORKSPACE_PATH',
  'POSTGRES_DATABASE_URL',
  'POSTGRES_DATABASE_URL_FILE',
  'PSFN_REDIS_URL',
  'LITELLM_BASE_URL',
  'GATEWAY_RPC_ENDPOINT',
  'ADMIN_TRANSPORT_URL',
]) {
  assertIncludes(rendered, `- name: ${envName}`, 'runtime env contract');
}

assertIncludes(rendered, 'mountPath: /app/system-data', 'system-data PVC mount');
assertIncludes(rendered, 'mountPath: /app/companion-data', 'companion-data PVC mount');
assertIncludes(rendered, 'mountPath: /app/workspace', 'workspace PVC mount');
assertIncludes(rendered, 'mountPath: /app/models/transformers', 'model cache PVC mount');
assertIncludes(rendered, 'runAsUser: 999', 'numeric non-root user');
assertIncludes(rendered, 'runAsGroup: 999', 'numeric non-root group');
const postgresInit = findDocumentByKindName(rendered, 'ConfigMap', 'psfn-postgres-init');
assertIncludes(
  postgresInit,
  'CREATE EXTENSION IF NOT EXISTS vector;',
  'pgvector init SQL',
);
assertIncludes(
  postgresInit,
  "'CREATE DATABASE %I OWNER %I',\n      'psfn_restore_verify',\n      'psfn'",
  'Postgres restore-verify database and owner init SQL',
);
assertIncludes(
  postgresInit,
  "WHERE datname = 'psfn_restore_verify'",
  'Postgres restore-verify idempotency guard',
);
assertIncludes(
  postgresInit,
  '\\gexec',
  'Postgres restore-verify guarded command execution',
);
assertIncludes(rendered, 'kind: NetworkPolicy', 'network policy render');
assertNotIncludes(rendered, 'ALLOW_AGENT_OUTBOUND_NETWORK', 'agent network isolation');
assertNotIncludes(rendered, 'name: psfn-model-prefetch', 'disabled model prefetch Job');

// cyy7l: the L1.5 intake injection-classifier weights (~700MiB, gitignored,
// provisioned out of band) are a HARD prerequisite for enforce-mode intake —
// the gateway fails closed at startup when they are absent. The deploy contract
// must therefore provision them onto the shared model-cache PVC at exactly the
// path the gateway reads (PSFN_INJECTION_MODEL_DIR), so no kube target can
// silently run the firewall degraded. Verify the prefetch Job wires the pinned
// provisioning script to that exact destination.
{
  const injectionExpectedDir = '/app/models/transformers/prompt-injection-v2';
  const gatewayInjectionEnv = findParsedDocumentByKindName(rendered, 'Deployment', 'psfn-gateway')
    ?.spec?.template?.spec?.containers?.[0]?.env
    ?.find(entry => entry.name === 'PSFN_INJECTION_MODEL_DIR');
  if (gatewayInjectionEnv?.value !== injectionExpectedDir) {
    throw new Error(
      `gateway PSFN_INJECTION_MODEL_DIR must be ${injectionExpectedDir}, got ${gatewayInjectionEnv?.value}`,
    );
  }
  const prefetchRendered = render(['--set', 'modelPrefetch.enabled=true']);
  const gatewayWithPrefetch = findParsedDocumentByKindName(
    prefetchRendered,
    'Deployment',
    'psfn-gateway',
  );
  const injectionWait = gatewayWithPrefetch?.spec?.template?.spec?.initContainers
    ?.find(container => container?.name === 'wait-for-injection-model');
  if (!injectionWait) {
    throw new Error('gateway must wait for injection model provisioning when prefetch is enabled');
  }
  const injectionWaitCommand = injectionWait.command?.join('\n') ?? '';
  for (const requiredFile of [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'onnx/model.onnx',
  ]) {
    assertIncludes(
      injectionWaitCommand,
      requiredFile,
      `gateway injection-model wait required file ${requiredFile}`,
    );
  }
  const injectionWaitMount = injectionWait.volumeMounts
    ?.find(mount => mount?.name === 'model-cache');
  if (injectionWaitMount?.mountPath !== '/app/models/transformers' || injectionWaitMount?.readOnly !== true) {
    throw new Error('gateway injection-model wait must mount the shared model cache read-only');
  }
  const prefetchJob = findParsedDocumentByKindName(prefetchRendered, 'Job', 'psfn-model-prefetch');
  if (!prefetchJob) {
    throw new Error('modelPrefetch.enabled=true did not render the model-prefetch Job');
  }
  const injectionContainer = prefetchJob.spec?.template?.spec?.containers
    ?.find(container => container?.name === 'injection-classifier');
  if (!injectionContainer) {
    throw new Error('model-prefetch Job missing the injection-classifier provisioning container');
  }
  assertIncludes(
    injectionContainer.command?.join(' ') ?? '',
    'node /app/dist/provision-injection-model.js',
    'injection-classifier provisioning entrypoint',
  );
  const destIndex = injectionContainer.command?.indexOf('--dest');
  const renderedDest = destIndex >= 0 ? injectionContainer.command?.[destIndex + 1] : undefined;
  if (renderedDest !== injectionExpectedDir) {
    throw new Error(
      'injection-classifier prefetch must provision into the gateway PSFN_INJECTION_MODEL_DIR '
      + `(${injectionExpectedDir}), got ${renderedDest}`,
    );
  }
  const injectionMount = injectionContainer.volumeMounts
    ?.find(mount => mount?.name === 'model-cache');
  if (injectionMount?.mountPath !== '/app/models/transformers') {
    throw new Error('injection-classifier prefetch must mount the model-cache PVC');
  }
  // The provisioning step is inert without the PVC it writes to: the chart
  // must refuse a prefetch Job with no model-cache PVC rather than provision
  // into an ephemeral path the gateway never sees (fail closed at render time).
  assertRenderFails(
    [
      '--set', 'modelPrefetch.enabled=true',
      '--set', 'persistence.modelCache.enabled=false',
    ],
    'modelPrefetch.enabled=true requires persistence.modelCache.enabled=true',
  );

  const injectionOnlyRendered = render([
    '--set', 'modelPrefetch.enabled=true',
    '--set', 'modelPrefetch.textEmotion.enabled=false',
  ]);
  const injectionOnlyJob = findParsedDocumentByKindName(
    injectionOnlyRendered,
    'Job',
    'psfn-model-prefetch',
  );
  if (!injectionOnlyJob?.spec?.template?.spec?.containers
    ?.some(container => container?.name === 'injection-classifier')) {
    throw new Error('injection-only model prefetch must render the injection classifier container');
  }
  if (injectionOnlyJob.spec.template.spec.containers
    .some(container => container?.name === 'text-emotion')) {
    throw new Error('injection-only model prefetch must not render the text-emotion container');
  }
  if (!findParsedDocumentByKindName(
    injectionOnlyRendered,
    'NetworkPolicy',
    'psfn-model-prefetch-egress',
  )) {
    throw new Error('injection-only model prefetch must render its egress NetworkPolicy');
  }
  assertRenderFails(
    [
      '--set', 'modelPrefetch.enabled=true',
      '--set', 'modelPrefetch.textEmotion.enabled=false',
      '--set', 'modelPrefetch.injectionClassifier.enabled=false',
    ],
    'modelPrefetch.enabled=true requires at least one enabled prefetch target',
  );
}

const customPostgresRendered = render([
  '--set-string',
  'postgres.auth.database=companion',
  '--set-string',
  'postgres.auth.username=companion_owner',
]);
const customPostgresInit = findDocumentByKindName(
  customPostgresRendered,
  'ConfigMap',
  'psfn-postgres-init',
);
assertIncludes(
  customPostgresInit,
  "'CREATE DATABASE %I OWNER %I',\n      'companion_restore_verify',\n      'companion_owner'",
  'custom Postgres restore-verify database and owner init SQL',
);

const appSecret = findDocument(rendered, 'psfn-app');
assertIncludes(appSecret, 'kind: Secret', 'app secret kind');
assertIncludes(appSecret, 'API_KEY:', 'API key secret');
assertIncludes(appSecret, 'ADMIN_TOKEN:', 'admin token secret');
assertIncludes(appSecret, 'GATEWAY_SESSION_HMAC_KEY:', 'session HMAC secret');
assertIncludes(appSecret, 'LITELLM_API_KEY:', 'LiteLLM API key secret');
const credentialSecrets = parseAllDocuments(rendered)
  .map(document => document.toJS())
  .filter(document => document?.kind === 'Secret');
for (const secret of credentialSecrets) {
  if (secret.metadata?.annotations?.['helm.sh/resource-policy'] !== 'keep') {
    throw new Error(
      `chart-rendered credential Secret ${secret.metadata?.name ?? '<unnamed>'} must carry `
      + 'helm.sh/resource-policy: keep',
    );
  }
}

const defaultDenyPolicy = findDocument(rendered, 'psfn-default-deny');
assertIncludes(defaultDenyPolicy, 'podSelector: {}', 'default deny policy');
assertIncludes(defaultDenyPolicy, '- Ingress', 'default deny ingress');
assertIncludes(defaultDenyPolicy, '- Egress', 'default deny egress');

const agentPolicy = findDocument(rendered, 'psfn-agent');
assertNotIncludes(agentPolicy, '0.0.0.0/0', 'agent policy broad egress');
assertIncludes(agentPolicy, 'component: gateway', 'agent policy gateway flow');
// x5rt.10: the agent no longer reaches the gateway API (operator confirmation
// relay removed); the Garden operator process holds that egress instead.
assertNotIncludes(agentPolicy, 'port: 10053', 'agent has no gateway operator API egress');
assertIncludes(agentPolicy, 'component: postgres', 'agent policy postgres flow');
assertIncludes(agentPolicy, 'component: redis', 'agent policy redis flow');
assertNotIncludes(agentPolicy, 'component: litellm', 'agent policy LiteLLM direct egress');
assertNotIncludes(rendered, 'psfn-satellite-hub', 'default disabled satellite hub');
assertNotIncludes(rendered, 'psfn-companion-ui-test', 'default disabled companion-ui test surface');

const gatewayDeployment = findDocumentByKindName(rendered, 'Deployment', 'psfn-gateway');
assertIncludes(gatewayDeployment, 'name: wait-for-postgres', 'gateway Postgres startup wait init container');
assertIncludes(
  gatewayDeployment,
  'pg_isready -d "$(cat "$POSTGRES_DATABASE_URL_FILE")"',
  'gateway Postgres startup wait command',
);
assertIncludes(gatewayDeployment, 'name: psfn-postgres', 'gateway Postgres startup wait secret name');
assertIncludes(gatewayDeployment, 'key: postgres-database-url', 'gateway Postgres startup wait secret key');
assertIncludes(gatewayDeployment, 'name: LITELLM_BASE_URL', 'gateway LiteLLM endpoint env');
assertIncludes(gatewayDeployment, 'value: "http://psfn-litellm.psfn-test.svc:4000/v1"', 'gateway in-cluster LiteLLM base URL');
assertIncludes(gatewayDeployment, 'name: LITELLM_API_KEY', 'gateway LiteLLM credential env');
assertIncludes(gatewayDeployment, 'name: PSFN_INJECTION_MODEL_DIR', 'gateway intake classifier model env');
assertIncludes(
  gatewayDeployment,
  'value: "/app/models/transformers/prompt-injection-v2"',
  'gateway intake classifier persistent model path',
);
assertIncludes(gatewayDeployment, 'mountPath: /app/companion-data\n              readOnly: true', 'gateway read-only companion-data root');
assertIncludes(gatewayDeployment, 'mountPath: /app/companion-data/state', 'gateway writable CogSec state submount');
assertIncludes(gatewayDeployment, 'subPath: state', 'gateway CogSec state PVC subPath');
assertIncludes(gatewayDeployment, 'automountServiceAccountToken: false', 'default gateway ServiceAccount token disabled');
assertNotIncludes(gatewayDeployment, 'PSFN_KUBE_SELF_MANAGEMENT_ENABLED', 'default kube self-management runtime disabled');
assertNotIncludes(rendered, 'name: psfn-kube-self-management', 'default kube self-management RBAC disabled');

const kubeSelfManagementRendered = render([
  '--set',
  'kubeSelfManagement.enabled=true',
  '--set-string',
  'kubeSelfManagement.apiServerCIDRs[0]=10.43.0.1/32',
  '--set-string',
  `psfnAppImage.gitCommit=${'a'.repeat(40)}`,
]);
if (findDocumentsByKind(kubeSelfManagementRendered, 'ClusterRole').length > 0
  || findDocumentsByKind(kubeSelfManagementRendered, 'ClusterRoleBinding').length > 0) {
  throw new Error('kube self-management RBAC must never render cluster-scoped roles');
}
const kubeServiceAccount = findDocumentByKindName(
  kubeSelfManagementRendered,
  'ServiceAccount',
  'psfn-kube-self-management',
);
assertIncludes(kubeServiceAccount, 'automountServiceAccountToken: true', 'dedicated kube ServiceAccount token');
const kubeRole = findDocumentByKindName(
  kubeSelfManagementRendered,
  'Role',
  'psfn-kube-self-management',
);
assertIncludes(kubeRole, 'resources: ["pods"]\n    verbs: ["list"]', 'pod diagnostics least-privilege rule');
assertIncludes(kubeRole, 'resources: ["deployments"]', 'deployment lifecycle rule');
assertIncludes(kubeRole, '- psfn-agent\n      - psfn-gateway\n      - psfn-garden', 'release deployment resourceNames');
assertIncludes(kubeRole, 'verbs: ["get", "patch"]', 'deployment lifecycle exact verbs');
for (const forbidden of ['ClusterRole', 'resources: ["secrets"]', 'resources: ["jobs"]', 'pods/exec', 'verbs: ["*"]']) {
  assertNotIncludes(kubeRole, forbidden, 'kube self-management forbidden RBAC authority');
}
const kubeRoleBinding = findDocumentByKindName(
  kubeSelfManagementRendered,
  'RoleBinding',
  'psfn-kube-self-management',
);
assertIncludes(kubeRoleBinding, 'kind: Role\n  name: psfn-kube-self-management', 'namespaced kube RoleBinding');
assertIncludes(kubeRoleBinding, 'name: psfn-kube-self-management\n    namespace: psfn-test', 'dedicated kube RoleBinding subject');
const kubeGatewayDeployment = findDocumentByKindName(
  kubeSelfManagementRendered,
  'Deployment',
  'psfn-gateway',
);
assertIncludes(kubeGatewayDeployment, 'serviceAccountName: psfn-kube-self-management', 'gateway dedicated kube ServiceAccount');
assertIncludes(kubeGatewayDeployment, 'automountServiceAccountToken: true', 'gateway kube token mount');
assertIncludes(kubeGatewayDeployment, 'name: PSFN_KUBE_SELF_MANAGEMENT_ENABLED\n              value: "true"', 'gateway kube runtime opt-in');
assertIncludes(kubeGatewayDeployment, 'name: PSFN_KUBE_CURRENT_IMAGE\n              value: "localhost/psfn-framework:0.1.0-kube"', 'gateway exact current image binding');
assertIncludes(kubeGatewayDeployment, 'name: PSFN_KUBE_RESOURCE_PREFIX\n              value: "psfn"', 'gateway exact Helm resource prefix binding');
const kubeGatewayPolicy = findDocumentByKindName(
  kubeSelfManagementRendered,
  'NetworkPolicy',
  'psfn-gateway',
);
assertIncludes(kubeGatewayPolicy, 'cidr: "10.43.0.1/32"', 'single-host Kubernetes API egress');
assertIncludes(kubeGatewayPolicy, 'port: 443\n          protocol: TCP', 'Kubernetes API HTTPS-only egress');
assertRenderFails(
  [
    '--set',
    'kubeSelfManagement.enabled=true',
    '--set-string',
    `psfnAppImage.gitCommit=${'a'.repeat(40)}`,
  ],
  'kubeSelfManagement.apiServerCIDRs must contain the Kubernetes API Service host CIDR',
);
assertRenderFails(
  [
    '--set',
    'kubeSelfManagement.enabled=true',
    '--set-string',
    'kubeSelfManagement.apiServerCIDRs[0]=10.43.0.1/32',
  ],
  'psfnAppImage.gitCommit must be an exact 40-character Git revision',
);
assertRenderFails(
  [
    '--set',
    'kubeSelfManagement.enabled=true',
    '--set-string',
    'kubeSelfManagement.apiServerCIDRs[0]=0.0.0.0/0',
    '--set-string',
    `psfnAppImage.gitCommit=${'a'.repeat(40)}`,
  ],
  'kubeSelfManagement.apiServerCIDRs entries must be single-host',
);
assertRenderFails(
  [
    '--set',
    'kubeSelfManagement.enabled=true',
    '--set-string',
    'kubeSelfManagement.serviceAccountName=psfn',
    '--set-string',
    'kubeSelfManagement.apiServerCIDRs[0]=10.43.0.1/32',
    '--set-string',
    `psfnAppImage.gitCommit=${'a'.repeat(40)}`,
  ],
  'kubeSelfManagement.serviceAccountName must be dedicated to the gateway',
);

const agentDeployment = findDocumentByKindName(rendered, 'Deployment', 'psfn-agent');
assertIncludes(agentDeployment, 'name: wait-for-postgres', 'agent Postgres startup wait init container');
assertIncludes(
  agentDeployment,
  'pg_isready -d "$(cat "$POSTGRES_DATABASE_URL_FILE")"',
  'agent Postgres startup wait command',
);
assertIncludes(agentDeployment, 'secretName: psfn-postgres', 'agent Postgres startup wait secret name');
assertIncludes(agentDeployment, 'key: postgres-database-url', 'agent Postgres startup wait secret key');
assertIncludes(agentDeployment, 'name: POSTGRES_DATABASE_URL_FILE', 'agent Postgres credential file env');
assertIncludes(
  agentDeployment,
  'value: "/var/run/secrets/psfn-postgres/database-url"',
  'agent Postgres credential file path',
);
assertNotIncludes(
  agentDeployment,
  '- name: POSTGRES_DATABASE_URL\n',
  'agent raw Postgres credential env',
);
assertNotIncludes(
  agentDeployment,
  'name: GATEWAY_SESSION_HMAC_KEY',
  'agent gateway root proof-signing credential',
);
assertIncludes(agentDeployment, 'name: GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN', 'agent isolated session-integrity proof env');
assertIncludes(agentDeployment, 'key: GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN', 'agent isolated session-integrity proof Secret key');
assertIncludes(agentDeployment, 'name: GATEWAY_COMPANION_AUTH_TOKEN', 'agent companion role proof env');
assertIncludes(agentDeployment, 'key: GATEWAY_COMPANION_AUTH_TOKEN', 'agent companion role proof Secret key');
assertIncludes(
  agentDeployment,
  'key: GATEWAY_COMPANION_AUTH_TOKEN\n                  optional: true',
  'agent companion role proof remains optional for single-companion installs',
);
// x5rt.10: the operator confirmation endpoint (and the ADMIN_TOKEN it carries)
// lives in the Garden operator process, never the agent.
assertNotIncludes(
  agentDeployment,
  'name: GATEWAY_OPERATOR_API_BASE_URL',
  'agent has no gateway operator confirmation endpoint env',
);
assertNotIncludes(agentDeployment, 'name: ADMIN_TOKEN', 'agent admin credential isolation');
for (const [name, value] of [
  ['PSFN_KUBERNETES_BACKUP_ENABLED', 'true'],
  ['PSFN_HELM_CHART_DIR', '/app/deploy/helm/psfn'],
  ['PSFN_HELM_RELEASE_NAME', 'psfn'],
  ['PSFN_HELM_NAMESPACE', 'psfn-test'],
  ['PSFN_HELM_CHART_NAME', 'psfn'],
  ['PSFN_HELM_CHART_VERSION', '0.1.0'],
  ['PSFN_HELM_APP_VERSION', '0.1.0-kube'],
  ['PSFN_HELM_CHART_CONTENT_SHA256', recoveryChartDigest],
  ['PSFN_IMAGE_TAG', '0.1.0-kube'],
  ['PSFN_HELM_BACKUP_AGENT_IMAGE_REPOSITORY', 'localhost/psfn-framework'],
  ['PSFN_HELM_BACKUP_AGENT_IMAGE_TAG', '0.1.0-kube'],
  ['PSFN_HELM_BACKUP_GATEWAY_IMAGE_REPOSITORY', 'localhost/psfn-framework'],
  ['PSFN_HELM_BACKUP_GATEWAY_IMAGE_TAG', '0.1.0-kube'],
  ['PSFN_HELM_BACKUP_GARDEN_IMAGE_REPOSITORY', 'localhost/psfn-framework'],
  ['PSFN_HELM_BACKUP_GARDEN_IMAGE_TAG', '0.1.0-kube'],
]) {
  assertIncludes(agentDeployment, `name: ${name}`, `agent Kubernetes backup ${name} env`);
  assertIncludes(agentDeployment, `value: "${value}"`, `agent Kubernetes backup ${name} value`);
}
assertNotIncludes(agentDeployment, 'LITELLM_BASE_URL', 'agent LiteLLM endpoint env');
assertNotIncludes(agentDeployment, 'LITELLM_API_KEY', 'agent LiteLLM credential env');
assertNotIncludes(
  agentDeployment,
  'name: SHELL_EXEC_ENABLED',
  'agent has no local shell policy that could bypass gateway approval and audit',
);
assertNotIncludes(
  gatewayDeployment,
  'name: SHELL_EXEC_ENABLED',
  'gateway shell policy is settings-owned rather than environment-owned',
);
assertIncludes(
  gatewayDeployment,
  'requests:\n              cpu: 100m\n              memory: 2Gi',
  'gateway cgroup resource requests',
);
assertIncludes(
  gatewayDeployment,
  'limits:\n              cpu: "2"\n              memory: 4Gi',
  'gateway cgroup resource limits',
);

const gardenCredentialBoundaryDeployment = findDocumentByKindName(rendered, 'Deployment', 'psfn-garden');
assertNotIncludes(
  gardenCredentialBoundaryDeployment,
  'GATEWAY_SESSION_HMAC_KEY',
  'network-only Garden session HMAC credential',
);
assertNotIncludes(
  gardenCredentialBoundaryDeployment,
  '- name: POSTGRES_DATABASE_URL\n',
  'Garden raw Postgres credential env',
);
// x5rt.10: the Garden operator process resolves operator-only confirmations
// directly against the gateway API, carrying ADMIN_TOKEN so it never traverses
// the agent.
assertIncludes(
  gardenCredentialBoundaryDeployment,
  'name: GATEWAY_OPERATOR_API_BASE_URL',
  'Garden operator confirmation endpoint env',
);
assertIncludes(
  gardenCredentialBoundaryDeployment,
  'value: "http://psfn-gateway:10053/v1"',
  'Garden in-cluster gateway operator confirmation endpoint',
);
assertIncludes(
  gardenCredentialBoundaryDeployment,
  'name: ADMIN_TOKEN',
  'Garden operator owns ADMIN_TOKEN for operator confirmation resolution',
);

const workloadImageOverrides = [
  ['agent', 'a'],
  ['gateway', 'b'],
  ['garden', 'c'],
];
const agentImageOverrideRendered = render(workloadImageOverrides.flatMap(([workload, marker]) => [
  '--set',
  `workloads.${workload}.image.repository=registry.example.test/${workload}`,
  '--set',
  `workloads.${workload}.image.tag=0.1.0-${workload}-override`,
  '--set',
  `workloads.${workload}.image.digest=sha256:${marker.repeat(64)}`,
]));
const overriddenAgentDeployment = findDocumentByKindName(
  agentImageOverrideRendered,
  'Deployment',
  'psfn-agent',
);
for (const [workload, marker] of workloadImageOverrides) {
  for (const value of [
    `registry.example.test/${workload}`,
    `0.1.0-${workload}-override`,
    `sha256:${marker.repeat(64)}`,
  ]) {
    assertIncludes(
      overriddenAgentDeployment,
      `value: "${value}"`,
      `${workload} Helm recovery exact image override`,
    );
  }
}

const gardenDeployment = findDocumentByKindName(rendered, 'Deployment', 'psfn-garden');
assertNotIncludes(gardenDeployment, 'name: wait-for-postgres', 'Garden direct Postgres startup wait');
assertIncludes(gardenDeployment, 'name: workspace', 'Garden workspace PVC volume mount');
assertIncludes(gardenDeployment, 'mountPath: /app/workspace', 'Garden workspace PVC mount path');
assertIncludes(gardenDeployment, 'name: ADMIN_TOKEN', 'fleet-off internal Garden legacy credential');
assertNotIncludes(gardenDeployment, 'FLEET_SSO_GARDEN_TLS_', 'fleet-off Garden SSO TLS wiring');
const gardenService = findDocumentByKindName(rendered, 'Service', 'psfn-garden');
assertIncludes(gardenService, 'type: ClusterIP', 'fleet-off Garden internal-only Service');
const defaultGardenIngress = findDocumentByKindName(rendered, 'Ingress', 'psfn-garden');
assertIncludes(defaultGardenIngress, 'host: "psfn-garden.local"', 'default Garden Ingress host');
assertIncludes(defaultGardenIngress, 'name: http-garden', 'default Garden Ingress service port');
assertNotIncludes(gardenDeployment, 'hostPort:', 'default fleet-off Garden hostPort');

// psfn-framework-6187t: nothing in a pod template may vary per helm operation.
// `.Release.Revision` increments on every one, so baking it in rewrote the pod
// template hash and force-restarted the companion on upgrades that changed
// nothing about it — including sidecar-only ships.
for (const [component, deployment] of [
  ['agent', agentDeployment],
  ['gateway', gatewayDeployment],
  ['garden', gardenDeployment],
]) {
  assertNotIncludes(
    deployment,
    'PSFN_HELM_REVISION',
    `${component} carries no per-helm-operation revision env`,
  );
}

const fleetGardenRendered = render(fleetGardenRenderArgs());
const fleetGardenDocuments = parseAllDocuments(fleetGardenRendered)
  .map(document => document.toJS())
  .filter(Boolean);
const fleetGardenDeployments = fleetGardenDocuments.filter(document => document.kind === 'Deployment');
const fleetGardenServices = fleetGardenDocuments.filter(document => document.kind === 'Service');
const renderedGardens = fleetGardenDeployments.filter(document => document.metadata?.name === 'psfn-garden');
if (renderedGardens.length !== 1) {
  throw new Error(`fleet render must contain exactly one Garden Deployment, got ${renderedGardens.length}`);
}
const renderedGardenServices = fleetGardenServices.filter(document => document.metadata?.name === 'psfn-garden');
if (renderedGardenServices.length !== 1) {
  throw new Error(`fleet render must contain exactly one Garden Service, got ${renderedGardenServices.length}`);
}
const shardGardens = fleetGardenDocuments.filter(document => (
  /garden/u.test(document.metadata?.name ?? '') && /shard/u.test(document.metadata?.name ?? '')
));
if (shardGardens.length !== 0) {
  throw new Error(`fleet render must contain zero shard Gardens, got ${shardGardens.length}`);
}
const fleetAgentDeployments = fleetGardenDeployments.filter(document => (
  document.spec?.template?.metadata?.labels?.['psfn.io/fleet-target'] === 'registered'
));
if (fleetAgentDeployments.length !== fleetGardenCompanions.length) {
  throw new Error(
    `fleet render must contain one agent Deployment per target, got ${fleetAgentDeployments.length}`,
  );
}
for (const deployment of fleetAgentDeployments) {
  assertSharedWorkspaceBootstrap(deployment, deployment.metadata.name);
}
if (findDocumentByKindName(fleetGardenRendered, 'Deployment', 'psfn-agent')) {
  throw new Error('fleet render must not contain the legacy unsuffixed agent Deployment');
}
if (findDocumentByKindName(fleetGardenRendered, 'Service', 'psfn-agent-admin')) {
  throw new Error('fleet render must not contain the legacy unsuffixed agent admin Service');
}
for (const companion of fleetGardenCompanions) {
  const suffix = companion.companionId;
  const agentDeploymentName = `psfn-agent-${suffix}`;
  const agentServiceName = `psfn-agent-admin-${suffix}`;
  const agentDeployment = findDocumentByKindName(
    fleetGardenRendered,
    'Deployment',
    agentDeploymentName,
  );
  const agentService = findDocumentByKindName(fleetGardenRendered, 'Service', agentServiceName);
  if (!agentDeployment) throw new Error(`fleet render missing ${agentDeploymentName}`);
  if (!agentService) throw new Error(`fleet render missing ${agentServiceName}`);
  // The fleet agent container is the DEFAULT shipped topology (values.yaml
  // fleet.enabled=true). It must render with an immutable root filesystem, the
  // same hardened contract as the non-fleet agent — a revert to the plain
  // securityContext (readOnlyRootFilesystem: false) must fail this contract,
  // not only the Trivy IaC gate. See psfn-framework-7hw4.
  const parsedAgentDeployment = findParsedDocumentByKindName(
    fleetGardenRendered,
    'Deployment',
    agentDeploymentName,
  );
  const fleetAgentContainer = parsedAgentDeployment?.spec?.template?.spec?.containers
    ?.find(container => container.name === 'agent');
  if (!fleetAgentContainer) {
    throw new Error(`${agentDeploymentName} must render an agent container`);
  }
  if (fleetAgentContainer.securityContext?.readOnlyRootFilesystem !== true) {
    throw new Error(
      `${agentDeploymentName} agent container must set securityContext.readOnlyRootFilesystem: true`,
    );
  }
  const fleetAgentTmpMount = fleetAgentContainer.volumeMounts
    ?.find(mount => mount.name === 'tmp' && mount.mountPath === '/tmp');
  if (!fleetAgentTmpMount) {
    throw new Error(
      `${agentDeploymentName} agent container needs a writable /tmp emptyDir mount for the read-only root`,
    );
  }
  assertIncludes(agentDeployment, `value: "${suffix}"`, `${agentDeploymentName} companion identity`);
  assertIncludes(
    agentDeployment,
    `value: "${companion.postgresSchema}"`,
    `${agentDeploymentName} companion schema identity`,
  );
  assertIncludes(
    agentDeployment,
    `value: "spiffe://cluster.local/psfn/garden/fleet"`,
    `${agentDeploymentName} fleet Garden peer identity`,
  );
  assertIncludes(
    agentService,
    `psfn.io/companion-id: ${suffix}`,
    `${agentServiceName} exact target selector`,
  );
  assertIncludes(
    fleetGardenRendered,
    `spiffe://cluster.local/psfn/agent/${suffix}`,
    `${agentDeploymentName} exact SPIFFE identity`,
  );
  assertIncludes(
    fleetGardenRendered,
    `name: psfn-agent-admin-${suffix}`,
    `${agentDeploymentName} target-bound admin certificate`,
  );
}
const fleetDatabaseUrlSecretKey = 'companion-tenant-b-url';
const fleetDatabaseUrlKeyCompanions = fleetGardenCompanions.map((companion, index) => (
  index === 1 ? { ...companion, databaseUrlSecretKey: fleetDatabaseUrlSecretKey } : companion
));
const fleetDatabaseUrlKeyRendered = render(fleetGardenRenderArgs(fleetDatabaseUrlKeyCompanions));
const fleetDatabaseUrlKeyGateway = findParsedDocumentByKindName(
  fleetDatabaseUrlKeyRendered,
  'Deployment',
  'psfn-gateway',
);
const fleetDatabaseUrlKeyGatewayEnv = fleetDatabaseUrlKeyGateway
  ?.spec?.template?.spec?.containers?.[0]?.env
  ?.find(entry => entry.name === 'POSTGRES_DATABASE_URL');
if (fleetDatabaseUrlKeyGatewayEnv?.valueFrom?.secretKeyRef?.key !== 'postgres-database-url') {
  throw new Error('fleet Gateway must use the chart-wide Postgres database URL Secret key');
}
const fleetDatabaseUrlKeyGarden = findParsedDocumentByKindName(
  fleetDatabaseUrlKeyRendered,
  'Deployment',
  'psfn-garden',
);
const fleetDatabaseUrlKeyGardenVolume = fleetDatabaseUrlKeyGarden
  ?.spec?.template?.spec?.volumes
  ?.find(volume => volume.name === 'postgres-database-url');
if (fleetDatabaseUrlKeyGardenVolume?.secret?.items?.[0]?.key !== 'postgres-database-url') {
  throw new Error('fleet Garden must use the chart-wide Postgres database URL Secret key');
}
for (const [companion, expectedKey] of [
  [fleetDatabaseUrlKeyCompanions[0], 'postgres-database-url'],
  [fleetDatabaseUrlKeyCompanions[1], fleetDatabaseUrlSecretKey],
]) {
  const deploymentName = `psfn-agent-${companion.companionId}`;
  const deployment = findParsedDocumentByKindName(
    fleetDatabaseUrlKeyRendered,
    'Deployment',
    deploymentName,
  );
  const secretVolume = deployment?.spec?.template?.spec?.volumes
    ?.find(volume => volume.name === 'postgres-database-url');
  if (secretVolume?.secret?.items?.[0]?.key !== expectedKey) {
    throw new Error(`${deploymentName} Postgres database URL Secret key must be ${expectedKey}`);
  }
  const initFileEnv = deployment?.spec?.template?.spec?.initContainers
    ?.find(container => container.name === 'wait-for-postgres')
    ?.env?.find(entry => entry.name === 'POSTGRES_DATABASE_URL_FILE');
  const agentFileEnv = deployment?.spec?.template?.spec?.containers?.[0]?.env
    ?.find(entry => entry.name === 'POSTGRES_DATABASE_URL_FILE');
  const rawDatabaseUrlEnv = deployment?.spec?.template?.spec?.containers?.[0]?.env
    ?.find(entry => entry.name === 'POSTGRES_DATABASE_URL');
  if (initFileEnv?.value !== '/var/run/secrets/psfn-postgres/database-url'
    || agentFileEnv?.value !== '/var/run/secrets/psfn-postgres/database-url') {
    throw new Error(`${deploymentName} must consume its Postgres database URL from the Secret file`);
  }
  if (rawDatabaseUrlEnv) {
    throw new Error(`${deploymentName} must not receive the raw Postgres database URL env`);
  }
}
assertRenderFails(
  fleetGardenRenderArgs([
    fleetGardenCompanions[0],
    { ...fleetGardenCompanions[1], databaseUrlSecretKey: fleetDatabaseUrlSecretKey },
    {
      ...fleetGardenCompanions[1],
      companionId: '33333333-3333-4333-8333-333333333333',
      postgresSchema: 'companion_c',
      databaseUrlSecretKey: fleetDatabaseUrlSecretKey,
      companionDataClaim: 'companion-c-data',
      workspaceClaim: 'companion-c-workspace',
      authSecret: { ...fleetGardenCompanions[1].authSecret, name: 'companion-c-auth' },
    },
  ]),
  `fleet databaseUrlSecretKey is duplicated: ${fleetDatabaseUrlSecretKey}`,
);
assertRenderFails(
  fleetGardenRenderArgs([
    { ...fleetGardenCompanions[0], databaseUrlSecretKey: fleetDatabaseUrlSecretKey },
    fleetGardenCompanions[1],
  ]),
  'fleet.companions[0].databaseUrlSecretKey must be empty; the primary/gateway/garden always use the chart-wide key and per-tenant keys belong on follower entries only',
);
assertRenderFails(
  fleetGardenRenderArgs([
    fleetGardenCompanions[0],
    { ...fleetGardenCompanions[1], databaseUrlSecretKey: '.' },
  ]),
  'fleet.companions[1].databaseUrlSecretKey must be a valid Kubernetes Secret key',
);
assertRenderFails(
  fleetGardenRenderArgs([
    fleetGardenCompanions[0],
    { ...fleetGardenCompanions[1], databaseUrlSecretKey: 'invalid/key' },
  ]),
  'fleet.companions[1].databaseUrlSecretKey must be a valid Kubernetes Secret key',
);
const fleetGardenDeployment = renderedGardens[0];
const fleetGardenYaml = findDocumentByKindName(fleetGardenRendered, 'Deployment', 'psfn-garden');
const fleetGatewayDeployment = fleetGardenDeployments
  .find(document => document.metadata?.name === 'psfn-gateway');
verifyFleetGatewayCompanionMountContract({
  deployment: fleetGatewayDeployment,
  companions: fleetGardenCompanions,
  assertRenderFails,
  renderArgs: fleetGardenRenderArgs,
});
for (const [deployment, name] of [
  [fleetGatewayDeployment, 'gateway'],
  [fleetGardenDeployment, 'Garden'],
]) {
  const container = deployment?.spec?.template?.spec?.containers?.[0];
  const schema = container?.env?.find(entry => entry.name === 'COMPANION_PG_SCHEMA')?.value;
  if (schema !== fleetGardenCompanions[0].postgresSchema) {
    throw new Error(`fleet ${name} runtime schema identity is ${schema ?? 'missing'}`);
  }
}
assertIncludes(
  fleetGardenYaml,
  'name: GATEWAY_OPERATOR_API_BASE_URL',
  'fleet Garden gateway child-assertion and confirmation endpoint',
);
assertIncludes(
  fleetGardenRendered,
  'spiffe://cluster.local/psfn/garden/fleet',
  'fleet-scoped Garden identity',
);
assertIncludes(
  fleetGardenYaml,
  "path: '/api/admin/__transport_probe__'",
  'fleet Garden readiness performs an authorized transport probe',
);
assertIncludes(
  fleetGardenYaml,
  'URI:spiffe://cluster.local/psfn/agent/${companionId}',
  'fleet Garden readiness validates each exact target SPIFFE identity',
);
assertIncludes(
  fleetGardenYaml,
  `value: "${fleetGardenCompanions.map(companion => companion.companionId).join(',')}"`,
  'fleet Garden readiness includes the complete target registry',
);
const fleetGardenContainer = fleetGardenDeployment.spec?.template?.spec?.containers
  ?.find(container => container.name === 'garden');
const fleetGardenVolumeNames = new Set(
  (fleetGardenDeployment.spec?.template?.spec?.volumes ?? []).map(volume => volume.name),
);
const fleetGardenMounts = new Map(
  (fleetGardenContainer?.volumeMounts ?? []).map(mount => [mount.name, mount]),
);
const fleetGardenVolumes = new Map(
  (fleetGardenDeployment.spec?.template?.spec?.volumes ?? [])
    .map(volume => [volume.name, volume]),
);
for (const [index, companion] of fleetGardenCompanions.entries()) {
  const volumeName = `garden-companion-data-${index}`;
  const volume = fleetGardenVolumes.get(volumeName);
  if (volume?.persistentVolumeClaim?.claimName !== companion.companionDataClaim) {
    throw new Error(
      `fleet Garden ${volumeName} must use companion claim ${companion.companionDataClaim}`,
    );
  }
  const mount = fleetGardenMounts.get(volumeName);
  const expectedPath = `/runtime/companions/${companion.companionId}`;
  if (mount?.mountPath !== expectedPath || mount.readOnly !== true) {
    throw new Error(
      `fleet Garden ${volumeName} must mount ${expectedPath} read-only`,
    );
  }
}
if (fleetGardenVolumeNames.has('workspace')) {
  throw new Error('fleet Garden must not receive workspace volume');
}
if (!fleetGardenVolumeNames.has('postgres-database-url')) {
  throw new Error('fleet Garden must mount the postgres-database-url Secret volume');
}
if (!fleetGardenVolumeNames.has('tmp') || !fleetGardenMounts.has('tmp')) {
  throw new Error('fleet Garden must define and mount its ephemeral tmp volume');
}
const fleetGardenSecretEnv = (fleetGardenContainer?.env ?? [])
  .filter(entry => entry.valueFrom?.secretKeyRef)
  .map(entry => entry.name);
if (fleetGardenSecretEnv.length !== 0) {
  throw new Error(
    `fleet Garden database credential must use the mounted Secret file, got secret env ${fleetGardenSecretEnv.join(', ')}`,
  );
}
assertIncludes(
  fleetGardenYaml,
  'name: POSTGRES_DATABASE_URL_FILE',
  'fleet Garden Postgres credential file env',
);
assertIncludes(
  fleetGardenYaml,
  'value: "/var/run/secrets/psfn-postgres/database-url"',
  'fleet Garden Postgres credential file path',
);
assertIncludes(
  fleetGardenYaml,
  'secretName: psfn-postgres',
  'fleet Garden Postgres credential Secret',
);
assertIncludes(fleetGardenYaml, 'key: postgres-database-url', 'fleet Garden Postgres credential key');
assertIncludes(fleetGardenYaml, 'name: wait-for-postgres', 'fleet Garden Postgres startup wait');
assertIncludes(
  fleetGardenYaml,
  'pg_isready -d "$(cat "$POSTGRES_DATABASE_URL_FILE")"',
  'fleet Garden Postgres startup readiness command',
);
const fleetGardenPolicy = findDocumentByKindName(
  fleetGardenRendered,
  'NetworkPolicy',
  'psfn-garden',
);
const fleetAgentPolicy = fleetGardenDocuments.find(document => (
  document.kind === 'NetworkPolicy' && document.metadata?.name === 'psfn-agent'
));
const agentAdminIngressPeers = fleetAgentPolicy?.spec?.ingress?.[0]?.from ?? [];
const agentAdminIngressComponents = agentAdminIngressPeers.map(peer => (
  peer.podSelector?.matchLabels?.['app.kubernetes.io/component']
));
if (agentAdminIngressComponents.includes('gateway')) {
  throw new Error('fleet Gateway must not have a direct network path to agent admin ports');
}
if (!agentAdminIngressComponents.includes('garden')) {
  throw new Error('fleet Garden must retain its registered agent admin network path');
}
for (const companion of fleetGardenCompanions) {
  assertIncludes(
    fleetGardenPolicy,
    `- ${companion.companionId}`,
    `fleet Garden policy registered target ${companion.companionId}`,
  );
}
assertIncludes(fleetGardenPolicy, 'component: postgres', 'fleet Garden Postgres egress');
const fleetPostgresPolicy = findDocumentByKindName(
  fleetGardenRendered,
  'NetworkPolicy',
  'psfn-postgres',
);
assertIncludes(fleetPostgresPolicy, 'component: garden', 'Postgres ingress from fleet Garden');
assertRenderFails(
  fleetGardenRenderArgs([]),
  'fleet.enabled=true requires at least one registered companion',
);
assertRenderFails(
  fleetGardenRenderArgs([fleetGardenCompanions[0], fleetGardenCompanions[0]]),
  `fleet companionId is duplicated: ${fleetGardenCompanions[0].companionId}`,
);
assertRenderFails(
  fleetGardenRenderArgs([
    fleetGardenCompanions[0],
    {
      ...fleetGardenCompanions[1],
      authSecret: { ...fleetGardenCompanions[1].authSecret, name: '' },
    },
  ]),
  'fleet.companions[1].authSecret.name is required',
);
assertRenderFails(
  [...fleetGardenRenderArgs(), '--set-string', 'psfnAppImage.tag=latest'],
  'fleet agent image tag must be pinned and must not be latest/main/main-latest',
);

// Fleet Auth credential env: fleet-auth.json references every credential as
// { kind: env, envName: FLEET_AUTH_* } and the gateway fails closed when a
// referenced env var is unset, so the chart must own the wiring (uzmj).
const fleetCredentialEnvArgs = [
  ...fleetGardenRenderArgs(),
  '--set-string', 'fleetAuth.credentialEnv[0].name=FLEET_AUTH_SESSION_PEPPER',
  '--set-string', 'fleetAuth.credentialEnv[0].secretRef.name=psfn-fleet-auth',
  '--set-string', 'fleetAuth.credentialEnv[0].secretRef.key=session-pepper',
];
const fleetCredentialEnvRendered = render(fleetCredentialEnvArgs);
const fleetCredentialGatewayEnv = findParsedDocumentByKindName(
  fleetCredentialEnvRendered,
  'Deployment',
  'psfn-gateway',
)?.spec?.template?.spec?.containers?.[0]?.env ?? [];
const fleetCredentialPepper = fleetCredentialGatewayEnv
  .find(entry => entry.name === 'FLEET_AUTH_SESSION_PEPPER');
if (fleetCredentialPepper?.valueFrom?.secretKeyRef?.name !== 'psfn-fleet-auth'
  || fleetCredentialPepper?.valueFrom?.secretKeyRef?.key !== 'session-pepper') {
  throw new Error('fleet gateway must bind FLEET_AUTH_SESSION_PEPPER from the named Secret key');
}
const fleetCredentialFloor = fleetCredentialGatewayEnv
  .find(entry => entry.name === 'FLEET_AUTH_AUTHORITY_FLOOR_ROOT');
if (fleetCredentialFloor?.value !== '/var/lib/psfn/fleet-auth-floor') {
  throw new Error('fleet gateway must bind FLEET_AUTH_AUTHORITY_FLOOR_ROOT to the chart-owned mount');
}
const fleetCredentialAgentEnv = findParsedDocumentByKindName(
  fleetCredentialEnvRendered,
  'Deployment',
  `psfn-agent-${fleetGardenCompanions[0].companionId}`,
)?.spec?.template?.spec?.containers?.[0]?.env ?? [];
if (fleetCredentialAgentEnv.some(entry => entry.name?.startsWith('FLEET_AUTH_'))) {
  throw new Error('Fleet Auth credential env is gateway-only and must never reach agent pods');
}

// Dedicated, non-restored Fleet Auth authority-floor persistence (qicb item 1).
const chartFloorPvc = findParsedDocumentByKindName(
  fleetCredentialEnvRendered,
  'PersistentVolumeClaim',
  'psfn-fleet-auth-floor',
);
if (chartFloorPvc?.spec?.resources?.requests?.storage !== '64Mi') {
  throw new Error('chart-managed Fleet Auth authority-floor PVC must default to 64Mi');
}
if ('storageClassName' in (chartFloorPvc?.spec ?? {})) {
  throw new Error('empty fleetAuth.authorityFloor.storageClassName must use the cluster default');
}
if (chartFloorPvc?.metadata?.annotations?.['helm.sh/resource-policy'] !== 'keep') {
  throw new Error(
    'chart-managed Fleet Auth authority-floor PVC must carry helm.sh/resource-policy: keep '
    + '(the never-backed-up anti-rollback anchor must survive helm uninstall and adoption pruning)',
  );
}
const chartFloorGateway = findParsedDocumentByKindName(
  fleetCredentialEnvRendered,
  'Deployment',
  'psfn-gateway',
);
const chartFloorVolume = chartFloorGateway?.spec?.template?.spec?.volumes
  ?.find(volume => volume.name === 'fleet-auth-authority-floor');
if (chartFloorVolume?.persistentVolumeClaim?.claimName !== 'psfn-fleet-auth-floor') {
  throw new Error('gateway must use the chart-managed Fleet Auth authority-floor claim');
}
const chartFloorMount = chartFloorGateway?.spec?.template?.spec?.containers?.[0]?.volumeMounts
  ?.find(mount => mount.name === 'fleet-auth-authority-floor');
if (chartFloorMount?.mountPath !== '/var/lib/psfn/fleet-auth-floor') {
  throw new Error('gateway must mount the Fleet Auth authority floor at its configured path');
}
const chartFloorInitContainers = chartFloorGateway?.spec?.template?.spec?.initContainers ?? [];
const chartFloorInitIndex = chartFloorInitContainers.findIndex(
  container => container.name === 'prepare-fleet-auth-authority-floor',
);
const chartFloorInit = chartFloorInitContainers[chartFloorInitIndex];
if (!chartFloorInit) {
  throw new Error('gateway must prepare the Fleet Auth authority floor before startup');
}
const chartFloorSeedIndex = chartFloorInitContainers.findIndex(
  container => container.name === 'seed-runtime-files',
);
if (chartFloorInitIndex !== 1 || chartFloorInitIndex >= chartFloorSeedIndex) {
  throw new Error(
    'Fleet Auth authority-floor preparation must immediately follow shared workspace bootstrap '
    + 'and precede owner seeding',
  );
}
if (chartFloorInit.securityContext?.capabilities?.drop?.join(',') !== 'ALL') {
  throw new Error('Fleet Auth authority-floor init must drop all ambient capabilities');
}
if (chartFloorInit.securityContext?.capabilities?.add?.join(',') !== 'CHOWN,FOWNER') {
  throw new Error('Fleet Auth authority-floor init must add only CAP_CHOWN and CAP_FOWNER');
}
if (!chartFloorInit.command?.[2]?.includes('chown 999:999 "$floor_root"')
    || !chartFloorInit.command?.[2]?.includes('chmod 0700 "$floor_root"')) {
  throw new Error('Fleet Auth authority-floor init must enforce uid/gid 999 and mode 0700');
}
if (!chartFloorInit.command?.[2]?.includes('999:999:700|999:999:2700)')
    || !chartFloorInit.command?.[2]?.includes('floor perms unexpected:')
    || !chartFloorInit.command?.[2]?.includes('>&2; exit 1')) {
  throw new Error(
    'Fleet Auth authority-floor init must accept 700/2700 and report observed mismatches',
  );
}

const adoptedFloorRendered = render([
  ...fleetGardenRenderArgs(),
  '--set-string', 'fleetAuth.authorityFloor.existingClaim=adopted-fleet-auth-floor',
  '--set-string', 'fleetAuth.authorityFloor.mountPath=/authority/floor',
]);
if (findDocumentByKindName(adoptedFloorRendered, 'PersistentVolumeClaim', 'psfn-fleet-auth-floor')) {
  throw new Error('fleetAuth.authorityFloor.existingClaim must suppress the chart-managed PVC');
}
const adoptedFloorGateway = findParsedDocumentByKindName(
  adoptedFloorRendered,
  'Deployment',
  'psfn-gateway',
);
const adoptedFloorVolume = adoptedFloorGateway?.spec?.template?.spec?.volumes
  ?.find(volume => volume.name === 'fleet-auth-authority-floor');
if (adoptedFloorVolume?.persistentVolumeClaim?.claimName !== 'adopted-fleet-auth-floor') {
  throw new Error('gateway must adopt fleetAuth.authorityFloor.existingClaim exactly');
}
const adoptedFloorContainer = adoptedFloorGateway?.spec?.template?.spec?.containers?.[0];
if (adoptedFloorContainer?.env?.find(entry => (
  entry.name === 'FLEET_AUTH_AUTHORITY_FLOOR_ROOT'
))?.value !== '/authority/floor') {
  throw new Error('adopted Fleet Auth authority floor must project its mount path as plain env');
}
if (adoptedFloorContainer?.volumeMounts?.find(mount => (
  mount.name === 'fleet-auth-authority-floor'
))?.mountPath !== '/authority/floor') {
  throw new Error('adopted Fleet Auth authority floor must use its configured gateway mount path');
}
assertRenderFails(
  [
    ...fleetGardenRenderArgs(),
    '--set-json', 'fleetAuth.authorityFloor=null',
  ],
  'fleetAuth.enabled=true requires fleetAuth.authorityFloor; set fleetAuth.authorityFloor.existingClaim to adopt an existing PVC or configure size for a chart-managed PVC',
);
assertRenderFails(
  [
    ...fleetGardenRenderArgs(),
    '--set-string', 'fleetAuth.credentialEnv[0].name=FLEET_AUTH_AUTHORITY_FLOOR_ROOT',
    '--set-string', 'fleetAuth.credentialEnv[0].secretRef.name=psfn-fleet-auth',
    '--set-string', 'fleetAuth.credentialEnv[0].secretRef.key=authority-floor-root',
  ],
  'must not set FLEET_AUTH_AUTHORITY_FLOOR_ROOT; remove this entry and configure fleetAuth.authorityFloor instead',
);
assertRenderFails(
  [
    '--set-string', 'fleetAuth.credentialEnv[0].name=FLEET_AUTH_SESSION_PEPPER',
    '--set-string', 'fleetAuth.credentialEnv[0].secretRef.name=psfn-fleet-auth',
    '--set-string', 'fleetAuth.credentialEnv[0].secretRef.key=session-pepper',
  ],
  'fleetAuth.credentialEnv requires fleetAuth.enabled=true',
);
assertRenderFails(
  [
    ...fleetCredentialEnvArgs,
    '--set-string', 'fleetAuth.credentialEnv[1].name=lowercase-name',
    '--set-string', 'fleetAuth.credentialEnv[1].secretRef.name=psfn-fleet-auth',
    '--set-string', 'fleetAuth.credentialEnv[1].secretRef.key=other',
  ],
  'fleetAuth.credentialEnv[1].name must match',
);
assertRenderFails(
  [
    ...fleetCredentialEnvArgs,
    '--set-string', 'fleetAuth.credentialEnv[1].name=FLEET_AUTH_SESSION_PEPPER',
    '--set-string', 'fleetAuth.credentialEnv[1].secretRef.name=psfn-fleet-auth',
    '--set-string', 'fleetAuth.credentialEnv[1].secretRef.key=other',
  ],
  'fleetAuth.credentialEnv name is duplicated: FLEET_AUTH_SESSION_PEPPER',
);
assertRenderFails(
  [
    ...fleetCredentialEnvArgs,
    '--set-string', 'fleetAuth.credentialEnv[1].name=FLEET_AUTH_RECOVERY_CREDENTIAL',
  ],
  'requires exactly one of a Secret reference or a plain value',
);
assertRenderFails(
  [
    ...fleetCredentialEnvArgs,
    '--set-string', 'fleetAuth.credentialEnv[1].name=FLEET_AUTH_RECOVERY_CREDENTIAL',
    '--set-string', 'fleetAuth.credentialEnv[1].secretRef.name=psfn-fleet-auth',
  ],
  'requires both secretRef.name and secretRef.key',
);
assertRenderFails(
  [
    ...fleetGardenRenderArgs(),
    '--set-json',
    'fleetAuth.credentialEnv=[{"name":"FLEET_AUTH_NULL_VALUE","value":null}]',
  ],
  'fleetAuth.credentialEnv[0] (FLEET_AUTH_NULL_VALUE) value must not be empty',
);

const internalOnlyGardenRendered = render([
  '--set', 'ingress.garden.enabled=false',
]);
if (findDocumentByKindName(internalOnlyGardenRendered, 'Ingress', 'psfn-garden')) {
  throw new Error('ingress.garden.enabled=false must suppress the Garden Ingress');
}
assertNotIncludes(
  findDocumentByKindName(internalOnlyGardenRendered, 'NetworkPolicy', 'psfn-garden'),
  'app.kubernetes.io/name: traefik',
  'internal-only Garden ingress controller policy',
);

const directGardenIngressRendered = render([
  '--set', 'ingress.garden.enabled=true',
  '--set-string', 'ingress.garden.host=garden.operator.test',
]);
const directGardenIngress = findDocumentByKindName(
  directGardenIngressRendered,
  'Ingress',
  'psfn-garden',
);
assertIncludes(directGardenIngress, 'host: "garden.operator.test"', 'opt-in Garden Ingress host');
assertIncludes(directGardenIngress, 'name: psfn-garden', 'opt-in Garden Ingress backend');
assertIncludes(directGardenIngress, 'name: http-garden', 'opt-in Garden Ingress service port');
const directGardenIngressPolicy = findDocumentByKindName(
  directGardenIngressRendered,
  'NetworkPolicy',
  'psfn-garden',
);
assertIncludes(
  directGardenIngressPolicy,
  'app.kubernetes.io/name: traefik',
  'opt-in Garden Ingress controller policy',
);
assertIncludes(
  findDocumentByKindName(directGardenIngressRendered, 'Deployment', 'psfn-garden'),
  'name: ADMIN_TOKEN',
  'opt-in Garden Ingress ADMIN_TOKEN',
);

const directGardenHostPortRendered = render([
  '--set', 'hostPorts.garden.enabled=true',
  '--set', 'hostPorts.garden.port=11054',
  '--set-string', 'hostPorts.garden.hostIP=127.0.0.1',
  '--set-string', 'hostPorts.garden.sourceCIDRs[0]=192.0.2.10/32',
]);
const directGardenHostPortDeployment = findDocumentByKindName(
  directGardenHostPortRendered,
  'Deployment',
  'psfn-garden',
);
assertIncludes(
  directGardenHostPortDeployment,
  'hostPort: 11054',
  'opt-in Garden hostPort',
);
assertIncludes(
  directGardenHostPortDeployment,
  'hostIP: "127.0.0.1"',
  'opt-in Garden hostIP',
);
assertIncludes(
  findDocumentByKindName(directGardenHostPortRendered, 'NetworkPolicy', 'psfn-garden'),
  'cidr: "192.0.2.10/32"',
  'opt-in Garden hostPort source CIDR',
);

// Owner-file seeding is fail-closed by default: the seed init container creates
// runtime dirs and the companion.json bootstrap, but must NOT copy *.seed.json
// owner files into system-data unless bootstrap.seedOwnerFiles is explicitly
// opted in. Runtime config must not seed itself (psfn-framework-9bgk).
assertIncludes(rendered, 'name: seed-runtime-files', 'seed init container present');
assertIncludes(
  rendered,
  'node /app/dist/migrate-required-settings-blocks.js',
  'required settings blocks migration command',
);
assertIncludes(rendered, 'mkdir -p', 'seed init container creates runtime dirs');
assertIncludes(
  rendered,
  'cp /seed/companion.json /app/companion-data/companion.json',
  'companion.json bootstrap copy retained',
);
assertNotIncludes(
  rendered,
  '/app/config/*.seed.json',
  'owner-file seeding disabled by default (fail closed)',
);

// Always-fleet deploy shape: every deployment is a fleet of one or more
// companions enumerated by the mandatory system-owned companions.json manifest;
// topology is derived from the entry count, not the retired PSFN_MULTI_COMPANION
// flag. The chart never synthesizes or overwrites this owner file.
const singleCompanionSeedCommand = renderedSeedCommand(rendered);
assertIncludes(
  singleCompanionSeedCommand,
  'companions_manifest="/app/system-data/companions.json"',
  'seed init resolves the companions.json manifest path',
);
assertNotIncludes(
  singleCompanionSeedCommand,
  'manifest_tmp=',
  'seed init must not synthesize companions.json',
);
assertIncludes(
  singleCompanionSeedCommand,
  'Missing required fleet manifest',
  'seed init fails closed on a missing fleet manifest',
);
// commonEnv must not carry the retired flag for the single-companion topology.
const singleCompanionGateway = findParsedDocumentByKindName(rendered, 'Deployment', 'psfn-gateway');
const singleCompanionGatewayEnv = new Map(
  (singleCompanionGateway?.spec?.template?.spec?.containers?.[0]?.env ?? [])
    .map(entry => [entry.name, entry.value]),
);
if (singleCompanionGatewayEnv.has('PSFN_MULTI_COMPANION')) {
  throw new Error('single-companion gateway must not set the retired PSFN_MULTI_COMPANION env');
}
const seededRender = render(['--set', 'bootstrap.seedOwnerFiles=true']);
assertIncludes(
  seededRender,
  'for src in /app/config/*.seed.json; do',
  'owner-file seeding opt-in via bootstrap.seedOwnerFiles=true',
);
assertIncludes(
  seededRender,
  'capability-tier.json|scheduler.json|charge-policy.json|skills.json)',
  'per-companion owner-file bootstrap partition',
);
assertIncludes(
  seededRender,
  'target_root="/app/companion-data"',
  'per-companion owner-file bootstrap root',
);
assertIncludes(
  seededRender,
  'target_root="/app/system-data"',
  'system owner-file bootstrap root',
);
assertNotIncludes(
  seededRender,
  'target="/app/system-data/${base%.seed.json}.json"',
  'obsolete all-owner system-data bootstrap target',
);

for (const [companionId, companionDataDir] of [
  ['aria', '/app/fleet/companions/aria'],
  ['beatrix', '/app/fleet/companions/beatrix'],
]) {
  const companionRender = render([
    '--set',
    'bootstrap.seedOwnerFiles=true',
    '--set-string',
    `runtime.companionId=${companionId}`,
    '--set-string',
    `runtime.companionDataDir=${companionDataDir}`,
    '--set-string',
    `runtime.characterCardPath=${companionDataDir}/companion.json`,
  ]);
  assertIncludes(
    companionRender,
    `target_root="${companionDataDir}"`,
    `${companionId} per-companion owner-file bootstrap root`,
  );
  assertIncludes(
    companionRender,
    'target_root="/app/system-data"',
    `${companionId} system owner-file bootstrap root`,
  );
}

assertIncludes(
  seededRender,
  'node /app/dist/migrate-scheduler-owner.js',
  'compiled scheduler schema migration before runtime startup',
);

const schedulerSeed = readFileSync(resolve(repoRoot, 'config/scheduler.seed.json'), 'utf8');
const preBundledScheduler = readFileSync(
  resolve(repoRoot, 'src/system/config/fixtures/scheduler.pre-bundled-owner.json'),
  'utf8',
);
const capabilityTierSeed = readFileSync(
  resolve(repoRoot, 'config/capability-tier.seed.json'),
  'utf8',
);
const chargePolicySeed = readFileSync(
  resolve(repoRoot, 'config/charge-policy.seed.json'),
  'utf8',
);
const skillsSeed = readFileSync(resolve(repoRoot, 'config/skills.seed.json'), 'utf8');
const perCompanionOwners = new Map([
  ['scheduler.json', schedulerSeed],
  ['capability-tier.json', capabilityTierSeed],
  ['charge-policy.json', chargePolicySeed],
  ['skills.json', skillsSeed],
]);
const helmAutoMigratedOwners = new Map([
  ['scheduler.json', schedulerSeed],
  ['capability-tier.json', capabilityTierSeed],
]);

const upgradeRoot = mkdtempSync(join(tmpdir(), 'psfn-helm-owner-upgrade-'));
try {
  const fixture = renderOwnerMigrationFixture(upgradeRoot, false);
  mkdirSync(fixture.systemDataDir, { recursive: true });
  mkdirSync(fixture.companionDataDir, { recursive: true });
  const legacyScheduler = preBundledScheduler.replace(
    '"tickIntervalMs": 60000',
    '"tickIntervalMs": 61000',
  );
  const legacyCapabilityTier = capabilityTierSeed.replace('"nursery"', '"mature"');
  const legacyOwners = new Map([
    ['scheduler.json', legacyScheduler],
    ['capability-tier.json', legacyCapabilityTier],
  ]);
  for (const [fileName, contents] of legacyOwners) {
    writeFileSync(join(fixture.systemDataDir, fileName), contents, 'utf8');
  }
  for (const [fileName, contents] of perCompanionOwners) {
    if (!helmAutoMigratedOwners.has(fileName)) {
      writeFileSync(join(fixture.companionDataDir, fileName), contents, 'utf8');
    }
  }

  // The same shared PVCs are mounted by all three workload init containers.
  // Prove their idempotent transaction tolerates a simultaneous rollout.
  await Promise.all([
    runOwnerMigrationCommandAsync(fixture.command),
    runOwnerMigrationCommandAsync(fixture.command),
    runOwnerMigrationCommandAsync(fixture.command),
  ]);
  for (const [fileName, contents] of legacyOwners) {
    const targetPath = join(fixture.companionDataDir, fileName);
    if (!existsSync(targetPath)) {
      throw new Error(`${fileName} was not migrated into companion-data`);
    }
    if (fileName === 'capability-tier.json' && readFileSync(targetPath, 'utf8') !== contents) {
      throw new Error('capability-tier.json was not migrated byte-for-byte');
    }
    const markerPath = join(
      fixture.companionDataDir,
      '.owner-migrations',
      `${fileName}.from-system.sha256`,
    );
    if (!existsSync(markerPath)) {
      throw new Error(`${fileName} migration marker was not recorded`);
    }
  }
  const migratedScheduler = JSON.parse(
    readFileSync(join(fixture.companionDataDir, 'scheduler.json'), 'utf8'),
  );
  if (migratedScheduler.salienceDecayIntervalMs !== undefined
    || migratedScheduler.socialGraphBuilder?.intervalMs !== undefined
    || migratedScheduler.backgroundMaintenance?.intervalMs !== 3_600_000) {
    throw new Error('legacy scheduler owner was not converted to backgroundMaintenance');
  }

  migratedScheduler.tickIntervalMs = 62_000;
  const companionScheduler = `${JSON.stringify(migratedScheduler, null, 2)}\n`;
  writeFileSync(
    join(fixture.companionDataDir, 'scheduler.json'),
    companionScheduler,
    'utf8',
  );
  runOwnerMigrationCommand(fixture.command);
  if (readFileSync(join(fixture.companionDataDir, 'scheduler.json'), 'utf8') !== companionScheduler) {
    throw new Error('an already-migrated companion owner was overwritten by its legacy source');
  }

  writeFileSync(
    join(fixture.systemDataDir, 'scheduler.json'),
    legacyScheduler.replace('"tickIntervalMs": 61000', '"tickIntervalMs": 63000'),
    'utf8',
  );
  const changedLegacyOutput = runOwnerMigrationCommand(fixture.command, 1);
  assertIncludes(
    changedLegacyOutput,
    'Legacy owner changed after migration',
    'changed legacy owner fail-closed error',
  );
} finally {
  rmSync(upgradeRoot, { recursive: true, force: true });
}

const ambiguousRoot = mkdtempSync(join(tmpdir(), 'psfn-helm-owner-ambiguous-'));
try {
  const fixture = renderOwnerMigrationFixture(ambiguousRoot, false);
  mkdirSync(fixture.systemDataDir, { recursive: true });
  mkdirSync(fixture.companionDataDir, { recursive: true });
  writeFileSync(join(fixture.systemDataDir, 'scheduler.json'), schedulerSeed, 'utf8');
  writeFileSync(
    join(fixture.companionDataDir, 'scheduler.json'),
    schedulerSeed.replace('"tickIntervalMs": 60000', '"tickIntervalMs": 61000'),
    'utf8',
  );
  const ambiguousOutput = runOwnerMigrationCommand(fixture.command, 1);
  assertIncludes(
    ambiguousOutput,
    'Refusing ambiguous per-companion owner migration',
    'divergent unmarked owner fail-closed error',
  );
} finally {
  rmSync(ambiguousRoot, { recursive: true, force: true });
}

const identicalRoot = mkdtempSync(join(tmpdir(), 'psfn-helm-owner-identical-'));
try {
  const fixture = renderOwnerMigrationFixture(identicalRoot, false);
  mkdirSync(fixture.systemDataDir, { recursive: true });
  mkdirSync(fixture.companionDataDir, { recursive: true });
  for (const [fileName, contents] of helmAutoMigratedOwners) {
    writeFileSync(join(fixture.systemDataDir, fileName), contents, 'utf8');
    writeFileSync(join(fixture.companionDataDir, fileName), contents, 'utf8');
  }
  for (const [fileName, contents] of perCompanionOwners) {
    if (!helmAutoMigratedOwners.has(fileName)) {
      writeFileSync(join(fixture.companionDataDir, fileName), contents, 'utf8');
    }
  }
  runOwnerMigrationCommand(fixture.command);
  for (const fileName of helmAutoMigratedOwners.keys()) {
    if (!existsSync(join(
      fixture.companionDataDir,
      '.owner-migrations',
      `${fileName}.from-system.sha256`,
    ))) {
      throw new Error(`${fileName} identical legacy and target state was not recorded`);
    }
  }
  for (const fileName of perCompanionOwners.keys()) {
    if (!helmAutoMigratedOwners.has(fileName) && existsSync(join(
      fixture.companionDataDir,
      '.owner-migrations',
      `${fileName}.from-system.sha256`,
    ))) {
      throw new Error(`${fileName} target-only state was incorrectly recorded as a migration`);
    }
  }
} finally {
  rmSync(identicalRoot, { recursive: true, force: true });
}

const targetOnlyRoot = mkdtempSync(join(tmpdir(), 'psfn-helm-owner-target-only-'));
try {
  const fixture = renderOwnerMigrationFixture(targetOnlyRoot, false);
  mkdirSync(fixture.companionDataDir, { recursive: true });
  for (const [fileName, contents] of perCompanionOwners) {
    writeFileSync(join(fixture.companionDataDir, fileName), contents, 'utf8');
  }
  runOwnerMigrationCommand(fixture.command);
  if (existsSync(join(fixture.companionDataDir, '.owner-migrations'))) {
    const unexpectedMarkers = Array.from(perCompanionOwners.keys()).some(fileName => existsSync(join(
      fixture.companionDataDir,
      '.owner-migrations',
      `${fileName}.from-system.sha256`,
    )));
    if (unexpectedMarkers) {
      throw new Error('target-only owner state was incorrectly recorded as a legacy migration');
    }
  }
} finally {
  rmSync(targetOnlyRoot, { recursive: true, force: true });
}

const missingRoot = mkdtempSync(join(tmpdir(), 'psfn-helm-owner-missing-'));
try {
  const fixture = renderOwnerMigrationFixture(missingRoot, false);
  const missingOutput = runOwnerMigrationCommand(fixture.command, 1);
  assertIncludes(
    missingOutput,
    'Missing required per-companion owner file after bootstrap/migration',
    'missing owner with seeding disabled fail-closed error',
  );
} finally {
  rmSync(missingRoot, { recursive: true, force: true });
}

const unsupportedLegacyOwnersRoot = mkdtempSync(
  join(tmpdir(), 'psfn-helm-owner-explicit-fleet-migration-required-'),
);
try {
  const fixture = renderOwnerMigrationFixture(unsupportedLegacyOwnersRoot, false);
  mkdirSync(fixture.systemDataDir, { recursive: true });
  mkdirSync(fixture.companionDataDir, { recursive: true });
  for (const [fileName, contents] of helmAutoMigratedOwners) {
    writeFileSync(join(fixture.companionDataDir, fileName), contents, 'utf8');
  }
  for (const [fileName, contents] of perCompanionOwners) {
    if (!helmAutoMigratedOwners.has(fileName)) {
      writeFileSync(join(fixture.systemDataDir, fileName), contents, 'utf8');
    }
  }

  const unsupportedLegacyOutput = runOwnerMigrationCommand(fixture.command, 1);
  assertIncludes(
    unsupportedLegacyOutput,
    'Missing required per-companion owner file after bootstrap/migration',
    'charge/skills legacy system owners require explicit fleet migration',
  );
  for (const [fileName, contents] of perCompanionOwners) {
    if (helmAutoMigratedOwners.has(fileName)) continue;
    if (readFileSync(join(fixture.systemDataDir, fileName), 'utf8') !== contents) {
      throw new Error(`${fileName} unsupported legacy source was changed`);
    }
    if (existsSync(join(fixture.companionDataDir, fileName))) {
      throw new Error(`${fileName} was implicitly migrated by the Helm compatibility path`);
    }
  }
} finally {
  rmSync(unsupportedLegacyOwnersRoot, { recursive: true, force: true });
}

const missingMarkedTargetRoot = mkdtempSync(
  join(tmpdir(), 'psfn-helm-owner-missing-marked-target-'),
);
try {
  const fixture = renderOwnerMigrationFixture(missingMarkedTargetRoot, false);
  const migrationDir = join(fixture.companionDataDir, '.owner-migrations');
  mkdirSync(migrationDir, { recursive: true });
  writeFileSync(
    join(migrationDir, 'scheduler.json.from-system.sha256'),
    `${'0'.repeat(64)}\n`,
    'utf8',
  );
  const missingMarkedTargetOutput = runOwnerMigrationCommand(fixture.command, 1);
  assertIncludes(
    missingMarkedTargetOutput,
    'Owner migration marker exists but target is missing',
    'missing marked target fail-closed error',
  );
} finally {
  rmSync(missingMarkedTargetRoot, { recursive: true, force: true });
}

const freshInstallRoot = mkdtempSync(join(tmpdir(), 'psfn-helm-owner-fresh-'));
try {
  const fixture = renderOwnerMigrationFixture(freshInstallRoot, true);
  runOwnerMigrationCommand(fixture.command);
  for (const [fileName, contents] of perCompanionOwners) {
    const companionPath = join(fixture.companionDataDir, fileName);
    if (readFileSync(companionPath, 'utf8') !== contents) {
      throw new Error(`fresh install did not seed ${fileName} into companion-data`);
    }
    if (existsSync(join(fixture.systemDataDir, fileName))) {
      throw new Error(`fresh install incorrectly seeded ${fileName} into system-data`);
    }
  }
  if (!existsSync(join(fixture.systemDataDir, 'settings.json'))) {
    throw new Error('fresh install did not seed cluster-global settings.json into system-data');
  }
} finally {
  rmSync(freshInstallRoot, { recursive: true, force: true });
}

const liteLlmConfig = findDocumentByKindName(rendered, 'ConfigMap', 'psfn-litellm-config');
assertIncludes(liteLlmConfig, 'model_name: "openrouter/*"', 'LiteLLM OpenRouter wildcard config');
assertIncludes(
  liteLlmConfig,
  'model_name: "z-ai-glm-5.2-nitro"',
  'LiteLLM colon-free GLM 5.2 Nitro alias',
);
assertIncludes(
  liteLlmConfig,
  'model: "openrouter/z-ai/glm-5.2:nitro"',
  'LiteLLM GLM 5.2 Nitro upstream variant',
);
assertIncludes(liteLlmConfig, 'reasoning_effort: "none"', 'LiteLLM Nitro reasoning disabled');
assertIncludes(liteLlmConfig, 'api_key: "os.environ/OPENROUTER_API_KEY"', 'LiteLLM provider key env reference');
assertIncludes(liteLlmConfig, 'master_key: "os.environ/LITELLM_MASTER_KEY"', 'LiteLLM master key env reference');

const liteLlmService = findDocumentByKindName(rendered, 'Service', 'psfn-litellm');
assertIncludes(liteLlmService, 'name: http-proxy', 'LiteLLM Service port name');
assertIncludes(liteLlmService, 'port: 4000', 'LiteLLM Service port value');
assertIncludes(liteLlmService, 'targetPort: http-proxy', 'LiteLLM Service target port');
assertIncludes(liteLlmService, 'app.kubernetes.io/component: litellm', 'LiteLLM Service selector');

const liteLlmDeployment = findDocumentByKindName(rendered, 'Deployment', 'psfn-litellm');
assertIncludes(
  liteLlmDeployment,
  'image: "ghcr.io/berriai/litellm:v1.74.9-stable@sha256:f78c763d6f2289305a3acc3a003c6170f797bdda70c56e75776fbab670e663cc"',
  'LiteLLM pinned image',
);
assertIncludes(liteLlmDeployment, '- litellm', 'LiteLLM command');
assertIncludes(liteLlmDeployment, '- "/etc/litellm/config.yaml"', 'LiteLLM config command path');
assertIncludes(liteLlmDeployment, '- --port', 'LiteLLM port arg');
assertIncludes(liteLlmDeployment, '- "4000"', 'LiteLLM port arg value');
assertIncludes(liteLlmDeployment, 'containerPort: 4000', 'LiteLLM container port');
assertIncludes(liteLlmDeployment, 'name: LITELLM_MASTER_KEY', 'LiteLLM master key env');
assertIncludes(liteLlmDeployment, 'key: LITELLM_API_KEY', 'LiteLLM master key secret key');
assertIncludes(liteLlmDeployment, 'name: OPENROUTER_API_KEY', 'LiteLLM OpenRouter env');
assertIncludes(liteLlmDeployment, 'mountPath: /etc/litellm', 'LiteLLM config mount');
assertIncludes(liteLlmDeployment, 'runAsUser: 999', 'LiteLLM numeric user');

const gatewayPolicy = findDocumentByKindName(rendered, 'NetworkPolicy', 'psfn-gateway');
assertIncludes(gatewayPolicy, 'component: litellm', 'gateway policy LiteLLM egress');
assertIncludes(gatewayPolicy, 'port: 4000', 'gateway policy LiteLLM port');
// x5rt.10: operator confirmation resolution ingress comes from the Garden
// operator process, not the agent.
assertIncludes(gatewayPolicy, 'component: garden', 'gateway policy garden operator API ingress');
assertIncludes(gatewayPolicy, 'port: 10053', 'gateway policy garden operator API ingress port');

const gardenPolicy = findDocumentByKindName(rendered, 'NetworkPolicy', 'psfn-garden');
assertIncludes(gardenPolicy, 'component: agent', 'garden policy agent admin transport egress');
assertIncludes(gardenPolicy, 'component: gateway', 'garden policy gateway operator API egress');
assertIncludes(gardenPolicy, 'port: 10053', 'garden policy gateway operator API egress port');

const liteLlmPolicy = findDocumentByKindName(rendered, 'NetworkPolicy', 'psfn-litellm');
assertIncludes(liteLlmPolicy, 'component: litellm', 'LiteLLM policy selector');
assertIncludes(liteLlmPolicy, 'component: gateway', 'LiteLLM policy gateway ingress');
assertNotIncludes(liteLlmPolicy, 'component: agent', 'LiteLLM policy agent ingress');
assertIncludes(liteLlmPolicy, 'k8s-app: kube-dns', 'LiteLLM DNS egress');
assertIncludes(liteLlmPolicy, 'cidr: 0.0.0.0/0', 'LiteLLM provider egress');
assertIncludes(liteLlmPolicy, 'port: 443', 'LiteLLM HTTPS egress port');

const strictSecretRendered = render([
  '--set',
  'secrets.allowMissingRequired=false',
  '--set-string',
  'secrets.values.apiKey=verify-api-key',
  '--set-string',
  'secrets.values.adminToken=verify-admin-token',
  '--set-string',
  'secrets.values.gatewaySessionHmacKey=verify-hmac-key',
  '--set-string',
  'secrets.values.gatewaySessionIntegrityAuthToken=verify-worker-proof',
  '--set-string',
  'secrets.values.gatewayCompanionAuthToken=verify-agent-proof',
  '--set-string',
  'secrets.values.backupEncryptionKey=verify-backup-key',
]);

assertIncludes(strictSecretRendered, 'API_KEY: "verify-api-key"', 'strict app secret API key');
assertIncludes(strictSecretRendered, 'ADMIN_TOKEN: "verify-admin-token"', 'strict app secret admin token');
assertIncludes(strictSecretRendered, 'GATEWAY_SESSION_HMAC_KEY: "verify-hmac-key"', 'strict app secret HMAC key');
assertIncludes(
  strictSecretRendered,
  'GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN: "verify-worker-proof"',
  'strict app secret isolated session-integrity proof',
);
assertIncludes(
  strictSecretRendered,
  'GATEWAY_COMPANION_AUTH_TOKEN: "verify-agent-proof"',
  'strict app secret companion agent proof',
);
assertIncludes(strictSecretRendered, 'PSFN_BACKUP_ENCRYPTION_KEY: "verify-backup-key"', 'strict app secret backup encryption key');

const strictAgent = findDocumentByKindName(strictSecretRendered, 'Deployment', 'psfn-agent');
assertIncludes(strictAgent, 'name: PSFN_BACKUP_ENCRYPTION_KEY', 'agent backup encryption env');
assertIncludes(strictAgent, 'key: PSFN_BACKUP_ENCRYPTION_KEY', 'agent backup encryption secret key');

const externalLiteLlmRendered = render([
  '--set',
  'liteLlm.mode=external',
  '--set',
  'liteLlm.external.baseUrl=https://litellm.example.test/v1',
]);
const externalLiteLlmGateway = findDocumentByKindName(externalLiteLlmRendered, 'Deployment', 'psfn-gateway');
assertIncludes(externalLiteLlmGateway, 'value: "https://litellm.example.test/v1"', 'external LiteLLM gateway URL');
assertNotIncludes(externalLiteLlmRendered, 'name: psfn-litellm\n', 'external LiteLLM bundled Service/Deployment');
assertNotIncludes(externalLiteLlmRendered, 'component: litellm', 'external LiteLLM bundled selectors');

const disabledLiteLlmRendered = render([
  '--set',
  'liteLlm.enabled=false',
]);
assertNotIncludes(disabledLiteLlmRendered, 'LITELLM_BASE_URL', 'disabled LiteLLM gateway env');
assertNotIncludes(disabledLiteLlmRendered, 'name: psfn-litellm\n', 'disabled LiteLLM bundled Service/Deployment');
assertNotIncludes(disabledLiteLlmRendered, 'component: litellm', 'disabled LiteLLM selectors');

const externalRendered = render([
  '--set',
  'postgres.enabled=false',
  '--set',
  'postgres.external.enabled=true',
  '--set',
  'postgres.external.databaseUrlSecret.name=external-pg',
  '--set',
  'redis.mode=external',
  '--set',
  'redis.external.url=redis://external-redis:6379',
  '--set',
  'redis.external.passwordSecret.name=external-redis-secret',
]);

assertIncludes(externalRendered, 'name: external-pg', 'external Postgres secret ref');
assertIncludes(externalRendered, 'value: "redis://external-redis:6379"', 'external Redis URL');
assertNotIncludes(externalRendered, 'name: psfn-postgres\n', 'bundled Postgres resources in external mode');
assertNotIncludes(externalRendered, 'name: psfn-redis\n', 'bundled Redis resources in external mode');

const hubDigest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const hubIdentityArgs = [
  '--set',
  'satelliteHub.identity.satelliteId=hub-verify',
  '--set',
  'satelliteHub.identity.endpointId=hub-verify-main',
  '--set',
  'satelliteHub.identity.claimType=voice-only',
];
const hubRendered = render([
  '--set',
  'satelliteHub.enabled=true',
  '--set',
  'satelliteHub.image.repository=localhost/psfn-satellite-hub',
  '--set',
  'satelliteHub.image.tag=0.1.0-kube-de65b21dfbc3',
  '--set-string',
  `satelliteHub.image.digest=${hubDigest}`,
  '--set-string',
  'satelliteHub.elevenLabsVoiceId=voice-verify',
  ...hubIdentityArgs,
  '--set-string',
  'secrets.values.satelliteHubApiKey=verify-hub-satellite-key',
  '--set-string',
  'secrets.values.extraSatelliteApiKeys=verify-extra-satellite-key',
  '--set-string',
  'secrets.values.deepgramApiKey=verify-deepgram',
  '--set-string',
  'secrets.values.elevenLabsApiKey=verify-eleven',
  '--set',
  'ingress.satelliteHub.enabled=true',
  '--set',
  'ingress.satelliteHub.path=/satellite',
  '--set',
  'hostPorts.satelliteHub.enabled=true',
  '--set',
  'hostPorts.satelliteHub.sourceCIDRs[0]=192.0.2.0/24',
]);

const hubSecret = findDocumentByKindName(hubRendered, 'Secret', 'psfn-app');
assertIncludes(hubSecret, 'DEEPGRAM_API_KEY: "verify-deepgram"', 'satellite hub Deepgram secret');
assertIncludes(hubSecret, 'ELEVENLABS_API_KEY: "verify-eleven"', 'satellite hub ElevenLabs secret');
assertIncludes(hubSecret, 'SATELLITE_HUB_API_KEY: "verify-hub-satellite-key"', 'satellite hub dedicated API key secret');
assertIncludes(
  hubSecret,
  'API_SATELLITE_KEYS: "verify-hub-satellite-key,verify-extra-satellite-key"',
  'gateway satellite key list composed from hub key plus extras',
);

const hubGatewayDeployment = findDocumentByKindName(hubRendered, 'Deployment', 'psfn-gateway');
assertIncludes(hubGatewayDeployment, 'name: API_SATELLITE_KEYS', 'gateway satellite keys env');
assertIncludes(hubGatewayDeployment, 'key: API_SATELLITE_KEYS', 'gateway satellite keys secret key');

const hubDeployment = findDocumentByKindName(hubRendered, 'Deployment', 'psfn-satellite-hub');
assertIncludes(hubDeployment, `image: "localhost/psfn-satellite-hub:0.1.0-kube-de65b21dfbc3@${hubDigest}"`, 'satellite hub pinned image');
assertIncludes(hubDeployment, '- node', 'satellite hub command node');
assertIncludes(hubDeployment, '- dist/ts/hub/main.js', 'satellite hub command entrypoint');
assertIncludes(hubDeployment, 'runAsUser: 999', 'satellite hub numeric user');
assertIncludes(hubDeployment, 'type: Recreate', 'satellite hub Recreate strategy');
assertIncludes(hubDeployment, 'name: hub-ws', 'satellite hub websocket port');
assertIncludes(hubDeployment, 'containerPort: 8787', 'satellite hub websocket container port');
assertIncludes(hubDeployment, 'hostPort: 8787', 'satellite hub websocket hostPort');
assertIncludes(hubDeployment, 'path: /', 'satellite hub health probe path');
assertIncludes(hubDeployment, 'mountPath: /app/.artifacts', 'satellite hub artifact mount');
assertIncludes(hubDeployment, 'name: AGENT_RUNTIME', 'satellite hub agent runtime env');
assertIncludes(hubDeployment, 'value: "psfn"', 'satellite hub PSFN runtime');
assertIncludes(hubDeployment, 'name: REALTIME_VOICE_PORT', 'satellite hub listen port env');
assertIncludes(hubDeployment, 'value: "8787"', 'satellite hub listen port value');
assertIncludes(hubDeployment, 'name: PSFN_API_BASE_URL', 'satellite hub PSFN API env');
assertIncludes(hubDeployment, 'value: "http://psfn-gateway:10053/v1"', 'satellite hub in-cluster gateway API wiring');
assertIncludes(hubDeployment, 'name: PSFN_API_KEY', 'satellite hub API key env');
assertIncludes(hubDeployment, 'key: SATELLITE_HUB_API_KEY', 'satellite hub dedicated (H4) API key secret key');
assertNotIncludes(hubDeployment, 'key: API_KEY\n', 'satellite hub shared operator API key');
assertIncludes(hubDeployment, 'name: PSFN_SATELLITE_ID', 'satellite hub registry satellite id env');
assertIncludes(hubDeployment, 'value: "hub-verify"', 'satellite hub registry satellite id value');
assertIncludes(hubDeployment, 'name: PSFN_ENDPOINT_ID', 'satellite hub registry endpoint id env');
assertIncludes(hubDeployment, 'value: "hub-verify-main"', 'satellite hub registry endpoint id value');
assertIncludes(hubDeployment, 'name: PSFN_CLAIM_TYPE', 'satellite hub claim type env');
assertIncludes(hubDeployment, 'value: "voice-only"', 'satellite hub claim type value');
assertIncludes(hubDeployment, 'name: PSFN_COMPANION_BASE_URL', 'satellite hub companion bridge env');
assertIncludes(hubDeployment, 'name: DEEPGRAM_API_KEY', 'satellite hub Deepgram env');
assertIncludes(hubDeployment, 'key: DEEPGRAM_API_KEY', 'satellite hub Deepgram secret key');
assertIncludes(hubDeployment, 'name: ELEVENLABS_API_KEY', 'satellite hub ElevenLabs env');
assertIncludes(hubDeployment, 'key: ELEVENLABS_API_KEY', 'satellite hub ElevenLabs secret key');
assertIncludes(hubDeployment, 'name: ELEVENLABS_VOICE_ID', 'satellite hub ElevenLabs voice env');
assertIncludes(hubDeployment, 'value: "voice-verify"', 'satellite hub ElevenLabs voice value');
assertIncludes(hubDeployment, 'name: ARTIFACT_ROOT', 'satellite hub artifact env');
assertNotIncludes(hubDeployment, 'HUB_TEXT_ONLY', 'voice-mode hub text-only env');
assertNotIncludes(hubDeployment, 'optional: true', 'satellite hub secret refs');
assertIncludes(hubDeployment, 'mountPath: /run/psfn/tls/psfn-client', 'satellite hub staged mTLS client cert mount');
assertIncludes(hubDeployment, 'secretName: psfn-satellite-hub-client-tls', 'satellite hub client cert secret volume');

const hubClientCert = findDocumentByKindName(hubRendered, 'Certificate', 'psfn-satellite-hub-client');
assertIncludes(hubClientCert, 'secretName: psfn-satellite-hub-client-tls', 'satellite hub client Certificate secret');
assertIncludes(
  hubClientCert,
  'spiffe://cluster.local/psfn/satellite-hub/11111111-1111-4111-8111-111111111111',
  'satellite hub client Certificate SPIFFE URI',
);
assertIncludes(hubClientCert, 'renewBefore:', 'satellite hub client Certificate renewal');

const piHubOverlayRendered = render([
  '-f',
  resolve(chartDir, 'overlays/pi-satellite-hub.values.yaml'),
  '--set',
  'satelliteHub.image.tag=0.1.0-kube-de65b21dfbc3',
  '--set-string',
  'secrets.values.satelliteHubApiKey=verify-hub-satellite-key',
]);
const piHubDevices = findDocumentByKindName(piHubOverlayRendered, 'ConfigMap', 'psfn-hub-devices');
assertIncludes(
  piHubDevices,
  '\"control\":[\"interrupt\",\"presence\",\"session_attach\",\"approvals\",\"touch\"]',
  'Pi companion app touch capability grant',
);

const hubTextOnlyRendered = render([
  '--set',
  'satelliteHub.enabled=true',
  '--set',
  'satelliteHub.image.repository=localhost/psfn-satellite-hub',
  '--set',
  'satelliteHub.image.tag=0.1.0-kube-de65b21dfbc3',
  ...hubIdentityArgs,
  '--set',
  'satelliteHub.textOnly=true',
  '--set-string',
  'secrets.values.satelliteHubApiKey=verify-hub-satellite-key',
]);
const hubTextOnlyDeployment = findDocumentByKindName(hubTextOnlyRendered, 'Deployment', 'psfn-satellite-hub');
assertIncludes(hubTextOnlyDeployment, 'name: HUB_TEXT_ONLY', 'text-only hub mode env');
assertIncludes(hubTextOnlyDeployment, 'value: "true"', 'text-only hub mode value');
assertNotIncludes(hubTextOnlyDeployment, 'ELEVENLABS_VOICE_ID', 'text-only hub voice id env');
// Voice provider refs must be tolerated as absent in text-only mode.
assertIncludes(hubTextOnlyDeployment, 'optional: true', 'text-only hub optional voice secret refs');

// Fail-closed guards: registry identity is mandatory, voice mode requires the
// ElevenLabs voice id, and weak hub keys are rejected at render time.
assertRenderFails(
  [
    '--set',
    'satelliteHub.enabled=true',
    '--set',
    'satelliteHub.image.repository=localhost/psfn-satellite-hub',
    '--set',
    'satelliteHub.image.tag=0.1.0-kube-de65b21dfbc3',
    '--set-string',
    'satelliteHub.elevenLabsVoiceId=voice-verify',
  ],
  'satelliteHub.identity.satelliteId is required when satelliteHub.enabled=true',
);
assertRenderFails(
  [
    '--set-string',
    'secrets.values.satelliteHubApiKey=short',
  ],
  'secrets.values.satelliteHubApiKey must be at least 16 characters',
);

const hubService = findDocumentByKindName(hubRendered, 'Service', 'psfn-satellite-hub');
assertIncludes(hubService, 'name: hub-ws', 'satellite hub Service websocket port');
assertIncludes(hubService, 'port: 8787', 'satellite hub Service websocket port value');
assertIncludes(hubService, 'targetPort: hub-ws', 'satellite hub Service target port');

const hubIngress = findDocumentByKindName(hubRendered, 'Ingress', 'psfn-satellite-hub');
assertIncludes(hubIngress, 'path: "/satellite"', 'satellite hub configured Ingress path');
assertIncludes(hubIngress, 'name: hub-ws', 'satellite hub Ingress service port');

const hubPolicy = findDocumentByKindName(hubRendered, 'NetworkPolicy', 'psfn-satellite-hub');
assertIncludes(hubPolicy, 'app.kubernetes.io/name: traefik', 'satellite hub ingress controller policy');
assertIncludes(hubPolicy, 'k8s-app: kube-dns', 'satellite hub DNS egress');
assertIncludes(hubPolicy, 'component: gateway', 'satellite hub gateway egress');
assertIncludes(hubPolicy, 'cidr: 0.0.0.0/0', 'satellite hub provider HTTPS egress');
assertIncludes(hubPolicy, 'port: 443', 'satellite hub HTTPS egress port');

const hubEnabledAgentPolicy = findDocumentByKindName(hubRendered, 'NetworkPolicy', 'psfn-agent');
assertNotIncludes(hubEnabledAgentPolicy, '0.0.0.0/0', 'hub-enabled agent policy broad egress');
assertNotIncludes(hubEnabledAgentPolicy, 'component: satellite-hub', 'hub-enabled agent policy satellite access');

const hubDigestOnlyRendered = render([
  '--set',
  'satelliteHub.enabled=true',
  '--set',
  'satelliteHub.image.repository=localhost/psfn-satellite-hub',
  '--set-string',
  `satelliteHub.image.digest=${hubDigest}`,
  '--set-string',
  'satelliteHub.elevenLabsVoiceId=voice-verify',
  ...hubIdentityArgs,
]);
const hubDigestOnlyDeployment = findDocumentByKindName(hubDigestOnlyRendered, 'Deployment', 'psfn-satellite-hub');
assertIncludes(hubDigestOnlyDeployment, `image: "localhost/psfn-satellite-hub@${hubDigest}"`, 'satellite hub digest-only image');

const companionUiDigest = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const companionUiAuthorityArgs = [
  '--set',
  'fleetAuth.enabled=true',
  '--set-string',
  'runtime.companionId=11111111-1111-4111-8111-111111111111',
  '--set',
  'ingress.gateway.tls.enabled=true',
  '--set-string',
  'ingress.gateway.tls.secretName=psfn-public-origin-tls',
  '--set-string',
  'fleetAuth.companionUiCompanionId=11111111-1111-4111-8111-111111111111',
  '--set',
  'satelliteHub.enabled=true',
  '--set',
  'satelliteHub.textOnly=true',
  '--set',
  'satelliteHub.image.repository=localhost/psfn-satellite-hub',
  '--set-string',
  `satelliteHub.image.digest=${hubDigest}`,
  '--set-string',
  'secrets.values.satelliteHubApiKey=verify-hub-satellite-key',
  ...hubIdentityArgs,
];
const companionUiRendered = render([
  ...companionUiAuthorityArgs,
  '--set',
  'companionUiTest.enabled=true',
  '--set',
  'companionUiTest.image.repository=localhost/psfn-companion-ui',
  '--set',
  'companionUiTest.image.tag=0.1.0-kube-abcdef012345',
  '--set-string',
  `companionUiTest.image.digest=${companionUiDigest}`,
]);

const companionUiDeployment = findDocumentByKindName(companionUiRendered, 'Deployment', 'psfn-companion-ui-test');
assertIncludes(companionUiDeployment, `image: "localhost/psfn-companion-ui:0.1.0-kube-abcdef012345@${companionUiDigest}"`, 'companion-ui test pinned image');
assertIncludes(companionUiDeployment, 'runAsUser: 999', 'companion-ui test numeric user');
assertIncludes(companionUiDeployment, 'runAsGroup: 999', 'companion-ui test numeric group');
assertIncludes(companionUiDeployment, 'name: http-ui', 'companion-ui test port name');
assertIncludes(companionUiDeployment, 'containerPort: 8080', 'companion-ui test container port');
assertIncludes(companionUiDeployment, 'path: /companion-ui/', 'companion-ui test health probe path');
assertNotIncludes(companionUiDeployment, 'POSTGRES_DATABASE_URL', 'companion-ui test has no runtime secret wiring');
assertNotIncludes(companionUiDeployment, 'secretKeyRef', 'companion-ui test has no secret references');

const companionUiService = findDocumentByKindName(companionUiRendered, 'Service', 'psfn-companion-ui-test');
assertIncludes(companionUiService, 'type: ClusterIP', 'companion-ui test internal-only Service');
assertIncludes(companionUiService, 'name: http-ui', 'companion-ui test Service port name');
assertIncludes(companionUiService, 'port: 8080', 'companion-ui test Service port value');
assertIncludes(companionUiService, 'targetPort: http-ui', 'companion-ui test Service target port');

const companionUiIngress = findDocumentByKindName(companionUiRendered, 'Ingress', 'psfn-companion-ui-test');
if (companionUiIngress) throw new Error('companion-ui must not render a direct browser Ingress');

const companionUiPolicy = findDocumentByKindName(companionUiRendered, 'NetworkPolicy', 'psfn-companion-ui-test');
assertIncludes(companionUiPolicy, 'component: gateway', 'companion-ui test gateway-only ingress policy');
assertIncludes(companionUiPolicy, 'port: 8080', 'companion-ui test policy ingress port');
assertIncludes(companionUiPolicy, 'egress: []', 'companion-ui test policy denies all egress');
assertNotIncludes(companionUiPolicy, '0.0.0.0/0', 'companion-ui test policy has no broad egress');

const companionUiDigestOnlyRendered = render([
  ...companionUiAuthorityArgs,
  '--set',
  'companionUiTest.enabled=true',
  '--set',
  'companionUiTest.image.repository=localhost/psfn-companion-ui',
  '--set-string',
  `companionUiTest.image.digest=${companionUiDigest}`,
]);
const companionUiDigestOnlyDeployment = findDocumentByKindName(companionUiDigestOnlyRendered, 'Deployment', 'psfn-companion-ui-test');
assertIncludes(companionUiDigestOnlyDeployment, `image: "localhost/psfn-companion-ui@${companionUiDigest}"`, 'companion-ui test digest-only image');

assertRenderFails([
  ...companionUiAuthorityArgs,
  '--set',
  'companionUiTest.enabled=true',
  '--set',
  'companionUiTest.image.repository=localhost/psfn-companion-ui',
  '--set-string',
  `companionUiTest.image.digest=${companionUiDigest}`,
  '--set',
  'companionUiTest.service.type=NodePort',
], 'companionUiTest.service.type must be ClusterIP');

const fleetAuthRequiredValues = [
  '--set',
  'fleetAuth.enabled=true',
  '--set-string',
  'runtime.companionId=11111111-1111-4111-8111-111111111111',
  '--set',
  'ingress.gateway.tls.enabled=true',
  '--set-string',
  'ingress.gateway.tls.secretName=psfn-public-origin-tls',
];
const unifiedOriginRendered = render([
  ...companionUiAuthorityArgs,
  '--set',
  'companionUiTest.enabled=true',
  '--set',
  'companionUiTest.image.repository=localhost/psfn-companion-ui',
  '--set-string',
  `companionUiTest.image.digest=${companionUiDigest}`,
  '--set-string',
  'fleetAuth.companionUiCompanionId=11111111-1111-4111-8111-111111111111',
]);
const unifiedGateway = findDocumentByKindName(unifiedOriginRendered, 'Deployment', 'psfn-gateway');
for (const envName of [
  'PSFN_FLEET_AUTH',
  'FLEET_SSO_TRUST_PROXY',
  'FLEET_SSO_GARDEN_HOST',
  'FLEET_SSO_GARDEN_TLS_CA_PATH',
  'FLEET_SSO_GARDEN_TLS_CERT_PATH',
  'FLEET_SSO_GARDEN_TLS_KEY_PATH',
  'FLEET_SSO_GARDEN_TLS_EXPECTED_PEER_SPIFFE_URI',
  'FLEET_SSO_GARDEN_TLS_SERVER_NAME',
  'FLEET_SSO_COMPANION_UI_ORIGIN',
  'FLEET_SSO_COMPANION_UI_COMPANION_ID',
  'FLEET_SSO_COMPANION_UI_GUEST_MODE',
]) {
  assertIncludes(unifiedGateway, `name: ${envName}`, `unified-origin gateway ${envName}`);
}
assertNotIncludes(unifiedGateway, 'name: ADMIN_TOKEN', 'fleet-on gateway legacy admin credential');
assertNotIncludes(unifiedGateway, 'name: ADMIN_ALLOW_INSECURE', 'fleet-on gateway insecure admin mode');
assertNotIncludes(unifiedGateway, 'name: FLEET_STATUS_PORT', 'raw fleet status is not a public workload');
assertNotIncludes(unifiedGateway, 'hostPort:', 'fleet-on gateway has no direct node listener');
const unifiedIngress = findDocumentByKindName(unifiedOriginRendered, 'Ingress', 'psfn-gateway');
assertIncludes(unifiedIngress, 'path: /companion-ui/companions/', 'same-origin Companion UI Hub websocket route');
assertIncludes(unifiedIngress, 'name: hub-ws', 'same-origin Companion UI Hub websocket backend');
assertIncludes(unifiedGateway, 'secretName: psfn-gateway-sso-client-tls', 'gateway SSO client certificate');

const unifiedGatewayService = findDocumentByKindName(
  unifiedOriginRendered,
  'Service',
  'psfn-gateway',
);
assertIncludes(unifiedGatewayService, 'type: ClusterIP', 'fleet-on gateway internal Service');
assertNotIncludes(unifiedGatewayService, 'type: NodePort', 'fleet-on gateway direct NodePort');

const unifiedGarden = findDocumentByKindName(unifiedOriginRendered, 'Deployment', 'psfn-garden');
assertIncludes(unifiedGarden, 'name: https-garden', 'fleet-on Garden TLS listener');
assertIncludes(unifiedGarden, 'name: FLEET_SSO_GARDEN_TLS_EXPECTED_PEER_SPIFFE_URI', 'Garden gateway SPIFFE check');
assertIncludes(unifiedGarden, 'secretName: psfn-garden-sso-server-tls', 'Garden SSO server certificate');
assertNotIncludes(unifiedGarden, 'name: ADMIN_TOKEN', 'fleet-on Garden legacy admin credential');
assertNotIncludes(unifiedGarden, 'hostPort:', 'fleet-on Garden has no direct node listener');

for (const directIngress of ['psfn-garden', 'psfn-companion-ui-test']) {
  if (findDocumentByKindName(unifiedOriginRendered, 'Ingress', directIngress)) {
    throw new Error(`${directIngress} must not render a direct browser Ingress`);
  }
}
const unifiedIngresses = findDocumentsByKind(unifiedOriginRendered, 'Ingress');
if (unifiedIngresses.length !== 1
  || !unifiedIngresses[0].includes('\n  name: psfn-gateway\n')) {
  throw new Error('fleet-on browser topology must render the Gateway as the sole Ingress');
}
assertIncludes(unifiedIngresses[0], 'secretName: "psfn-public-origin-tls"', 'canonical origin TLS Secret');
assertIncludes(unifiedIngresses[0], 'host: "psfn-gateway.local"', 'canonical origin host');
assertIncludes(unifiedIngresses[0], 'path: "/"', 'canonical origin root path');
assertIncludes(unifiedIngresses[0], 'pathType: Prefix', 'canonical origin root path type');
assertIncludes(unifiedIngresses[0], 'name: psfn-gateway', 'canonical origin gateway backend');
assertIncludes(unifiedIngresses[0], 'name: http-api', 'canonical origin gateway API port');
assertNotIncludes(unifiedOriginRendered, 'hostPort: 3001', 'fleet-on direct Garden hostPort');
const unifiedGardenService = findDocumentByKindName(
  unifiedOriginRendered,
  'Service',
  'psfn-garden',
);
assertIncludes(unifiedGardenService, 'type: ClusterIP', 'fleet-on Garden internal Service');
assertNotIncludes(unifiedGardenService, 'type: NodePort', 'fleet-on Garden direct NodePort');
const unifiedGatewayPolicy = findDocumentByKindName(
  unifiedOriginRendered,
  'NetworkPolicy',
  'psfn-gateway',
);
assertIncludes(
  unifiedGatewayPolicy,
  'app.kubernetes.io/name: traefik',
  'fleet-on gateway admits only the configured ingress controller browser hop',
);
const unifiedGardenPolicy = findDocumentByKindName(
  unifiedOriginRendered,
  'NetworkPolicy',
  'psfn-garden',
);
assertIncludes(unifiedGardenPolicy, 'component: gateway', 'fleet-on Garden gateway-only ingress');
assertNotIncludes(unifiedGardenPolicy, 'app.kubernetes.io/name: traefik', 'Garden direct ingress controller');
const unifiedUiPolicy = findDocumentByKindName(
  unifiedOriginRendered,
  'NetworkPolicy',
  'psfn-companion-ui-test',
);
assertIncludes(unifiedUiPolicy, 'component: gateway', 'fleet-on Companion UI gateway-only ingress');
const gardenSsoCertificate = findDocumentByKindName(
  unifiedOriginRendered,
  'Certificate',
  'psfn-garden-sso-server',
);
assertIncludes(
  gardenSsoCertificate,
  'spiffe://cluster.local/psfn/garden/11111111-1111-4111-8111-111111111111',
  'Garden SSO SPIFFE SAN',
);
const gatewaySsoCertificate = findDocumentByKindName(
  unifiedOriginRendered,
  'Certificate',
  'psfn-gateway-sso-client',
);
assertIncludes(
  gatewaySsoCertificate,
  'spiffe://cluster.local/psfn/gateway/11111111-1111-4111-8111-111111111111',
  'Gateway SSO SPIFFE SAN',
);
assertRenderFails(
  [
    '--set', 'fleetAuth.enabled=true',
    '--set-string', 'runtime.companionId=companion',
  ],
  'fleetAuth.enabled=true requires runtime.companionId to be one lowercase RFC4122 UUID',
);
assertRenderFails(
  [
    '--set', 'fleetAuth.enabled=true',
    '--set-string', 'runtime.companionId=11111111-1111-4111-8111-111111111111',
  ],
  'fleetAuth.enabled=true requires ingress.gateway.tls.enabled=true',
);
assertRenderFails(
  [
    '--set', 'fleetAuth.enabled=true',
    '--set-string', 'runtime.companionId=11111111-1111-4111-8111-111111111111',
    '--set', 'ingress.gateway.tls.enabled=true',
  ],
  'fleetAuth.enabled=true requires ingress.gateway.tls.secretName',
);
assertRenderFails(
  [...fleetAuthRequiredValues, '--set', 'networkPolicy.enabled=false'],
  'fleetAuth.enabled=true requires networkPolicy.enabled=true',
);
assertRenderFails(
  [...fleetAuthRequiredValues, '--set', 'hostPorts.gatewayApi.enabled=true'],
  'fleetAuth.enabled=true forbids hostPorts.gatewayApi.enabled=true',
);
assertRenderFails(
  [...fleetAuthRequiredValues, '--set', 'hostPorts.garden.enabled=true'],
  'fleetAuth.enabled=true forbids hostPorts.garden.enabled=true',
);
assertRenderFails(
  [...fleetAuthRequiredValues, '--set-string', 'ingress.gateway.path=/fleet'],
  'fleetAuth.enabled=true requires ingress.gateway.path=/ and pathType=Prefix',
);
assertRenderFails(
  [...fleetAuthRequiredValues, '--set-string', 'ingress.gateway.pathType=Exact'],
  'fleetAuth.enabled=true requires ingress.gateway.path=/ and pathType=Prefix',
);

const prefetchRendered = render([
  '--set',
  'modelPrefetch.enabled=true',
]);

const prefetchJob = findDocument(prefetchRendered, 'psfn-model-prefetch');
assertIncludes(prefetchJob, 'kind: Job', 'model prefetch Job kind');
assertIncludes(prefetchJob, 'app.kubernetes.io/component: model-prefetch', 'model prefetch Job component label');
assertIncludes(prefetchJob, 'image: "localhost/psfn-framework:0.1.0-kube"', 'model prefetch Job image');
assertIncludes(prefetchJob, '- node', 'model prefetch Job command node');
assertIncludes(prefetchJob, '- --input-type=module', 'model prefetch Job command module mode');
assertIncludes(prefetchJob, "pipeline('text-classification', model, { dtype })", 'model prefetch text emotion command');
assertIncludes(prefetchJob, 'name: TRANSFORMERS_CACHE_DIR', 'model prefetch cache env');
assertIncludes(prefetchJob, 'value: "/app/models/transformers"', 'model prefetch cache env value');
assertIncludes(prefetchJob, 'name: PSFN_PREFETCH_TEXT_EMOTION_MODEL', 'model prefetch model env');
assertIncludes(prefetchJob, 'value: "SamLowe/roberta-base-go_emotions-onnx"', 'model prefetch model value');
assertIncludes(prefetchJob, 'mountPath: /app/models/transformers', 'model prefetch model-cache mount');
assertIncludes(prefetchJob, 'claimName: psfn-model-cache', 'model prefetch model-cache PVC');
assertIncludes(prefetchJob, 'runAsUser: 999', 'model prefetch numeric user');
assertIncludes(prefetchJob, 'runAsGroup: 999', 'model prefetch numeric group');
assertIncludes(prefetchJob, 'fsGroup: 999', 'model prefetch fsGroup');
for (const component of ['gateway', 'agent', 'garden', 'satellite-hub']) {
  assertDocumentDoesNotSelectComponent(prefetchJob, component, 'model prefetch Job labels');
}
assertServiceSelectorsDoNotSelectPrefetch(prefetchRendered, 'prefetch render');

const prefetchPolicy = findDocument(prefetchRendered, 'psfn-model-prefetch-egress');
assertIncludes(prefetchPolicy, 'kind: NetworkPolicy', 'model prefetch NetworkPolicy kind');
assertIncludes(prefetchPolicy, 'component: model-prefetch', 'model prefetch NetworkPolicy selector');
assertIncludes(prefetchPolicy, 'port: 443', 'model prefetch external HTTPS egress');

const prefetchAgentPolicy = findDocument(prefetchRendered, 'psfn-agent');
assertNotIncludes(prefetchAgentPolicy, '0.0.0.0/0', 'agent policy broad egress with prefetch enabled');
assertNotIncludes(prefetchAgentPolicy, 'component: model-prefetch', 'agent policy model prefetch label');

const prefetchHubRendered = render([
  '--set',
  'modelPrefetch.enabled=true',
  '--set',
  'satelliteHub.enabled=true',
  '--set',
  'satelliteHub.image.repository=localhost/psfn-satellite-hub',
  '--set',
  'satelliteHub.image.tag=0.1.0-kube-de65b21dfbc3',
  '--set-string',
  'satelliteHub.elevenLabsVoiceId=voice-verify',
  ...hubIdentityArgs,
]);
assertServiceSelectorsDoNotSelectPrefetch(prefetchHubRendered, 'prefetch plus satellite hub render');

// Generated-CA issuers must stay namespaced: the CA secret lives in the release
// namespace, so a chart-created ClusterIssuer could never resolve it.
const generatedCaIssuer = findDocumentByKindName(rendered, 'Issuer', 'psfn-ca');
assertIncludes(generatedCaIssuer, 'kind: Issuer', 'generated CA issuer namespaced kind');
assertIncludes(generatedCaIssuer, 'secretName: psfn-ca-tls', 'generated CA issuer secret');
const gatewayRpcCert = findDocumentByKindName(rendered, 'Certificate', 'psfn-gateway-rpc');
assertIncludes(gatewayRpcCert, 'kind: Issuer', 'gateway cert issuerRef kind');
const fleetGatewayRpcCert = findDocumentByKindName(
  fleetGardenRendered,
  'Certificate',
  'psfn-gateway-rpc',
);
assertIncludes(
  fleetGatewayRpcCert,
  'name: psfn-gateway-rpc',
  'fleet gateway RPC server certificate name',
);
assertIncludes(
  fleetGatewayRpcCert,
  'name: psfn-ca',
  'fleet gateway RPC server certificate issuer',
);
assertIncludes(
  fleetGatewayRpcCert,
  'secretName: psfn-gateway-rpc-tls',
  'fleet gateway RPC server certificate secret',
);
assertIncludes(
  fleetGatewayRpcCert,
  '- "spiffe://cluster.local/psfn/gateway/fleet"',
  'fleet gateway RPC server certificate SPIFFE URI',
);
assertIncludes(
  fleetGatewayRpcCert,
  '- "psfn-gateway-rpc.psfn-test.svc"',
  'fleet gateway RPC server certificate service DNS name',
);

const clusterIssuerRefRendered = render([
  '--set',
  'certificates.issuer.create=false',
  '--set',
  'certificates.issuer.existingIssuerRef.name=corp-ca',
  '--set',
  'certificates.issuer.existingIssuerRef.kind=ClusterIssuer',
]);
assertNotIncludes(clusterIssuerRefRendered, 'name: psfn-ca-tls', 'existingIssuerRef generated CA secret');
assertNotIncludes(clusterIssuerRefRendered, 'selfSigned: {}', 'existingIssuerRef bootstrap self-signed issuer');
const externalIssuerCert = findDocumentByKindName(clusterIssuerRefRendered, 'Certificate', 'psfn-gateway-rpc');
assertIncludes(externalIssuerCert, 'name: corp-ca', 'existingIssuerRef issuer name');
assertIncludes(externalIssuerCert, 'kind: ClusterIssuer', 'existingIssuerRef ClusterIssuer kind');

assertRenderFails(
  ['--set', 'certificates.enabled=false'],
  'certificates.enabled must be true',
);
assertRenderFails(
  ['--set', 'certificates.issuer.kind=ClusterIssuer'],
  'certificates.issuer.kind must be Issuer when certificates.issuer.create=true',
);
assertRenderFails(
  [
    '--set',
    'secrets.allowMissingRequired=false',
    '--set-string',
    'secrets.values.apiKey=',
    '--set-string',
    'secrets.values.adminToken=verify-admin-token',
    '--set-string',
    'secrets.values.gatewaySessionHmacKey=verify-hmac-key',
    '--set-string',
    'secrets.values.gatewaySessionIntegrityAuthToken=verify-worker-proof',
    '--set-string',
    'secrets.values.backupEncryptionKey=verify-backup-key',
  ],
  'secrets.values.apiKey is required when secrets.allowMissingRequired=false',
);
assertRenderFails(
  [
    '--set',
    'secrets.allowMissingRequired=false',
    '--set-string',
    'secrets.values.apiKey=verify-api-key',
    '--set-string',
    'secrets.values.adminToken=verify-admin-token',
    '--set-string',
    'secrets.values.gatewaySessionHmacKey=verify-hmac-key',
    '--set-string',
    'secrets.values.gatewaySessionIntegrityAuthToken=verify-worker-proof',
    '--set-string',
    'secrets.values.backupEncryptionKey=',
  ],
  'secrets.values.backupEncryptionKey is required when secrets.allowMissingRequired=false',
);
assertRenderFails(
  [
    '--set',
    'secrets.allowMissingRequired=false',
    '--set-string',
    'secrets.values.apiKey=verify-api-key',
    '--set-string',
    'secrets.values.adminToken=verify-admin-token',
    '--set-string',
    'secrets.values.gatewaySessionHmacKey=verify-hmac-key',
    '--set-string',
    'secrets.values.gatewaySessionIntegrityAuthToken=',
    '--set-string',
    'secrets.values.backupEncryptionKey=verify-backup-key',
  ],
  'secrets.values.gatewaySessionIntegrityAuthToken is required when secrets.allowMissingRequired=false',
);
assertRenderFails(
  ['--set', 'postgres.enabled=false'],
  'postgres.enabled=false requires postgres.external.enabled=true',
);
assertRenderFails(
  ['--set', 'redis.mode=external', '--set', 'redis.external.passwordSecret.name=external-redis-secret'],
  'redis.external.url is required when redis.mode=external',
);
assertRenderFails(
  ['--set', 'liteLlm.mode=external'],
  'liteLlm.external.baseUrl is required when liteLlm.mode=external',
);
assertRenderFails(
  ['--set', 'liteLlm.mode=sidecar'],
  'liteLlm.mode must be internal or external',
);
assertRenderFails(
  ['--set', 'liteLlm.image.tag=latest'],
  'liteLlm.image.tag must be pinned',
);
assertRenderFails(
  ['--set-string', 'liteLlm.image.digest=deadbeef'],
  'liteLlm.image.digest must start with sha256:',
);
assertRenderFails(
  [
    '--set',
    'secrets.allowMissingRequired=false',
    '--set-string',
    'secrets.values.apiKey=verify-api-key',
    '--set-string',
    'secrets.values.adminToken=verify-admin-token',
    '--set-string',
    'secrets.values.gatewaySessionHmacKey=verify-hmac-key',
    '--set-string',
    'secrets.values.backupEncryptionKey=verify-backup-key',
    '--set-string',
    'secrets.values.liteLlmApiKey=',
  ],
  'secrets.values.liteLlmApiKey is required for liteLlm.enabled=true',
);
assertRenderFails(
  ['--set', 'satelliteHub.enabled=true'],
  'satelliteHub.image.repository is required when satelliteHub.enabled=true',
);
assertRenderFails(
  ['--set', 'modelPrefetch.enabled=true', '--set', 'persistence.modelCache.enabled=false'],
  'modelPrefetch.enabled=true requires persistence.modelCache.enabled=true',
);
assertRenderFails(
  [
    '--set',
    'satelliteHub.enabled=true',
    '--set',
    'satelliteHub.image.repository=localhost/psfn-satellite-hub',
    '--set-string',
    'satelliteHub.elevenLabsVoiceId=voice-verify',
  ],
  'satelliteHub.image.tag or satelliteHub.image.digest is required when satelliteHub.enabled=true',
);
assertRenderFails(
  [
    '--set',
    'satelliteHub.enabled=true',
    '--set',
    'satelliteHub.image.repository=localhost/psfn-satellite-hub',
    '--set',
    'satelliteHub.image.tag=latest',
    '--set-string',
    'satelliteHub.elevenLabsVoiceId=voice-verify',
  ],
  'satelliteHub.image.tag must be pinned',
);
assertRenderFails(
  [
    '--set',
    'satelliteHub.enabled=true',
    '--set',
    'satelliteHub.image.repository=localhost/psfn-satellite-hub',
    '--set-string',
    'satelliteHub.image.digest=deadbeef',
    '--set-string',
    'satelliteHub.elevenLabsVoiceId=voice-verify',
  ],
  'satelliteHub.image.digest must start with sha256:',
);
assertRenderFails(
  [
    '--set',
    'satelliteHub.enabled=true',
    '--set',
    'satelliteHub.image.repository=localhost/psfn-satellite-hub',
    '--set',
    'satelliteHub.image.tag=0.1.0-kube-de65b21dfbc3',
    ...hubIdentityArgs,
  ],
  'satelliteHub.elevenLabsVoiceId is required when satelliteHub.enabled=true and satelliteHub.textOnly=false',
);
assertRenderFails(
  [
    '--set',
    'satelliteHub.enabled=true',
    '--set',
    'satelliteHub.agentRuntime=hermes',
    '--set',
    'satelliteHub.image.repository=localhost/psfn-satellite-hub',
    '--set',
    'satelliteHub.image.tag=0.1.0-kube-de65b21dfbc3',
    '--set-string',
    'satelliteHub.elevenLabsVoiceId=voice-verify',
    ...hubIdentityArgs,
  ],
  'satelliteHub.agentRuntime must be psfn',
);
assertRenderFails(
  [
    '--set',
    'satelliteHub.enabled=true',
    '--set',
    'satelliteHub.image.repository=localhost/psfn-satellite-hub',
    '--set',
    'satelliteHub.image.tag=0.1.0-kube-de65b21dfbc3',
    '--set-string',
    'satelliteHub.elevenLabsVoiceId=voice-verify',
    ...hubIdentityArgs,
    '--set',
    'secrets.allowMissingRequired=false',
    '--set-string',
    'secrets.values.apiKey=verify-api-key',
    '--set-string',
    'secrets.values.adminToken=verify-admin-token',
    '--set-string',
    'secrets.values.gatewaySessionHmacKey=verify-hmac-key',
  ],
  'secrets.values.deepgramApiKey is required for satelliteHub.enabled=true',
);

assertRenderFails(
  [...companionUiAuthorityArgs, '--set', 'companionUiTest.enabled=true'],
  'companionUiTest.image.repository is required when companionUiTest.enabled=true',
);
assertRenderFails(
  [
    ...companionUiAuthorityArgs,
    '--set',
    'companionUiTest.enabled=true',
    '--set',
    'companionUiTest.image.repository=localhost/psfn-companion-ui',
  ],
  'companionUiTest.image.tag or companionUiTest.image.digest is required when companionUiTest.enabled=true',
);
assertRenderFails(
  [
    ...companionUiAuthorityArgs,
    '--set',
    'companionUiTest.enabled=true',
    '--set',
    'companionUiTest.image.repository=localhost/psfn-companion-ui',
    '--set',
    'companionUiTest.image.tag=latest',
  ],
  'companionUiTest.image.tag must be pinned',
);
assertRenderFails(
  [
    ...companionUiAuthorityArgs,
    '--set',
    'companionUiTest.enabled=true',
    '--set',
    'companionUiTest.image.repository=localhost/psfn-companion-ui',
    '--set-string',
    'companionUiTest.image.digest=deadbeef',
  ],
  'companionUiTest.image.digest must start with sha256:',
);

assertRenderFails([
  '--set',
  'companionUiTest.enabled=true',
  '--set',
  'companionUiTest.image.repository=localhost/psfn-companion-ui',
  '--set-string',
  `companionUiTest.image.digest=${companionUiDigest}`,
], 'companionUiTest.enabled=true requires fleetAuth.enabled=true for the canonical login/session origin');

assertRenderFails([
  '--set',
  'fleetAuth.enabled=true',
  '--set-string',
  'runtime.companionId=11111111-1111-4111-8111-111111111111',
  '--set',
  'ingress.gateway.tls.enabled=true',
  '--set-string',
  'ingress.gateway.tls.secretName=psfn-public-origin-tls',
  '--set',
  'companionUiTest.enabled=true',
  '--set',
  'companionUiTest.image.repository=localhost/psfn-companion-ui',
  '--set-string',
  `companionUiTest.image.digest=${companionUiDigest}`,
], 'companionUiTest.enabled=true requires satelliteHub.enabled=true for server-owned device authority');

assertRenderFails([
  ...companionUiAuthorityArgs,
  '--set',
  'companionUiTest.enabled=true',
  '--set',
  'companionUiTest.image.repository=localhost/psfn-companion-ui',
  '--set-string',
  `companionUiTest.image.digest=${companionUiDigest}`,
  '--set',
  'companionUiTest.guestMode=implicit',
], 'companionUiTest.guestMode must be disabled or explicit');

console.log('Helm chart verification passed.');
