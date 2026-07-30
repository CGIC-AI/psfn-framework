#!/usr/bin/env node
// Test D — tier-conformance-sweep.mjs flips through all three tiers, restores the
// pre-sweep tier on normal exit AND on SIGINT/SIGTERM, and counts ok:false
// conformance entries correctly.
//
// Drives the REAL tier-conformance-sweep.mjs (which uses the REAL
// setTierAndConfirm/fetchCurrentTier from lib/target.mjs) against an in-process
// stub Garden that composes the capability-tier owner-file contract with the
// tool-conformance run/latest endpoints. No live cluster is touched.
//
// Decisive regression proofs:
//   * Remove the finally-block restore (or the SIGINT/SIGTERM handlers) in the
//     sweep and the "restored to original" assertions FAIL.
//   * Change the summary to key off `.classification`/`.tool` truthiness instead
//     of `ok === false` (the throwaway probe's bug) and the ok:false count is
//     wrong -> the count assertion FAILS.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStubConformanceServer } from './support/stub-conformance-server.mjs';
import { resolveTarget } from '../lib/target.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = join(HERE, '..');
const SWEEP = join(HARNESS_DIR, 'tier-conformance-sweep.mjs');

const ADMIN_TOKEN = 'stub-admin-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A /latest payload with exactly one ok:false entry (notify, matching the real
// k3d capture) plus two healthy reads — total=3, failed=1.
const LATEST_ONE_FAILURE = {
  schemaVersion: 1,
  ranAt: 1784262464367,
  trigger: 'manual',
  results: [
    { toolName: 'self_status', probeKind: 'read_only', ok: true, durationMs: 5 },
    { toolName: 'session', probeKind: 'read_only', action: 'list', ok: true, durationMs: 4 },
    {
      toolName: 'notify',
      probeKind: 'schema_only',
      ok: false,
      durationMs: 0,
      classification: 'schema_invalid',
      error: 'parameters schema declares neither type:"object" nor properties',
    },
  ],
};

function sweepEnv(baseUrl, matrixDir) {
  return {
    ...process.env,
    PSFN_TARGET: 'kube',
    PSFN_API_BASE: baseUrl,
    PSFN_ADMIN_BASE: baseUrl,
    API_KEY: 'stub-key',
    TESTING_HARNESS_API_KEY: ADMIN_TOKEN,
    ADMIN_TOKEN,
    COMPANION_ID: '22222222-2222-4222-8222-222222222222',
    POSTGRES_DATABASE_URL: 'postgres://stub',
    PSFN_MATRIX_DIR: matrixDir,
    // Keep the run-settle short so the normal-exit case finishes fast.
    PSFN_CONFORMANCE_SETTLE_MS: '0',
    PSFN_TIER_FLIP_CONFIRM_TIMEOUT_MS: '3000',
    PSFN_TIER_FLIP_POLL_MS: '10',
    PSFN_TIER_RESTORE_MAX_ATTEMPTS: '3',
    PSFN_TIER_RESTORE_RETRY_DELAY_MS: '50',
  };
}

const failures = [];
function check(cond, message) {
  if (cond) console.log(`  ok  - ${message}`);
  else { failures.push(message); console.log(`  FAIL- ${message}`); }
}

