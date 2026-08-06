import { describe, expect, it } from 'vitest';

import {
  parseIcpLocalPolicyAcquireParams,
  parseIcpLocalPolicyAcquireResult,
  parseIcpLocalPolicyInspectParams,
  parseIcpLocalPolicyInspectResult,
  parseIcpLocalPolicyReleaseParams,
  parseIcpLocalPolicyReleaseResult,
  deriveIcpLocalPolicyAcquirePayloadDigest,
} from './local-policy-contract.js';

const SENDER_ID = '11111111-1111-4111-8111-111111111111';
const RECIPIENT_ID = '22222222-2222-4222-8222-222222222222';
const CANDIDATE_ID = '33333333-3333-4333-8333-333333333333';
const ROOT_ID = '44444444-4444-4444-8444-444444444444';
const HOLD_ID = '55555555-5555-4555-8555-555555555555';
const NONCE = '66666666-6666-4666-8666-666666666666';
const DIGEST = 'a'.repeat(64);

const candidate = {
  candidateId: CANDIDATE_ID,
  rootInitiationId: ROOT_ID,
  localCompanionId: SENDER_ID,
  peerCompanionId: RECIPIENT_ID,
  preferredChannel: 'dm',
  source: 'intention',
  provenanceRef: `icp-prov:${ROOT_ID}`,
  createdAtMs: 1_000,
  expiresAtMs: 20_000,
  status: 'pending',
  revision: 1,
} as const;

describe('companion-local ICP policy wire contract', () => {
  it('strictly parses sender inspection without admitting private contact or policy fields', () => {
    expect(parseIcpLocalPolicyInspectParams({
      role: 'sender',
      senderCompanionId: SENDER_ID,
      recipientCompanionId: RECIPIENT_ID,
      candidate,
      channelId: `companion-dm:${SENDER_ID}:${RECIPIENT_ID}`,
      nowMs: 2_000,
      relationshipPressure: 2.5,
    })).toEqual({
      role: 'sender',
      senderCompanionId: SENDER_ID,
      recipientCompanionId: RECIPIENT_ID,
      candidate,
      channelId: `companion-dm:${SENDER_ID}:${RECIPIENT_ID}`,
      nowMs: 2_000,
      relationshipPressure: 2.5,
    });

    expect(() => parseIcpLocalPolicyInspectParams({
      role: 'sender',
      senderCompanionId: SENDER_ID,
      recipientCompanionId: RECIPIENT_ID,
      candidate: { ...candidate, peerContactId: 'private-contact' },
      channelId: `companion-dm:${SENDER_ID}:${RECIPIENT_ID}`,
      nowMs: 2_000,
      relationshipPressure: 2.5,
    })).toThrow(/unknown key.*peerContactId/i);
    expect(() => parseIcpLocalPolicyInspectParams({
      role: 'sender',
      senderCompanionId: SENDER_ID,
      recipientCompanionId: RECIPIENT_ID,
      candidate,
      channelId: `companion-dm:${SENDER_ID}:${RECIPIENT_ID}`,
      nowMs: 2_000,
      relationshipPressure: 2.5,
      postgresSchema: 'tenant_a',
    })).toThrow(/unknown key.*postgresSchema/i);
  });

  it('requires reciprocal participant binding for recipient inspection', () => {
    const result = parseIcpLocalPolicyInspectParams({
      role: 'recipient',
      senderCompanionId: SENDER_ID,
      recipientCompanionId: RECIPIENT_ID,
      channelId: `companion-dm:${SENDER_ID}:${RECIPIENT_ID}`,
      nowMs: 2_000,
    });
    expect(result.role).toBe('recipient');
    expect(() => parseIcpLocalPolicyInspectParams({
      ...result,
      relationshipPressure: 1,
    })).toThrow(/recipient.*pressure/i);
    expect(() => parseIcpLocalPolicyInspectParams({
      ...result,
      recipientCompanionId: SENDER_ID,
    })).toThrow(/different companions/i);
  });

  it('accepts only the bounded public fact result shapes', () => {
    expect(parseIcpLocalPolicyInspectResult({
      role: 'sender',
      ready: true,
      canonicalPeerContact: true,
      trustAllows: true,
      blocksPeer: false,
      provenanceFresh: true,
      socialPressureAllows: true,
      chargeAllows: true,
      fatigueAllows: true,
      costAllows: true,
    })).toMatchObject({ role: 'sender', ready: true, provenanceFresh: true });
    expect(parseIcpLocalPolicyInspectResult({
      role: 'recipient',
      ready: true,
      canonicalPeerContact: true,
      trustAllows: true,
      blocksPeer: false,
    })).toEqual({
      role: 'recipient',
      ready: true,
      canonicalPeerContact: true,
      trustAllows: true,
      blocksPeer: false,
    });
    expect(() => parseIcpLocalPolicyInspectResult({
      role: 'recipient',
      ready: true,
      canonicalPeerContact: true,
      trustAllows: true,
      blocksPeer: false,
      contactId: 'private-contact',
    })).toThrow(/unknown key.*contactId/i);
  });

  it('binds acquire and release to exact digest, nonce, phase, and participants', () => {
    const acquire = parseIcpLocalPolicyAcquireParams({
      role: 'sender',
      phase: 'issue',
      senderCompanionId: SENDER_ID,
      recipientCompanionId: RECIPIENT_ID,
      candidate,
      channelId: `companion-dm:${SENDER_ID}:${RECIPIENT_ID}`,
      payloadDigest: DIGEST,
      nonce: NONCE,
      nowMs: 2_000,
      expiresAtMs: 3_000,
      relationshipPressure: 2.5,
    });
    expect(acquire.payloadDigest).toBe(DIGEST);
    const { payloadDigest: _payloadDigest, ...digestInput } = acquire;
    expect(deriveIcpLocalPolicyAcquirePayloadDigest({
      ...digestInput,
      channelId: `${digestInput.channelId}:mutated`,
    })).not.toBe(deriveIcpLocalPolicyAcquirePayloadDigest(digestInput));
    expect(() => parseIcpLocalPolicyAcquireParams({
      ...acquire,
      role: 'recipient',
    })).toThrow(/recipient.*pressure/i);
    expect(() => parseIcpLocalPolicyAcquireParams({
      ...acquire,
      payloadDigest: 'A'.repeat(64),
    })).toThrow(/lowercase SHA-256/i);

    expect(parseIcpLocalPolicyAcquireResult({
      acquired: true,
      holdId: HOLD_ID,
      expiresAtMs: 3_000,
    })).toEqual({ acquired: true, holdId: HOLD_ID, expiresAtMs: 3_000 });
    expect(parseIcpLocalPolicyAcquireResult({
      acquired: false,
      reasonCode: 'policy_denied',
    })).toEqual({ acquired: false, reasonCode: 'policy_denied' });

    const release = parseIcpLocalPolicyReleaseParams({
      holdId: HOLD_ID,
      payloadDigest: DIGEST,
      nonce: NONCE,
    });
    expect(release).toEqual({ holdId: HOLD_ID, payloadDigest: DIGEST, nonce: NONCE });
    expect(parseIcpLocalPolicyReleaseResult({ released: true })).toEqual({ released: true });
    expect(() => parseIcpLocalPolicyReleaseResult({ released: true, replayed: true }))
      .toThrow(/unknown key.*replayed/i);
  });
});
