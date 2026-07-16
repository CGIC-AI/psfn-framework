import { describe, expect, it } from 'vitest';
import { parseProviderRecoveryArgs } from './create-provider-recovery.js';

const exact = [
  '--companion-id', '11111111-1111-4111-8111-111111111111',
  '--principal-id', '22222222-2222-4222-8222-222222222222',
  '--current-provider-subject', '123456789012345678',
  '--current-provider-version', '7',
  '--new-provider-subject', '223456789012345678',
  '--reason', 'current subject unavailable',
  '--expires-at', '2026-07-16T23:59:00.000Z',
];

describe('trusted-host provider recovery CLI', () => {
  it('requires the exact pre-bound ceremony inputs', () => {
    expect(parseProviderRecoveryArgs(exact)).toMatchObject({
      currentProviderAuthorityGeneration: 7,
      currentProviderSubjectId: '123456789012345678',
      expectedNewProviderSubjectId: '223456789012345678',
    });
  });

  it.each([
    [...exact, '--ADMIN_TOKEN', 'legacy'],
    [...exact, '--psfn_token', 'legacy'],
    exact.filter(value => value !== '--reason' && value !== 'current subject unavailable'),
    [...exact.slice(0, -1), 'not-an-iso-timestamp'],
  ])('rejects legacy, missing, or malformed authority arguments', candidate => {
    expect(() => parseProviderRecoveryArgs(candidate)).toThrow();
  });
});
