import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentResponse,
  Attachment,
  SubstrateMessage,
  TurnID,
} from '../../shared/contracts/runtime.js';
import type { SatelliteRoutingMetadata } from '../../core/agent/satellite-adapter-port.js';
import { createNoopSatelliteRoutingPort } from '../../core/agent/satellite-adapter-port.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  registerGatewayMessageHandlers,
  type EgressLeasePhasePort,
  type ObservedGroupMemorySchedulerPort,
  type ParticipationAppraiserPort,
  type PassiveNameCandidatePort,
  type ReservationPhasePort,
} from './gateway-message-handlers.js';
import type { EgressLeaseDecision } from '../../core/agent/arbiter/egress-lease-phase.js';
import type {
  ParticipationAppraisalResult,
  ParticipationCandidate,
} from '../../core/participation/types.js';
import type { ReservationDecision } from '../../core/agent/arbiter/reservation-phase.js';
import type {
  RoomEpisodeSnapshot,
  SpeakingReservationSnapshot,
} from '../../core/agent/arbiter/speaking-arbiter-store-port.js';
import type {
  CompanionMessageDeliveryFailureNotification,
  CompanionMessageFailureReportParams,
} from '../../boundary/gateway/protocol.js';
import {
  deriveIcpTransportMessageId,
  type IcpConversationCorrelation,
} from '../../shared/contracts/icp-autonomy.js';
import type { RecordedCompanionSourceMessage } from '../../core/session/icp-delivery-recovery.js';
import { materializeGatewayAttachment } from '../../boundary/gateway/attachment-materialization.js';
import { EventBus } from '../../shared/event-bus.js';
import { ParentTurnContinuationBudgetExceededError } from '../../core/agent/turn-limits.js';

function makeMessage(overrides?: Record<string, unknown>): SubstrateMessage {
  return {
    id: 'msg-1',
    channelId: 'api:test-channel',
    channelType: 'api',
    authorId: 'user-1',
    authorName: 'User',
    content: 'hello from api',
    timestamp: new Date('2026-03-02T00:00:00.000Z'),
    routing: {
      source: 'api',
    },
    ...overrides,
  } as SubstrateMessage;
}

