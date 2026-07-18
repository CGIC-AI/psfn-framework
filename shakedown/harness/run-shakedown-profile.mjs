#!/usr/bin/env node
// Shakedown profile runner (65rk.8) — `--profile lite|full`.
//
// This is a THIN wrapper. It does NOT reimplement the tier sweep, the case
// harness, tier flipping, or the scorecard. It composes the existing pieces:
//
//   full — reproduces the current scripted Layer A exactly: the standing
//     run-live-shakedown-matrix.sh sweep with its default per-tier case sets,
//     then shakedown-scorecard.mjs with NO profile stamp. Output is byte-for-byte
//     unchanged (full scorecards gain no `profile` field).
//
//   lite — the repeatable sub-hour floor for out-of-band feature pushes
//     (docs/shakedown.md, "Profiles: lite vs full"):
//       1. run the manifest's preflight verify gates (fail closed on any red);
//       2. run the SAME matrix sweep on ONE explicit target (PSFN_TARGET), but
//          with the manifest's ~10 persisted-state smoke cases (selected by
//          stable id) at the baseline tier and the capability-gate matrix at all
//          three tiers — so the refusal grid + tier tool-conformance evidence are
//          collected at nursery/apprentice/autonomous;
//       3. enforce a sub-hour deadline; on deadline OR an operator signal the
//          matrix child is SIGTERM'd so ITS exit trap restores the pre-sweep tier
//          (signal-safe restoration, reused — never reimplemented);
//       4. run shakedown-scorecard.mjs with PSFN_PROFILE=lite, which stamps the
//          scorecard `profile: "lite"` and skips the coverage-appendix
//          completeness cross-check ONLY when every lite attestation is present.
//
// Fail-closed: unknown --profile, an unset/invalid single target, a missing
// required output dir, or a red gate is a hard, named error. No silent fallback.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  optionalEnv,
  optionalIntEnv,
  requireEnv,
  InvalidEnvError,
  MissingEnvError,
  failClosedOnEnv,
} from './lib/env.mjs';
import {
  loadProfileManifest,
  composeTierCaseSets,
  ProfileManifestError,
} from './lib/profile.mjs';

const HARNESS_DIR = fileURLToPath(new URL('.', import.meta.url));
const TIERS = ['nursery', 'apprentice', 'autonomous'];

function log(message) {
  process.stderr.write(`${message}\n`);
}

class LiteDeadlineError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'LiteDeadlineError';
    this.reason = reason;
  }
}

/** Parse argv; fail closed on a missing/unknown --profile. */
export function parseArgs(argv) {
  let profile = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--profile') {
      profile = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length);
    } else {
      throw new InvalidEnvError('--profile', `unexpected argument ${JSON.stringify(arg)}; usage: run-shakedown-profile.mjs --profile lite|full`);
    }
  }
  if (typeof profile !== 'string' || profile.trim().length === 0) {
    throw new InvalidEnvError('--profile', 'required; usage: run-shakedown-profile.mjs --profile lite|full');
  }
  const value = profile.trim().toLowerCase();
  if (value !== 'lite' && value !== 'full') {
    throw new InvalidEnvError('--profile', `expected 'lite' or 'full', got ${JSON.stringify(profile)}`);
  }
  return { profile: value };
}

function resolveMatrixScript() {
  return optionalEnv('PSFN_MATRIX_SCRIPT') ?? join(HARNESS_DIR, 'run-live-shakedown-matrix.sh');
}

function resolveScorecardScript() {
  return optionalEnv('PSFN_SCORECARD_SCRIPT') ?? join(HARNESS_DIR, 'shakedown-scorecard.mjs');
}

function requireSingleTarget(env) {
  const target = (env.PSFN_TARGET ?? '').trim();
  if (target !== 'local' && target !== 'kube') {
    throw new InvalidEnvError('PSFN_TARGET', "lite runs one explicit target; set 'local' or 'kube'");
  }
  return target;
}

