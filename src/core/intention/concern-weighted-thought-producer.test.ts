import { describe, expect, it } from 'vitest';
import type { ActiveConcern, ActiveConcernVAD } from '../../shared/contracts/intention-contracts.js';
import type { ConcernResolutionAppraisalEvent } from './concern-resolution-appraisal.js';
import {
  concernWeightedThoughtId,
  recordConcernWeightedThoughts,
  type ConcernCandidateReviewedEvent,
} from './concern-weighted-thought-producer.js';
import { applyWeightedThoughtContradictionDampening } from './weighted-thought-contradiction.js';
import {
  createInMemoryWeightedThoughtBackend,
  createWeightedThoughtStorePort,
  recordWeightedThought,
} from './weighted-thought-store-port.js';
import { decayedWeight, type WeightedThoughtLifecycleConfig } from './weighted-thoughts.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-07-02T12:00:00.000Z');

const CONFIG: WeightedThoughtLifecycleConfig = {
  classes: {
    time_sensitive: { baseWeight: 0.5, halflifeMs: 6 * HOUR },
    standard: { baseWeight: 0.4, halflifeMs: 24 * HOUR },
    trivial: { baseWeight: 0.2, halflifeMs: 72 * HOUR },
  },
  reinforcement: { repeatBoost: 0.5, emotionalChargeWeight: 1 },
  accumulatedWeightCap: 3,
  contradictionDampeningFactor: 0.6,
  declineDampeningFactor: 0.5,
  relevanceFloor: 0.05,
};

const vad = (valence: number, arousal = 0.4, dominance = 0.1): ActiveConcernVAD => ({
  valence,
  arousal,
  dominance,
});

function stubConcern(overrides: Partial<ActiveConcern> = {}): ActiveConcern {
  return {
    id: 'concern-1',
    text: 'Morgan seemed stressed about the move',
    priority: 'medium',
    source: 'appraisal',
    status: 'active',
    createdAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 72 * HOUR).toISOString(),
    salience: 0.5,
    sensitivity: 'normal',
    owner: 'companion',
    evidenceRefs: [],
    resolutionEvidenceRefs: [],
    contactId: 'contact-v',
    formationVAD: vad(-0.4),
    ...overrides,
  } as ActiveConcern;
}

function reviewedEvent(
  outcomes: ConcernCandidateReviewedEvent['outcomes'],
): ConcernCandidateReviewedEvent {
  return {
    candidateCount: outcomes.length,
    outcomeCount: outcomes.length,
    outcomes,
    timestamp: T0,
  };
}

function outcome(
  overrides: Partial<ConcernCandidateReviewedEvent['outcomes'][number]> = {},
): ConcernCandidateReviewedEvent['outcomes'][number] {
  return {
    candidateId: 'candidate-1',
    action: 'create',
    status: 'created',
    reason: 'a live open thread',
    concernId: 'concern-1',
    ...overrides,
  };
}

function createStore() {
  return createWeightedThoughtStorePort(createInMemoryWeightedThoughtBackend());
}

function concernSource(concerns: readonly ActiveConcern[]) {
  return {
    getById: (id: string) => concerns.find(concern => concern.id === id) ?? null,
  };
}

