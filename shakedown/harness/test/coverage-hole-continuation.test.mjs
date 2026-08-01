#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const harnessDir = join(here, '..');
const matrix = join(harnessDir, 'run-live-shakedown-matrix.sh');
const stubTarget = join(here, 'support', 'stub-target-lib.mjs');
const stubHarness = join(here, 'support', 'stub-harness.mjs');

const originalTier = 'apprentice';
const failureReason = 'missing_env:PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_API_KEY';

for (const scenario of [
  { status: 'coverage_hole', reason: failureReason },
  { status: 'agent_busy', reason: 'agent_busy:busy_retry_window_exhausted' },
]) {
  const root = mkdtempSync(join(tmpdir(), `${scenario.status}-continuation-`));
  const matrixDir = join(root, 'matrix');
  const stateFile = join(root, 'tier.state');
  const setTierLog = join(root, 'set-tier.log');
  const ranLog = join(root, 'ran.log');
  try {
    writeFileSync(stateFile, `${originalTier}\n`);
    writeFileSync(setTierLog, '');
    writeFileSync(ranLog, '');

    const result = spawnSync('bash', [matrix], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PSFN_TARGET: 'kube',
        PSFN_API_BASE: 'http://127.0.0.1:1',
        PSFN_ADMIN_BASE: 'http://127.0.0.1:1',
        TESTING_HARNESS_API_KEY: 'stub-testing-harness-key',
        POSTGRES_DATABASE_URL: 'postgres://stub',
        PSFN_MATRIX_DIR: matrixDir,
        PSFN_TARGET_LIB: stubTarget,
        PSFN_HARNESS_PATH: stubHarness,
        STUB_STATE_FILE: stateFile,
        STUB_SETTIER_LOG: setTierLog,
        STUB_HARNESS_RANLOG: ranLog,
        STUB_HARNESS_CASE_STATUS: scenario.status,
        STUB_HARNESS_FAILURE_REASON: scenario.reason,
      },
    });

    assert(result.status === 0, `matrix exited ${String(result.status)}: ${result.stderr}`);
    const ran = readFileSync(ranLog, 'utf8').trim().split('\n').filter(Boolean);
    assert(ran.length === 3, `expected all three tiers to run, got ${JSON.stringify(ran)}`);
    for (const [label, tier] of [
      ['nursery', 'nursery'],
      ['apprentice', 'apprentice'],
      ['autonomous', 'autonomous'],
    ]) {
      assert(ran.some((line) => line.includes(`tier=${tier}`)), `${tier} tier did not run`);
      const artifact = JSON.parse(readFileSync(
        join(matrixDir, `live-system-shakedown.${label}.json`),
        'utf8',
      ));
      assert(artifact.harnessStatus !== 'matrix_aborted', `${label} was matrix-aborted`);
      assert(artifact.results[0]?.caseStatus === scenario.status, `${label} lost case-local status`);
      assert(artifact.results[0]?.failureReason === scenario.reason, `${label} lost named reason`);
    }
    assert(readFileSync(stateFile, 'utf8').trim() === originalTier, 'original tier was not restored');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
console.log('case-local continuation test passed');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
