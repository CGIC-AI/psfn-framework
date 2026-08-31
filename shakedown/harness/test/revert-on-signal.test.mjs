#!/usr/bin/env node
// Test B — the tier sweep restores the pre-sweep tier on SIGINT and SIGTERM.
//
// Runs run-live-shakedown-matrix.sh (kube target) with stub CLI + stub harness.
// The stub harness flips to `nursery`, writes its run JSON, then sleeps; the test
// signals the sweep's process group mid-phase. The signal-safe trap must re-flip
// to the captured original exactly once and confirm it.
//
// Decisive regression proof: remove the SIGINT/SIGTERM traps (65rk.1) or the
// EXIT trap and the restore line disappears -> this test FAILS. A double-restore
// (broken idempotency) also FAILS the "exactly once" check.

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOne(signal) {
  const dir = mkdtempSync(join(tmpdir(), `revert-${signal}-`));
  const stateFile = join(dir, 'tier.state');
  const setTierLog = join(dir, 'settier.log');
  const ranLog = join(dir, 'ran.log');
  const readyFile = join(dir, 'ready');
  const matrixDir = join(dir, 'matrix');
  const original = 'autonomous';
  writeFileSync(stateFile, `${original}\n`);
  writeFileSync(setTierLog, '');
  writeFileSync(ranLog, '');

  const env = {
    ...process.env,
    PSFN_TARGET: 'kube',
    PSFN_API_BASE: 'http://127.0.0.1:1',
    PSFN_ADMIN_BASE: 'http://127.0.0.1:1',
    COMPANION_ID: '11111111-1111-4111-8111-111111111111',
    API_KEY: 'stub-key',
    TESTING_HARNESS_API_KEY: 'stub-testing-harness-key',
    POSTGRES_DATABASE_URL: 'postgres://stub',
    PSFN_MATRIX_DIR: matrixDir,
    PSFN_TARGET_LIB: STUB_LIB,
    PSFN_HARNESS_PATH: STUB_HARNESS,
    STUB_STATE_FILE: stateFile,
    STUB_SETTIER_LOG: setTierLog,
    STUB_HARNESS_RANLOG: ranLog,
    STUB_HARNESS_READY: readyFile,
    STUB_HARNESS_SLEEP_MS: '60000',
  };

  const child = spawn('bash', [MATRIX], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig })));

  // Wait until the harness is running mid-phase (ready marker written).
  const deadline = Date.now() + 20000;
  while (!existsSync(readyFile) && Date.now() < deadline) await sleep(100);
  if (!existsSync(readyFile)) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    throw new Error(`[${signal}] harness never reached mid-phase; stderr:\n${stderr}`);
  }

  // Signal the whole process group — faithful Ctrl-C / kill semantics.
  process.kill(-child.pid, signal);
  const result = await Promise.race([exited, sleep(20000).then(() => ({ code: 'timeout' }))]);
  if (result.code === 'timeout') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ignore */ }
    throw new Error(`[${signal}] sweep did not exit after ${signal}; stderr:\n${stderr}`);
  }

  const log = readFileSync(setTierLog, 'utf8').trim().split('\n').filter(Boolean);
  const finalTier = readFileSync(stateFile, 'utf8').trim();
  rmSync(dir, { recursive: true, force: true });
  return { log, finalTier, stderr, original };
}

const failures = [];
function check(cond, message) {
  if (cond) console.log(`  ok  - ${message}`);
  else { failures.push(message); console.log(`  FAIL- ${message}`); }
}

async function main() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    console.log(`\n[${signal}]`);
    const { log, finalTier, original } = await runOne(signal);
    const forwardFlips = log.filter((l) => l === 'set-tier nursery ok');
    const restores = log.filter((l) => l === `set-tier ${original} ok`);
    check(forwardFlips.length === 1, `forward flip to 'nursery' happened once (log: ${JSON.stringify(log)})`);
    check(restores.length === 1, `restore to '${original}' happened exactly once (log: ${JSON.stringify(log)})`);
    check(log[log.length - 1] === `set-tier ${original} ok`, `last tier op is the restore to '${original}'`);
    check(finalTier === original, `state file left at the original tier '${original}' (got '${finalTier}')`);
  }

  if (failures.length > 0) {
    console.error(`\nTest B FAILED: ${failures.length} assertion(s) failed.`);
    process.exit(1);
  }
  console.log('\nTest B PASSED: the sweep restores the pre-sweep tier exactly once on SIGINT and SIGTERM.');
}

main().catch((error) => {
  console.error(`Test B ERROR: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
