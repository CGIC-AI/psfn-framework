import { buildSessionMetadataWithMessageAddressing } from '../../core/session/message-addressing.js';
import type { ProactiveQuietHoursConfig } from '../../core/intention/proactive-time-gate.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../shared/event-bus.js';
import type { LLMContext } from '../../shared/contracts/runtime.js';
import { createNotifyTool } from '../../core/tools/ntfy.js';
import { assertExplicitToolResponseSatisfied, resolveExplicitToolContract } from '../../primitives/llm/explicit-tool-request.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { wirePostTurnActionRuntime } from '../startup/composition/post-turn-actions.js';
import { TurnRunReservation } from '../../core/agent/substrate-agent/turn-run-reservation.js';
import { describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import type { EmoSimProactivityImpulse } from '../../core/emotion/emosim-proactivity-port.js';
import type {
  SocialImpulseOutreachRecord,
  SocialImpulseOutreachStorePort,
} from '../../core/emotion/social-impulse-outreach.js';
import { SpeakingReservationPhase } from '../../core/agent/arbiter/reservation-phase.js';
import { SpeakingEgressLeasePhase } from '../../core/agent/arbiter/egress-lease-phase.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import { OutboundReplyDeduper } from '../../system/lifecycle/outbound-reply-dedupe.js';
import { createAgentLoopEgressReplySender } from './egress-reply-sender.js';
import { createProductionSocialImpulseOutreachRuntime } from './social-impulse-outreach-runtime.js';
import {
  createSocialDesireHumanDeliveryPolicy,
  type SocialDesireHumanDeliveryPolicy,
} from '../../core/intention/social-desire-human-policy.js';

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
    async getDestinationStatus(companionId, destinationId) {
      const matching = [...records.values()].filter(record => record.companionId === companionId
        && record.destination?.destinationId === destinationId)
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs || right.opportunityId.localeCompare(left.opportunityId));
      const active = (record: SocialImpulseOutreachRecord) => record.state === 'pending' || record.state === 'queued' || record.state === 'chosen';
      return structuredClone({ pending: matching.find(active) ?? null, latestTerminal: matching.find(record => !active(record)) ?? null });
    },
    async listRecoverable(companionId) {
      return [...records.values()].filter(record => record.companionId === companionId
        && (record.state === 'pending' || record.state === 'queued')).map(record => structuredClone(record));
    },
    async deferExecution(input) {
      const record = records.get(input.opportunityId);
      if (!record || record.state !== 'chosen' || record.bindingHash !== input.bindingHash || !record.executionIntent) throw new Error('lost unsent claim');
      const deferred = { ...record, state: 'queued' as const, reasonCode: input.reasonCode, updatedAtMs: input.deferredAtMs };
      records.set(input.opportunityId, deferred);
      return structuredClone(deferred);
    },
    async beginExecution(opportunityId, bindingHash, atMs) {
      const record = records.get(opportunityId);
      if (!record || record.state !== 'queued' || record.bindingHash !== bindingHash) return false;
      records.set(opportunityId, { ...record, state: 'chosen', updatedAtMs: atMs });
      return true;
    },
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
        state: input.executionIntent ? 'queued' : 'chosen',
        disposition: input.disposition,
        destination: input.destination ? structuredClone(input.destination) : null,
        bindingHash: input.bindingHash,
        executionIntent: input.executionIntent ?? null,
        originIcpRootInitiationId: record.originIcpRootInitiationId ?? input.originIcpRootInitiationId ?? null,
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
        executionIntent: null,
        reasonCode: input.reasonCode ?? null,
        updatedAtMs: input.finalizedAtMs,
      };
      records.set(input.opportunityId, finalized);
      return structuredClone(finalized);
    },
  };
}

