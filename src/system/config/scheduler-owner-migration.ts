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
import { canonicalOwnerFileMode } from './owner-file-modes.js';
import {
  DEFAULT_BACKGROUND_WORK_TUNING,
  DEFAULT_BACKGROUND_MAINTENANCE_CONFIG,
  SCHEDULER_FILE_NAME,
  validateSchedulerConfig,
} from './scheduler-config.js';
import { DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG } from './icp-autonomy-scheduler-config.js';
import { DEFAULT_INTENTION_FOLLOW_UP_SCHEDULER_CONFIG } from './scheduler-config/intention-follow-up.js';

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
  addedPaths?: string[];
}

function addMissingIcpPolicyHolds(
  candidate: Record<string, unknown>,
  addedPaths: string[],
): void {
  if (!isRecord(candidate.icpAutonomy)
    || candidate.icpAutonomy.policyHolds !== undefined) return;
  candidate.icpAutonomy = {
    ...candidate.icpAutonomy,
    policyHolds: structuredClone(DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG.policyHolds),
  };
  addedPaths.push('icpAutonomy.policyHolds');
}

function addMissingBackgroundWorkMaxAttempts(
  candidate: Record<string, unknown>,
  addedPaths: string[],
): void {
  if (!isRecord(candidate.backgroundWork)
    || !isRecord(candidate.backgroundWork.postTurn)
    || candidate.backgroundWork.postTurn.maxAttempts !== undefined) return;
  candidate.backgroundWork = {
    ...candidate.backgroundWork,
    postTurn: {
      ...candidate.backgroundWork.postTurn,
      maxAttempts: DEFAULT_BACKGROUND_WORK_TUNING.postTurn.maxAttempts,
    },
  };
  addedPaths.push('backgroundWork.postTurn.maxAttempts');
}

function addMissingIntentionFollowUp(
  candidate: Record<string, unknown>,
  addedPaths: string[],
): void {
  if (candidate.intentionFollowUp !== undefined) return;
  candidate.intentionFollowUp = structuredClone(
    DEFAULT_INTENTION_FOLLOW_UP_SCHEDULER_CONFIG,
  );
  addedPaths.push('intentionFollowUp');
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

    if (hasLegacyInterval && raw.backgroundMaintenance !== undefined) {
      throw new Error(
        `Scheduler owner migration at ${filePath} refuses a mixed shape containing both `
        + 'backgroundMaintenance and retired cadence keys; resolve the ambiguous owner state manually',
      );
    }

    let candidate: Record<string, unknown>;
    let result: SchedulerOwnerMigrationResult;
    if (hasLegacyInterval) {
      const addedPaths: string[] = [];
      // The bundled cadence inherited the legacy salience-decay interval. If that
      // key is absent, the social-graph interval is the only available owner value.
      const selectedFrom = hasSalienceInterval
        ? 'salienceDecayIntervalMs'
        : 'socialGraphBuilder.intervalMs';
      const selectedInterval = hasSalienceInterval
        ? raw.salienceDecayIntervalMs
        : socialGraphBuilder?.intervalMs;
      candidate = structuredClone(raw);
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
      addMissingBackgroundWorkMaxAttempts(candidate, addedPaths);
      addMissingIcpPolicyHolds(candidate, addedPaths);
      addMissingIntentionFollowUp(candidate, addedPaths);

      const validated = validateSchedulerConfig(candidate, filePath);
      result = {
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
        ...(addedPaths.length > 0 ? { addedPaths } : {}),
      };
    } else {
      const backgroundMaintenance = raw.backgroundMaintenance;
      const addedPaths: string[] = [];
      candidate = structuredClone(raw);
      if (isRecord(backgroundMaintenance)
        && backgroundMaintenance.sharedWorldWikiCaretaker === undefined) {
        candidate.backgroundMaintenance = {
          ...backgroundMaintenance,
          sharedWorldWikiCaretaker: structuredClone(
            DEFAULT_BACKGROUND_MAINTENANCE_CONFIG.sharedWorldWikiCaretaker,
          ),
        };
        addedPaths.push('backgroundMaintenance.sharedWorldWikiCaretaker');
      }
      if (raw.backgroundWork === undefined) {
        candidate.backgroundWork = structuredClone(DEFAULT_BACKGROUND_WORK_TUNING);
        addedPaths.push('backgroundWork');
      }
      addMissingBackgroundWorkMaxAttempts(candidate, addedPaths);
      addMissingIcpPolicyHolds(candidate, addedPaths);
      addMissingIntentionFollowUp(candidate, addedPaths);
      if (addedPaths.length === 0) {
        validateSchedulerConfig(raw, filePath);
        assertSourceStillCurrent();
        return { mode, status: 'not_needed', filePath };
      }

      validateSchedulerConfig(candidate, filePath);
      result = {
        mode,
        status: options.apply ? 'applied' : 'planned',
        filePath,
        addedPaths,
      };
    }

    if (options.apply) {
      // Preserve every unrelated raw owner key. Validation above proves the
      // canonical projection is safe before this durable atomic publish occurs.
      writeFileDurableAtomicSync(
        pinnedLeafPath(dataDirectory, SCHEDULER_FILE_NAME),
        `${JSON.stringify(candidate, null, 2)}\n`,
        {
          mode: canonicalOwnerFileMode({
            ownerFileName: SCHEDULER_FILE_NAME,
            scope: 'companion',
          }),
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
