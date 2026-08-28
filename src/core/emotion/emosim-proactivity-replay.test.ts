import { describe, expect, it } from 'vitest';

import { createDefaultEmoSimProactivitySettings } from '../../system/config/runtime-config-contracts.js';
import {
  replayEmoSimProactivityProfiles,
  type EmoSimProactivityReplayCorpus,
} from './emosim-proactivity-replay.js';

const MINUTE_MS = 60_000;

function profile(profileId: string, socialNeedThreshold: number) {
  const base = createDefaultEmoSimProactivitySettings().thresholdProfile;
  return {
    ...base,
    profileId,
    revision: `${profileId}.revision-1`,
    calibration: {
      ...base.calibration,
      status: 'measured' as const,
      fireRate: 0.2,
      falsePositiveRate: 0.05,
      fatigueRate: 0.1,
    },
    socialNeedThreshold,
    samplingIntervalMs: 0,
    minimumConfidence: 0.5,
    sustainMs: MINUTE_MS,
    dedupeWindowMs: 5 * MINUTE_MS,
    cooldownMs: 10 * MINUTE_MS,
  };
}

const corpus: EmoSimProactivityReplayCorpus = {
  schemaVersion: 1,
  corpusVersion: 'sanitized-three-lane.v1',
  rawContentRedacted: true,
  events: [
    {
      scenarioId: 'direction',
      lane: 'event_direction',
      eventId: 'direction-1',
      observedAtMs: 1_000_000,
      confidence: 0.9,
      expected: 'suppress',
      snapshot: { dominant: 'Calmness', emotions: { Calmness: 0.2 }, socialNeed: 0.6 },
    },
    {
      scenarioId: 'direction',
      lane: 'event_direction',
      eventId: 'direction-2',
      observedAtMs: 1_000_000 + MINUTE_MS,
      confidence: 0.9,
      expected: 'suppress',
      snapshot: { dominant: 'Calmness', emotions: { Calmness: 0.2 }, socialNeed: 0.6 },
    },
    {
      scenarioId: 'trajectory',
      lane: 'mood_trajectory',
      eventId: 'trajectory-1',
      observedAtMs: 2_000_000,
      confidence: 0.9,
      expected: 'defer',
      snapshot: { dominant: 'Love', emotions: { Love: 0.8 }, socialNeed: 0.1 },
    },
    {
      scenarioId: 'trajectory',
      lane: 'mood_trajectory',
      eventId: 'trajectory-2',
      observedAtMs: 2_000_000 + MINUTE_MS,
      confidence: 0.9,
      expected: 'fire',
      snapshot: { dominant: 'Love', emotions: { Love: 0.8 }, socialNeed: 0.1 },
    },
    {
      scenarioId: 'timing',
      lane: 'outreach_timing',
      eventId: 'timing-1',
      observedAtMs: 3_000_000,
      confidence: 0.9,
      expected: 'defer',
      snapshot: { dominant: 'Calmness', emotions: { Calmness: 0.2 }, socialNeed: 0.9 },
    },
    {
      scenarioId: 'timing',
      lane: 'outreach_timing',
      eventId: 'timing-2',
      observedAtMs: 3_000_000 + MINUTE_MS,
      confidence: 0.9,
      expected: 'fire',
      snapshot: { dominant: 'Calmness', emotions: { Calmness: 0.2 }, socialNeed: 0.9 },
    },
    {
      scenarioId: 'timing',
      lane: 'outreach_timing',
      eventId: 'timing-2',
      observedAtMs: 3_000_000 + MINUTE_MS + 1,
      confidence: 0.9,
      expected: 'suppress',
      snapshot: { dominant: 'Calmness', emotions: { Calmness: 0.2 }, socialNeed: 0.9 },
    },
    {
      scenarioId: 'timing',
      lane: 'outreach_timing',
      eventId: 'timing-3',
      observedAtMs: 3_000_000 + 2 * MINUTE_MS,
      confidence: 0.9,
      expected: 'defer',
      snapshot: { dominant: 'Calmness', emotions: { Calmness: 0.2 }, socialNeed: 0.9 },
    },
    {
      scenarioId: 'timing',
      lane: 'outreach_timing',
      eventId: 'timing-4',
      observedAtMs: 3_000_000 + 3 * MINUTE_MS,
      confidence: 0.9,
      expected: 'suppress',
      snapshot: { dominant: 'Calmness', emotions: { Calmness: 0.2 }, socialNeed: 0.9 },
    },
  ],
};

describe('EmoSim proactivity profile replay', () => {
  it('deterministically compares all sanitized calibration lanes and outcome classes', async () => {
    const report = await replayEmoSimProactivityProfiles({
      baseline: profile('baseline', 0.7),
      candidate: profile('candidate', 0.5),
      corpus,
    });
    const repeated = await replayEmoSimProactivityProfiles({
      baseline: profile('baseline', 0.7),
      candidate: profile('candidate', 0.5),
      corpus,
    });

    expect(repeated).toEqual(report);
    expect(report.corpus.lanes).toEqual([
      'event_direction',
      'mood_trajectory',
      'outreach_timing',
    ]);
    expect(report.baseline.counts).toMatchObject({
      fire: 2,
      defer: 3,
      suppress: 2,
      duplicate: 1,
      fatigue: 1,
    });
    expect(report.candidate.counts).toMatchObject({
      fire: 3,
      defer: 4,
      suppress: 0,
      duplicate: 1,
      fatigue: 1,
      falsePositive: 1,
    });
    expect(report.divergence).toEqual({ count: 2, scoredAsAutomaticFailure: false });
    expect(report.candidate.promotion.criteriaVersion).toBe(
      profile('candidate', 0.5).promotionCriteria.criteriaVersion,
    );
  });

  it('rejects corpora that omit a required calibration lane or carry raw content', async () => {
    await expect(replayEmoSimProactivityProfiles({
      baseline: profile('baseline', 0.7),
      candidate: profile('candidate', 0.5),
      corpus: { ...corpus, events: corpus.events.filter(event => event.lane !== 'mood_trajectory') },
    })).rejects.toThrow(/mood_trajectory/);

    await expect(replayEmoSimProactivityProfiles({
      baseline: profile('baseline', 0.7),
      candidate: profile('candidate', 0.5),
      corpus: { ...corpus, rawContentRedacted: false as true },
    })).rejects.toThrow(/raw-content redaction/);
  });
});