// --- Part 1: normal exit -----------------------------------------------------
async function testNormalExit() {
  console.log('\n[normal-exit]');
  const dir = mkdtempSync(join(tmpdir(), 'tier-conf-normal-'));
  const matrixDir = join(dir, 'matrix');
  const original = 'apprentice';
  const stub = await startStubConformanceServer({
    tier: original,
    customTokens: ['git.read'],
    adminToken: ADMIN_TOKEN,
    latestPayload: LATEST_ONE_FAILURE,
    runDelayMs: 0,
  });

  let stderr = '';
  try {
    const child = spawn('node', [SWEEP], { env: sweepEnv(stub.baseUrl, matrixDir), stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const { code } = await new Promise((resolve) => child.on('exit', (c, s) => resolve({ code: c, sig: s })));

    check(code === 0, `sweep exited 0 on clean run (exit ${code})`);

    const flips = stub.log.filter((r) => r.method === 'POST' && r.path === '/api/admin/settings/capabilities');
    // nursery, apprentice, autonomous, then the restore -> 4 whole-file writes.
    check(flips.length === 4, `four capability POSTs: 3 flips + 1 restore (got ${flips.length})`);
    const usedPatch = stub.log.some((r) => r.method === 'PATCH');
    check(!usedPatch, 'never used the rejected PATCH /api/admin/settings route');
    const runs = stub.log.filter((r) => r.method === 'POST' && r.path === '/api/admin/tool-conformance/run');
    check(runs.length === 3, `triggered a conformance run once per tier (got ${runs.length})`);

    const finalState = stub.getState();
    check(finalState.tier === original, `pre-sweep tier '${original}' restored on normal exit (got '${finalState.tier}')`);
    check(
      JSON.stringify(finalState.customTokens) === JSON.stringify(['git.read']),
      `customTokens preserved through the whole sweep (got ${JSON.stringify(finalState.customTokens)})`,
    );

    // Durable pre-sweep record written before any flip.
    const durable = join(matrixDir, 'original-capability-tier');
    check(existsSync(durable) && readFileSync(durable, 'utf8').trim() === original,
      `durable pre-sweep record written as '${original}'`);

    // Per-tier result JSONs written and parseable.
    for (const tier of ['nursery', 'apprentice', 'autonomous']) {
      const p = join(matrixDir, `tool-conformance.${tier}.json`);
      const payload = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
      const ok = Array.isArray(payload?.results)
        && payload?.capabilityTierChangeNotice?.matches === true;
      check(ok, `per-tier result JSON written for '${tier}'`);
    }
    const sessionReads = stub.log.filter(
      request => request.method === 'GET' && request.path.startsWith('/api/admin/sessions'),
    );
    check(sessionReads.length >= 6, 'verified companion-visible tier notices through session reads');

    // ok:false counting: one failure per tier, summarized correctly.
    const okFalseLines = (stderr.match(/ok:false=1/g) ?? []).length;
    check(okFalseLines >= 3, `summary reported ok:false=1 for each of 3 tiers (matches=${okFalseLines})`);
    check(
      stderr.includes('notify/- -> schema_invalid (parameters schema declares neither'),
      'failure line formatted as toolName/action -> classification (error)',
    );
    check(/TIER-INSENSITIVE/.test(stderr), 'overall tier-insensitive caveat emitted');
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return stderr;
}

// --- Part 2/3: restore on SIGINT / SIGTERM -----------------------------------
async function testSignalRestore(signal) {
  console.log(`\n[${signal}]`);
  const dir = mkdtempSync(join(tmpdir(), `tier-conf-${signal}-`));
  const matrixDir = join(dir, 'matrix');
  const original = 'autonomous';
  const stub = await startStubConformanceServer({
    tier: original,
    customTokens: [],
    adminToken: ADMIN_TOKEN,
    latestPayload: LATEST_ONE_FAILURE,
    // Block the FIRST conformance run so the sweep is mid-phase (tier already
    // flipped to nursery) when we signal it.
    runDelayMs: 30000,
  });

  let stderr = '';
  try {
    const child = spawn('node', [SWEEP], { env: sweepEnv(stub.baseUrl, matrixDir), stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const exited = new Promise((resolve) => child.on('exit', (c, s) => resolve({ code: c, sig: s })));

    // Wait until the first flip landed AND the (blocking) run request arrived.
    const deadline = Date.now() + 20000;
    const flipped = () => stub.log.some((r) => r.method === 'POST' && r.path === '/api/admin/settings/capabilities');
    const runStarted = () => stub.log.some((r) => r.method === 'POST' && r.path === '/api/admin/tool-conformance/run');
    while ((!flipped() || !runStarted()) && Date.now() < deadline) await sleep(50);
    if (!flipped() || !runStarted()) {
      child.kill('SIGKILL');
      throw new Error(`[${signal}] sweep never reached mid-run; stderr:\n${stderr}`);
    }
    check(stub.getState().tier === 'nursery', `tier was flipped to 'nursery' before the signal (got '${stub.getState().tier}')`);

    child.kill(signal);
    const result = await Promise.race([exited, sleep(20000).then(() => ({ code: 'timeout' }))]);
    if (result.code === 'timeout') {
      child.kill('SIGKILL');
      throw new Error(`[${signal}] sweep did not exit after ${signal}; stderr:\n${stderr}`);
    }

    const finalState = stub.getState();
    check(finalState.tier === original, `pre-sweep tier '${original}' restored after ${signal} (got '${finalState.tier}')`);
    check(new RegExp(`received ${signal}`).test(stderr), `sweep logged the ${signal} restore path`);
    check(/capability tier restored/.test(stderr), 'restore confirmed via the settings API');
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const companionId = '22222222-2222-4222-8222-222222222222';
  const resolved = resolveTarget({
    PSFN_TARGET: 'kube',
    PSFN_API_BASE: 'http://127.0.0.1:10053',
    PSFN_ADMIN_BASE: 'http://127.0.0.1:10054',
    TESTING_HARNESS_API_KEY: ADMIN_TOKEN,
    POSTGRES_DATABASE_URL: 'postgres://unused',
    COMPANION_ID: companionId,
  });
  check(
    resolved.adminBaseUrl
      === `http://127.0.0.1:10053/companions/${companionId}/garden`,
    'kube Garden APIs resolve through the gateway unified origin',
  );
  check(
    resolved.adminHealthBaseUrl === 'http://127.0.0.1:10054',
    'kube Garden health retains its direct public origin',
  );
  check(
    resolved.adminToken === ADMIN_TOKEN,
    'kube Garden APIs use the testing-harness key without ADMIN_TOKEN',
  );
  await testNormalExit();
  await testSignalRestore('SIGINT');
  await testSignalRestore('SIGTERM');

  if (failures.length > 0) {
    console.error(`\nTest D FAILED: ${failures.length} assertion(s) failed.`);
    process.exit(1);
  }
  console.log('\nTest D PASSED: the conformance sweep flips all tiers, restores on exit + signals, and counts ok:false correctly.');
}

main().catch((error) => {
  console.error(`Test D ERROR: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
