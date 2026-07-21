#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  buildGatePlan,
  createAttestation,
  validateAttestation,
} from './local-delivery-contract.mjs';

function git(args, cwd, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.quietStderr ? 'ignore' : 'pipe'],
  }).trim();
}

function gitRaw(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function resolveLocalGateState({ cwd = process.cwd(), baseRef = 'origin/main' } = {}) {
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}'], cwd);
  const branch = git(['branch', '--show-current'], cwd);
  if (!branch) throw new Error('Local pre-PR gate requires a named branch.');
  if (branch === 'main') throw new Error('Run the local pre-PR gate on a PR branch, not main.');

  const status = git(['status', '--porcelain=v1', '--untracked-files=all'], cwd);
  if (status) {
    throw new Error('Local pre-PR gate requires a clean worktree and index. Commit the exact change first.');
  }

  const base = git(['rev-parse', '--verify', `${baseRef}^{commit}`], cwd);
  const mergeBase = git(['merge-base', base, head], cwd);
  if (mergeBase !== base) {
    throw new Error(`${baseRef} is not an ancestor of HEAD; rebase the branch before validation.`);
  }
  const pathsOutput = gitRaw(['diff', '--name-only', '-M', '-z', base, head], cwd);
  const paths = pathsOutput.split('\0').filter(Boolean);
  if (paths.length === 0) throw new Error(`HEAD contains no changes relative to ${baseRef}.`);

  const gitDir = git(['rev-parse', '--absolute-git-dir'], cwd);
  const stateDir = join(gitDir, 'local-delivery-gate');
  return {
    cwd,
    branch,
    head,
    base,
    baseRef,
    paths,
    stateDir,
    attestationPath: join(stateDir, 'attestation.json'),
    logDir: join(stateDir, 'logs', head),
  };
}

export function readAttestation(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read local gate attestation ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function writeAttestation(path, attestation) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(attestation, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function buildStateGatePlan(state, { changeBudgetException = false } = {}) {
  return buildGatePlan({
    paths: state.paths,
    base: state.base,
    head: state.head,
    changeBudgetException,
  });
}

export function validateStateAttestation(attestation, state, options) {
  const plan = buildStateGatePlan(state, options);
  const gates = plan.filter(({ skip }) => !skip).map(({ name }) => name);
  return { plan, gates, result: validateAttestation(attestation, { ...state, gates }) };
}

function gateEnvironment(gate) {
  const env = { ...process.env, PSFN_LOCAL_GATE_ACTIVE: '1' };
  if (gate.nodeHeapMb) env.NODE_OPTIONS = `--max-old-space-size=${gate.nodeHeapMb}`;
  return env;
}

export async function executeGate(gate, { cwd, logDir }) {
  if (gate.skip) {
    console.log(`==> ${gate.name}: skipped (no applicable changed files)`);
    return;
  }
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${gate.name}.log`);
  const log = createWriteStream(logPath, { flags: 'w', mode: 0o600 });
  console.log(`==> ${gate.name}`);

  await new Promise((resolve, reject) => {
    const child = spawn(gate.executable, gate.args, {
      cwd,
      env: gateEnvironment(gate),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      log.end();
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${gate.name} failed (${signal ? `signal ${signal}` : `exit ${String(code)}`}); log: ${logPath}`,
          ),
        );
      }
    });
  });
}

function parseArguments(argv) {
  const options = { baseRef: 'origin/main', force: false, plan: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--base') options.baseRef = argv[++index] ?? '';
    else if (argument === '--force') options.force = true;
    else if (argument === '--plan') options.plan = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.baseRef) throw new Error('--base requires a git ref');
  return options;
}

export async function runLocalGate({
  cwd = process.cwd(),
  baseRef = 'origin/main',
  changeBudgetException = process.env.CHANGE_BUDGET_EXCEPTION === 'true',
  force = false,
  planOnly = false,
  execute = executeGate,
} = {}) {
  const state = resolveLocalGateState({ cwd, baseRef });
  const cached = readAttestation(state.attestationPath);
  const validation = validateStateAttestation(cached, state, { changeBudgetException });
  if (validation.result.valid && !force) {
    console.log(`Local pre-PR gate already passed for ${state.head.slice(0, 12)}.`);
    return cached;
  }

  const { plan, gates } = validation;
  if (planOnly) {
    for (const gate of plan) {
      console.log(`${gate.skip ? 'skip' : 'run'}\t${gate.name}\t${gate.executable} ${gate.args.join(' ')}`);
    }
    return null;
  }

  console.log(
    `Local pre-PR gate: ${state.branch} ${state.base.slice(0, 12)}..${state.head.slice(0, 12)} (${state.paths.length} files)`,
  );
  for (const gate of plan) await execute(gate, state);

  const attestation = createAttestation({
    head: state.head,
    base: state.base,
    baseRef: state.baseRef,
    gates,
  });
  writeAttestation(state.attestationPath, attestation);
  console.log(`Local pre-PR gate passed; attested ${state.head.slice(0, 12)}.`);
  return attestation;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await runLocalGate({
    baseRef: options.baseRef,
    force: options.force,
    planOnly: options.plan,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