function harness(
  isRoomTransportAvailable: (channelType: 'discord' | 'buzz') => boolean = () => true,
  queueFixture: {
    persistencePath?: string;
    store?: SocialImpulseOutreachStorePort;
    dmScope?: 'direct' | 'group';
    dmAuthorId?: string;
    humanPolicy?: SocialDesireHumanDeliveryPolicy;
    nowMs?: number;
    doNotDisturb?: boolean;
    humanAllowed?: boolean;
    now?: () => number;
    quietHours?: ProactiveQuietHoursConfig;
  } = {},
) {
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
  const roomPhases = fromAny({
    reservationPhase: { reserve, settleAfterAppraisal },
    egressLeasePhase: { grantReply },
  });
  const reservation = new TurnRunReservation();
  const eventBus = new EventBus();
  const scheduler = new Scheduler(eventBus, { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 });
  const postTurnActions = wirePostTurnActionRuntime({
    eventBus, scheduler, agentLoop: { waitForIdle: () => reservation.waitForIdle() },
    ...(queueFixture.persistencePath ? { persistencePath: queueFixture.persistencePath } : {}),
  });
  const drain = async () => { await scheduler.getTask('post-turn-action-executor')!.handler(); };
  const rawRuntime = createProductionSocialImpulseOutreachRuntime({
    companionId: COMPANION_ID,
    companionName: 'Test Companion',
    quietHours: queueFixture.quietHours ?? { enabled: false, startLocalTime: '02:00', endLocalTime: '06:00', timeZone: 'UTC' },
    store: queueFixture.store ?? memoryStore(),
    getMode: () => 'on',
    agentLoop: { handleMessage: message => reservation.runShared(
      { kind: 'ordinary-turn', sourceId: message.id }, () => handleMessage(message),
    ) },
    postTurnActions,
    contactStore: fromAny({
      getByTrustLevel: async () => [{
        id: 'contact-human',
        discordUserId: 'discord-user',
        displayName: 'Trusted Person',
        trustLevel: 'primary',
        relationshipType: 'friend',
        firstSeen: '2026-01-01T00:00:00Z',
        lastSeen: '2026-01-01T00:00:00Z',
      }],
      getById: async () => ({ id: 'contact-human', displayName: 'Trusted Person', relationshipType: 'friend' }),
      listKnownRooms: async () => [
        { channel: 'discord', channelId: 'room-discord' },
        { channel: 'buzz', channelId: 'room-buzz' },
        { channel: 'discord', channelId: 'human-dm' },
      ],
    }),
    sessionStore: fromAny({
      listChannels: () => [{ channelId: 'room-discord' }, { channelId: 'room-buzz' }, { channelId: 'human-dm' }],
      getSessionActivity: (channelId: string) => ({ channelId, lastActivityAt: NOW_MS - 3600000, lastRole: 'user', lastMessagePreview: 'I would welcome hearing from you.' }),
      findLatestEntries: (channelId: string) => channelId === 'human-dm' ? [{
        id: 1, channelId, role: 'user', authorId: 'discord-user', authorName: 'Trusted Person', timestamp: NOW_MS - 3600000,
        content: 'I would welcome hearing from you.',
        metadata: buildSessionMetadataWithMessageAddressing(undefined, {
          schemaVersion: 2, source: 'discord', author: { authorId: queueFixture.dmAuthorId ?? 'discord-user', authorName: 'Trusted Person' },
          observer: { authorId: 'companion-bot', authorName: 'Test Companion' },
          mentionedTargets: [], channel: { scope: queueFixture.dmScope ?? 'direct', channelId },
          resolvedAddressee: queueFixture.dmScope === 'group'
            ? { kind: 'room', channelId }
            : { kind: 'participants', participants: [{ authorId: 'companion-bot', authorName: 'Test Companion', evidence: ['direct_message'] }] },
        }),
      }] : [],
    }),
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
    availability: fromAny({ snapshot: () => ({ state: queueFixture.doNotDisturb ? 'do_not_disturb' : 'available' }) }),
    isRoomTransportAvailable,
    isHumanContactAllowed: async () => queueFixture.humanAllowed ?? true,
    getPhases: () => fromAny({
      proactiveOutbound: { dispatch },
      humanPolicy: queueFixture.humanPolicy ?? { evaluate: evaluateHuman },
      ...roomPhases,
    }),
    now: queueFixture.now ?? (() => queueFixture.nowMs ?? NOW_MS + 100),
  });
  const runtime = {
    ...rawRuntime,
    async onImpulse(input: EmoSimProactivityImpulse) {
      const result = await rawRuntime.onImpulse(input);
      await drain();
      return result;
    },
    async choose(input: Parameters<typeof rawRuntime.choose>[0]) {
      const result = await rawRuntime.choose(input);
      await drain();
      if (result.outcome !== 'queued') return result;
      const { record } = await rawRuntime.inspect(input.opportunityId);
      return { outcome: record.state, record, reasonCode: record.reasonCode };
    },
  };
  return {
    runtime,
    rawRuntime,
    reservation,
    postTurnActions,
    drain,
    handleMessage,
    executeDyadContinuation,
    submit,
    dispatch,
    evaluateHuman,
    reserve,
    settleAfterAppraisal,
    grantReply,
    setRoomPhases(value: {
      reservationPhase: SpeakingReservationPhase;
      egressLeasePhase: SpeakingEgressLeasePhase;
    }) {
      roomPhases.reservationPhase = value.reservationPhase;
      roomPhases.egressLeasePhase = value.egressLeasePhase;
    },
  };
}

