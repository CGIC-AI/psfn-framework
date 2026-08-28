import { describe, expect, it, vi } from 'vitest';

import {
  createEmoSimProactivityPort,
  type EmoSimProactivityStateStorePort,
} from './emosim-proactivity-port.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const NOW_MS = 1_780_000_000_000;
const MINUTE_MS = 60_000;

function thresholdProfile() {
  return {
    schemaVersion: 1 as const,
    profileId: 'would-message-v1',
    revision: '2026-08-28.1',
    applicableSource: {
      model: 'emo_sim',
      version: 'emo_sim/server.py#http-api.v1',
    },
    reviewNote: 'Sanitized deterministic test profile.',
    calibration: {
      corpusVersion: 'test-corpus.v1',
      metricsVersion: 'emosim-proactivity.metrics.v1',
      status: 'measured' as const,
      fireRate: 0.2,
      falsePositiveRate: 0.05,
      fatigueRate: 0.1,
    },
    promotionCriteria: {
      criteriaVersion: 'test-promotion.v1',
      maximumFalsePositiveRate: 0.1,
      maximumFatigueRate: 0.2,
    },
    rollbackProfileId: null,
    socialNeedThreshold: 0.7,
    attachmentIntensityThreshold: 0.5,
    samplingIntervalMs: MINUTE_MS,
    minimumConfidence: 0.6,
    abstainBelowMinimumConfidence: true as const,
    sustainMs: 30 * MINUTE_MS,
    dedupeWindowMs: 5 * MINUTE_MS,
    cooldownMs: 6 * 60 * MINUTE_MS,
  };
}

function stateStore(initial?: { firstCrossingMs: number | null; lastFiredAtMs: number | null }) {
  let state = {
    firstCrossingMs: initial?.firstCrossingMs ?? null,
    lastFiredAtMs: initial?.lastFiredAtMs ?? null,
    lastSampledAtMs: null,
    lastInputId: null,
  };
  const store: EmoSimProactivityStateStorePort = {
    load: vi.fn(async () => structuredClone(state)),
    save: vi.fn(async next => { state = structuredClone(next); }),
  };
  return { store, read: () => state };
}

function observation(observedAtMs: number) {
  return {
    companionId: COMPANION_ID,
    observedAtMs,
    source: {
      model: 'emo_sim',
      version: 'emo_sim/server.py#http-api.v1',
      availability: 'available' as const,
      confidence: 0.82,
    },
    lineage: {
      schemaVersion: 1 as const,
      inputId: `turn:${observedAtMs}`,
      projectionVersion: 'psfn.observer-sidecar.appraisal-projection.v3',
      privacyClass: 'content_redacted',
      rawContentRedacted: true as const,
    },
    snapshot: {
      dominant: 'Calmness',
      emotions: { Calmness: 0.3 },
      drives: { socialNeed: 0.8 },
    },
  };
}

