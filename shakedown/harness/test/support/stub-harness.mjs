#!/usr/bin/env node
// Stub of live-system-shakedown.mjs for the shell-level tests. It records that a
// phase actually RAN (with the tier that was live when it ran) and writes a
// valid, completed run JSON, then optionally sleeps so a test can signal the
// sweep mid-phase.
//
// The presence of a phase line in STUB_HARNESS_RANLOG is the decisive signal for
// the flip-abort test: if a forward flip failed but cases still ran, this file
// records it.
//
// Env:
//   PSFN_SHAKEDOWN_OUTPUT (required) — where to write the run JSON
//   PSFN_SHAKEDOWN_PHASE  (optional) — phase label, recorded
//   STUB_HARNESS_RANLOG   (required) — append-only "ran" log
//   STUB_STATE_FILE       (optional) — current tier, recorded alongside the phase
//   STUB_HARNESS_SLEEP_MS (optional) — sleep this long before exiting (0 = none)
//   STUB_HARNESS_READY     (optional) — touch this file just before sleeping
//   STUB_HARNESS_CASE_STATUS (optional) — emitted case status (default: ok)
//   STUB_HARNESS_FAILURE_REASON (optional) — emitted named case failure reason

import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function env(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

const output = env('PSFN_SHAKEDOWN_OUTPUT');
if (!output) {
  process.stderr.write('stub-harness: PSFN_SHAKEDOWN_OUTPUT is required\n');
  process.exit(1);
}
const ranLog = env('STUB_HARNESS_RANLOG');
if (!ranLog) {
  process.stderr.write('stub-harness: STUB_HARNESS_RANLOG is required\n');
  process.exit(1);
}

const phase = env('PSFN_SHAKEDOWN_PHASE') ?? 'unknown';
const caseStatus = env('STUB_HARNESS_CASE_STATUS') ?? 'ok';
const failureReason = env('STUB_HARNESS_FAILURE_REASON');
const stateFile = env('STUB_STATE_FILE');
let liveTier = 'unknown';
if (stateFile) {
  try { liveTier = readFileSync(stateFile, 'utf8').trim(); } catch { liveTier = 'unreadable'; }
}
appendFileSync(ranLog, `ran phase=${phase} tier=${liveTier}\n`);

mkdirSync(dirname(output), { recursive: true });
const payload = {
  generatedAt: new Date().toISOString(),
  completed: true,
  harnessStatus: 'ok',
  phase,
  results: [{
    caseId: 'stub_case',
    caseStatus,
    ...(failureReason ? { failureReason } : {}),
  }],
};
writeFileSync(output, JSON.stringify(payload, null, 2));

const sleepMs = Number.parseInt(env('STUB_HARNESS_SLEEP_MS') ?? '0', 10);
if (Number.isFinite(sleepMs) && sleepMs > 0) {
  const ready = env('STUB_HARNESS_READY');
  if (ready) writeFileSync(ready, 'ready');
  // Stay alive so the test can deliver a signal to the sweep's process group.
  setTimeout(() => process.exit(0), sleepMs);
} else {
  process.exit(0);
}
