import { describe, expect, it, vi } from 'vitest';

import { createTurnRecordBlindReviewEvidenceSource } from './evidence-source.js';
import type { TurnRecord } from '../../../shared/contracts/runtime.js';
import type { TurnID } from '../../../shared/contracts/runtime-base.js';

const CHANNEL = 'discord:channel:public-room';
const PRIVATE_TEXT = 'Ask @nadia to tell my therapist about the meeting at Acme Corporation.';

function turnRecord(overrides: Partial<TurnRecord> = {}): TurnRecord {
  const turnId = (overrides.turnId ?? 'turn-1') as TurnID;
  return {
    schemaVersion: 1,
    turnId,
    requestId: 'request-1',
    channelId: CHANNEL,
    channelType: 'discord',
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_001_500,
    status: 'completed',
    userMessage: { role: 'user', content: 'hello there', timestamp: 1_700_000_000_000 },
    assistantMessage: { role: 'assistant', content: PRIVATE_TEXT, timestamp: 1_700_000_001_000 },
    toolCalls: [
      { toolName: 'memory_search', rationale: 'private chain of thought', isError: false },
      { toolName: 'memory_search', isError: true },
      { toolName: 'web_fetch', isError: false },
    ],
    extractedMemoryIds: ['m1', 'm2'],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: {},
    provenanceRefs: [],
    ...overrides,
  } as TurnRecord;
}

/** The companion's own recorded mark that this exchange was public and ordinary. */
function publicPrivacy(turnId = 'turn-1', requestId = 'request-1'): TurnRecord['auditPrivacy'] {
  return {
    schemaVersion: 1,
    contentMode: 'verbatim_public',
    channelPrivacy: 'public',
    contentSensitivity: 'non_intimate',
    contentSensitivityActor: { kind: 'companion', turnId: turnId as TurnID, requestId },
    reason: 'explicit_public_non_dm',
  };
}

function sourceOver(records: TurnRecord[], options: { retired?: boolean } = {}) {
  const getRecentSourceTurnRecords = vi.fn(() => records);
  const source = createTurnRecordBlindReviewEvidenceSource({
    recentSessionLimit: 4,
    maxToolNamesPerItem: 12,
    reader: {
      listRecentSessions: () => [{ sessionId: 'session-1', sourceChannelId: CHANNEL }],
      getRecentSourceTurnRecords,
      isSessionRetiredOrQuarantined: () => options.retired === true,
    },
  });
  return { source, getRecentSourceTurnRecords };
}

async function listOnce(records: TurnRecord[], sinceMs = 0) {
  const { source } = sourceOver(records);
  return source.listEvidence({ sinceMs, limit: 50, maxBlindedCharsPerItem: 200 });
}

describe('blind review evidence source', () => {
  it('reduces an unmarked turn to structural signals with no text', async () => {
    const [item] = await listOnce([turnRecord()]);
    expect(item).toBeDefined();
    expect(item?.disclosure).toBe('structural_only');
    expect(item?.blindedExcerpt).toBe('');
    expect(item?.activity).toEqual({
      toolCallCount: 3,
      toolNames: ['memory_search', 'web_fetch'],
      toolErrorCount: 1,
      assistantChars: PRIVATE_TEXT.length,
      userChars: 'hello there'.length,
      extractedMemoryCount: 2,
      durationMs: 1_500,
    });
  });

  it('never stores raw text: the excerpt is blinded before it leaves capture', async () => {
    const [item] = await listOnce([turnRecord({ auditPrivacy: publicPrivacy() })]);
    expect(item?.disclosure).toBe('blinded_excerpt');
    expect(item?.blindedExcerpt).not.toContain('@nadia');
    expect(item?.blindedExcerpt).not.toContain('my therapist');
    expect(item?.blindedExcerpt).toContain('[person]');
    expect(item?.blindedExcerpt).toContain('[relationship]');
  });

  it('never carries tool-call rationale, which the public mark does not cover', async () => {
    const [item] = await listOnce([turnRecord({ auditPrivacy: publicPrivacy() })]);
    expect(item?.blindedExcerpt).not.toContain('private chain of thought');
  });

  it('truncates the excerpt to the per-item ceiling', async () => {
    const long = 'ordinary sentence. '.repeat(100);
    const { source } = sourceOver([
      turnRecord({ auditPrivacy: publicPrivacy(), assistantMessage: { role: 'assistant', content: long, timestamp: 1 } }),
    ]);
    const [item] = await source.listEvidence({ sinceMs: 0, limit: 10, maxBlindedCharsPerItem: 64 });
    expect(item?.blindedExcerpt).toHaveLength(64);
  });

  it.each([
    ['a non-public channel mark', { ...publicPrivacy(), channelPrivacy: 'private' as const }],
    ['an intimate mark', { ...publicPrivacy(), contentSensitivity: 'intimate' as const }],
    ['an emotional-signal-only mark', { ...publicPrivacy(), contentMode: 'emotional_signal_only' as const }],
    ['a mark drawn for a different turn', publicPrivacy('turn-other', 'request-1')],
    ['a mark drawn for a different request', publicPrivacy('turn-1', 'request-other')],
  ])('falls back to structural-only for %s', async (_label, auditPrivacy) => {
    const [item] = await listOnce([turnRecord({ auditPrivacy })]);
    expect(item?.disclosure).toBe('structural_only');
    expect(item?.blindedExcerpt).toBe('');
  });

  it('skips failed turns and everything at or before the watermark', async () => {
    const records = [
      turnRecord({ turnId: 'turn-a' as TurnID, completedAt: 1_000 }),
      turnRecord({ turnId: 'turn-b' as TurnID, completedAt: 2_000, status: 'failed' }),
      turnRecord({ turnId: 'turn-c' as TurnID, completedAt: 3_000 }),
    ];
    const items = await listOnce(records, 1_000);
    expect(items.map(item => item.occurredAtMs)).toEqual([3_000]);
  });

  it('never resurrects a retired or quarantined session', async () => {
    const { source, getRecentSourceTurnRecords } = sourceOver([turnRecord()], { retired: true });
    const items = await source.listEvidence({ sinceMs: 0, limit: 10, maxBlindedCharsPerItem: 200 });
    expect(items).toEqual([]);
    expect(getRecentSourceTurnRecords).not.toHaveBeenCalled();
  });

  it('bounds one pass by the ingest limit and returns oldest-first', async () => {
    const records = Array.from({ length: 10 }, (_, index) => turnRecord({
      turnId: `turn-${index}` as TurnID,
      completedAt: 10_000 - index * 100,
    }));
    const { source } = sourceOver(records);
    const items = await source.listEvidence({ sinceMs: 0, limit: 3, maxBlindedCharsPerItem: 200 });
    expect(items).toHaveLength(3);
    expect(items.map(item => item.occurredAtMs)).toEqual([9_100, 9_200, 9_300]);
  });
});
