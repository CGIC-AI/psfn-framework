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
  setPinnedRegularFileMode,
} from '../../persistence/pinned-filesystem.js';
import type {
  LifecycleKubernetesSettings,
  WikiStartupHydrationSettings,
} from '../config/runtime-config-contracts.js';
import { SETTINGS_FILE_NAME, type EditableSettings } from './contracts.js';
import { normalizeEditableSettings } from './schema.js';
import { loadRuntimeSettingsContractDefaults } from '../config/settings-contract-guard.js';
import { canonicalOwnerFileMode } from '../config/owner-file-modes.js';

export const DEFAULT_WIKI_STARTUP_HYDRATION_SETTINGS: WikiStartupHydrationSettings = {
  recentSessionLimit: 4,
  recentMessageLimit: 18,
  maxContextChars: 6_000,
};

export const DEFAULT_LIFECYCLE_KUBERNETES_SETTINGS: LifecycleKubernetesSettings = {
  lifecycleCommandTimeoutMs: 30_000,
  operatorCommandTimeoutMs: 600_000,
  operatorHttpTimeoutMs: 8_000,
  operatorConfirmationRequestTimeoutMs: 5_000,
  kubernetesReadRequestTimeoutMs: 5_000,
  kubernetesRolloutRequestTimeoutMs: 5_000,
  rolloutWaitTimeoutMs: 180_000,
  rolloutPollIntervalMs: 3_000,
  rollbackWaitTimeoutMs: 180_000,
  rollbackPollIntervalMs: 3_000,
  postRolloutMaxLogRecords: 10,
  postRolloutValidationHistoryLimit: 20,
  rollbackHistoryLimit: 50,
};

export interface RequiredSettingsBlocksMigrationOptions {
  dataDir: string;
  seedDir?: string;
  apply?: boolean;
  faultInjection?: DurableWriteOptions['faultInjection'];
}

export interface RequiredSettingsBlocksMigrationResult {
  mode: 'dry-run' | 'apply';
  status: 'not_needed' | 'planned' | 'applied';
  filePath: string;
  addedPaths?: string[];
  updatedPaths?: string[];
}

/**
 * Upgrade settings owners written before current default-bearing runtime
 * contract fields existed. The legacy function name remains the stable CLI
 * seam used by deployed init containers.
 */
export function migrateRequiredSettingsBlocks(
  options: RequiredSettingsBlocksMigrationOptions,
): RequiredSettingsBlocksMigrationResult {
  const filePath = join(options.dataDir, SETTINGS_FILE_NAME);
  const mode = options.apply ? 'apply' : 'dry-run';
  const dataDirectory = pinAbsoluteDirectory(
    options.dataDir,
    'Settings owner data directory',
  );
  try {
    const source = readPinnedRegularFile(
      dataDirectory,
      SETTINGS_FILE_NAME,
      'Settings owner file',
    );
    const assertSourceStillCurrent = (): void => {
      assertPinnedDirectoryAtLogicalPath(dataDirectory, 'Settings owner data directory');
      const current = inspectPinnedRegularFile(
        dataDirectory,
        SETTINGS_FILE_NAME,
        'Settings owner file',
      );
      assertFilesystemIdentity(current, source, 'Settings owner file');
      if (current.bytes !== source.bytes || current.sha256 !== source.sha256) {
        throw new Error(`Settings owner changed while migration was prepared: ${filePath}`);
      }
    };

    const raw = JSON.parse(source.content.toString('utf8')) as unknown;
    if (!isRecord(raw)) {
      throw new Error(`Invalid settings config at ${filePath}: expected object`);
    }
    const candidate: Record<string, unknown> = structuredClone(raw);
    const addedPaths: string[] = [];
    const defaults = loadRuntimeSettingsContractDefaults(
      options.seedDir ?? process.env.CONFIG_DIR ?? './config',
    );
    for (const [key, value] of Object.entries(defaults).sort(([left], [right]) => (
      left.localeCompare(right)
    ))) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) {
        candidate[key] = structuredClone(value);
        addedPaths.push(key);
      }
    }

    normalizeEditableSettings(candidate as EditableSettings);
    if (addedPaths.length === 0) {
      assertSourceStillCurrent();
      const canonicalMode = canonicalOwnerFileMode({
        ownerFileName: SETTINGS_FILE_NAME,
        scope: 'system',
      });
      if (source.mode !== canonicalMode) {
        if (options.apply) {
          setPinnedRegularFileMode(
            dataDirectory,
            SETTINGS_FILE_NAME,
            'Settings owner file',
            canonicalMode,
            source,
          );
        }
        return {
          mode,
          status: options.apply ? 'applied' : 'planned',
          filePath,
          updatedPaths: ['mode'],
        };
      }
      return { mode, status: 'not_needed', filePath };
    }
    const result: RequiredSettingsBlocksMigrationResult = {
      mode,
      status: options.apply ? 'applied' : 'planned',
      filePath,
      addedPaths,
    };
    if (options.apply) {
      writeFileDurableAtomicSync(
        pinnedLeafPath(dataDirectory, SETTINGS_FILE_NAME),
        `${JSON.stringify(candidate, null, 2)}\n`,
        {
          mode: canonicalOwnerFileMode({ ownerFileName: SETTINGS_FILE_NAME, scope: 'system' }),
          faultInjection: (stage) => {
            options.faultInjection?.(stage, filePath);
            if (stage !== 'after_file_sync') return;
            assertSourceStillCurrent();
          },
        },
      );
      assertPinnedDirectoryAtLogicalPath(dataDirectory, 'Settings owner data directory');
    } else {
      assertSourceStillCurrent();
    }
    return result;
  } finally {
    closePinnedDirectory(dataDirectory);
  }
}
