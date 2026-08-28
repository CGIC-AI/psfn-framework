import {
  createDefaultEgressLeaseTunables,
  createDefaultParticipationAppraiserSettings,
  createDefaultPassiveNameCandidateSettings,
  createDefaultReservationPhaseSettings,
  parseEgressLeaseTunables,
  parseParticipationAppraiserSettings,
  parsePassiveNameCandidateSettings,
  parseReservationPhaseSettings,
  type EgressLeaseTunables,
  type ParticipationAppraiserSettings,
  type PassiveNameCandidateSettings,
  type ReservationPhaseSettings,
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
  freeTimeChooser: FreeTimeChooserSettings;
}

export function createDefaultSocialAutonomyConfig(): SocialAutonomyConfig {
  return {
    passiveNameCandidate: createDefaultPassiveNameCandidateSettings(),
    appraiser: createDefaultParticipationAppraiserSettings(),
    reservationPhase: createDefaultReservationPhaseSettings(),
    egressLease: createDefaultEgressLeaseTunables(),
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
    ['passiveNameCandidate', 'appraiser', 'reservationPhase', 'egressLease', 'freeTimeChooser'],
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
    freeTimeChooser: parseFreeTimeChooserSettings(
      raw.freeTimeChooser,
      `${sourcePath}.socialAutonomy.freeTimeChooser`,
    ),
  };
}
