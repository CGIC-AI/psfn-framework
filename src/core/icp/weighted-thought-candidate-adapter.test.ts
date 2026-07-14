import { describe, expect, it, vi } from 'vitest';

import { createThoughtWeight } from '../intention/weighted-thoughts.js';
import { CanonicalCompanionPeerValidationError } from './agent-facing-autonomy.js';
import { createIcpWeightedThoughtCandidateAdapter } from './weighted-thought-candidate-adapter.js';

function thought() {
  return createThoughtWeight({
    id: 'thought-1',
    content: 'I wonder how my peer is doing.',
    source: 'icp_reply',
    thoughtClass: 'standard',
    contactId: 'peer-contact',
    provenance: {
      sourceChannelId: 'companion-room:kitchen',
      icpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
  }, {
    classes: {
      time_sensitive: { baseWeight: 1, halflifeMs: 1_000 },
      standard: { baseWeight: 1, halflifeMs: 1_000 },
      trivial: { baseWeight: 1, halflifeMs: 1_000 },
    },
    reinforcement: { repeatBoost: 0.5, emotionalChargeWeight: 1 },
    accumulatedWeightCap: 3,
    contradictionDampeningFactor: 0.5,
    declineDampeningFactor: 0.5,
    relevanceFloor: 0.01,
  }, 1_700_000_000_000);
}

describe('ICP weighted-thought candidate adapter', () => {
  it('preserves room and inherited-root provenance for a canonical peer', async () => {
    const submit = vi.fn().mockResolvedValue({
      outcome: 'deferred',
      candidateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      status: 'deferred',
    });
    const adapter = createIcpWeightedThoughtCandidateAdapter({
      sourceRuntime: { submit },
      peers: {
        resolveKnownPeer: vi.fn().mockResolvedValue({
          contactId: 'peer-contact',
          displayName: 'Peer',
          peerCompanionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        }),
      },
    });
    await expect(adapter.submit({ thought: thought(), weight: 1, nowMs: 1 }))
      .resolves.toMatchObject({ status: 'deferred' });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'weighted_thought',
      preferredChannel: 'current_room',
      currentRoomChannelId: 'companion-room:kitchen',
      cause: {
        kind: 'icp_conversation',
        rootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    }));
  });

  it('returns null for a human contact without touching the candidate broker', async () => {
    const submit = vi.fn();
    const adapter = createIcpWeightedThoughtCandidateAdapter({
      sourceRuntime: { submit },
      peers: {
        resolveKnownPeer: vi.fn().mockRejectedValue(
          new CanonicalCompanionPeerValidationError('not a peer'),
        ),
      },
    });
    await expect(adapter.submit({ thought: thought(), weight: 1, nowMs: 1 }))
      .resolves.toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });
});
