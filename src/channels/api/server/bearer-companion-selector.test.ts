import { describe, expect, it } from 'vitest';
import { createBearerCompanionRoutingConfig, resolveBearerCompanionTarget } from './bearer-companion-selector.js';

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

// psfn-framework-gz50o: the dedicated testing-harness principal may target any
// operator-selectable fleet companion; everything else about selection stays
// fail closed.
describe('resolveBearerCompanionTarget', () => {
  const routing = {
    pinnedCompanionId: COMPANION_A,
    knownCompanionIds: [COMPANION_A, COMPANION_B],
    selectableCompanionIds: [COMPANION_A, COMPANION_B],
  };
  const harness = { id: 'testing-harness', mode: 'api_key', scope: 'testing_harness' } as const;

  it('routes the testing-harness principal to a selectable follower', () => {
    expect(resolveBearerCompanionTarget({ requestedCompanionId: COMPANION_B, principal: harness, routing }))
      .toEqual({ ok: true, companionId: COMPANION_B });
  });

  it('keeps the harness pinned when it sends no selector', () => {
    expect(resolveBearerCompanionTarget({ requestedCompanionId: undefined, principal: harness, routing }))
      .toEqual({ ok: true, companionId: COMPANION_A });
  });

  it.each([
    ['an unknown companion', COMPANION_C, routing, 404, 'bearer_companion_not_found'],
    ['a known but unselectable companion', COMPANION_B,
      { ...routing, selectableCompanionIds: [COMPANION_A] }, 403, 'bearer_companion_unauthorized'],
    ['a deployment with selection disabled', COMPANION_B,
      { pinnedCompanionId: COMPANION_A, knownCompanionIds: [COMPANION_A, COMPANION_B] },
      403, 'bearer_companion_selector_disabled'],
  ] as const)('refuses the harness for %s', (_label, requested, routingConfig, status, type) => {
    expect(resolveBearerCompanionTarget({ requestedCompanionId: requested, principal: harness, routing: routingConfig }))
      .toMatchObject({ ok: false, status, type });
  });

  it('keeps satellite principals pinned', () => {
    expect(resolveBearerCompanionTarget({
      requestedCompanionId: COMPANION_B,
      principal: { id: 'satellite-1', mode: 'api_key', scope: 'satellite' },
      routing,
    })).toMatchObject({ ok: false, status: 403, type: 'bearer_companion_unauthorized' });
  });
});
