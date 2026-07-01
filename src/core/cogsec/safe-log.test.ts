import { describe, expect, it } from 'vitest';
import type { CogSecEvent } from './events.js';
import {
  buildCogSecEventNoticeBlock,
  listAgentVisibleCogSecEvents,
  listOperatorVisibleCogSecEvents,
  toAgentVisibleCogSecEvent,
} from './safe-log.js';

const SAFE_SUMMARY = 'Unsafe instruction-like content was sealed and removed from active cognition.';
const DIRTY_TEXT = 'SMOKE_DIRTY_COGSEC_TEXT';
const SEALED_REF = `cogsec-forensic://cogsec_20260701T000000Z_safe/${DIRTY_TEXT}.json`;
const SEALED_HASH = `sha256:${'b'.repeat(64)}`;

function makeEvent(overrides: Partial<CogSecEvent> = {}): CogSecEvent {
  return {
    caseId: 'cogsec_20260701T000000Z_safe',
    type: 'content_poisoning',
    severity: 'high',
    status: 'applied',
    sourceChannelId: 'discord-channel-1',
    affectedLogicalSessionIds: ['logical-session-1'],
    affectedMessageRanges: [{
      sourceChannelId: 'discord-channel-1',
      logicalSessionId: 'logical-session-1',
      startEntryId: 10,
      endEntryId: 12,
      messageIds: [10, 11, 12],
      discordMessageIds: ['discord-message-10'],
    }],
    sealedForensicPayloadRefs: [SEALED_REF],
    sealedForensicPayloadHashes: [SEALED_HASH],
    tombstonedL0RowCount: 3,
    affectedArtifacts: {
      memories: {
        ids: ['memory-dirty'],
        count: 1,
      },
      compaction_summaries: {
        ids: ['logical-session-1:compaction:1'],
        count: 1,
      },
    },
    actions: ['seal', 'tombstone', 'search_exclude', 'revoke', 'regenerate'],
    actor: 'operator',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:03.000Z',
    appliedAt: '2026-07-01T00:00:03.000Z',
    safeAgentSummary: SAFE_SUMMARY,
    resultCounters: {
      sealedArtifacts: 1,
      tombstonedL0Rows: 3,
      searchExcludedRows: 3,
      revokedArtifacts: 2,
      regeneratedArtifacts: 2,
    },
    epochCuts: [{
      sourceChannelId: 'discord-channel-1',
      oldLogicalSessionId: 'logical-session-1',
      newLogicalSessionId: 'logical-session-2',
      cutAt: '2026-07-01T00:00:03.000Z',
    }],
    ...overrides,
  };
}

describe('CogSec safe event log', () => {
  it('exposes agent-visible metadata without sealed refs, hashes, or dirty text', () => {
    const visible = toAgentVisibleCogSecEvent(makeEvent());
    const serialized = JSON.stringify(visible);

    expect(visible).toMatchObject({
      caseId: 'cogsec_20260701T000000Z_safe',
      sourceChannelId: 'discord-channel-1',
      tombstonedL0RowCount: 3,
      safeSummary: SAFE_SUMMARY,
      affectedArtifactCounts: {
        memories: 1,
        compaction_summaries: 1,
      },
    });
    expect(visible.affectedRanges).toEqual([{
      sourceChannelId: 'discord-channel-1',
      logicalSessionId: 'logical-session-1',
      startEntryId: 10,
      endEntryId: 12,
      messageIdCount: 3,
      discordMessageIdCount: 1,
    }]);
    expect(serialized).not.toContain(SEALED_REF);
    expect(serialized).not.toContain(SEALED_HASH);
    expect(serialized).not.toContain(DIRTY_TEXT);
    expect(serialized).not.toContain('sealedForensicPayloadRefs');
    expect(serialized).not.toContain('sealedForensicPayloadHashes');
    expect(serialized).not.toContain('payload');
  });

  it('keeps operator-visible diagnostics to counts instead of sealed artifact refs', () => {
    const visible = listOperatorVisibleCogSecEvents([makeEvent()])[0];
    const serialized = JSON.stringify(visible);

    expect(visible.sealedArtifactCount).toBe(1);
    expect(visible.sealedHashCount).toBe(1);
    expect(serialized).not.toContain(SEALED_REF);
    expect(serialized).not.toContain(SEALED_HASH);
    expect(serialized).not.toContain(DIRTY_TEXT);
  });

  it('filters safe events to relevant source or logical channels', () => {
    const event = makeEvent();
    const unrelated = makeEvent({
      caseId: 'cogsec_20260701T000000Z_other',
      sourceChannelId: 'discord-channel-2',
      affectedLogicalSessionIds: ['logical-session-9'],
      affectedMessageRanges: [{
        sourceChannelId: 'discord-channel-2',
        logicalSessionId: 'logical-session-9',
      }],
      epochCuts: [],
      updatedAt: '2026-07-01T00:00:04.000Z',
    });

    expect(listAgentVisibleCogSecEvents([event, unrelated], {
      channelIds: ['discord-channel-1'],
    }).map(item => item.caseId)).toEqual(['cogsec_20260701T000000Z_safe']);
    expect(listAgentVisibleCogSecEvents([event, unrelated], {
      channelIds: ['logical-session-1'],
    }).map(item => item.caseId)).toEqual(['cogsec_20260701T000000Z_safe']);
    expect(listAgentVisibleCogSecEvents([event, unrelated], {
      channelIds: ['missing-channel'],
    })).toEqual([]);
  });

  it('formats prompt notices without sealed refs, dirty text, or attack mechanics', () => {
    const block = buildCogSecEventNoticeBlock([makeEvent()], {
      channelIds: ['discord-channel-1'],
    });

    expect(block).toContain('<cogsec_notices>');
    expect(block).toContain('cogsec_20260701T000000Z_safe');
    expect(block).toContain(SAFE_SUMMARY);
    expect(block).not.toContain(SEALED_REF);
    expect(block).not.toContain(SEALED_HASH);
    expect(block).not.toContain(DIRTY_TEXT);
    expect(block).not.toMatch(/\bpayload\b/iu);
    expect(block).not.toMatch(/\bbypass\b/iu);
    expect(block).not.toMatch(/\bexploit\b/iu);
    expect(block).not.toMatch(/\breproducer\b/iu);
  });
});
