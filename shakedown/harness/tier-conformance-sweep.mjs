#!/usr/bin/env node
// Kube 3-tier tool-conformance sweep — a repeatable, committed version of the
// ad-hoc probe that was run against Artie (ARTEMIS, the test companion) on the
// k3d cluster on 2026-07-17 and then thrown away. It flips the LIVE capability
// tier through nursery -> apprentice -> autonomous, triggers the Garden
// tool-conformance sweep at each tier, captures the per-tier result JSON, and
// GUARANTEES the pre-sweep tier is restored on any exit (normal, error,
// SIGINT/SIGTERM). See shakedown/harness/README.md
// ("Running the kube tier-conformance sweep") for the full runbook.
//
// TIER-INSENSITIVE CAVEAT (important): the default Garden tool-conformance sweep
// probes only SAFE READS and schema shapes (probeKind: read_only / schema_only /
// rejection_check). It does NOT attempt gated actions, so the results are
// EXPECTED to be identical across all three tiers — this probe does NOT certify
// capability GATING. It certifies that the tool-conformance surface stays healthy
// while the tier is flipped live, and that the live tier-flip + restore contract
// works end to end. Real capability-gate certification (does nursery actually
// deny an action that autonomous allows?) is bead 65rk.6, NOT this probe.
//
// Contract reuse (single source of truth): the tier flip, its confirm poll, and
// the fail-closed env/target resolution all come from lib/target.mjs +
// lib/env.mjs. This script owns only the conformance-run orchestration and the
// signal-safe restore. It NEVER edits capability-tier.json on the PVC and NEVER
// uses the rejected PATCH /api/admin/settings {capabilityTier} route.
//
// Fail-closed: every required value is read from the sourced shakedown env and a
// missing one exits non-zero naming it. No path/URL defaults point outside the
// env. A failed restore is a loud FATAL naming the tier to hand-restore and the
// durable record to read it from.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  requireEnvOneOf,
  optionalIntEnv,
  MissingEnvError,
  InvalidEnvError,
  failClosedOnEnv,
} from './lib/env.mjs';
import {
  resolveTarget,
  fetchCurrentTier,
  setTierAndConfirm,
} from './lib/target.mjs';

// The three capability tiers, swept low -> high, exactly as the throwaway probe.
const TIERS = ['nursery', 'apprentice', 'autonomous'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  process.stderr.write(`${message}\n`);
}

function toolConformanceUrl(adminBaseUrl, leaf) {
  return `${adminBaseUrl}/api/admin/tool-conformance/${leaf}`;
}

function bearer(adminToken) {
  return { Authorization: `Bearer ${adminToken}` };
}

/**
 * POST /api/admin/tool-conformance/run to trigger a fresh conformance sweep at
 * the currently-live tier. Non-2xx is a hard, named error — a run we cannot
 * confirm triggered must not be summarized as if it did.
 */
