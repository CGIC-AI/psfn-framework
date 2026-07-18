#!/usr/bin/env node
// 65rk.8 — scorecard profile stamping + lite attestation gate.
//
// Drives the REAL shakedown-scorecard.mjs as a child process over fixture tier
// run JSONs, a fixture coverage appendix (uncovered surfaces), and the real lite
// manifest. Proves:
//   * lite + all attestations present  -> GREEN, profile:lite stamped, the
//     coverage-appendix completeness cross-check is skipped.
//   * lite + a missing attestation     -> RED (fail closed), profile:lite stamped,
//     the cross-check stays enforced.
//   * full / unset                     -> RED on the same uncovered fixture,
//     with NO profile stamp and NO lite markers.
//   * full == unset, byte-for-byte     -> PSFN_PROFILE=full is identical to unset
//     after normalizing the dynamic generatedAt (full gains no behavior change).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = join(HERE, '..');
const SCORECARD = join(HARNESS_DIR, 'shakedown-scorecard.mjs');
const MANIFEST = join(HARNESS_DIR, 'profiles', 'lite.manifest.json');

// Fixture coverage appendix with two in-scope surfaces and NO mapped cases, so a
// full run is RED (uncovered) while a complete lite run skips the cross-check.
const DOC_FIXTURE = `# Fixture shakedown doc

### In scope — fixture surfaces

| Surface | Lane / tier | How exercised | Notes |
| --- | --- | --- | --- |
| Fixture surface one | local, all tiers | harness | fixture |
| Fixture surface two | kube only | partner walk | fixture |
`;

const COVERAGE_MAP_FIXTURE = JSON.stringify({ surfaces: {} });

function tierArtifact(tier, {
  conformance = true,
  matrixOk = true,
  coverageIds = true,
  matches = true,
  completed,
  harnessStatus,
} = {}) {
  const art = {
    generatedAt: '2026-07-18T00:00:00.000Z',
    target: 'kube',
    phase: tier === 'autonomous' ? 'autonomous' : 'coverage',
    coverageCaseIds: coverageIds
      ? ['capability_refusal_matrix', 'tier_tool_conformance']
      : ['capability_refusal_matrix'],
    tierToolConformance: conformance
      ? { caseId: 'tier_tool_conformance', expectedTier: tier, responseValid: true, matches }
      : null,
    initialStats: {},
    results: [
      { caseId: 'capability_refusal_matrix', caseStatus: matrixOk ? 'ok' : 'semantic_failure' },
      { caseId: 'l0_baseline', caseStatus: 'ok' },
    ],
  };
  if (completed !== undefined) art.completed = completed;
  if (harnessStatus !== undefined) art.harnessStatus = harnessStatus;
  return art;
}

function runScorecard(dir, { profile, artifacts }) {
  const inputs = [];
  for (const [tier, art] of Object.entries(artifacts)) {
    const p = join(dir, `live-system-shakedown.${tier}.json`);
    writeFileSync(p, JSON.stringify(art, null, 2));
    inputs.push(p);
  }
  const docPath = join(dir, 'doc.md');
  const coverageMapPath = join(dir, 'coverage-map.json');
  writeFileSync(docPath, DOC_FIXTURE);
  writeFileSync(coverageMapPath, COVERAGE_MAP_FIXTURE);
  const jsonOut = join(dir, `scorecard.${profile ?? 'none'}.json`);
  const mdOut = join(dir, `scorecard.${profile ?? 'none'}.md`);

  const env = {
    ...process.env,
    PSFN_SCORECARD_INPUTS: inputs.join(','),
    PSFN_SCORECARD_JSON: jsonOut,
    PSFN_SCORECARD_MD: mdOut,
    PSFN_SHAKEDOWN_DOC: docPath,
    PSFN_COVERAGE_MAP: coverageMapPath,
    PSFN_PROFILE_MANIFEST: MANIFEST,
  };
  if (profile === undefined) {
    delete env.PSFN_PROFILE;
  } else {
    env.PSFN_PROFILE = profile;
  }
  const proc = spawnSync('node', [SCORECARD], { env, encoding: 'utf8' });
  return {
    code: proc.status,
    json: JSON.parse(readFileSync(jsonOut, 'utf8')),
    md: readFileSync(mdOut, 'utf8'),
  };
}

