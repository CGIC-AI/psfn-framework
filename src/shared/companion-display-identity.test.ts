import { describe, expect, it } from 'vitest';
import {
  createCompanionDisplayIdentityResolver,
  UNKNOWN_COMPANION_DISPLAY_NAME,
} from './companion-display-identity.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const COMPANION_C = '33333333-3333-4333-8333-333333333333';

describe('companion display identity resolver', () => {
  it('uses the canonical roster displayName as the primary label and retains the exact id', () => {
    const resolver = createCompanionDisplayIdentityResolver([
      { companionId: COMPANION_A, displayName: '  Nova  ' },
    ]);

    expect(resolver.resolve(COMPANION_A)).toEqual({
      companionId: COMPANION_A,
      displayName: 'Nova',
      displayLabel: 'Nova',
      technicalLabel: `Companion ID ${COMPANION_A}`,
      known: true,
    });
  });

  it('labels an unknown id honestly while retaining safe technical detail', () => {
    const resolver = createCompanionDisplayIdentityResolver([]);

    expect(resolver.resolve(COMPANION_C)).toEqual({
      companionId: COMPANION_C,
      displayName: UNKNOWN_COMPANION_DISPLAY_NAME,
      displayLabel: 'Unknown companion · 33333333',
      technicalLabel: `Companion ID ${COMPANION_C}`,
      known: false,
    });
  });

  it('keeps duplicate canonical names distinguishable without replacing either name with an id', () => {
    const resolver = createCompanionDisplayIdentityResolver([
      { companionId: COMPANION_A, displayName: 'Nova' },
      { companionId: COMPANION_B, displayName: ' nova ' },
    ]);

    const first = resolver.resolve(COMPANION_A);
    const second = resolver.resolve(COMPANION_B);
    expect(first.displayName).toBe('Nova');
    expect(second.displayName).toBe('nova');
    expect(first.displayLabel).toBe('Nova · 11111111');
    expect(second.displayLabel).toBe('nova · 22222222');
    expect(first.displayLabel).not.toBe(second.displayLabel);
  });

  it('extends the technical suffix when colliding names also share an id prefix', () => {
    const resolver = createCompanionDisplayIdentityResolver([
      { companionId: '11111111-1111-4111-8111-111111111111', displayName: 'Nova' },
      { companionId: '11111111-2222-4222-8222-222222222222', displayName: 'Nova' },
    ]);

    expect(resolver.resolve('11111111-1111-4111-8111-111111111111').displayLabel)
      .toBe('Nova · 11111111-1');
    expect(resolver.resolve('11111111-2222-4222-8222-222222222222').displayLabel)
      .toBe('Nova · 11111111-2');
  });

  it('treats a roster entry without a usable name as explicitly unknown', () => {
    const resolver = createCompanionDisplayIdentityResolver([
      { companionId: COMPANION_A },
    ]);

    expect(resolver.resolve(COMPANION_A)).toMatchObject({
      displayName: UNKNOWN_COMPANION_DISPLAY_NAME,
      displayLabel: 'Unknown companion · 11111111',
      known: false,
    });
  });

  it('keeps multiple newly encountered unknown ids distinguishable', () => {
    const resolver = createCompanionDisplayIdentityResolver([]);
    const identities = resolver.resolveMany([
      '33333333-1111-4111-8111-111111111111',
      '33333333-2222-4222-8222-222222222222',
    ]);

    expect(Object.values(identities).map(identity => identity.displayLabel)).toEqual([
      'Unknown companion · 33333333-1',
      'Unknown companion · 33333333-2',
    ]);
  });
});
