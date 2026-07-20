import { beforeEach, describe, it, expect, vi } from 'vitest';

const logSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../shared/logger.js', () => ({
  createComponentLogger: () => logSpies,
}));

import type { Contact } from './types.js';
import type { EmotionalTimeSeriesPoint } from './store/emotional-baseline.js';
import type {
  DyadRelationshipAdvisory,
  DyadRelationshipAdvisoryProvider,
} from '../../shared/contracts/dyad-relationship-advisory.js';
import { DyadRelationshipAdvisoryUnavailableError } from '../../shared/contracts/dyad-relationship-advisory.js';
import {
  CONTACT_TRUST_DRIFT_REVIEW_ACTION_KIND,
  CONTACT_TRUST_DRIFT_REVIEW_PROCESSOR,
  ContactTrustDriftReviewLane,
  type ContactTrustDriftReviewStore,
} from './trust-drift-review-lane.js';

const ADVISORY: DyadRelationshipAdvisory = {
  prose: 'Your background affect model reads warmth as clearly warm.',
  provenance: { source: 'classifier_inferred', classifier: 'emo_sim' },
  observedAtMs: 1_000,
};

function advisoryProvider(
  impl: () => Promise<DyadRelationshipAdvisory | null>,
): DyadRelationshipAdvisoryProvider {
  return { describeLatestDirectedRelationship: impl };
}

// Rest window: 02:00-05:00 UTC. "Inside" and "outside" instants below are
// fixed epochs on 2026-07-07.
const REST_WINDOW = {
  enabled: true,
  startLocalTime: '02:00',
  endLocalTime: '05:00',
  timeZone: 'UTC',
  inactivityThresholdMinutes: 45,
};
const INSIDE_WINDOW_MS = Date.parse('2026-07-07T03:00:00.000Z');
const OUTSIDE_WINDOW_MS = Date.parse('2026-07-07T12:00:00.000Z');

