import {
  createDefaultEgressLeaseTunables,
  createDefaultParticipationAppraiserSettings,
  createDefaultPassiveNameCandidateSettings,
  createDefaultReservationPhaseSettings,
  createDefaultRoomParticipationLeaseSettings,
  createDefaultRoomSignalSettings,
  parseEgressLeaseTunables,
  parseParticipationAppraiserSettings,
  parsePassiveNameCandidateSettings,
  parseReservationPhaseSettings,
  parseRoomParticipationLeaseSettings,
  parseRoomSignalSettings,
  type EgressLeaseTunables,
  type ParticipationAppraiserSettings,
  type PassiveNameCandidateSettings,
  type ReservationPhaseSettings,
  type RoomParticipationLeaseSettings,
  type RoomSignalSettings,
} from '../participation-config.js';
import {
  createDefaultFreeTimeChooserSettings,
  parseFreeTimeChooserSettings,
  type FreeTimeChooserSettings,
} from '../free-time-chooser-config.js';

export {
  type EgressLeaseTunables,
  type ParticipationAppraiserSettings,
  type PassiveNameCandidateSettings,
  type ReservationPhaseSettings,
} from '../participation-config.js';
export { type FreeTimeChooserSettings } from '../free-time-chooser-config.js';
import { isRecord } from '../../../shared/utils/types.js';
import { assertNoUnknownKeys } from '../validators.js';

/**
 * Social-autonomy participation tunables (jp36.8.2). Homes the room-participation
 * gate knobs — passive-name candidate creation, the cheap participation
 * appraiser, the two-phase speaking arbiter (reservation + egress-lease), and the
 * free-time chooser (incl. the rest / silence-persistence window) — in the
 * per-companion scheduler owner file so they are Garden-editable via the raw
 * owner-file editor. Room egress is an explicit off/shadow/on posture; public
 * defaults remain off and the hardened arbiter remains the only on-path.
 */
export interface SocialAutonomyConfig {
  passiveNameCandidate: PassiveNameCandidateSettings;
  appraiser: ParticipationAppraiserSettings;
  reservationPhase: ReservationPhaseSettings;
  egressLease: EgressLeaseTunables;
  /**
   * Bounded durable room-participation lease (jp36.5.5): how long an engaged
   * companion may keep considering a running group conversation without the
   * room repeating its name. Public default off.
   */
  roomParticipationLease: RoomParticipationLeaseSettings;
  /**
   * Channel-neutral room signal (jp36.5.6): which room members may be
   * participated with contextually, the room-velocity ceiling, the reviewed
   * coarse topic vocabulary, and the optional shared ambiguity classifier.
   * Public default off.
   */
  roomSignal: RoomSignalSettings;
  freeTimeChooser: FreeTimeChooserSettings;
}

export function createDefaultSocialAutonomyConfig(): SocialAutonomyConfig {
  return {
    passiveNameCandidate: createDefaultPassiveNameCandidateSettings(),
    appraiser: createDefaultParticipationAppraiserSettings(),
    reservationPhase: createDefaultReservationPhaseSettings(),
    egressLease: createDefaultEgressLeaseTunables(),
    roomParticipationLease: createDefaultRoomParticipationLeaseSettings(),
    roomSignal: createDefaultRoomSignalSettings(),
    freeTimeChooser: createDefaultFreeTimeChooserSettings(),
  };
}

export const DEFAULT_SOCIAL_AUTONOMY_CONFIG: SocialAutonomyConfig =
  createDefaultSocialAutonomyConfig();

export function validateSocialAutonomyConfig(
  raw: unknown,
  sourcePath: string,
): SocialAutonomyConfig {
  if (raw === undefined) {
    return createDefaultSocialAutonomyConfig();
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: socialAutonomy must be an object`);
  }
  assertNoUnknownKeys(
    raw,
    [
      'passiveNameCandidate',
      'appraiser',
      'reservationPhase',
      'egressLease',
      'roomParticipationLease',
      'roomSignal',
      'freeTimeChooser',
    ],
    `${sourcePath}.socialAutonomy`,
    { errorPrefix: 'Invalid scheduler config' },
  );
  return {
    passiveNameCandidate: parsePassiveNameCandidateSettings(
      raw.passiveNameCandidate,
      `${sourcePath}.socialAutonomy.passiveNameCandidate`,
    ),
    appraiser: parseParticipationAppraiserSettings(
      raw.appraiser,
      `${sourcePath}.socialAutonomy.appraiser`,
    ),
    reservationPhase: parseReservationPhaseSettings(
      raw.reservationPhase,
      `${sourcePath}.socialAutonomy.reservationPhase`,
    ),
    egressLease: parseEgressLeaseTunables(
      raw.egressLease,
      `${sourcePath}.socialAutonomy.egressLease`,
    ),
    roomParticipationLease: parseRoomParticipationLeaseSettings(
      raw.roomParticipationLease,
      `${sourcePath}.socialAutonomy.roomParticipationLease`,
    ),
    roomSignal: parseRoomSignalSettings(
      raw.roomSignal,
      `${sourcePath}.socialAutonomy.roomSignal`,
    ),
    freeTimeChooser: parseFreeTimeChooserSettings(
      raw.freeTimeChooser,
      `${sourcePath}.socialAutonomy.freeTimeChooser`,
    ),
  };
}
