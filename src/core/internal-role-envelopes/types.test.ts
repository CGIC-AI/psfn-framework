import { describe, expect, it } from 'vitest';
import {
  createInternalRoleEnvelope,
  createInternalRoleEnvelopeId,
} from './types.js';

describe('internal role envelope ids', () => {
  it('derives deterministic ids from turn, stage, role, and ordinal', () => {
    const seed = {
      turnId: 'turn-alpha',
      sourceStage: 'post_turn_appraisal' as const,
      internalRole: 'outreach_candidate' as const,
      ordinal: 2,
    };

    expect(createInternalRoleEnvelopeId(seed)).toBe(createInternalRoleEnvelopeId(seed));
    expect(createInternalRoleEnvelopeId(seed)).toMatch(/^env_[0-9a-f]{24}$/);
    expect(createInternalRoleEnvelopeId({ ...seed, ordinal: 3 })).not.toBe(createInternalRoleEnvelopeId(seed));
  });

  it('uses deterministic ids when creating envelopes without an explicit envelope id', () => {
    const envelope = createInternalRoleEnvelope({
      turnId: 'turn-beta',
      requestId: 'req-beta',
      sourceMessageId: 'msg-beta',
      channelId: 'discord:dm:primary',
      channelType: 'discord',
      canonicalContactId: 'contact-primary',
      createdAt: 1_742_000_000_000,
      transportRole: 'system',
      internalRole: 'concern_candidate',
      sourceStage: 'post_turn_appraisal',
      visibility: 'companion_private',
      summary: 'Watch for low energy tomorrow.',
      body: 'Check for a follow-up if there is no new inbound activity.',
      tags: ['energy', 'follow_up'],
      provenanceRefs: ['turn:turn-beta'],
      ordinal: 1,
    });

    expect(envelope.envelopeId).toBe(createInternalRoleEnvelopeId({
      turnId: 'turn-beta',
      sourceStage: 'post_turn_appraisal',
      internalRole: 'concern_candidate',
      ordinal: 1,
    }));
    expect(envelope.inspection.rawTtlDays).toBe(30);
    expect(envelope.promotion).toEqual({
      status: 'ephemeral',
      target: 'none',
    });
  });

  it('accepts psfn-amica as a first-class external channel type', () => {
    const envelope = createInternalRoleEnvelope({
      turnId: 'turn-psfn-amica',
      channelId: 'psfn-amica:test:pi5',
      channelType: 'psfn-amica',
      transportRole: 'assistant',
      internalRole: 'outreach_result',
      sourceStage: 'turn_execution',
      visibility: 'user_visible',
      summary: 'Reply delivered through the satellite UX.',
      body: 'The assistant answered through the PSFN Amica-backed Pi channel.',
    });

    expect(envelope.channelType).toBe('psfn-amica');
  });
});
