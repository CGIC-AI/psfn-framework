import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MEMORY_RETRIEVAL_BUDGET_PCT_RANGE,
  SESSION_HISTORY_BUDGET_PCT_RANGE,
} from '../../../shared/context-budget.js';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import {
  createBackgroundWorkIdentity,
  createTurnRecordBackgroundWorkHandoff,
  fingerprintBackgroundWorkPayload,
  fingerprintBackgroundWorkTurnRecord,
  parseBackgroundWorkPayload,
  parseTurnRecordBackgroundWorkHandoff,
  repairLegacyTurnRecordBackgroundWorkHandoffForRecovery,
  stableBackgroundWorkStringify,
  type AutoCompactionBackgroundPayload,
  type EnqueueBackgroundWorkInput,
} from './types.js';

function fingerprintUnknownPayload(payload: unknown): string {
  return createHash('sha256').update(stableBackgroundWorkStringify(payload)).digest('hex');
}

function makeTurnRecord(): TurnRecord {
  return {
    schemaVersion: 1,
    turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4e',
    requestId: 'request-a',
    sessionId: 'session-a',
    channelId: 'channel-a',
    channelType: 'api',
    startedAt: 90,
    completedAt: 100,
    status: 'completed',
    userMessage: { role: 'user', content: 'private prompt', timestamp: 90 },
    assistantMessage: { role: 'assistant', content: 'private response', timestamp: 100 },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: { model: 'test-model' },
    provenanceRefs: [],
  };
}

function makePayload(record = makeTurnRecord()): AutoCompactionBackgroundPayload {
  return {
    schemaVersion: 1,
    kind: 'auto_compaction',
    source: {
      schemaVersion: 1,
      logicalSessionId: record.sessionId ?? record.channelId,
      channelId: record.channelId,
      turnId: record.turnId,
      requestId: record.requestId,
      turnRecordFingerprint: fingerprintBackgroundWorkTurnRecord(record),
      createdAtMs: record.completedAt,
    },
    systemPromptTokenCount: 10,
    memoriesTokenCount: 5,
    adaptiveProfile: {
      enabled: true,
      source: 'adaptive',
      category: 'task',
      sessionHistoryBudgetPct: SESSION_HISTORY_BUDGET_PCT_RANGE.max,
      memoryRetrievalBudgetPct: MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.min,
    },
    turnBudgetCharacteristics: {
      channelId: record.channelId,
      channelType: record.channelType,
      isDirectMessage: true,
      taskKind: 'chat',
      modelSelection: {
        purpose: 'chat',
        slotKey: 'chat-primary',
        provider: 'test-provider',
        model: 'test-model',
        contextWindow: 16_384,
      },
    },
    channelMeta: {
      isDirectMessage: true,
      privacyLevel: 'private',
      disclosureConsentGranted: false,
    },
  };
}

function makeInput(
  record: TurnRecord,
  payload: AutoCompactionBackgroundPayload,
): EnqueueBackgroundWorkInput {
  const logicalSessionId = record.sessionId ?? record.channelId;
  return {
    ...createBackgroundWorkIdentity({
      logicalSessionId,
      turnId: record.turnId,
      kind: payload.kind,
    }),
    logicalSessionId,
    kind: payload.kind,
    payload,
    payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
    sourceTurnId: record.turnId,
    sourceRequestId: record.requestId,
    sourceChannelId: record.channelId,
    createdAtMs: record.completedAt,
    maxAttempts: 5,
  };
}

function withPayloadMutation(
  mutate: (payload: Record<string, unknown>) => void,
): unknown {
  const payload = structuredClone(makePayload()) as unknown as Record<string, unknown>;
  mutate(payload);
  return payload;
}

