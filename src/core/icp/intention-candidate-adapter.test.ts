import { describe, expect, it, vi } from 'vitest';

import type { ActiveConcern } from '../intention/concerns.js';
import type { PendingFollowUp } from '../intention/pending-follow-ups.js';
import { CanonicalCompanionPeerValidationError } from './agent-facing-autonomy.js';
import { createIcpIntentionCandidateAdapter } from './intention-candidate-adapter.js';

const NOW = Date.parse('2026-07-13T20:00:00.000Z');
const ROOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function followUp(overrides: Partial<PendingFollowUp> = {}): PendingFollowUp {
  return {
    id: 'follow-up-1',
    content: 'Check in',
    priority: 'medium',
    timing: 'immediate',
    createdAt: new Date(NOW - 1_000).toISOString(),
    channelId: 'human-dm',
    channelType: 'discord',
    authorId: 'system:intention',
    authorName: 'Whisper',
    contactId: 'peer-contact',
    ...overrides,
  };
}

function concern(overrides: Partial<ActiveConcern> = {}): ActiveConcern {
  return {
    id: 'concern-1',
    text: 'Peer sounded tired',
    priority: 'medium',
    source: 'appraisal',
    status: 'active',
    createdAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    salience: 0.5,
    sensitivity: 'personal',
    owner: 'companion',
    evidenceRefs: [],
    resolutionEvidenceRefs: [],
    contactId: 'peer-contact',
    ...overrides,
  };
}

function harness(input: {
  pending?: PendingFollowUp | null;
  concern?: ActiveConcern | null;
  nonCompanion?: boolean;
} = {}) {
  const submit = vi.fn().mockResolvedValue({
    outcome: 'sent',
    candidateId: ROOT,
    status: 'consumed',
  });
  const adapter = createIcpIntentionCandidateAdapter({
    sourceRuntime: { submit },
    peers: {
      resolveKnownPeer: vi.fn().mockImplementation(async contactId => {
        if (input.nonCompanion) {
          throw new CanonicalCompanionPeerValidationError(
            'not_machine_intelligence',
            'not an MI peer',
          );
        }
        return {
          contactId,
          displayName: 'Peer',
          peerCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        };
      }),
    },
    pendingFollowUpStore: {
      peek: vi.fn().mockResolvedValue(input.pending === undefined ? followUp() : input.pending),
    },
    candidateStore: {
      getCandidateByPendingFollowUpId: vi.fn().mockResolvedValue(null),
    },
    concernStore: {
      getById: vi.fn().mockResolvedValue(input.concern === undefined ? concern() : input.concern),
    },
    now: () => NOW,
  });

  return { adapter, submit };
}

const action = {
  id: 'action-1',
  dedupeKey: 'intention.outbound_message:message-1:hash',
  sourceMessageId: 'message-1',
};