describe('EmoSim Proactivity Port', () => {
  it('emits one versioned provenance-bearing impulse for a sustained first crossing', async () => {
    const { store } = stateStore();
    const emitImpulse = vi.fn(async () => undefined);
    const port = createEmoSimProactivityPort({
      enabled: true,
      companionId: COMPANION_ID,
      thresholdProfile: thresholdProfile(),
      stateStore: store,
      emitImpulse,
    });

    expect((await port.observe(observation(NOW_MS))).kind).toBe('suppressed');
    const result = await port.observe(observation(NOW_MS + 30 * MINUTE_MS));
    expect(result).toEqual({
      kind: 'emitted',
      impulse: expect.objectContaining({
        schemaVersion: 1,
        impulseVersion: 'emosim-proactivity.impulse.v1',
        companionId: COMPANION_ID,
        source: {
          model: 'emo_sim',
          version: 'emo_sim/server.py#http-api.v1',
        },
        lineage: expect.objectContaining({ rawContentRedacted: true }),
        firstCrossingMs: NOW_MS,
        firedAtMs: NOW_MS + 30 * MINUTE_MS,
        thresholdProfile: expect.objectContaining({ profileId: 'would-message-v1' }),
        dedupeKey: `felt-impulse:would_message:${NOW_MS}`,
        confidence: 0.82,
        availability: 'available',
      }),
    });
    expect(result.impulse).not.toHaveProperty('rawContent');
    expect(result.impulse).not.toHaveProperty('messageText');
    expect(result.impulse).not.toHaveProperty('motivation');

    await port.observe(observation(NOW_MS + 35 * MINUTE_MS));
    expect(emitImpulse).toHaveBeenCalledTimes(1);
  });

  it('returns honest typed suppression when disabled or unavailable', async () => {
    const disabled = createEmoSimProactivityPort({
      enabled: false,
      companionId: COMPANION_ID,
      thresholdProfile: thresholdProfile(),
      stateStore: stateStore().store,
      emitImpulse: vi.fn(),
    });
    await expect(disabled.observe(observation(NOW_MS))).resolves.toMatchObject({
      kind: 'suppressed', reason: 'port_disabled', availability: 'disabled',
    });

    const unavailable = createEmoSimProactivityPort({
      enabled: true,
      companionId: COMPANION_ID,
      thresholdProfile: thresholdProfile(),
      stateStore: stateStore().store,
      emitImpulse: vi.fn(),
    });
    await expect(unavailable.observe({
      ...observation(NOW_MS),
      source: { ...observation(NOW_MS).source, availability: 'unavailable' },
      snapshot: null,
    })).resolves.toMatchObject({
      kind: 'suppressed', reason: 'source_unavailable', availability: 'unavailable',
    });
  });

  it('retries a failed required handoff with the legacy dedupe key', async () => {
    const { store, read } = stateStore();
    const emitImpulse = vi.fn()
      .mockRejectedValueOnce(new Error('ICP consumer unavailable'))
      .mockResolvedValue(undefined);
    const port = createEmoSimProactivityPort({
      enabled: true,
      companionId: COMPANION_ID,
      thresholdProfile: thresholdProfile(),
      stateStore: store,
      emitImpulse,
    });

    await port.observe(observation(NOW_MS));
    await expect(port.observe(observation(NOW_MS + 30 * MINUTE_MS))).rejects.toThrow(
      'ICP consumer unavailable',
    );
    expect(read()).toMatchObject({ firstCrossingMs: NOW_MS, lastFiredAtMs: null });
    await port.observe(observation(NOW_MS + 31 * MINUTE_MS));
    expect(emitImpulse.mock.calls.map(([impulse]) => impulse.dedupeKey)).toEqual([
      `felt-impulse:would_message:${NOW_MS}`,
      `felt-impulse:would_message:${NOW_MS}`,
    ]);
  });

  it('resumes a legacy first crossing without dropping it', async () => {
    const { store } = stateStore({ firstCrossingMs: NOW_MS, lastFiredAtMs: null });
    const emitImpulse = vi.fn(async () => undefined);
    const port = createEmoSimProactivityPort({
      enabled: true,
      companionId: COMPANION_ID,
      thresholdProfile: thresholdProfile(),
      stateStore: store,
      emitImpulse,
    });
    await port.observe(observation(NOW_MS + 30 * MINUTE_MS));
    expect(emitImpulse).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: `felt-impulse:would_message:${NOW_MS}`,
    }));
  });

  it('fails closed when a profile is applied to an unknown source model or version', async () => {
    const port = createEmoSimProactivityPort({
      enabled: true,
      companionId: COMPANION_ID,
      thresholdProfile: thresholdProfile(),
      stateStore: stateStore().store,
      emitImpulse: vi.fn(),
    });

    await expect(port.observe({
      ...observation(NOW_MS),
      source: { ...observation(NOW_MS).source, version: 'unexpected-version' },
    })).rejects.toThrow(/profile .* source .*unexpected-version/i);
  });

  it('abstains below confidence and separates sample, duplicate, and fatigue outcomes', async () => {
    const { store } = stateStore();
    const emitImpulse = vi.fn(async () => undefined);
    const port = createEmoSimProactivityPort({
      enabled: true,
      companionId: COMPANION_ID,
      thresholdProfile: thresholdProfile(),
      stateStore: store,
      emitImpulse,
    });

    await expect(port.observe({
      ...observation(NOW_MS),
      source: { ...observation(NOW_MS).source, confidence: 0.4 },
    })).resolves.toMatchObject({ kind: 'suppressed', reason: 'confidence_abstained' });

    const first = observation(NOW_MS + MINUTE_MS);
    await expect(port.observe(first)).resolves.toMatchObject({ reason: 'sustain_pending' });
    await expect(port.observe({
      ...first,
      observedAtMs: first.observedAtMs + 1,
    })).resolves.toMatchObject({ reason: 'duplicate_input' });
    await expect(port.observe(observation(NOW_MS + MINUTE_MS + 30 * MINUTE_MS)))
      .resolves.toMatchObject({ kind: 'emitted' });

    const nextCrossingAt = NOW_MS + MINUTE_MS + 31 * MINUTE_MS;
    await expect(port.observe(observation(nextCrossingAt)))
      .resolves.toMatchObject({ reason: 'sustain_pending' });
    await expect(port.observe(observation(nextCrossingAt + 30 * MINUTE_MS)))
      .resolves.toMatchObject({ reason: 'cooldown_active' });
    expect(emitImpulse).toHaveBeenCalledTimes(1);
  });
});
