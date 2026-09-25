import { getAllowedSensitivities } from '../../system/trust/policy.js';
import type { ChannelDisclosureContext } from '../../system/trust/policy.js';
import type { SensitivityLevel, TrustLevel } from '../../system/trust/types.js';
import type { ActiveConcern } from '../../shared/contracts/intention-contracts.js';

/**
 * Viewer gate for the runtime-attention open threads (psfn-framework-xz8m1).
 *
 * Active concerns are companion state formed in many conversations. The
 * open-threads block rendered them into every turn, so a public stranger in a
 * fresh room saw threads the memory and session tools correctly withheld.
 * A thread renders only when the viewer's trust ceiling and the current
 * room's disclosure envelope admit its sensitivity (the same
 * getAllowedSensitivities policy memory retrieval uses) and, below primary
 * trust, only when it is companion-wide or belongs to the current contact.
 * Redacted threads never render.
 */

export interface ConcernViewer {
  trustLevel: TrustLevel;
  channelDisclosure: ChannelDisclosureContext;
  /** Canonical contact of the current conversation, when resolved. */
  canonicalContactKey?: string;
}

function isSensitivityLevel(value: string): value is SensitivityLevel {
  return value === 'public' || value === 'personal' || value === 'intimate' || value === 'confidential';
}

export function filterConcernsForViewer(
  concerns: readonly ActiveConcern[],
  viewer: ConcernViewer,
): ActiveConcern[] {
  const allowed = new Set<string>(getAllowedSensitivities(viewer.trustLevel, viewer.channelDisclosure));
  const admits = (sensitivity: string | undefined): boolean => (
    sensitivity === undefined || (isSensitivityLevel(sensitivity) && allowed.has(sensitivity))
  );
  return concerns.filter((concern) => {
    if (!isSensitivityLevel(concern.sensitivity) || !allowed.has(concern.sensitivity)) return false;
    if (!concern.evidenceRefs.every(ref => ref.redacted !== true && admits(ref.sensitivity))) return false;
    if (concern.contactId === undefined || viewer.trustLevel === 'primary') return true;
    return concern.contactId === viewer.canonicalContactKey;
  });
}