function assembledRoomPhases(input: {
  handleMessage: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}): {
  reservationPhase: SpeakingReservationPhase;
  egressLeasePhase: SpeakingEgressLeasePhase;
} {
  let reservation = fromAny();
  const arbiterStore = fromAny({
    reserve: async (request: Record<string, unknown>) => {
      reservation = fromAny({
        reservationId: request.reservationId,
        channelId: request.channelId,
        triggerEventId: request.triggerEventId,
        companionId: request.companionId,
        episodeId: 'episode-room',
        reservedAtMs: request.nowMs,
        expiresAtMs: request.expiresAtMs,
        status: 'reserved',
        reason: null,
        finalizedAtMs: null,
        revision: 1,
      });
      return { outcome: 'reserved', reservation, episode: roomEpisode() };
    },
    releaseReservation: async () => fromAny({ ...reservation, status: 'released' }),
    readRoomEpisodeBreakerState: async () => 'closed',
    persistRoomEpisodeBreakerState: async () => undefined,
    listActiveReservers: async () => [COMPANION_ID],
    readRoomEpisode: async () => roomEpisode(),
    acquireEgressLease: async (request: Record<string, unknown>) => ({
      outcome: 'acquired',
      heldBy: null,
      lease: fromAny({
        leaseId: request.leaseId,
        reservationId: reservation.reservationId,
        channelId: reservation.channelId,
        triggerEventId: reservation.triggerEventId,
        companionId: COMPANION_ID,
        episodeId: 'episode-room',
        fencingToken: 1,
        chargedUnits: request.chargedUnits,
        acquiredAtMs: request.nowMs,
        expiresAtMs: request.expiresAtMs,
        status: 'held',
        reason: null,
        finalizedAtMs: null,
        revision: 1,
      }),
    }),
    completeEgressLease: async () => fromAny({ status: 'delivered' }),
  });
  const socialPot = fromAny({
    readPot: async () => ({
      companionId: COMPANION_ID,
      balance: 10,
      cap: 240,
      lastRegenAtMs: NOW_MS,
      revision: 1,
    }),
    draw: async () => ({
      outcome: 'drawn',
      drawn: 1,
      before: { companionId: COMPANION_ID, balance: 10, cap: 240, lastRegenAtMs: NOW_MS, revision: 1 },
      after: { companionId: COMPANION_ID, balance: 9, cap: 240, lastRegenAtMs: NOW_MS, revision: 2 },
    }),
    refund: async () => ({
      companionId: COMPANION_ID,
      balance: 10,
      cap: 240,
      lastRegenAtMs: NOW_MS,
      revision: 3,
    }),
  });
  const socialPotConfig = {
    capUnits: 240,
    perChannelDrawFraction: 0.34,
    regenerationTickMs: 3_600_000,
    regenerationUnitsPerTick: 10,
  };
  const roomEpisodeCircuitBreaker = { tripThreshold: 100, resetThreshold: 40 };
  return {
    reservationPhase: new SpeakingReservationPhase({
      store: arbiterStore,
      socialPot,
      icpPrecedence: { resolve: () => ({ icpTurnFenced: false, icpFatigueExhausted: false }) },
      companionId: COMPANION_ID,
      config: {
        reservationTtlMs: 60_000,
        minReserveDrawUnits: 1,
        socialPot: socialPotConfig,
        roomEpisodeCircuitBreaker,
        wrapUpThreshold: 60,
      },
    }),
    egressLeasePhase: new SpeakingEgressLeasePhase({
      store: arbiterStore,
      socialPot,
      roomPressure: {
        resolve: ({ channelId, nowMs }) => ({
          channelId,
          pressure: 0,
          contributingEventCount: 0,
          windowStartMs: nowMs,
          evaluatedAtMs: nowMs,
          level: 'calm',
          wrapUpInvited: false,
          leaseThresholdBias: 0,
        }),
      },
      sender: createAgentLoopEgressReplySender({
        generator: { handleMessage: input.handleMessage },
        delivery: { send: input.send },
        companionName: 'Test Companion',
        outboundReplyGuard: new OutboundReplyDeduper(),
        resolveDestinationDisclosure: () => ({ channelPrivacy: 'invite_only', broadcast: false }),
      }),
      companionId: COMPANION_ID,
      config: {
        mode: 'on',
        leaseTtlMs: 60_000,
        egressDrawUnits: 1,
        minReplyConfidence: 0.5,
        socialPot: socialPotConfig,
        roomEpisodeCircuitBreaker,
        wrapUpThreshold: 60,
        replyPressureUnits: 3,
      },
    }),
  };
}

function roomEpisode() {
  return {
    episodeId: 'episode-room',
    channelId: 'room-discord',
    status: 'open' as const,
    pressure: 0,
    openedAtMs: NOW_MS,
    lastActivityAtMs: NOW_MS,
    consecutiveAutonomousTurns: 0,
    lastSpeakerCompanionId: null,
    revision: 1,
    participants: [],
  };
}

function installDeferDecisionTurn(assembled: ReturnType<typeof harness>, invalidIntent: boolean) {
  const tool = createNotifyTool({ dispatch: assembled.dispatch }, {
    socialImpulseOutreach: assembled.rawRuntime,
  });
  assembled.handleMessage.mockImplementation(async message => {
    const context: LLMContext = {
      systemPrompt: 'The companion freely selects defer.',
      messages: [{ role: 'user', content: message.content }],
      tools: [{ name: tool.name, description: tool.description, inputSchema: tool.parameters }],
    };
    const listed = await tool.execute('list-call', {
      action: 'outreach_list', opportunity_id: impulse().correlationId,
    });
    expect(listed.isError).not.toBe(true);
    context.messages.push(fromAny({
      role: 'toolResult', toolCallId: 'list-call', toolName: 'notify',
      content: listed.content, outcome: 'success', isError: false,
    }));
    const choice = {
      action: 'outreach_choose', opportunity_id: impulse().correlationId, disposition: 'defer',
      ...(invalidIntent ? { intent: 'An explanation that this disposition does not accept.' } : {}),
    };
    const chosen = await tool.execute('choose-call', choice);
    expect(Boolean(chosen.details?.isError)).toBe(invalidIntent);
    context.messages.push(fromAny({
      role: 'toolResult', toolCallId: 'choose-call', toolName: 'notify',
      content: chosen.content, outcome: invalidIntent ? 'execution_failure' : 'success', isError: invalidIntent,
    }));
    // The explicit two-step request finishes even when validation rejected the choice.
    expect(resolveExplicitToolContract({
      context, originStage: 'agent.turn.prompt', modelApi: 'openai-completions',
    })?.choice).toBeUndefined();
    return fromAny({ content: 'I am deferring.' });
  });
}

