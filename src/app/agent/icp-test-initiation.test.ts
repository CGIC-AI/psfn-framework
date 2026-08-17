import { describe, expect, it, vi } from 'vitest';

import { createIcpTestInitiationTrigger } from './icp-test-initiation.js';

const PEER_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';

describe('ICP operator test initiation trigger', () => {
  it('does not acknowledge a request when durable candidate creation fails', async () => {
    const trigger = createIcpTestInitiationTrigger({
      sourceRuntime: {
        accept: vi.fn(async () => {
          throw new Error('candidate store unavailable');
        }),
      },
      peers: {
        listKnownPeerAvailability: vi.fn(async () => [{
          contactId: 'peer-contact',
          displayName: 'Peer',
          peerCompanionId: PEER_ID,
          availability: { available: true },
        }] as never),
      },
    });

    await expect(trigger.trigger({
      peerCompanionId: PEER_ID,
      requestId: REQUEST_ID,
    })).rejects.toThrow('candidate store unavailable');
  });

  it('returns the runtime durable-candidate acceptance', async () => {
    const accept = vi.fn(async () => ({
      outcome: 'accepted' as const,
      candidateId: '33333333-3333-5333-8333-333333333333',
      status: 'pending' as const,
    }));
    const trigger = createIcpTestInitiationTrigger({
      sourceRuntime: { accept },
      peers: {
        listKnownPeerAvailability: vi.fn(async () => [{
          contactId: 'peer-contact',
          displayName: 'Peer',
          peerCompanionId: PEER_ID,
          availability: { available: true },
        }] as never),
      },
    });

    const result = await trigger.trigger({ peerCompanionId: PEER_ID, requestId: REQUEST_ID });

    expect(result).toMatchObject({
      outcome: 'accepted',
      status: 'pending',
      deliveryDisposition: 'pending',
    });
    expect(accept).toHaveBeenCalledOnce();
  });

  it('resolves a canonical peer and submits a provenance-marked broker request', async () => {
    const accept = vi.fn(async () => ({
      outcome: 'accepted' as const,
      candidateId: '33333333-3333-5333-8333-333333333333',
      status: 'pending' as const,
    }));
    const trigger = createIcpTestInitiationTrigger({
      sourceRuntime: { accept },
      peers: {
        listKnownPeerAvailability: vi.fn(async () => [{
          contactId: 'peer-contact',
          displayName: 'Peer',
          peerCompanionId: PEER_ID,
          availability: { available: true },
        }] as never),
      },
    });

    await trigger.trigger({ peerCompanionId: PEER_ID, requestId: REQUEST_ID });

    expect(accept).toHaveBeenCalledWith({
      source: 'operator_test',
      peerContactId: 'peer-contact',
      preferredChannel: 'dm',
      sourceRecordId: REQUEST_ID,
      reasonSummary: 'Authenticated operator requested an ICP test initiation.',
      cause: { kind: 'independent' },
    });
  });

  it('rejects an unknown peer instead of guessing a contact', async () => {
    const accept = vi.fn();
    const trigger = createIcpTestInitiationTrigger({
      sourceRuntime: { accept },
      peers: { listKnownPeerAvailability: vi.fn(async () => []) },
    });

    await expect(trigger.trigger({
      peerCompanionId: PEER_ID,
      requestId: REQUEST_ID,
    })).rejects.toThrow('known canonical peer');
    expect(accept).not.toHaveBeenCalled();
  });
});
