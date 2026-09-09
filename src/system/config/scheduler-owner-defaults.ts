// ── Additive scheduler owner-file defaults (bead psfn-framework-bxnyu) ──
//
// One source for every block a scheduler.json written before the current
// contract cannot carry. Two callers share it, and that sharing is the point:
//
//   * `migrate-scheduler-owner` (the chart's seed init container, and the
//     documented manual step) PERSISTS these values into the owner file.
//   * `loadSchedulerConfig` ADAPTS an owner file that still lacks them in
//     memory, warning by path, so a deployment that manages its owner files
//     outside the chart boots instead of failing closed on a key the file
//     could not have known about.
//
// Because both read this module, an owner file the init container would have
// written and one a process adapted at load carry byte-identical values by
// construction rather than by two lists agreeing with each other.
//
// Every function here is strictly additive: it seeds a canonical default only
// where the operator set nothing, and never rewrites a value they did set. A
// non-object where a block belongs is left alone — that is operator corruption,
// and validation must reject it with the real reason rather than have it
// silently overwritten.

import { isRecord } from '../../shared/utils/types.js';
import { createComponentLogger } from '../../shared/logger.js';
import { DEFAULT_BACKGROUND_WORK_TUNING } from './scheduler-config/background-work.js';
import { DEFAULT_BACKGROUND_MAINTENANCE_CONFIG } from './scheduler-config/maintenance.js';
import { DEFAULT_HEALTH_DETECTORS_CONFIG } from './scheduler-config/health-detectors.js';
import { DEFAULT_HUMAN_ESCALATION_CONFIG } from './scheduler-config/human-escalation.js';
import { DEFAULT_INTENTION_FOLLOW_UP_SCHEDULER_CONFIG } from './scheduler-config/intention-follow-up.js';
import { DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG } from './icp-autonomy-scheduler-config.js';
import {
  createDefaultRoomParticipationLeaseSettings,
  createDefaultRoomSignalSettings,
} from './participation-config.js';

const log = createComponentLogger('SchedulerOwnerDefaults');

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
 * The blocks seeded on EVERY scheduler owner shape, legacy cadence included.
 * Mutates `candidate` in place and returns the paths it added.
 */
export function seedMissingSchedulerOwnerBlocks(
  candidate: Record<string, unknown>,
  addedPaths: string[],
): string[] {
  addMissingBackgroundWorkMaxAttempts(candidate, addedPaths);
  addMissingIcpPolicyHolds(candidate, addedPaths);
  addMissingIntentionFollowUp(candidate, addedPaths);
  addMissingRoomParticipationLease(candidate, addedPaths);
  addMissingHealthDetectors(candidate, addedPaths);
  addMissingHumanEscalation(candidate, addedPaths);
  addMissingRoomSignal(candidate, addedPaths);
  return addedPaths;
}

/**
 * Everything {@link seedMissingSchedulerOwnerBlocks} seeds, plus the
 * background-maintenance and background-work blocks that only a
 * post-cadence-migration owner file can be missing. This is the complete
 * additive projection for an owner file already on the canonical
 * `backgroundMaintenance` shape.
 */
export function seedMissingSchedulerOwnerDefaults(
  candidate: Record<string, unknown>,
): string[] {
  const addedPaths: string[] = [];
  const backgroundMaintenance = candidate.backgroundMaintenance;
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
  if (candidate.backgroundWork === undefined) {
    candidate.backgroundWork = structuredClone(DEFAULT_BACKGROUND_WORK_TUNING);
    addedPaths.push('backgroundWork');
  }
  return seedMissingSchedulerOwnerBlocks(candidate, addedPaths);
}

/**
 * True when the owner file still carries the retired pre-bundled cadence keys.
 * That shape is a real migration with an ambiguity the CLI guards (a file
 * carrying BOTH a legacy cadence and `backgroundMaintenance` cannot be resolved
 * automatically), so the load-time adaptation declines it and lets validation
 * fail with its own reason.
 */
function hasRetiredSchedulerCadence(raw: Record<string, unknown>): boolean {
  if (raw.salienceDecayIntervalMs !== undefined) return true;
  const socialGraphBuilder = raw.socialGraphBuilder;
  return isRecord(socialGraphBuilder) && socialGraphBuilder.intervalMs !== undefined;
}

/** One warning per distinct (owner path, seeded path set) for the process. */
const warnedAdaptations = new Set<string>();

/** Test seam: the warn-once ledger is process-lifetime state. */
export function resetSchedulerOwnerAdaptationWarnings(): void {
  warnedAdaptations.clear();
}

/**
 * Adapt a raw scheduler owner payload to the current contract before it is
 * validated, warning by path.
 *
 * A deployment whose owner files are managed by the Helm chart has already had
 * these blocks written by the seed init container's `migrate-scheduler-owner`
 * step. One that manages them itself — bare docker, compose, a custom operator
 * — never runs it, and every process then refused to load scheduler.json on
 * upgrade: a crash loop, not a migration. The adaptation is in memory only,
 * because the fleet Garden mounts companion data read-only and every app
 * container runs a read-only root filesystem; the operator persists the same
 * values by running the documented migration.
 *
 * Content-free by construction: the warning names owner-file paths from this
 * module's own vocabulary and nothing from the file's contents.
 */
export function adaptSchedulerOwnerToCurrentContract(
  raw: unknown,
  sourcePath: string,
): unknown {
  if (!isRecord(raw)) return raw;
  if (hasRetiredSchedulerCadence(raw)) return raw;
  const candidate = structuredClone(raw) as Record<string, unknown>;
  const addedPaths = seedMissingSchedulerOwnerDefaults(candidate);
  if (addedPaths.length === 0) return raw;
  const warnKey = `${sourcePath} ${addedPaths.join(',')}`;
  if (!warnedAdaptations.has(warnKey)) {
    warnedAdaptations.add(warnKey);
    // The paths are this module's own vocabulary, so naming them in the message
    // is content-free — and it is the only way they survive into the operator's
    // diagnostic ring, which keeps warn messages but drops context keys outside
    // its allowlist.
    // The remedy and the paths lead, because the operator's diagnostic ring
    // truncates a long warn message and drops context keys outside its own
    // allowlist. The paths are this module's own vocabulary, so carrying them
    // in the message is content-free.
    log.warn(
      'Run migrate:scheduler-owner --apply; '
      + `${sourcePath} is using canonical defaults for missing blocks: `
      + addedPaths.join(', '),
      { ownerFile: sourcePath, adaptedPaths: addedPaths },
    );
  }
  return candidate;
}