describe('ICP intention candidate adapter', () => {
  it('exposes the durable candidate status linked to a pending follow-up', async () => {
    const getCandidateByPendingFollowUpId = vi.fn().mockResolvedValue({ status: 'deferred' });
    const adapter = createIcpIntentionCandidateAdapter({
      sourceRuntime: { submit: vi.fn() },
      peers: { resolveKnownPeer: vi.fn() },
      pendingFollowUpStore: { peek: vi.fn() },
      concernStore: { getById: vi.fn() },
      candidateStore: { getCandidateByPendingFollowUpId },
      now: () => NOW,
    });

    await expect(adapter.getLinkedCandidateStatus('follow-up-1')).resolves.toBe('deferred');
    expect(getCandidateByPendingFollowUpId).toHaveBeenCalledWith('follow-up-1');
  });

  it.each(['invalid_companion_identity', 'reverse_identity_mismatch'] as const)(
    'blocks %s without legacy dispatch eligibility',
    async (reason) => {
      const submit = vi.fn();
      const blockedAdapter = createIcpIntentionCandidateAdapter({
        sourceRuntime: { submit },
        peers: {
          resolveKnownPeer: vi.fn().mockRejectedValue(
            new CanonicalCompanionPeerValidationError(reason, 'invalid MI identity'),
          ),
        },
        pendingFollowUpStore: { peek: vi.fn().mockResolvedValue(followUp()) },
        candidateStore: { getCandidateByPendingFollowUpId: vi.fn().mockResolvedValue(null) },
        concernStore: { getById: vi.fn().mockResolvedValue(concern()) },
        now: () => NOW,
      });

      await expect(blockedAdapter.submit({
        action,
        payload: {
          channelId: 'human-dm',
          channelType: 'discord',
          content: 'Hi',
          pendingFollowUpId: 'follow-up-1',
        },
      })).resolves.toEqual({ kind: 'blocked', reason: 'ambiguous_contact' });
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it('submits one shared private candidate for a live peer follow-up', async () => {
    const { adapter, submit } = harness();
    await expect(adapter.submit({
      action,
      payload: {
        channelId: 'human-dm',
        channelType: 'discord',
        content: 'This peer-visible draft must not be used as transport.',
        reason: 'A private reason',
        pendingFollowUpId: 'follow-up-1',
        originIcpRootInitiationId: ROOT,
      },
    })).resolves.toMatchObject({ kind: 'submitted' });
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'intention',
      peerContactId: 'peer-contact',
      sourceRecordId: action.dedupeKey,
      pendingFollowUpId: 'follow-up-1',
      reasonSummary: 'A private reason',
      cause: { kind: 'icp_conversation', rootInitiationId: ROOT },
    }));
  });

  it('derives inherited causality from a cited durable concern after payload lineage is absent', async () => {
    const { adapter, submit } = harness({
      concern: concern({ originIcpRootInitiationId: ROOT }),
    });

    await expect(adapter.submit({
      action,
      payload: {
        channelId: 'human-dm',
        channelType: 'discord',
        content: 'Hi',
        concernIds: ['concern-1'],
      },
    })).resolves.toMatchObject({ kind: 'submitted' });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      cause: { kind: 'icp_conversation', rootInitiationId: ROOT },
    }));
  });

  it('fails closed when cited durable records carry conflicting ICP roots', async () => {
    const { adapter, submit } = harness({
      pending: followUp({ originIcpRootInitiationId: ROOT }),
      concern: concern({
        originIcpRootInitiationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
    });

    await expect(adapter.submit({
      action,
      payload: {
        channelId: 'human-dm',
        channelType: 'discord',
        content: 'Hi',
        pendingFollowUpId: 'follow-up-1',
        concernIds: ['concern-1'],
      },
    })).resolves.toEqual({ kind: 'blocked', reason: 'stale_provenance' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('blocks stale follow-up provenance without reaching the broker', async () => {
    const { adapter, submit } = harness({
      pending: followUp({ activatedAt: new Date(NOW - 100).toISOString() }),
    });
    await expect(adapter.submit({
      action,
      payload: {
        channelId: 'human-dm',
        channelType: 'discord',
        content: 'Hi',
        pendingFollowUpId: 'follow-up-1',
      },
    })).resolves.toEqual({ kind: 'blocked', reason: 'stale_provenance' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('blocks terminal concern provenance without reaching the broker', async () => {
    const { adapter, submit } = harness({ concern: concern({ status: 'resolved' }) });
    await expect(adapter.submit({
      action,
      payload: {
        channelId: 'human-dm',
        channelType: 'discord',
        content: 'Hi',
        concernIds: ['concern-1'],
      },
    })).resolves.toEqual({ kind: 'blocked', reason: 'stale_provenance' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('returns not_companion for a human contact so the existing sender remains authoritative', async () => {
    const { adapter, submit } = harness({ nonCompanion: true });
    await expect(adapter.submit({
      action,
      payload: {
        channelId: 'human-dm',
        channelType: 'discord',
        content: 'Hi',
        pendingFollowUpId: 'follow-up-1',
      },
    })).resolves.toEqual({ kind: 'not_companion' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('blocks provenance that spans more than one contact', async () => {
    const { adapter, submit } = harness({
      concern: concern({ contactId: 'other-peer' }),
    });
    await expect(adapter.submit({
      action,
      payload: {
        channelId: 'human-dm',
        channelType: 'discord',
        content: 'Hi',
        pendingFollowUpId: 'follow-up-1',
        concernIds: ['concern-1'],
      },
    })).resolves.toEqual({ kind: 'blocked', reason: 'ambiguous_contact' });
    expect(submit).not.toHaveBeenCalled();
  });
});
