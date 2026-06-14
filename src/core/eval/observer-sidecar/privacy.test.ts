import { describe, expect, it, vi } from 'vitest';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import type { ObserverEvalInputPayload, ObserverEvalLifecycleStatePayload } from './types.js';
import {
  dispatchObserverEvalTurn,
  drainObserverEvalSidecarQueue,
} from './runtime.js';
import {
  createObserverEvalLogSafeInput,
  createObserverEvalLogSafeLifecycleState,
  sanitizeObserverEvalError,
  sanitizeObserverEvalInput,
  sanitizeObserverEvalLifecycleState,
} from './privacy.js';

const RAW_SECRET = 'raw-user-secret: loves redacted moonlight tea';

const EMOTION_SNAPSHOT: EmotionStateSnapshot = {
  vad: { valence: 0.2, arousal: 0.4, dominance: 0.1 },
  mood: { valence: 0.1, arousal: 0.3, dominance: 0 },
  discrete: { concern: 0.6, curiosity: 0.2 },
  confidence: 0.75,
};

function makeObserverInput(
  overrides: Partial<ObserverEvalInputPayload> = {},
): ObserverEvalInputPayload {
  return {
    schemaVersion: 1,
    turn: {
      turnId: 'turn-privacy',
      requestId: 'request-privacy',
      sourceMessageId: 'source-message-privacy',
      channelId: 'channel-privacy',
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
      trustLevel: 'regular',
      speakerRole: 'user',
      contactResolved: true,
      contentLength: RAW_SECRET.length,
      attachmentCount: 1,
      hasVisionInput: false,
      sensitivity: 'public',
    },
    provenance: {
      seam: 'substrate-agent.pre-turn.emotion-observed',
      capturedAt: 1_780_000_000_100,
      emotionSessionId: 'emotion-session-privacy',
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

function expectNoRawLeak(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(RAW_SECRET);
}

describe('observer eval privacy boundary', () => {
  it('keeps public observations metadata-only without leaking raw text or identifiers', () => {
    const input = withRawLeakFields(makeObserverInput());

    const sanitized = sanitizeObserverEvalInput(input);

    expect(sanitized.privacy).toMatchObject({
      privacyClass: 'public',
      sensitivity: 'public',
      channelVisibility: 'public',
      rawContentRedacted: true,
      sensitiveIdentifiersRedacted: true,
      derivedTelemetryPermitted: true,
      redactionReason: 'public_metadata_only',
    });
    expect(sanitized.metadata).toMatchObject({
      contentLength: RAW_SECRET.length,
      attachmentCount: 1,
      sensitivity: 'public',
    });
    expect(sanitized.emotion.snapshot).toEqual(EMOTION_SNAPSHOT);
    expect(sanitized.turn.redactedIdentifiers).toEqual(['requestId', 'sourceMessageId', 'channelId']);
    expect(sanitized.provenance.redactedIdentifiers).toEqual(['emotionSessionId']);
    expectNoRawLeak(sanitized);
  });

  it('treats direct private observations as private while preserving derived telemetry', () => {
    const input = withRawLeakFields(makeObserverInput({
      source: {
        routingSource: 'api',
        isDirectMessage: true,
      },
      metadata: {
        trustLevel: 'trusted',
        speakerRole: 'user',
        contactResolved: true,
        contentLength: RAW_SECRET.length,
        attachmentCount: 0,
        hasVisionInput: false,
        sensitivity: 'personal',
      },
    }));

    const sanitized = sanitizeObserverEvalInput(input);

    expect(sanitized.privacy).toMatchObject({
      privacyClass: 'private',
      sensitivity: 'personal',
      channelVisibility: 'private',
      derivedTelemetryPermitted: true,
      redactionReason: 'direct_message_metadata_only',
    });
    expect(sanitized.emotion.snapshot).toEqual(EMOTION_SNAPSHOT);
    expectNoRawLeak(sanitized);
  });

  it('fails closed when sensitivity metadata is missing', () => {
    const input = withRawLeakFields(makeObserverInput({
      metadata: {
        trustLevel: 'regular',
        speakerRole: 'user',
        contactResolved: true,
        contentLength: RAW_SECRET.length,
        attachmentCount: 0,
        hasVisionInput: false,
      },
    }));

    const sanitized = sanitizeObserverEvalInput(input);

    expect(sanitized.privacy).toMatchObject({
      privacyClass: 'fail_closed',
      sensitivity: null,
      channelVisibility: null,
      derivedTelemetryPermitted: false,
      redactionReason: 'missing_sensitivity_metadata',
    });
    expect(sanitized.emotion).toMatchObject({
      snapshot: null,
      snapshotRedacted: true,
    });
    expectNoRawLeak(sanitized);
  });

  it('fails closed when sensitivity metadata is ambiguous', () => {
    const input = withRawLeakFields(makeObserverInput({
      metadata: {
        trustLevel: 'regular',
        speakerRole: 'user',
        contactResolved: true,
        contentLength: RAW_SECRET.length,
        attachmentCount: 0,
        hasVisionInput: false,
        sensitivity: 'private-ish' as 'public',
      },
    }));

    const sanitized = sanitizeObserverEvalInput(input);

    expect(sanitized.privacy).toMatchObject({
      privacyClass: 'fail_closed',
      sensitivity: null,
      channelVisibility: null,
      derivedTelemetryPermitted: false,
      redactionReason: 'ambiguous_sensitivity_metadata',
    });
    expectNoRawLeak(sanitized);
  });

  it('classifies intimate observations as closed without content sniffing', () => {
    const input = withRawLeakFields(makeObserverInput({
      source: {
        routingSource: 'api',
        isDirectMessage: false,
        channelPrivacy: 'private',
      },
      metadata: {
        trustLevel: 'primary',
        speakerRole: 'user',
        contactResolved: true,
        contentLength: RAW_SECRET.length,
        attachmentCount: 2,
        hasVisionInput: true,
        sensitivity: 'intimate',
      },
    }));

    const sanitized = sanitizeObserverEvalInput(input);

    expect(sanitized.privacy).toMatchObject({
      privacyClass: 'closed',
      sensitivity: 'intimate',
      channelVisibility: 'private',
      derivedTelemetryPermitted: true,
      redactionReason: 'closed_sensitivity_metadata_only',
    });
    expect(sanitized.metadata).toMatchObject({
      contentLength: RAW_SECRET.length,
      attachmentCount: 2,
      hasVisionInput: true,
    });
    expect(sanitized.emotion.snapshot).toEqual(EMOTION_SNAPSHOT);
    expectNoRawLeak(sanitized);
  });

  it('sanitizes lifecycle and error payloads before log or display use', () => {
    const rawError = new Error(`observer exploded on ${RAW_SECRET}`);
    const lifecycle: ObserverEvalLifecycleStatePayload = {
      status: 'degraded',
      observedAt: 1_780_000_000_200,
      sidecarId: 'observer-test',
      reason: RAW_SECRET,
      error: { message: rawError.message },
    };

    const sanitizedError = sanitizeObserverEvalError(rawError);
    const sanitizedLifecycle = sanitizeObserverEvalLifecycleState(lifecycle);
    const logSafeLifecycle = createObserverEvalLogSafeLifecycleState(lifecycle);

    expect(sanitizedError).toMatchObject({
      message: 'Observer eval sidecar error redacted',
      redacted: true,
      redactionReason: 'raw_error_redacted',
      errorKind: 'error',
    });
    expect(sanitizedLifecycle).toMatchObject({
      status: 'degraded',
      reason: 'redacted_lifecycle_reason',
      error: {
        message: 'Observer eval sidecar error redacted',
        redacted: true,
        redactionReason: 'raw_error_redacted',
        rawMessageLength: rawError.message.length,
        errorKind: 'non_error',
      },
      redaction: {
        lifecycleReasonRedacted: true,
        errorRedacted: true,
      },
    });
    expect(logSafeLifecycle).toEqual(sanitizedLifecycle);
    expectNoRawLeak(sanitizedError);
    expectNoRawLeak(sanitizedLifecycle);
    expectNoRawLeak(logSafeLifecycle);
  });

  it('provides log-safe observer input views', () => {
    const input = withRawLeakFields(makeObserverInput({
      source: {
        routingSource: 'api',
        isDirectMessage: false,
        channelPrivacy: 'semi_private',
      },
      metadata: {
        trustLevel: 'trusted',
        speakerRole: 'system',
        contactResolved: false,
        contentLength: RAW_SECRET.length,
        attachmentCount: 0,
        hasVisionInput: false,
        sensitivity: 'personal',
      },
    }));

    const logSafeInput = createObserverEvalLogSafeInput(input);

    expect(logSafeInput.privacy).toMatchObject({
      privacyClass: 'restricted',
      sensitivity: 'personal',
      channelVisibility: 'semi_private',
      redactionReason: 'semi_private_channel_metadata_only',
    });
    expect(logSafeInput.provenance.correlation).toEqual({
      callType: 'chat',
      purposeRedacted: true,
    });
    expectNoRawLeak(logSafeInput);
  });

  it('uses sanitized error and input details for degraded runtime logs', async () => {
    const logger = { debug: vi.fn() };
    const lifecycleStates: ObserverEvalLifecycleStatePayload[] = [];
    const input = withRawLeakFields(makeObserverInput({
      metadata: {
        trustLevel: 'regular',
        speakerRole: 'user',
        contactResolved: true,
        contentLength: RAW_SECRET.length,
        attachmentCount: 0,
        hasVisionInput: false,
      },
    }));

    const sidecarRuntime = {
      config: { enabled: true, sidecarId: 'observer-test' },
      observer: {
        observeTurn: () => {
          throw new Error(`sidecar saw ${RAW_SECRET}`);
        },
      },
      onLifecycleState: (lifecycleState: ObserverEvalLifecycleStatePayload) => {
        lifecycleStates.push(lifecycleState);
      },
    };

    const queuedState = await dispatchObserverEvalTurn({
      input,
      logger,
      sidecarRuntime,
    });
    await drainObserverEvalSidecarQueue(sidecarRuntime);
    const degradedState = lifecycleStates.at(-1);

    expect(queuedState).toMatchObject({
      status: 'enabled',
      reason: 'queued',
    });
    expect(degradedState).toMatchObject({
      status: 'degraded',
      reason: 'observer_failed',
      error: {
        message: 'Observer eval sidecar error redacted',
        redacted: true,
        redactionReason: 'raw_error_redacted',
      },
    });
    expect(lifecycleStates).toHaveLength(2);
    expect(logger.debug).toHaveBeenCalledWith(
      'Observer eval sidecar degraded',
      expect.objectContaining({
        turn: expect.objectContaining({
          redactedIdentifiers: ['requestId', 'sourceMessageId', 'channelId'],
        }),
        privacy: expect.objectContaining({
          privacyClass: 'fail_closed',
          redactionReason: 'missing_sensitivity_metadata',
        }),
        error: expect.objectContaining({
          message: 'Observer eval sidecar error redacted',
        }),
      }),
    );
    expectNoRawLeak(queuedState);
    expectNoRawLeak(degradedState);
    expectNoRawLeak(lifecycleStates);
    expectNoRawLeak(logger.debug.mock.calls);
  });
});