describe('production social impulse outreach routing', () => {
  it.each([false, true])('defers the same durable decision through quiet hours (crossed after enqueue: %s)', async crossedAfterEnqueue => {
    const directory = mkdtempSync(join(tmpdir(), 'outreach-quiet-resume-'));
    const persistencePath = join(directory, 'queue.json');
    let current = Date.parse(crossedAfterEnqueue ? '2026-07-20T01:59:00Z' : '2026-07-20T03:00:00Z');
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => current);
    const store = memoryStore();
    const quietHours = { enabled: true, startLocalTime: '02:00', endLocalTime: '06:00', timeZone: 'UTC' };
    try {
      const first = harness(undefined, { store, persistencePath, quietHours, now: () => current });
      await first.rawRuntime.onImpulse(impulse());
      const actionId = first.postTurnActions.listQueued()[0]!.actionId;
      current = Date.parse('2026-07-20T03:00:00Z');
      await first.rawRuntime.onImpulse(impulse());
      await first.drain();
      expect(first.handleMessage).not.toHaveBeenCalled();
      expect(first.dispatch).not.toHaveBeenCalled();
      expect(first.postTurnActions.listQueued()).toEqual([expect.objectContaining({
        actionId, nextRunAt: Date.parse('2026-07-20T06:00:00Z'),
      })]);
      expect(await store.getOpportunity(impulse().correlationId)).toMatchObject({ state: 'pending', bindingHash: null });

      const restarted = harness(undefined, { store, persistencePath, quietHours, now: () => current });
      restarted.handleMessage.mockImplementation(async message => {
        if (message.id.startsWith('social-disposition-')) await restarted.rawRuntime.choose({
          opportunityId: impulse().correlationId, disposition: 'contact-human',
          destinationId: 'human:contact-human:discord:human-dm', intent: 'A natural morning hello.',
        });
        return fromAny({ content: 'Good morning.' });
      });
      await restarted.rawRuntime.recoverPending();
      current = Date.parse('2026-07-20T05:59:59Z'); await restarted.drain();
      expect(restarted.handleMessage).not.toHaveBeenCalled();
      expect(restarted.postTurnActions.listQueued()).toHaveLength(1);
      current = Date.parse('2026-07-20T06:00:00Z'); await restarted.drain(); await restarted.drain();
      expect(restarted.handleMessage).toHaveBeenCalledTimes(2);
      expect(restarted.dispatch).toHaveBeenCalledOnce();
      expect(await store.getOpportunity(impulse().correlationId)).toMatchObject({ state: 'delivered', executionIntent: null });
      await restarted.rawRuntime.recoverPending(); await restarted.drain();
      expect(restarted.dispatch).toHaveBeenCalledOnce();
      expect(restarted.postTurnActions.listQueued()).toEqual([]);
    } finally { clock.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
  });

  it.each([false, true])('preserves the exact queued choice on recipient time deferral (crossed during authoring: %s)', async crossedDuringAuthoring => {
    let current = Date.parse(crossedDuringAuthoring ? '2026-07-20T01:59:59Z' : '2026-07-20T03:00:00Z');
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => current);
    const store = memoryStore();
    const humanPolicy = createSocialDesireHumanDeliveryPolicy({
      contacts: { getById: () => fromAny({ id: 'contact-human', trustLevel: 'primary' }) },
      approvedHeartbeatChannel: { channelId: 'human-dm', channelType: 'discord' },
      quietHours: { enabled: true, startLocalTime: '02:00', endLocalTime: '06:00', timeZone: 'UTC', inactivityThresholdMinutes: 60 },
    });
    try {
      const assembled = harness(undefined, { store, humanPolicy, now: () => current });
      assembled.handleMessage.mockImplementation(async message => {
        if (message.id.startsWith('social-disposition-')) await assembled.rawRuntime.choose({
          opportunityId: impulse().correlationId, disposition: 'contact-human',
          destinationId: 'human:contact-human:discord:human-dm', intent: 'An exact private hello.',
        });
        else if (crossedDuringAuthoring) current = Date.parse('2026-07-20T02:00:00Z');
        return fromAny({ content: 'Hello.' });
      });
      await assembled.rawRuntime.onImpulse(impulse()); await assembled.drain();
      expect(assembled.dispatch).not.toHaveBeenCalled();
      const deferred = await store.getOpportunity(impulse().correlationId);
      expect(deferred).toMatchObject({ state: 'queued', executionIntent: 'An exact private hello.' });
      expect(assembled.postTurnActions.listQueued()).toEqual([expect.objectContaining({
        actionKind: 'social-outreach.execute', nextRunAt: Date.parse('2026-07-20T06:00:00Z'),
      })]);
      const actionId = assembled.postTurnActions.listQueued()[0]!.actionId;
      await assembled.rawRuntime.recoverPending();
      expect(assembled.postTurnActions.listQueued()).toEqual([expect.objectContaining({ actionId })]);
      assembled.handleMessage.mockResolvedValue(fromAny({ content: 'A fresh morning hello.' }));
      current = Date.parse('2026-07-20T06:00:00Z'); await assembled.drain();
      expect(assembled.dispatch).toHaveBeenCalledOnce();
      expect(await store.getOpportunity(impulse().correlationId)).toMatchObject({
        state: 'delivered', bindingHash: deferred!.bindingHash, executionIntent: null,
      });
      await assembled.rawRuntime.executeQueued(impulse().correlationId);
      expect(assembled.dispatch).toHaveBeenCalledOnce();
    } finally { clock.mockRestore(); }
  });
  it.each(['suppressed', 'delivered', 'queued', 'chosen'] as const)(
    'briefs the next private decision with the persisted %s outreach outcome', async state => {
      const store = memoryStore();
      const priorId = `felt-impulse:would_message:${NOW_MS - 1000}`;
      await store.createOpportunity({
        schemaVersion: 1, opportunityId: priorId, companionId: COMPANION_ID,
        impulseDedupeKey: priorId, firstCrossingMs: NOW_MS - 1000, firedAtMs: NOW_MS - 1000,
        modeAtCreation: 'on', state, disposition: 'contact-human',
        destination: { kind: 'human_dm', destinationId: 'human:contact-human:discord:human-dm',
          contactId: 'contact-human', displayLabel: 'Trusted Person', channelId: 'human-dm',
          channelType: 'discord', dyadId: null },
        bindingHash: 'a'.repeat(64), executionIntent: 'Private intent must not enter this briefing.',
        originIcpRootInitiationId: null,
        reasonCode: state === 'suppressed' ? 'social_desire_recipient_timezone_unavailable' : null,
        createdAtMs: NOW_MS - 1000, updatedAtMs: NOW_MS - 500,
      });
      const assembled = harness(() => true, { store });
      installDeferDecisionTurn(assembled, false);
      await assembled.rawRuntime.onImpulse(impulse());
      await assembled.drain();
      const message = assembled.handleMessage.mock.calls[0]![0];
      const evidence = JSON.parse(message.content.split('\n').find(line => line.startsWith('[{'))!);
      const human = evidence.find((entry: { kind: string }) => entry.kind === 'human_dm');
      const active = state === 'queued' || state === 'chosen';
      expect(human.outreach).toMatchObject({
        pending: active ? { opportunityId: priorId, state, updatedAt: new Date(NOW_MS - 500).toISOString() } : null,
        latestTerminal: active ? null : { opportunityId: priorId, state, updatedAt: new Date(NOW_MS - 500).toISOString() },
      });
      if (state === 'suppressed') {
        expect(human.outreach.latestTerminal).toMatchObject({ reasonCode: 'social_desire_recipient_timezone_unavailable' });
        expect(message.content).toContain('Suppressed opportunities are no longer queued');
      }
      expect(message.content).toContain('Queued or chosen does not confirm delivery');
      expect(message.content).not.toContain('Private intent must not enter');
      expect(assembled.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(['companion', 'destination'] as const)('rejects mismatched %s outcome evidence before prompting', async mismatch => {
    const store = memoryStore();
    vi.spyOn(store, 'getDestinationStatus').mockResolvedValue({
      pending: null,
      latestTerminal: fromAny({
        companionId: mismatch === 'companion' ? PEER_COMPANION_ID : COMPANION_ID,
        destination: { destinationId: mismatch === 'destination' ? 'foreign-destination' : 'human:contact-human:discord:human-dm' },
      }),
    });
    const assembled = harness(() => true, { store });
    await assembled.rawRuntime.onImpulse(impulse());
    await assembled.drain();
    expect(store.getDestinationStatus).toHaveBeenCalledWith(COMPANION_ID, 'human:contact-human:discord:human-dm');
    expect(assembled.handleMessage).not.toHaveBeenCalled();
    expect(await store.getOpportunity(impulse().correlationId)).toMatchObject({ state: 'pending' });
  });

  it('binds only exact authorized destination IDs or raw conversation channels', async () => {
    const { rawRuntime } = harness();
    for (const channelId of ['human:contact-human:discord:human-dm', 'human-dm']) {
      await expect(rawRuntime.resolveFollowUpDestination({ channelId, channelType: 'discord' }))
        .resolves.toEqual({ channelId: 'human-dm', channelType: 'discord', contactId: 'contact-human' });
    }
    await expect(rawRuntime.resolveFollowUpDestination({ channelId: `companion-dyad:${DYAD_ID}` }))
      .resolves.toEqual({ channelId: `companion-dm:${COMPANION_ID}:${PEER_COMPANION_ID}`, channelType: 'companion', contactId: 'contact-peer-open' });
    for (const channelId of ['human:foreign:discord:human-dm', 'unknown-dm', 'companion-first:contact-peer-new', 'room:discord:room-discord']) {
      await expect(rawRuntime.resolveFollowUpDestination({ channelId })).resolves.toBeNull();
    }
    await expect(rawRuntime.resolveFollowUpDestination({ channelId: 'human-dm', channelType: 'telegram' }))
      .resolves.toBeNull();
  });

  it.each([{ dmScope: 'group' as const }, { dmAuthorId: 'different-person' }, { humanAllowed: false }])('refuses follow-up binding without authoritative DM admission: %j', async fixture => {
    const { rawRuntime } = harness(() => true, fixture);
    await expect(rawRuntime.resolveFollowUpDestination({ channelId: 'human:contact-human:discord:human-dm' }))
      .resolves.toBeNull();
  });

  it('permits scheduling an authorized destination during DND without making it available for immediate outreach', async () => {
    const { rawRuntime } = harness(() => true, { doNotDisturb: true });
    await expect(rawRuntime.resolveFollowUpDestination({ channelId: 'human-dm' }))
      .resolves.toEqual({ channelId: 'human-dm', channelType: 'discord', contactId: 'contact-human' });
    await rawRuntime.onImpulse(impulse());
    const inspected = await rawRuntime.inspect(impulse().correlationId);
    expect(inspected.destinations).toEqual([]);
  });

  it.each([{ dmScope: 'group' as const }, { dmAuthorId: 'different-person' }])('rejects a configured proactive channel that is not the primary contact DM: %j', async fixture => {
    const { rawRuntime } = harness(() => true, fixture);
    await rawRuntime.onImpulse(impulse());
    const inspected = await rawRuntime.inspect(impulse().correlationId);
    expect(inspected.destinations.some(destination => destination.kind === 'human_dm')).toBe(false);
  });
  it('keeps successive decisions in one private reflection with canonical destinations and recent contact context', async () => {
    const assembled = harness();
    installDeferDecisionTurn(assembled, false);
    await assembled.rawRuntime.onImpulse(impulse());
    await assembled.drain();
    const first = assembled.handleMessage.mock.calls[0]![0];
    expect(first.channelId).toBe('internal:reflection:social-outreach');
    expect(first.content).toContain('Trusted Person');
    expect(first.content).toContain('friend');
    expect(first.content).toContain('I would welcome hearing from you.');
    expect(first.content).toContain(new Date(NOW_MS - 3600000).toISOString());
    const next = { ...impulse(), correlationId: `felt-impulse:would_message:${NOW_MS + 1}`, dedupeKey: `felt-impulse:would_message:${NOW_MS + 1}`, firstCrossingMs: NOW_MS + 1 };
    assembled.handleMessage.mockImplementation(async () => {
      await assembled.rawRuntime.choose({ opportunityId: next.correlationId, disposition: 'defer' });
      return fromAny({ content: 'Later.' });
    });
    await assembled.rawRuntime.onImpulse(next);
    await assembled.drain();
    expect(assembled.handleMessage.mock.calls[1]![0].channelId).toBe(first.channelId);
  });

  it('discovers the canonical primary human without a legacy bootstrap user ID and never lists their DM as a room', async () => {
    const assembled = harness();
    await assembled.rawRuntime.onImpulse(impulse());
    const { destinations } = await assembled.rawRuntime.inspect(impulse().correlationId);
    expect(destinations).toContainEqual(expect.objectContaining({kind: 'human_dm', contactId: 'contact-human', channelId: 'human-dm'}));
    expect(destinations).not.toContainEqual(expect.objectContaining({kind: 'room', channelId: 'human-dm'}));
  });

  it('durably retries a rejected defer decision and recovers into a valid defer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'social-choice-retry-'));
    const persistencePath = join(directory, 'queue.json');
    const store = memoryStore();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const initial = harness(undefined, { persistencePath, store });
      installDeferDecisionTurn(initial, true);
      await initial.rawRuntime.onImpulse(impulse());
      await initial.drain();
      expect((await initial.rawRuntime.inspect(impulse().correlationId)).record.state).toBe('pending');
      expect(initial.postTurnActions.getStatus().completions.completedCount).toBe(0);
      const retry = initial.postTurnActions.listQueued()[0];
      expect(retry).toMatchObject({ actionKind: 'social-outreach.disposition', attempt: 1 });
      expect(initial.postTurnActions.getActionStatus(retry!.actionId)?.state).toBe('retry_scheduled');
      expect(JSON.parse(readFileSync(persistencePath, 'utf8')).entries)
        .toMatchObject([{ attempt: 1, retryableFailureCount: 1 }]);
      expect(initial.handleMessage.mock.calls[0]?.[0].content)
        .toContain('For ignore, defer, or other, omit destination_id and intent.');

      const recovered = harness(undefined, { persistencePath, store });
      installDeferDecisionTurn(recovered, false);
      expect(recovered.postTurnActions.listQueued()).toMatchObject([{ attempt: 1 }]);
      vi.setSystemTime(retry!.nextRunAt + 1);
      await recovered.drain();
      expect((await recovered.rawRuntime.inspect(impulse().correlationId)).record)
        .toMatchObject({ state: 'defer', disposition: 'defer', executionIntent: null });
      expect(recovered.postTurnActions.listQueued()).toEqual([]);
      expect(recovered.postTurnActions.getStatus().completions.completedCount).toBe(1);
      expect(initial.dispatch).not.toHaveBeenCalled();
      expect(recovered.dispatch).not.toHaveBeenCalled();
      expect(recovered.submit).not.toHaveBeenCalled();
      expect(recovered.executeDyadContinuation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('exhausts the existing retry budget visibly while retaining an unrecorded opportunity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const assembled = harness();
      installDeferDecisionTurn(assembled, true);
      await assembled.rawRuntime.onImpulse(impulse());
      const admitted = assembled.postTurnActions.listQueued()[0]!;
      for (let attempt = 0; attempt < admitted.maxAttempts; attempt += 1) {
        const next = assembled.postTurnActions.listQueued()[0];
        expect(next).toBeDefined();
        vi.setSystemTime(Math.max(Date.now(), next!.nextRunAt) + 1);
        await assembled.drain();
      }
      expect(assembled.handleMessage).toHaveBeenCalledTimes(admitted.maxAttempts);
      expect(assembled.postTurnActions.getStatus().completions.completedCount).toBe(0);
      expect(assembled.postTurnActions.getActionStatus(admitted.actionId))
        .toMatchObject({ state: 'failed', attempt: admitted.maxAttempts });
      expect(assembled.postTurnActions.getStatus().failures.recentFailures)
        .toMatchObject([{ reason: 'retries_exhausted' }]);
      expect((await assembled.rawRuntime.inspect(impulse().correlationId)).record)
        .toMatchObject({ state: 'pending', disposition: null, executionIntent: null });
      expect(assembled.postTurnActions.listQueued()).toEqual([]);
      expect(assembled.dispatch).not.toHaveBeenCalled();
      expect(assembled.submit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['ignore', 'defer'] as const)(
    'allows memory tools before listing and recording %s without a forced notify-only contract',
    async disposition => {
      const assembled = harness();
      const tool = createNotifyTool({ dispatch: assembled.dispatch }, {
        socialImpulseOutreach: assembled.rawRuntime,
      });
      assembled.handleMessage.mockImplementation(async message => {
        const context: LLMContext = {
          systemPrompt: 'Choose freely; recording a disposition does not require a message.',
          messages: [{ role: 'user', content: message.content }],
          tools: [{ name: tool.name, description: tool.description, inputSchema: tool.parameters }],
        };
        const contract = () => resolveExplicitToolContract({
          context, originStage: 'agent.turn.prompt', modelApi: 'openai-completions',
        });
        expect(contract()?.requiredToolName).toBeUndefined();
        const listed = await tool.execute('list-call', {
          action: 'outreach_list', opportunity_id: impulse().correlationId,
        });
        expect(listed.isError).not.toBe(true);
        context.messages.push(fromAny({
          role: 'toolResult', toolCallId: 'list-call', toolName: 'notify',
          content: listed.content, outcome: 'success', isError: false,
        }));

        // A successful list must leave the companion able to record their choice.
        // The old prompt parsed as one call and returned tool_choice=none here.
        expect(contract()?.requiredToolName).toBeUndefined();
        const choice = {
          action: 'outreach_choose', opportunity_id: impulse().correlationId, disposition,
        };
        assertExplicitToolResponseSatisfied({
          contract: contract(), corruptToolNames: [], tools: context.tools,
          toolCalls: [{ id: 'choose-call', name: 'notify', input: choice }],
        });
        const chosen = await tool.execute('choose-call', choice);
        expect(chosen.isError).not.toBe(true);
        context.messages.push(fromAny({
          role: 'toolResult', toolCallId: 'choose-call', toolName: 'notify',
          content: chosen.content, outcome: 'success', isError: false,
        }));
        expect(contract()?.choice).toBeUndefined();
        return fromAny({ content: 'Decision recorded.' });
      });

      await assembled.rawRuntime.onImpulse(impulse());
      await assembled.rawRuntime.recoverPending();
      await assembled.drain();
      expect((await assembled.rawRuntime.inspect(impulse().correlationId)).record)
        .toMatchObject({ state: disposition, disposition, executionIntent: null });
      expect(assembled.handleMessage).toHaveBeenCalledTimes(1);
      expect(assembled.dispatch).not.toHaveBeenCalled();
      expect(assembled.submit).not.toHaveBeenCalled();
      expect(assembled.executeDyadContinuation).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['2026-07-20T16:00:00.000Z', 'delivered', null],
    ['2026-07-20T06:30:00.000Z', 'queued', 'quiet_hours'],
  ])('runs queued human outreach through configured quiet hours without a contact timezone at %s', async (now, state, reasonCode) => {
    vi.stubEnv('TZ', 'America/New_York');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(now));
    try {
      const humanPolicy = createSocialDesireHumanDeliveryPolicy({
        contacts: { getById: () => ({
          id: 'contact-human',
          displayName: 'Trusted Person',
          trustLevel: 'primary',
          relationshipType: 'friend',
          firstSeen: '2026-01-01T00:00:00Z',
          lastSeen: '2026-01-01T00:00:00Z',
        }) },
        approvedHeartbeatChannel: { channelId: 'human-dm', channelType: 'discord' },
        quietHours: {
          enabled: true, startLocalTime: '00:00', endLocalTime: '09:00',
          timeZone: 'local', inactivityThresholdMinutes: 60,
        },
      });
      const assembled = harness(undefined, { humanPolicy, nowMs: Date.parse(now) });
      assembled.handleMessage.mockImplementation(async message => {
        if (message.id.startsWith('social-disposition-')) {
          const choice = await assembled.rawRuntime.choose({
            opportunityId: impulse().correlationId,
            disposition: 'contact-human',
            destinationId: 'human:contact-human:discord:human-dm',
            intent: 'Ask how the day is going.',
          });
          expect(choice.outcome).toBe('queued');
          return fromAny({ content: 'Decision recorded.' });
        }
        return fromAny({ content: 'How is your day going?' });
      });

      await assembled.rawRuntime.onImpulse(impulse());
      await assembled.drain();

      expect((await assembled.rawRuntime.inspect(impulse().correlationId)).record)
        .toMatchObject({ state, reasonCode, executionIntent: state === 'queued' ? 'Ask how the day is going.' : null });
      expect(assembled.dispatch).toHaveBeenCalledTimes(state === 'delivered' ? 1 : 0);
      expect(assembled.handleMessage).toHaveBeenCalledTimes(state === 'delivered' ? 2 : 1);
      expect(assembled.postTurnActions.listQueued()).toEqual(state === 'delivered' ? [] : [expect.objectContaining({
        actionKind: 'social-outreach.execute', nextRunAt: Date.parse('2026-07-20T13:00:00Z'),
      })]);
    } finally {
      clock.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('releases source and disposition turn ownership before authored proactive delivery', async () => {
    const assembled = harness();
    const { rawRuntime, reservation, handleMessage, dispatch, drain, postTurnActions } = assembled;
    handleMessage.mockImplementation(async message => {
      if (message.id.startsWith('social-disposition-')) {
        const choice = await rawRuntime.choose({
          opportunityId: impulse().correlationId,
          disposition: 'contact-human',
          destinationId: 'human:contact-human:discord:human-dm',
          intent: 'Ask how the day is going.',
        });
        expect(choice.outcome).toBe('queued');
        expect(dispatch).not.toHaveBeenCalled();
        return fromAny({ content: '' });
      }
      return fromAny({ content: 'How is your day going?' });
    });
    await reservation.runShared({ kind: 'ordinary-turn', sourceId: 'source-turn' }, async () => {
      await rawRuntime.onImpulse(impulse());
      expect(handleMessage).not.toHaveBeenCalled();
      expect(postTurnActions.listQueued()).toHaveLength(1);
    });
    await drain();
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ content: 'How is your day going?' }));
    expect((await rawRuntime.inspect(impulse().correlationId)).record).toMatchObject({
      state: 'delivered', executionIntent: null,
    });
    await rawRuntime.onImpulse({ ...impulse(), firedAtMs: NOW_MS + 1_000 });
    await rawRuntime.recoverPending();
    await drain();
    expect(dispatch).toHaveBeenCalledOnce();
  });

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

  it('preserves recursive ICP lineage when first-contact initiation is chosen inside an ICP turn', async () => {
    const { runtime, submit } = harness();
    await runtime.onImpulse(impulse());

    await runWithRequestContext(fromAny({
      icpCorrelation: { rootInitiationId: DYAD_ID },
    }), async () => await runtime.choose({
      opportunityId: impulse().correlationId,
      disposition: 'contact-companion',
      destinationId: 'companion-first:contact-peer-new',
      intent: 'Consider a third-party introduction through the normal gate.',
    }));

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      cause: { kind: 'icp_conversation', rootInitiationId: DYAD_ID },
    }));
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

    expect(evaluateHuman).toHaveBeenCalledTimes(2);
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

    const result = await runtime.choose({
      opportunityId: impulse().correlationId,
      disposition: 'join-room',
      destinationId: `room:${channelType}:${channelId}`,
      intent: 'Join the room naturally.',
    });

    expect(result).toMatchObject({
      outcome: 'delivered',
      record: {
        state: 'delivered',
        disposition: 'join-room',
        destination: { kind: 'room', channelId, channelType },
        bindingHash: expect.any(String),
      },
    });
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ channelId }));
    expect(settleAfterAppraisal).toHaveBeenCalledWith(expect.anything(), 'reply', expect.any(Number));
    expect(grantReply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'reply' }),
      expect.objectContaining({
        kind: 'endogenous_room_candidate',
        source: 'social_impulse_disposition',
        sourceEventId: impulse().correlationId,
        candidateId: result.record.bindingHash,
        channelId,
        channelType,
        companionId: COMPANION_ID,
        roomIntent: 'Join the room naturally.',
      }),
      expect.any(Number),
    );
    const candidate = grantReply.mock.calls[0]?.[2];
    expect(candidate).not.toHaveProperty('authorId');
    expect(candidate).not.toHaveProperty('authorName');
    expect(candidate).not.toHaveProperty('content');
  });

  it('assembles a durable endogenous disposition through the real two-phase sender path', async () => {
    const assembled = harness(channelType => channelType === 'discord');
    const send = vi.fn(async () => undefined);
    assembled.handleMessage.mockImplementation(async (message) => fromAny({
      content: message.id.startsWith('egress-reply:')
        ? 'A naturally authored room message.'
        : '',
    }));
    assembled.setRoomPhases(assembledRoomPhases({
      handleMessage: assembled.handleMessage,
      send,
    }));
    await assembled.runtime.onImpulse(impulse());

    const result = await assembled.runtime.choose({
      opportunityId: impulse().correlationId,
      disposition: 'join-room',
      destinationId: 'room:discord:room-discord',
      intent: 'Ask how the shared project is going.',
    });

    expect(result).toMatchObject({
      outcome: 'delivered',
      record: {
        state: 'delivered',
        disposition: 'join-room',
        destination: { kind: 'room', channelId: 'room-discord' },
        bindingHash: expect.any(String),
      },
    });
    expect(send).toHaveBeenCalledWith(
      'discord',
      'room-discord',
      'A naturally authored room message.',
    );
    const generated = assembled.handleMessage.mock.calls.find(
      ([message]) => message.id.startsWith('egress-reply:'),
    )?.[0];
    expect(generated?.content).toContain('No participant message triggered this candidate');
    expect(generated?.content).not.toContain('A message below mentioned or addressed you');
  });

  it('does not advertise a room whose composed transport cannot carry it', async () => {
    const { runtime } = harness(channelType => channelType === 'discord');
    await runtime.onImpulse(impulse());

    const result = await runtime.inspect(impulse().correlationId);

    expect(result.destinations).toContainEqual(expect.objectContaining({
      destinationId: 'room:discord:room-discord',
    }));
    expect(result.destinations).not.toContainEqual(expect.objectContaining({
      destinationId: 'room:buzz:room-buzz',
    }));
  });
});
