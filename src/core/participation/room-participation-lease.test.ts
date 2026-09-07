import { describe, expect, it } from 'vitest';

import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { NearTurnMemoryScope } from '../../faculties/memory/near-turn-memory-lane.js';
import {
  createDefaultPassiveNameCandidateSettings,
  createDefaultRoomParticipationLeaseSettings,
  type RoomParticipationLeaseSettings,
} from '../../system/config/participation-config.js';
import { PassiveNameCandidateBuilder } from './passive-name-candidate.js';
import {
  evaluateRoomParticipationContinuation,
  type RoomParticipationLeaseSnapshot,
  type RoomParticipationLeaseStorePort,
  type RoomParticipationObservation,
} from './room-participation-lease.js';
import { FakeRoomParticipationLeaseStore } from '../../test-support/room-participation-lease-store-fake.js';
import { RoomParticipationLeaseCoordinator } from './room-participation-lease-coordinator.js';

const COMPANION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANION_NAME = 'Persephone';
const COMPANION_BOT_ID = 'bot-persephone';
const ROOM = 'discord-lounge';
const NOW = 1_000_000;

function activeLease(
  overrides: Partial<RoomParticipationLeaseSnapshot> = {},
): RoomParticipationLeaseSnapshot {
  return {
    companionId: COMPANION_ID,
    channelId: ROOM,
    status: 'active',
    openedDisposition: 'reply',
    openedAtMs: NOW - 1_000,
    lastActivityAtMs: NOW - 1_000,
    expiresAtMs: NOW + 600_000,
    watermarkMessageId: 'msg-0',
    watermarkTimestampMs: NOW - 1_000,
    consideredCount: 0,
    ignoreStreak: 0,
    machineStreak: 0,
    closedAtMs: null,
    closeReason: null,
    revision: 1,
    ...overrides,
  };
}

function observation(
  overrides: Partial<RoomParticipationObservation> = {},
): RoomParticipationObservation {
  return {
    messageId: 'msg-1',
    timestampMs: NOW,
    authorIsMachine: false,
    contentLength: 60,
    ...overrides,
  };
}

function settings(
  overrides: Partial<RoomParticipationLeaseSettings> = {},
): RoomParticipationLeaseSettings {
  return {
    ...createDefaultRoomParticipationLeaseSettings(),
    enabled: true,
    continuationCooldownMs: 0,
    ...overrides,
  };
}

function makeCoordinator(input: {
  store: RoomParticipationLeaseStorePort;
  settings?: RoomParticipationLeaseSettings;
  scope?: NearTurnMemoryScope;
  nowMs?: () => number;
}): RoomParticipationLeaseCoordinator {
  const scope: NearTurnMemoryScope = input.scope ?? 'group';
  return new RoomParticipationLeaseCoordinator({
    companionId: COMPANION_ID,
    store: input.store,
    scopeClassifier: { classifyChannelMemoryScope: async () => scope },
    settings: input.settings ?? settings(),
    nowMs: input.nowMs ?? (() => NOW),
  });
}

function makeMessage(overrides: Partial<SubstrateMessage> = {}): SubstrateMessage {
  return {
    id: 'msg-1',
    channelId: ROOM,
    channelType: 'discord',
    authorId: 'human-alice',
    authorName: 'Alice',
    content: 'do you think the second option would actually hold up though',
    timestamp: new Date(NOW),
    ...overrides,
  };
}

