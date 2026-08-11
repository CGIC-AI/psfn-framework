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

function isAncestor(ancestor, descendant) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    stdio: 'ignore',
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git merge-base --is-ancestor failed with exit ${String(result.status)}`);
}

export function validateAttestedPublication(currentBranch, {
  env = process.env,
  gitCommand = git,
  resolveGateState = resolveLocalGateState,
  readGateAttestation = readAttestation,
  validateGateAttestation = validateStateAttestation,
} = {}) {
  if (env.PSFN_ATTESTED_PUBLISH !== '1') return false;
  const baseRef = gitCommand([
    'config',
    '--get',
    '--default',
    'origin/main',
    `branch.${currentBranch}.psfnGateBase`,
  ]);
  const state = resolveGateState({ baseRef });
  const validation = validateGateAttestation(
    readGateAttestation(state.attestationPath),
    state,
    { changeBudgetException: env.CHANGE_BUDGET_EXCEPTION === 'true' },
  ).result;
  if (!validation.valid) {
    throw new Error(`Attested publication denied: ${validation.reason}`);
  }
  return true;
}

export function main() {
  const updates = parsePrePushUpdates(readStdin());
  const head = git(['rev-parse', 'HEAD']);
  const currentBranch = git(['branch', '--show-current']);
  const plan = planPrePush({
    updates,
    head,
    currentBranch,
    isAncestor,
    attestedPublication: validateAttestedPublication(currentBranch),
  });
  console.log(`pre-push: ${plan.reason}`);
  return plan.action === 'allow' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
