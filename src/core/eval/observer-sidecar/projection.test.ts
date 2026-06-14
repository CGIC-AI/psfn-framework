import { describe, expect, it } from 'vitest';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import {
  EMOSIM_APPRAISAL_DIMS,
  parseEmoSimAdapterInput,
  type EmoSimAppraisalVector,
} from './emosim-adapter.js';
import {
  OBSERVER_APPRAISAL_PROJECTION_CAVEAT,
  projectObserverEvalToEmoSim,
  type ObserverAppraisalProjectionFailure,
  type ObserverAppraisalProjectionResult,
  type ObserverAppraisalProjectionSuccess,
} from './projection.js';
import type { ObserverEvalInputPayload } from './types.js';

const RAW_SECRET = 'raw-user-secret: hidden fixture words';

const EMOTION_SNAPSHOT: EmotionStateSnapshot = {
  vad: { valence: 0.58, arousal: 0.34, dominance: 0.22 },
  mood: { valence: 0.32, arousal: 0.18, dominance: 0.12 },
  discrete: {
    joy: 0.62,
    trust: 0.44,
    curiosity: 0.3,
  },
  confidence: 0.84,
};

describe('observer sidecar appraisal projection', () => {
  it('projects complete sanitized observer data into appraisal and adapter input with provenance', () => {
    const result = projectObserverEvalToEmoSim(withRawLeakFields(makeObserverInput()));

    expectSuccess(result);
    expect(result.schemaVersion).toBe(1);
    expect(result.projectionVersion).toBe('psfn.observer-sidecar.appraisal-projection.v1');
    expect(result.source).toBe('observer-derived');
    expect(result.projectedAppraisal.dimensions).toEqual(result.adapterInput.stimulus.appraisal);
    expect(Object.keys(result.projectedAppraisal.dimensions)).toEqual([...EMOSIM_APPRAISAL_DIMS]);
    expect(parseEmoSimAdapterInput(result.adapterInput)).toEqual(result.adapterInput);
    expect(result.confidence).toBeGreaterThan(0.85);
    expect(result.missingInputs).toEqual([]);
    expect(result.projectedAppraisal.privacyClass).toBe('public');
    expect(result.projectedAppraisal.sensitivity).toBe('public');
    expect(result.projectedAppraisal.caveats).toContain(OBSERVER_APPRAISAL_PROJECTION_CAVEAT);
    expect(result.projectedAppraisal.dimensionProvenance.valence.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'observer-emotion-snapshot',
          path: 'emotion.snapshot',
        }),
        expect.objectContaining({
          source: 'observer-privacy-decision',
          privacyClass: 'public',
        }),
      ]),
    );
    expect(result.adapterInput.stimulus.appraisal.gain).toBeGreaterThan(
      result.adapterInput.stimulus.appraisal.loss,
    );
    expect(result.adapterInput.stimulus.appraisal.agency_other).toBeGreaterThan(
      result.adapterInput.stimulus.appraisal.agency_self,
    );
    expectNoRawLeak(result);
  });

  it('keeps sparse null emotion data projectable while surfacing missing inputs and lower confidence', () => {
    const result = projectObserverEvalToEmoSim(makeObserverInput({
      emotion: {
        snapshot: null,
        appraisalEntryCount: 0,
      },
      metadata: {
        trustLevel: 'regular',
        speakerRole: 'user',
        contactResolved: false,
        contentLength: 0,
        attachmentCount: 0,
        hasVisionInput: false,
        sensitivity: 'public',
      },
    }));

    expectSuccess(result);
    expect(parseEmoSimAdapterInput(result.adapterInput)).toEqual(result.adapterInput);
    expect(result.confidence).toBeLessThan(0.35);
    expect(result.projectedAppraisal.dimensions.valence).toBe(0);
    expect(result.missingInputs.map((missing) => missing.reason)).toEqual(
      expect.arrayContaining([
        'emotion_snapshot_missing',
        'emotion_discrete_empty',
        'appraisal_chain_empty',
        'content_length_empty',
        'contact_unresolved',
      ]),
    );
    expect(result.projectedAppraisal.dimensionProvenance.certainty.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'observer-turn-metadata',
        }),
      ]),
    );
  });

  it('fails closed for privacy-redacted data before building an EmoSim adapter input', () => {
    const result = projectObserverEvalToEmoSim(withRawLeakFields(makeObserverInput({
      metadata: {
        trustLevel: 'regular',
        speakerRole: 'user',
        contactResolved: true,
        contentLength: RAW_SECRET.length,
        attachmentCount: 0,
        hasVisionInput: false,
      },
    })));

    expectFailure(result);
    expect(result.privacy).toMatchObject({
      privacyClass: 'fail_closed',
      derivedTelemetryPermitted: false,
      redactionReason: 'missing_sensitivity_metadata',
    });
    expect(result.error).toMatchObject({
      code: 'projection-unavailable',
      reason: 'privacy-derived-telemetry-unavailable',
      recoverable: true,
    });
    expect(result.missingInputs.map((missing) => missing.reason)).toEqual(
      expect.arrayContaining([
        'derived_telemetry_not_permitted',
        'emotion_snapshot_redacted',
        'sensitivity_missing',
      ]),
    );
    expect(Object.hasOwn(result, 'adapterInput')).toBe(false);
    expectNoRawLeak(result);
  });

  it('uses explicit direct fixture appraisal dimensions for eval scenarios', () => {
    const fixtureAppraisal = makeFixtureAppraisal();
    const result = projectObserverEvalToEmoSim(makeObserverInput(), {
      directFixtureAppraisal: {
        appraisal: fixtureAppraisal,
        confidence: 0.92,
        label: 'fixture warm direct',
      },
      runId: 'fixture-run',
    });

    expectSuccess(result);
    expect(result.source).toBe('direct-fixture-appraisal');
    expect(result.projectedAppraisal.source).toBe('direct-fixture-appraisal');
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.adapterInput.runId).toBe('fixture-run');
    expect(result.adapterInput.stimulus.label).toBe('fixture warm direct');
    expect(result.adapterInput.stimulus.appraisal).toEqual(fixtureAppraisal);
    expect(parseEmoSimAdapterInput(result.adapterInput)).toEqual(result.adapterInput);
    expect(result.projectedAppraisal.dimensionProvenance.valence.provenance).toEqual([
      expect.objectContaining({
        source: 'direct-fixture-appraisal',
        path: 'options.directFixtureAppraisal.appraisal',
      }),
    ]);
    expect(result.caveats).toEqual(
      expect.arrayContaining([
        'Direct fixture appraisal is explicit eval input, not inferred live appraisal.',
      ]),
    );
  });
});