/** Run a command array to completion; a non-zero exit is a named hard error. */
function runCommand(command, { env, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', (error) => reject(new Error(`${label} could not start (${command.join(' ')}): ${error.message}`)));
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} failed: ${command.join(' ')} exited ${code === null ? `on signal ${signal}` : `with code ${code}`}`));
      }
    });
  });
}

async function runPreflightGates(manifest, env) {
  for (const gate of manifest.preflightGates) {
    log(`[lite] preflight gate '${gate.id}': ${gate.command.join(' ')}`);
    await runCommand(gate.command, { env, label: `preflight gate '${gate.id}'` });
  }
  log(`[lite] all ${manifest.preflightGates.length} preflight gate(s) passed.`);
}

/**
 * Spawn the matrix sweep. Enforces the sub-hour deadline (when deadlineMs is a
 * number) and forwards an operator SIGINT/SIGTERM to the child as SIGTERM, so the
 * matrix script's own exit trap restores + verifies the pre-sweep tier. Only
 * SIGKILLs as a last resort after a bounded grace, and then loudly names the
 * durable pre-sweep record for manual restore (the tier-conformance-sweep
 * contract). Resolves on a clean exit; rejects on deadline/signal/failure.
 */
function runMatrixSweep({ scriptPath, env, deadlineMs, graceMs, originalTierRecord }) {
  return new Promise((resolve, reject) => {
    const child = spawn(scriptPath, [], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    let settled = false;
    let terminating = null;
    let deadlineTimer = null;
    let killTimer = null;

    const cleanup = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };

    const beginTermination = (reason) => {
      if (terminating || settled) return;
      terminating = reason;
      log(`[lite] ${reason}: SIGTERM -> matrix sweep so it restores the pre-sweep tier via its exit trap...`);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        log(`[lite] FATAL: matrix sweep did not exit ${graceMs}ms after SIGTERM; sending SIGKILL. `
          + `The tier restore trap may NOT have completed — verify and restore the tier manually from the `
          + `durable record (${originalTierRecord}); see shakedown/harness/README.md "Safety and manual restore".`);
        child.kill('SIGKILL');
      }, graceMs);
    };

    function onSignal(signal) {
      beginTermination(signal);
    }

    if (typeof deadlineMs === 'number') {
      deadlineTimer = setTimeout(() => beginTermination('deadline'), deadlineMs);
    }
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`matrix sweep failed to start (${scriptPath}): ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminating) {
        reject(new LiteDeadlineError(
          terminating,
          terminating === 'deadline'
            ? `lite sub-hour deadline (${deadlineMs}ms) exceeded; matrix sweep terminated and its exit trap restored the pre-sweep tier`
            : `received ${terminating}; matrix sweep terminated and its exit trap restored the pre-sweep tier`,
        ));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`matrix sweep exited ${code === null ? `on signal ${signal}` : `with code ${code}`}`));
      }
    });
  });
}

function tierRunJsonPaths(matrixDir) {
  return TIERS.map((tier) => join(matrixDir, `live-system-shakedown.${tier}.json`));
}

function runScorecard({ scorecardScript, env, inputs, jsonOut, mdOut, profile }) {
  const scorecardEnv = {
    ...env,
    PSFN_SCORECARD_INPUTS: inputs.join(','),
    PSFN_SCORECARD_JSON: jsonOut,
    PSFN_SCORECARD_MD: mdOut,
  };
  if (profile === 'lite') {
    scorecardEnv.PSFN_PROFILE = 'lite';
  } else {
    // Full path leaves PSFN_PROFILE unset so the scorecard output is unchanged.
    delete scorecardEnv.PSFN_PROFILE;
  }
  return runCommand(['node', scorecardScript], { env: scorecardEnv, label: 'scorecard' });
}

