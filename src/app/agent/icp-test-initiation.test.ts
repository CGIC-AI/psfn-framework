import { describe, expect, it, vi } from 'vitest';

import { createIcpTestInitiationTrigger } from './icp-test-initiation.js';

const PEER_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';
const LOCAL_ID = '11111111-1111-4111-8111-111111111111';

describe('ICP operator test initiation trigger', () => {
  it('accepts a validated request before provider-backed outreach settles', async () => {
    let settleOutreach!: () => void;
    const outreachSettled = new Promise<void>(resolve => {
      settleOutreach = resolve;
    });
    const submit = vi.fn(async () => {
      await outreachSettled;
      return {
        outcome: 'sent' as const,
        candidateId: '33333333-3333-4333-8333-333333333333',
        status: 'consumed' as const,
        deliveryDisposition: 'delivered' as const,
      };
    });
    const trigger = createIcpTestInitiationTrigger({
      localCompanionId: LOCAL_ID,
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

    const result = await Promise.race([
      trigger.trigger({ peerCompanionId: PEER_ID, requestId: REQUEST_ID }),
      new Promise<'timed_out'>(resolve => setTimeout(() => resolve('timed_out'), 25)),
    ]);

    expect(result).toMatchObject({
      outcome: 'accepted',
      status: 'pending',
      deliveryDisposition: 'pending',
    });
    expect(result).not.toBe('timed_out');
    expect(submit).toHaveBeenCalledOnce();
    settleOutreach();
  });

  it('resolves a canonical peer and submits a provenance-marked broker request', async () => {
    const submit = vi.fn(async () => ({
      outcome: 'sent' as const,
      candidateId: '33333333-3333-4333-8333-333333333333',
      status: 'consumed' as const,
      deliveryDisposition: 'delivered' as const,
    }));
    const trigger = createIcpTestInitiationTrigger({
      localCompanionId: LOCAL_ID,
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
      localCompanionId: LOCAL_ID,
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
