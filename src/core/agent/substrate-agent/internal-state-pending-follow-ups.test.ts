import { describe, expect, it, vi } from 'vitest';
import type {
  PendingFollowUp,
  PendingFollowUpContextProvider,
} from '../../intention/pending-follow-ups.js';
import { InternalStateComputer } from '../../self-model/state.js';
import { resolveInternalStatePendingFollowUps } from './internal-state-pending-follow-ups.js';

const PEER_A = 'a7100000-0000-4000-8000-000000000001';
const PEER_B = 'b7100000-0000-4000-8000-000000000002';
const PEER_CHANNEL_ID = ['companion-dm', PEER_A, PEER_B].join(':');

function makeFollowUp(overrides: Partial<PendingFollowUp> = {}): PendingFollowUp {
  return {
    id: 'follow-up-1',
    content: 'Ask how the garden plan turned out.',
    priority: 'medium',
    timing: 'scheduled',
    createdAt: '2026-09-25T10:00:00.000Z',
    dueAt: '2026-09-26T10:00:00.000Z',
    channelId: PEER_CHANNEL_ID,
    channelType: 'companion',
    authorId: 'system:intention',
    authorName: 'Intention',
    ...overrides,
  };
}

function providerOf(
  followUps: PendingFollowUp[],
  quarantine?: PendingFollowUpContextProvider['quarantinePendingFollowUp'],
): PendingFollowUpContextProvider {
  return {
    getPendingFollowUps: () => followUps,
    ...(quarantine ? { quarantinePendingFollowUp: quarantine } : {}),
  };
}

describe('resolveInternalStatePendingFollowUps', () => {
  it('accepts an ICP follow-up on the companion channel and builds InternalState from it', async () => {
    const quarantine = vi.fn(async () => ({}));
    const followUps = await resolveInternalStatePendingFollowUps(
      providerOf([makeFollowUp()], quarantine),
      'peer-contact',
      PEER_CHANNEL_ID,
    );

    expect(followUps.map(followUp => followUp.id)).toEqual(['follow-up-1']);
    expect(quarantine).not.toHaveBeenCalled();
    const state = new InternalStateComputer().computeState({
      activeConcerns: [],
      pendingFollowUps: followUps,
      trustLevel: 'trusted',
      contactId: 'peer-contact',
      sessionMetrics: {
        userMessageText: 'hello',
        responseText: 'hi',
        toolCallCount: 0,
        recentTurnCount: 1,
      },
    });
    expect(state.attention.pendingFollowUps?.[0]?.channelType).toBe('companion');
  });

  it('quarantines one invalid row and keeps the rest of the state', async () => {
    const quarantine = vi.fn(async () => ({}));
    const bad = makeFollowUp({ id: 'follow-up-bad', channelType: 'pager' as PendingFollowUp['channelType'] });
    const good = makeFollowUp({ id: 'follow-up-good' });

    const followUps = await resolveInternalStatePendingFollowUps(
      providerOf([bad, good], quarantine),
      'peer-contact',
      PEER_CHANNEL_ID,
    );

    expect(followUps.map(followUp => followUp.id)).toEqual(['follow-up-good']);
    expect(quarantine).toHaveBeenCalledTimes(1);
    expect(quarantine).toHaveBeenCalledWith({
      followUpId: 'follow-up-bad',
      reason: expect.stringContaining('unsupported channelType "pager"'),
      raw: bad,
      source: 'internal_state',
    });
  });

  it('fails closed when the provider cannot quarantine an invalid row', async () => {
    const bad = makeFollowUp({ priority: 'urgent' as PendingFollowUp['priority'] });

    await expect(resolveInternalStatePendingFollowUps(
      providerOf([bad]),
      'peer-contact',
      PEER_CHANNEL_ID,
    )).rejects.toThrow(/priority/);
  });

  it('propagates a quarantine write failure instead of dropping the row silently', async () => {
    const quarantine = vi.fn(async () => {
      throw new Error('quarantine insert failed');
    });
    const bad = makeFollowUp({ priority: 'urgent' as PendingFollowUp['priority'] });

    await expect(resolveInternalStatePendingFollowUps(
      providerOf([bad], quarantine),
      'peer-contact',
      PEER_CHANNEL_ID,
    )).rejects.toThrow('quarantine insert failed');
  });
});