function fixtureContact(overrides: Partial<Contact> & { id: string }): Contact {
  return {
    displayName: `Fixture ${overrides.id}`,
    trustLevel: 'public',
    relationshipType: 'stranger',
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function point(valence: number): EmotionalTimeSeriesPoint {
  return { valence, confidence: 0.8, observedAtMs: 1_000 };
}

function fakeStore(options: {
  contacts?: Contact[];
  timeSeriesByContact?: Record<string, EmotionalTimeSeriesPoint[]>;
  verifiedLinksByContact?: Record<string, number>;
  watermark?: string;
}): ContactTrustDriftReviewStore & { watermarks: Map<string, string> } {
  const watermarks = new Map<string, string>();
  if (options.watermark) {
    watermarks.set(CONTACT_TRUST_DRIFT_REVIEW_PROCESSOR, options.watermark);
  }
  return {
    watermarks,
    listAll: () => options.contacts ?? [],
    getEmotionalTimeSeries: (id) => options.timeSeriesByContact?.[id] ?? [],
    countVerifiedIdentityLinks: (id) => options.verifiedLinksByContact?.[id] ?? 0,
    getContactMaintenanceWatermark: (processor) => watermarks.get(processor),
    setContactMaintenanceWatermark: (processor, lastRunAt) => {
      watermarks.set(processor, lastRunAt);
    },
  };
}

const PROMOTABLE_SERIES = [point(0.4), point(0.3), point(0.25)];

beforeEach(() => {
  logSpies.info.mockClear();
  logSpies.warn.mockClear();
});

describe('ContactTrustDriftReviewLane construction', () => {
  it('fails closed without a rest window', () => {
    expect(() => new ContactTrustDriftReviewLane({
      contactStore: fakeStore({}),
      restWindow: undefined as never,
      deliverReview: () => {},
    })).toThrow(/rest-window/);
  });

  it('fails closed without a delivery hook', () => {
    expect(() => new ContactTrustDriftReviewLane({
      contactStore: fakeStore({}),
      restWindow: REST_WINDOW,
      deliverReview: undefined as never,
    })).toThrow(/deliverReview/);
  });
});

describe('inferIdleActions', () => {
  it('emits one daily action inside the rest window', async () => {
    const lane = new ContactTrustDriftReviewLane({
      contactStore: fakeStore({}),
      restWindow: REST_WINDOW,
      deliverReview: () => {},
      now: () => INSIDE_WINDOW_MS,
    });
    const actions = await lane.inferIdleActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe(CONTACT_TRUST_DRIFT_REVIEW_ACTION_KIND);
    expect(actions[0]?.dedupeKey).toBe(`${CONTACT_TRUST_DRIFT_REVIEW_ACTION_KIND}:2026-07-07`);
  });

  it('stays silent outside the rest window', async () => {
    const lane = new ContactTrustDriftReviewLane({
      contactStore: fakeStore({}),
      restWindow: REST_WINDOW,
      deliverReview: () => {},
      now: () => OUTSIDE_WINDOW_MS,
    });
    expect(await lane.inferIdleActions()).toHaveLength(0);
  });

  it('stays silent when the watermark already covers today', async () => {
    const lane = new ContactTrustDriftReviewLane({
      contactStore: fakeStore({ watermark: '2026-07-07T02:30:00.000Z' }),
      restWindow: REST_WINDOW,
      deliverReview: () => {},
      now: () => INSIDE_WINDOW_MS,
    });
    expect(await lane.inferIdleActions()).toHaveLength(0);
  });

  it('runs again on the next day', async () => {
    const lane = new ContactTrustDriftReviewLane({
      contactStore: fakeStore({ watermark: '2026-07-06T03:00:00.000Z' }),
      restWindow: REST_WINDOW,
      deliverReview: () => {},
      now: () => INSIDE_WINDOW_MS,
    });
    expect(await lane.inferIdleActions()).toHaveLength(1);
  });
});

describe('execute', () => {
  it('delivers a review with drift candidates and advances the watermark', async () => {
    const deliverReview = vi.fn();
    const store = fakeStore({
      contacts: [
        fixtureContact({ id: 'promotable', trustLevel: 'public' }),
        fixtureContact({ id: 'quiet', trustLevel: 'public' }),
        fixtureContact({ id: 'already-trusted', trustLevel: 'trusted' }),
      ],
      timeSeriesByContact: { promotable: PROMOTABLE_SERIES },
      verifiedLinksByContact: { promotable: 1 },
    });
    const lane = new ContactTrustDriftReviewLane({
      contactStore: store,
      restWindow: REST_WINDOW,
      deliverReview,
      now: () => INSIDE_WINDOW_MS,
    });

    await lane.execute({ id: 'action-1', payload: {} });

    expect(deliverReview).toHaveBeenCalledTimes(1);
    const review = deliverReview.mock.calls[0]?.[0] as { content: string; candidateCount: number };
    expect(review.candidateCount).toBe(1);
    expect(review.content).toContain('promotable');
    expect(review.content).toContain('public -> regular');
    expect(review.content).toContain('confirmSuggestion=true');
    expect(review.content).toContain('Relationship: stranger -> acquaintance');
    expect(review.content).toContain('action=set_relationship');
    expect(review.content).not.toContain('already-trusted');
    expect(store.watermarks.get(CONTACT_TRUST_DRIFT_REVIEW_PROCESSOR)).toBe(
      new Date(INSIDE_WINDOW_MS).toISOString(),
    );
  });

  it('reviews relationship progression even when high-tier trust has nothing to escalate', async () => {
    const deliverReview = vi.fn();
    const store = fakeStore({
      contacts: [
        fixtureContact({ id: 'trusted-stranger', trustLevel: 'trusted', relationshipType: 'stranger' }),
      ],
      timeSeriesByContact: { 'trusted-stranger': PROMOTABLE_SERIES },
    });
    const lane = new ContactTrustDriftReviewLane({
      contactStore: store,
      restWindow: REST_WINDOW,
      deliverReview,
      now: () => INSIDE_WINDOW_MS,
    });

    await lane.execute({ id: 'relationship-review', payload: {} });

    expect(deliverReview).toHaveBeenCalledTimes(1);
    const review = deliverReview.mock.calls[0]?.[0] as { content: string; candidateCount: number };
    expect(review.candidateCount).toBe(1);
    expect(review.content).toContain('trusted-stranger');
    expect(review.content).toContain('Relationship: stranger -> acquaintance');
    expect(review.content).not.toContain('Trust: trusted');
  });

  it('routes family relationship suggestions through the HITL proposal action', async () => {
    const deliverReview = vi.fn();
    const store = fakeStore({
      contacts: [
        fixtureContact({ id: 'close-friend', trustLevel: 'trusted', relationshipType: 'friend' }),
      ],
      timeSeriesByContact: {
        'close-friend': Array.from({ length: 24 }, () => point(0.4)),
      },
    });
    const lane = new ContactTrustDriftReviewLane({
      contactStore: store,
      restWindow: REST_WINDOW,
      deliverReview,
      now: () => INSIDE_WINDOW_MS,
    });

    await lane.execute({ id: 'family-review', payload: {} });

    const review = deliverReview.mock.calls[0]?.[0] as { content: string };
    expect(review.content).toContain('Relationship: friend -> family');
    expect(review.content).toContain('action=propose_relationship');
    expect(review.content).toContain('operator approval');
  });

  it('advances the watermark without delivering when there are no candidates', async () => {
    const deliverReview = vi.fn();
    const store = fakeStore({
      contacts: [fixtureContact({ id: 'quiet', trustLevel: 'public' })],
    });
    const lane = new ContactTrustDriftReviewLane({
      contactStore: store,
      restWindow: REST_WINDOW,
      deliverReview,
      now: () => INSIDE_WINDOW_MS,
    });

    await lane.execute({ id: 'action-1', payload: {} });

    expect(deliverReview).not.toHaveBeenCalled();
    expect(store.watermarks.get(CONTACT_TRUST_DRIFT_REVIEW_PROCESSOR)).toBe(
      new Date(INSIDE_WINDOW_MS).toISOString(),
    );
  });

  it('skips a duplicate run in the same local day', async () => {
    const deliverReview = vi.fn();
    const store = fakeStore({
      contacts: [fixtureContact({ id: 'promotable', trustLevel: 'public' })],
      timeSeriesByContact: { promotable: PROMOTABLE_SERIES },
      verifiedLinksByContact: { promotable: 1 },
      watermark: '2026-07-07T02:15:00.000Z',
    });
    const lane = new ContactTrustDriftReviewLane({
      contactStore: store,
      restWindow: REST_WINDOW,
      deliverReview,
      now: () => INSIDE_WINDOW_MS,
    });

    await lane.execute({ id: 'action-2', payload: {} });

    expect(deliverReview).not.toHaveBeenCalled();
    expect(store.watermarks.get(CONTACT_TRUST_DRIFT_REVIEW_PROCESSOR)).toBe(
      '2026-07-07T02:15:00.000Z',
    );
  });

  it('does not advance the watermark when the scan throws', async () => {
    const store = fakeStore({
      contacts: [fixtureContact({ id: 'promotable', trustLevel: 'public' })],
    });
    store.getEmotionalTimeSeries = () => {
      throw new Error('store unavailable');
    };
    const lane = new ContactTrustDriftReviewLane({
      contactStore: store,
      restWindow: REST_WINDOW,
      deliverReview: () => {},
      now: () => INSIDE_WINDOW_MS,
    });

    await expect(lane.execute({ id: 'action-3', payload: {} })).rejects.toThrow('store unavailable');
    expect(store.watermarks.has(CONTACT_TRUST_DRIFT_REVIEW_PROCESSOR)).toBe(false);
  });

  it('fails closed on a corrupt watermark', async () => {
    const lane = new ContactTrustDriftReviewLane({
      contactStore: fakeStore({ watermark: 'not-a-timestamp' }),
      restWindow: REST_WINDOW,
      deliverReview: () => {},
      now: () => INSIDE_WINDOW_MS,
    });
    await expect(lane.execute({ id: 'action-4', payload: {} })).rejects.toThrow(/watermark/);
  });
});

describe('emo_sim dyad advisory (oth4.6)', () => {
  function promotableStore() {
    return fakeStore({
      contacts: [fixtureContact({ id: 'promotable', trustLevel: 'public' })],
      timeSeriesByContact: { promotable: PROMOTABLE_SERIES },
      verifiedLinksByContact: { promotable: 1 },
    });
  }

  it('includes the advisory prose, marked advisory, when the provider returns a reading', async () => {
    const deliverReview = vi.fn();
    const lane = new ContactTrustDriftReviewLane({
      contactStore: promotableStore(),
      restWindow: REST_WINDOW,
      deliverReview,
      dyadAdvisoryProvider: advisoryProvider(() => Promise.resolve(ADVISORY)),
      now: () => INSIDE_WINDOW_MS,
    });

    await lane.execute({ id: 'advisory-present', payload: {} });

    const review = deliverReview.mock.calls[0]?.[0] as { content: string; candidateCount: number };
    expect(review.content).toContain(ADVISORY.prose);
    expect(review.content).toContain('advisory only');
    expect(review.content).toContain('not a self-report');
    expect(review.content).toContain('changes nothing');
    // The advisory adds NO candidate — it is not a promoter/demoter.
    expect(review.candidateCount).toBe(1);
  });

  it('omits the advisory (fail-soft) and still delivers when the provider throws unavailable', async () => {
    const deliverReview = vi.fn();
    const store = promotableStore();
    const lane = new ContactTrustDriftReviewLane({
      contactStore: store,
      restWindow: REST_WINDOW,
      deliverReview,
      dyadAdvisoryProvider: advisoryProvider(() =>
        Promise.reject(new DyadRelationshipAdvisoryUnavailableError('store down'))),
      now: () => INSIDE_WINDOW_MS,
    });

    await lane.execute({ id: 'advisory-down', payload: {} });

    expect(deliverReview).toHaveBeenCalledTimes(1);
    const review = deliverReview.mock.calls[0]?.[0] as { content: string };
    expect(review.content).not.toContain('Background relational read');
    expect(review.content).toContain('promotable');
    // The review's own candidate scan still advanced normally.
    expect(store.watermarks.get(CONTACT_TRUST_DRIFT_REVIEW_PROCESSOR)).toBe(
      new Date(INSIDE_WINDOW_MS).toISOString(),
    );
    expect(logSpies.info).toHaveBeenCalledWith(
      'Omitting emo_sim dyad advisory from trust-drift review (read unavailable)',
      { actionId: 'advisory-down', error: 'store down' },
    );
    expect(logSpies.warn).not.toHaveBeenCalledWith(
      'Omitting emo_sim dyad advisory from trust-drift review (read unavailable)',
      expect.anything(),
    );
  });

  it('warns on unexpected provider errors while still omitting the advisory and delivering', async () => {
    const deliverReview = vi.fn();
    const store = promotableStore();
    const lane = new ContactTrustDriftReviewLane({
      contactStore: store,
      restWindow: REST_WINDOW,
      deliverReview,
      dyadAdvisoryProvider: advisoryProvider(() =>
        Promise.reject(new TypeError('provider bug'))),
      now: () => INSIDE_WINDOW_MS,
    });

    await lane.execute({ id: 'advisory-bug', payload: {} });

    expect(deliverReview).toHaveBeenCalledTimes(1);
    const review = deliverReview.mock.calls[0]?.[0] as { content: string };
    expect(review.content).not.toContain('Background relational read');
    expect(logSpies.warn).toHaveBeenCalledWith(
      'Omitting emo_sim dyad advisory from trust-drift review (read unavailable)',
      { actionId: 'advisory-bug', error: 'provider bug' },
    );
    expect(logSpies.info).not.toHaveBeenCalledWith(
      'Omitting emo_sim dyad advisory from trust-drift review (read unavailable)',
      expect.anything(),
    );
  });

  it('omits the advisory when the provider returns null (no data)', async () => {
    const deliverReview = vi.fn();
    const lane = new ContactTrustDriftReviewLane({
      contactStore: promotableStore(),
      restWindow: REST_WINDOW,
      deliverReview,
      dyadAdvisoryProvider: advisoryProvider(() => Promise.resolve(null)),
      now: () => INSIDE_WINDOW_MS,
    });

    await lane.execute({ id: 'advisory-null', payload: {} });

    const review = deliverReview.mock.calls[0]?.[0] as { content: string };
    expect(review.content).not.toContain('Background relational read');
  });

  it('never reads the advisory when there are no candidates (no review, no promotion pressure)', async () => {
    const deliverReview = vi.fn();
    const describeLatestDirectedRelationship = vi.fn(() => Promise.resolve(ADVISORY));
    const lane = new ContactTrustDriftReviewLane({
      contactStore: fakeStore({ contacts: [fixtureContact({ id: 'quiet', trustLevel: 'public' })] }),
      restWindow: REST_WINDOW,
      deliverReview,
      dyadAdvisoryProvider: { describeLatestDirectedRelationship },
      now: () => INSIDE_WINDOW_MS,
    });

    await lane.execute({ id: 'no-candidates', payload: {} });

    expect(deliverReview).not.toHaveBeenCalled();
    expect(describeLatestDirectedRelationship).not.toHaveBeenCalled();
  });

  it('is read-only: the advisory path exposes no trust/relationship mutators to the lane', () => {
    // The review store surface is structurally read-only (no setTrustLevel /
    // compareAndSetRelationshipType). This compile-time + shape assertion guards
    // that the advisory feature did not widen it.
    const store = promotableStore();
    const mutatorNames = ['setTrustLevel', 'compareAndSetRelationshipType', 'applyLowTierTrustDriftSuggestion'];
    for (const name of mutatorNames) {
      expect((store as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});