describe('auto-compaction background payload contract', () => {
  it('round-trips the complete current model-selection schema with stable bytes and fingerprint', () => {
    const payload = makePayload();

    const parsed = parseBackgroundWorkPayload(payload.kind, payload);
    const reparsed = parseBackgroundWorkPayload(payload.kind, parsed);

    expect(parsed).toEqual(payload);
    expect(stableBackgroundWorkStringify(reparsed)).toBe(stableBackgroundWorkStringify(payload));
    expect(fingerprintBackgroundWorkPayload(reparsed)).toBe(fingerprintBackgroundWorkPayload(payload));
  });

  it.each([
    'chat',
    'background',
    'memory',
    'context',
    'reasoning',
    'longContext',
    'vision',
    'moa',
  ])('accepts current model purpose %s', (purpose) => {
    const payload = withPayloadMutation((candidate) => {
      const turn = candidate.turnBudgetCharacteristics as Record<string, unknown>;
      (turn.modelSelection as Record<string, unknown>).purpose = purpose;
    });

    expect(parseBackgroundWorkPayload('auto_compaction', payload)).toMatchObject({
      turnBudgetCharacteristics: { modelSelection: { purpose } },
    });
  });

  it.each([
    ['unknown model-selection key', (payload: Record<string, unknown>) => {
      const turn = payload.turnBudgetCharacteristics as Record<string, unknown>;
      (turn.modelSelection as Record<string, unknown>).unknown = true;
    }],
    ['partner-content-shaped model-selection key', (payload: Record<string, unknown>) => {
      const turn = payload.turnBudgetCharacteristics as Record<string, unknown>;
      (turn.modelSelection as Record<string, unknown>).partnerMessage = 'private prompt';
    }],
    ['nested unsupported model-selection data', (payload: Record<string, unknown>) => {
      const turn = payload.turnBudgetCharacteristics as Record<string, unknown>;
      (turn.modelSelection as Record<string, unknown>).provider = { rawContent: 'private prompt' };
    }],
    ['wrong model-selection string type', (payload: Record<string, unknown>) => {
      const turn = payload.turnBudgetCharacteristics as Record<string, unknown>;
      (turn.modelSelection as Record<string, unknown>).purpose = 42;
    }],
    ['unsupported model-selection purpose', (payload: Record<string, unknown>) => {
      const turn = payload.turnBudgetCharacteristics as Record<string, unknown>;
      (turn.modelSelection as Record<string, unknown>).purpose = 'summary';
    }],
    ['wrong context-window type', (payload: Record<string, unknown>) => {
      const turn = payload.turnBudgetCharacteristics as Record<string, unknown>;
      (turn.modelSelection as Record<string, unknown>).contextWindow = '16384';
    }],
    ['non-positive context window', (payload: Record<string, unknown>) => {
      const turn = payload.turnBudgetCharacteristics as Record<string, unknown>;
      (turn.modelSelection as Record<string, unknown>).contextWindow = 0;
    }],
    ['fractional context window', (payload: Record<string, unknown>) => {
      const turn = payload.turnBudgetCharacteristics as Record<string, unknown>;
      (turn.modelSelection as Record<string, unknown>).contextWindow = 1.5;
    }],
    ['raw content beside model selection', (payload: Record<string, unknown>) => {
      const turn = payload.turnBudgetCharacteristics as Record<string, unknown>;
      turn.partnerMessage = 'private prompt';
    }],
    ['adaptive-profile nested unsupported data', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).rawContent = { text: 'private prompt' };
    }],
    ['retired channel privacy label', (payload: Record<string, unknown>) => {
      (payload.channelMeta as Record<string, unknown>).privacyLevel = 'direct';
    }],
    ['string session percentage', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).sessionHistoryBudgetPct = '6';
    }],
    ['nonfinite session percentage', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).sessionHistoryBudgetPct = Number.NaN;
    }],
    ['fractional session percentage', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).sessionHistoryBudgetPct = 6.5;
    }],
    ['session percentage below range', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).sessionHistoryBudgetPct =
        SESSION_HISTORY_BUDGET_PCT_RANGE.min - 1;
    }],
    ['session percentage above range', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).sessionHistoryBudgetPct =
        SESSION_HISTORY_BUDGET_PCT_RANGE.max + 1;
    }],
    ['nonfinite memory percentage', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).memoryRetrievalBudgetPct =
        Number.POSITIVE_INFINITY;
    }],
    ['fractional memory percentage', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).memoryRetrievalBudgetPct = 2.5;
    }],
    ['memory percentage below range', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).memoryRetrievalBudgetPct =
        MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.min - 1;
    }],
    ['memory percentage above range', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).memoryRetrievalBudgetPct =
        MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.max + 1;
    }],
    ['enabled disabled-source profile', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).enabled = true;
      (payload.adaptiveProfile as Record<string, unknown>).source = 'disabled';
      (payload.adaptiveProfile as Record<string, unknown>).category = 'default';
    }],
    ['categorized disabled-source profile', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).enabled = false;
      (payload.adaptiveProfile as Record<string, unknown>).source = 'disabled';
      (payload.adaptiveProfile as Record<string, unknown>).category = 'task';
    }],
    ['disabled default-source profile', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).enabled = false;
      (payload.adaptiveProfile as Record<string, unknown>).source = 'default';
      (payload.adaptiveProfile as Record<string, unknown>).category = 'default';
    }],
    ['categorized default-source profile', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).enabled = true;
      (payload.adaptiveProfile as Record<string, unknown>).source = 'default';
      (payload.adaptiveProfile as Record<string, unknown>).category = 'task';
    }],
    ['disabled adaptive-source profile', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).enabled = false;
      (payload.adaptiveProfile as Record<string, unknown>).source = 'adaptive';
      (payload.adaptiveProfile as Record<string, unknown>).category = 'task';
    }],
    ['default-category adaptive-source profile', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).enabled = true;
      (payload.adaptiveProfile as Record<string, unknown>).source = 'adaptive';
      (payload.adaptiveProfile as Record<string, unknown>).category = 'default';
    }],
  ] satisfies Array<[string, (payload: Record<string, unknown>) => void]>)('rejects %s', (_name, mutate) => {
    const payload = withPayloadMutation(mutate);

    expect(() => parseBackgroundWorkPayload('auto_compaction', payload)).toThrow();
  });

  it('rejects malformed compaction payloads at handoff creation and replay', () => {
    const record = makeTurnRecord();
    const malformed = withPayloadMutation((payload) => {
      const turn = payload.turnBudgetCharacteristics as Record<string, unknown>;
      (turn.modelSelection as Record<string, unknown>).partnerMessage = 'private prompt';
    }) as AutoCompactionBackgroundPayload;
    const job = makeInput(record, malformed);

    expect(() => createTurnRecordBackgroundWorkHandoff([job])).toThrow();

    record.backgroundWorkHandoff = { schemaVersion: 1, jobs: [job] };
    expect(() => parseTurnRecordBackgroundWorkHandoff(record)).toThrow();
  });
});

