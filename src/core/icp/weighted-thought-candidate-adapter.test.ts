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
    await expect(adapter.submit({ thought: thought() }))
      .resolves.toMatchObject({
        kind: 'submitted',
        result: { status: 'deferred' },
      });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'weighted_thought',
      sourceRecordId: 'thought-1:r0',
      preferredChannel: 'current_room',
      currentRoomChannelId: 'companion-room:kitchen',
      cause: {
        kind: 'icp_conversation',
        rootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    }));
  });

  it('preserves the human lane for a non-companion contact', async () => {
    const submit = vi.fn();
    const adapter = createIcpWeightedThoughtCandidateAdapter({
      sourceRuntime: { submit },
      peers: {
        resolveKnownPeer: vi.fn().mockRejectedValue(
          new CanonicalCompanionPeerValidationError('not a peer'),
        ),
      },
    });
    await expect(adapter.submit({ thought: thought() }))
      .resolves.toEqual({ kind: 'not_companion' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects a peer-derived thought with no inherited root or co-location provenance', async () => {
    const submit = vi.fn();
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
    const missingRoot = {
      ...thought(),
      provenance: { sourceChannelId: 'companion-room:kitchen' },
    };

    await expect(adapter.submit({ thought: missingRoot }))
      .resolves.toEqual({ kind: 'blocked', reason: 'recursive_trigger' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('treats co-location provenance as the only independent weighted-thought source', async () => {
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
    const coLocated = {
      ...thought(),
      provenance: {
        sourceChannelId: 'companion-room:kitchen',
        coLocationRef: 'presence:kitchen:peer-contact',
      },
    };

    await expect(adapter.submit({ thought: coLocated }))
      .resolves.toMatchObject({ kind: 'submitted' });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      cause: { kind: 'independent' },
    }));
  });
});
