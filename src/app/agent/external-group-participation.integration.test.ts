// psfn-framework-w1lc2 (+ ze2fx egress): an external bridge group room must be
// a VERIFIED participation surface. A group line that names the companion
// without the platform's addressed flag travels
//   bridge inbound -> external adapter -> agent observe path
//   -> passive-name candidate (room-signal gate) -> reservation -> appraiser
//   -> egress lease -> gateway channel.sendRoomReply -> adapter outbound queue
// and the bridge drains the appraised reply with channel_pull_outbound.
//
// Real components: the external adapter and its inbound normalization, the
// gateway message handlers, the passive-name candidate builder with the room
// signal runtime, the participation appraiser (local model stubbed), and the
// gateway room-reply outbound. The reservation and egress-lease phases are
// admitting stand-ins (their Postgres behaviour has its own integration
// suites); the egress stand-in delivers through the real gateway path.
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  createDefaultParticipationAppraiserSettings,
  createDefaultPassiveNameCandidateSettings,
  createDefaultRoomSignalSettings,
} from '../../system/config/participation-config.js';
import { createNoopSatelliteRoutingPort } from '../../core/agent/satellite-adapter-port.js';
import { PassiveNameCandidateBuilder } from '../../core/participation/passive-name-candidate.js';
import { ParticipationAppraiser } from '../../core/participation/appraiser.js';
import { RoomMessageFeatureExtractor } from '../../core/participation/room-signal.js';
import { normalizeRoomObservation } from '../../core/participation/room-observation.js';
import type { ReservationDecision } from '../../core/agent/arbiter/reservation-phase.js';
import { ExternalChannelAdapter } from '../../channels/external/adapter.js';
import { ExternalChannelMcpRoute } from '../../channels/external/mcp-route.js';
import { externalObserverIdentity } from '../../channels/external/message-addressing.js';
import {
  createGatewayRoomReplyOutbound,
  resolveRoomReplyOutboundTargets,
} from '../../boundary/gateway/room-reply-outbound.js';
import {
  EXTERNAL_CHANNEL_TEST_COMPANION_ID,
  EXTERNAL_CHANNEL_TEST_LIMITS,
} from '../../test-support/external-channel-conformance.js';
import {
  registerGatewayMessageHandlers,
  type EgressLeasePhasePort,
  type ReservationPhasePort,
} from './gateway-message-handlers.js';

const COMPANION_NAME = 'Juniper';
const ROOM = 'garden-club';

/** The agent sees the message after the gateway-agent RPC's JSON round trip. */
function overRpc(message: SubstrateMessage): SubstrateMessage {
  const wire = JSON.parse(JSON.stringify(message)) as SubstrateMessage & { timestamp: string };
  return { ...wire, timestamp: new Date(wire.timestamp) };
}

