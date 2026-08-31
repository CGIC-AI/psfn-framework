#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBootstrapConfig } from '../lib/bootstrap-config.mjs';
import { runBootstrap } from '../lib/bootstrap-runner.mjs';

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

function makeEnv(fixtureRoot, repoRoot, roundRoot) {
  return {
    PSFN_REPO_ROOT: repoRoot,
    CONFIG_DIR: join(repoRoot, 'config'),
    SHAKEDOWN_ROOT: roundRoot,
    PSFN_SHAKEDOWN_ROOT: roundRoot,
    PSFN_RUNTIME_ROOT: roundRoot,
    PSFN_RUNTIME_MODE: 'split',
    PSFN_RUNTIME_LAYOUT_MODE: 'production',
    WORKSPACE_PATH: join(roundRoot, 'workspace'),
    DATA_DIR: join(roundRoot, 'legacy-empty'),
    SYSTEM_DATA_DIR: join(roundRoot, 'system-data'),
    COMPANION_DATA_DIR: join(roundRoot, 'companion-data'),
    CHARACTER_CARD_PATH: join(roundRoot, 'companion-data', 'companion.json'),
    PSFN_LOGS_DIR: join(roundRoot, 'logs'),
    PSFN_TEMP_DIR: join(roundRoot, 'tmp'),
    BACKUP_ROOT_DIR: join(roundRoot, 'backups'),
    POSTGRES_DATABASE_URL: 'postgresql://round:test@127.0.0.1:5432/psfn_shakedown_round',
    PSFN_LIVE_POSTGRES_DATABASE_URL: 'postgresql://live:test@127.0.0.1:5432/psfn_live',
    PSFN_SHAKEDOWN_POSTGRES_DATABASE: 'psfn_shakedown_round',
    COMPANION_PG_SCHEMA: 'shakedown_artemis',
    PSFN_SHAKEDOWN_EXTERNAL_CHANNELS: 'false',
    PSFN_API_BASE: 'http://127.0.0.1:10153',
    PSFN_ADMIN_BASE: 'http://127.0.0.1:10154',
    API_HOST: '127.0.0.1',
    API_PORT: '10153',
    ADMIN_HOST: '127.0.0.1',
    ADMIN_PORT: '10154',
    API_CORS_ALLOWLIST: 'http://127.0.0.1:10154',
    API_KEY: 'test-api-key',
    TESTING_HARNESS_API_KEY: 'dedicated-testing-harness-key',
    ADMIN_TOKEN: 'test-admin-token',
    GATEWAY_SESSION_HMAC_KEY: 'test-hmac-key-that-is-long-enough',
    COMPANION_ID: 'a7100000-0000-4000-8000-000000000001',
    PSFN_LIVE_DATA_ROOTS: join(fixtureRoot, 'live'),
  };
}

const fixtureRoot = mkdtempSync(join(tmpdir(), 'psfn-bootstrap-runner-'));

