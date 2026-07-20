#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chartDir = join(repoRoot, 'deploy', 'helm', 'psfn');
const configDir = join(repoRoot, 'config');
const firstCompanionId = '11111111-1111-4111-8111-111111111111';
const secondCompanionId = '22222222-2222-4222-8222-222222222222';
const exactImageTag = '0.1.0-kube-dut9-4-fixture';
const exactImageDigest = `sha256:${'d'.repeat(64)}`;
const exactImage = `registry.example.test/psfn-framework:${exactImageTag}@${exactImageDigest}`;

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) throw new Error(`${label} missing: ${needle}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeJsonAtomicFixture(path, value) {
  const temporaryPath = `${path}.replacement`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, path);
}

function fleetManifest(companions) {
  return {
    companions: companions.map(({ companionId, name, postgresSchema }) => ({
      companionId,
      companionDataDir: `companions/${name}`,
      characterCardPath: `companions/${name}/companion.json`,
      postgresSchema,
    })),
  };
}

function migrationEnvironment(input) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    PSFN_RUNTIME_LAYOUT_MODE: 'production',
    PSFN_RUNTIME_ROOT: input.runtimeRoot,
    SYSTEM_DATA_DIR: input.systemDataDir,
    COMPANION_DATA_DIR: input.companionDataDir,
    WORKSPACE_PATH: join(input.runtimeRoot, 'workspace'),
    PSFN_LOGS_DIR: join(input.runtimeRoot, 'logs'),
    PSFN_TEMP_DIR: join(input.runtimeRoot, 'tmp'),
    BACKUP_ROOT_DIR: join(input.runtimeRoot, 'backups'),
    CONFIG_DIR: configDir,
    // Topology is derived from companions.json presence by the migrator, not the
    // retired PSFN_MULTI_COMPANION flag; the fixtures always write companions.json.
    PSFN_FLEET_AUTH: 'false',
    DATA_DIR: '',
  };
}

function runNpm(script, args, env, expectedStatus = 0) {
  const result = spawnSync('npm', ['run', script, ...(args.length > 0 ? ['--', ...args] : [])], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  if (result.status !== expectedStatus) {
    throw new Error(
      `${script} exit ${result.status}, expected ${expectedStatus}: ${result.stderr}${result.stdout}`,
    );
  }
  return `${result.stderr}${result.stdout}`;
}

function renderHelmStartup(input) {
  const args = [
    'template',
    'psfn',
    chartDir,
    '--namespace',
    'psfn-test',
    '--set-string', `runtime.systemDataDir=${input.systemDataDir}`,
    '--set-string', `runtime.companionDataDir=${input.companionDataDir}`,
    '--set-string', `runtime.companionId=${input.companionId}`,
    '--set-string', `runtime.characterCardPath=${join(input.companionDataDir, 'companion.json')}`,
    '--set-string', `runtime.workspacePath=${join(input.runtimeRoot, 'workspace')}`,
    '--set-string', `runtime.logsDir=${join(input.runtimeRoot, 'logs')}`,
    '--set-string', `runtime.tempDir=${join(input.runtimeRoot, 'tmp')}`,
    '--set-string', `runtime.backupsDir=${join(input.runtimeRoot, 'backups')}`,
    '--set-string', `runtime.modelCacheDir=${join(input.runtimeRoot, 'models')}`,
    '--set-string', `runtime.configDir=${configDir}`,
    '--set-string', 'psfnAppImage.repository=registry.example.test/psfn-framework',
    '--set-string', `psfnAppImage.tag=${exactImageTag}`,
    '--set-string', `psfnAppImage.digest=${exactImageDigest}`,
    '--set', 'bootstrap.seedOwnerFiles=false',
  ];
  const rendered = spawnSync('helm', args, { cwd: repoRoot, encoding: 'utf8' });
  if (rendered.status !== 0) {
    throw new Error(`helm template failed: ${rendered.stderr}${rendered.stdout}`);
  }
  if (rendered.stdout.includes('/app/config/*.seed.json')) {
    throw new Error(`${input.label} rendered owner seeding during an upgrade`);
  }

  const commands = [];
  for (const component of ['agent', 'gateway', 'garden']) {
    const deployment = parseAllDocuments(rendered.stdout)
      .map(document => document.toJS())
      .find(document => (
        document?.kind === 'Deployment'
        && document?.metadata?.name === `psfn-${component}`
      ));
    if (!deployment) throw new Error(`${input.label} ${component} Deployment is missing`);
    const seed = deployment.spec.template.spec.initContainers
      ?.find(container => container.name === 'seed-runtime-files');
    if (seed?.image !== exactImage) {
      throw new Error(`${input.label} ${component} init did not use ${exactImage}`);
    }
    if (!deployment.spec.template.spec.containers?.some(container => container.image === exactImage)) {
      throw new Error(`${input.label} ${component} workload did not use ${exactImage}`);
    }
    if (!Array.isArray(seed.command) || seed.command[0] !== 'sh' || seed.command[1] !== '-c') {
      throw new Error(`${input.label} ${component} init command is not rendered sh -c`);
    }
    commands.push(seed.command[2]);
  }
  if (commands.some(command => command !== commands[0])) {
    throw new Error(`${input.label} app workloads rendered different owner init commands`);
  }
  return commands[0];
}

function assertMalformedSourceRefused(ownerFile, contents, expectedError) {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'psfn-helm-malformed-owner-'));
  try {
    const systemDataDir = join(runtimeRoot, 'system-data');
    const companionDataDir = join(runtimeRoot, 'companions', 'one');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    writeFileSync(
      join(systemDataDir, 'companions.json'),
      `${JSON.stringify(fleetManifest([{
        companionId: firstCompanionId,
        name: 'one',
        postgresSchema: 'one',
      }]), null, 2)}\n`,
      'utf8',
    );
    writeFileSync(join(systemDataDir, ownerFile), contents, 'utf8');
    const output = runNpm(
      'migrate:system-owner-fleet',
      ['--apply', '--approve', `${ownerFile}=${sha256(contents)}`],
      migrationEnvironment({ runtimeRoot, systemDataDir, companionDataDir }),
      1,
    );
    assertIncludes(output, expectedError, `${ownerFile} malformed source refusal`);
    if (
      readFileSync(join(systemDataDir, ownerFile), 'utf8') !== contents
      || existsSync(join(systemDataDir, 'migrations', 'system-owner-fleet-reroot.json'))
      || existsSync(join(companionDataDir, ownerFile))
    ) {
      throw new Error(`${ownerFile} malformed source refusal changed migration state`);
    }
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

const runtimeRoot = mkdtempSync(join(tmpdir(), 'psfn-helm-charge-skills-upgrade-'));
try {
  const systemDataDir = join(runtimeRoot, 'system-data');
  const firstCompanionDataDir = join(runtimeRoot, 'companions', 'one');
  const secondCompanionDataDir = join(runtimeRoot, 'companions', 'two');
  const manifest = fleetManifest([
    { companionId: firstCompanionId, name: 'one', postgresSchema: 'one' },
    { companionId: secondCompanionId, name: 'two', postgresSchema: 'two' },
  ]);
  mkdirSync(systemDataDir, { recursive: true });
  for (const companionDataDir of [firstCompanionDataDir, secondCompanionDataDir]) {
    mkdirSync(companionDataDir, { recursive: true });
  }
  writeFileSync(
    join(systemDataDir, 'companions.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  for (const ownerFile of [
    'settings',
    'models',
    'providers',
    'trust-policy',
    'backup',
    'intake-policy',
  ]) {
    writeFileSync(
      join(systemDataDir, `${ownerFile}.json`),
      readFileSync(join(configDir, `${ownerFile}.seed.json`)),
    );
  }
  const schedulerSeed = readFileSync(join(configDir, 'scheduler.seed.json'), 'utf8');
  const capabilitySeed = readFileSync(join(configDir, 'capability-tier.seed.json'), 'utf8');
  for (const companionDataDir of [firstCompanionDataDir, secondCompanionDataDir]) {
    writeFileSync(join(companionDataDir, 'scheduler.json'), schedulerSeed, 'utf8');
    writeFileSync(join(companionDataDir, 'capability-tier.json'), capabilitySeed, 'utf8');
  }

  const legacyOwners = new Map([
    [
      'charge-policy.json',
      readFileSync(join(configDir, 'charge-policy.seed.json'), 'utf8')
        .replace('"interactive": 24', '"interactive": 27'),
    ],
    [
      'skills.json',
      readFileSync(join(configDir, 'skills.seed.json'), 'utf8')
        .replace('"maxLoadedSkills": 32', '"maxLoadedSkills": 36'),
    ],
  ]);
  for (const [ownerFile, contents] of legacyOwners) {
    writeFileSync(join(systemDataDir, ownerFile), contents, 'utf8');
  }
  const env = migrationEnvironment({
    runtimeRoot,
    systemDataDir,
    companionDataDir: firstCompanionDataDir,
  });
  const approvals = Array.from(legacyOwners, ([ownerFile, contents]) => (
    `${ownerFile}=${sha256(contents)}`
  ));
  const snapshotDir = join(runtimeRoot, 'backups', 'pre-owner-migration');
  assertIncludes(
    runNpm('snapshot:system-owner-fleet', ['--output', snapshotDir], env),
    '"status": "captured"',
    'whole-fleet pre-migration snapshot',
  );
  const dryRun = runNpm('migrate:system-owner-fleet', [], env);
  for (const [ownerFile] of legacyOwners) {
    assertIncludes(dryRun, `--approve ${ownerFile}=`, `${ownerFile} exact approval`);
    assertIncludes(dryRun, join(firstCompanionDataDir, ownerFile), `${ownerFile} first root`);
    assertIncludes(dryRun, join(secondCompanionDataDir, ownerFile), `${ownerFile} second root`);
  }
  const applyArgs = ['--apply', ...approvals.flatMap(value => ['--approve', value])];
  assertIncludes(
    runNpm('migrate:system-owner-fleet', applyArgs, env),
    '"status": "migrated"',
    'fleet charge/skills apply',
  );

  const receipt = JSON.parse(readFileSync(
    join(systemDataDir, 'migrations', 'system-owner-fleet-reroot.json'),
    'utf8',
  ));
  if (receipt.status !== 'completed' || receipt.files.length !== legacyOwners.size) {
    throw new Error('charge/skills migration receipt is not complete');
  }
  for (const file of receipt.files) {
    const expected = legacyOwners.get(file.ownerFile);
    if (!expected || file.sourceSha256 !== sha256(expected)) {
      throw new Error(`${file.ownerFile} receipt source provenance is wrong`);
    }
    if (
      existsSync(join(systemDataDir, file.ownerFile))
      || readFileSync(file.quarantinePath, 'utf8') !== expected
    ) {
      throw new Error(`${file.ownerFile} was not exactly retired into receipt quarantine`);
    }
    for (const companionDataDir of [firstCompanionDataDir, secondCompanionDataDir]) {
      if (readFileSync(join(companionDataDir, file.ownerFile), 'utf8') !== expected) {
        throw new Error(`${file.ownerFile} bytes differ at ${companionDataDir}`);
      }
    }
  }
  assertIncludes(
    runNpm('migrate:system-owner-fleet', applyArgs, env),
    '"status": "already_completed"',
    'identical fleet migration rerun',
  );

  for (const [companionDataDir, interactive, maxSkills] of [
    [firstCompanionDataDir, 31, 41],
    [secondCompanionDataDir, 32, 42],
  ]) {
    const chargePolicyPath = join(companionDataDir, 'charge-policy.json');
    const chargePolicy = JSON.parse(readFileSync(chargePolicyPath, 'utf8'));
    chargePolicy.runChargeQuotaByLane.interactive = interactive;
    writeJsonAtomicFixture(chargePolicyPath, chargePolicy);
    const skillsPath = join(companionDataDir, 'skills.json');
    const skills = JSON.parse(readFileSync(skillsPath, 'utf8'));
    skills.maxLoadedSkills = maxSkills;
    writeJsonAtomicFixture(skillsPath, skills);
  }
  assertIncludes(
    runNpm('migrate:system-owner-fleet', applyArgs, env),
    '"status": "already_completed"',
    'safe atomic owner evolution rerun',
  );

  for (const [label, companionId, companionDataDir] of [
    ['first companion', firstCompanionId, firstCompanionDataDir],
    ['second companion', secondCompanionId, secondCompanionDataDir],
  ]) {
    const renderedStartup = renderHelmStartup({
      label,
      runtimeRoot,
      systemDataDir,
      companionDataDir,
      companionId,
    });
    assertIncludes(
      renderedStartup,
      'node /app/dist/migrate-scheduler-owner.js',
      `${label} exact-image startup command`,
    );
    assertIncludes(
      renderedStartup,
      'node /app/dist/migrate-required-settings-blocks.js',
      `${label} required settings migration command`,
    );
  }
  for (const [companionDataDir, interactive, maxSkills] of [
    [firstCompanionDataDir, 31, 41],
    [secondCompanionDataDir, 32, 42],
  ]) {
    if (
      JSON.parse(readFileSync(join(companionDataDir, 'charge-policy.json'), 'utf8'))
        .runChargeQuotaByLane.interactive !== interactive
      || JSON.parse(readFileSync(join(companionDataDir, 'skills.json'), 'utf8'))
        .maxLoadedSkills !== maxSkills
    ) {
      throw new Error(`${companionDataDir} distinct owners changed during Helm startup`);
    }
  }
  const preflight = runNpm('preflight:startup-owner-files', [], {
    ...env,
    COMPANION_ID: firstCompanionId,
    COMPANION_DATA_DIR: firstCompanionDataDir,
    CHARACTER_CARD_PATH: join(firstCompanionDataDir, 'companion.json'),
    COMPANION_PG_SCHEMA: 'one',
    POSTGRES_DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:5432/fixture',
  });
  assertIncludes(
    preflight,
    `fleet=2 companionRoots=${firstCompanionDataDir},${secondCompanionDataDir}`,
    'exact multi-companion startup preflight',
  );

  const restoreRoot = join(runtimeRoot, 'fresh-restore');
  mkdirSync(join(restoreRoot, 'system-data'), { recursive: true });
  mkdirSync(join(restoreRoot, 'companions', 'one'), { recursive: true });
  mkdirSync(join(restoreRoot, 'companions', 'two'), { recursive: true });
  assertIncludes(
    runNpm('restore:system-owner-fleet-snapshot', [
      '--manifest', join(snapshotDir, 'system-owner-fleet-snapshot.json'),
      '--restore-runtime-root', restoreRoot,
    ], env),
    '"status": "restored"',
    'whole-fleet rollback rehearsal',
  );
  for (const [ownerFile, contents] of legacyOwners) {
    if (readFileSync(join(restoreRoot, 'system-data', ownerFile), 'utf8') !== contents) {
      throw new Error(`${ownerFile} was not restored to the old system owner root`);
    }
    for (const companionName of ['one', 'two']) {
      if (existsSync(join(restoreRoot, 'companions', companionName, ownerFile))) {
        throw new Error(`${ownerFile} fan-out survived whole-fleet rollback`);
      }
    }
  }
  if (existsSync(join(restoreRoot, 'system-data', 'migrations'))) {
    throw new Error('Migration receipt survived whole-fleet rollback');
  }
} finally {
  rmSync(runtimeRoot, { recursive: true, force: true });
}

assertMalformedSourceRefused(
  'skills.json',
  '{"enabled":"not-a-boolean"}\n',
  'Invalid skills config',
);
assertMalformedSourceRefused(
  'charge-policy.json',
  '{"schemaVersion":0}\n',
  'Invalid charge policy',
);

for (const [label, guide] of [
  ['operations guide', readFileSync(join(repoRoot, 'docs', 'operations.md'), 'utf8')],
  ['setup guide', readFileSync(join(repoRoot, 'docs', 'setup.md'), 'utf8')],
  ['Helm guide', readFileSync(join(chartDir, 'README.md'), 'utf8')],
]) {
  const normalizedGuide = guide.replace(/\s+/gu, ' ');
  assertIncludes(normalizedGuide, 'npm run migrate:system-owner-fleet', `${label} fleet command`);
  assertIncludes(normalizedGuide, 'bootstrap.seedOwnerFiles=false', `${label} seed posture`);
  assertIncludes(normalizedGuide, 'npm run snapshot:system-owner-fleet', `${label} snapshot command`);
  assertIncludes(normalizedGuide, 'npm run restore:system-owner-fleet-snapshot', `${label} restore command`);
}

console.log('Helm charge/skills owner upgrade verification passed.');
