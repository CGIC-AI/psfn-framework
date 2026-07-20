import { join } from 'node:path';
import {
  loadRequiredJson,
} from './load-or-seed.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  isPartnerAffectDirection,
  isPartnerAffectSignalFamily,
  type PartnerAffectDirection,
  type PartnerAffectShadowPolicy,
  type PartnerAffectSignalFamily,
  type PartnerAffectSourceAuthorization,
} from '../../shared/contracts/partner-affect.js';

// Canonical JSON owner file for the Partner Affect shadow observation
// foundation (docs/partner-affect.md, slice 1). Every mutable weight, window,
// and threshold the shadow lane uses lives here — there are no hidden module
// constants. The subsystem ships disabled and partner-unbound; both must be
// explicitly configured before any observation is accepted.

export const PARTNER_AFFECT_SHADOW_FILE_NAME = 'partner-affect-shadow.json';
export const PARTNER_AFFECT_SHADOW_SEED_FILE_NAME = 'partner-affect-shadow.seed.json';

interface PartnerAffectShadowConfigLoadOptions {
  seedDir?: string;
}

function invalid(field: string, requirement: string, value: unknown): Error {
  return new Error(
    `Invalid partner-affect-shadow config: ${field} must be ${requirement}, got ${JSON.stringify(value)}`,
  );
}

function toBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw invalid(field, 'a boolean', value);
  }
  return value;
}

function toPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid(field, 'a positive integer', value);
  }
  return value;
}

function toUnitInterval(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalid(field, 'a number in [0, 1]', value);
  }
  return value;
}

function toToken(value: unknown, field: string, maxLength = 128): string {
  if (typeof value !== 'string') {
    throw invalid(field, 'a string', value);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw invalid(field, `a non-empty string of at most ${String(maxLength)} characters`, value);
  }
  return trimmed;
}

function toSignalFamily(value: unknown, field: string): PartnerAffectSignalFamily {
  if (!isPartnerAffectSignalFamily(value)) {
    throw invalid(field, 'a known partner-affect Signal Family', value);
  }
  return value;
}

function validateDirections(value: unknown, field: string): Record<string, PartnerAffectDirection> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw invalid(field, 'an object keyed by "family.metricName"', value);
  }
  const directions: Record<string, PartnerAffectDirection> = {};
  for (const [key, rawDirection] of Object.entries(value)) {
    const trimmedKey = key.trim();
    const separator = trimmedKey.indexOf('.');
    if (separator <= 0 || separator === trimmedKey.length - 1) {
      throw invalid(`${field}.${key}`, 'keyed as "family.metricName"', key);
    }
    toSignalFamily(trimmedKey.slice(0, separator), `${field}.${key} family prefix`);
    if (!isPartnerAffectDirection(rawDirection)) {
      throw invalid(`${field}.${key}`, 'a known partner-affect direction', rawDirection);
    }
    directions[trimmedKey] = rawDirection;
  }
  return directions;
}

function validateSource(value: unknown, field: string): PartnerAffectSourceAuthorization {
  if (!isRecord(value)) {
    throw invalid(field, 'an object', value);
  }
  const families = value.families;
  if (!Array.isArray(families) || families.length === 0) {
    throw invalid(`${field}.families`, 'a non-empty array of Signal Families', families);
  }
  return {
    sourceId: toToken(value.sourceId, `${field}.sourceId`),
    families: [...new Set(families.map((family, index) => toSignalFamily(family, `${field}.families[${String(index)}]`)))],
    consentRef: toToken(value.consentRef, `${field}.consentRef`),
    sensitivity: toToken(value.sensitivity, `${field}.sensitivity`, 64),
    revoked: toBoolean(value.revoked, `${field}.revoked`),
  };
}

function validateSources(value: unknown, field: string): PartnerAffectSourceAuthorization[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw invalid(field, 'an array of source authorizations', value);
  }
  const sources = value.map((entry, index) => validateSource(entry, `${field}[${String(index)}]`));
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.sourceId)) {
      throw invalid(field, 'free of duplicate sourceId entries', source.sourceId);
    }
    seen.add(source.sourceId);
  }
  return sources;
}

function validateAllowedFamilies(value: unknown, field: string): PartnerAffectSignalFamily[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(field, 'a non-empty array of Signal Families', value);
  }
  return [...new Set(value.map((family, index) => toSignalFamily(family, `${field}[${String(index)}]`)))];
}

export function validatePartnerAffectShadowConfig(
  raw: unknown,
  sourcePath: string,
): PartnerAffectShadowPolicy {
  if (!isRecord(raw)) {
    throw new Error(`Invalid partner-affect-shadow config at ${sourcePath}: expected object`);
  }
  const partnerContactId = raw.partnerContactId === null
    ? null
    : toToken(raw.partnerContactId, 'partnerContactId');
  const enabled = toBoolean(raw.enabled, 'enabled');
  if (enabled && partnerContactId === null) {
    // Fail closed: an enabled shadow lane with no exact canonical partner
    // binding cannot exist — there is nothing valid it could observe.
    throw new Error(
      `Invalid partner-affect-shadow config at ${sourcePath}: enabled requires a non-null partnerContactId`,
    );
  }
  return {
    enabled,
    partnerContactId,
    staleAfterMs: toPositiveInteger(raw.staleAfterMs, 'staleAfterMs'),
    evidenceWindowMs: toPositiveInteger(raw.evidenceWindowMs, 'evidenceWindowMs'),
    minConfidence: toUnitInterval(raw.minConfidence, 'minConfidence'),
    minIndependentFamilies: toPositiveInteger(raw.minIndependentFamilies, 'minIndependentFamilies'),
    conflictValueTolerance: toUnitInterval(raw.conflictValueTolerance, 'conflictValueTolerance'),
    allowedSignalFamilies: validateAllowedFamilies(raw.allowedSignalFamilies, 'allowedSignalFamilies'),
    directions: validateDirections(raw.directions, 'directions'),
    sources: validateSources(raw.sources, 'sources'),
    maxRetainedObservations: toPositiveInteger(raw.maxRetainedObservations, 'maxRetainedObservations'),
    policyRevision: toToken(raw.policyRevision, 'policyRevision', 64),
  };
}

export function loadPartnerAffectShadowConfig(
  dataDir: string,
  options: PartnerAffectShadowConfigLoadOptions = {},
): PartnerAffectShadowPolicy {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadRequiredJson({
    dataPath: join(dataDir, PARTNER_AFFECT_SHADOW_FILE_NAME),
    examplePath: join(seedDir, PARTNER_AFFECT_SHADOW_SEED_FILE_NAME),
    validate: validatePartnerAffectShadowConfig,
  });
}

export function savePartnerAffectShadowConfig(
  dataDir: string,
  nextConfig: unknown,
): PartnerAffectShadowPolicy {
  const validated = validatePartnerAffectShadowConfig(nextConfig, PARTNER_AFFECT_SHADOW_FILE_NAME);
  writeJsonAtomic(join(dataDir, PARTNER_AFFECT_SHADOW_FILE_NAME), validated);
  return validated;
}
