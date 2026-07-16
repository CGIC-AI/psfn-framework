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
  DEFAULT_BACKGROUND_MAINTENANCE_CONFIG,
  SCHEDULER_FILE_NAME,
  validateSchedulerConfig,
} from './scheduler-config.js';

export interface SchedulerOwnerMigrationOptions {
  dataDir: string;
  apply?: boolean;
  faultInjection?: DurableWriteOptions['faultInjection'];
}

export interface SchedulerOwnerMigrationResult {
  mode: 'dry-run' | 'apply';
  status: 'not_needed' | 'planned' | 'applied';
  filePath: string;
  selectedIntervalMs?: number;
  selectedFrom?: 'salienceDecayIntervalMs' | 'socialGraphBuilder.intervalMs';
  legacyIntervals?: {
    salienceDecayIntervalMs?: unknown;
    socialGraphBuilderIntervalMs?: unknown;
  };
  removedPaths?: string[];
}

/**
 * Converts the pre-bundled scheduler owner shape into the canonical shared
 * background-maintenance cadence. Dry-run is the default. The candidate is
 * fully validated before an atomic replacement, and already-migrated files are
 * validated without being rewritten.
 */
export function migrateLegacySchedulerOwner(
  options: SchedulerOwnerMigrationOptions,
): SchedulerOwnerMigrationResult {
  const filePath = join(options.dataDir, SCHEDULER_FILE_NAME);
  const mode = options.apply ? 'apply' : 'dry-run';
  const dataDirectory = pinAbsoluteDirectory(
    options.dataDir,
    'Scheduler owner data directory',
  );
  try {
    const source = readPinnedRegularFile(
      dataDirectory,
      SCHEDULER_FILE_NAME,
      'Scheduler owner file',
    );
    const assertSourceStillCurrent = (): void => {
      assertPinnedDirectoryAtLogicalPath(
        dataDirectory,
        'Scheduler owner data directory',
      );
      const current = inspectPinnedRegularFile(
        dataDirectory,
        SCHEDULER_FILE_NAME,
        'Scheduler owner file',
      );
      assertFilesystemIdentity(current, source, 'Scheduler owner file');
      if (current.bytes !== source.bytes || current.sha256 !== source.sha256) {
        throw new Error(`Scheduler owner changed while migration was prepared: ${filePath}`);
      }
    };
    const raw = JSON.parse(source.content.toString('utf8')) as unknown;
    if (!isRecord(raw)) {
      throw new Error(`Invalid scheduler config at ${filePath}: expected object`);
    }

    const socialGraphBuilder = isRecord(raw.socialGraphBuilder)
      ? raw.socialGraphBuilder
      : null;
    const hasSalienceInterval = raw.salienceDecayIntervalMs !== undefined;
    const hasSocialGraphInterval = socialGraphBuilder?.intervalMs !== undefined;
    const hasLegacyInterval = hasSalienceInterval || hasSocialGraphInterval;

    if (!hasLegacyInterval) {
      validateSchedulerConfig(raw, filePath);
      assertSourceStillCurrent();
      return { mode, status: 'not_needed', filePath };
    }
    if (raw.backgroundMaintenance !== undefined) {
      throw new Error(
        `Scheduler owner migration at ${filePath} refuses a mixed shape containing both `
        + 'backgroundMaintenance and retired cadence keys; resolve the ambiguous owner state manually',
      );
    }

    // The bundled cadence inherited the legacy salience-decay interval. If that
    // key is absent, the social-graph interval is the only available owner value.
    const selectedFrom = hasSalienceInterval
      ? 'salienceDecayIntervalMs'
      : 'socialGraphBuilder.intervalMs';
    const selectedInterval = hasSalienceInterval
      ? raw.salienceDecayIntervalMs
      : socialGraphBuilder?.intervalMs;
    const candidate: Record<string, unknown> = structuredClone(raw);
    delete candidate.salienceDecayIntervalMs;
    if (isRecord(candidate.socialGraphBuilder)) {
      const nextSocialGraphBuilder = { ...candidate.socialGraphBuilder };
      delete nextSocialGraphBuilder.intervalMs;
      candidate.socialGraphBuilder = nextSocialGraphBuilder;
    }
    candidate.backgroundMaintenance = {
      ...structuredClone(DEFAULT_BACKGROUND_MAINTENANCE_CONFIG),
      intervalMs: selectedInterval,
    };

    const validated = validateSchedulerConfig(candidate, filePath);
    const result: SchedulerOwnerMigrationResult = {
      mode,
      status: options.apply ? 'applied' : 'planned',
      filePath,
      selectedIntervalMs: validated.backgroundMaintenance.intervalMs,
      selectedFrom,
      legacyIntervals: {
        ...(hasSalienceInterval
          ? { salienceDecayIntervalMs: raw.salienceDecayIntervalMs }
          : {}),
        ...(hasSocialGraphInterval
          ? { socialGraphBuilderIntervalMs: socialGraphBuilder.intervalMs }
          : {}),
      },
      removedPaths: [
        ...(hasSalienceInterval ? ['salienceDecayIntervalMs'] : []),
        ...(hasSocialGraphInterval ? ['socialGraphBuilder.intervalMs'] : []),
      ],
    };

    if (options.apply) {
      // Preserve every unrelated raw owner key. Validation above proves the
      // canonical projection is safe before this durable atomic publish occurs.
      writeFileDurableAtomicSync(
        pinnedLeafPath(dataDirectory, SCHEDULER_FILE_NAME),
        `${JSON.stringify(candidate, null, 2)}\n`,
        {
          faultInjection: (stage) => {
            options.faultInjection?.(stage, filePath);
            if (stage !== 'after_file_sync') return;
            assertSourceStillCurrent();
          },
        },
      );
      assertPinnedDirectoryAtLogicalPath(dataDirectory, 'Scheduler owner data directory');
    } else {
      assertSourceStillCurrent();
    }
    return result;
  } finally {
    closePinnedDirectory(dataDirectory);
  }
}