async function runLiteProfile(env) {
  const manifest = loadProfileManifest();
  const target = requireSingleTarget(env);
  const matrixDir = requireEnv('PSFN_MATRIX_DIR', 'output dir for the per-tier run JSONs (also the scorecard input dir)');
  const deadlineMs = optionalIntEnv('PSFN_LITE_DEADLINE_MS', manifest.deadlineMs);
  if (deadlineMs <= 0 || deadlineMs >= manifest.maxDeadlineMs) {
    throw new InvalidEnvError('PSFN_LITE_DEADLINE_MS', `must be >0 and under the manifest ceiling ${manifest.maxDeadlineMs}ms, got ${deadlineMs}`);
  }
  const graceMs = optionalIntEnv('PSFN_LITE_RESTORE_GRACE_MS', 180000);
  const originalTierRecord = optionalEnv('PSFN_ORIGINAL_TIER_FILE') ?? join(matrixDir, 'original-capability-tier');

  log(`[lite] profile=lite target=${target} deadline=${deadlineMs}ms manifest=${manifest.path}`);

  await runPreflightGates(manifest, env);

  const caseSets = composeTierCaseSets(manifest);
  log(`[lite] tier case sets: ${TIERS.map((tier) => `${tier}=[${caseSets[tier].join(',')}]`).join(' ')}`);
  const matrixEnv = {
    ...env,
    PSFN_NURSERY_CASES: caseSets.nursery.join(','),
    PSFN_APPRENTICE_CASES: caseSets.apprentice.join(','),
    PSFN_AUTONOMOUS_CASES: caseSets.autonomous.join(','),
  };

  await runMatrixSweep({
    scriptPath: resolveMatrixScript(),
    env: matrixEnv,
    deadlineMs,
    graceMs,
    originalTierRecord,
  });

  const jsonOut = optionalEnv('PSFN_SCORECARD_JSON') ?? join(matrixDir, 'shakedown-scorecard.lite.json');
  const mdOut = optionalEnv('PSFN_SCORECARD_MD') ?? join(matrixDir, 'SHAKEDOWN-SCORECARD.lite.md');
  await runScorecard({
    scorecardScript: resolveScorecardScript(),
    env,
    inputs: tierRunJsonPaths(matrixDir),
    jsonOut,
    mdOut,
    profile: 'lite',
  });
  log(`[lite] scorecard (profile:lite) green -> ${jsonOut}`);
}

async function runFullProfile(env) {
  // Full = the documented round's scripted Layer A, unchanged. Default case sets,
  // no deadline, no profile stamp. Signals still forward to the child so an
  // operator Ctrl-C restores the tier via the matrix exit trap.
  const matrixDir = requireEnv('PSFN_MATRIX_DIR', 'output dir for the per-tier run JSONs (also the scorecard input dir)');
  const graceMs = optionalIntEnv('PSFN_LITE_RESTORE_GRACE_MS', 180000);
  const originalTierRecord = optionalEnv('PSFN_ORIGINAL_TIER_FILE') ?? join(matrixDir, 'original-capability-tier');

  log('[full] profile=full — standard scripted Layer A (matrix sweep + scorecard), no profile stamp.');

  await runMatrixSweep({
    scriptPath: resolveMatrixScript(),
    env,
    deadlineMs: null,
    graceMs,
    originalTierRecord,
  });

  const jsonOut = requireEnv('PSFN_SCORECARD_JSON', 'scorecard JSON output path');
  const mdOut = requireEnv('PSFN_SCORECARD_MD', 'scorecard Markdown output path');
  await runScorecard({
    scorecardScript: resolveScorecardScript(),
    env,
    inputs: tierRunJsonPaths(matrixDir),
    jsonOut,
    mdOut,
    profile: 'full',
  });
  log(`[full] scorecard green -> ${jsonOut}`);
}

export async function runProfile(argv, env = process.env) {
  const { profile } = parseArgs(argv);
  if (profile === 'lite') {
    await runLiteProfile(env);
  } else {
    await runFullProfile(env);
  }
}

async function main() {
  await runProfile(process.argv.slice(2), process.env);
}

// Only auto-run when invoked as a script, not when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    if (error instanceof MissingEnvError || error instanceof InvalidEnvError) {
      failClosedOnEnv(error);
      return;
    }
    if (error instanceof ProfileManifestError || error instanceof LiteDeadlineError) {
      log(error.message);
      process.exit(1);
    }
    log(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
}
