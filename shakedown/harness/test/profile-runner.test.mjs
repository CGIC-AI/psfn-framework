#!/usr/bin/env node
// 65rk.8 — run-shakedown-profile.mjs (--profile lite|full).
//
// In-process unit checks (parseArgs, manifest validation, tier case-set
// composition) plus integration runs of the REAL runner against STUB matrix +
// scorecard scripts (no live cluster). Proves the load-bearing behavior:
//   * lite composes smoke-at-baseline + capability matrix at all three tiers,
//     by stable id;
//   * lite runs the preflight gates before the sweep and stamps the scorecard
//     PSFN_PROFILE=lite;
//   * the sub-hour deadline SIGTERMs the sweep so ITS trap restores the tier
//     (signal-safe), and an operator SIGINT does the same;
//   * a single explicit target is required (fail closed);
//   * full sets NO case overrides and NO PSFN_PROFILE (unchanged behavior).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../run-shakedown-profile.mjs';
import { loadProfileManifest, composeTierCaseSets } from '../lib/profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = join(HERE, '..');
const RUNNER = join(HARNESS_DIR, 'run-shakedown-profile.mjs');
const REAL_MANIFEST = join(HARNESS_DIR, 'profiles', 'lite.manifest.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(cond, message) {
  if (cond) console.log(`  ok  - ${message}`);
  else { failures.push(message); console.log(`  FAIL- ${message}`); }
}

// --- Part 1: parseArgs (fail closed) -----------------------------------------
console.log('\n[parseArgs]');
check(parseArgs(['--profile', 'lite']).profile === 'lite', 'parses --profile lite');
check(parseArgs(['--profile=full']).profile === 'full', 'parses --profile=full');
for (const bad of [[], ['--profile'], ['--profile', 'turbo'], ['--wat']]) {
  let threw = false;
  try { parseArgs(bad); } catch { threw = true; }
  check(threw, `rejects ${JSON.stringify(bad)}`);
}