function makeResponse(content: string): AgentResponse {
  return {
    content,
    channelId: 'discord:general',
    metadata: {
      model: 'test-model',
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 25,
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness(overrides?: {
  eventBus?: EventBus;
  nowMonotonicMs?: () => number;
  config?: SubstrateConfig;
  delegateSatelliteSession?: (request: {
    message: SubstrateMessage;
    routing?: SatelliteRoutingMetadata;
  }) => Promise<{
    shardId: string;
    content: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  }>;
  handleMessage?: (
    message: SubstrateMessage,
    deliveryLifecycle?: {
      recoveredResponse?: AgentResponse;
      sourceAlreadyPersisted?: true;
      finalizeDelivery(response: AgentResponse): Promise<void>;
    },
  ) => Promise<AgentResponse>;
  observeMessage?: (message: SubstrateMessage) => Promise<void>;
  waitForIdle?: () => Promise<void>;
  observedGroupMemoryScheduler?: ObservedGroupMemorySchedulerPort;
  passiveNameCandidateBuilder?: PassiveNameCandidatePort;
  participationAppraiser?: ParticipationAppraiserPort;
  reservationPhase?: ReservationPhasePort;
  egressLeasePhase?: EgressLeasePhasePort;
  discordSend?: (channelId: string, content: string) => Promise<void>;
  discordSendMedia?: (channelId: string, media: Attachment) => Promise<void>;
  companionSend?: (
    channelId: string,
    content: string,
    authorName?: string,
    correlationOrReplyToMessageId?: IcpConversationCorrelation | string,
  ) => Promise<{
    channelId: string;
    messageId: string;
    deliveredTo: string[];
    skippedOffline: string[];
  }>;
  companionSendInitiation?: (input: Record<string, unknown>) => Promise<any>;
  companionReportFailure?: (params: CompanionMessageFailureReportParams) => Promise<unknown>;
  findRecordedCompanionSourceMessage?: (
    channelId: string,
    sourceMessageId: string,
  ) => Promise<RecordedCompanionSourceMessage | null> | RecordedCompanionSourceMessage | null;
  findRecordedIcpInitiation?: (
    channelId: string,
    sourceMessageId: string,
  ) => Promise<{
    content: string;
    correlation: IcpConversationCorrelation;
    recoveryResponse: AgentResponse;
  } | null> | {
    content: string;
    correlation: IcpConversationCorrelation;
    recoveryResponse: AgentResponse;
  } | null;
  findIcpDeliveryObservation?: (
    channelId: string,
    sourceMessageId: string,
  ) => Promise<any> | any;
  recordIcpDeliveryObservation?: (observation: any) => Promise<void> | void;
  outboundReplyGuard?: {
    noteDelivered: ReturnType<typeof vi.fn>;
    evaluate: ReturnType<typeof vi.fn>;
  };
}) {
  let onHandleMessage:
    | ((message: SubstrateMessage) => Promise<AgentResponse>)
    | undefined;
  let onDiscordMessage:
    | ((message: SubstrateMessage) => void | Promise<void>)
    | undefined;
  let onCompanionMessage:
    | ((message: SubstrateMessage) => void | Promise<void>)
    | undefined;
  let onCompanionDeliveryFailure:
    | ((notification: CompanionMessageDeliveryFailureNotification) => void | Promise<void>)
    | undefined;

  const gateway = {
    onHandleMessage: vi.fn((handler: (message: SubstrateMessage) => Promise<AgentResponse>) => {
      onHandleMessage = handler;
    }),
    onDiscordMessage: vi.fn((handler: (message: SubstrateMessage) => void | Promise<void>) => {
      onDiscordMessage = handler;
    }),
    onCompanionMessage: vi.fn((handler: (message: SubstrateMessage) => void | Promise<void>) => {
      onCompanionMessage = handler;
    }),
    onCompanionDeliveryFailure: vi.fn((
      handler: (notification: CompanionMessageDeliveryFailureNotification) => void | Promise<void>,
    ) => {
      onCompanionDeliveryFailure = handler;
    }),
    discordSend: vi.fn(overrides?.discordSend ?? (async () => {})),
    discordSendMedia: vi.fn(overrides?.discordSendMedia ?? (async () => {})),
    companionSend: vi.fn(overrides?.companionSend ?? (async channelId => ({
      channelId,
      messageId: 'companion-reply-test',
      deliveredTo: [],
      skippedOffline: [],
    }))),
    companionSendInitiation: vi.fn(overrides?.companionSendInitiation ?? (async () => ({
      channelId: 'companion-dm:test',
      messageId: 'companion-initiation-test',
      deliveredTo: [],
      skippedOffline: [],
      permitOutcome: 'consumed',
    }))),
    companionConsumeInitiationPermit: vi.fn(async () => ({ outcome: 'consumed' })),
    companionReportFailure: vi.fn(overrides?.companionReportFailure ?? (async () => ({}))),
  };
  const agentLoop = {
    handleMessage: vi.fn(overrides?.handleMessage ?? (async () => makeResponse('primary response'))),
    observeMessage: vi.fn(overrides?.observeMessage ?? (async () => {})),
    waitForIdle: vi.fn(overrides?.waitForIdle ?? (async () => {})),
    findRecordedIcpInitiation: vi.fn(overrides?.findRecordedIcpInitiation ?? (async () => null)),
    findIcpDeliveryObservation: vi.fn(overrides?.findIcpDeliveryObservation ?? (async () => null)),
    findRecordedCompanionSourceMessage: vi.fn(
      overrides?.findRecordedCompanionSourceMessage ?? (async () => null),
    ),
    recordIcpDeliveryObservation: vi.fn(
      overrides?.recordIcpDeliveryObservation ?? (async () => {}),
    ),
  };
  const shardManager = {
    delegateSatelliteSession: vi.fn(
      overrides?.delegateSatelliteSession
      ?? (async () => ({
        shardId: 'test-shard-1',
        content: 'delegated response',
        model: 'shard-model',
        inputTokens: 3,
        outputTokens: 7,
        durationMs: 42,
      })),
    ),
  };
  const satelliteRouting = createNoopSatelliteRoutingPort();
  const safeguardAuditTrail = {
    append: vi.fn(),
  };
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const trackSessionActivity = vi.fn();
  const config = overrides?.config ?? ({
    companionId: '11111111-1111-4111-8111-111111111111',
  } as SubstrateConfig);
  const eventBus = overrides?.eventBus ?? new EventBus();

  registerGatewayMessageHandlers({
    eventBus,
    gateway,
    agentLoop,
    shardManager,
    safeguardAuditTrail,
    satelliteRouting,
    config,
    log,
    trackSessionActivity,
    ...(overrides?.observedGroupMemoryScheduler
      ? { observedGroupMemoryScheduler: overrides.observedGroupMemoryScheduler }
      : {}),
    ...(overrides?.passiveNameCandidateBuilder
      ? { passiveNameCandidateBuilder: overrides.passiveNameCandidateBuilder }
      : {}),
    ...(overrides?.participationAppraiser
      ? { participationAppraiser: overrides.participationAppraiser }
      : {}),
    ...(overrides?.reservationPhase
      ? { reservationPhase: overrides.reservationPhase }
      : {}),
    ...(overrides?.egressLeasePhase
      ? { egressLeasePhase: overrides.egressLeasePhase }
      : {}),
    ...(overrides?.outboundReplyGuard
      ? { outboundReplyGuard: overrides.outboundReplyGuard }
      : {}),
    companionAuthorName: 'Selene',
    ...(overrides?.nowMonotonicMs ? { nowMonotonicMs: overrides.nowMonotonicMs } : {}),
  });

  if (!onHandleMessage || !onDiscordMessage || !onCompanionMessage || !onCompanionDeliveryFailure) {
    throw new Error('Expected gateway message handlers to be registered');
  }

  return {
    gateway,
    agentLoop,
    shardManager,
    safeguardAuditTrail,
    log,
    trackSessionActivity,
    observedGroupMemoryScheduler: overrides?.observedGroupMemoryScheduler,
    outboundReplyGuard: overrides?.outboundReplyGuard,
    eventBus,
    onHandleMessage,
    onDiscordMessage,
    onCompanionMessage,
    onCompanionDeliveryFailure,
  };
}

describe('registerGatewayMessageHandlers', () => {
  it('normalizes discord timestamp strings and sends the primary response', async () => {
    const harness = createHarness({
      handleMessage: async () => makeResponse('discord response'),
    });
    const message = makeMessage({
      channelId: 'discord:general',
      channelType: 'discord',
      timestamp: '2026-03-02T02:00:00.000Z',
      attachments: [
        {
          url: 'https://cdn.discordapp.com/attachments/1/2/image.png',
          contentType: 'image/png',
          name: 'image.png',
        },
      ],
      routing: undefined,
    });

    await harness.onDiscordMessage(message);

    expect(message.timestamp).toBeInstanceOf(Date);
    expect(harness.trackSessionActivity).toHaveBeenCalledWith(message);
    expect(harness.log.info).toHaveBeenCalledWith(
      'Message from User: hello from api...',
      {
        channelId: 'discord:general',
        attachmentCount: 1,
        attachmentTypes: ['image/png'],
        attachmentNames: ['image.png'],
        responseMode: 'respond',
      },
    );
    expect(harness.agentLoop.handleMessage).toHaveBeenCalledWith(message);
    await vi.waitFor(() => {
      expect(harness.gateway.discordSend).toHaveBeenCalledWith('discord:general', 'discord response');
    });
  });

  it('records a delivered discord reply with the outbound reply guard (psfn-framework-mdxu)', async () => {
    const outboundReplyGuard = {
      noteDelivered: vi.fn(),
      evaluate: vi.fn(() => null),
    };
    const harness = createHarness({
      handleMessage: async () => makeResponse('primary reply text'),
      outboundReplyGuard,
    });
    const message = makeMessage({
      id: 'discord-msg-42',
      channelId: 'discord:general',
      channelType: 'discord',
      routing: undefined,
    });

    await harness.onDiscordMessage(message);

    await vi.waitFor(() => {
      expect(harness.gateway.discordSend).toHaveBeenCalledWith('discord:general', 'primary reply text');
    });
    expect(outboundReplyGuard.noteDelivered).toHaveBeenCalledWith({
      channelId: 'discord:general',
      content: 'primary reply text',
      sourceTurnId: 'discord-msg-42',
      senderKind: 'discord_inbound_reply',
    });
  });

  it('does not record an empty (suppressed) discord reply with the outbound reply guard', async () => {
    const outboundReplyGuard = {
      noteDelivered: vi.fn(),
      evaluate: vi.fn(() => null),
    };
    const harness = createHarness({
      handleMessage: async () => makeResponse('   '),
      outboundReplyGuard,
    });
    const message = makeMessage({
      id: 'discord-msg-43',
      channelId: 'discord:general',
      channelType: 'discord',
      routing: undefined,
    });

    await harness.onDiscordMessage(message);

    await vi.waitFor(() => {
      expect(harness.agentLoop.handleMessage).toHaveBeenCalledWith(message);
    });
    expect(harness.gateway.discordSend).not.toHaveBeenCalled();
    expect(outboundReplyGuard.noteDelivered).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.onDiscordMessage(message);
    expect(harness.agentLoop.handleMessage).toHaveBeenCalledTimes(1);
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith('gateway.message.duplicate', {
      route: 'discord',
      channelId: 'discord:general',
      messageId: 'discord-msg-43',
      disposition: 'cached',
    });
  });

  it('returns from discord notification receipt before backend turn work finishes', async () => {
    const deferredTurn = createDeferred<AgentResponse>();
    const harness = createHarness({
      handleMessage: async () => deferredTurn.promise,
    });
    const message = makeMessage({
      channelId: 'discord:general',
      channelType: 'discord',
      routing: undefined,
    });

    await expect(harness.onDiscordMessage(message)).resolves.toBeUndefined();

    expect(harness.trackSessionActivity).toHaveBeenCalledWith(message);
    expect(harness.agentLoop.handleMessage).toHaveBeenCalledWith(message);
    expect(harness.gateway.discordSend).not.toHaveBeenCalled();

    deferredTurn.resolve(makeResponse('eventual response'));
    await vi.waitFor(() => {
      expect(harness.gateway.discordSend).toHaveBeenCalledWith('discord:general', 'eventual response');
    });
  });

  it('records passive discord observations without generating or sending a response', async () => {
    const harness = createHarness();
    const message = makeMessage({
      id: 'discord-observe-1',
      channelId: 'discord:general',
      channelType: 'discord',
      timestamp: '2026-03-02T02:00:00.000Z',
      routing: {
        source: 'discord',
        responseMode: 'observe',
      },
    });

    await harness.onDiscordMessage(message);

    expect(message.timestamp).toBeInstanceOf(Date);
    expect(harness.trackSessionActivity).toHaveBeenCalledWith(message);
    expect(harness.agentLoop.observeMessage).toHaveBeenCalledWith(message);
    expect(harness.agentLoop.handleMessage).not.toHaveBeenCalled();
    expect(harness.gateway.discordSend).not.toHaveBeenCalled();
    expect(harness.gateway.discordSendMedia).not.toHaveBeenCalled();
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith('discord.message.observed', {
      channelId: 'discord:general',
      messageId: 'discord-observe-1',
      authorId: 'user-1',
    });
  });

  it('can schedule observed group memory from passive discord observations without replying', async () => {
    const observedGroupMemoryScheduler: ObservedGroupMemorySchedulerPort = {
      observeMessage: vi.fn(async () => ({
        status: 'scheduled',
        channelId: 'discord:general',
        triggerReason: 'observed_count',
        spanStartMessageId: 10,
        spanEndMessageId: 60,
        newEntryCount: 50,
        watermarkLagMessageIds: 50,
        hasDeferredBacklog: false,
      })),
    };
    const harness = createHarness({ observedGroupMemoryScheduler });
    const message = makeMessage({
      id: 'discord-observe-memory-1',
      channelId: 'discord:general',
      channelType: 'discord',
      timestamp: '2026-03-02T02:00:00.000Z',
      routing: {
        source: 'discord',
        responseMode: 'observe',
      },
    });

    await harness.onDiscordMessage(message);

    expect(observedGroupMemoryScheduler.observeMessage).toHaveBeenCalledWith(message);
    expect(harness.agentLoop.observeMessage).toHaveBeenCalledWith(message);
    expect(harness.agentLoop.handleMessage).not.toHaveBeenCalled();
    expect(harness.gateway.discordSend).not.toHaveBeenCalled();
    expect(harness.gateway.discordSendMedia).not.toHaveBeenCalled();
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith(
      'memory.group_observed.scheduled',
      {
        channelId: 'discord:general',
        messageId: 'discord-observe-memory-1',
        triggerReason: 'observed_count',
        spanStartMessageId: 10,
        spanEndMessageId: 60,
        newEntryCount: 50,
        watermarkLagMessageIds: 50,
        hasDeferredBacklog: false,
      },
    );
  });

  it('does not schedule duplicate observed group memory jobs for duplicate passive notifications', async () => {
    const deferredSchedule = createDeferred<Awaited<ReturnType<ObservedGroupMemorySchedulerPort['observeMessage']>>>();
    const observedGroupMemoryScheduler: ObservedGroupMemorySchedulerPort = {
      observeMessage: vi.fn(async () => deferredSchedule.promise),
    };
    const harness = createHarness({ observedGroupMemoryScheduler });
    const message = makeMessage({
      id: 'discord-observe-memory-dup',
      channelId: 'discord:general',
      channelType: 'discord',
      timestamp: '2026-03-02T02:00:00.000Z',
      routing: {
        source: 'discord',
        responseMode: 'observe',
      },
    });

    const firstReceipt = harness.onDiscordMessage(message);
    await vi.waitFor(() => {
      expect(observedGroupMemoryScheduler.observeMessage).toHaveBeenCalledTimes(1);
    });
    await harness.onDiscordMessage(message);

    expect(observedGroupMemoryScheduler.observeMessage).toHaveBeenCalledTimes(1);
    expect(harness.agentLoop.observeMessage).toHaveBeenCalledTimes(1);
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith('gateway.message.duplicate', {
      route: 'discord',
      channelId: 'discord:general',
      messageId: 'discord-observe-memory-dup',
      disposition: 'in_flight',
    });

    deferredSchedule.resolve({
      status: 'skipped',
      channelId: 'discord:general',
      reason: 'threshold_not_met',
      watermarkLagMessageIds: 12,
    });
    await firstReceipt;
  });

  it('sends generated media attachments back through the gateway discord egress', async () => {
    const harness = createHarness({
      handleMessage: async () => ({
        ...makeResponse(''),
        attachments: [{
          url: 'https://images.example.test/purr.png',
          contentType: 'image/png',
          name: 'purr.png',
          localPath: '/tmp/purr.png',
        }],
      }),
    });
    const message = makeMessage({
      channelId: 'discord:general',
      channelType: 'discord',
      routing: undefined,
    });

    await harness.onDiscordMessage(message);

    await vi.waitFor(() => {
      expect(harness.gateway.discordSendMedia).toHaveBeenCalledWith('discord:general', {
        url: 'https://images.example.test/purr.png',
        contentType: 'image/png',
        name: 'purr.png',
        localPath: '/tmp/purr.png',
      });
    });
    expect(harness.gateway.discordSend).not.toHaveBeenCalled();
  });

  it('delivers generated local media through authenticated gateway materialization as immutable bytes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'psfn-agent-discord-media-'));
    try {
      const localPath = join(workspace, 'purr.png');
      writeFileSync(localPath, 'generated-png-bytes');
      const adapterSendMedia = vi.fn(async () => {});
      const harness = createHarness({
        handleMessage: async () => ({
          ...makeResponse(''),
          attachments: [{
            url: 'https://images.example.test/purr.png',
            contentType: 'image/png',
            name: 'purr.png',
            localPath,
          }],
        }),
        discordSendMedia: async (channelId, media) => {
          await adapterSendMedia(channelId, materializeGatewayAttachment(media, workspace));
        },
      });

      await harness.onDiscordMessage(makeMessage({
        channelId: 'discord:general',
        channelType: 'discord',
        routing: undefined,
      }));

      await vi.waitFor(() => {
        expect(adapterSendMedia).toHaveBeenCalledWith('discord:general', {
          url: 'https://images.example.test/purr.png',
          contentType: 'image/png',
          name: 'purr.png',
          dataBase64: Buffer.from('generated-png-bytes').toString('base64'),
        });
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('records diagnostics when discord agent handling fails', async () => {
    const harness = createHarness({
      handleMessage: async () => {
        throw new Error('agent handling failure');
      },
    });
    const message = makeMessage({
      channelId: 'discord:general',
      channelType: 'discord',
      routing: undefined,
    });

    await harness.onDiscordMessage(message);

    await vi.waitFor(() => {
      expect(harness.log.error).toHaveBeenCalledWith('Error handling message', {
        channelId: 'discord:general',
        messageId: 'msg-1',
        error: 'agent handling failure',
        stage: 'handle_message',
      });
    });
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith('discord.message.error', {
      channelId: 'discord:general',
      messageId: 'msg-1',
      error: 'agent handling failure',
      stage: 'handle_message',
    });
    expect(harness.gateway.discordSend).toHaveBeenCalledWith(
      'discord:general',
      '[System delivery error] The runtime could not complete that turn. Please retry your message.',
    );
    expect(harness.gateway.discordSendMedia).not.toHaveBeenCalled();
  });

  it('surfaces a continuation-budget failure and processes the next queued message', async () => {
    const handleMessage = vi.fn()
      .mockRejectedValueOnce(new ParentTurnContinuationBudgetExceededError({
        schemaVersion: 1,
        reason: 'wall_clock_limit',
        promptEntries: 9,
        maxPromptEntries: 36,
        elapsedMs: 300_000,
        maxWallTimeMs: 300_000,
      }))
      .mockResolvedValueOnce(makeResponse('next turn completed'));
    const harness = createHarness({ handleMessage });

    await harness.onDiscordMessage(makeMessage({
      id: 'msg-budget-stopped',
      channelId: 'discord:general',
      channelType: 'discord',
      routing: undefined,
    }));
    await harness.onDiscordMessage(makeMessage({
      id: 'msg-after-budget-stop',
      channelId: 'discord:other',
      channelType: 'discord',
      routing: undefined,
    }));

    await vi.waitFor(() => {
      expect(handleMessage).toHaveBeenCalledTimes(2);
      expect(harness.gateway.discordSend).toHaveBeenCalledWith(
        'discord:general',
        '[System delivery error] The runtime could not complete that turn. Please retry your message.',
      );
      expect(harness.gateway.discordSend).toHaveBeenCalledWith(
        'discord:other',
        'next turn completed',
      );
    });
  });

  it('keeps a discord message retryable when agent handling fails', async () => {
    const handleMessage = vi.fn()
      .mockRejectedValueOnce(new Error('transient model failure'))
      .mockResolvedValueOnce(makeResponse('recovered response'));
    const harness = createHarness({ handleMessage });
    const message = makeMessage({
      id: 'msg-handle-retry',
      channelId: 'discord:general',
      channelType: 'discord',
      routing: undefined,
    });

    await harness.onDiscordMessage(message);
    await vi.waitFor(() => {
      expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith(
        'discord.message.error',
        expect.objectContaining({ messageId: 'msg-handle-retry', stage: 'handle_message' }),
      );
    });

    await harness.onDiscordMessage(message);
    await vi.waitFor(() => {
      expect(handleMessage).toHaveBeenCalledTimes(2);
      expect(harness.gateway.discordSend).toHaveBeenCalledWith('discord:general', 'recovered response');
    });
  });

  it('retries failed discord text delivery without rerunning the completed turn', async () => {
    const discordSend = vi.fn()
      .mockRejectedValueOnce(new Error('discord text unavailable'))
      .mockResolvedValue(undefined);
    const handleMessage = vi.fn(async () => makeResponse('deliver me once'));
    const harness = createHarness({ handleMessage, discordSend });
    const message = makeMessage({
      id: 'msg-text-retry',
      channelId: 'discord:general',
      channelType: 'discord',
      routing: undefined,
    });

    await harness.onDiscordMessage(message);
    await vi.waitFor(() => {
      expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith(
        'discord.message.error',
        expect.objectContaining({ messageId: 'msg-text-retry', stage: 'text_delivery' }),
      );
    });

    await harness.onDiscordMessage(message);
    await vi.waitFor(() => {
      expect(discordSend).toHaveBeenCalledWith('discord:general', 'deliver me once');
      expect(discordSend).toHaveBeenCalledTimes(3);
    });
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it('resumes failed discord media delivery without duplicating delivered text', async () => {
    const attachment: Attachment = {
      url: 'https://images.example.test/retry.png',
      contentType: 'image/png',
      name: 'retry.png',
    };
    const discordSendMedia = vi.fn()
      .mockRejectedValueOnce(new Error('discord media unavailable'))
      .mockResolvedValue(undefined);
    const handleMessage = vi.fn(async () => ({
      ...makeResponse('text already delivered'),
      attachments: [attachment],
    }));
    const harness = createHarness({ handleMessage, discordSendMedia });
    const message = makeMessage({
      id: 'msg-media-retry',
      channelId: 'discord:general',
      channelType: 'discord',
      routing: undefined,
    });

    await harness.onDiscordMessage(message);
    await vi.waitFor(() => {
      expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith(
        'discord.message.error',
        expect.objectContaining({ messageId: 'msg-media-retry', stage: 'media_delivery' }),
      );
    });

    await harness.onDiscordMessage(message);
    await vi.waitFor(() => {
      expect(discordSendMedia).toHaveBeenCalledTimes(2);
    });
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(harness.gateway.discordSend.mock.calls.filter(([, content]) => content === 'text already delivered'))
      .toHaveLength(1);
  });

  it('holds a discord message until the in-flight turn finishes instead of dropping it', async () => {
    const handleMessage = vi.fn()
      .mockRejectedValueOnce(new Error('Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.'))
      .mockResolvedValueOnce(makeResponse('after the turn finished'));
    const harness = createHarness({ handleMessage });
    const message = makeMessage({
      channelId: 'discord:general',
      channelType: 'discord',
      routing: undefined,
    });

    await harness.onDiscordMessage(message);

    await vi.waitFor(() => {
      expect(harness.agentLoop.waitForIdle).toHaveBeenCalledTimes(1);
      expect(handleMessage).toHaveBeenCalledTimes(2);
      expect(harness.gateway.discordSend).toHaveBeenCalledWith('discord:general', 'after the turn finished');
    });
    expect(harness.log.error).not.toHaveBeenCalled();
  });

  it('keeps waiting through repeated busy collisions instead of ever dropping', async () => {
    const busyError = new Error('Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.');
    const handleMessage = vi.fn()
      .mockRejectedValueOnce(busyError)
      .mockRejectedValueOnce(busyError)
      .mockRejectedValueOnce(busyError)
      .mockRejectedValueOnce(busyError)
      .mockResolvedValueOnce(makeResponse('finally through'));
    const harness = createHarness({ handleMessage });
    const message = makeMessage({
      channelId: 'discord:general',
      channelType: 'discord',
      routing: undefined,
    });

    await harness.onDiscordMessage(message);

    await vi.waitFor(() => {
      expect(handleMessage).toHaveBeenCalledTimes(5);
      expect(harness.agentLoop.waitForIdle).toHaveBeenCalledTimes(4);
      expect(harness.gateway.discordSend).toHaveBeenCalledWith('discord:general', 'finally through');
    });
    expect(harness.log.error).not.toHaveBeenCalled();
  });

  it('bundles same-author messages that arrive while a turn is processing into one follow-up turn', async () => {
    let releaseFirstTurn: (response: AgentResponse) => void = () => {};
    const firstTurn = new Promise<AgentResponse>((resolve) => {
      releaseFirstTurn = resolve;
    });
    const handleMessage = vi.fn()
      .mockImplementationOnce(async () => firstTurn)
      .mockImplementation(async () => makeResponse('saw everything'));
    const harness = createHarness({ handleMessage });

    const makeBurstMessage = (id: string, content: string) => makeMessage({
      id,
      content,
      channelId: 'discord:general',
      channelType: 'discord',
      routing: undefined,
      attachments: undefined,
    });

    await harness.onDiscordMessage(makeBurstMessage('msg-a', 'first thing'));
    await harness.onDiscordMessage(makeBurstMessage('msg-b', 'second thing'));
    await harness.onDiscordMessage(makeBurstMessage('msg-c', 'and a third'));
    releaseFirstTurn(makeResponse('reply to the first'));

    await vi.waitFor(() => {
      expect(handleMessage).toHaveBeenCalledTimes(2);
      expect(harness.gateway.discordSend).toHaveBeenNthCalledWith(2, 'discord:general', 'saw everything');
    });
    const bundled = handleMessage.mock.calls[1][0] as SubstrateMessage;
    expect(bundled.content).toBe('second thing\nand a third');
    expect(bundled.id).toBe('msg-c');
    expect(harness.gateway.discordSend).toHaveBeenNthCalledWith(1, 'discord:general', 'reply to the first');
    expect(harness.gateway.discordSend).toHaveBeenNthCalledWith(2, 'discord:general', 'saw everything');
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith('discord.message.bundled', {
      channelId: 'discord:general',
      messageIds: ['msg-b', 'msg-c'],
      count: 2,
    });
    expect(harness.log.error).not.toHaveBeenCalled();
  });

  it('measures each bundled discord message from enqueue to dequeue with its own trace key', async () => {
    let releaseFirstTurn: (response: AgentResponse) => void = () => {};
    const firstTurn = new Promise<AgentResponse>((resolve) => {
      releaseFirstTurn = resolve;
    });
    const handleMessage = vi.fn()
      .mockImplementationOnce(async () => firstTurn)
      .mockImplementation(async () => makeResponse('bundled reply'));
    let monotonicNow = 0;
    const eventBus = new EventBus();
    const performanceEvents: Array<Record<string, unknown>> = [];
    eventBus.on('agent.turn.performance', event => {
      performanceEvents.push(event as unknown as Record<string, unknown>);
    });
    const harness = createHarness({
      eventBus,
      handleMessage,
      nowMonotonicMs: () => monotonicNow,
    });
    const makeBurstMessage = (id: string, content: string) => makeMessage({
      id,
      content,
      channelId: 'discord:general',
      channelType: 'discord',
      routing: undefined,
      attachments: undefined,
    });

    await harness.onDiscordMessage(makeBurstMessage('msg-a', 'first thing'));
    monotonicNow = 100;
    await harness.onDiscordMessage(makeBurstMessage('msg-b', 'second thing'));
    monotonicNow = 125;
    await harness.onDiscordMessage(makeBurstMessage('msg-c', 'and a third'));
    monotonicNow = 175;
    releaseFirstTurn(makeResponse('reply to the first'));

    await vi.waitFor(() => {
      expect(handleMessage).toHaveBeenCalledTimes(2);
      expect(performanceEvents.filter(event => event.stage === 'channel_queue_wait')).toHaveLength(3);
    });
    expect(performanceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        traceId: 'msg-b',
        turnId: 'msg-b',
        requestId: 'msg-b',
        stage: 'channel_queue_wait',
        monotonicAtMs: 175,
        durationMs: 75,
      }),
      expect.objectContaining({
        traceId: 'msg-c',
        turnId: 'msg-c',
        requestId: 'msg-c',
        stage: 'channel_queue_wait',
        monotonicAtMs: 175,
        durationMs: 50,
      }),
    ]));
    expect((handleMessage.mock.calls[1]?.[0] as SubstrateMessage).id).toBe('msg-c');
  });

  it('does not bundle messages from different authors into one user turn', async () => {
    let releaseFirstTurn: (response: AgentResponse) => void = () => {};
    const firstTurn = new Promise<AgentResponse>((resolve) => {
      releaseFirstTurn = resolve;
    });
    const handleMessage = vi.fn()
      .mockImplementationOnce(async () => firstTurn)
      .mockImplementation(async () => makeResponse('separate reply'));
    const harness = createHarness({ handleMessage });

    await harness.onDiscordMessage(makeMessage({
      id: 'msg-a',
      content: 'opener',
      channelId: 'discord:general',
      channelType: 'discord',
      routing: undefined,
      attachments: undefined,
    }));
    await harness.onDiscordMessage(makeMessage({
      id: 'msg-b',
      content: 'from vega',
      authorId: 'user-1',
      channelId: 'discord:general',
      channelType: 'discord',
      routing: undefined,
      attachments: undefined,
    }));
    await harness.onDiscordMessage(makeMessage({
      id: 'msg-c',
      content: 'from someone else',
      authorId: 'user-2',
      authorName: 'Someone Else',
      channelId: 'discord:general',
      channelType: 'discord',
      routing: undefined,
      attachments: undefined,
    }));
    releaseFirstTurn(makeResponse('first reply'));

    // Three turns total: opener, vega's queued message, the other author's.
    await vi.waitFor(() => {
      expect(handleMessage).toHaveBeenCalledTimes(3);
    });
    expect((handleMessage.mock.calls[1][0] as SubstrateMessage).content).toBe('from vega');
    expect((handleMessage.mock.calls[2][0] as SubstrateMessage).content).toBe('from someone else');
    expect(harness.safeguardAuditTrail.append).not.toHaveBeenCalledWith('discord.message.bundled', expect.anything());
  });

  it('drops duplicate discord notifications by message id while in-flight and after completion', async () => {
    const harness = createHarness({
      handleMessage: async () => makeResponse('discord response'),
    });
    const message = makeMessage({
      id: 'msg-dup-1',
      channelId: 'discord:general',
      channelType: 'discord',
      routing: undefined,
    });

    await harness.onDiscordMessage(message);
    await harness.onDiscordMessage(message);

    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith('gateway.message.duplicate', {
      route: 'discord',
      channelId: 'discord:general',
      messageId: 'msg-dup-1',
      disposition: 'in_flight',
    });
    await vi.waitFor(() => {
      expect(harness.agentLoop.handleMessage).toHaveBeenCalledTimes(1);
      expect(harness.gateway.discordSend).toHaveBeenCalledTimes(1);
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.onDiscordMessage(message);

    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith('gateway.message.duplicate', {
      route: 'discord',
      channelId: 'discord:general',
      messageId: 'msg-dup-1',
      disposition: 'cached',
    });
  });

  it('reuses cached response for duplicate reverse-RPC handle messages', async () => {
    const harness = createHarness();
    const message = makeMessage({ id: 'msg-dup-2' });

    const first = await harness.onHandleMessage(message);
    const second = await harness.onHandleMessage(message);

    expect(first).toEqual(second);
    expect(harness.trackSessionActivity).toHaveBeenCalledTimes(1);
    expect(harness.agentLoop.handleMessage).toHaveBeenCalledTimes(1);
    expect(harness.shardManager.delegateSatelliteSession).not.toHaveBeenCalled();
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith('gateway.message.duplicate', {
      route: 'handle',
      channelId: message.channelId,
      messageId: 'msg-dup-2',
      disposition: 'cached',
    });
  });

  it('records observation-only reverse-RPC messages without generating a response', async () => {
    const harness = createHarness();
    const message = makeMessage({
      id: 'stimulus-observe-1',
      routing: {
        source: 'satellite',
        responseMode: 'observe',
      },
    });

    const response = await harness.onHandleMessage(message);

    expect(response.content).toBe('');
    expect(response.channelId).toBe(message.channelId);
    expect(harness.trackSessionActivity).toHaveBeenCalledWith(message);
    expect(harness.agentLoop.observeMessage).toHaveBeenCalledWith(message);
    expect(harness.agentLoop.handleMessage).not.toHaveBeenCalled();
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith('gateway.message.observed', {
      route: 'handle',
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.authorId,
    });
  });

  // ── Inter-companion channel lane (sprint 10, W6) ──

  function makeCompanionMessage(overrides?: Record<string, unknown>): SubstrateMessage {
    return makeMessage({
      id: 'cmsg-1',
      channelId: 'companion-room:living_room',
      channelType: 'companion',
      authorId: 'peer-companion-uuid',
      authorName: 'Nova',
      content: 'hello from a peer companion',
      isDirectMessage: false,
      routing: {
        source: 'companion',
        authorIsMachineIntelligence: true,
      },
      ...overrides,
    });
  }

  const ICP_A = '11111111-1111-4111-8111-111111111111';
  const ICP_B = '22222222-2222-4222-8222-222222222222';
  const ICP_CHANNEL = `companion-dm:${ICP_A}:${ICP_B}`;
  const ICP_CANDIDATE = '33333333-3333-4333-8333-333333333333';
  const inboundIcpCorrelation: IcpConversationCorrelation = {
    conversationId: '44444444-4444-4444-8444-444444444444',
    rootInitiationId: '99999999-9999-4999-8999-999999999999',
    initiatedByCompanionId: ICP_A,
    localCompanionId: ICP_A,
    peerCompanionId: ICP_B,
    peerContactId: 'contact-b',
    channelId: ICP_CHANNEL,
    turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7081',
    messageId: `icp-initiation:${ICP_CANDIDATE}`,
    requestId: `icp-initiation:${ICP_CANDIDATE}`,
    chargeLane: 'companion_social',
    surface: 'companion_dm',
    costPurpose: 'conversation_turn',
    costOriginStage: 'initiation',
    fatigueDecision: 'allow',
  };
  const INBOUND_ICP_MESSAGE_ID = deriveIcpTransportMessageId(inboundIcpCorrelation);
  const replyIcpCorrelation: IcpConversationCorrelation = {
    ...inboundIcpCorrelation,
    localCompanionId: ICP_B,
    peerCompanionId: ICP_A,
    peerContactId: 'contact-a',
    turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7082',
    messageId: INBOUND_ICP_MESSAGE_ID,
    requestId: INBOUND_ICP_MESSAGE_ID,
    costOriginStage: 'reply',
    fatigueDecision: 'not_evaluated',
  };

  function makeCorrelatedCompanionMessage(overrides?: Record<string, unknown>): SubstrateMessage {
    return makeCompanionMessage({
      id: INBOUND_ICP_MESSAGE_ID,
      channelId: ICP_CHANNEL,
      authorId: ICP_A,
      isDirectMessage: true,
      routing: {
        source: 'companion',
        authorIsMachineIntelligence: true,
        icpCorrelation: inboundIcpCorrelation,
      },
      ...overrides,
    });
  }

  function makeRecordedSource(
    message: SubstrateMessage,
    timestampMs = Date.parse('2026-03-02T00:00:00.000Z'),
  ): RecordedCompanionSourceMessage {
    return {
      channelId: message.channelId,
      sourceMessageId: message.id,
      content: message.content,
      authorId: message.authorId,
      authorName: message.authorName,
      timestampMs,
      ...(message.routing?.icpCorrelation
        ? { correlation: message.routing.icpCorrelation }
        : {}),
    };
  }

  it('delivery-gates a correlated companion reply and carries episode lineage', async () => {
    let postTurnStarted = 0;
    const reply = {
      ...makeResponse('correlated reply'),
      channelId: ICP_CHANNEL,
      metadata: {
        ...makeResponse('').metadata,
        turnId: replyIcpCorrelation.turnId,
        requestId: replyIcpCorrelation.requestId,
        icpCorrelation: replyIcpCorrelation,
      },
    };
    const harness = createHarness({
      config: { companionId: ICP_B } as SubstrateConfig,
      handleMessage: async (_message, lifecycle) => {
        if (!lifecycle) throw new Error('test expected delivery lifecycle');
        await lifecycle.finalizeDelivery(reply);
        postTurnStarted += 1;
        return reply;
      },
      companionSend: async channelId => ({
        channelId,
        messageId: 'companion-reply-delivered',
        deliveredTo: [ICP_A],
        skippedOffline: [],
      }),
    });

    await harness.onCompanionMessage(makeCorrelatedCompanionMessage());

    await vi.waitFor(() => expect(postTurnStarted).toBe(1));
    expect(harness.gateway.companionSend).toHaveBeenCalledWith(
      ICP_CHANNEL,
      'correlated reply',
      'Selene',
      replyIcpCorrelation,
    );
    expect(harness.agentLoop.recordIcpDeliveryObservation).toHaveBeenCalledWith(expect.objectContaining({
      channelId: ICP_CHANNEL,
      sourceMessageId: INBOUND_ICP_MESSAGE_ID,
      status: 'delivered',
      gatewayMessageId: 'companion-reply-delivered',
      deliveredTo: [ICP_A],
      turnCompleted: true,
    }));
  });

  it('persists a fresh fatigue-suppressed reply without an impossible prepared state', async () => {
    const suppressedCorrelation: IcpConversationCorrelation = {
      ...replyIcpCorrelation,
      fatigueDecision: 'suppress',
      fatigueReasonCode: 'fatigue_exhausted',
    };
    const suppressed = {
      ...makeResponse(''),
      channelId: ICP_CHANNEL,
      metadata: {
        ...makeResponse('').metadata,
        turnId: suppressedCorrelation.turnId,
        requestId: suppressedCorrelation.requestId,
        icpCorrelation: suppressedCorrelation,
      },
    };
    const harness = createHarness({
      config: { companionId: ICP_B } as SubstrateConfig,
      handleMessage: async (_message, lifecycle) => {
        if (!lifecycle) throw new Error('test expected delivery lifecycle');
        await lifecycle.finalizeDelivery(suppressed);
        return suppressed;
      },
    });

    await harness.onCompanionMessage(makeCorrelatedCompanionMessage());
    await vi.waitFor(() => {
      expect(harness.agentLoop.recordIcpDeliveryObservation).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'suppressed', turnCompleted: true }),
      );
    });
    expect(harness.agentLoop.recordIcpDeliveryObservation).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'prepared' }),
    );
    expect(harness.gateway.companionSend).not.toHaveBeenCalled();
    expect(harness.gateway.companionReportFailure).not.toHaveBeenCalled();
  });

  it('recovers a failed correlated reply after restart without another generated turn', async () => {
    const reply = {
      ...makeResponse('durable reply'),
      channelId: ICP_CHANNEL,
      metadata: {
        ...makeResponse('').metadata,
        turnId: replyIcpCorrelation.turnId,
        requestId: replyIcpCorrelation.requestId,
        icpCorrelation: replyIcpCorrelation,
      },
    };
    let firstPostTurnStarted = 0;
    const first = createHarness({
      config: { companionId: ICP_B } as SubstrateConfig,
      handleMessage: async (_message, lifecycle) => {
        if (!lifecycle) throw new Error('test expected delivery lifecycle');
        await lifecycle.finalizeDelivery(reply);
        firstPostTurnStarted += 1;
        return reply;
      },
      companionSend: async () => {
        throw new Error('peer route unavailable');
      },
    });

    await first.onCompanionMessage(makeCorrelatedCompanionMessage());
    await vi.waitFor(() => {
      expect(first.gateway.companionReportFailure).toHaveBeenCalledWith({
        channelId: ICP_CHANNEL,
        messageId: INBOUND_ICP_MESSAGE_ID,
        reason: 'reply_delivery_failed',
      });
    });
    expect(firstPostTurnStarted).toBe(0);
    const failedObservation = first.agentLoop.recordIcpDeliveryObservation.mock.calls.at(-1)?.[0];
    expect(failedObservation).toMatchObject({
      status: 'failed',
      recoveryResponse: reply,
    });

    let recoveredPostTurnStarted = 0;
    const restarted = createHarness({
      config: { companionId: ICP_B } as SubstrateConfig,
      findRecordedCompanionSourceMessage: async () => (
        makeRecordedSource(makeCorrelatedCompanionMessage())
      ),
      findRecordedIcpInitiation: async () => ({
        content: reply.content,
        correlation: replyIcpCorrelation,
        recoveryResponse: reply,
      }),
      findIcpDeliveryObservation: async () => failedObservation,
      handleMessage: async (_message, lifecycle) => {
        if (!lifecycle?.recoveredResponse) throw new Error('test expected recovered response');
        await lifecycle.finalizeDelivery(lifecycle.recoveredResponse);
        recoveredPostTurnStarted += 1;
        return lifecycle.recoveredResponse;
      },
      companionSend: async channelId => ({
        channelId,
        messageId: 'companion-reply-recovered',
        deliveredTo: [ICP_A],
        skippedOffline: [],
      }),
    });

    await restarted.onCompanionMessage(makeCorrelatedCompanionMessage({
      timestamp: '2026-03-02T05:00:00.000Z',
    }));

    expect(restarted.agentLoop.handleMessage).toHaveBeenCalledTimes(1);
    expect(recoveredPostTurnStarted).toBe(1);
    expect(restarted.gateway.companionSend).toHaveBeenCalledTimes(1);
    expect(restarted.agentLoop.recordIcpDeliveryObservation).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'delivered' }),
    );
  });

  it('recovers a pending reply from its assistant row when no delivery observation survived', async () => {
    const reply = {
      ...makeResponse('assistant-row reply'),
      channelId: ICP_CHANNEL,
      metadata: {
        ...makeResponse('').metadata,
        turnId: replyIcpCorrelation.turnId,
        requestId: replyIcpCorrelation.requestId,
        icpCorrelation: replyIcpCorrelation,
      },
    };
    let recoveredPostTurnStarted = 0;
    const restarted = createHarness({
      config: { companionId: ICP_B } as SubstrateConfig,
      findRecordedCompanionSourceMessage: async () => (
        makeRecordedSource(makeCorrelatedCompanionMessage())
      ),
      findRecordedIcpInitiation: async () => ({
        content: reply.content,
        correlation: replyIcpCorrelation,
        recoveryResponse: reply,
      }),
      findIcpDeliveryObservation: async () => null,
      handleMessage: async (_message, lifecycle) => {
        if (!lifecycle?.recoveredResponse) throw new Error('test expected assistant-row recovery');
        await lifecycle.finalizeDelivery(lifecycle.recoveredResponse);
        recoveredPostTurnStarted += 1;
        return lifecycle.recoveredResponse;
      },
      companionSend: async channelId => ({
        channelId,
        messageId: 'companion-reply-stable-recovery',
        deliveredTo: [ICP_A],
        skippedOffline: [],
      }),
    });

    await restarted.onCompanionMessage(makeCorrelatedCompanionMessage({
      timestamp: '2026-03-02T05:00:00.000Z',
    }));

    expect(restarted.agentLoop.handleMessage).toHaveBeenCalledTimes(1);
    expect(recoveredPostTurnStarted).toBe(1);
    expect(restarted.gateway.companionSend).toHaveBeenCalledTimes(1);
    expect(restarted.agentLoop.recordIcpDeliveryObservation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'delivered', turnCompleted: true }),
    );
    const handled = restarted.agentLoop.handleMessage.mock.calls[0][0] as SubstrateMessage;
    expect(handled.timestamp).toEqual(new Date('2026-03-02T00:00:00.000Z'));
  });

  it.each([
    ['conversation', {
      conversationId: '55555555-5555-4555-8555-555555555555',
    }],
    ['root initiation', {
      rootInitiationId: '88888888-8888-4888-8888-888888888888',
    }],
    ['initiator', { initiatedByCompanionId: ICP_B }],
    ['participant inversion', {
      localCompanionId: ICP_A,
      peerCompanionId: ICP_B,
    }],
    ['episode origin', { costOriginStage: 'maintenance' }],
  ])('rejects a restart recovery transplanted onto another %s lineage', async (_label, changes) => {
    const transplantedCorrelation = { ...replyIcpCorrelation, ...changes };
    const transplantedResponse = {
      ...makeResponse('transplanted reply'),
      channelId: ICP_CHANNEL,
      metadata: {
        ...makeResponse('').metadata,
        turnId: transplantedCorrelation.turnId,
        requestId: transplantedCorrelation.requestId,
        icpCorrelation: transplantedCorrelation,
      },
    };
    const restarted = createHarness({
      config: { companionId: ICP_B } as SubstrateConfig,
      findRecordedCompanionSourceMessage: async () => (
        makeRecordedSource(makeCorrelatedCompanionMessage())
      ),
      findRecordedIcpInitiation: async () => ({
        content: transplantedResponse.content,
        correlation: transplantedCorrelation,
        recoveryResponse: transplantedResponse,
      }),
    });

    await expect(restarted.onCompanionMessage(makeCorrelatedCompanionMessage({
      timestamp: '2026-03-02T05:00:00.000Z',
    }))).rejects.toThrow(/durable inbound episode lineage/i);
    expect(restarted.agentLoop.handleMessage).not.toHaveBeenCalled();
    expect(restarted.gateway.companionSend).not.toHaveBeenCalled();
  });

  it.each([
    ['suppressed content', {
      status: 'suppressed',
      correlation: replyIcpCorrelation,
      content: 'forged suppressed reply',
      expectedError: /suppressed recovery contains a deliverable response/i,
    }],
    ['delivered transport content', {
      status: 'delivered',
      correlation: replyIcpCorrelation,
      content: ' \n\t ',
      expectedError: /delivered recovery is missing transport content/i,
    }],
    ['failed transport content', {
      status: 'failed',
      correlation: replyIcpCorrelation,
      content: ' \n\t ',
      expectedError: /failed recovery is missing transport content/i,
    }],
  ])('rejects contradictory recovery %s before execution', async (_label, fixture) => {
    const response = {
      ...makeResponse(fixture.content),
      channelId: ICP_CHANNEL,
      metadata: {
        ...makeResponse('').metadata,
        turnId: fixture.correlation.turnId,
        requestId: fixture.correlation.requestId,
        icpCorrelation: fixture.correlation,
      },
    };
    const restarted = createHarness({
      config: { companionId: ICP_B } as SubstrateConfig,
      findRecordedCompanionSourceMessage: async () => (
        makeRecordedSource(makeCorrelatedCompanionMessage())
      ),
      findIcpDeliveryObservation: async () => ({
        channelId: ICP_CHANNEL,
        sourceMessageId: INBOUND_ICP_MESSAGE_ID,
        status: fixture.status,
        recoveryResponse: response,
      }),
    });

    await expect(restarted.onCompanionMessage(makeCorrelatedCompanionMessage({
      timestamp: '2026-03-02T05:00:00.000Z',
    }))).rejects.toThrow(fixture.expectedError);
    expect(restarted.agentLoop.handleMessage).not.toHaveBeenCalled();
    expect(restarted.gateway.companionSend).not.toHaveBeenCalled();
  });

  it('completes a delivered restart replay from its durable response without resending', async () => {
    const reply = {
      ...makeResponse('already delivered reply'),
      channelId: ICP_CHANNEL,
      metadata: {
        ...makeResponse('').metadata,
        turnId: replyIcpCorrelation.turnId,
        requestId: replyIcpCorrelation.requestId,
        icpCorrelation: replyIcpCorrelation,
      },
    };
    const deliveredObservation = {
      channelId: ICP_CHANNEL,
      sourceMessageId: INBOUND_ICP_MESSAGE_ID,
      status: 'delivered' as const,
      gatewayMessageId: 'already-delivered-message',
      deliveredTo: [ICP_A],
      recoveryResponse: reply,
    };
    const restarted = createHarness({
      config: { companionId: ICP_B } as SubstrateConfig,
      findRecordedCompanionSourceMessage: async () => (
        makeRecordedSource(makeCorrelatedCompanionMessage())
      ),
      findIcpDeliveryObservation: async () => deliveredObservation,
      handleMessage: async (_message, lifecycle) => {
        expect(lifecycle?.recoveredResponse).toEqual(reply);
        await lifecycle?.finalizeDelivery(reply);
        return reply;
      },
    });

    await restarted.onCompanionMessage(makeCorrelatedCompanionMessage({
      timestamp: '2026-03-02T05:00:00.000Z',
    }));

    expect(restarted.gateway.companionSend).not.toHaveBeenCalled();
    expect(restarted.agentLoop.recordIcpDeliveryObservation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'delivered',
        gatewayMessageId: 'already-delivered-message',
        turnCompleted: true,
      }),
    );
  });

  it('recovers a durably suppressed turn without regenerating or sending a reply', async () => {
    const suppressed = {
      ...makeResponse(''),
      channelId: ICP_CHANNEL,
      metadata: {
        ...makeResponse('').metadata,
        turnId: replyIcpCorrelation.turnId,
        requestId: replyIcpCorrelation.requestId,
        icpCorrelation: replyIcpCorrelation,
        noReply: {
          schemaVersion: 1 as const,
          disposition: 'intentional_no_reply' as const,
          source: 'response_control_tool' as const,
          auditId: 'no-reply-restart',
          decidedAt: Date.parse('2026-03-02T00:00:00.000Z'),
          turnId: replyIcpCorrelation.turnId as TurnID,
          requestId: replyIcpCorrelation.requestId,
          channelId: ICP_CHANNEL,
        },
      },
    };
    const restarted = createHarness({
      config: { companionId: ICP_B } as SubstrateConfig,
      findRecordedCompanionSourceMessage: async () => (
        makeRecordedSource(makeCorrelatedCompanionMessage())
      ),
      findIcpDeliveryObservation: async () => ({
        channelId: ICP_CHANNEL,
        sourceMessageId: INBOUND_ICP_MESSAGE_ID,
        status: 'suppressed',
        recoveryResponse: suppressed,
      }),
      handleMessage: async (_message, lifecycle) => {
        expect(lifecycle?.recoveredResponse).toEqual(suppressed);
        await lifecycle?.finalizeDelivery(suppressed);
        return suppressed;
      },
    });

    await restarted.onCompanionMessage(makeCorrelatedCompanionMessage({
      timestamp: '2026-03-02T05:00:00.000Z',
    }));

    expect(restarted.agentLoop.handleMessage).toHaveBeenCalledOnce();
    expect(restarted.gateway.companionSend).not.toHaveBeenCalled();
    expect(restarted.agentLoop.recordIcpDeliveryObservation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'suppressed', turnCompleted: true }),
    );
  });

  it('resumes a correlated turn when only the inbound source row survived the crash', async () => {
    const reply = {
      ...makeResponse('reply after source-only recovery'),
      channelId: ICP_CHANNEL,
      metadata: {
        ...makeResponse('').metadata,
        turnId: replyIcpCorrelation.turnId,
        requestId: replyIcpCorrelation.requestId,
        icpCorrelation: replyIcpCorrelation,
      },
    };
    const restarted = createHarness({
      config: { companionId: ICP_B } as SubstrateConfig,
      findRecordedCompanionSourceMessage: async () => (
        makeRecordedSource(makeCorrelatedCompanionMessage())
      ),
      findRecordedIcpInitiation: async () => null,
      handleMessage: async (_message, lifecycle) => {
        expect(lifecycle?.sourceAlreadyPersisted).toBe(true);
        if (!lifecycle) throw new Error('test expected delivery lifecycle');
        await lifecycle.finalizeDelivery(reply);
        return reply;
      },
      companionSend: async channelId => ({
        channelId,
        messageId: 'companion-reply-source-only-recovery',
        deliveredTo: [ICP_A],
        skippedOffline: [],
      }),
    });

    await restarted.onCompanionMessage(makeCorrelatedCompanionMessage({
      timestamp: '2026-03-02T05:00:00.000Z',
      attachments: [{
        url: 'https://example.invalid/replay-only.png',
        contentType: 'image/png',
        name: 'replay-only.png',
      }],
    }));

    expect(restarted.agentLoop.handleMessage).toHaveBeenCalledTimes(1);
    expect(restarted.gateway.companionSend).toHaveBeenCalledTimes(1);
    expect(restarted.agentLoop.recordIcpDeliveryObservation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'delivered', turnCompleted: true }),
    );
    const handled = restarted.agentLoop.handleMessage.mock.calls[0][0] as SubstrateMessage;
    expect(handled.timestamp).toEqual(new Date('2026-03-02T00:00:00.000Z'));
    expect(handled).toMatchObject({
      channelType: 'companion',
      isDirectMessage: true,
      routing: {
        source: 'companion',
        authorIsMachineIntelligence: true,
        icpCorrelation: inboundIcpCorrelation,
      },
    });
    expect(Object.keys(handled.routing ?? {}).sort()).toEqual([
      'authorIsMachineIntelligence',
      'icpCorrelation',
      'source',
    ]);
    expect(handled.attachments).toBeUndefined();
  });

  it('rejects a restart replay whose stable source id carries a changed durable envelope', async () => {
    const original = makeCorrelatedCompanionMessage();
    const harness = createHarness({
      config: { companionId: ICP_B } as SubstrateConfig,
      findRecordedCompanionSourceMessage: async () => makeRecordedSource(original),
    });

    await harness.onCompanionMessage(makeCorrelatedCompanionMessage({
      content: 'changed after gateway restart',
      timestamp: '2026-03-02T05:00:00.000Z',
    }));

    expect(harness.agentLoop.handleMessage).not.toHaveBeenCalled();
    expect(harness.gateway.companionReportFailure).toHaveBeenCalledWith({
      channelId: ICP_CHANNEL,
      messageId: INBOUND_ICP_MESSAGE_ID,
      reason: 'processing_failed',
    });
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith(
      'companion.message.durable_dedupe_error',
      expect.objectContaining({
        channelId: ICP_CHANNEL,
        messageId: INBOUND_ICP_MESSAGE_ID,
        error: 'Companion replay envelope does not match its durable source entry',
      }),
    );
  });

  it.each([
    ['channel type', { channelType: 'api' }],
    ['DM flag', { isDirectMessage: false }],
    ['routing source', {
      routing: {
        source: 'api',
        authorIsMachineIntelligence: true,
        icpCorrelation: inboundIcpCorrelation,
      },
    }],
    ['machine-intelligence identity', {
      routing: {
        source: 'companion',
        authorIsMachineIntelligence: false,
        icpCorrelation: inboundIcpCorrelation,
      },
    }],
    ['ICP correlation', {
      routing: {
        source: 'companion',
        authorIsMachineIntelligence: true,
      },
    }],
    ['extra trust routing', {
      routing: {
        source: 'companion',
        authorIsMachineIntelligence: true,
        channelPrivacy: 'public',
        canonicalContactId: 'wrong-contact',
        icpCorrelation: inboundIcpCorrelation,
      },
    }],
  ])('rejects restart replay with changed canonical %s', async (_label, overrides) => {
    const original = makeCorrelatedCompanionMessage();
    const harness = createHarness({
      config: { companionId: ICP_B } as SubstrateConfig,
      findRecordedCompanionSourceMessage: async () => makeRecordedSource(original),
    });

    await harness.onCompanionMessage(makeCorrelatedCompanionMessage({
      ...overrides,
      timestamp: '2026-03-02T05:00:00.000Z',
    }));

    expect(harness.agentLoop.handleMessage).not.toHaveBeenCalled();
    expect(harness.gateway.companionReportFailure).toHaveBeenCalledWith({
      channelId: ICP_CHANNEL,
      messageId: INBOUND_ICP_MESSAGE_ID,
      reason: 'processing_failed',
    });
  });

  it('owns a correlated envelope before awaiting durable recovery state', async () => {
    const durableLookup = createDeferred<RecordedCompanionSourceMessage | null>();
    const reply = {
      ...makeResponse('single raced reply'),
      channelId: ICP_CHANNEL,
      metadata: {
        ...makeResponse('').metadata,
        turnId: replyIcpCorrelation.turnId,
        requestId: replyIcpCorrelation.requestId,
        icpCorrelation: replyIcpCorrelation,
      },
    };
    const harness = createHarness({
      config: { companionId: ICP_B } as SubstrateConfig,
      findRecordedCompanionSourceMessage: async () => await durableLookup.promise,
      handleMessage: async (_message, lifecycle) => {
        if (!lifecycle) throw new Error('test expected delivery lifecycle');
        await lifecycle.finalizeDelivery(reply);
        return reply;
      },
      companionSend: async channelId => ({
        channelId,
        messageId: 'companion-reply-race-owner',
        deliveredTo: [ICP_A],
        skippedOffline: [],
      }),
    });

    const first = harness.onCompanionMessage(makeCorrelatedCompanionMessage());
    await Promise.resolve();
    await Promise.resolve();
    await harness.onCompanionMessage(makeCorrelatedCompanionMessage());
    expect(harness.agentLoop.findRecordedCompanionSourceMessage).toHaveBeenCalledTimes(1);

    durableLookup.resolve(null);
    await first;
    await vi.waitFor(() => expect(harness.agentLoop.handleMessage).toHaveBeenCalledTimes(1));
    expect(harness.gateway.companionSend).toHaveBeenCalledTimes(1);
  });

  it('runs companion messages through the normal turn pipeline and replies via the companion lane', async () => {
    const harness = createHarness({
      handleMessage: async () => makeResponse('companion reply'),
    });
    const message = makeCompanionMessage({
      timestamp: '2026-03-02T02:00:00.000Z',
      replyToMessageId: 'cmsg-opening',
      routing: {
        source: 'companion',
        authorIsMachineIntelligence: true,
        channelPrivacy: 'private',
        room: { placeId: 'living_room', privacy: 'private' },
      },
    });

    await harness.onCompanionMessage(message);

    await vi.waitFor(() => {
      expect(harness.agentLoop.handleMessage).toHaveBeenCalledTimes(1);
      expect(harness.gateway.companionSend).toHaveBeenCalledWith(
        'companion-room:living_room',
        'companion reply',
        'Selene',
        'cmsg-1',
      );
    });
    // Timestamp deserialized before the turn pipeline sees it.
    const handled = harness.agentLoop.handleMessage.mock.calls[0][0] as SubstrateMessage;
    expect(handled.timestamp).toBeInstanceOf(Date);
    expect(handled.replyToMessageId).toBe('cmsg-opening');
    expect(handled.routing).toMatchObject({
      channelPrivacy: 'private',
      room: { placeId: 'living_room', privacy: 'private' },
    });
    expect(harness.trackSessionActivity).toHaveBeenCalledTimes(1);
    // The reply never leaks onto another channel surface.
    expect(harness.gateway.discordSend).not.toHaveBeenCalled();
  });

  it('sends nothing when the turn produces empty content (fatigue suppression terminates the exchange)', async () => {
    const harness = createHarness({
      handleMessage: async () => makeResponse(''),
    });

    await harness.onCompanionMessage(makeCompanionMessage());

    await vi.waitFor(() => {
      expect(harness.agentLoop.handleMessage).toHaveBeenCalledTimes(1);
    });
    expect(harness.gateway.companionSend).not.toHaveBeenCalled();

    await harness.onCompanionMessage(makeCompanionMessage());
    expect(harness.agentLoop.handleMessage).toHaveBeenCalledTimes(1);
  });

  it('drops duplicate companion notifications and audits the disposition', async () => {
    const gate = createDeferred<AgentResponse>();
    const harness = createHarness({
      handleMessage: async () => gate.promise,
    });
    const message = makeCompanionMessage({ id: 'cmsg-dup' });

    await harness.onCompanionMessage(message);
    await harness.onCompanionMessage(message);

    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith('gateway.message.duplicate', {
      route: 'companion',
      channelId: message.channelId,
      messageId: 'cmsg-dup',
      disposition: 'in_flight',
    });
    gate.resolve(makeResponse('late reply'));
    await vi.waitFor(() => {
      expect(harness.agentLoop.handleMessage).toHaveBeenCalledTimes(1);
      expect(harness.gateway.companionSend).toHaveBeenCalledTimes(1);
    });

    await harness.onCompanionMessage(message);
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith('gateway.message.duplicate', {
      route: 'companion',
      channelId: message.channelId,
      messageId: 'cmsg-dup',
      disposition: 'cached',
    });
    expect(harness.agentLoop.handleMessage).toHaveBeenCalledTimes(1);
  });

  it('drops a gateway replay already present in durable recipient L0 after restart', async () => {
    const message = makeCompanionMessage({ id: 'companion-initiation-restart-safe' });
    const harness = createHarness({
      findRecordedCompanionSourceMessage: async (_channelId, sourceMessageId) => (
        sourceMessageId === message.id ? makeRecordedSource(message) : null
      ),
    });

    await harness.onCompanionMessage(message);

    expect(harness.agentLoop.handleMessage).not.toHaveBeenCalled();
    expect(harness.gateway.companionSend).not.toHaveBeenCalled();
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith('gateway.message.duplicate', {
      route: 'companion',
      channelId: message.channelId,
      messageId: 'companion-initiation-restart-safe',
      disposition: 'durable',
    });
  });

  it('reports a deterministic failure when durable companion dedupe cannot be read', async () => {
    const harness = createHarness({
      findRecordedCompanionSourceMessage: async () => {
        throw new Error('journal unavailable');
      },
    });
    const message = makeCompanionMessage({ id: 'companion-dedupe-read-failure' });

    await harness.onCompanionMessage(message);

    expect(harness.agentLoop.handleMessage).not.toHaveBeenCalled();
    expect(harness.gateway.companionSend).not.toHaveBeenCalled();
    expect(harness.gateway.companionReportFailure).toHaveBeenCalledWith({
      channelId: 'companion-room:living_room',
      messageId: 'companion-dedupe-read-failure',
      reason: 'processing_failed',
    });
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith(
      'companion.message.durable_dedupe_error',
      {
        channelId: 'companion-room:living_room',
        messageId: 'companion-dedupe-read-failure',
        error: 'journal unavailable',
      },
    );
  });

  it('reports companion turn failures and keeps the source message retryable', async () => {
    const handleMessage = vi.fn()
      .mockRejectedValueOnce(new Error('turn exploded'))
      .mockResolvedValueOnce(makeResponse(''));
    const harness = createHarness({
      handleMessage,
    });
    const message = makeCompanionMessage({ id: 'cmsg-err' });

    await harness.onCompanionMessage(message);

    await vi.waitFor(() => {
      expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith('companion.message.error', {
        channelId: 'companion-room:living_room',
        messageId: 'cmsg-err',
        error: 'turn exploded',
        reason: 'processing_failed',
      });
    });
    expect(harness.gateway.companionReportFailure).toHaveBeenCalledWith({
      channelId: 'companion-room:living_room',
      messageId: 'cmsg-err',
      reason: 'processing_failed',
    });

    await harness.onCompanionMessage(message);
    await vi.waitFor(() => {
      expect(handleMessage).toHaveBeenCalledTimes(2);
    });
  });

  it('reports companion reply delivery failures without sending conversational error text', async () => {
    const harness = createHarness({
      handleMessage: async () => makeResponse('reply that cannot be delivered'),
      companionSend: async () => {
        throw new Error('peer route unavailable');
      },
    });

    await harness.onCompanionMessage(makeCompanionMessage({ id: 'cmsg-send-err' }));

    await vi.waitFor(() => {
      expect(harness.gateway.companionReportFailure).toHaveBeenCalledWith({
        channelId: 'companion-room:living_room',
        messageId: 'cmsg-send-err',
        reason: 'reply_delivery_failed',
      });
    });
    expect(harness.gateway.companionSend).toHaveBeenCalledTimes(1);
  });

  it('records companion delivery failures as system observations without a reply turn', async () => {
    const harness = createHarness();
    const notification: CompanionMessageDeliveryFailureNotification = {
      channelId: 'companion-room:living_room',
      messageId: 'cmsg-origin',
      reportingCompanionId: 'comp-b',
      reason: 'processing_failed',
      reportedAt: '2026-07-09T18:00:00.000Z',
    };

    await harness.onCompanionDeliveryFailure(notification);

    expect(harness.agentLoop.handleMessage).not.toHaveBeenCalled();
    expect(harness.agentLoop.observeMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 'companion-delivery-failure:cmsg-origin:comp-b',
      channelId: 'companion-room:living_room',
      channelType: 'companion',
      authorId: 'system:companion-delivery',
      routing: {
        source: 'companion',
        responseMode: 'observe',
      },
    }));
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith(
      'companion.message.delivery_failed',
      notification,
    );
  });
});

