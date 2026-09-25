// psfn-framework-znqh6: an external group line that names the companion must
// reach a room reply through the REAL speaking arbiter, not stand-ins:
//   bridge inbound -> external adapter -> agent observe path
//   -> passive-name candidate -> SpeakingReservationPhase (Postgres arbiter
//      store + Postgres social pot) -> ParticipationAppraiser on the decision
//      runtime (Jev answer stubbed at the transport)
//   -> SpeakingEgressLeasePhase (same stores) -> gateway room-reply outbound
//   -> adapter outbound queue (channel_pull_outbound).
// Shakedown r3 showed Jev three-way `reply` argmaxes of 0.33 / 0.43 all
// dropped as `below_confidence_bar` against minReplyConfidence 0.5; the
// verdict and the arbiter outcome must also be visible at info level.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  createDefaultParticipationAppraiserSettings,
  createDefaultPassiveNameCandidateSettings,
  createDefaultRoomSignalSettings,
} from '../../system/config/participation-config.js';
import { createDefaultDecisionBackendSettings } from '../../system/config/decision-backend-config.js';
import { createDecisionRuntime } from '../../primitives/llm/decision/decide.js';
import type { DecisionOutcome } from '../../primitives/llm/decision/types.js';
import { createNoopSatelliteRoutingPort } from '../../core/agent/satellite-adapter-port.js';
import { PassiveNameCandidateBuilder } from '../../core/participation/passive-name-candidate.js';
import { ParticipationAppraiser } from '../../core/participation/appraiser.js';
import { RoomMessageFeatureExtractor } from '../../core/participation/room-signal.js';
import { SpeakingReservationPhase } from '../../core/agent/arbiter/reservation-phase.js';
import {
  SpeakingEgressLeasePhase,
  type EgressReplySender,
} from '../../core/agent/arbiter/egress-lease-phase.js';
import { PostgresSpeakingArbiterStore } from '../../persistence/postgres/speaking-arbiter-store.js';
import { PostgresSocialPotStore } from '../../persistence/postgres/social-pot-store.js';
import { bootstrapSharedSchema } from '../../persistence/postgres/shared-schema.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
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
import { registerGatewayMessageHandlers } from './gateway-message-handlers.js';

const TEST_IMAGE = 'postgres:16-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;
const COMPANION_NAME = 'Selene';
const ROOM = 'balcony-club';
const SOCIAL_POT = {
  capUnits: 240,
  perChannelDrawFraction: 0.34,
  regenerationTickMs: 3_600_000,
  regenerationUnitsPerTick: 10,
};
const BREAKER = { tripThreshold: 100, resetThreshold: 40 };

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

function overRpc(message: SubstrateMessage): SubstrateMessage {
  const wire = JSON.parse(JSON.stringify(message)) as SubstrateMessage & { timestamp: string };
  return { ...wire, timestamp: new Date(wire.timestamp) };
}

function jevReply(probabilities: Record<string, number>): DecisionOutcome {
  return {
    ok: true,
    answers: {
      action: { type: 'choice', choice: 'reply', probabilities, confidence: probabilities.reply },
      reaction_class: { type: 'choice', choice: 'acknowledge' },
    },
    backend: 'jev',
    probabilitySource: 'jev',
    latencyMs: 150,
    model: 'jev-test-snapshot',
  };
}

