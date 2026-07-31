import { join } from 'node:path';
import {
  writeFileDurableAtomicSync,
  type DurableWriteOptions,
} from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import {
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
  INTAKE_POLICY_SCHEMA_VERSION,
  validateIntakePolicy,
} from './intake-policy-config.js';

export interface IntakePolicyOwnerMigrationOptions {
  dataDir: string;
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

/**
 * Explicitly upgrades intake-policy schema v1/v2 owners to v3. V1 gains the
 * canonical skill_write sink rule; both legacy versions raise persona/trust
 * mutation caps to the configured tool_output tier so screened self-authored
 * content can reach those sinks. Retired screener model selectors are removed
 * at every supported version. Runtime loading never calls this function: an
 * operator must dry-run and apply it against the exact system owner root
 * before startup will accept the migrated owner.
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
      const { candidate, removedPaths } = removeRetiredScreenerModelKeys(raw);
      if (removedPaths.length > 0) {
        validateIntakePolicy(candidate, filePath);
        return finishCandidate(candidate, {
          mode,
          status: options.apply ? 'applied' : 'planned',
          filePath,
          fromSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
          toSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
          removedPaths,
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
    if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) {
      throw new Error(
        `Intake policy owner migration at ${filePath} requires schemaVersion 1, 2, or `
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
    const addedPaths: string[] = [];
    const updatedPaths: string[] = [];
    const upgradedSinks = structuredClone(raw.sinkGates.sinks);
    if (raw.schemaVersion === 1) {
      upgradedSinks.skill_write = createSkillWriteSinkRule();
      addedPaths.push('sinkGates.sinks.skill_write');
    }
    const sourceRiskTiers = raw.sourceRiskTiers;
    if (!isRecord(sourceRiskTiers) || !isIntakeSourceRiskTier(sourceRiskTiers.tool_output)) {
      throw new Error(
        `Intake policy owner migration at ${filePath} requires sourceRiskTiers.tool_output`,
      );
    }
    for (const sink of [
      'skill_write',
      'persona_mutation',
      'wiki_write',
      'trust_mutation',
    ] as const) {
      const rule = upgradedSinks[sink];
      if (!isRecord(rule)) {
        throw new Error(
          `Intake policy owner migration at ${filePath}: sinkGates.sinks.${sink} is required`,
        );
      }
      if (!isIntakeSourceRiskTier(rule.maxSourceRiskTier)) {
        throw new Error(
          `Intake policy owner migration at ${filePath} requires a valid `
          + `sinkGates.sinks.${sink}.maxSourceRiskTier`,
        );
      }
      if (compareIntakeSourceRiskTiers(
        rule.maxSourceRiskTier,
        sourceRiskTiers.tool_output,
      ) < 0) {
        rule.maxSourceRiskTier = sourceRiskTiers.tool_output;
        updatedPaths.push(`sinkGates.sinks.${sink}.maxSourceRiskTier`);
      }
    }
    upgraded.sinkGates = {
      ...raw.sinkGates,
      sinks: upgradedSinks,
    };
    const { candidate, removedPaths } = removeRetiredScreenerModelKeys(upgraded);
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
