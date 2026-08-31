// Shakedown profile support (65rk.8) — the LITE profile is a THIN wrapper around
// the existing matrix sweep + scorecard, so this module holds only the two
// pieces both entrypoints share:
//
//   1. loadProfileManifest — parse + fail-closed validate the declarative lite
//      manifest (shakedown/harness/profiles/lite.manifest.json). A missing file
//      or a missing/invalid field is a hard error, never a silent default.
//   2. composeTierCaseSets — turn the manifest's smoke subset + capability-matrix
//      case id into the per-tier PSFN_*_CASES sets the matrix script consumes,
//      selecting by STABLE case id (never catalog position).
//   3. computeLiteAttestation — over the executed per-tier run JSONs, prove the
//      lite attestations are present at ALL required tiers: the capability-gate
//      matrix case ran green, the stable coverage ids are stamped, and the tier
//      tool-conformance evidence was collected. Only when every attestation is
//      present may the scorecard skip the coverage-appendix completeness
//      cross-check; a missing attestation fails closed.
//
// Fail-closed everywhere: no fallback manifest, no coercion of malformed input.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { optionalEnv, InvalidEnvError } from './env.mjs';

const HARNESS_DIR = fileURLToPath(new URL('..', import.meta.url));
export const LITE_MANIFEST_DEFAULT = join(HARNESS_DIR, 'profiles', 'lite.manifest.json');

const VALID_TIERS = ['nursery', 'apprentice', 'autonomous'];
const HARD_DEADLINE_CEILING_MS = 3_600_000; // sub-hour acceptance floor for lite.

export class ProfileManifestError extends Error {
  constructor(message) {
    super(`Invalid shakedown profile manifest: ${message}`);
    this.name = 'ProfileManifestError';
  }
}

/**
 * Resolve the requested scorecard profile from PSFN_PROFILE. Returns 'lite' only
 * for an explicit lite request; unset and 'full' both return null so the full
 * scorecard path is byte-for-byte unchanged (it gains no profile stamp). Any
 * other value is a fail-closed InvalidEnvError.
 */
export function resolveScorecardProfile(env = process.env) {
  const raw = env.PSFN_PROFILE;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const value = raw.trim().toLowerCase();
  if (value === 'lite') return 'lite';
  if (value === 'full') return null;
  throw new InvalidEnvError('PSFN_PROFILE', `expected 'lite' or 'full', got ${JSON.stringify(raw)}`);
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProfileManifestError(`${label} must be a non-empty array`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new ProfileManifestError(`${label} must contain only non-empty strings`);
    }
  }
  return value.map((entry) => entry.trim());
}

/** Load + fail-closed validate the lite manifest. Path resolution: explicit arg,
 *  then PSFN_PROFILE_MANIFEST, then the in-repo default. */