async function createRig(jevAnswer: DecisionOutcome) {
  if (!harness) throw new Error('Postgres integration harness is not available');
  const database = await harness.createDatabase();
  await bootstrapSharedSchema(database.databaseUrl);
  const arbiterStore = await PostgresSpeakingArbiterStore.connect(database.databaseUrl);
  const socialPot = await PostgresSocialPotStore.connect(database.databaseUrl);

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
  const roomReplyOutbound = createGatewayRoomReplyOutbound({
    multiCompanion: true,
    targets: resolveRoomReplyOutboundTargets({ multiCompanion: true, externalAdapters: [adapter] }),
  });

  const roomSignalSettings = {
    ...createDefaultRoomSignalSettings(),
    enabled: true,
    contextualEligibleSourceClasses: ['operator', 'primary_user', 'public_contact'] as const,
  };
  const recent: Array<{ id: string; authorId: string; authorName: string; content: string; timestamp: number }> = [];
  const candidateBuilder = new PassiveNameCandidateBuilder({
    scopeClassifier: { classifyChannelMemoryScope: async () => 'group' },
    contextReader: { getRecent: () => recent.map(entry => ({ ...entry })) as never },
    companionNames: [COMPANION_NAME],
    companionAuthorIds: [],
    settings: createDefaultPassiveNameCandidateSettings(),
    roomSignal: {
      extractor: new RoomMessageFeatureExtractor({ settings: roomSignalSettings as never }),
      profile: {
        companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
        aliases: [COMPANION_NAME],
        interests: [],
      },
      settings: roomSignalSettings as never,
    },
  });

  // decisionBackend participation.appraise in jev mode; Jev answers at the
  // transport seam, exactly as the gateway-remote backend would return it.
  const decisions = createDecisionRuntime({
    local: { decide: vi.fn(async () => { throw new Error('local backend must not run in jev mode'); }) },
    jev: { decide: vi.fn(async () => jevAnswer) },
    resolveSettings: () => ({
      ...createDefaultDecisionBackendSettings(),
      sites: { 'participation.appraise': { mode: 'jev' } },
    }),
    shadowSink: { record: () => undefined },
  });
  const appraiser = new ParticipationAppraiser({
    llmProvider: { complete: vi.fn(async () => { throw new Error('local appraisal must not run in jev mode'); }) },
    companionName: COMPANION_NAME,
    companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
    decisions,
    settings: { ...createDefaultParticipationAppraiserSettings(), enabled: true },
  });

  const reservationPhase = new SpeakingReservationPhase({
    store: arbiterStore,
    socialPot,
    icpPrecedence: { resolve: () => ({ icpTurnFenced: false, icpFatigueExhausted: false }) },
    companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
    config: {
      reservationTtlMs: 120_000,
      minReserveDrawUnits: 1,
      socialPot: SOCIAL_POT,
      roomEpisodeCircuitBreaker: BREAKER,
      wrapUpThreshold: 60,
    },
  });
  // The generation step is the agent loop's; the delivery is the real
  // gateway `channel.sendRoomReply` outbound onto the adapter queue.
  const sender: EgressReplySender = {
    deliver: async (request) => {
      await roomReplyOutbound.send({
        channelType: 'external',
        channelId: request.trigger.channelId,
        content: `${COMPANION_NAME}: mint does well in shade.`,
        companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
      });
      return { outcome: 'delivered' };
    },
  };
  const egressLeasePhase = new SpeakingEgressLeasePhase({
    store: arbiterStore,
    socialPot,
    roomPressure: {
      resolve: (ctx) => ({
        channelId: ctx.channelId,
        pressure: 0,
        contributingEventCount: 0,
        windowStartMs: 0,
        evaluatedAtMs: ctx.nowMs,
        level: 'calm',
        wrapUpInvited: false,
        leaseThresholdBias: 0,
      }),
    },
    sender,
    companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
    config: {
      mode: 'on',
      leaseTtlMs: 60_000,
      egressDrawUnits: 1,
      // The shakedown value: the bar the r3 Jev verdicts failed.
      minReplyConfidence: 0.5,
      socialPot: SOCIAL_POT,
      roomEpisodeCircuitBreaker: BREAKER,
      wrapUpThreshold: 60,
      replyPressureUnits: 3,
    },
    generateLeaseId: randomUUID,
  });

  let onHandleMessage: ((message: SubstrateMessage) => Promise<AgentResponse>) | undefined;
  const info = vi.fn();
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
    safeguardAuditTrail: { append: vi.fn() } as never,
    satelliteRouting: createNoopSatelliteRoutingPort(),
    config: { companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID, multiCompanion: true } as SubstrateConfig,
    log: { info, warn: vi.fn(), error: vi.fn() },
    trackSessionActivity: vi.fn(),
    passiveNameCandidateBuilder: candidateBuilder,
    participationAppraiser: appraiser,
    reservationPhase,
    egressLeasePhase,
    companionAuthorName: COMPANION_NAME,
  });
  if (!onHandleMessage) throw new Error('gateway handle handler was not registered');
  const handle = onHandleMessage;
  adapter.onMessage(async message => await handle(overRpc(message)));
  await adapter.start();

  return {
    adapter,
    info,
    close: async () => {
      await adapter.stop();
      await arbiterStore.close();
      await socialPot.close();
    },
  };
}

let sequence = 0;
async function send(adapter: ExternalChannelAdapter, senderId: string, senderName: string, text: string) {
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
    },
  });
}

function infoEvent(info: ReturnType<typeof vi.fn>, message: string): Record<string, unknown> | undefined {
  return info.mock.calls.find(([logged]) => logged === message)?.[1] as Record<string, unknown> | undefined;
}

describe('external group room through the real speaking arbiter (znqh6)', () => {
  it('delivers an appraised reply for a Jev three-way reply argmax below 0.5 raw', async () => {
    const rig = await createRig(jevReply({ ignore: 0.3, react: 0.27, reply: 0.43 }));
    try {
      await send(rig.adapter, 'alex', 'Alex', 'anyone catch the game last night?');
      await send(rig.adapter, 'sam', 'Sam', 'lol yes, I switched to a cooking show');
      const named = await send(
        rig.adapter,
        'sam',
        'Sam',
        'Selene, quick question for you: basil or mint for a shady north-facing balcony?',
      );
      expect(named).toEqual({ status: 'no_reply' });

      expect(infoEvent(rig.info, 'Participation appraisal.completed')).toMatchObject({
        action: 'reply',
        reasonCode: 'decision_backend',
        failClosed: false,
      });
      const egress = infoEvent(rig.info, 'Participation egress.settled');
      expect(egress).toMatchObject({ action: 'reply', outcome: 'delivered' });
      expect(egress?.confidence as number).toBeCloseTo(0.43 / 0.73, 10);
      expect(rig.adapter.pullOutbound({ protocolVersion: 1 }).messages).toMatchObject([
        { conversationId: ROOM, text: 'Selene: mint does well in shade.' },
      ]);
    } finally {
      await rig.close();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('still suppresses a genuinely doubtful reply, visibly and with a typed reason', async () => {
    const rig = await createRig(jevReply({ ignore: 0.7, react: 0.1, reply: 0.2 }));
    try {
      await send(rig.adapter, 'alex', 'Alex', 'the bullpen was a disaster');
      await send(rig.adapter, 'sam', 'Sam', 'Selene probably has opinions about bullpens, lol');
      const egress = infoEvent(rig.info, 'Participation egress.settled');
      expect(egress).toMatchObject({ action: 'reply', outcome: 'below_confidence_bar' });
      expect(egress?.confidence as number).toBeCloseTo(0.2 / 0.9, 10);
      expect(rig.adapter.pullOutbound({ protocolVersion: 1 }).messages).toEqual([]);
    } finally {
      await rig.close();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
