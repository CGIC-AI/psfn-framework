#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  HEAVY_PHASE_LOCK_DIR,
  buildGatePlan,
  createAttestation,
  describeLockWait,
  partitionGatePlan,
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
  const scannablePathsOutput = gitRaw([
    'diff',
    '--name-only',
    '--diff-filter=ACMRTUXB',
    '-M',
    '-z',
    base,
    head,
  ], cwd);
  const scannablePaths = scannablePathsOutput.split('\0').filter(Boolean);
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
    scannablePaths,
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

const DEFAULT_POLL_MS = 2000;
const DEFAULT_DIAGNOSTIC_MS = 15000;

// Grace period before a metaless lock directory is treated as an orphan. A live
// holder publishes meta.json within milliseconds of creating the lock directory
// (mkdir, then a temp-write + rename that completes in sub-millisecond time), so
// any directory that stays metaless for whole seconds is not a writer mid-flight
// — it is the corpse of a process killed between the mkdir and the meta publish.
// 10s is orders of magnitude past a real writer's publish window, so this can
// never race a live writer, yet it bounds the wedge to ~10s instead of forever
// (without it a metaless orphan is never reclaimed and the heavy phase stalls
// until a human removes the directory by hand).
const METALESS_GRACE_MS = 10000;

// Liveness probe used for stale-lock recovery. `kill(pid, 0)` never signals the
// process; it only reports reachability. ESRCH is a provably dead owner (the
// only case in which a lock may be reclaimed). EPERM means the process exists
// under another user — alive, and never to be stolen. Any other error is
// surfaced (fail closed) rather than misread as death.
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function lockMetaPath(lockDir) {
  return join(lockDir, 'meta.json');
}

function readLockMeta(metaPath) {
  let raw;
  try {
    raw = readFileSync(metaPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    // meta is written temp-then-rename, so readers never see a torn write;
    // unparsable content means genuine corruption. Fail closed.
    throw new Error(`Corrupt heavy-phase lock metadata at ${metaPath}: ${error.message}`);
  }
}

function writeLockMeta(metaPath, meta) {
  const temporary = `${metaPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(temporary, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, metaPath);
}

// Reclaim a stale lock under a single-owner reap mutex. The mutex exists so the
// liveness re-check and the removal are performed by exactly one process at a
// time: any other contender that recreated a fresh live lock in the meantime is
// observed as alive here and is never removed. Returns true only when a
// provably-dead owner's lock was removed.
function reapStaleLock({ lockDir, isAlive, log }) {
  const reapDir = `${lockDir}.reap`;
  const reapMetaPath = lockMetaPath(reapDir);
  try {
    mkdirSync(reapDir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Another process is reaping. If that reaper is itself dead, clear its
    // marker so a later pass can retry; never disturb a live reaper.
    const reaper = readLockMeta(reapMetaPath);
    if (!reaper || !isAlive(reaper.pid)) {
      rmSync(reapDir, { recursive: true, force: true });
    }
    return false;
  }
  try {
    writeLockMeta(reapMetaPath, { pid: process.pid, startedAt: new Date().toISOString() });
    const holder = readLockMeta(lockMetaPath(lockDir));
    if (!holder) return false; // vanished or mid-write: nothing to reap
    if (isAlive(holder.pid)) return false; // came back alive: never steal
    rmSync(lockDir, { recursive: true, force: true });
    log.error(
      `heavy-phase lock: reclaimed stale lock from dead pid ${holder.pid} (${holder.worktree ?? 'unknown worktree'})`,
    );
    return true;
  } finally {
    rmSync(reapDir, { recursive: true, force: true });
  }
}

// Age of a metaless lock directory, measured from the directory's own stat so
// every waiter agrees on it (no reliance on per-process first-seen memory).
// birthtime is unreliable on some filesystems (reported as 0), so fall back to
// mtime — set by the mkdir and never advanced while the directory stays
// metaless. Returns null if the directory has already vanished (retry mkdir).
function metalessLockAgeMs(lockDir, stat, now) {
  let info;
  try {
    info = stat(lockDir);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const createdMs = info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
  return now() - createdMs;
}

// Reclaim a metaless orphan (a lock directory whose owner died between mkdir and
// the meta publish) under the same single-owner reap mutex used for dead-PID
// reaps, so the two reclaim paths can never run concurrently. Inside the mutex
// we re-read meta.json: a slow-but-alive writer that has since published is
// honored (return false, remove nothing). Only a directory that is STILL
// metaless is removed — recursively, which also clears any orphaned temp file
// left inside it. A directory with meta.json is never touched here; that path
// stays owned by the dead-PID reap (reapStaleLock).
function reapMetalessLock({ lockDir, isAlive, log }) {
  const reapDir = `${lockDir}.reap`;
  const reapMetaPath = lockMetaPath(reapDir);
  try {
    mkdirSync(reapDir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Another process holds the reap mutex. If that reaper is itself dead, clear
    // its marker so a later pass can retry; never disturb a live reaper.
    const reaper = readLockMeta(reapMetaPath);
    if (!reaper || !isAlive(reaper.pid)) {
      rmSync(reapDir, { recursive: true, force: true });
    }
    return false;
  }
  try {
    writeLockMeta(reapMetaPath, { pid: process.pid, startedAt: new Date().toISOString() });
    const holder = readLockMeta(lockMetaPath(lockDir));
    if (holder) return false; // writer published under the grace window: honor it
    rmSync(lockDir, { recursive: true, force: true });
    log.error(`heavy-phase lock: reclaimed metaless lock dir ${lockDir} after grace period`);
    return true;
  } finally {
    rmSync(reapDir, { recursive: true, force: true });
  }
}

export async function acquireHeavyPhaseLock({
  lockDir = HEAVY_PHASE_LOCK_DIR,
  meta,
  isAlive = isProcessAlive,
  now = Date.now,
  sleep = (ms) => delay(ms),
  log = console,
  pollMs = DEFAULT_POLL_MS,
  diagnosticEveryMs = DEFAULT_DIAGNOSTIC_MS,
  stat = statSync,
  metalessGraceMs = METALESS_GRACE_MS,
} = {}) {
  if (!meta || typeof meta.pid !== 'number') {
    throw new Error('Heavy-phase lock requires metadata with an owner pid.');
  }
  const metaPath = lockMetaPath(lockDir);
  const waitStart = now();
  let lastDiagnostic = 0;
  for (;;) {
    try {
      mkdirSync(lockDir);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = readLockMeta(metaPath);
      if (!holder) {
        // Lock directory exists but its owner has not finished writing metadata
        // (or it just vanished). A live writer publishes meta.json in
        // milliseconds, so once the directory has been metaless past the grace
        // period it is an orphan from a process killed between mkdir and the
        // meta publish — never reclaimed by the dead-PID reap (which needs
        // non-null meta), so every waiter would otherwise sleep here forever.
        // Reclaim it under the reap mutex (which re-checks meta is still absent
        // before removing), then loop back to contend normally.
        const ageMs = metalessLockAgeMs(lockDir, stat, now);
        if (ageMs !== null && ageMs >= metalessGraceMs && reapMetalessLock({ lockDir, isAlive, log })) {
          continue;
        }
        await sleep(pollMs);
        continue;
      }
      if (isAlive(holder.pid)) {
        const waitedMs = now() - waitStart;
        if (lastDiagnostic === 0 || now() - lastDiagnostic >= diagnosticEveryMs) {
          log.error(describeLockWait({ holder, waitedMs, self: meta }));
          lastDiagnostic = now();
        }
        await sleep(pollMs);
        continue;
      }
      const reclaimed = reapStaleLock({ lockDir, isAlive, log });
      if (!reclaimed) await sleep(pollMs);
      continue;
    }
    try {
      writeLockMeta(metaPath, meta);
    } catch (error) {
      // Never leave a metadata-less lock directory behind (it would strand
      // every waiter). Remove what we created and surface the failure.
      rmSync(lockDir, { recursive: true, force: true });
      throw error;
    }
    return {
      lockDir,
      release: () => releaseHeavyPhaseLock({ lockDir, meta }),
    };
  }
}

export function releaseHeavyPhaseLock({ lockDir, meta }) {
  const metaPath = lockMetaPath(lockDir);
  const holder = readLockMeta(metaPath);
  if (!holder) {
    throw new Error('Heavy-phase lock vanished before release; a concurrent reclaim is suspected.');
  }
  if (holder.pid !== meta.pid || holder.startedAt !== meta.startedAt) {
    throw new Error('Heavy-phase lock owner changed before release; refusing to remove another holder.');
  }
  rmSync(lockDir, { recursive: true, force: true });
}

export async function withHeavyPhaseLock(config, body) {
  const handle = await acquireHeavyPhaseLock(config);
  const log = config.log ?? console;
  let bodyFailed = false;
  try {
    return await body();
  } catch (error) {
    bodyFailed = true;
    throw error;
  } finally {
    try {
      handle.release();
    } catch (releaseError) {
      if (!bodyFailed) throw releaseError;
      log.error(
        `heavy-phase lock release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
      );
    }
  }
}

