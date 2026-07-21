#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { parsePrePushUpdates, planPrePush } from './local-delivery-contract.mjs';
import {
  readAttestation,
  resolveLocalGateState,
  validateStateAttestation,
} from './run-local-gate.mjs';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

export function configuredBaseRef(branch) {
  return git(['config', '--get', '--default', 'origin/main', `branch.${branch}.psfnGateBase`]);
}

export function main() {
  const updates = parsePrePushUpdates(readStdin());
  const head = git(['rev-parse', 'HEAD']);
  const currentBranch = git(['branch', '--show-current']);
  const gateActive = process.env.PSFN_LOCAL_GATE_ACTIVE === '1';
  const preliminary = planPrePush({
    updates,
    head,
    currentBranch,
    attestationValid: false,
    gateActive,
  });
  if (preliminary.action !== 'run-gate') {
    console.log(`pre-push: ${preliminary.reason}`);
    return preliminary.action === 'allow' ? 0 : 1;
  }

  const baseRef = configuredBaseRef(currentBranch);
  const state = resolveLocalGateState({ baseRef });
  const attestation = readAttestation(state.attestationPath);
  const attestationResult = validateStateAttestation(attestation, state).result;
  const plan = planPrePush({
    updates,
    head,
    currentBranch,
    attestationValid: attestationResult.valid,
    gateActive,
  });

  console.log(`pre-push: ${plan.reason}`);
  if (plan.action === 'block') return 1;
  if (plan.action === 'allow') return 0;

  const result = spawnSync(
    process.execPath,
    ['scripts/ci/run-local-gate.mjs', '--base', baseRef],
    { stdio: 'inherit', env: { ...process.env, PSFN_LOCAL_GATE_ACTIVE: '1' } },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
