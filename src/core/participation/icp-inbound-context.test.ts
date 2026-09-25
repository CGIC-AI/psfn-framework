import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '../session/types.js';
import { loadIcpAppraisalPrecedingContext } from './icp-inbound-context.js';
import { buildAppraisalDecisionQuestions } from './appraiser-decision.js';

const DM = 'companion-dm:aaaaaaaa-0000-4000-8000-00000000000a:bbbbbbbb-0000-4000-8000-00000000000b';

function entry(id: number, role: SessionEntry['role'], content: string, extra: Partial<SessionEntry> = {}): SessionEntry {
  return { id, channelId: DM, role, content, timestamp: id * 100, ...extra };
}

describe('loadIcpAppraisalPrecedingContext (p6s1f)', () => {
  const history = [
    entry(1, 'user', 'first peer turn', { authorName: 'Nova' }),
    entry(2, 'assistant', 'my answer'),
    entry(3, 'tool', 'tool output must not leak'),
    entry(4, 'system', '{"kind":"icp_delivery"}'),
    entry(5, 'user', 'second peer turn', { authorName: 'Nova' }),
    entry(6, 'user', 'the trigger itself', { discordMessageId: 'companion-initiation-x' }),
    entry(9, 'user', 'arrived after the trigger'),
  ];

  it('returns only conversational turns of the same channel before the trigger', async () => {
    const context = await loadIcpAppraisalPrecedingContext(
      { reader: { getRecent: () => [...history, { ...entry(4, 'user', 'other room'), channelId: 'api:other' }] }, messageLimit: 6 },
      { channelId: DM, messageId: 'companion-initiation-x', timestampMs: 700 },
    );
    expect(context.map(message => message.content)).toEqual(['first peer turn', 'my answer', 'second peer turn']);
    expect(context.map(message => message.authorName)).toEqual(['Nova', 'you', 'Nova']);
  });

  it('bounds the window to the most recent turns and reads only the trigger channel', async () => {
    const requested: string[] = [];
    const context = await loadIcpAppraisalPrecedingContext(
      { reader: { getRecent: (channelId) => { requested.push(channelId); return history; } }, messageLimit: 2 },
      { channelId: DM, messageId: 'companion-initiation-x', timestampMs: 700 },
    );
    expect(requested).toEqual([DM]);
    expect(context.map(message => message.content)).toEqual(['my answer', 'second peer turn']);
  });

  it('rejects an invalid limit', async () => {
    await expect(loadIcpAppraisalPrecedingContext(
      { reader: { getRecent: () => [] }, messageLimit: -1 },
      { channelId: DM, messageId: 'x', timestampMs: 1 },
    )).rejects.toThrow('non-negative integer');
  });
});

describe('companion_dm decision framing (p6s1f)', () => {
  it('frames the trigger as a direct message in the private conversation, not a group mention', () => {
    const instructions = buildAppraisalDecisionQuestions('companion_dm').action!.instructions;
    expect(instructions).toContain('sent directly to');
    expect(instructions).not.toContain('usually not an invitation to speak');
  });
});