describe('recordConcernWeightedThoughts (psfn-framework-99ugi producer)', () => {
  it('stamps the concern id as live provenance on the thought it creates', async () => {
    const concern = stubConcern();
    const thoughtStore = createStore();

    const result = await recordConcernWeightedThoughts({
      concernStore: concernSource([concern]),
      thoughtStore,
      lifecycleConfig: CONFIG,
      now: () => T0,
    }, reviewedEvent([outcome()]));

    expect(result.recordedThoughtIds).toEqual([concernWeightedThoughtId('concern-1')]);
    const thought = await thoughtStore.getById(concernWeightedThoughtId('concern-1'));
    expect(thought).toMatchObject({
      contactId: 'contact-v',
      source: 'concern',
      thoughtClass: 'standard',
      nudgeState: 'pending',
    });
    // The field the concern-scoped dampening filter matches on.
    expect(thought?.provenance.concernId).toBe('concern-1');
    expect(thought?.provenance.personalProjectId).toBeUndefined();
  });

  it('carries the concern\'s ICP initiation root when it has one', async () => {
    const thoughtStore = createStore();
    await recordConcernWeightedThoughts({
      concernStore: concernSource([stubConcern({ originIcpRootInitiationId: 'icp-root-1' })]),
      thoughtStore,
      lifecycleConfig: CONFIG,
      now: () => T0,
    }, reviewedEvent([outcome()]));

    const thought = await thoughtStore.getById(concernWeightedThoughtId('concern-1'));
    expect(thought?.provenance.icpRootInitiationId).toBe('icp-root-1');
  });

  it('records one thought per merged concern too, since a merge revives a live concern', async () => {
    const thoughtStore = createStore();
    const result = await recordConcernWeightedThoughts({
      concernStore: concernSource([
        stubConcern(),
        stubConcern({ id: 'concern-2', text: 'A second live thread' }),
      ]),
      thoughtStore,
      lifecycleConfig: CONFIG,
      now: () => T0,
    }, reviewedEvent([
      outcome(),
      outcome({ candidateId: 'candidate-2', action: 'merge', status: 'merged', concernId: 'concern-2' }),
    ]));

    expect(result.recordedThoughtIds).toEqual([
      concernWeightedThoughtId('concern-1'),
      concernWeightedThoughtId('concern-2'),
    ]);
  });

  it('records nothing for review outcomes that did not produce a live concern', async () => {
    const thoughtStore = createStore();
    const result = await recordConcernWeightedThoughts({
      concernStore: concernSource([stubConcern()]),
      thoughtStore,
      lifecycleConfig: CONFIG,
      now: () => T0,
    }, reviewedEvent([
      outcome({ action: 'reject', status: 'rejected', concernId: undefined }),
      outcome({ candidateId: 'c2', action: 'defer', status: 'deferred', concernId: undefined }),
      outcome({ candidateId: 'c3', action: 'route', status: 'routed', concernId: undefined }),
      outcome({ candidateId: 'c4', action: 'create', status: 'blocked', concernId: undefined }),
    ]));

    expect(result.recordedThoughtIds).toEqual([]);
  });

  it('fails closed on a concern that vanished, went terminal, or has no contact', async () => {
    const thoughtStore = createStore();
    const result = await recordConcernWeightedThoughts({
      concernStore: concernSource([
        stubConcern({ id: 'concern-resolved', status: 'resolved' }),
        stubConcern({ id: 'concern-global', contactId: undefined }),
      ]),
      thoughtStore,
      lifecycleConfig: CONFIG,
      now: () => T0,
    }, reviewedEvent([
      outcome({ candidateId: 'c1', concernId: 'concern-missing' }),
      outcome({ candidateId: 'c2', concernId: 'concern-resolved' }),
      outcome({ candidateId: 'c3', concernId: 'concern-global' }),
    ]));

    expect(result.recordedThoughtIds).toEqual([]);
  });

  it('reinforces the same concern\'s thought instead of forking a duplicate', async () => {
    const thoughtStore = createStore();
    const deps = {
      concernStore: concernSource([stubConcern()]),
      thoughtStore,
      lifecycleConfig: CONFIG,
      now: () => T0,
    };
    await recordConcernWeightedThoughts(deps, reviewedEvent([outcome()]));
    const first = await thoughtStore.getById(concernWeightedThoughtId('concern-1'));
    await recordConcernWeightedThoughts(deps, reviewedEvent([outcome({ candidateId: 'candidate-2' })]));

    const rows = await thoughtStore.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reinforcementCount).toBe(1);
    expect(rows[0]?.accumulatedWeight).toBeGreaterThan(first!.accumulatedWeight);
  });
});

describe('producer through concern-scoped contradiction dampening (end to end)', () => {
  it('damps exactly the contradicted concern\'s produced thought', async () => {
    const thoughtStore = createStore();
    const contradicted = stubConcern({ id: 'concern-contradicted' });
    const other = stubConcern({ id: 'concern-other', text: 'A different open thread' });

    // Both concerns reach the weighted-thought lifecycle through the real
    // producer — no hand-written provenance anywhere in this test.
    await recordConcernWeightedThoughts({
      concernStore: concernSource([contradicted, other]),
      thoughtStore,
      lifecycleConfig: CONFIG,
      now: () => T0,
    }, reviewedEvent([
      outcome({ candidateId: 'c1', concernId: 'concern-contradicted' }),
      outcome({ candidateId: 'c2', concernId: 'concern-other' }),
    ]));
    // ...alongside a same-contact personal-project thought, which no concern
    // resolution may ever touch.
    await recordWeightedThought(thoughtStore, CONFIG, {
      id: 'personal-project:proj-1',
      content: 'Return to the pier photo series',
      source: 'personal_project',
      thoughtClass: 'standard',
      contactId: 'contact-v',
      provenance: { personalProjectId: 'proj-1' },
    }, T0);

    const before = new Map(
      (await thoughtStore.list()).map(thought => [thought.id, thought.accumulatedWeight]),
    );

    const resolved: ActiveConcern = {
      ...contradicted,
      status: 'resolved',
      resolutionVAD: vad(-0.5),
      resolutionGenerationId: 'gen-1',
    } as ActiveConcern;
    const event: ConcernResolutionAppraisalEvent = {
      concernId: resolved.id,
      resolutionGenerationId: 'gen-1',
      source: 'decision',
      formationVad: resolved.formationVAD!,
      resolutionVad: resolved.resolutionVAD!,
      reliefDelta: { valence: -0.1, arousal: 0, dominance: 0 },
      timestamp: T0,
    };

    const result = await applyWeightedThoughtContradictionDampening({
      concernStore: concernSource([resolved, other]),
      thoughtStore,
      lifecycleConfig: CONFIG,
      now: () => T0,
    }, event);

    expect(result.contradiction).toBe(true);
    expect(result.dampenedThoughtIds).toEqual([
      concernWeightedThoughtId('concern-contradicted'),
    ]);

    const after = await thoughtStore.list();
    const dampened = after.find(
      thought => thought.id === concernWeightedThoughtId('concern-contradicted'),
    )!;
    // Reduced, never zeroed (charter 6.24).
    expect(dampened.accumulatedWeight).toBeLessThan(before.get(dampened.id)!);
    expect(decayedWeight(dampened, T0)).toBeGreaterThan(0);
    for (const untouched of ['concern:concern-other', 'personal-project:proj-1']) {
      const thought = after.find(row => row.id === untouched)!;
      expect(thought.accumulatedWeight).toBe(before.get(untouched));
    }
  });
});