export function buildStateGatePlan(state, { changeBudgetException = false } = {}) {
  return buildGatePlan({
    paths: state.paths,
    scannablePaths: state.scannablePaths,
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

function buildHeavyLockMeta(state, activeGates, lockConfig) {
  return {
    pid: lockConfig.pid ?? process.pid,
    worktree: state.cwd,
    command: `local-gate heavy: ${activeGates.map((gate) => gate.name).join(',')}`,
    startedAt: new Date().toISOString(),
  };
}

// Run the heavy phase under the machine-wide lock. If every heavy gate is
// skipped (e.g. a delivery-only change with no product tests to run) no lock is
// taken; the preflight phase never takes the lock at all.
export async function runHeavyPhase({ heavy, state, execute, lockConfig = {} }) {
  const active = heavy.filter((gate) => !gate.skip);
  if (active.length === 0) {
    for (const gate of heavy) await execute(gate, state);
    return;
  }
  const meta = buildHeavyLockMeta(state, active, lockConfig);
  await withHeavyPhaseLock({ ...lockConfig, meta }, async () => {
    for (const gate of heavy) await execute(gate, state);
  });
}

export async function runLocalGate({
  cwd = process.cwd(),
  baseRef = 'origin/main',
  changeBudgetException = process.env.CHANGE_BUDGET_EXCEPTION === 'true',
  force = false,
  planOnly = false,
  execute = executeGate,
  heavyLock = {},
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
  // Phase 1 (preflight): every cheap, parallel-safe gate — including the
  // deployment/settings/supply-chain contracts — runs before any heavy suite so
  // a cheap contract failure fires first and never after a full product run.
  // Phase 2 (heavy): the product/Postgres suite, serialized machine-wide.
  const { preflight, heavy } = partitionGatePlan(plan);
  for (const gate of preflight) await execute(gate, state);
  await runHeavyPhase({ heavy, state, execute, lockConfig: heavyLock });

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