const allThree = () => ({
  nursery: tierArtifact('nursery'),
  apprentice: tierArtifact('apprentice'),
  autonomous: tierArtifact('autonomous'),
});

function normalizeJson(obj) {
  const clone = JSON.parse(JSON.stringify(obj));
  clone.generatedAt = '<normalized>';
  return clone;
}

function normalizeMd(md) {
  return md.replace(/^Generated: .*/m, 'Generated: <normalized>');
}

// --- A: lite complete -> green, stamped, cross-check skipped ------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'sc-lite-ok-'));
  try {
    const { code, json, md } = runScorecard(dir, { profile: 'lite', artifacts: allThree() });
    assert.equal(code, 0, 'lite with all attestations present exits 0 (green)');
    assert.equal(json.profile, 'lite', 'lite scorecard is stamped profile:lite');
    assert.equal(json.green, true, 'lite scorecard is green');
    assert.equal(json.liteAttestation.complete, true, 'lite attestation complete');
    assert.equal(json.coverage.liteSkipped, true, 'coverage cross-check marked skipped');
    assert.equal(json.coverage.uncoveredCount, 0, 'uncovered surfaces neutralized for lite');
    assert.match(md, /\*\*Profile: lite\*\*/, 'markdown carries the lite profile stamp');
    assert.match(md, /cross-check skipped/, 'markdown notes the skipped cross-check');
    assert.match(md, /## Lite attestation/, 'markdown has the lite attestation section');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- B: lite incomplete -> red, stamped, cross-check enforced -----------------
{
  const dir = mkdtempSync(join(tmpdir(), 'sc-lite-bad-'));
  try {
    const artifacts = allThree();
    artifacts.autonomous = tierArtifact('autonomous', { conformance: false }); // drop conformance evidence
    const { code, json } = runScorecard(dir, { profile: 'lite', artifacts });
    assert.notEqual(code, 0, 'lite with a missing attestation fails closed (non-zero)');
    assert.equal(json.profile, 'lite', 'incomplete lite run is still stamped profile:lite');
    assert.equal(json.green, false, 'incomplete lite run is red');
    assert.equal(json.liteAttestation.complete, false, 'lite attestation incomplete');
    assert.notEqual(json.coverage.liteSkipped, true, 'cross-check NOT skipped when attestation incomplete');
    assert.ok(
      json.failureReasons.some((r) => r.includes('lite attestation incomplete')),
      'failure reasons name the incomplete attestation',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- B2: lite with capability matrix not green -> red -------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'sc-lite-matrix-'));
  try {
    const artifacts = allThree();
    artifacts.apprentice = tierArtifact('apprentice', { matrixOk: false });
    const { code, json } = runScorecard(dir, { profile: 'lite', artifacts });
    assert.notEqual(code, 0, 'lite with a non-green capability matrix fails closed');
    // Non-green matrix is BOTH a taxonomy failure AND an incomplete attestation.
    assert.equal(json.liteAttestation.complete, false, 'attestation incomplete when matrix not ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- B3: lite with tierToolConformance.matches:false -> red -------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'sc-lite-nomatch-'));
  try {
    const artifacts = allThree();
    // Conformance evidence is present and valid, but the grid did NOT match the
    // expected tier grant — a real tier drift that must fail the attestation.
    artifacts.autonomous = tierArtifact('autonomous', { matches: false });
    const { code, json } = runScorecard(dir, { profile: 'lite', artifacts });
    assert.notEqual(code, 0, 'lite with conformance matches:false fails closed');
    assert.equal(json.liteAttestation.complete, false, 'attestation incomplete when conformance.matches !== true');
    const autoTier = json.liteAttestation.tiers.find((t) => t.tier === 'autonomous');
    assert.equal(autoTier.conformanceMatches, false, 'autonomous tier records conformanceMatches:false');
    assert.ok(
      autoTier.missing.some((m) => /matches/i.test(m)),
      'the missing list names the matches !== true failure',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- B4: an input artifact marked completed:false forces red (lite) -----------
{
  const dir = mkdtempSync(join(tmpdir(), 'sc-lite-incomplete-'));
  try {
    const artifacts = allThree();
    artifacts.apprentice = tierArtifact('apprentice', { completed: false });
    const { code, json } = runScorecard(dir, { profile: 'lite', artifacts });
    assert.notEqual(code, 0, 'lite with a completed:false input fails closed');
    assert.equal(json.green, false, 'completed:false input forces green:false');
    assert.ok(Array.isArray(json.artifactFailures) && json.artifactFailures.length > 0,
      'artifactFailures records the incomplete input');
    assert.ok(json.failureReasons.some((r) => /completed=false/.test(r)),
      'failure reasons name the completed:false artifact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- B5: harnessStatus tool_conformance_failed forces red even for FULL --------
{
  const dir = mkdtempSync(join(tmpdir(), 'sc-full-toolfail-'));
  try {
    const artifacts = allThree();
    artifacts.autonomous = tierArtifact('autonomous', { harnessStatus: 'tool_conformance_failed' });
    const { code, json } = runScorecard(dir, { profile: undefined, artifacts });
    assert.notEqual(code, 0, 'a directly-invoked full scorecard cannot go green on a tool_conformance_failed artifact');
    assert.equal(json.green, false, 'tool_conformance_failed input forces green:false in the non-lite path');
    assert.ok(Array.isArray(json.artifactFailures) && json.artifactFailures.length > 0,
      'artifactFailures records the tool_conformance_failed input');
    assert.ok(json.failureReasons.some((r) => /tool_conformance_failed/.test(r)),
      'failure reasons name the tool_conformance_failed artifact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- C: full/unset on the same fixture -> red, no stamp, no lite markers ------
{
  const dir = mkdtempSync(join(tmpdir(), 'sc-full-'));
  try {
    const { code, json, md } = runScorecard(dir, { profile: undefined, artifacts: allThree() });
    assert.notEqual(code, 0, 'full run is RED on uncovered appendix surfaces (unchanged behavior)');
    assert.ok(!('profile' in json), 'full scorecard JSON has NO profile key');
    assert.ok(!('liteAttestation' in json), 'full scorecard JSON has NO liteAttestation key');
    assert.ok(!('liteSkipped' in json.coverage), 'full coverage has NO liteSkipped key');
    assert.equal(json.coverage.uncoveredCount, 2, 'full run reports both uncovered surfaces');
    assert.doesNotMatch(md, /Profile: lite/, 'full markdown has no lite profile stamp');
    assert.doesNotMatch(md, /Lite attestation/, 'full markdown has no lite attestation section');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- D: full == unset, byte-for-byte (proves full gains no behavior change) ---
{
  const dir = mkdtempSync(join(tmpdir(), 'sc-eq-'));
  try {
    const unset = runScorecard(dir, { profile: undefined, artifacts: allThree() });
    const full = runScorecard(dir, { profile: 'full', artifacts: allThree() });
    assert.deepEqual(
      normalizeJson(full.json),
      normalizeJson(unset.json),
      'PSFN_PROFILE=full JSON is byte-for-byte identical to unset (after generatedAt normalization)',
    );
    assert.equal(
      normalizeMd(full.md),
      normalizeMd(unset.md),
      'PSFN_PROFILE=full markdown is byte-for-byte identical to unset',
    );
    assert.equal(full.code, unset.code, 'PSFN_PROFILE=full exit code matches unset');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- E: invalid PSFN_PROFILE fails closed ------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'sc-badprofile-'));
  try {
    let threw = false;
    try {
      runScorecard(dir, { profile: 'turbo', artifacts: allThree() });
    } catch {
      threw = true; // outputs never written -> readFileSync throws
    }
    assert.ok(threw, 'an unknown PSFN_PROFILE value fails closed (no scorecard emitted)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('scorecard profile tests passed');
