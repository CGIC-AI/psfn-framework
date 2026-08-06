import { describe, expect, it, vi } from 'vitest';

import {
  deriveIcpLocalPolicyAcquirePayloadDigest,
  parseIcpLocalPolicyAcquireParams,
  parseIcpLocalPolicyReleaseParams,
} from '../../core/icp/local-policy-contract.js';
import type { IcpInitiationCandidateSharedMetadata } from '../../core/icp/initiation-candidate.js';
import type { IcpInitiationPermit } from '../../shared/contracts/icp-autonomy.js';
import { GatewayIcpLocalPolicyCoordinator } from './icp-local-policy-coordinator.js';

const NOW = 100_000;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CANDIDATE_ID = '11111111-1111-4111-8111-111111111111';
const ROOT_ID = '22222222-2222-4222-8222-222222222222';
const PERMIT_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const SENDER_NONCE = '55555555-5555-4555-8555-555555555555';
const RECIPIENT_NONCE = '66666666-6666-4666-8666-666666666666';
const SENDER_HOLD = '77777777-7777-4777-8777-777777777777';
const RECIPIENT_HOLD = '88888888-8888-4888-8888-888888888888';
const CHANNEL = `companion-dm:${A}:${B}`;

function candidate(): IcpInitiationCandidateSharedMetadata {
  return {
    candidateId: CANDIDATE_ID,
    rootInitiationId: ROOT_ID,
    localCompanionId: A,
    peerCompanionId: B,
    preferredChannel: 'dm',
    source: 'free_time',
    provenanceRef: `icp-prov:${CANDIDATE_ID}`,
    createdAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
    status: 'pending',
    revision: 1,
  };
}

function permit(): IcpInitiationPermit {
  return {
    permitId: PERMIT_ID,
    candidateId: CANDIDATE_ID,
    conversationId: CONVERSATION_ID,
    senderCompanionId: A,
    recipientCompanionId: B,
    channelId: CHANNEL,
    provenanceRef: `icp-prov:${CANDIDATE_ID}`,
    issuedAtMs: NOW - 100,
    expiresAtMs: NOW + 60_000,
    status: 'issued',
    revision: 1,
  };
}

describe('GatewayIcpLocalPolicyCoordinator', () => {
  it('combines strict bilateral local inspections with shared causality', async () => {
    const requestCompanionAgent = vi.fn(async (companionId: string) => (
      companionId === A
        ? {
            role: 'sender',
            ready: true,
            canonicalPeerContact: true,
            trustAllows: true,
            blocksPeer: false,
            quietHours: true,
            provenanceFresh: true,
            socialPressureAllows: true,
            chargeAllows: true,
            fatigueAllows: true,
            costAllows: true,
          }
        : {
            role: 'recipient',
            ready: true,
            canonicalPeerContact: true,
            trustAllows: true,
            blocksPeer: true,
          }
    ));
    const coordinator = new GatewayIcpLocalPolicyCoordinator({
      requestCompanionAgent,
      readRelationshipPressure: async () => 2.5,
      causalityAuthority: { isIndependentRoot: async () => true },
      reportUnavailable: vi.fn(),
    });

    await expect(coordinator.resolve({
      senderCompanionId: A,
      candidate: candidate(),
      channelId: CHANNEL,
      nowMs: NOW,
    })).resolves.toMatchObject({
      canonicalPeerContact: true,
      senderBlocksPeer: false,
      peerBlocksSender: true,
      trustAllows: true,
      provenanceFresh: true,
      recursiveMiOnlyRoot: false,
    });
    expect(requestCompanionAgent).toHaveBeenCalledTimes(2);
    expect(requestCompanionAgent).toHaveBeenCalledWith(
      A,
      'icp.policy.inspect',
      expect.objectContaining({ role: 'sender', relationshipPressure: 2.5 }),
    );
    expect(requestCompanionAgent).toHaveBeenCalledWith(
      B,
      'icp.policy.inspect',
      expect.objectContaining({ role: 'recipient' }),
    );
  });

  it('holds both local authorities in sorted order through the shared operation', async () => {
    const calls: string[] = [];
    const nonces = [SENDER_NONCE, RECIPIENT_NONCE];
    const requestCompanionAgent = vi.fn(async (
      companionId: string,
      method: string,
      value: unknown,
    ) => {
      calls.push(`${method}:${companionId}`);
      if (method === 'icp.policy.acquire') {
        const params = parseIcpLocalPolicyAcquireParams(value);
        const { payloadDigest: _payloadDigest, ...digestInput } = params;
        expect(params.payloadDigest).toBe(
          deriveIcpLocalPolicyAcquirePayloadDigest(digestInput),
        );
        return {
          acquired: true,
          holdId: companionId === A ? SENDER_HOLD : RECIPIENT_HOLD,
          expiresAtMs: NOW + 1_000,
        };
      }
      parseIcpLocalPolicyReleaseParams(value);
      return { released: true };
    });
    const coordinator = new GatewayIcpLocalPolicyCoordinator({
      requestCompanionAgent,
      readRelationshipPressure: async () => 1,
      causalityAuthority: { isIndependentRoot: async () => true },
      reportUnavailable: vi.fn(),
      randomUuid: () => nonces.shift()!,
    });

    const result = await coordinator.runAuthorizedHandoff({
      senderCompanionId: A,
      peerContactId: 'private-local-contact',
      permit: permit(),
      rootInitiationId: ROOT_ID,
      nowMs: NOW,
    }, async () => {
      calls.push('shared-operation');
      return 'committed';
    });

    expect(result).toEqual({ decision: { eligible: true }, result: 'committed' });
    expect(calls).toEqual([
      `icp.policy.acquire:${A}`,
      `icp.policy.acquire:${B}`,
      'shared-operation',
      `icp.policy.release:${B}`,
      `icp.policy.release:${A}`,
    ]);
  });

  it('releases a partial acquisition and fails the pair closed', async () => {
    const calls: string[] = [];
    const nonces = [SENDER_NONCE, RECIPIENT_NONCE];
    const requestCompanionAgent = vi.fn(async (
      companionId: string,
      method: string,
    ) => {
      calls.push(`${method}:${companionId}`);
      if (method === 'icp.policy.acquire' && companionId === A) {
        return { acquired: true, holdId: SENDER_HOLD, expiresAtMs: NOW + 1_000 };
      }
      if (method === 'icp.policy.acquire') {
        return { acquired: false, reasonCode: 'peer_blocked' };
      }
      return { released: true };
    });
    const coordinator = new GatewayIcpLocalPolicyCoordinator({
      requestCompanionAgent,
      readRelationshipPressure: async () => 1,
      causalityAuthority: { isIndependentRoot: async () => true },
      reportUnavailable: vi.fn(),
      randomUuid: () => nonces.shift()!,
    });

    await expect(coordinator.runAuthorizedHandoff({
      senderCompanionId: A,
      peerContactId: 'private-local-contact',
      permit: permit(),
      rootInitiationId: ROOT_ID,
      nowMs: NOW,
    }, async () => 'must-not-run')).resolves.toEqual({
      decision: { eligible: false, reasonCode: 'peer_blocked' },
    });
    expect(calls).toEqual([
      `icp.policy.acquire:${A}`,
      `icp.policy.acquire:${B}`,
      `icp.policy.release:${A}`,
    ]);
  });
});
