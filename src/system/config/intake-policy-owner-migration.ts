import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  writeFileDurableAtomicSync,
  type DurableWriteOptions,
} from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  INTAKE_SOURCE_RISK_TIERS,
  compareIntakeSourceRiskTiers,
  isIntakeSourceRiskTier,
} from '../../shared/contracts/intake-envelope.js';
import {
  assertFilesystemIdentity,
  assertPinnedDirectoryAtLogicalPath,
  closePinnedDirectory,
  inspectPinnedRegularFile,
  pinAbsoluteDirectory,
  pinnedLeafPath,
  readPinnedRegularFile,
} from '../../persistence/pinned-filesystem.js';
import {
  createSkillWriteSinkRule,
  INTAKE_POLICY_FILE_NAME,
  INTAKE_POLICY_SEED_FILE_NAME,
  INTAKE_POLICY_SCHEMA_VERSION,
  validateIntakePolicy,
  validateChatBodyHandling,
  validateScreeningPool,
  type IntakeChatBodyHandlingPolicyConfig,
  type IntakeScreeningPoolPolicyConfig,
  type IntakeSurfacePosturesConfig,
} from './intake-policy-config.js';
import {
  validateIntakeUrlScannerPolicy,
  type IntakeUrlScannerPolicyConfig,
} from './intake-url-scanner-policy.js';

export interface IntakePolicyOwnerMigrationOptions {
  dataDir: string;
  seedDir?: string;
  apply?: boolean;
  faultInjection?: DurableWriteOptions['faultInjection'];
}

export interface IntakePolicyOwnerMigrationResult {
  mode: 'dry-run' | 'apply';
  status: 'not_needed' | 'planned' | 'applied';
  filePath: string;
  fromSchemaVersion: number;
  toSchemaVersion: typeof INTAKE_POLICY_SCHEMA_VERSION;
  addedPaths?: string[];
  updatedPaths?: string[];
  removedPaths?: string[];
}

const RETIRED_SCREENER_MODEL_PATHS = [
  ['l2Screener', 'model'],
  ['l3Screener', 'model'],
  ['l3Screener', 'secondaryModel'],
  ['visionScreener', 'model'],
] as const;

/**
 * Retired intake-firewall mode values and their explicit migration target.
 * 'off' (no firewall) → 'shadow' (observe-only, the least-interference valid
 * posture now that 'off' is removed); 'enforce' (full enforcement, pre
 * clean-bubble) → 'strict' (behavior-preserving: full enforcement of every
 * declared vector). 'shadow' is unchanged.
 */
const RETIRED_INTAKE_MODE_MIGRATIONS: Readonly<Record<string, string>> = {
  off: 'shadow',
  enforce: 'strict',
};

function remapRetiredIntakeMode(
  raw: Record<string, unknown>,
): { candidate: Record<string, unknown>; updatedMode: boolean } {
  if (typeof raw.mode !== 'string') {
    throw new Error(
      'Intake policy owner migration requires a string `mode` field to remap',
    );
  }
  const target = RETIRED_INTAKE_MODE_MIGRATIONS[raw.mode];
  if (target === undefined) return { candidate: raw, updatedMode: false };
  return {
    candidate: { ...raw, mode: target },
    updatedMode: true,
  };
}

function loadSeedUrlScannerPolicy(seedDir: string): IntakeUrlScannerPolicyConfig {
  const seedPath = join(seedDir, INTAKE_POLICY_SEED_FILE_NAME);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(seedPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Cannot load intake URL scanner migration policy from ${seedPath}: ${String(error)}`,
    );
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid intake policy seed at ${seedPath}: expected object`);
  }
  return validateIntakeUrlScannerPolicy(raw.urlScanner, seedPath);
}

function loadSeedScreeningPoolPolicy(seedDir: string): IntakeScreeningPoolPolicyConfig {
  const seedPath = join(seedDir, INTAKE_POLICY_SEED_FILE_NAME);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(seedPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Cannot load intake screening pool migration policy from ${seedPath}: ${String(error)}`,
    );
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid intake policy seed at ${seedPath}: expected object`);
  }
  return validateScreeningPool(raw.screeningPool, seedPath);
}