async function createRig() {
  const adapter = new ExternalChannelAdapter({
    config: {
      instanceId: 'loopback',
      label: 'Loopback',
      companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
      limits: EXTERNAL_CHANNEL_TEST_LIMITS,
    },
    token: 'loopback-token',
    observer: externalObserverIdentity({ instanceId: 'loopback', displayName: COMPANION_NAME }),
    intakeScreening: null,
    log: { warn: () => undefined, error: () => undefined },
    reportRuntimeFailure: () => undefined,
  });
  void new ExternalChannelMcpRoute([adapter], []);

  // Gateway side of `channel.sendRoomReply`, authenticated as the companion.
  const roomReplyOutbound = createGatewayRoomReplyOutbound({
    multiCompanion: true,
    targets: resolveRoomReplyOutboundTargets({ multiCompanion: true, externalAdapters: [adapter] }),
  });

  const roomSignalSettings = { ...createDefaultRoomSignalSettings(), enabled: true };
  const recent: Array<{ id: string; authorId: string; authorName: string; content: string; timestamp: number }> = [];
  const candidateBuilder = new PassiveNameCandidateBuilder({
    scopeClassifier: { classifyChannelMemoryScope: async () => 'group' },
    contextReader: { getRecent: () => recent.map(entry => ({ ...entry })) as never },
    companionNames: [COMPANION_NAME],
    companionAuthorIds: [],
    settings: createDefaultPassiveNameCandidateSettings(),
    roomSignal: {
      extractor: new RoomMessageFeatureExtractor({ settings: roomSignalSettings }),
      profile: {
        companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
        aliases: [COMPANION_NAME],
        interests: roomSignalSettings.companionInterests,
      },
      settings: roomSignalSettings,
    },
  });
  const appraiserModel = vi.fn(async () => ({
    content: '{"action":"reply","reasonCode":"named_with_question","confidence":0.8}',
    toolCalls: [],
    model: 'background-model',
    inputTokens: 10,
    outputTokens: 5,
    stopReason: 'stop' as const,
  }));
  const appraiser = new ParticipationAppraiser({
    llmProvider: { complete: appraiserModel },
    companionName: COMPANION_NAME,
    companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
    settings: { ...createDefaultParticipationAppraiserSettings(), enabled: true },
  });
  const appraise = vi.spyOn(appraiser, 'appraise');

  const reservation = {
    reservationId: '99999999-9999-4999-8999-999999999999',
    channelId: '',
    triggerEventId: '',
    companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
    episodeId: 'episode-1',
    reservedAtMs: 1,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    status: 'reserved' as const,
    reason: null,
    finalizedAtMs: null,
    revision: 1,
  };
  const reservationPhase: ReservationPhasePort = {
    reserve: vi.fn(async (ctx): Promise<ReservationDecision> => ({
      outcome: 'reserved',
      reservation: { ...reservation, channelId: ctx.channelId, triggerEventId: ctx.triggerEventId },
      episode: {
        episodeId: 'episode-1',
        channelId: ctx.channelId,
        status: 'open',
        pressure: 0,
        openedAtMs: 1,
        lastActivityAtMs: 1,
        consecutiveAutonomousTurns: 0,
        lastSpeakerCompanionId: null,
        revision: 1,
        participants: [],
      },
      replayed: false,
    })),
    settleAfterAppraisal: vi.fn(async () => 'retained' as const),
    releaseIgnored: vi.fn(async () => undefined),
  };
  const egressLeasePhase: EgressLeasePhasePort = {
    grantReply: vi.fn(async (_reservation, _appraisal, trigger) => {
      // The agent's gateway sender -> gateway `channel.sendRoomReply`.
      await roomReplyOutbound.send({
        channelType: 'external',
        channelId: trigger.channelId,
        content: `${COMPANION_NAME}: mint, parsley and chives.`,
        companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
      });
      return { outcome: 'delivered' } as Awaited<ReturnType<EgressLeasePhasePort['grantReply']>>;
    }),
    releaseReact: vi.fn(),
  };

  let onHandleMessage: ((message: SubstrateMessage) => Promise<AgentResponse>) | undefined;
  const audit: Array<[string, Record<string, unknown>]> = [];
  registerGatewayMessageHandlers({
    eventBus: new EventBus(),
    gateway: {
      onHandleMessage: (handler: (message: SubstrateMessage) => Promise<AgentResponse>) => {
        onHandleMessage = handler;
      },
      onDiscordMessage: () => undefined,
      onCompanionMessage: () => undefined,
      onCompanionDeliveryFailure: () => undefined,
      discordSend: vi.fn(),
      discordSendMedia: vi.fn(),
      companionSend: vi.fn(),
      companionSendInitiation: vi.fn(),
      companionConsumeInitiationPermit: vi.fn(),
      companionEndIcpEpisodeActivity: vi.fn(),
      companionReportFailure: vi.fn(),
    } as never,
    agentLoop: {
      handleMessage: vi.fn(async () => { throw new Error('ambient group lines are observed, not answered inline'); }),
      observeMessage: vi.fn(async (message: SubstrateMessage) => {
        recent.push({
          id: message.id,
          authorId: message.authorId,
          authorName: message.authorName,
          content: message.content,
          timestamp: message.timestamp.getTime(),
        });
      }),
      waitForIdle: vi.fn(async () => undefined),
      findRecordedIcpInitiation: vi.fn(async () => null),
      findIcpDeliveryObservation: vi.fn(async () => null),
      findRecordedCompanionSourceMessage: vi.fn(async () => null),
      recordIcpDeliveryObservation: vi.fn(async () => undefined),
    } as never,
    shardManager: { delegateSatelliteSession: vi.fn() } as never,
    safeguardAuditTrail: { append: (event: string, details: Record<string, unknown>) => { audit.push([event, details]); } } as never,
    satelliteRouting: createNoopSatelliteRoutingPort(),
    config: { companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID } as SubstrateConfig,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    trackSessionActivity: vi.fn(),
    passiveNameCandidateBuilder: candidateBuilder,
    participationAppraiser: appraiser,
    reservationPhase,
    egressLeasePhase,
    companionAuthorName: COMPANION_NAME,
  });
  if (!onHandleMessage) throw new Error('gateway handle handler was not registered');
  const handle = onHandleMessage;

  // The gateway forwards each adapter turn to the agent's `handle` RPC.
  adapter.onMessage(async message => await handle(overRpc(message)));
  await adapter.start();
  return { adapter, appraise, appraiserModel, reservationPhase, egressLeasePhase, audit };
}