// --- Part 2: manifest validation (fail closed) -------------------------------
console.log('\n[manifest validation]');
{
  const manifest = loadProfileManifest(REAL_MANIFEST);
  check(manifest.profile === 'lite', 'real manifest loads');
  check(manifest.deadlineMs < 3_600_000, 'real manifest deadline is sub-hour');
  const base = JSON.parse(readFileSync(REAL_MANIFEST, 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'manifest-'));
  const mutate = (fn) => {
    const clone = JSON.parse(JSON.stringify(base));
    fn(clone);
    const p = join(dir, `m-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify(clone));
    return p;
  };
  const rejects = [
    ['deadline >= 1h', mutate((m) => { m.deadlineMs = 3_600_000; })],
    ['deadline above max', mutate((m) => { m.deadlineMs = 3_500_001; m.maxDeadlineMs = 3_500_000; })],
    ['max above ceiling', mutate((m) => { m.maxDeadlineMs = 3_700_000; })],
    ['missing tier', mutate((m) => { m.requiredTiers = ['nursery', 'apprentice']; })],
    ['missing coverage id', mutate((m) => { m.requiredCoverageIds = ['capability_refusal_matrix']; })],
    ['empty smoke', mutate((m) => { m.smoke.caseIds = []; })],
    ['smoke includes matrix case', mutate((m) => { m.smoke.caseIds.push('capability_refusal_matrix'); })],
    ['bad smoke tier', mutate((m) => { m.smoke.tier = 'archon'; })],
    ['no gates', mutate((m) => { m.preflightGates = []; })],
    ['profile not lite', mutate((m) => { m.profile = 'full'; })],
  ];
  for (const [label, p] of rejects) {
    let threw = false;
    try { loadProfileManifest(p); } catch { threw = true; }
    check(threw, `rejects manifest: ${label}`);
  }
  let missingThrew = false;
  try { loadProfileManifest(join(dir, 'does-not-exist.json')); } catch { missingThrew = true; }
  check(missingThrew, 'rejects a missing manifest file (no silent default)');
  rmSync(dir, { recursive: true, force: true });
}

// --- Part 3: tier case-set composition (by stable id) ------------------------
console.log('\n[composeTierCaseSets]');
{
  const manifest = loadProfileManifest(REAL_MANIFEST);
  const sets = composeTierCaseSets(manifest);
  check(sets.nursery.includes('capability_refusal_matrix'), 'nursery includes capability matrix');
  check(sets.apprentice.length === 1 && sets.apprentice[0] === 'capability_refusal_matrix', 'apprentice = capability matrix only');
  check(sets.autonomous.length === 1 && sets.autonomous[0] === 'capability_refusal_matrix', 'autonomous = capability matrix only');
  check(manifest.smoke.caseIds.every((id) => sets.nursery.includes(id)), 'all smoke cases run at the baseline tier');
  check(['nursery', 'apprentice', 'autonomous'].every((t) => sets[t].filter((id) => id === 'capability_refusal_matrix').length === 1),
    'capability matrix runs at all three tiers, exactly once each');
}

// --- Integration harness: stub matrix + scorecard scripts --------------------
function writeStubs(dir, { gateExit = 0 } = {}) {
  const record = join(dir, 'record');
  mkdirSync(record, { recursive: true });
  // Stub matrix (bash). STUB_MODE=clean emits 3 tier JSONs and exits 0;
  // STUB_MODE=hang installs a TERM/INT trap that records a restore + exits 143.
  const matrix = join(dir, 'stub-matrix.sh');
  writeFileSync(matrix, `#!/usr/bin/env bash
mkdir -p "$STUB_RECORD_DIR"
printf '%s' "\${PSFN_NURSERY_CASES:-<unset>}" > "$STUB_RECORD_DIR/nursery-cases"
printf '%s' "\${PSFN_APPRENTICE_CASES:-<unset>}" > "$STUB_RECORD_DIR/apprentice-cases"
printf '%s' "\${PSFN_AUTONOMOUS_CASES:-<unset>}" > "$STUB_RECORD_DIR/autonomous-cases"
restore() { printf 'restored' > "$STUB_RECORD_DIR/restored"; exit 143; }
if [ "\${STUB_MODE:-clean}" = "hang" ]; then
  trap restore TERM INT
  printf 'apprentice' > "$PSFN_MATRIX_DIR/original-capability-tier"
  printf 'started' > "$STUB_RECORD_DIR/matrix-started"
  while true; do sleep 0.05; done
else
  for tier in nursery apprentice autonomous; do
    printf '{"phase":"coverage","results":[]}' > "$PSFN_MATRIX_DIR/live-system-shakedown.$tier.json"
  done
  printf 'ran' > "$STUB_RECORD_DIR/matrix-ran"
  exit 0
fi
`);
  chmodSync(matrix, 0o755);
  // Stub scorecard (node): record the env it was handed and exit 0.
  const scorecard = join(dir, 'stub-scorecard.mjs');
  writeFileSync(scorecard, `import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync(process.env.STUB_RECORD_DIR, { recursive: true });
writeFileSync(process.env.STUB_RECORD_DIR + '/scorecard-env.json', JSON.stringify({
  profile: process.env.PSFN_PROFILE ?? null,
  inputs: process.env.PSFN_SCORECARD_INPUTS ?? null,
  json: process.env.PSFN_SCORECARD_JSON ?? null,
}));
process.exit(0);
`);
  // Fixture manifest with harmless gate commands.
  const gateCmd = gateExit === 0
    ? ['node', '-e', "require('fs').appendFileSync(process.env.STUB_RECORD_DIR+'/gates','gate\\n')"]
    : ['node', '-e', "require('fs').appendFileSync(process.env.STUB_RECORD_DIR+'/gates','gate\\n');process.exit(3)"];
  const base = JSON.parse(readFileSync(REAL_MANIFEST, 'utf8'));
  base.preflightGates = [{ id: 'stub-gate', command: gateCmd }];
  const manifest = join(dir, 'lite.manifest.json');
  writeFileSync(manifest, JSON.stringify(base));
  return { matrix, scorecard, manifest, record };
}

function runnerEnv(dir, stubs, overrides = {}) {
  return {
    ...process.env,
    PSFN_MATRIX_SCRIPT: stubs.matrix,
    PSFN_SCORECARD_SCRIPT: stubs.scorecard,
    PSFN_PROFILE_MANIFEST: stubs.manifest,
    PSFN_MATRIX_DIR: join(dir, 'matrix'),
    STUB_RECORD_DIR: stubs.record,
    PSFN_TARGET: 'kube',
    ...overrides,
  };
}

function spawnRunner(profile, env) {
  const child = spawn('node', [RUNNER, '--profile', profile], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, stderr: () => stderr };
}

// --- Part 4: clean lite run --------------------------------------------------
console.log('\n[lite clean run]');
{
  const dir = mkdtempSync(join(tmpdir(), 'runner-lite-'));
  try {
    const stubs = writeStubs(dir);
    const env = runnerEnv(dir, stubs, { STUB_MODE: 'clean' });
    const { exited } = spawnRunner('lite', env);
    const { code } = await exited;
    check(code === 0, `clean lite run exits 0 (got ${code})`);
    check(existsSync(join(stubs.record, 'gates')), 'preflight gate ran');
    check(existsSync(join(stubs.record, 'matrix-ran')), 'matrix sweep ran');
    const nursery = readFileSync(join(stubs.record, 'nursery-cases'), 'utf8');
    check(nursery.includes('capability_refusal_matrix') && nursery.includes('l0_baseline'),
      'nursery case set = smoke subset + capability matrix');
    check(readFileSync(join(stubs.record, 'apprentice-cases'), 'utf8') === 'capability_refusal_matrix',
      'apprentice case set = capability matrix only');
    check(readFileSync(join(stubs.record, 'autonomous-cases'), 'utf8') === 'capability_refusal_matrix',
      'autonomous case set = capability matrix only');
    const scEnv = JSON.parse(readFileSync(join(stubs.record, 'scorecard-env.json'), 'utf8'));
    check(scEnv.profile === 'lite', 'scorecard invoked with PSFN_PROFILE=lite');
    check((scEnv.inputs || '').split(',').length === 3, 'scorecard handed the three tier run JSONs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Part 5: gate failure aborts before the sweep ----------------------------
console.log('\n[lite gate failure]');
{
  const dir = mkdtempSync(join(tmpdir(), 'runner-gatefail-'));
  try {
    const stubs = writeStubs(dir, { gateExit: 3 });
    const env = runnerEnv(dir, stubs, { STUB_MODE: 'clean' });
    const { exited } = spawnRunner('lite', env);
    const { code } = await exited;
    check(code !== 0, `a red preflight gate fails the run (got ${code})`);
    check(!existsSync(join(stubs.record, 'matrix-ran')), 'matrix sweep never ran after a red gate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Part 6: deadline -> SIGTERM -> signal-safe tier restore -----------------
console.log('\n[lite deadline restore]');
{
  const dir = mkdtempSync(join(tmpdir(), 'runner-deadline-'));
  try {
    const stubs = writeStubs(dir);
    const env = runnerEnv(dir, stubs, { STUB_MODE: 'hang', PSFN_LITE_DEADLINE_MS: '400', PSFN_LITE_RESTORE_GRACE_MS: '5000' });
    const { exited, stderr } = spawnRunner('lite', env);
    const { code } = await exited;
    check(code !== 0, `deadline-hit lite run exits non-zero (got ${code})`);
    check(existsSync(join(stubs.record, 'restored')), 'matrix sweep restored the tier via its trap on deadline SIGTERM');
    check(/deadline/i.test(stderr()), 'stderr names the deadline');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Part 7: operator SIGINT -> forwarded SIGTERM -> restore -----------------
console.log('\n[lite SIGINT restore]');
{
  const dir = mkdtempSync(join(tmpdir(), 'runner-sigint-'));
  try {
    const stubs = writeStubs(dir);
    const env = runnerEnv(dir, stubs, { STUB_MODE: 'hang', PSFN_LITE_DEADLINE_MS: '60000', PSFN_LITE_RESTORE_GRACE_MS: '5000' });
    const { child, exited, stderr } = spawnRunner('lite', env);
    const deadline = Date.now() + 15000;
    while (!existsSync(join(stubs.record, 'matrix-started')) && Date.now() < deadline) await sleep(30);
    check(existsSync(join(stubs.record, 'matrix-started')), 'matrix sweep started before the signal');
    child.kill('SIGINT');
    const { code } = await Promise.race([exited, sleep(15000).then(() => ({ code: 'timeout' }))]);
    check(code !== 'timeout' && code !== 0, `runner exits non-zero after SIGINT (got ${code})`);
    check(existsSync(join(stubs.record, 'restored')), 'matrix sweep restored the tier after forwarded SIGTERM');
    check(/SIGINT/.test(stderr()), 'stderr records the forwarded SIGINT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Part 8: single-target fail-closed ---------------------------------------
console.log('\n[lite target fail-closed]');
{
  const dir = mkdtempSync(join(tmpdir(), 'runner-target-'));
  try {
    const stubs = writeStubs(dir);
    const env = runnerEnv(dir, stubs, { STUB_MODE: 'clean', PSFN_TARGET: '' });
    const { exited, stderr } = spawnRunner('lite', env);
    const { code } = await exited;
    check(code !== 0, 'lite with no explicit target fails closed');
    check(/PSFN_TARGET/.test(stderr()), 'stderr names PSFN_TARGET');
    check(!existsSync(join(stubs.record, 'matrix-ran')), 'sweep never ran without a target');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Part 9: full run sets no overrides and no profile stamp ------------------
console.log('\n[full run]');
{
  const dir = mkdtempSync(join(tmpdir(), 'runner-full-'));
  try {
    const stubs = writeStubs(dir);
    const env = runnerEnv(dir, stubs, {
      STUB_MODE: 'clean',
      PSFN_SCORECARD_JSON: join(dir, 'sc.json'),
      PSFN_SCORECARD_MD: join(dir, 'sc.md'),
    });
    const { exited } = spawnRunner('full', env);
    const { code } = await exited;
    check(code === 0, `clean full run exits 0 (got ${code})`);
    check(readFileSync(join(stubs.record, 'nursery-cases'), 'utf8') === '<unset>', 'full run sets NO case overrides');
    const scEnv = JSON.parse(readFileSync(join(stubs.record, 'scorecard-env.json'), 'utf8'));
    check(scEnv.profile === null, 'full run leaves PSFN_PROFILE unset (no stamp)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(`\nprofile runner tests FAILED: ${failures.length} assertion(s).`);
  process.exit(1);
}
console.log('\nprofile runner tests passed');
