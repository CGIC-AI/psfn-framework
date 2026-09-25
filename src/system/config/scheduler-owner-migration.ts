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
  createDefaultParticipationAppraiserSettings,
  RETIRED_APPRAISAL_DEADLINE_MS,
  RETIRED_APPRAISAL_MAX_OUTPUT_TOKENS,
} from './participation-config.js';
import {
  DEFAULT_BACKGROUND_MAINTENANCE_CONFIG,
  SCHEDULER_FILE_NAME,
  validateSchedulerConfig,
} from './scheduler-config.js';
// psfn-framework-bxnyu: the additive block seeding is shared with the
// load-time adaptation in `scheduler-owner-defaults.ts`, so what this CLI
// persists and what a process boots with can never drift apart.
import {
  seedMissingSchedulerOwnerBlocks,
  seedMissingSchedulerOwnerDefaults,
} from './scheduler-owner-defaults.js';

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
  /** Paths whose value was the retired shipped default and now carries the current one. */
  upgradedPaths?: string[];
}

/**
 * psfn-framework-0eq2x: shipped defaults that proved wrong for real models.
 * An owner file still carrying EXACTLY the retired seed value never chose it —
 * it inherited it from the seed — so the migration moves it to the current
 * default. Any other operator value is left untouched.
 */
const RETIRED_SCHEDULER_DEFAULTS: ReadonlyArray<{
  path: readonly [string, string, string];
  retired: number;
  current: () => number;
}> = [{
  path: ['socialAutonomy', 'appraiser', 'appraisalDeadlineMs'],
  retired: RETIRED_APPRAISAL_DEADLINE_MS,
  current: () => createDefaultParticipationAppraiserSettings().appraisalDeadlineMs,
}, {
  // psfn-framework-9z2z9: reasoning tokens exhausted the seeded 200.
  path: ['socialAutonomy', 'appraiser', 'appraisalMaxOutputTokens'],
  retired: RETIRED_APPRAISAL_MAX_OUTPUT_TOKENS,
  current: () => createDefaultParticipationAppraiserSettings().appraisalMaxOutputTokens,
}];

function upgradeRetiredSchedulerDefaults(
  candidate: Record<string, unknown>,
  upgradedPaths: string[],
): void {
  for (const entry of RETIRED_SCHEDULER_DEFAULTS) {
    const [outer, inner, leaf] = entry.path;
    const outerBlock = candidate[outer];
    if (!isRecord(outerBlock)) continue;
    const innerBlock = outerBlock[inner];
    if (!isRecord(innerBlock) || innerBlock[leaf] !== entry.retired) continue;
    candidate[outer] = { ...outerBlock, [inner]: { ...innerBlock, [leaf]: entry.current() } };
    upgradedPaths.push(entry.path.join('.'));
  }
}

/**
 * psfn-framework-c4twp / cziwg: owner keys retired because nothing consumed them. The
 * migration removes exactly these paths and leaves every sibling untouched.
 */
function removeRetiredSchedulerOwnerKeys(
  candidate: Record<string, unknown>,
  removedPaths: string[],
): void {
  const temporalWakeup = candidate.temporalWakeup;
  if (isRecord(temporalWakeup) && temporalWakeup.wakeSummary !== undefined) {
    const next = { ...temporalWakeup };
    delete next.wakeSummary;
    candidate.temporalWakeup = next;
    removedPaths.push('temporalWakeup.wakeSummary');
  }
  // psfn-framework-cziwg: artifactLifecycle lost its only reader.
  if (candidate.artifactLifecycle !== undefined) {
    delete candidate.artifactLifecycle;
    removedPaths.push('artifactLifecycle');
  }
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
      seedMissingSchedulerOwnerBlocks(candidate, addedPaths);
      const retiredPaths: string[] = [];
      removeRetiredSchedulerOwnerKeys(candidate, retiredPaths);
      const upgradedPaths: string[] = [];
      upgradeRetiredSchedulerDefaults(candidate, upgradedPaths);

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
          ...retiredPaths,
        ],
        ...(addedPaths.length > 0 ? { addedPaths } : {}),
        ...(upgradedPaths.length > 0 ? { upgradedPaths } : {}),
      };
    } else {
      candidate = structuredClone(raw);
      const removedPaths: string[] = [];
      removeRetiredSchedulerOwnerKeys(candidate, removedPaths);
      const addedPaths = seedMissingSchedulerOwnerDefaults(candidate);
      const upgradedPaths: string[] = [];
      upgradeRetiredSchedulerDefaults(candidate, upgradedPaths);
      if (addedPaths.length === 0 && removedPaths.length === 0 && upgradedPaths.length === 0) {
        validateSchedulerConfig(raw, filePath);
        assertSourceStillCurrent();
        return { mode, status: 'not_needed', filePath };
      }

      validateSchedulerConfig(candidate, filePath);
      result = {
        mode,
        status: options.apply ? 'applied' : 'planned',
        filePath,
        ...(addedPaths.length > 0 ? { addedPaths } : {}),
        ...(removedPaths.length > 0 ? { removedPaths } : {}),
        ...(upgradedPaths.length > 0 ? { upgradedPaths } : {}),
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