function loadSeedChatBodyHandlingPolicy(seedDir: string): IntakeChatBodyHandlingPolicyConfig {
  const seedPath = join(seedDir, INTAKE_POLICY_SEED_FILE_NAME);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(seedPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Cannot load intake chat-body handling migration policy from ${seedPath}: ${String(error)}`,
    );
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid intake policy seed at ${seedPath}: expected object`);
  }
  return validateChatBodyHandling(raw.chatBodyHandling, seedPath);
}

function loadSeedSurfacePostures(seedDir: string): IntakeSurfacePosturesConfig {
  const seedPath = join(seedDir, INTAKE_POLICY_SEED_FILE_NAME);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(seedPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Cannot load intake surface-posture migration policy from ${seedPath}: ${String(error)}`,
    );
  }
  return validateIntakePolicy(raw, seedPath).surfacePostures;
}

function ensureSurfacePosturesPresent(
  candidate: Record<string, unknown>,
  seedDir: string,
): { candidate: Record<string, unknown>; addedPaths: string[] } {
  if (isRecord(candidate.surfacePostures)) {
    return { candidate, addedPaths: [] };
  }
  const next = structuredClone(candidate);
  next.surfacePostures = loadSeedSurfacePostures(seedDir);
  return { candidate: next, addedPaths: ['surfacePostures'] };
}

function ensureChatBodyHandlingPresent(
  candidate: Record<string, unknown>,
  filePath: string,
  seedDir: string,
): { candidate: Record<string, unknown>; addedPaths: string[] } {
  if (isRecord(candidate.chatBodyHandling)) {
    validateChatBodyHandling(candidate.chatBodyHandling, filePath);
    return { candidate, addedPaths: [] };
  }
  const next = structuredClone(candidate);
  next.chatBodyHandling = loadSeedChatBodyHandlingPolicy(seedDir);
  return { candidate: next, addedPaths: ['chatBodyHandling'] };
}

function ensureLegacyMandatoryUntrustedL2(
  candidate: Record<string, unknown>,
  filePath: string,
): { candidate: Record<string, unknown>; updatedPaths: string[] } {
  if (!isRecord(candidate.l2Screener)) {
    throw new Error(
      `Intake policy owner migration at ${filePath} requires l2Screener to be an object`,
    );
  }
  const mandatoryTiers = candidate.l2Screener.mandatoryTiers;
  if (!Array.isArray(mandatoryTiers)) {
    throw new Error(
      `Intake policy owner migration at ${filePath} requires l2Screener.mandatoryTiers to be an array`,
    );
  }
  for (const tier of mandatoryTiers) {
    if (!isIntakeSourceRiskTier(tier)) {
      throw new Error(
        `Intake policy owner migration at ${filePath} has unsupported `
        + `l2Screener.mandatoryTiers entry ${JSON.stringify(tier)}`,
      );
    }
  }
  if (mandatoryTiers.includes('untrusted')) {
    return { candidate, updatedPaths: [] };
  }
  const next = structuredClone(candidate);
  const carriedTiers = new Set([...mandatoryTiers, 'untrusted']);
  if (!isRecord(next.l2Screener)) {
    throw new Error('Internal intake policy migration error: l2Screener clone was lost');
  }
  next.l2Screener.mandatoryTiers = INTAKE_SOURCE_RISK_TIERS.filter(
    tier => carriedTiers.has(tier),
  );
  return { candidate: next, updatedPaths: ['l2Screener.mandatoryTiers'] };
}

function ensureScreeningPoolPresent(
  candidate: Record<string, unknown>,
  filePath: string,
  seedDir: string,
): { candidate: Record<string, unknown>; addedPaths: string[] } {
  if (isRecord(candidate.screeningPool)) {
    // Re-validate the carried section so a malformed legacy copy fails closed
    // here instead of at the final validateIntakePolicy call.
    validateScreeningPool(candidate.screeningPool, filePath);
    return { candidate, addedPaths: [] };
  }
  const next = structuredClone(candidate);
  next.screeningPool = loadSeedScreeningPoolPolicy(seedDir);
  return { candidate: next, addedPaths: ['screeningPool'] };
}

function removeRetiredScreenerModelKeys(
  raw: Record<string, unknown>,
): { candidate: Record<string, unknown>; removedPaths: string[] } {
  const candidate = structuredClone(raw);
  const removedPaths: string[] = [];
  for (const [section, key] of RETIRED_SCREENER_MODEL_PATHS) {
    const value = candidate[section];
    if (!isRecord(value) || !Object.hasOwn(value, key)) continue;
    delete value[key];
    removedPaths.push(`${section}.${key}`);
  }
  return { candidate, removedPaths };
}

function repairSelfAuthoredMutationPolicy(
  raw: Record<string, unknown>,
  filePath: string,
  options: { rejectExistingCompanionSelf: boolean },
): {
    candidate: Record<string, unknown>;
    addedPaths: string[];
    updatedPaths: string[];
  } {
  const candidate = structuredClone(raw);
  if (!isRecord(candidate.sourceRiskTiers)) {
    throw new Error(
      `Intake policy owner migration at ${filePath} requires sourceRiskTiers`,
    );
  }
  const addedPaths: string[] = [];
  const updatedPaths: string[] = [];
  if (Object.hasOwn(candidate.sourceRiskTiers, 'companion_self')) {
    if (options.rejectExistingCompanionSelf) {
      throw new Error(
        `Intake policy owner migration at ${filePath} refuses legacy schemaVersion `
        + `${String(raw.schemaVersion)} with an existing sourceRiskTiers.companion_self; `
        + 'resolve the ambiguous owner state explicitly',
      );
    }
    if (candidate.sourceRiskTiers.companion_self !== 'trusted') {
      candidate.sourceRiskTiers.companion_self = 'trusted';
      updatedPaths.push('sourceRiskTiers.companion_self');
    }
  } else {
    candidate.sourceRiskTiers.companion_self = 'trusted';
    addedPaths.push('sourceRiskTiers.companion_self');
  }

  if (!isRecord(candidate.sinkGates) || !isRecord(candidate.sinkGates.sinks)) {
    throw new Error(
      `Intake policy owner migration at ${filePath} requires sinkGates.sinks to be an object`,
    );
  }
  for (const sink of ['persona_mutation', 'trust_mutation'] as const) {
    const rule = candidate.sinkGates.sinks[sink];
    if (!isRecord(rule) || !isIntakeSourceRiskTier(rule.maxSourceRiskTier)) {
      throw new Error(
        `Intake policy owner migration at ${filePath} requires a valid `
        + `sinkGates.sinks.${sink}.maxSourceRiskTier`,
      );
    }
    if (compareIntakeSourceRiskTiers(rule.maxSourceRiskTier, 'standard') > 0) {
      rule.maxSourceRiskTier = 'standard';
      updatedPaths.push(`sinkGates.sinks.${sink}.maxSourceRiskTier`);
    }
  }
  return { candidate, addedPaths, updatedPaths };
}

/**
 * Explicitly upgrades intake-policy schema v1/v2/v3/v4/v5 owners to v6. V1 gains the
 * canonical skill_write sink rule; legacy owners gain the explicit
 * trusted companion_self source class used only for screened self-authored
 * mutations. Every legacy version gains the URL scanner scheme policy from the
 * distributed seed. Retired screener model selectors are removed at every
 * supported version. Runtime loading never calls this function: an operator
 * must dry-run and apply it against the exact system owner root before startup
 * will accept the migrated owner.
 */
export function migrateIntakePolicyOwner(
  options: IntakePolicyOwnerMigrationOptions,
): IntakePolicyOwnerMigrationResult {
  const filePath = join(options.dataDir, INTAKE_POLICY_FILE_NAME);
  const mode = options.apply ? 'apply' : 'dry-run';
  const dataDirectory = pinAbsoluteDirectory(
    options.dataDir,
    'Intake policy owner data directory',
  );
  try {
    const source = readPinnedRegularFile(
      dataDirectory,
      INTAKE_POLICY_FILE_NAME,
      'Intake policy owner file',
    );
    const assertSourceStillCurrent = (): void => {
      assertPinnedDirectoryAtLogicalPath(
        dataDirectory,
        'Intake policy owner data directory',
      );
      const current = inspectPinnedRegularFile(
        dataDirectory,
        INTAKE_POLICY_FILE_NAME,
        'Intake policy owner file',
      );
      assertFilesystemIdentity(current, source, 'Intake policy owner file');
      if (current.bytes !== source.bytes || current.sha256 !== source.sha256) {
        throw new Error(`Intake policy owner changed while migration was prepared: ${filePath}`);
      }
    };

    const raw = JSON.parse(source.content.toString('utf8')) as unknown;
    if (!isRecord(raw)) {
      throw new Error(`Invalid intake policy at ${filePath}: expected object`);
    }

    const finishCandidate = (
      candidate: Record<string, unknown>,
      result: IntakePolicyOwnerMigrationResult,
    ): IntakePolicyOwnerMigrationResult => {
      if (options.apply) {
        writeFileDurableAtomicSync(
          pinnedLeafPath(dataDirectory, INTAKE_POLICY_FILE_NAME),
          `${JSON.stringify(candidate, null, 2)}\n`,
          {
            faultInjection: (stage) => {
              options.faultInjection?.(stage, filePath);
              if (stage !== 'after_file_sync') return;
              assertSourceStillCurrent();
            },
          },
        );
        assertPinnedDirectoryAtLogicalPath(
          dataDirectory,
          'Intake policy owner data directory',
        );
      } else {
        assertSourceStillCurrent();
      }
      return result;
    };

    if (raw.schemaVersion === INTAKE_POLICY_SCHEMA_VERSION) {
      const modeRemapped = remapRetiredIntakeMode(raw);
      let candidate = modeRemapped.candidate;
      const repaired = repairSelfAuthoredMutationPolicy(candidate, filePath, {
        rejectExistingCompanionSelf: false,
      });
      const withScreeningPool = ensureScreeningPoolPresent(
        repaired.candidate,
        filePath,
        options.seedDir ?? process.env.CONFIG_DIR ?? './config',
      );
      const withChatBodyHandling = ensureChatBodyHandlingPresent(
        withScreeningPool.candidate,
        filePath,
        options.seedDir ?? process.env.CONFIG_DIR ?? './config',
      );
      const withSurfacePostures = ensureSurfacePosturesPresent(
        withChatBodyHandling.candidate,
        options.seedDir ?? process.env.CONFIG_DIR ?? './config',
      );
      const retired = removeRetiredScreenerModelKeys(withSurfacePostures.candidate);
      candidate = retired.candidate;
      const addedPaths = [
        ...repaired.addedPaths,
        ...withScreeningPool.addedPaths,
        ...withChatBodyHandling.addedPaths,
        ...withSurfacePostures.addedPaths,
      ];
      const updatedPaths: string[] = [];
      if (modeRemapped.updatedMode) {
        updatedPaths.push(`mode (${String(raw.mode)} -> ${String(candidate.mode)})`);
      }
      updatedPaths.push(...repaired.updatedPaths);
      if (
        updatedPaths.length > 0
        || addedPaths.length > 0
        || retired.removedPaths.length > 0
      ) {
        validateIntakePolicy(candidate, filePath);
        return finishCandidate(candidate, {
          mode,
          status: options.apply ? 'applied' : 'planned',
          filePath,
          fromSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
          toSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
          ...(addedPaths.length > 0 ? { addedPaths } : {}),
          ...(updatedPaths.length > 0 ? { updatedPaths } : {}),
          ...(retired.removedPaths.length > 0 ? { removedPaths: retired.removedPaths } : {}),
        });
      }
      validateIntakePolicy(raw, filePath);
      assertSourceStillCurrent();
      return {
        mode,
        status: 'not_needed',
        filePath,
        fromSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
        toSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
      };
    }
    if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2 && raw.schemaVersion !== 3
      && raw.schemaVersion !== 4 && raw.schemaVersion !== 5) {
      throw new Error(
        `Intake policy owner migration at ${filePath} requires schemaVersion 1, 2, 3, 4, 5, or `
        + `the current schemaVersion ${String(INTAKE_POLICY_SCHEMA_VERSION)}`,
      );
    }
    if (!isRecord(raw.sinkGates) || !isRecord(raw.sinkGates.sinks)) {
      throw new Error(
        `Intake policy owner migration at ${filePath} requires sinkGates.sinks to be an object`,
      );
    }
    if (raw.schemaVersion === 1 && Object.hasOwn(raw.sinkGates.sinks, 'skill_write')) {
      throw new Error(
        `Intake policy owner migration at ${filePath} refuses schemaVersion 1 with an existing `
        + 'skill_write sink; resolve the ambiguous owner state explicitly',
      );
    }

    const upgraded: Record<string, unknown> = structuredClone(raw);
    upgraded.schemaVersion = INTAKE_POLICY_SCHEMA_VERSION;
    // Legacy schema versions predate the canonical CogSec mode vocabulary;
    // remap any retired mode value before validation rejects it.
    const legacyModeRemapped = remapRetiredIntakeMode(upgraded);
    const addedPaths: string[] = [];
    const updatedPaths: string[] = [];
    if (legacyModeRemapped.updatedMode) {
      updatedPaths.push(`mode (${String(upgraded.mode)} -> ${String(legacyModeRemapped.candidate.mode)})`);
      upgraded.mode = legacyModeRemapped.candidate.mode;
    }
    if (Object.hasOwn(upgraded, 'urlScanner')) {
      upgraded.urlScanner = validateIntakeUrlScannerPolicy(upgraded.urlScanner, filePath);
    } else {
      upgraded.urlScanner = loadSeedUrlScannerPolicy(
        options.seedDir ?? process.env.CONFIG_DIR ?? './config',
      );
      addedPaths.push('urlScanner');
    }
    const withScreeningPool = ensureScreeningPoolPresent(
      upgraded,
      filePath,
      options.seedDir ?? process.env.CONFIG_DIR ?? './config',
    );
    Object.assign(upgraded, withScreeningPool.candidate);
    addedPaths.push(...withScreeningPool.addedPaths);
    const withChatBodyHandling = ensureChatBodyHandlingPresent(
      upgraded,
      filePath,
      options.seedDir ?? process.env.CONFIG_DIR ?? './config',
    );
    Object.assign(upgraded, withChatBodyHandling.candidate);
    addedPaths.push(...withChatBodyHandling.addedPaths);
    const withSurfacePostures = ensureSurfacePosturesPresent(
      upgraded,
      options.seedDir ?? process.env.CONFIG_DIR ?? './config',
    );
    Object.assign(upgraded, withSurfacePostures.candidate);
    addedPaths.push(...withSurfacePostures.addedPaths);
    const upgradedSinks = structuredClone(raw.sinkGates.sinks);
    if (raw.schemaVersion === 1) {
      upgradedSinks.skill_write = createSkillWriteSinkRule();
      addedPaths.push('sinkGates.sinks.skill_write');
    }
    upgraded.sinkGates = {
      ...raw.sinkGates,
      sinks: upgradedSinks,
    };
    const withMandatoryUntrustedL2 = ensureLegacyMandatoryUntrustedL2(upgraded, filePath);
    updatedPaths.push(...withMandatoryUntrustedL2.updatedPaths);
    const repaired = repairSelfAuthoredMutationPolicy(withMandatoryUntrustedL2.candidate, filePath, {
      rejectExistingCompanionSelf: raw.schemaVersion === 1 || raw.schemaVersion === 2,
    });
    addedPaths.push(...repaired.addedPaths);
    updatedPaths.push(...repaired.updatedPaths);
    const { candidate, removedPaths } = removeRetiredScreenerModelKeys(repaired.candidate);
    validateIntakePolicy(candidate, filePath);

    const result: IntakePolicyOwnerMigrationResult = {
      mode,
      status: options.apply ? 'applied' : 'planned',
      filePath,
      fromSchemaVersion: raw.schemaVersion,
      toSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
      ...(addedPaths.length > 0 ? { addedPaths } : {}),
      ...(updatedPaths.length > 0 ? { updatedPaths } : {}),
      ...(removedPaths.length > 0 ? { removedPaths } : {}),
    };
    return finishCandidate(candidate, result);
  } finally {
    closePinnedDirectory(dataDirectory);
  }
}
