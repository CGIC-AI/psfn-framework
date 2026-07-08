import { describe, it, expect, vi } from 'vitest';
import type { Contact } from './types.js';
import type { EmotionalTimeSeriesPoint } from './store/emotional-baseline.js';
import {
  CONTACT_TRUST_DRIFT_REVIEW_ACTION_KIND,
  CONTACT_TRUST_DRIFT_REVIEW_PROCESSOR,
  ContactTrustDriftReviewLane,
  type ContactTrustDriftReviewStore,
} from './trust-drift-review-lane.js';

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
    expect(review.content).not.toContain('already-trusted');
    expect(store.watermarks.get(CONTACT_TRUST_DRIFT_REVIEW_PROCESSOR)).toBe(
      new Date(INSIDE_WINDOW_MS).toISOString(),
    );
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
