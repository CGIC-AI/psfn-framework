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
import type {
  LifecycleKubernetesSettings,
  WikiStartupHydrationSettings,
} from '../config/runtime-config-contracts.js';
import { SETTINGS_FILE_NAME, type EditableSettings } from './contracts.js';
import { normalizeEditableSettings } from './schema.js';

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
  apply?: boolean;
  faultInjection?: DurableWriteOptions['faultInjection'];
}

export interface RequiredSettingsBlocksMigrationResult {
  mode: 'dry-run' | 'apply';
  status: 'not_needed' | 'planned' | 'applied';
  filePath: string;
  addedPaths?: string[];
}

/** Explicitly upgrades owners written before the two runtime-required blocks existed. */
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
    if (raw.wikiStartupHydration === undefined) {
      candidate.wikiStartupHydration = structuredClone(
        DEFAULT_WIKI_STARTUP_HYDRATION_SETTINGS,
      );
      addedPaths.push('wikiStartupHydration');
    }
    if (raw.lifecycleKubernetes === undefined) {
      candidate.lifecycleKubernetes = structuredClone(
        DEFAULT_LIFECYCLE_KUBERNETES_SETTINGS,
      );
      addedPaths.push('lifecycleKubernetes');
    }

    normalizeEditableSettings(candidate as EditableSettings);
    if (addedPaths.length === 0) {
      assertSourceStillCurrent();
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