function makeObserverInput(
  overrides: Partial<ObserverEvalInputPayload> = {},
): ObserverEvalInputPayload {
  return {
    schemaVersion: 1,
    turn: {
      turnId: 'turn-projection',
      requestId: 'request-projection',
      sourceMessageId: 'source-message-projection',
      channelId: 'channel-projection',
      channelType: 'api',
      messageTimestampMs: 1_780_000_000_000,
    },
    source: {
      routingSource: 'api',
      isDirectMessage: false,
      channelPrivacy: 'public',
    },
    emotion: {
      snapshot: structuredClone(EMOTION_SNAPSHOT),
      appraisalEntryCount: 2,
    },
    metadata: {
      trustLevel: 'trusted',
      speakerRole: 'user',
      contactResolved: true,
      contentLength: 420,
      attachmentCount: 1,
      hasVisionInput: true,
      sensitivity: 'public',
    },
    provenance: {
      seam: 'substrate-agent.pre-turn.emotion-observed',
      capturedAt: 1_780_000_000_100,
      emotionSessionId: 'emotion-session-projection',
      emotionSnapshotSource: 'observeEmotionState',
      correlation: {
        callType: 'chat',
        purpose: 'agent.turn',
      },
    },
    ...overrides,
  };
}

function withRawLeakFields(input: ObserverEvalInputPayload): ObserverEvalInputPayload {
  return {
    ...input,
    turn: {
      ...input.turn,
      requestId: RAW_SECRET,
      sourceMessageId: RAW_SECRET,
      channelId: RAW_SECRET,
    },
    provenance: {
      ...input.provenance,
      emotionSessionId: RAW_SECRET,
      correlation: {
        ...input.provenance.correlation,
        purpose: RAW_SECRET,
      },
    },
    rawUserText: RAW_SECRET,
  } as ObserverEvalInputPayload;
}

function makeFixtureAppraisal(): EmoSimAppraisalVector {
  return {
    valence: 0.72,
    novelty: 0.18,
    goal_congruence: 0.64,
    certainty: 0.52,
    control: 0.28,
    agency_self: 0.1,
    agency_other: 0.88,
    fairness: 0.5,
    self_norm: 0.08,
    threat: 0.02,
    loss: 0,
    gain: 0.7,
    other_suffering: 0.03,
    attachment: 0.66,
    beauty: 0.22,
    effort: 0.31,
    safety: 0.84,
  };
}

function expectSuccess(
  result: ObserverAppraisalProjectionResult,
): asserts result is ObserverAppraisalProjectionSuccess {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
}

function expectFailure(
  result: ObserverAppraisalProjectionResult,
): asserts result is ObserverAppraisalProjectionFailure {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('Expected projection failure');
  }
}

function expectNoRawLeak(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(RAW_SECRET);
}