try {
  const repoRoot = join(fixtureRoot, 'repo');
  const roundRoot = join(fixtureRoot, 'round');
  mkdirSync(join(repoRoot, 'config'), { recursive: true });
  mkdirSync(join(repoRoot, 'shakedown', 'artie'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'live'), { recursive: true });
  mkdirSync(roundRoot, { recursive: true });
  writeFileSync(join(roundRoot, 'shakedown.env'), '# already sourced\n');
  writeFileSync(join(repoRoot, 'package.json'), '{}\n');
  writeFileSync(join(repoRoot, 'shakedown', 'artie', 'ARTIE.png'), 'card');
  for (const owner of [...GLOBAL_OWNER_SEEDS, ...COMPANION_OWNER_SEEDS]) {
    const seed = owner === 'charge-policy'
      ? { schemaVersion: 1, runChargeQuotaByLane: { interactive: 24 } }
      : { owner };
    writeFileSync(
      join(repoRoot, 'config', `${owner}.seed.json`),
      `${JSON.stringify(seed, null, 2)}\n`,
    );
  }

  const env = makeEnv(fixtureRoot, repoRoot, roundRoot);
  const commands = [];
  const readiness = [];
  const proofs = [];
  const logs = [];
  const services = {
    async runCommand(command, args) {
      commands.push([command, ...args]);
    },
    async waitForReadiness(input) {
      readiness.push(input);
    },
    async proveFirstConversation(input) {
      proofs.push(input);
      return {
        message: input.message,
        sessionId: input.sessionId,
        turnRecordPath: join(input.turnRecordsDir, 'exact-bootstrap-record.jsonl'),
      };
    },
    log(line) {
      logs.push(line);
    },
  };

  const config = {
    ...resolveBootstrapConfig(env),
    rcRevision: '1111111111111111111111111111111111111111',
  };
  const result = await runBootstrap(config, services);

  // Shakedown charge headroom (0frcd): the seeded interactive quota is raised
  // on the round's own companion-data copy, never on the repo seed.
  assert.equal(
    JSON.parse(readFileSync(join(config.companionDataDir, 'charge-policy.json'), 'utf8'))
      .runChargeQuotaByLane.interactive >= 120,
    true,
  );
  assert.equal(
    JSON.parse(readFileSync(join(repoRoot, 'config', 'charge-policy.seed.json'), 'utf8'))
      .runChargeQuotaByLane.interactive,
    24,
  );

  assert.deepEqual(commands, [
    ['npm', 'ci'],
    ['npm', 'run', 'build'],
    ['npm', 'run', 'garden:build'],
    ['npm', 'run', 'verify:startup-owner-files'],
    ['npm', 'run', 'verify:settings-contract'],
    ['npm', 'run', 'preflight:startup-owner-files'],
    ['npm', 'run', 'import-character', '--', join(repoRoot, 'shakedown', 'artie', 'ARTIE.png')],
    ['bash', join(repoRoot, 'shakedown', 'harness', 'restart-split-runtime.sh')],
  ]);
  assert.equal(readiness.length, 1);
  assert.equal(proofs.length, 1);
  assert.match(proofs[0].message, /^PSFN fresh-bootstrap proof /u);
  assert.match(proofs[0].sessionId, /^bootstrap-/u);
  assert.equal(
    proofs[0].turnRecordsDir,
    join(roundRoot, 'companion-data', 'state', 'sessions', '_turn_records'),
  );
  assert.equal(result.turnRecordPath, join(
    roundRoot,
    'companion-data',
    'state',
    'sessions',
    '_turn_records',
    'exact-bootstrap-record.jsonl',
  ));
  assert.ok(logs.some(line => line.includes(`turn_record=${result.turnRecordPath}`)));

  for (const owner of GLOBAL_OWNER_SEEDS) {
    const path = join(roundRoot, 'system-data', `${owner}.json`);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).owner, owner);
  }
  for (const owner of COMPANION_OWNER_SEEDS) {
    const path = join(roundRoot, 'companion-data', `${owner}.json`);
    if (owner === 'charge-policy') {
      assert.equal(
        JSON.parse(readFileSync(path, 'utf8')).runChargeQuotaByLane.interactive >= 120,
        true,
      );
    } else {
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).owner, owner);
    }
  }
  assert.equal(existsSync(join(roundRoot, '.bootstrap-state.json')), true);

  const callsBeforeDirtyRun = commands.length;
  await assert.rejects(
    () => runBootstrap(config, services),
    /already contains bootstrap state.*PSFN_SHAKEDOWN_RESUME=1/u,
  );
  assert.equal(commands.length, callsBeforeDirtyRun, 'dirty refusal must launch no command');

  await assert.rejects(
    () => runBootstrap(
      {
        ...resolveBootstrapConfig({ ...env, PSFN_SHAKEDOWN_RESUME: '1' }),
        rcRevision: '2222222222222222222222222222222222222222',
      },
      services,
    ),
    /bootstrap state rcRevision.*expected/u,
  );
  assert.equal(commands.length, callsBeforeDirtyRun, 'revision mismatch must launch no command');

  await assert.rejects(
    () => runBootstrap(
      {
        ...resolveBootstrapConfig({
          ...env,
          PSFN_SHAKEDOWN_RESUME: '1',
          POSTGRES_DATABASE_URL: 'postgresql://round:test@127.0.0.1:5432/psfn_shakedown_other',
          PSFN_SHAKEDOWN_POSTGRES_DATABASE: 'psfn_shakedown_other',
        }),
        rcRevision: config.rcRevision,
      },
      services,
    ),
    /bootstrap state postgresIdentity.*expected/u,
  );
  assert.equal(commands.length, callsBeforeDirtyRun, 'Postgres target mismatch must launch no command');

  const resumeServices = {
    ...services,
    async runCommand(command, args) {
      commands.push(['resume', command, ...args]);
    },
  };
  const resumed = await runBootstrap(
    {
      ...resolveBootstrapConfig({ ...env, PSFN_SHAKEDOWN_RESUME: '1' }),
      rcRevision: config.rcRevision,
    },
    resumeServices,
  );
  assert.deepEqual(
    commands.slice(callsBeforeDirtyRun),
    [
      ['resume', 'bash', join(repoRoot, 'shakedown', 'harness', 'restart-split-runtime.sh')],
    ],
    'an explicit resume must reuse completed immutable stages but relaunch and re-prove the live path',
  );
  assert.ok(resumed.turnRecordPath.endsWith('exact-bootstrap-record.jsonl'));

  console.log('bootstrap runner success/resume test passed');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