describe('evaluateRoomParticipationContinuation', () => {
  it('reports no membership for a room the companion is not taking part in', () => {
    expect(evaluateRoomParticipationContinuation({
      lease: null,
      observation: observation(),
      settings: settings(),
      nowMs: NOW,
    })).toEqual({ outcome: 'absent' });
  });

  it('admits a relevant follow-up under a live lease', () => {
    expect(evaluateRoomParticipationContinuation({
      lease: activeLease(),
      observation: observation(),
      settings: settings(),
      nowMs: NOW,
    })).toEqual({ outcome: 'admit' });
  });

  it('closes a lapsed lease instead of considering the message', () => {
    expect(evaluateRoomParticipationContinuation({
      lease: activeLease({ expiresAtMs: NOW - 1 }),
      observation: observation(),
      settings: settings(),
      nowMs: NOW,
    })).toEqual({ outcome: 'close', reason: 'expiry', suppression: 'lease_expired' });
  });

  it('closes a silent lease', () => {
    expect(evaluateRoomParticipationContinuation({
      lease: activeLease({ lastActivityAtMs: NOW - 400_000 }),
      observation: observation(),
      settings: settings({ silenceTimeoutMs: 300_000 }),
      nowMs: NOW,
    })).toEqual({ outcome: 'close', reason: 'silence', suppression: 'lease_silent' });
  });

  it('closes a lease whose bounded continuation budget is spent', () => {
    expect(evaluateRoomParticipationContinuation({
      lease: activeLease({ consideredCount: 6 }),
      observation: observation(),
      settings: settings({ maxContinuationCandidates: 6 }),
      nowMs: NOW,
    })).toEqual({ outcome: 'close', reason: 'message_cap', suppression: 'lease_message_cap' });
  });

  it('fences a bot-to-bot loop on consecutive machine authors only', () => {
    const lease = activeLease({ machineStreak: 2 });
    const leaseSettings = settings({ maxConsecutiveMachineContinuations: 2 });
    expect(evaluateRoomParticipationContinuation({
      lease,
      observation: observation({ authorIsMachine: true }),
      settings: leaseSettings,
      nowMs: NOW,
    })).toEqual({
      outcome: 'close',
      reason: 'machine_streak',
      suppression: 'lease_machine_streak',
    });
    // A human turn in the same room is still admitted: the fence is about
    // companions talking only to companions, not about a busy room.
    expect(evaluateRoomParticipationContinuation({
      lease,
      observation: observation(),
      settings: leaseSettings,
      nowMs: NOW,
    })).toEqual({ outcome: 'admit' });
  });

  it('never re-considers a message at or behind the context watermark', () => {
    expect(evaluateRoomParticipationContinuation({
      lease: activeLease({ watermarkMessageId: 'msg-5', watermarkTimestampMs: NOW }),
      observation: observation({ messageId: 'msg-5', timestampMs: NOW }),
      settings: settings(),
      nowMs: NOW,
    })).toEqual({ outcome: 'suppressed', suppression: 'lease_watermark' });
  });

  it('rate-limits and skips low-signal chatter', () => {
    expect(evaluateRoomParticipationContinuation({
      lease: activeLease({ lastActivityAtMs: NOW - 5_000 }),
      observation: observation(),
      settings: settings({ continuationCooldownMs: 20_000 }),
      nowMs: NOW,
    })).toEqual({ outcome: 'suppressed', suppression: 'lease_cooldown' });
    expect(evaluateRoomParticipationContinuation({
      lease: activeLease({ lastActivityAtMs: NOW - 25_000 }),
      observation: observation(),
      settings: settings({ continuationCooldownMs: 20_000 }),
      nowMs: NOW,
    })).toEqual({ outcome: 'admit' });
    expect(evaluateRoomParticipationContinuation({
      lease: activeLease(),
      observation: observation({ contentLength: 3 }),
      settings: settings({ minContentChars: 8 }),
      nowMs: NOW,
    })).toEqual({ outcome: 'suppressed', suppression: 'lease_low_signal' });
  });

  it('closes a live lease when owner policy turns continuation off', () => {
    expect(evaluateRoomParticipationContinuation({
      lease: activeLease(),
      observation: observation(),
      settings: settings({ enabled: false }),
      nowMs: NOW,
    })).toEqual({ outcome: 'close', reason: 'policy_off', suppression: 'lease_policy_off' });
  });
});