describe('registerGatewayMessageHandlers — participation appraiser wiring (jp36.3.3.1)', () => {
  const CHANNEL = 'discord:general';

  function makeParticipationCandidate(
    overrides: Partial<ParticipationCandidate> = {},
  ): ParticipationCandidate {
    return {
      schemaVersion: 1,
      channelId: CHANNEL,
      channelType: 'discord',
      sourceMessageId: 'discord-observe-participation-1',
      trigger: 'passive_name',
      triggerAuthorId: 'human-alice',
      triggerAuthorName: 'Alice',
      triggerContent: 'I wonder what Selene thinks about that',
      triggerTimestampMs: 1_000_000,
      matchedName: true,
      matchedDirectAddress: false,
      precedingContext: [],
      createdAtMs: 1_000_001,
      ...overrides,
    };
  }

  function createdBuilder(candidate: ParticipationCandidate): PassiveNameCandidatePort {
    return { build: vi.fn(async () => ({ status: 'created' as const, candidate })) };
  }

  function observeMessage() {
    return makeMessage({
      id: 'discord-observe-participation-1',
      channelId: CHANNEL,
      channelType: 'discord',
      timestamp: '2026-03-02T02:00:00.000Z',
      routing: { source: 'discord', responseMode: 'observe' },
    });
  }

  it('appraises a created candidate and emits the typed bus event plus completed audit', async () => {
    const candidate = makeParticipationCandidate();
    const appraiser: ParticipationAppraiserPort = {
      appraise: vi.fn(async (): Promise<ParticipationAppraisalResult> => ({
        appraisal: { action: 'reply', reasonCode: 'asked_directly', confidence: 0.72 },
        failClosed: false,
      })),
    };
    const harness = createHarness({
      passiveNameCandidateBuilder: createdBuilder(candidate),
      participationAppraiser: appraiser,
    });
    const events: unknown[] = [];
    harness.eventBus.on('participation.appraisal', (event) => {
      events.push(event);
    });

    await harness.onDiscordMessage(observeMessage());

    // The candidate is routed through the appraiser on the real observe path...
    expect(appraiser.appraise).toHaveBeenCalledWith(candidate);
    // ...the observe path itself still runs (participation never replaces it)...
    expect(harness.agentLoop.observeMessage).toHaveBeenCalledTimes(1);
    expect(harness.agentLoop.handleMessage).not.toHaveBeenCalled();
    // ...a content-free completed audit record is appended...
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith(
      'participation.appraisal.completed',
      {
        channelId: CHANNEL,
        sourceMessageId: 'discord-observe-participation-1',
        trigger: 'passive_name',
        action: 'reply',
        reasonCode: 'asked_directly',
        confidence: 0.72,
        failClosed: false,
      },
    );
    // ...and the typed bus event carries exactly the ternary decision.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channelId: CHANNEL,
      sourceMessageId: 'discord-observe-participation-1',
      trigger: 'passive_name',
      action: 'reply',
      reasonCode: 'asked_directly',
      confidence: 0.72,
      failClosed: false,
    });
    expect(events[0]).toHaveProperty('timestamp');
  });

  it('records a fail-closed appraisal on the audit trail and bus (no reply invented)', async () => {
    const candidate = makeParticipationCandidate();
    const appraiser: ParticipationAppraiserPort = {
      appraise: vi.fn(async (): Promise<ParticipationAppraisalResult> => ({
        appraisal: { action: 'ignore', reasonCode: 'appraiser_timeout', confidence: 0 },
        failClosed: true,
        failClosedReason: 'appraiser_timeout',
      })),
    };
    const harness = createHarness({
      passiveNameCandidateBuilder: createdBuilder(candidate),
      participationAppraiser: appraiser,
    });
    const events: { failClosed: boolean; action: string }[] = [];
    harness.eventBus.on('participation.appraisal', (event) => {
      events.push(event as { failClosed: boolean; action: string });
    });

    await harness.onDiscordMessage(observeMessage());

    // The fail-closed degradation is recorded content-free, with its reason.
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith(
      'participation.appraisal.completed',
      {
        channelId: CHANNEL,
        sourceMessageId: 'discord-observe-participation-1',
        trigger: 'passive_name',
        action: 'ignore',
        reasonCode: 'appraiser_timeout',
        confidence: 0,
        failClosed: true,
        failClosedReason: 'appraiser_timeout',
      },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'ignore', failClosed: true });
    // A fail-closed appraisal never routes a reply through the response path.
    expect(harness.agentLoop.handleMessage).not.toHaveBeenCalled();
  });

  it('never lets an appraiser throw break message observation (belt-and-braces catch)', async () => {
    const candidate = makeParticipationCandidate();
    const appraiser: ParticipationAppraiserPort = {
      appraise: vi.fn(async () => {
        throw new Error('appraiser exploded with untrusted echo');
      }),
    };
    const harness = createHarness({
      passiveNameCandidateBuilder: createdBuilder(candidate),
      participationAppraiser: appraiser,
    });
    const events: unknown[] = [];
    harness.eventBus.on('participation.appraisal', (event) => {
      events.push(event);
    });

    // The observe handler must resolve, not reject, even though the appraiser threw.
    await expect(harness.onDiscordMessage(observeMessage())).resolves.toBeUndefined();

    // Observation still completed for the message.
    expect(harness.agentLoop.observeMessage).toHaveBeenCalledTimes(1);
    // The error is recorded as a distinct audit event; no completed record, no bus event.
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith(
      'participation.appraisal.error',
      expect.objectContaining({
        channelId: CHANNEL,
        sourceMessageId: 'discord-observe-participation-1',
        trigger: 'passive_name',
      }),
    );
    expect(harness.safeguardAuditTrail.append).not.toHaveBeenCalledWith(
      'participation.appraisal.completed',
      expect.anything(),
    );
    expect(events).toHaveLength(0);
  });

  it('does not appraise when a candidate is suppressed by the passive-name gate', async () => {
    const appraiser: ParticipationAppraiserPort = {
      appraise: vi.fn(async (): Promise<ParticipationAppraisalResult> => ({
        appraisal: { action: 'ignore', reasonCode: 'x', confidence: 0 },
        failClosed: false,
      })),
    };
    const suppressingBuilder: PassiveNameCandidatePort = {
      build: vi.fn(async () => ({
        status: 'suppressed' as const,
        reason: 'not_group' as const,
        channelId: CHANNEL,
        sourceMessageId: 'discord-observe-participation-1',
      })),
    };
    const harness = createHarness({
      passiveNameCandidateBuilder: suppressingBuilder,
      participationAppraiser: appraiser,
    });

    await harness.onDiscordMessage(observeMessage());

    expect(appraiser.appraise).not.toHaveBeenCalled();
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith(
      'participation.candidate.suppressed',
      expect.objectContaining({ reason: 'not_group' }),
    );
  });

  it('emits a content-free participation.candidate created bus event (jp36.8.3)', async () => {
    const candidate = makeParticipationCandidate();
    const harness = createHarness({
      passiveNameCandidateBuilder: createdBuilder(candidate),
    });
    const events: unknown[] = [];
    harness.eventBus.on('participation.candidate', (event) => {
      events.push(event);
    });

    await harness.onDiscordMessage(observeMessage());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channelId: CHANNEL,
      sourceMessageId: 'discord-observe-participation-1',
      outcome: 'created',
      trigger: 'passive_name',
      matchedDirectAddress: false,
      precedingContextCount: 0,
    });
    expect(events[0]).toHaveProperty('timestamp');
    // §19 do-not-log: no matched-name string, trigger text, or author name leaks.
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('Selene');
    expect(serialized).not.toContain('Alice');
    expect(serialized).not.toContain('I wonder what');
    expect(serialized).not.toContain('matchedName');
  });

  it('emits a participation.candidate suppressed bus event with the reason enum only', async () => {
    const suppressingBuilder: PassiveNameCandidatePort = {
      build: vi.fn(async () => ({
        status: 'suppressed' as const,
        reason: 'not_group' as const,
        channelId: CHANNEL,
        sourceMessageId: 'discord-observe-participation-1',
        trigger: 'passive_name' as const,
      })),
    };
    const harness = createHarness({ passiveNameCandidateBuilder: suppressingBuilder });
    const events: { outcome: string; suppressionReason?: string }[] = [];
    harness.eventBus.on('participation.candidate', (event) => {
      events.push(event as { outcome: string; suppressionReason?: string });
    });

    await harness.onDiscordMessage(observeMessage());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'suppressed',
      suppressionReason: 'not_group',
      trigger: 'passive_name',
    });
    // A suppressed candidate never carries a created-only field.
    expect(events[0]).not.toHaveProperty('precedingContextCount');
  });

  it('emits a content-free participation.candidate error event when the gate throws', async () => {
    const throwingBuilder: PassiveNameCandidatePort = {
      build: vi.fn(async () => {
        throw new Error('builder exploded with untrusted room echo: I wonder what Selene thinks');
      }),
    };
    const harness = createHarness({ passiveNameCandidateBuilder: throwingBuilder });
    const events: unknown[] = [];
    harness.eventBus.on('participation.candidate', (event) => {
      events.push(event);
    });

    // The observe handler must resolve, not reject, even though the gate threw.
    await expect(harness.onDiscordMessage(observeMessage())).resolves.toBeUndefined();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'error' });
    // The forensic error text stays on the audit trail, never the typed bus event.
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('Selene');
    expect(serialized).not.toContain('exploded');
    expect(serialized).not.toContain('untrusted');
  });
});

