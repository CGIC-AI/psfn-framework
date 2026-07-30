import type { FleetAuthAccountRosterEntry } from '../../system/config/fleet-auth-config.js';

/**
 * Deployment access-mode seam (operator ruling D1, 2026-07-30).
 *
 * SSO exists to unify auth across surfaces, never to gate the operator from
 * their own information. The seam is the boot-frozen account roster:
 *
 * - `sole_admin`: exactly one human (distinct provider subject) is rostered
 *   for the companion. Nothing is subject-gated for that admin; the only
 *   remaining barrier is the high-intimacy body escalation and the
 *   companion-privacy (break-glass) consent boundary.
 * - `multi_admin`: zero or two-plus rostered humans. Every admin sees
 *   everything except sensitive/intimate memories derived from OTHER humans'
 *   chats with the companion; those open only through an audited escalation.
 *
 * Zero roster entries fails closed to `multi_admin`: without a roster there is
 * no evidence the deployment has a single operator.
 */
export type FleetAccessMode = 'sole_admin' | 'multi_admin';

export function resolveFleetAccessMode(
  accountRoster: readonly FleetAuthAccountRosterEntry[] | undefined,
  companionId: string,
): FleetAccessMode {
  const subjects = new Set(
    (accountRoster ?? [])
      .filter(entry => entry.companionId === companionId)
      .map(entry => entry.providerSubjectId),
  );
  return subjects.size === 1 ? 'sole_admin' : 'multi_admin';
}