describe('RoomParticipationLeaseCoordinator', () => {
  it('opens membership only for an owner-admitted disposition', async () => {
    const store = new FakeRoomParticipationLeaseStore();
    const coordinator = makeCoordinator({ store });
    const summons = await coordinator.recordDisposition({
      channelId: ROOM,
      channelType: 'discord',
      disposition: 'passive_summons',
      sourceMessageId: 'msg-0',
      sourceTimestampMs: NOW - 1_000,
    });
    expect(summons).toEqual({ outcome: 'skipped', reason: 'disposition_not_admitted' });
    expect(await store.read({ companionId: COMPANION_ID, channelId: ROOM })).toBeNull();

    const reply = await coordinator.recordDisposition({
      channelId: ROOM,
      channelType: 'discord',
      disposition: 'reply',
      sourceMessageId: 'msg-0',
      sourceTimestampMs: NOW - 1_000,
    });
    expect(reply.outcome).toBe('opened');
    const lease = await store.read({ companionId: COMPANION_ID, channelId: ROOM });
    expect(lease?.status).toBe('active');
    // The opening act is already considered: nothing said before it can be
    // replayed into a continuation candidate.
    expect(lease?.watermarkMessageId).toBe('msg-0');
  });

  it('refreshes live membership for any disposition, including a bare summons', async () => {
    const store = new FakeRoomParticipationLeaseStore();
    const coordinator = makeCoordinator({ store });
    await coordinator.recordDisposition({
      channelId: ROOM,
      channelType: 'discord',
      disposition: 'reply',
      sourceMessageId: 'msg-0',
      sourceTimestampMs: NOW - 1_000,
    });
    const refreshed = await coordinator.recordDisposition({
      channelId: ROOM,
      channelType: 'discord',
      disposition: 'passive_summons',
      sourceMessageId: 'msg-1',
      sourceTimestampMs: NOW,
    });
    expect(refreshed.outcome).toBe('refreshed');
  });

  it('never opens membership outside a verified group room', async () => {
    const store = new FakeRoomParticipationLeaseStore();
    const direct = await makeCoordinator({ store }).recordDisposition({
      channelId: ROOM,
      channelType: 'discord',
      disposition: 'reply',
      sourceMessageId: 'msg-0',
      sourceTimestampMs: NOW,
      isDirectMessage: true,
    });
    expect(direct).toEqual({ outcome: 'skipped', reason: 'direct_message' });
    const dmScope = await makeCoordinator({ store, scope: 'direct' }).recordDisposition({
      channelId: ROOM,
      channelType: 'discord',
      disposition: 'reply',
      sourceMessageId: 'msg-0',
      sourceTimestampMs: NOW,
    });
    expect(dmScope).toEqual({ outcome: 'skipped', reason: 'not_group' });
    expect(await store.read({ companionId: COMPANION_ID, channelId: ROOM })).toBeNull();
  });

  it('claims each observed message exactly once, even under a concurrent race', async () => {
    const store = new FakeRoomParticipationLeaseStore();
    const coordinator = makeCoordinator({ store });
    await coordinator.recordDisposition({
      channelId: ROOM,
      channelType: 'discord',
      disposition: 'reply',
      sourceMessageId: 'msg-0',
      sourceTimestampMs: NOW - 1_000,
    });
    const [first, second] = await Promise.all([
      coordinator.admitContinuation({ channelId: ROOM, observation: observation() }),
      coordinator.admitContinuation({ channelId: ROOM, observation: observation() }),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(['admitted', 'suppressed']);
    const loser = first.outcome === 'suppressed' ? first : second;
    expect(loser).toEqual({ outcome: 'suppressed', suppression: 'lease_claim_lost' });
    const lease = await store.read({ companionId: COMPANION_ID, channelId: ROOM });
    expect(lease?.consideredCount).toBe(1);
    expect(lease?.watermarkMessageId).toBe('msg-1');

    // A redelivery of the same message (the restart case) is now behind the
    // durable watermark and can never produce a second candidate.
    expect(await coordinator.admitContinuation({
      channelId: ROOM,
      observation: observation(),
    })).toEqual({ outcome: 'suppressed', suppression: 'lease_watermark' });
  });

  it('withdraws from the room after repeated silence and retires it durably', async () => {
    const store = new FakeRoomParticipationLeaseStore();
    const coordinator = makeCoordinator({ store, settings: settings({ maxConsecutiveIgnores: 2 }) });
    await coordinator.recordDisposition({
      channelId: ROOM,
      channelType: 'discord',
      disposition: 'reply',
      sourceMessageId: 'msg-0',
      sourceTimestampMs: NOW - 1_000,
    });
    expect(await coordinator.recordAppraisal({ channelId: ROOM, action: 'ignore' }))
      .toEqual({ outcome: 'recorded' });
    expect(await coordinator.recordAppraisal({ channelId: ROOM, action: 'ignore' }))
      .toEqual({ outcome: 'closed', reason: 'withdrawn' });
    const lease = await store.read({ companionId: COMPANION_ID, channelId: ROOM });
    expect(lease?.status).toBe('closed');
    expect(lease?.closeReason).toBe('withdrawn');
    // A closed lease grants nothing: the next follow-up is ordinary chatter.
    expect(await coordinator.admitContinuation({
      channelId: ROOM,
      observation: observation(),
    })).toEqual({ outcome: 'absent' });
  });

  it('retires membership on fatigue and room pressure but not on transient gates', async () => {
    const store = new FakeRoomParticipationLeaseStore();
    const coordinator = makeCoordinator({ store });
    const open = async (): Promise<void> => {
      await coordinator.recordDisposition({
        channelId: ROOM,
        channelType: 'discord',
        disposition: 'reply',
        sourceMessageId: 'msg-0',
        sourceTimestampMs: NOW - 1_000,
      });
    };
    await open();
    expect(await coordinator.closeForReservationGate({
      channelId: ROOM,
      blockedBy: 'icp_availability',
    })).toEqual({ outcome: 'retained' });
    expect(await coordinator.closeForReservationGate({
      channelId: ROOM,
      blockedBy: 'fatigue_pot_insufficient',
    })).toEqual({ outcome: 'closed', reason: 'fatigue' });
    await open();
    expect(await coordinator.closeForReservationGate({
      channelId: ROOM,
      blockedBy: 'room_flooded',
    })).toEqual({ outcome: 'closed', reason: 'room_pressure' });
  });
});

describe('PassiveNameCandidateBuilder contextual continuation', () => {
  function makeBuilder(coordinator?: RoomParticipationLeaseCoordinator): PassiveNameCandidateBuilder {
    return new PassiveNameCandidateBuilder({
      scopeClassifier: { classifyChannelMemoryScope: async () => 'group' },
      contextReader: {
        getRecent: () => [
          {
            id: 1,
            channelId: ROOM,
            role: 'user',
            content: 'Persephone what did you make of the second option',
            authorId: 'human-alice',
            authorName: 'Alice',
            timestamp: NOW - 2_000,
            discordMessageId: 'msg-0',
          },
        ],
      },
      companionNames: [COMPANION_NAME],
      companionAuthorIds: [COMPANION_BOT_ID],
      settings: createDefaultPassiveNameCandidateSettings(),
      ...(coordinator ? { roomParticipationLease: coordinator } : {}),
      nowMs: () => NOW,
    });
  }

  it('leaves a room with no lease exactly as it was: ambient chatter, no candidate', async () => {
    const store = new FakeRoomParticipationLeaseStore();
    const decision = await makeBuilder(makeCoordinator({ store })).build(makeMessage());
    expect(decision.status).toBe('suppressed');
    if (decision.status === 'suppressed') {
      expect(decision.reason).toBe('no_name_match');
    }
  });

  it('creates a name-free continuation candidate with the bounded transcript', async () => {
    const store = new FakeRoomParticipationLeaseStore();
    const coordinator = makeCoordinator({ store });
    await coordinator.recordDisposition({
      channelId: ROOM,
      channelType: 'discord',
      disposition: 'reply',
      sourceMessageId: 'msg-0',
      sourceTimestampMs: NOW - 2_000,
    });
    const decision = await makeBuilder(coordinator).build(makeMessage());
    expect(decision.status).toBe('created');
    if (decision.status === 'created') {
      expect(decision.candidate.trigger).toBe('contextual_continuation');
      expect(decision.candidate.matchedName).toBe(false);
      expect(decision.candidate.matchedDirectAddress).toBe(false);
      expect(decision.candidate.precedingContext).toHaveLength(1);
      expect(decision.candidate.precedingContext[0]?.messageId).toBe('msg-0');
    }
  });

  it('reports the deterministic lease reason code when the gate refuses', async () => {
    const store = new FakeRoomParticipationLeaseStore();
    const coordinator = makeCoordinator({
      store,
      settings: settings({ minContentChars: 400 }),
    });
    await coordinator.recordDisposition({
      channelId: ROOM,
      channelType: 'discord',
      disposition: 'reply',
      sourceMessageId: 'msg-0',
      sourceTimestampMs: NOW - 2_000,
    });
    const decision = await makeBuilder(coordinator).build(makeMessage());
    expect(decision.status).toBe('suppressed');
    if (decision.status === 'suppressed') {
      expect(decision.reason).toBe('lease_low_signal');
      expect(decision.trigger).toBe('contextual_continuation');
    }
  });

  it('keeps the name-spam debounce window separate from continuation', async () => {
    const store = new FakeRoomParticipationLeaseStore();
    const coordinator = makeCoordinator({ store });
    const builder = makeBuilder(coordinator);
    // A summons opens the per-channel debounce window ...
    const summons = await builder.build(
      makeMessage({ id: 'msg-0', content: 'Persephone what do you think' }),
    );
    expect(summons.status).toBe('created');
    await coordinator.recordDisposition({
      channelId: ROOM,
      channelType: 'discord',
      disposition: 'reply',
      sourceMessageId: 'msg-0',
      sourceTimestampMs: NOW - 2_000,
    });
    // ... which silences a repeated summons ...
    const repeated = await builder.build(
      makeMessage({ id: 'msg-1', content: 'Persephone are you there' }),
    );
    expect(repeated.status).toBe('suppressed');
    if (repeated.status === 'suppressed') expect(repeated.reason).toBe('debounced');
    // ... but not the ordinary follow-up the lease exists to consider.
    const followUp = await builder.build(makeMessage({ id: 'msg-2' }));
    expect(followUp.status).toBe('created');
    if (followUp.status === 'created') {
      expect(followUp.candidate.trigger).toBe('contextual_continuation');
    }
  });
});
