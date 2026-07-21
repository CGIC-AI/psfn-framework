import { describe, expect, it } from 'vitest';
import { createBearerCompanionRoutingConfig } from './bearer-companion-selector.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const COMPANION_C = '33333333-3333-4333-8333-333333333333';

describe('createBearerCompanionRoutingConfig', () => {
  it('keeps the selector absent when no pinned Bearer surface is configured', () => {
    expect(createBearerCompanionRoutingConfig({
      pinnedCompanionId: undefined,
      knownCompanionIds: [COMPANION_A],
      selectableCompanionIds: undefined,
    })).toBeUndefined();
  });

  it('builds a pinned routing contract with an explicit selector allowlist', () => {
    expect(createBearerCompanionRoutingConfig({
      pinnedCompanionId: COMPANION_A,
      knownCompanionIds: [COMPANION_A, COMPANION_B],
      selectableCompanionIds: [COMPANION_B],
    })).toEqual({
      pinnedCompanionId: COMPANION_A,
      knownCompanionIds: [COMPANION_A, COMPANION_B],
      selectableCompanionIds: [COMPANION_B],
    });
  });

  it('fails startup closed when an allowlisted target is outside the roster', () => {
    expect(() => createBearerCompanionRoutingConfig({
      pinnedCompanionId: COMPANION_A,
      knownCompanionIds: [COMPANION_A, COMPANION_B],
      selectableCompanionIds: [COMPANION_C],
    })).toThrow(`Selectable Bearer companion ${COMPANION_C} is not present in the companion roster`);
  });
});
