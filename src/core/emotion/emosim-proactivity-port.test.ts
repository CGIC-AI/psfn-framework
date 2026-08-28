import { describe, expect, it, vi } from 'vitest';

import {
  createEmoSimProactivityPort,
  type EmoSimProactivityStateStorePort,
} from './emosim-proactivity-port.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const NOW_MS = 1_780_000_000_000;
const MINUTE_MS = 60_000;

function stateStore(initial?: { firstCrossingMs: number | null; lastFiredAtMs: number | null }) {
  let state = initial ?? { firstCrossingMs: null, lastFiredAtMs: null };
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
      thresholdProfile: {
        profileId: 'would-message-v1',
        socialNeedThreshold: 0.7,
        attachmentIntensityThreshold: 0.5,
        sustainMs: 30 * MINUTE_MS,
        cooldownMs: 6 * 60 * MINUTE_MS,
      },
      stateStore: store,
      emitImpulse,
    });

    expect((await port.observe(observation(NOW_MS))).kind).toBe('suppressed');
    const result = await port.observe(observation(NOW_MS + 30 * MINUTE_MS));
    expect(result).toEqual({
      kind: 'emitted',
      impulse: expect.objectContaining({
        schemaVersion: 1,
        impulseVersion: 'psfn.emosim-proactivity.impulse.v1',
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
      thresholdProfile: {
        profileId: 'would-message-v1',
        socialNeedThreshold: 0.7,
        attachmentIntensityThreshold: 0.5,
        sustainMs: 30 * MINUTE_MS,
        cooldownMs: 6 * 60 * MINUTE_MS,
      },
      stateStore: stateStore().store,
      emitImpulse: vi.fn(),
    });
    await expect(disabled.observe(observation(NOW_MS))).resolves.toMatchObject({
      kind: 'suppressed', reason: 'port_disabled', availability: 'disabled',
    });

    const unavailable = createEmoSimProactivityPort({
      enabled: true,
      companionId: COMPANION_ID,
      thresholdProfile: {
        profileId: 'would-message-v1',
        socialNeedThreshold: 0.7,
        attachmentIntensityThreshold: 0.5,
        sustainMs: 30 * MINUTE_MS,
        cooldownMs: 6 * 60 * MINUTE_MS,
      },
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
      thresholdProfile: {
        profileId: 'would-message-v1',
        socialNeedThreshold: 0.7,
        attachmentIntensityThreshold: 0.5,
        sustainMs: 30 * MINUTE_MS,
        cooldownMs: 6 * 60 * MINUTE_MS,
      },
      stateStore: store,
      emitImpulse,
    });

    await port.observe(observation(NOW_MS));
    await expect(port.observe(observation(NOW_MS + 30 * MINUTE_MS))).rejects.toThrow(
      'ICP consumer unavailable',
    );
    expect(read()).toEqual({ firstCrossingMs: NOW_MS, lastFiredAtMs: null });
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
      thresholdProfile: {
        profileId: 'would-message-v1',
        socialNeedThreshold: 0.7,
        attachmentIntensityThreshold: 0.5,
        sustainMs: 30 * MINUTE_MS,
        cooldownMs: 6 * 60 * MINUTE_MS,
      },
      stateStore: store,
      emitImpulse,
    });
    await port.observe(observation(NOW_MS + 30 * MINUTE_MS));
    expect(emitImpulse).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: `felt-impulse:would_message:${NOW_MS}`,
    }));
  });
});
