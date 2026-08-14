import { describe, expect, it, vi } from 'vitest';

import { createIcpTestInitiationTrigger } from './icp-test-initiation.js';

const PEER_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';

describe('ICP operator test initiation trigger', () => {
  it('resolves a canonical peer and submits a provenance-marked broker request', async () => {
    const submit = vi.fn(async () => ({
      outcome: 'sent' as const,
      candidateId: '33333333-3333-4333-8333-333333333333',
      status: 'consumed' as const,
      deliveryDisposition: 'delivered' as const,
    }));
    const trigger = createIcpTestInitiationTrigger({
      sourceRuntime: { submit },
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

    expect(submit).toHaveBeenCalledWith({
      source: 'operator_test',
      peerContactId: 'peer-contact',
      preferredChannel: 'dm',
      sourceRecordId: REQUEST_ID,
      reasonSummary: 'Authenticated operator requested an ICP test initiation.',
      cause: { kind: 'independent' },
    });
  });

  it('rejects an unknown peer instead of guessing a contact', async () => {
    const submit = vi.fn();
    const trigger = createIcpTestInitiationTrigger({
      sourceRuntime: { submit },
      peers: { listKnownPeerAvailability: vi.fn(async () => []) },
    });

    await expect(trigger.trigger({
      peerCompanionId: PEER_ID,
      requestId: REQUEST_ID,
    })).rejects.toThrow('known canonical peer');
    expect(submit).not.toHaveBeenCalled();
  });
});
