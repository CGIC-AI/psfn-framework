import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const STATE_FILE_NAME = '.bootstrap-state.json';
const STATE_SCHEMA_VERSION = 1;
const ALLOWED_FRESH_ROOT_ENTRIES = new Set(['shakedown.env']);

const GLOBAL_OWNER_SEEDS = [
  'settings',
  'models',
  'providers',
  'trust-policy',
  'backup',
  'intake-policy',
  'places',
];

const COMPANION_OWNER_SEEDS = [
  'scheduler',
  'capability-tier',
  'charge-policy',
  'skills',
];

function statePath(config) {
  return join(config.roundRoot, STATE_FILE_NAME);
}

function expectedStateIdentity(config) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    ...(config.rcRevision ? { rcRevision: config.rcRevision } : {}),
    repoRoot: config.repoRoot,
    roundRoot: config.roundRoot,
    systemDataDir: config.systemDataDir,
    companionDataDir: config.companionDataDir,
    companionId: config.companionId,
    postgresIdentity: config.postgresIdentity,
  };
}

function parseState(config) {
  const path = statePath(config);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot resume: ${path} is missing or invalid (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const expected = expectedStateIdentity(config);
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(parsed?.[key]) !== JSON.stringify(value)) {
      throw new Error(
        `Cannot resume: bootstrap state ${key} is ${JSON.stringify(parsed?.[key])}, `
        + `expected ${JSON.stringify(value)}. Use a new round root.`,
      );
    }
  }
  if (!Array.isArray(parsed.completedStages) || !parsed.completedStages.every(value => typeof value === 'string')) {
    throw new Error('Cannot resume: bootstrap state completedStages must be a string array');
  }
  return parsed;
}

function writeState(config, state) {
  const path = statePath(config);
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function inspectRound(config) {
  if (!existsSync(config.roundRoot)) {
    return { mode: 'fresh', entries: [] };
  }
  const entries = readdirSync(config.roundRoot)
    .filter(entry => !ALLOWED_FRESH_ROOT_ENTRIES.has(entry));
  if (entries.length === 0) {
    return { mode: 'fresh', entries };
  }
  if (!entries.includes(STATE_FILE_NAME)) {
    throw new Error(
      `SHAKEDOWN_ROOT is dirty (${entries.join(', ')}) and has no trusted ${STATE_FILE_NAME}; `
      + 'refusing silent reuse. Use a new round root.',
    );
  }
  if (!config.resume) {
    throw new Error(
      `SHAKEDOWN_ROOT already contains bootstrap state. Refusing silent reuse; `
      + 'set PSFN_SHAKEDOWN_RESUME=1 to resume it explicitly.',
    );
  }
  return { mode: 'resume', entries };
}

function createLayout(config) {
  for (const path of [
    config.roundRoot,
    config.workspacePath,
    config.dataDir,
    config.systemDataDir,
    config.companionDataDir,
    config.logsDir,
    config.tempDir,
    config.backupRootDir,
  ]) {
    mkdirSync(path, { recursive: true });
  }
}

function seedOwnerFiles(config) {
  const seedDir = join(config.repoRoot, 'config');
  for (const owner of GLOBAL_OWNER_SEEDS) {
    const target = join(config.systemDataDir, `${owner}.json`);
    if (!existsSync(target)) {
      copyFileSync(join(seedDir, `${owner}.seed.json`), target);
    }
  }
  for (const owner of COMPANION_OWNER_SEEDS) {
    const target = join(config.companionDataDir, `${owner}.json`);
    if (!existsSync(target)) {
      copyFileSync(join(seedDir, `${owner}.seed.json`), target);
    }
  }
}

async function runCommand(services, config, command, args) {
  await services.runCommand(command, args, { cwd: config.repoRoot });
}

async function runStage({ config, services, state, stage, action }) {
  if (state.completedStages.includes(stage)) {
    services.log(`bootstrap_stage=${stage} status=resume-skip`);
    return;
  }
  services.log(`bootstrap_stage=${stage} status=running`);
  await action();
  state.completedStages.push(stage);
  writeState(config, state);
  services.log(`bootstrap_stage=${stage} status=complete`);
}

/**
 * Execute a fresh or explicitly resumed local bootstrap.
 *
 * `services` is the public process/network adapter. Tests substitute it at this
 * seam; production uses the real command, readiness, chat, and turn-record
 * implementation from bootstrap-local.mjs.
 */
export async function runBootstrap(config, services) {
  const round = inspectRound(config);
  let state;
  if (round.mode === 'resume') {
    state = parseState(config);
    services.log(`bootstrap_mode=resume root=${config.roundRoot}`);
  } else {
    createLayout(config);
    state = {
      ...expectedStateIdentity(config),
      completedStages: ['layout'],
    };
    writeState(config, state);
    services.log(`bootstrap_mode=fresh root=${config.roundRoot}`);
  }

  await runStage({
    config,
    services,
    state,
    stage: 'install_dependencies',
    action: () => runCommand(services, config, 'npm', ['ci']),
  });
  await runStage({
    config,
    services,
    state,
    stage: 'build_runtime',
    action: () => runCommand(services, config, 'npm', ['run', 'build']),
  });
  await runStage({
    config,
    services,
    state,
    stage: 'build_garden',
    action: () => runCommand(services, config, 'npm', ['run', 'garden:build']),
  });
  await runStage({
    config,
    services,
    state,
    stage: 'seed_owner_files',
    action: async () => seedOwnerFiles(config),
  });
  await runStage({
    config,
    services,
    state,
    stage: 'verify_owner_contracts',
    action: async () => {
      await runCommand(services, config, 'npm', ['run', 'verify:startup-owner-files']);
      await runCommand(services, config, 'npm', ['run', 'verify:settings-contract']);
      await runCommand(services, config, 'npm', ['run', 'preflight:startup-owner-files']);
    },
  });
  await runStage({
    config,
    services,
    state,
    stage: 'import_character',
    action: () => runCommand(
      services,
      config,
      'npm',
      ['run', 'import-character', '--', config.characterCardSource],
    ),
  });

  // Live stages always rerun during an explicit resume. A state marker cannot
  // prove that yesterday's processes are still the selected runtime.
  await runCommand(
    services,
    config,
    'bash',
    [join(config.repoRoot, 'shakedown', 'harness', 'restart-split-runtime.sh')],
  );
  await services.waitForReadiness({ config });

  const proofToken = randomUUID();
  const proof = await services.proveFirstConversation({
    config,
    message: `PSFN fresh-bootstrap proof ${proofToken}`,
    sessionId: `bootstrap-${proofToken}`,
    turnRecordsDir: join(
      config.companionDataDir,
      'state',
      'sessions',
      '_turn_records',
    ),
  });
  state.lastProof = {
    message: proof.message,
    sessionId: proof.sessionId,
    turnRecordPath: proof.turnRecordPath,
    provenAt: new Date().toISOString(),
  };
  writeState(config, state);

  services.log('bootstrap_status=first-conversation-proven');
  services.log(`turn_record=${proof.turnRecordPath}`);
  return proof;
}