async function triggerConformanceRun({ adminBaseUrl, adminToken }, timeoutMs) {
  const url = toolConformanceUrl(adminBaseUrl, 'run');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let rawText;
  try {
    response = await fetch(url, { method: 'POST', headers: bearer(adminToken), signal: controller.signal });
    rawText = await response.text();
  } catch (error) {
    throw new Error(`POST ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`POST ${url} returned HTTP ${response.status}: ${rawText.slice(0, 400)}`);
  }
}

/**
 * GET /api/admin/tool-conformance/latest and parse it. Throws loudly on any
 * transport/shape failure so a broken read never drives a summary.
 */
async function fetchConformanceLatest({ adminBaseUrl, adminToken }, timeoutMs) {
  const url = toolConformanceUrl(adminBaseUrl, 'latest');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let rawText;
  try {
    response = await fetch(url, { headers: bearer(adminToken), signal: controller.signal });
    rawText = await response.text();
  } catch (error) {
    throw new Error(`GET ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`GET ${url} returned HTTP ${response.status}: ${rawText.slice(0, 400)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`GET ${url} returned non-JSON body: ${rawText.slice(0, 400)}`);
  }
  if (!parsed || !Array.isArray(parsed.results)) {
    throw new Error(`GET ${url} response is missing a results[] array`);
  }
  return parsed;
}

/**
 * Summarize a /latest payload. CORRECT parsing (the throwaway probe had a bug):
 * each entry is {toolName, probeKind, ok, durationMs}; classification/error are
 * present ONLY on failures and action only on some. A failure is `ok === false`
 * — NOT a `.tool`/`.classification` truthiness check, which the old script used
 * and which silently miscounted (e.g. it keyed off `x.classification` and
 * `x.tool`, neither of which exists on the success entries or is the failure
 * signal). We key strictly off `ok === false`.
 */
function summarizeConformance(latest) {
  const results = latest.results;
  const failures = results.filter((entry) => entry?.ok === false);
  const lines = failures.map((entry) => {
    const action = typeof entry.action === 'string' && entry.action.length > 0 ? entry.action : '-';
    const classification = typeof entry.classification === 'string' && entry.classification.length > 0
      ? entry.classification
      : 'unclassified';
    const error = typeof entry.error === 'string' && entry.error.length > 0 ? ` (${entry.error})` : '';
    return `${entry.toolName}/${action} -> ${classification}${error}`;
  });
  return { total: results.length, failed: failures.length, lines };
}

// --- Signal-safe, idempotent restore --------------------------------------
// Mirrors the run-live-shakedown-matrix.sh trap contract, in-process: the
// pre-sweep tier is captured up front and put back exactly once on EXIT, INT, or
// TERM. `restoreInProgress` dedupes concurrent callers (the finally block AND an
// interleaved signal), and `restored` short-circuits after a confirmed read-back.
// A restore that never confirms after the bounded retry budget is a loud FATAL
// naming the tier and the durable recovery record, then exit(1).
function makeRestorer(contract, originalTier, originalTierFile, maxAttempts, retryDelayMs) {
  let restored = false;
  let restoreInProgress = null;

  async function attemptRestore() {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const confirmed = await setTierAndConfirm({
          adminBaseUrl: contract.adminBaseUrl,
          adminToken: contract.adminToken,
          tier: originalTier,
          confirmTimeoutMs: contract.tierFlipConfirmTimeoutMs,
          pollMs: contract.tierFlipPollMs,
        });
        if (confirmed === originalTier) {
          restored = true;
          log(`[restore] capability tier restored to '${confirmed}' and confirmed via the settings API `
            + `(attempt ${attempt}/${maxAttempts}).`);
          return;
        }
        log(`[restore] WARN attempt ${attempt}/${maxAttempts}: read-back reported '${confirmed}', `
          + `expected '${originalTier}'; retrying in ${retryDelayMs}ms...`);
      } catch (error) {
        log(`[restore] WARN attempt ${attempt}/${maxAttempts} failed: `
          + `${error instanceof Error ? error.message : String(error)}; retrying in ${retryDelayMs}ms...`);
      }
      if (attempt < maxAttempts) await sleep(retryDelayMs);
    }
    log(`[restore] FATAL: capability tier restore to '${originalTier}' failed after ${maxAttempts} attempts. `
      + `Recover manually: PSFN_TARGET=kube (…env…) node shakedown/harness/lib/target.mjs set-tier `
      + `"$(cat '${originalTierFile}')"`);
    process.exit(1);
  }

  return function restoreOriginalTier() {
    if (restored) return Promise.resolve();
    if (restoreInProgress) return restoreInProgress;
    restoreInProgress = attemptRestore();
    return restoreInProgress;
  };
}

async function main() {
  const contract = resolveTarget();
  // Output root: reuse PSFN_MATRIX_DIR (the sweep's round dir) or the documented
  // PSFN_ROUND_DIR alias. Fail closed on neither being set — no cwd/tmp default.
  const outDir = requireEnvOneOf(
    ['PSFN_ROUND_DIR', 'PSFN_MATRIX_DIR'],
    'output directory for the per-tier conformance result JSONs',
  );
  const runTimeoutMs = optionalIntEnv('PSFN_CONFORMANCE_RUN_TIMEOUT_MS', 60000);
  const latestTimeoutMs = optionalIntEnv('PSFN_CONFORMANCE_LATEST_TIMEOUT_MS', 15000);
  // Small settle delay between triggering a run and reading /latest, so the
  // persisted result reflects the run we just triggered.
  const settleMs = optionalIntEnv('PSFN_CONFORMANCE_SETTLE_MS', 2000);
  const restoreMaxAttempts = optionalIntEnv('PSFN_TIER_RESTORE_MAX_ATTEMPTS', 5);
  const restoreRetryDelayMs = optionalIntEnv('PSFN_TIER_RESTORE_RETRY_DELAY_MS', 2000);

  mkdirSync(outDir, { recursive: true });

  // --- Capture the pre-sweep tier BEFORE any flip and record it durably. -----
  const originalTier = await fetchCurrentTier(contract);
  const originalTierFile = process.env.PSFN_ORIGINAL_TIER_FILE?.trim()
    ? process.env.PSFN_ORIGINAL_TIER_FILE.trim()
    : join(outDir, 'original-capability-tier');
  mkdirSync(dirname(originalTierFile), { recursive: true });
  writeFileSync(originalTierFile, `${originalTier}\n`);
  log(`[sweep] pre-sweep capability tier is '${originalTier}' (durable record: ${originalTierFile}).`);

  const restoreOriginalTier = makeRestorer(
    contract,
    originalTier,
    originalTierFile,
    restoreMaxAttempts,
    restoreRetryDelayMs,
  );

  // Install signal handlers up front so an interrupt at ANY point after the
  // durable record exists restores the tier before the process dies.
  let signalHandling = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (signalHandling) return;
      signalHandling = true;
      log(`[sweep] received ${signal}; restoring pre-sweep tier before exit...`);
      restoreOriginalTier()
        .then(() => process.exit(signal === 'SIGINT' ? 130 : 143))
        .catch((error) => {
          log(`[restore] FATAL during ${signal} restore: ${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        });
    });
  }

  const summaries = [];
  try {
    for (const tier of TIERS) {
      log(`\n=== FLIP -> ${tier} ===`);
      await setTierAndConfirm({
        adminBaseUrl: contract.adminBaseUrl,
        adminToken: contract.adminToken,
        tier,
        confirmTimeoutMs: contract.tierFlipConfirmTimeoutMs,
        pollMs: contract.tierFlipPollMs,
      });
      await triggerConformanceRun(contract, runTimeoutMs);
      if (settleMs > 0) await sleep(settleMs);
      const latest = await fetchConformanceLatest(contract, latestTimeoutMs);

      const outPath = join(outDir, `tool-conformance.${tier}.json`);
      writeFileSync(outPath, JSON.stringify(latest, null, 2));

      const summary = summarizeConformance(latest);
      summaries.push({ tier, ...summary });
      log(`[${tier}] total=${summary.total} ok:false=${summary.failed} -> ${outPath}`);
      for (const line of summary.lines) log(`   ${line}`);
    }
  } finally {
    // Restore on ANY exit from the sweep body — success, thrown error, or a
    // signal that raced past the handler. Idempotent, so a double call is safe.
    await restoreOriginalTier();
  }

  // --- Overall note ----------------------------------------------------------
  log('\n=== sweep complete ===');
  for (const s of summaries) log(`  ${s.tier}: total=${s.total} ok:false=${s.failed}`);
  log('\nNOTE: this probe is TIER-INSENSITIVE for capability GATING. The default '
    + 'tool-conformance sweep probes only safe reads/schemas and never attempts '
    + 'gated actions, so identical results across tiers is EXPECTED and is NOT '
    + 'evidence of a gating bug. Real capability-gate certification is bead 65rk.6, '
    + 'not this probe. What this DID prove: the live tier-flip + confirmed restore '
    + 'contract works, and the conformance surface stays healthy across flips.');
}

main().catch((error) => {
  if (error instanceof MissingEnvError || error instanceof InvalidEnvError) {
    failClosedOnEnv(error);
    return;
  }
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