let sequence = 0;
async function send(
  adapter: ExternalChannelAdapter,
  senderId: string,
  senderName: string,
  text: string,
  addressedToCompanion?: boolean,
) {
  sequence += 1;
  return await adapter.receiveInbound({
    protocolVersion: 1,
    message: {
      id: `line-${sequence}`,
      conversationId: ROOM,
      conversationKind: 'group',
      senderId,
      senderName,
      text,
      ...(addressedToCompanion === undefined ? {} : { addressedToCompanion }),
    },
  });
}

describe('external group room participation (w1lc2 + ze2fx)', () => {
  it('appraises a line that names the companion and delivers the reply to the bridge outbound queue', async () => {
    const rig = await createRig();
    try {
      expect(await send(rig.adapter, 'alex', 'Alex', 'anyone catch the game last night?')).toEqual({ status: 'no_reply' });
      expect(await send(rig.adapter, 'sam', 'Sam', 'lol yes, I switched to a cooking show')).toEqual({ status: 'no_reply' });
      expect(rig.appraise).not.toHaveBeenCalled();

      const named = await send(
        rig.adapter,
        'sam',
        'Sam',
        'Juniper would probably know which herbs survive a north-facing balcony, right?',
      );
      expect(named).toEqual({ status: 'no_reply' });

      // The room is verified, so the gate produced a candidate for this line...
      const created = rig.audit.find(([event]) => event === 'participation.candidate.created');
      expect(created?.[1]).toMatchObject({ channelId: `external:loopback:${ROOM}` });
      expect(rig.audit.map(([, details]) => details.reason)).not.toContain('room_unverified');
      // ...which was reserved, appraised by the model, and leased for egress.
      expect(rig.reservationPhase.reserve).toHaveBeenCalledOnce();
      expect(rig.appraise).toHaveBeenCalledOnce();
      expect(rig.appraiserModel).toHaveBeenCalledOnce();
      expect(rig.audit).toContainEqual([
        'participation.appraisal.completed',
        expect.objectContaining({ action: 'reply', failClosed: false }),
      ]);
      expect(rig.egressLeasePhase.grantReply).toHaveBeenCalledOnce();

      // The bridge drains the appraised room reply (channel_pull_outbound).
      expect(rig.adapter.pullOutbound({ protocolVersion: 1 }).messages).toMatchObject([
        { conversationId: ROOM, text: 'Juniper: mint, parsley and chives.' },
      ]);
    } finally {
      await rig.adapter.stop();
    }
  });

  it('hands the agent a verified room, with the platform addressed flag as the connector mention', async () => {
    const received: SubstrateMessage[] = [];
    const adapter = new ExternalChannelAdapter({
      config: {
        instanceId: 'loopback',
        label: 'Loopback',
        companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
        limits: EXTERNAL_CHANNEL_TEST_LIMITS,
      },
      token: 'loopback-token',
      observer: externalObserverIdentity({ instanceId: 'loopback', displayName: COMPANION_NAME }),
      intakeScreening: null,
      log: { warn: () => undefined, error: () => undefined },
      reportRuntimeFailure: () => undefined,
    });
    void new ExternalChannelMcpRoute([adapter], []);
    adapter.onMessage(async (message) => {
      received.push(overRpc(message));
      return { content: '', channelId: message.channelId, metadata: {} } as AgentResponse;
    });
    await adapter.start();
    try {
      await send(adapter, 'alex', 'Alex', 'the bullpen was a disaster');
      await send(adapter, 'sam', 'Sam', 'what do you think?', true);
      const [ambient, addressed] = received.map(message => normalizeRoomObservation(message));
      expect(ambient).toMatchObject({
        status: 'observed',
        observation: { connector: 'external', roomVerified: true, addressedByMention: false },
      });
      expect(addressed).toMatchObject({
        status: 'observed',
        observation: { connector: 'external', roomVerified: true, addressedByMention: true },
      });
      // A bridge sender can never claim the companion's own observer identity.
      expect(received[0]!.routing?.addressing?.observer.authorId).toBe('external-companion:loopback');
      expect(received[0]!.authorId).toBe('external:loopback:alex');
    } finally {
      await adapter.stop();
    }
  });
});
