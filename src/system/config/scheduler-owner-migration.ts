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
  DEFAULT_HEALTH_DETECTORS_CONFIG,
  DEFAULT_HUMAN_ESCALATION_CONFIG,
  SCHEDULER_FILE_NAME,
  validateSchedulerConfig,
} from './scheduler-config.js';
import { DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG } from './icp-autonomy-scheduler-config.js';
import { DEFAULT_INTENTION_FOLLOW_UP_SCHEDULER_CONFIG } from './scheduler-config/intention-follow-up.js';
import {
  createDefaultRoomParticipationLeaseSettings,
  createDefaultRoomSignalSettings,
} from './participation-config.js';

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

/**
 * psfn-framework-nwtw1: an owner file written before the drain gained
 * dead-letter handling has `doingMirrorLetters.batchSize` but no quarantine
 * threshold. Seed the canonical default rather than failing an existing owner
 * file closed on a key it could not have known about.
 */
function addMissingDoingMirrorLetterQuarantine(
  candidate: Record<string, unknown>,
  addedPaths: string[],
): void {
  const backgroundMaintenance = candidate.backgroundMaintenance;
  if (!isRecord(backgroundMaintenance)) return;
  const doingMirrorLetters = backgroundMaintenance.doingMirrorLetters;
  if (!isRecord(doingMirrorLetters) || doingMirrorLetters.maxDeliveryFailures !== undefined) return;
  candidate.backgroundMaintenance = {
    ...backgroundMaintenance,
    doingMirrorLetters: {
      ...doingMirrorLetters,
      maxDeliveryFailures:
        DEFAULT_BACKGROUND_MAINTENANCE_CONFIG.doingMirrorLetters.maxDeliveryFailures,
    },
  };
  addedPaths.push('backgroundMaintenance.doingMirrorLetters.maxDeliveryFailures');
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
 * psfn-framework-jp36.5.5: an owner file written before bounded room-participation
 * continuation existed has a `socialAutonomy` block with no
 * `roomParticipationLease`. Seed the canonical default (continuation disabled)
 * rather than leaving the posture implicit, so the operator can see and edit the
 * knob in the owner file it belongs to.
 */
function addMissingRoomParticipationLease(
  candidate: Record<string, unknown>,
  addedPaths: string[],
): void {
  const socialAutonomy = candidate.socialAutonomy;
  if (!isRecord(socialAutonomy)
    || socialAutonomy.roomParticipationLease !== undefined) return;
  candidate.socialAutonomy = {
    ...socialAutonomy,
    roomParticipationLease: createDefaultRoomParticipationLeaseSettings(),
  };
  addedPaths.push('socialAutonomy.roomParticipationLease');
}

/**
 * psfn-framework-7qeo1.24.2-.4: an owner file written before the runtime health
 * detectors existed has no `healthDetectors` block, and one written between two
 * detector children has the block but not the newer child's sub-block. Both
 * would otherwise fail the owner file closed on a key it could not have known
 * about, so seed exactly the canonical defaults for whatever is absent and
 * leave every value the operator did set untouched.
 *
 * Seeding per top-level sub-key rather than replacing the block is what makes
 * this one function correct for every detector child: a later child adds its
 * sub-block to the canonical default and this migration picks it up with no
 * edit here.
 */
function addMissingHealthDetectors(
  candidate: Record<string, unknown>,
  addedPaths: string[],
): void {
  const existing = candidate.healthDetectors;
  if (existing === undefined) {
    candidate.healthDetectors = structuredClone(DEFAULT_HEALTH_DETECTORS_CONFIG);
    addedPaths.push('healthDetectors');
    return;
  }
  // A non-object here is operator corruption, not a missing key. Leave it for
  // validation to reject with the real reason rather than silently overwriting.
  if (!isRecord(existing)) return;
  const seeded: Record<string, unknown> = { ...existing };
  let changed = false;
  for (const [key, value] of Object.entries(DEFAULT_HEALTH_DETECTORS_CONFIG)) {
    if (seeded[key] !== undefined) continue;
    seeded[key] = structuredClone(value);
    addedPaths.push(`healthDetectors.${key}`);
    changed = true;
  }
  if (changed) {
    candidate.healthDetectors = seeded;
  }
}

/**
 * psfn-framework-bznbn: an owner file written before the human escalation
 * control plane existed has no `humanEscalation` block, and would otherwise
 * fail closed on a key it could not have known about. Seed the canonical
 * default — runtime incidents keep paging through the operator alert sink, the
 * other kinds stay on the Garden surface — and leave anything the operator did
 * set untouched.
 */
function addMissingHumanEscalation(
  candidate: Record<string, unknown>,
  addedPaths: string[],
): void {
  const existing = candidate.humanEscalation;
  if (existing === undefined) {
    candidate.humanEscalation = structuredClone(DEFAULT_HUMAN_ESCALATION_CONFIG);
    addedPaths.push('humanEscalation');
    return;
  }
  // A non-object here is operator corruption, not a missing key. Leave it for
  // validation to reject with the real reason rather than silently overwriting.
  if (!isRecord(existing)) return;
  // psfn-framework-yu03d added `retention` to a block operators already had.
  // Seed only the sub-keys an existing file could not have known about, and
  // leave everything the operator did set untouched.
  const seeded: Record<string, unknown> = { ...existing };
  let changed = false;
  for (const [key, value] of Object.entries(DEFAULT_HUMAN_ESCALATION_CONFIG)) {
    if (seeded[key] !== undefined) continue;
    seeded[key] = structuredClone(value);
    addedPaths.push(`humanEscalation.${key}`);
    changed = true;
  }
  if (changed) {
    candidate.humanEscalation = seeded;
  }
}

/**
 * psfn-framework-jp36.5.6: an owner file written before the channel-neutral room
 * signal existed has a `socialAutonomy` block with no `roomSignal`. Seed the
 * canonical default (signal disabled, no contextual room roles admitted) so the
 * operator can see and edit the admission policy in the owner file it belongs to.
 */
function addMissingRoomSignal(
  candidate: Record<string, unknown>,
  addedPaths: string[],
): void {
  const socialAutonomy = candidate.socialAutonomy;
  if (!isRecord(socialAutonomy) || socialAutonomy.roomSignal !== undefined) return;
  candidate.socialAutonomy = {
    ...socialAutonomy,
    roomSignal: createDefaultRoomSignalSettings(),
  };
  addedPaths.push('socialAutonomy.roomSignal');
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
      addMissingRoomParticipationLease(candidate, addedPaths);
      addMissingHealthDetectors(candidate, addedPaths);
      addMissingHumanEscalation(candidate, addedPaths);
      addMissingRoomSignal(candidate, addedPaths);

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
      const migratedBackgroundMaintenance = isRecord(candidate.backgroundMaintenance)
        ? candidate.backgroundMaintenance
        : backgroundMaintenance;
      if (isRecord(migratedBackgroundMaintenance)
        && migratedBackgroundMaintenance.doingMirrorLetters === undefined) {
        candidate.backgroundMaintenance = {
          ...migratedBackgroundMaintenance,
          doingMirrorLetters: structuredClone(
            DEFAULT_BACKGROUND_MAINTENANCE_CONFIG.doingMirrorLetters,
          ),
        };
        addedPaths.push('backgroundMaintenance.doingMirrorLetters');
      }
      addMissingDoingMirrorLetterQuarantine(candidate, addedPaths);
      if (raw.backgroundWork === undefined) {
        candidate.backgroundWork = structuredClone(DEFAULT_BACKGROUND_WORK_TUNING);
        addedPaths.push('backgroundWork');
      }
      addMissingBackgroundWorkMaxAttempts(candidate, addedPaths);
      addMissingIcpPolicyHolds(candidate, addedPaths);
      addMissingIntentionFollowUp(candidate, addedPaths);
      addMissingRoomParticipationLease(candidate, addedPaths);
      addMissingHealthDetectors(candidate, addedPaths);
      addMissingHumanEscalation(candidate, addedPaths);
      addMissingRoomSignal(candidate, addedPaths);
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
