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
  stableBackgroundWorkStringify,
  type AutoCompactionBackgroundPayload,
  type EnqueueBackgroundWorkInput,
} from './types.js';

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
    ['memory percentage below range', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).memoryRetrievalBudgetPct =
        MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.min - 1;
    }],
    ['memory percentage above range', (payload: Record<string, unknown>) => {
      (payload.adaptiveProfile as Record<string, unknown>).memoryRetrievalBudgetPct =
        MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.max + 1;
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
