import { describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import type { EmoSimProactivityImpulse } from '../../core/emotion/emosim-proactivity-port.js';
import type {
  SocialImpulseOutreachRecord,
  SocialImpulseOutreachStorePort,
} from '../../core/emotion/social-impulse-outreach.js';
import { createProductionSocialImpulseOutreachRuntime } from './social-impulse-outreach-runtime.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const DYAD_ID = '22222222-2222-4222-8222-222222222222';
const PEER_COMPANION_ID = '33333333-3333-4333-8333-333333333333';
const NOW_MS = 1_780_000_000_000;

function impulse(): EmoSimProactivityImpulse {
  return {
    schemaVersion: 1,
    impulseVersion: 'emosim-proactivity.impulse.v1',
    kind: 'would_message',
    companionId: COMPANION_ID,
    source: { model: 'derived-model', version: '1.0.0' },
    lineage: {
      schemaVersion: 1,
      inputId: 'sanitized-input',
      projectionVersion: 'projection-v1',
      privacyClass: 'content_redacted',
      rawContentRedacted: true,
    },
    firstCrossingMs: NOW_MS,
    firedAtMs: NOW_MS,
    thresholdProfile: {
      profileId: 'profile-a',
      socialNeedThreshold: 0.7,
      attachmentIntensityThreshold: 0.8,
      sustainMs: 10,
      cooldownMs: 20,
    },
    dedupeKey: `felt-impulse:would_message:${NOW_MS}`,
    correlationId: `felt-impulse:would_message:${NOW_MS}`,
    confidence: 0.9,
    availability: 'available',
    authority: 'qualified_source_fire',
  };
}

function memoryStore(): SocialImpulseOutreachStorePort {
  const records = new Map<string, SocialImpulseOutreachRecord>();
  return {
    async createOpportunity(record) {
      const prior = records.get(record.opportunityId);
      if (prior) return { created: false, record: structuredClone(prior) };
      records.set(record.opportunityId, structuredClone(record));
      return { created: true, record: structuredClone(record) };
    },
    async getOpportunity(opportunityId) {
      const record = records.get(opportunityId);
      return record ? structuredClone(record) : null;
    },
    async claimDisposition(input) {
      const record = records.get(input.opportunityId);
      if (!record) return { outcome: 'unavailable' };
      if (record.bindingHash) {
        return record.bindingHash === input.bindingHash
          ? { outcome: 'replayed', record: structuredClone(record) }
          : { outcome: 'conflict', record: structuredClone(record) };
      }
      const claimed: SocialImpulseOutreachRecord = {
        ...record,
        state: 'chosen',
        disposition: input.disposition,
        destination: input.destination ? structuredClone(input.destination) : null,
        bindingHash: input.bindingHash,
        updatedAtMs: input.claimedAtMs,
      };
      records.set(input.opportunityId, claimed);
      return { outcome: 'claimed', record: structuredClone(claimed) };
    },
    async finalize(input) {
      const record = records.get(input.opportunityId);
      if (!record || record.bindingHash !== input.bindingHash) throw new Error('lost claim');
      const finalized: SocialImpulseOutreachRecord = {
        ...record,
        state: input.state,
        reasonCode: input.reasonCode ?? null,
        updatedAtMs: input.finalizedAtMs,
      };
      records.set(input.opportunityId, finalized);
      return structuredClone(finalized);
    },
  };
}

function harness() {
  const handleMessage = vi.fn(async () => fromAny({ content: 'A naturally authored message.' }));
  const executeDyadContinuation = vi.fn(async () => ({ disposition: 'delivered' as const }));
  const submit = vi.fn(async () => fromAny({
    outcome: 'sent',
    status: 'consumed',
    deliveryDisposition: 'delivered',
  }));
  const dispatch = vi.fn(async () => ({ outcome: 'sent' as const }));
  const evaluateHuman = vi.fn(async () => ({ allowed: true as const }));
  const reserve = vi.fn(async () => fromAny({
    outcome: 'reserved',
    reservation: { triggerEventId: impulse().correlationId },
  }));
  const settleAfterAppraisal = vi.fn(async () => {});
  const grantReply = vi.fn(async () => fromAny({ outcome: 'delivered' }));
  const runtime = createProductionSocialImpulseOutreachRuntime({
    companionId: COMPANION_ID,
    companionName: 'Test Companion',
    store: memoryStore(),
    getMode: () => 'on',
    agentLoop: { handleMessage },
    contactStore: fromAny({
      getByDiscordUserId: async () => ({
        id: 'contact-human',
        displayName: 'Trusted Person',
        trustLevel: 'primary',
        relationshipType: 'friend',
        firstSeen: '2026-01-01T00:00:00Z',
        lastSeen: '2026-01-01T00:00:00Z',
      }),
      listKnownRooms: async () => [
        { channel: 'discord', channelId: 'room-discord' },
        { channel: 'buzz', channelId: 'room-buzz' },
      ],
    }),
    sessionStore: fromAny({
      listChannels: () => [{ channelId: 'room-discord' }, { channelId: 'room-buzz' }],
    }),
    primaryDiscordUserId: 'discord-user',
    heartbeatChannel: { channelId: 'human-dm', channelType: 'discord' },
    icpAutonomy: fromAny({
      listOpenDyads: async () => [{
        dyadId: DYAD_ID,
        peerContactId: 'contact-peer-open',
        peerDisplayLabel: 'Known Peer',
        channelId: `companion-dm:${COMPANION_ID}:${PEER_COMPANION_ID}`,
      }],
      listKnownPeerAvailability: async () => [
        {
          contactId: 'contact-peer-open',
          displayName: 'Known Peer',
          availability: { eligible: true },
        },
        {
          contactId: 'contact-peer-new',
          displayName: 'New Peer',
          availability: { eligible: true },
        },
      ],
      executeDyadContinuation,
    }),
    icpInitiation: fromAny({ submit }),
    capabilityRuntime: fromAny({ has: () => true }),
    availability: fromAny({ snapshot: () => ({ state: 'available' }) }),
    isHumanContactAllowed: async () => true,
    getPhases: () => fromAny({
      proactiveOutbound: { dispatch },
      humanPolicy: { evaluate: evaluateHuman },
      reservationPhase: { reserve, settleAfterAppraisal },
      egressLeasePhase: { grantReply },
    }),
    now: () => NOW_MS + 100,
  });
  return {
    runtime,
    handleMessage,
    executeDyadContinuation,
    submit,
    dispatch,
    evaluateHuman,
    reserve,
    settleAfterAppraisal,
    grantReply,
  };
}

describe('production social impulse outreach routing', () => {
  it('lists only bounded authorization metadata and scopes dyad ids to open companion DMs', async () => {
    const { runtime } = harness();
    await runtime.onImpulse(impulse());

    const result = await runtime.inspect(impulse().correlationId);

    expect(result.destinations.map(destination => destination.kind)).toEqual([
      'human_dm',
      'open_companion_dyad',
      'companion_first_contact',
      'room',
      'room',
    ]);
    expect(result.destinations.filter(destination => destination.dyadId !== null)).toEqual([
      expect.objectContaining({ kind: 'open_companion_dyad', dyadId: DYAD_ID }),
    ]);
    expect(JSON.stringify(result)).not.toContain('A naturally authored message.');
  });

  it('continues an open dyad without entering first-contact initiation', async () => {
    const { runtime, executeDyadContinuation, submit } = harness();
    await runtime.onImpulse(impulse());

    await runtime.choose({
      opportunityId: impulse().correlationId,
      disposition: 'contact-companion',
      destinationId: `companion-dyad:${DYAD_ID}`,
      intent: 'Continue the established conversation.',
    });

    expect(executeDyadContinuation).toHaveBeenCalledOnce();
    expect(executeDyadContinuation).toHaveBeenCalledWith(
      expect.objectContaining({ dyadId: DYAD_ID, initiationSource: 'felt_impulse' }),
      expect.any(Function),
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('routes a new companion target through the consented initiation runtime', async () => {
    const { runtime, executeDyadContinuation, submit } = harness();
    await runtime.onImpulse(impulse());

    await runtime.choose({
      opportunityId: impulse().correlationId,
      disposition: 'contact-companion',
      destinationId: 'companion-first:contact-peer-new',
      intent: 'Decide whether to introduce myself.',
    });

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'felt_impulse',
      peerContactId: 'contact-peer-new',
      sourceRecordId: impulse().correlationId,
    }));
    expect(executeDyadContinuation).not.toHaveBeenCalled();
  });

  it('uses the human policy and canonical proactive dispatcher for a human DM', async () => {
    const { runtime, handleMessage, evaluateHuman, dispatch } = harness();
    await runtime.onImpulse(impulse());

    await runtime.choose({
      opportunityId: impulse().correlationId,
      disposition: 'contact-human',
      destinationId: 'human:contact-human:discord:human-dm',
      intent: 'Send a gentle hello.',
    });

    expect(evaluateHuman).toHaveBeenCalledOnce();
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      actionId: impulse().correlationId,
      channelId: 'human-dm',
      content: 'A naturally authored message.',
    }));
  });

  it.each([
    ['discord', 'room-discord'],
    ['buzz', 'room-buzz'],
  ] as const)('uses the speaking reservation and egress lease contract for a %s room', async (
    channelType,
    channelId,
  ) => {
    const { runtime, reserve, settleAfterAppraisal, grantReply } = harness();
    await runtime.onImpulse(impulse());

    await runtime.choose({
      opportunityId: impulse().correlationId,
      disposition: 'join-room',
      destinationId: `room:${channelType}:${channelId}`,
      intent: 'Join the room naturally.',
    });

    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ channelId }));
    expect(settleAfterAppraisal).toHaveBeenCalledWith(expect.anything(), 'reply', expect.any(Number));
    expect(grantReply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'reply' }),
      expect.objectContaining({ channelId, channelType }),
      expect.any(Number),
    );
  });
});