export function loadProfileManifest(manifestPath) {
  const path = manifestPath ?? optionalEnv('PSFN_PROFILE_MANIFEST') ?? LITE_MANIFEST_DEFAULT;
  if (!existsSync(path)) {
    throw new ProfileManifestError(`manifest file not found: ${path}`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ProfileManifestError(`manifest ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProfileManifestError(`manifest ${path} must be a JSON object`);
  }
  if (raw.profile !== 'lite') {
    throw new ProfileManifestError(`manifest.profile must be "lite", got ${JSON.stringify(raw.profile)}`);
  }

  const requiredTiers = requireStringArray(raw.requiredTiers, 'requiredTiers');
  for (const tier of requiredTiers) {
    if (!VALID_TIERS.includes(tier)) {
      throw new ProfileManifestError(`requiredTiers has unknown tier ${JSON.stringify(tier)} (expected one of ${VALID_TIERS.join(', ')})`);
    }
  }
  for (const tier of VALID_TIERS) {
    if (!requiredTiers.includes(tier)) {
      throw new ProfileManifestError(`requiredTiers must cover all three tiers; missing ${JSON.stringify(tier)}`);
    }
  }

  const requiredCoverageIds = requireStringArray(raw.requiredCoverageIds, 'requiredCoverageIds');
  for (const id of ['capability_refusal_matrix', 'tier_tool_conformance']) {
    if (!requiredCoverageIds.includes(id)) {
      throw new ProfileManifestError(`requiredCoverageIds must include the stable coverage id ${JSON.stringify(id)}`);
    }
  }

  const capabilityMatrixCaseId = raw.capabilityMatrixCaseId;
  if (typeof capabilityMatrixCaseId !== 'string' || capabilityMatrixCaseId.trim().length === 0) {
    throw new ProfileManifestError('capabilityMatrixCaseId must be a non-empty string');
  }
  if (!requiredCoverageIds.includes(capabilityMatrixCaseId.trim())) {
    throw new ProfileManifestError('capabilityMatrixCaseId must appear in requiredCoverageIds');
  }

  const smoke = raw.smoke;
  if (!smoke || typeof smoke !== 'object' || Array.isArray(smoke)) {
    throw new ProfileManifestError('smoke must be an object');
  }
  if (typeof smoke.tier !== 'string' || !requiredTiers.includes(smoke.tier)) {
    throw new ProfileManifestError(`smoke.tier must be one of the required tiers, got ${JSON.stringify(smoke.tier)}`);
  }
  const smokeCaseIds = requireStringArray(smoke.caseIds, 'smoke.caseIds');
  if (smokeCaseIds.includes(capabilityMatrixCaseId.trim())) {
    throw new ProfileManifestError('smoke.caseIds must not list capabilityMatrixCaseId (the runner appends it to every tier)');
  }

  const maxDeadlineMs = normalizePositiveInt(raw.maxDeadlineMs ?? HARD_DEADLINE_CEILING_MS, 'maxDeadlineMs');
  if (maxDeadlineMs > HARD_DEADLINE_CEILING_MS) {
    throw new ProfileManifestError(`maxDeadlineMs ${maxDeadlineMs} exceeds the sub-hour ceiling ${HARD_DEADLINE_CEILING_MS}`);
  }
  const deadlineMs = normalizePositiveInt(raw.deadlineMs, 'deadlineMs');
  if (deadlineMs >= HARD_DEADLINE_CEILING_MS) {
    throw new ProfileManifestError(`deadlineMs ${deadlineMs} must be under the sub-hour ceiling ${HARD_DEADLINE_CEILING_MS}`);
  }
  if (deadlineMs > maxDeadlineMs) {
    throw new ProfileManifestError(`deadlineMs ${deadlineMs} exceeds maxDeadlineMs ${maxDeadlineMs}`);
  }

  const preflightGates = validatePreflightGates(raw.preflightGates);

  return {
    path,
    profile: 'lite',
    version: typeof raw.version === 'number' ? raw.version : null,
    description: typeof raw.description === 'string' ? raw.description : '',
    deadlineMs,
    maxDeadlineMs,
    requiredTiers,
    requiredCoverageIds,
    capabilityMatrixCaseId: capabilityMatrixCaseId.trim(),
    smoke: { tier: smoke.tier, caseIds: smokeCaseIds },
    preflightGates,
  };
}

function normalizePositiveInt(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ProfileManifestError(`${label} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function validatePreflightGates(gates) {
  if (!Array.isArray(gates) || gates.length === 0) {
    throw new ProfileManifestError('preflightGates must be a non-empty array');
  }
  return gates.map((gate, index) => {
    if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
      throw new ProfileManifestError(`preflightGates[${index}] must be an object`);
    }
    if (typeof gate.id !== 'string' || gate.id.trim().length === 0) {
      throw new ProfileManifestError(`preflightGates[${index}].id must be a non-empty string`);
    }
    const command = requireStringArray(gate.command, `preflightGates[${index}].command`);
    return { id: gate.id.trim(), command };
  });
}

/**
 * Compose the per-tier case-id sets from the manifest. The smoke subset runs at
 * exactly one tier (manifest.smoke.tier); the capability-gate matrix case runs at
 * EVERY required tier so its refusal grid + tier tool-conformance evidence are
 * collected at all three. Selection is by stable id only.
 */
export function composeTierCaseSets(manifest) {
  const sets = {};
  for (const tier of manifest.requiredTiers) {
    const ids = tier === manifest.smoke.tier ? [...manifest.smoke.caseIds] : [];
    ids.push(manifest.capabilityMatrixCaseId);
    sets[tier] = ids;
  }
  return sets;
}

function deriveCaseStatus(result) {
  if (typeof result?.caseStatus === 'string' && result.caseStatus.trim()) {
    return result.caseStatus.trim();
  }
  return 'unknown';
}

/**
 * Attest a single per-tier run JSON for the lite profile. Present == the
 * capability-gate matrix case ran green, both stable coverage ids are stamped in
 * coverageCaseIds, and the tier tool-conformance evidence was collected for this
 * exact tier with a valid response.
 */
function attestTierArtifact(tier, data, manifest) {
  const missing = [];
  const results = Array.isArray(data?.results) ? data.results : [];
  const matrixCase = results.find((entry) => (entry?.caseId ?? entry?.id) === manifest.capabilityMatrixCaseId);
  const matrixExecuted = Boolean(matrixCase) && deriveCaseStatus(matrixCase) === 'ok';
  if (!matrixCase) {
    missing.push(`capability-gate matrix case '${manifest.capabilityMatrixCaseId}' not executed`);
  } else if (!matrixExecuted) {
    missing.push(`capability-gate matrix case '${manifest.capabilityMatrixCaseId}' status ${deriveCaseStatus(matrixCase)} (expected ok)`);
  }

  const coverageCaseIds = Array.isArray(data?.coverageCaseIds) ? data.coverageCaseIds : [];
  const coverageIdsPresent = manifest.requiredCoverageIds.every((id) => coverageCaseIds.includes(id));
  if (!coverageIdsPresent) {
    const absent = manifest.requiredCoverageIds.filter((id) => !coverageCaseIds.includes(id));
    missing.push(`coverageCaseIds missing ${absent.join(', ') || 'ids'}`);
  }

  const conformance = data?.tierToolConformance ?? null;
  const conformanceMatches = conformance ? conformance.matches === true : false;
  const conformancePresent = Boolean(conformance)
    && conformance.expectedTier === tier
    && conformance.responseValid === true;
  if (!conformance) {
    missing.push('tier tool-conformance evidence absent');
  } else {
    if (conformance.expectedTier !== tier) {
      missing.push(`tier tool-conformance evidence is for '${conformance.expectedTier}', not '${tier}'`);
    }
    if (conformance.responseValid !== true) {
      missing.push('tier tool-conformance run was not a valid conformance response');
    }
    // Presence is not enough: the grid must actually match the expected tier
    // grant. A conformance run with matches !== true is a real tier drift and
    // must fail the attestation, not pass it silently.
    if (conformance.matches !== true) {
      missing.push('tier tool-conformance run did not match the expected tier grant (matches !== true)');
    }
  }

  // A run artifact that the harness itself marked incomplete (completed:false —
  // e.g. a matrix-aborted or crashed phase) can never carry a present attestation.
  if (data?.completed === false) {
    missing.push('run artifact is marked completed:false (the harness did not finish this tier)');
  }

  return {
    tier,
    matrixExecuted,
    coverageIdsPresent,
    conformancePresent,
    conformanceMatches,
    complete: missing.length === 0,
    missing,
  };
}

/**
 * Compute the lite attestation across the executed per-tier artifacts. Each
 * `artifacts` entry is `{ path, data }` (data already parsed). Returns
 * `{ complete, tiers[], missing[] }`; `complete` is true only when every required
 * tier has a present, valid attestation. This is the sole gate on whether the
 * scorecard may skip the coverage-appendix completeness cross-check.
 */
export function computeLiteAttestation(manifest, artifacts) {
  const byTier = new Map();
  for (const artifact of artifacts) {
    const tier = artifact?.data?.tierToolConformance?.expectedTier;
    if (typeof tier === 'string' && !byTier.has(tier)) {
      byTier.set(tier, artifact);
    }
  }

  const tiers = [];
  const missing = [];
  for (const tier of manifest.requiredTiers) {
    const artifact = byTier.get(tier);
    if (!artifact) {
      const entry = {
        tier,
        matrixExecuted: false,
        coverageIdsPresent: false,
        conformancePresent: false,
        conformanceMatches: false,
        complete: false,
        missing: [`no executed run artifact found for tier '${tier}'`],
      };
      tiers.push(entry);
      missing.push(`${tier}: ${entry.missing.join('; ')}`);
      continue;
    }
    const attestation = attestTierArtifact(tier, artifact.data, manifest);
    attestation.artifact = artifact.path;
    tiers.push(attestation);
    if (!attestation.complete) {
      missing.push(`${tier}: ${attestation.missing.join('; ')}`);
    }
  }

  return {
    profile: 'lite',
    requiredTiers: manifest.requiredTiers,
    requiredCoverageIds: manifest.requiredCoverageIds,
    capabilityMatrixCaseId: manifest.capabilityMatrixCaseId,
    manifestPath: manifest.path,
    complete: missing.length === 0,
    tiers,
    missing,
  };
}
