#!/usr/bin/env node
// Test C — a failed/unconfirmed forward flip ABORTS the phase; cases NEVER run
// against the wrong tier.
//
// Runs run-live-shakedown-matrix.sh (kube target) with a stub CLI whose set-tier
// FAILS for `nursery` (models an unconfirmed flip). The sweep must abort before
// invoking the case harness for nursery, exit non-zero, mark the remaining tiers
// aborted, and still restore the original tier on exit.
//
// Decisive regression proof: this exercises the `set_tier "$tier" || return $?`
// guard in run_phase. Because run_phase runs under `|| status=$?`, `set -e` is
// suppressed inside it — revert the guard back to a bare `set_tier "$tier"` and
// the failed flip is swallowed, the stub harness RUNS at the wrong tier, and the
// "harness must not run" assertion FAILS.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = join(HERE, '..');
const MATRIX = join(HARNESS_DIR, 'run-live-shakedown-matrix.sh');
const STUB_LIB = join(HERE, 'support', 'stub-target-lib.mjs');
const STUB_HARNESS = join(HERE, 'support', 'stub-harness.mjs');

const failures = [];
function check(cond, message) {
  if (cond) console.log(`  ok  - ${message}`);
  else { failures.push(message); console.log(`  FAIL- ${message}`); }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'flip-abort-'));
  const stateFile = join(dir, 'tier.state');
  const setTierLog = join(dir, 'settier.log');
  const ranLog = join(dir, 'ran.log');
  const matrixDir = join(dir, 'matrix');
  const original = 'apprentice';
  writeFileSync(stateFile, `${original}\n`);
  writeFileSync(setTierLog, '');
  writeFileSync(ranLog, '');

  const env = {
    ...process.env,
    PSFN_TARGET: 'kube',
    PSFN_API_BASE: 'http://127.0.0.1:1',
    PSFN_ADMIN_BASE: 'http://127.0.0.1:1',
    API_KEY: 'stub-key',
    POSTGRES_DATABASE_URL: 'postgres://stub',
    PSFN_MATRIX_DIR: matrixDir,
    PSFN_TARGET_LIB: STUB_LIB,
    PSFN_HARNESS_PATH: STUB_HARNESS,
    STUB_STATE_FILE: stateFile,
    STUB_SETTIER_LOG: setTierLog,
    STUB_HARNESS_RANLOG: ranLog,
    STUB_FAIL_SET_TIER: 'nursery',
  };

  const child = spawn('bash', [MATRIX], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const { code } = await new Promise((resolve) => child.on('exit', (c, s) => resolve({ code: c, sig: s })));

  const ran = existsSync(ranLog) ? readFileSync(ranLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  const setTier = readFileSync(setTierLog, 'utf8').trim().split('\n').filter(Boolean);
  const nurseryRan = ran.some((l) => l.includes('phase=coverage') || l.includes('tier=nursery'));
  const nurseryReport = join(matrixDir, 'live-system-shakedown.nursery.json');
  const apprenticeReport = join(matrixDir, 'live-system-shakedown.apprentice.json');
  const finalTier = readFileSync(stateFile, 'utf8').trim();

  check(code !== 0, `sweep exited non-zero on the unconfirmed flip (exit ${code})`);
  check(!nurseryRan, `case harness did NOT run for the unconfirmed tier (ran log: ${JSON.stringify(ran)})`);
  check(
    setTier.includes('set-tier nursery FAIL'),
    `forward flip to 'nursery' was attempted and recorded as FAIL (log: ${JSON.stringify(setTier)})`,
  );
  // The nursery run JSON must not be a completed harness run (it either doesn't
  // exist or is a matrix_aborted marker written by the abort path).
  let nurseryOkRun = false;
  if (existsSync(nurseryReport)) {
    const parsed = JSON.parse(readFileSync(nurseryReport, 'utf8'));
    nurseryOkRun = parsed.completed === true && parsed.harnessStatus === 'ok';
  }
  check(!nurseryOkRun, 'no completed nursery run JSON was produced');
  if (existsSync(apprenticeReport)) {
    const parsed = JSON.parse(readFileSync(apprenticeReport, 'utf8'));
    check(parsed.harnessStatus === 'matrix_aborted', 'downstream apprentice phase marked matrix_aborted');
  }
  check(finalTier === original, `original tier '${original}' restored on exit (got '${finalTier}')`);

  rmSync(dir, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error(`\nTest C FAILED: ${failures.length} assertion(s) failed.\nsweep stderr:\n${stderr}`);
    process.exit(1);
  }
  console.log('\nTest C PASSED: an unconfirmed forward flip aborts the phase before any case runs.');
}

main().catch((error) => {
  console.error(`Test C ERROR: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