describe('legacy emotion-appraisal TurnRecord recovery', () => {
  function makeLegacyEmotionJob(record: TurnRecord) {
    const logicalSessionId = record.sessionId ?? record.channelId;
    const payload = {
      schemaVersion: 1 as const,
      kind: 'emotion_appraisal' as const,
      source: {
        schemaVersion: 1 as const,
        logicalSessionId,
        channelId: record.channelId,
        turnId: record.turnId,
        requestId: record.requestId,
        turnRecordFingerprint: fingerprintBackgroundWorkTurnRecord(record),
        createdAtMs: record.completedAt,
      },
      emotionSessionId: logicalSessionId,
      internalStateSnapshotRef: 'internal-state-v1:legacy-appraisal',
      appraisalState: {
        schemaVersion: 1 as const,
        emotional: {
          vad: { valence: 0.2, arousal: 0.3, dominance: 0.4 },
          mood: { valence: 0.1, arousal: 0.2, dominance: 0.3 },
          discreteEmotions: { joy: 0.7 },
          confidence: 0.8,
          telemetry: {
            status: 'trusted' as const,
            source: 'runtime_state' as const,
            reasons: [],
            weight: 1,
          },
        },
        cognitive: { certaintyLevel: 0.6, topicEngagement: 0.7, processingQuality: 'fluent' as const },
        attention: {
          activeConcernCount: 2,
          salientEntityCount: 1,
          conversationTrajectory: 'deepening' as const,
        },
        relational: { contactId: 'contact-1', trustLevel: 'regular' as const, moodDrift: 0.1 },
      },
      personalityOwnerRef: 'character-card' as const,
      personalityProjectionHash: 'a'.repeat(64),
    };
    return {
      ...createBackgroundWorkIdentity({
        logicalSessionId,
        turnId: record.turnId,
        kind: payload.kind,
      }),
      logicalSessionId,
      kind: payload.kind,
      payload,
      payloadFingerprint: fingerprintUnknownPayload(payload),
      sourceTurnId: record.turnId,
      sourceRequestId: record.requestId,
      sourceChannelId: record.channelId,
      createdAtMs: record.completedAt,
      maxAttempts: 3,
    };
  }

  it('retires an exact pre-drift appraisal while preserving a current sibling handoff', () => {
    const record = makeTurnRecord();
    const compactionPayload = makePayload(record);
    const compactionJob = makeInput(record, compactionPayload);
    const legacyEmotionJob = makeLegacyEmotionJob(record);
    record.backgroundWorkHandoff = {
      schemaVersion: 1,
      jobs: [legacyEmotionJob, compactionJob],
    };

    expect(() => parseTurnRecordBackgroundWorkHandoff(record))
      .toThrow('narrativeAppraisalDrift must be an object');

    const repaired = repairLegacyTurnRecordBackgroundWorkHandoffForRecovery(record);

    expect(repaired.retiredLegacyEmotionAppraisalJobs).toBe(1);
    expect(repaired.record.backgroundWorkHandoff?.jobs).toEqual([compactionJob]);
    expect(parseTurnRecordBackgroundWorkHandoff(repaired.record)).toHaveLength(1);
  });

  it('removes the handoff when the obsolete appraisal was its only job', () => {
    const record = makeTurnRecord();
    record.backgroundWorkHandoff = {
      schemaVersion: 1,
      jobs: [makeLegacyEmotionJob(record)],
    };

    const repaired = repairLegacyTurnRecordBackgroundWorkHandoffForRecovery(record);

    expect(repaired.retiredLegacyEmotionAppraisalJobs).toBe(1);
    expect(repaired.record.backgroundWorkHandoff).toBeUndefined();
  });

  it('fails closed on a near-legacy appraisal with an unsupported field', () => {
    const record = makeTurnRecord();
    const job = makeLegacyEmotionJob(record);
    const payload = job.payload as Record<string, unknown>;
    payload.unreviewedMigrationField = true;
    job.payloadFingerprint = fingerprintUnknownPayload(payload);
    record.backgroundWorkHandoff = { schemaVersion: 1, jobs: [job] };

    expect(() => repairLegacyTurnRecordBackgroundWorkHandoffForRecovery(record))
      .toThrow('legacy emotion appraisal payload contains unsupported field');
  });

  it('fails closed when a legacy appraisal binding or fingerprint was altered', () => {
    const record = makeTurnRecord();
    const job = makeLegacyEmotionJob(record);
    job.sourceRequestId = 'wrong-request';
    record.backgroundWorkHandoff = { schemaVersion: 1, jobs: [job] };

    expect(() => repairLegacyTurnRecordBackgroundWorkHandoffForRecovery(record))
      .toThrow('source_request_id');
  });
});
