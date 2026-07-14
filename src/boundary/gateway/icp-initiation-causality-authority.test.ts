import { describe, expect, it } from 'vitest';

import { RootBoundIcpInitiationCausalityAuthority } from './icp-initiation-causality-authority.js';
import type { IcpInitiationPolicyAuthorityInput } from './icp-initiation-policy-authority.js';

const LOCAL_COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const PEER_COMPANION_ID = '22222222-2222-4222-8222-222222222222';

function input(rootInitiationId: string): IcpInitiationPolicyAuthorityInput {
  return {
    senderCompanionId: LOCAL_COMPANION_ID,
    channelId: `companion-dm:${LOCAL_COMPANION_ID}:${PEER_COMPANION_ID}`,
    nowMs: 1_700_000_000_000,
    candidate: {
      candidateId: '33333333-3333-4333-8333-333333333333',
      rootInitiationId,
      localCompanionId: LOCAL_COMPANION_ID,
      peerCompanionId: PEER_COMPANION_ID,
      preferredChannel: 'dm',
      source: 'foreground',
      provenanceRef: 'icp-prov:44444444-4444-4444-8444-444444444444',
      createdAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_003_600_000,
      status: 'pending',
      revision: 1,
    },
  };
}

describe('RootBoundIcpInitiationCausalityAuthority', () => {
  it('accepts a source adapter-owned independent root', async () => {
    const authority = new RootBoundIcpInitiationCausalityAuthority();
    const value = input('33333333-3333-4333-8333-333333333333');
    await expect(authority.isIndependentRoot(value)).resolves.toBe(true);
  });

  it('rejects a candidate that preserves an inherited MI conversation root', async () => {
    const authority = new RootBoundIcpInitiationCausalityAuthority();
    await expect(authority.isIndependentRoot(input(
      '55555555-5555-4555-8555-555555555555',
    ))).resolves.toBe(false);
  });
});
