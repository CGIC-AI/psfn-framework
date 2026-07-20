import { join } from 'node:path';
import {
  writeFileDurableAtomicSync,
  type DurableWriteOptions,
} from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
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
}

/**
 * Explicitly upgrades intake-policy schema v1 owners to v2 by adding the
 * canonical skill_write sink rule. Runtime loading never calls this function:
 * an operator must dry-run and apply it against the exact system owner root
 * before startup will accept the new schema.
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

    if (raw.schemaVersion === INTAKE_POLICY_SCHEMA_VERSION) {
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
    if (raw.schemaVersion !== 1) {
      throw new Error(
        `Intake policy owner migration at ${filePath} requires schemaVersion 1 or `
        + `the current schemaVersion ${String(INTAKE_POLICY_SCHEMA_VERSION)}`,
      );
    }
    if (!isRecord(raw.sinkGates) || !isRecord(raw.sinkGates.sinks)) {
      throw new Error(
        `Intake policy owner migration at ${filePath} requires sinkGates.sinks to be an object`,
      );
    }
    if (Object.hasOwn(raw.sinkGates.sinks, 'skill_write')) {
      throw new Error(
        `Intake policy owner migration at ${filePath} refuses schemaVersion 1 with an existing `
        + 'skill_write sink; resolve the ambiguous owner state explicitly',
      );
    }

    const candidate: Record<string, unknown> = structuredClone(raw);
    candidate.schemaVersion = INTAKE_POLICY_SCHEMA_VERSION;
    candidate.sinkGates = {
      ...raw.sinkGates,
      sinks: {
        ...raw.sinkGates.sinks,
        skill_write: createSkillWriteSinkRule(),
      },
    };
    validateIntakePolicy(candidate, filePath);

    const result: IntakePolicyOwnerMigrationResult = {
      mode,
      status: options.apply ? 'applied' : 'planned',
      filePath,
      fromSchemaVersion: 1,
      toSchemaVersion: INTAKE_POLICY_SCHEMA_VERSION,
      addedPaths: ['sinkGates.sinks.skill_write'],
    };
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
  } finally {
    closePinnedDirectory(dataDirectory);
  }
}