describe('registerGatewayMessageHandlers — reservation phase wiring (jp36.5.1.2)', () => {
  const CHANNEL = 'discord:general';
  const SOURCE_MESSAGE_ID = 'discord-observe-reservation-1';

  function makeCandidate(): ParticipationCandidate {
    return {
      schemaVersion: 1,
      channelId: CHANNEL,
      channelType: 'discord',
      sourceMessageId: SOURCE_MESSAGE_ID,
      trigger: 'passive_name',
      triggerAuthorId: 'human-alice',
      triggerAuthorName: 'Alice',
      triggerContent: 'I wonder what Selene thinks',
      triggerTimestampMs: 1_000_000,
      matchedName: true,
      matchedDirectAddress: false,
      precedingContext: [],
      createdAtMs: 1_000_001,
    };
  }

  function createdBuilder(candidate: ParticipationCandidate): PassiveNameCandidatePort {
    return { build: vi.fn(async () => ({ status: 'created' as const, candidate })) };
  }

  function observeMessage() {
    return makeMessage({
      id: SOURCE_MESSAGE_ID,
      channelId: CHANNEL,
      channelType: 'discord',
      timestamp: '2026-03-02T02:00:00.000Z',
      routing: { source: 'discord', responseMode: 'observe' },
    });
  }

  function makeReservationSnapshot(): SpeakingReservationSnapshot {
    return {
      reservationId: '99999999-9999-4999-8999-999999999999',
      channelId: CHANNEL,
      triggerEventId: SOURCE_MESSAGE_ID,
      companionId: '11111111-1111-4111-8111-111111111111',
      episodeId: 'episode-1',
      reservedAtMs: 1_000_100,
      expiresAtMs: 1_120_100,
      status: 'reserved',
      reason: null,
      finalizedAtMs: null,
      revision: 1,
    };
  }

  function makeEpisodeSnapshot(): RoomEpisodeSnapshot {
    return {
      episodeId: 'episode-1',
      channelId: CHANNEL,
      status: 'open',
      pressure: 0,
      openedAtMs: 1_000_000,
      lastActivityAtMs: 1_000_100,
      consecutiveAutonomousTurns: 0,
      lastSpeakerCompanionId: null,
      revision: 1,
      participants: [],
    };
  }

  function replyingAppraiser(action: 'ignore' | 'react' | 'reply'): ParticipationAppraiserPort {
    return {
      appraise: vi.fn(async (): Promise<ParticipationAppraisalResult> => ({
        appraisal:
          action === 'react'
            ? { action, reasonCode: 'ack', confidence: 0.5, reactionClass: 'acknowledge' }
            : { action, reasonCode: 'r', confidence: 0.6 },
        failClosed: false,
      })),
    };
  }

  it('gates a candidate before appraisal so the appraiser model never runs', async () => {
    const appraiser = replyingAppraiser('reply');
    const reservationPhase: ReservationPhasePort = {
      reserve: vi.fn(async (): Promise<ReservationDecision> => ({
        outcome: 'gated',
        blockedBy: 'fatigue_pot_insufficient',
      })),
      settleAfterAppraisal: vi.fn(),
      releaseIgnored: vi.fn(),
    };
    const harness = createHarness({
      passiveNameCandidateBuilder: createdBuilder(makeCandidate()),
      participationAppraiser: appraiser,
      reservationPhase,
    });

    await harness.onDiscordMessage(observeMessage());

    // The gate ran with the candidate's room event...
    expect(reservationPhase.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: CHANNEL, triggerEventId: SOURCE_MESSAGE_ID }),
    );
    // ...and a gated candidate NEVER reaches the appraiser's model call.
    expect(appraiser.appraise).not.toHaveBeenCalled();
    expect(reservationPhase.settleAfterAppraisal).not.toHaveBeenCalled();
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith(
      'participation.reservation.gated',
      expect.objectContaining({
        channelId: CHANNEL,
        sourceMessageId: SOURCE_MESSAGE_ID,
        blockedBy: 'fatigue_pot_insufficient',
      }),
    );
    // Observation itself still ran.
    expect(harness.agentLoop.observeMessage).toHaveBeenCalledTimes(1);
  });

  it('reserves, appraises, and releases the reservation on an ignore outcome', async () => {
    const reservation = makeReservationSnapshot();
    const appraiser = replyingAppraiser('ignore');
    const reservationPhase: ReservationPhasePort = {
      reserve: vi.fn(async (): Promise<ReservationDecision> => ({
        outcome: 'reserved',
        reservation,
        episode: makeEpisodeSnapshot(),
        replayed: false,
      })),
      settleAfterAppraisal: vi.fn(async () => 'released' as const),
      releaseIgnored: vi.fn(),
    };
    const harness = createHarness({
      passiveNameCandidateBuilder: createdBuilder(makeCandidate()),
      participationAppraiser: appraiser,
      reservationPhase,
    });

    await harness.onDiscordMessage(observeMessage());

    expect(appraiser.appraise).toHaveBeenCalledTimes(1);
    // The reservation is settled with the ignore action → released.
    expect(reservationPhase.settleAfterAppraisal).toHaveBeenCalledWith(
      reservation,
      'ignore',
      expect.any(Number),
    );
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith(
      'participation.reservation.reserved',
      expect.objectContaining({ reservationId: reservation.reservationId, replayed: false }),
    );
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith(
      'participation.reservation.settled',
      expect.objectContaining({ action: 'ignore', settlement: 'released' }),
    );
  });

  it('retains the reservation on a reply outcome (handed to the egress phase)', async () => {
    const reservation = makeReservationSnapshot();
    const appraiser = replyingAppraiser('reply');
    const reservationPhase: ReservationPhasePort = {
      reserve: vi.fn(async (): Promise<ReservationDecision> => ({
        outcome: 'reserved',
        reservation,
        episode: makeEpisodeSnapshot(),
        replayed: false,
      })),
      settleAfterAppraisal: vi.fn(async () => 'retained' as const),
      releaseIgnored: vi.fn(),
    };
    const harness = createHarness({
      passiveNameCandidateBuilder: createdBuilder(makeCandidate()),
      participationAppraiser: appraiser,
      reservationPhase,
    });

    await harness.onDiscordMessage(observeMessage());

    expect(reservationPhase.settleAfterAppraisal).toHaveBeenCalledWith(
      reservation,
      'reply',
      expect.any(Number),
    );
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith(
      'participation.reservation.settled',
      expect.objectContaining({ action: 'reply', settlement: 'retained' }),
    );
    // The reservation phase never itself sends — a reply routes downstream.
    expect(harness.agentLoop.handleMessage).not.toHaveBeenCalled();
  });

  it('releases a reservation when reserved but no appraiser is wired to promote it', async () => {
    const reservation = makeReservationSnapshot();
    const reservationPhase: ReservationPhasePort = {
      reserve: vi.fn(async (): Promise<ReservationDecision> => ({
        outcome: 'reserved',
        reservation,
        episode: makeEpisodeSnapshot(),
        replayed: false,
      })),
      settleAfterAppraisal: vi.fn(async () => 'released' as const),
      releaseIgnored: vi.fn(),
    };
    const harness = createHarness({
      passiveNameCandidateBuilder: createdBuilder(makeCandidate()),
      reservationPhase,
    });

    await harness.onDiscordMessage(observeMessage());

    // No appraiser → the candidate can never become a reply → released as ignore.
    expect(reservationPhase.settleAfterAppraisal).toHaveBeenCalledWith(
      reservation,
      'ignore',
      expect.any(Number),
    );
  });

  it('emits a content-free participation.reservation gated bus event (jp36.8.3)', async () => {
    const appraiser = replyingAppraiser('reply');
    const reservationPhase: ReservationPhasePort = {
      reserve: vi.fn(async (): Promise<ReservationDecision> => ({
        outcome: 'gated',
        blockedBy: 'room_flooded',
      })),
      settleAfterAppraisal: vi.fn(),
      releaseIgnored: vi.fn(),
    };
    const harness = createHarness({
      passiveNameCandidateBuilder: createdBuilder(makeCandidate()),
      participationAppraiser: appraiser,
      reservationPhase,
    });
    const events: unknown[] = [];
    harness.eventBus.on('participation.reservation', (event) => {
      events.push(event);
    });

    await harness.onDiscordMessage(observeMessage());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channelId: CHANNEL,
      sourceMessageId: SOURCE_MESSAGE_ID,
      trigger: 'passive_name',
      outcome: 'gated',
      blockedBy: 'room_flooded',
    });
    expect(events[0]).toHaveProperty('timestamp');
    // §19 do-not-log: the trigger text never rides the gated telemetry event.
    expect(JSON.stringify(events[0])).not.toContain('I wonder what');
  });

  it('emits reserved then settled participation.reservation bus events', async () => {
    const reservation = makeReservationSnapshot();
    const appraiser = replyingAppraiser('ignore');
    const reservationPhase: ReservationPhasePort = {
      reserve: vi.fn(async (): Promise<ReservationDecision> => ({
        outcome: 'reserved',
        reservation,
        episode: makeEpisodeSnapshot(),
        replayed: false,
      })),
      settleAfterAppraisal: vi.fn(async () => 'released' as const),
      releaseIgnored: vi.fn(),
    };
    const harness = createHarness({
      passiveNameCandidateBuilder: createdBuilder(makeCandidate()),
      participationAppraiser: appraiser,
      reservationPhase,
    });
    const events: { outcome: string }[] = [];
    harness.eventBus.on('participation.reservation', (event) => {
      events.push(event as { outcome: string });
    });

    await harness.onDiscordMessage(observeMessage());

    expect(events.map(e => e.outcome)).toEqual(['reserved', 'settled']);
    expect(events[0]).toMatchObject({
      outcome: 'reserved',
      reservationId: reservation.reservationId,
      episodeId: reservation.episodeId,
      replayed: false,
    });
    expect(events[1]).toMatchObject({
      outcome: 'settled',
      reservationId: reservation.reservationId,
      action: 'ignore',
      settlement: 'released',
    });
  });

  it('emits a content-free participation.egress settled bus event on a granted reply', async () => {
    const reservation = makeReservationSnapshot();
    const appraiser = replyingAppraiser('reply');
    const reservationPhase: ReservationPhasePort = {
      reserve: vi.fn(async (): Promise<ReservationDecision> => ({
        outcome: 'reserved',
        reservation,
        episode: makeEpisodeSnapshot(),
        replayed: false,
      })),
      settleAfterAppraisal: vi.fn(async () => 'retained' as const),
      releaseIgnored: vi.fn(),
    };
    const egressLeasePhase: EgressLeasePhasePort = {
      grantReply: vi.fn(async (): Promise<EgressLeaseDecision> => ({
        channelId: CHANNEL,
        triggerEventId: SOURCE_MESSAGE_ID,
        companionId: reservation.companionId,
        outcome: 'delivered',
        breakerState: 'closed',
        drawOutcome: 'drawn',
      })),
      releaseReact: vi.fn(),
    };
    const harness = createHarness({
      passiveNameCandidateBuilder: createdBuilder(makeCandidate()),
      participationAppraiser: appraiser,
      reservationPhase,
      egressLeasePhase,
    });
    const events: unknown[] = [];
    harness.eventBus.on('participation.egress', (event) => {
      events.push(event);
    });

    await harness.onDiscordMessage(observeMessage());

    expect(egressLeasePhase.grantReply).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channelId: CHANNEL,
      sourceMessageId: SOURCE_MESSAGE_ID,
      trigger: 'passive_name',
      reservationId: reservation.reservationId,
      outcome: 'settled',
      action: 'reply',
      leaseOutcome: 'delivered',
      breakerState: 'closed',
      drawOutcome: 'drawn',
    });
    expect(events[0]).toHaveProperty('timestamp');
    // §19 do-not-log: the generated reply / trigger text never rides egress telemetry.
    expect(JSON.stringify(events[0])).not.toContain('I wonder what');
  });
});
