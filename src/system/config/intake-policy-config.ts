// ── Intake policy owner file (htm9.1) ──
//
// Canonical mutable config for the cognition intake firewall. Follows the
// standard owner-file pattern (see trust-policy-config.ts): strict fail-closed
// validation, loadRequiredJson with seed-example guidance, atomic saves.
// The firewall epic (htm9.2+) grows this file; keep additions schema-owned.

import { join } from 'node:path';
import {
  INTAKE_SOURCE_CLASSES,
  INTAKE_SOURCE_RISK_TIERS,
  isIntakeSourceRiskTier,
  type IntakeSourceClass,
  type IntakeSourceRiskTier,
} from '../../shared/contracts/intake-envelope.js';
import { loadRequiredJson } from './load-or-seed.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';

export const INTAKE_POLICY_FILE_NAME = 'intake-policy.json';
export const INTAKE_POLICY_SEED_FILE_NAME = 'intake-policy.seed.json';

/**
 * Firewall rollout mode:
 * - 'off': no envelope screening decisions are enforced anywhere.
 * - 'shadow': envelopes are created, screened, and journaled, but sink gates
 *   do not block (observe-only rollout posture).
 * - 'enforce': sink gates enforce envelope decisions.
 */
export const INTAKE_FIREWALL_MODES = ['off', 'shadow', 'enforce'] as const;
export type IntakeFirewallMode = typeof INTAKE_FIREWALL_MODES[number];

export interface IntakePolicyQuarantineConfig {
  /** Hours before a quarantined item auto-transitions to 'expired'. */
  itemTtlHours: number;
  /** Maximum quarantined items held before the oldest expire early. */
  maxHeldItems: number;
}

export interface IntakePolicyConfig {
  schemaVersion: 1;
  mode: IntakeFirewallMode;
  /**
   * Risk tier per source class. Every class must be mapped explicitly —
   * the contract carries no defaults, so an unmapped class fails startup
   * instead of silently trusting a new surface.
   */
  sourceRiskTiers: Record<IntakeSourceClass, IntakeSourceRiskTier>;
  quarantine: IntakePolicyQuarantineConfig;
}

interface IntakePolicyLoadOptions {
  seedDir?: string;
}

function invalid(sourcePath: string, detail: string): Error {
  return new Error(`Invalid intake policy at ${sourcePath}: ${detail}`);
}

function validateSourceRiskTiers(
  raw: unknown,
  sourcePath: string,
): Record<IntakeSourceClass, IntakeSourceRiskTier> {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, 'sourceRiskTiers must be an object');
  }
  const unknownKeys = Object.keys(raw)
    .filter((key) => !(INTAKE_SOURCE_CLASSES as readonly string[]).includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(sourcePath, `sourceRiskTiers has unsupported source classes: ${unknownKeys.join(', ')}`);
  }
  const tiers = {} as Record<IntakeSourceClass, IntakeSourceRiskTier>;
  for (const sourceClass of INTAKE_SOURCE_CLASSES) {
    const tier = raw[sourceClass];
    if (tier === undefined) {
      throw invalid(sourcePath, `sourceRiskTiers.${sourceClass} is required (no implicit tier defaults)`);
    }
    if (!isIntakeSourceRiskTier(tier)) {
      throw invalid(
        sourcePath,
        `sourceRiskTiers.${sourceClass} must be one of: ${INTAKE_SOURCE_RISK_TIERS.join(', ')}`,
      );
    }
    tiers[sourceClass] = tier;
  }
  return tiers;
}

function validatePositiveInteger(value: unknown, sourcePath: string, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalid(sourcePath, `${field} must be an integer >= 1`);
  }
  return value;
}

function validateQuarantine(raw: unknown, sourcePath: string): IntakePolicyQuarantineConfig {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, 'quarantine must be an object');
  }
  const unknownKeys = Object.keys(raw)
    .filter((key) => !['itemTtlHours', 'maxHeldItems'].includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(sourcePath, `quarantine has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  return {
    itemTtlHours: validatePositiveInteger(raw.itemTtlHours, sourcePath, 'quarantine.itemTtlHours'),
    maxHeldItems: validatePositiveInteger(raw.maxHeldItems, sourcePath, 'quarantine.maxHeldItems'),
  };
}

export function validateIntakePolicy(raw: unknown, sourcePath: string): IntakePolicyConfig {
  if (!isRecord(raw)) {
    throw invalid(sourcePath, 'expected object');
  }
  const knownKeys = ['schemaVersion', 'mode', 'sourceRiskTiers', 'quarantine'];
  const unknownKeys = Object.keys(raw).filter((key) => !knownKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(sourcePath, `has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (raw.schemaVersion !== 1) {
    throw invalid(sourcePath, 'schemaVersion must be 1');
  }
  const mode = raw.mode;
  if (typeof mode !== 'string' || !(INTAKE_FIREWALL_MODES as readonly string[]).includes(mode)) {
    throw invalid(sourcePath, `mode must be one of: ${INTAKE_FIREWALL_MODES.join(', ')}`);
  }
  return {
    schemaVersion: 1,
    mode: mode as IntakeFirewallMode,
    sourceRiskTiers: validateSourceRiskTiers(raw.sourceRiskTiers, sourcePath),
    quarantine: validateQuarantine(raw.quarantine, sourcePath),
  };
}

export function loadIntakePolicyConfig(
  dataDir: string,
  options: IntakePolicyLoadOptions = {},
): IntakePolicyConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadRequiredJson({
    dataPath: join(dataDir, INTAKE_POLICY_FILE_NAME),
    examplePath: join(seedDir, INTAKE_POLICY_SEED_FILE_NAME),
    validate: validateIntakePolicy,
  });
}

export function saveIntakePolicyConfig(
  dataDir: string,
  nextConfig: unknown,
): IntakePolicyConfig {
  const validated = validateIntakePolicy(nextConfig, INTAKE_POLICY_FILE_NAME);
  writeJsonAtomic(join(dataDir, INTAKE_POLICY_FILE_NAME), validated);
  return validated;
}
