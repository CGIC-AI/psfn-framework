import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, Attachment, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { SatelliteRoutingMetadata } from '../../core/agent/satellite-adapter-port.js';
import { createNoopSatelliteRoutingPort } from '../../core/agent/satellite-adapter-port.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  registerGatewayMessageHandlers,
  type ObservedGroupMemorySchedulerPort,
} from './gateway-message-handlers.js';
import type {
  CompanionMessageDeliveryFailureNotification,
  CompanionMessageFailureReportParams,
} from '../../boundary/gateway/protocol.js';

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
  handleMessage?: (message: SubstrateMessage) => Promise<AgentResponse>;
  observeMessage?: (message: SubstrateMessage) => Promise<void>;
  waitForIdle?: () => Promise<void>;
  observedGroupMemoryScheduler?: ObservedGroupMemorySchedulerPort;
  discordSend?: (channelId: string, content: string) => Promise<void>;
  discordSendMedia?: (channelId: string, media: Attachment) => Promise<void>;
  companionSend?: (channelId: string, content: string, authorName?: string) => Promise<unknown>;
  companionReportFailure?: (params: CompanionMessageFailureReportParams) => Promise<unknown>;
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
    companionSend: vi.fn(overrides?.companionSend ?? (async () => ({}))),
    companionReportFailure: vi.fn(overrides?.companionReportFailure ?? (async () => ({}))),
  };
  const agentLoop = {
    handleMessage: vi.fn(overrides?.handleMessage ?? (async () => makeResponse('primary response'))),
    observeMessage: vi.fn(overrides?.observeMessage ?? (async () => {})),
    waitForIdle: vi.fn(overrides?.waitForIdle ?? (async () => {})),
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
    companionId: 'companion-test',
  } as SubstrateConfig);

  registerGatewayMessageHandlers({
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
    ...(overrides?.outboundReplyGuard
      ? { outboundReplyGuard: overrides.outboundReplyGuard }
      : {}),
    companionAuthorName: 'Selene',
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

  it('runs companion messages through the normal turn pipeline and replies via the companion lane', async () => {
    const harness = createHarness({
      handleMessage: async () => makeResponse('companion reply'),
    });
    const message = makeCompanionMessage({ timestamp: '2026-03-02T02:00:00.000Z' });

    await harness.onCompanionMessage(message);

    await vi.waitFor(() => {
      expect(harness.agentLoop.handleMessage).toHaveBeenCalledTimes(1);
      expect(harness.gateway.companionSend).toHaveBeenCalledWith(
        'companion-room:living_room',
        'companion reply',
        'Selene',
      );
    });
    // Timestamp deserialized before the turn pipeline sees it.
    const handled = harness.agentLoop.handleMessage.mock.calls[0][0] as SubstrateMessage;
    expect(handled.timestamp).toBeInstanceOf(Date);
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
