import { describe, expect, it } from 'vitest';
import { resolveFleetAccessMode } from './fleet-access-mode.js';
import type { FleetAuthAccountRosterEntry } from '../../system/config/fleet-auth-config.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '388908766306893800';
const SECOND_ADMIN = '662789124608229300';

function entry(
  providerSubjectId: string,
  companionId: string,
  role: FleetAuthAccountRosterEntry['role'] = 'owner',
): FleetAuthAccountRosterEntry {
  return { providerSubjectId, companionId, role };
}

describe('resolveFleetAccessMode (D1 access-mode seam)', () => {
  it('resolves sole_admin for exactly one rostered human on the companion', () => {
    expect(resolveFleetAccessMode([entry(OPERATOR, COMPANION_A)], COMPANION_A))
      .toBe('sole_admin');
  });

  it('stays sole_admin when the same human is rostered for other companions too', () => {
    const roster = [
      entry(OPERATOR, COMPANION_A),
      entry(OPERATOR, COMPANION_B),
      entry(SECOND_ADMIN, COMPANION_B, 'admin'),
    ];
    expect(resolveFleetAccessMode(roster, COMPANION_A)).toBe('sole_admin');
  });

  it('resolves multi_admin when two distinct humans are rostered for the companion', () => {
    const roster = [
      entry(OPERATOR, COMPANION_A),
      entry(SECOND_ADMIN, COMPANION_A, 'admin'),
    ];
    expect(resolveFleetAccessMode(roster, COMPANION_A)).toBe('multi_admin');
  });

  it('fails closed to multi_admin with no roster entries for the companion', () => {
    expect(resolveFleetAccessMode([entry(OPERATOR, COMPANION_B)], COMPANION_A))
      .toBe('multi_admin');
    expect(resolveFleetAccessMode([], COMPANION_A)).toBe('multi_admin');
    expect(resolveFleetAccessMode(undefined, COMPANION_A)).toBe('multi_admin');
  });

  it('deduplicates repeated roster rows for the same human', () => {
    const roster = [
      entry(OPERATOR, COMPANION_A),
      entry(OPERATOR, COMPANION_A, 'admin'),
    ];
    expect(resolveFleetAccessMode(roster, COMPANION_A)).toBe('sole_admin');
  });
});
