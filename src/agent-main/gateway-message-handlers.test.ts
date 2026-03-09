import { describe, expect, it, vi } from 'vitest';
import type {
  AgentResponse,
  SubstrateConfig,
  SubstrateMessage,
  WyomingRoutingMetadata,
} from '../types.js';
import { registerGatewayMessageHandlers } from './gateway-message-handlers.js';

function makeMessage(overrides?: Record<string, unknown>): SubstrateMessage {
  return {
    id: 'msg-1',
    channelId: 'api:wyoming:ha-main:den',
    channelType: 'api',
    authorId: 'user-1',
    authorName: 'User',
    content: 'hello from wyoming',
    timestamp: new Date('2026-03-02T00:00:00.000Z'),
    routing: {
      wyoming: {
        connectionId: 'conn-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        siteId: 'ha-main',
        satelliteId: 'den',
        shardDelegation: {
          eligible: true,
          reason: 'gateway_allowed',
        },
      },
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

function createHarness(overrides?: {
  config?: SubstrateConfig;
  delegateWyomingSession?: (request: {
    message: SubstrateMessage;
    routing?: WyomingRoutingMetadata;
  }) => Promise<{
    shardId: string;
    content: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  }>;
  handleMessage?: (message: SubstrateMessage) => Promise<AgentResponse>;
}) {
  let onHandleMessage:
    | ((message: SubstrateMessage) => Promise<AgentResponse>)
    | undefined;
  let onDiscordMessage:
    | ((message: SubstrateMessage) => void | Promise<void>)
    | undefined;

  const gateway = {
    onHandleMessage: vi.fn((handler: (message: SubstrateMessage) => Promise<AgentResponse>) => {
      onHandleMessage = handler;
    }),
    onDiscordMessage: vi.fn((handler: (message: SubstrateMessage) => void | Promise<void>) => {
      onDiscordMessage = handler;
    }),
    discordSend: vi.fn(async () => {}),
  };
  const agentLoop = {
    handleMessage: vi.fn(overrides?.handleMessage ?? (async () => makeResponse('primary response'))),
  };
  const shardManager = {
    delegateWyomingSession: vi.fn(
      overrides?.delegateWyomingSession
      ?? (async () => ({
        shardId: 'wyoming-shard-1',
        content: 'delegated response',
        model: 'shard-model',
        inputTokens: 3,
        outputTokens: 7,
        durationMs: 42,
      })),
    ),
  };
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
    wyomingShardRouting: { enabled: true },
  } as SubstrateConfig);

  registerGatewayMessageHandlers({
    gateway,
    agentLoop,
    shardManager,
    safeguardAuditTrail,
    config,
    log,
    trackSessionActivity,
  });

  if (!onHandleMessage || !onDiscordMessage) {
    throw new Error('Expected gateway message handlers to be registered');
  }

  return {
    gateway,
    agentLoop,
    shardManager,
    safeguardAuditTrail,
    log,
    trackSessionActivity,
    onHandleMessage,
    onDiscordMessage,
  };
}

describe('registerGatewayMessageHandlers', () => {
  it('delegates eligible Wyoming voice messages to shard manager and returns delegated response', async () => {
    const harness = createHarness();
    const message = makeMessage();

    const response = await harness.onHandleMessage(message);

    expect(harness.trackSessionActivity).toHaveBeenCalledWith(message);
    expect(harness.shardManager.delegateWyomingSession).toHaveBeenCalledWith({
      message,
      routing: message.routing?.wyoming,
    });
    expect(harness.agentLoop.handleMessage).not.toHaveBeenCalled();
    expect(response).toEqual({
      content: 'delegated response',
      channelId: message.channelId,
      metadata: {
        model: 'shard-model',
        inputTokens: 3,
        outputTokens: 7,
        durationMs: 42,
      },
    });
    expect(harness.safeguardAuditTrail.append).toHaveBeenNthCalledWith(1, 'wyoming.routing.decision', {
      channelId: message.channelId,
      messageId: message.id,
      delegated: true,
      reason: 'delegation_enabled',
      connectionId: 'conn-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      siteId: 'ha-main',
      satelliteId: 'den',
    });
    expect(harness.safeguardAuditTrail.append).toHaveBeenNthCalledWith(2, 'wyoming.routing.delegated', {
      channelId: message.channelId,
      messageId: message.id,
      shardId: 'wyoming-shard-1',
      connectionId: 'conn-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      siteId: 'ha-main',
      satelliteId: 'den',
    });
  });

  it('falls back to primary agent path when Wyoming delegation reports no ready shard', async () => {
    const harness = createHarness({
      delegateWyomingSession: async () => {
        throw new Error('No ready agent connected');
      },
      handleMessage: async () => makeResponse('fallback response'),
    });
    const message = makeMessage();

    const response = await harness.onHandleMessage(message);

    expect(response).toEqual(makeResponse('fallback response'));
    expect(harness.agentLoop.handleMessage).toHaveBeenCalledWith(message);
    expect(harness.log.warn).toHaveBeenCalledWith(
      'Wyoming delegation failed; falling back to primary path',
      {
        channelId: message.channelId,
        error: 'No ready agent connected',
      },
    );
    expect(harness.safeguardAuditTrail.append).toHaveBeenNthCalledWith(2, 'wyoming.routing.fallback', {
      channelId: message.channelId,
      messageId: message.id,
      reason: 'delegation_error',
      error: 'No ready agent connected',
      connectionId: 'conn-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
    expect(harness.safeguardAuditTrail.append).toHaveBeenNthCalledWith(3, 'wyoming.routing.primary', {
      channelId: message.channelId,
      messageId: message.id,
      reason: 'delegation_enabled',
      connectionId: 'conn-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      siteId: 'ha-main',
      satelliteId: 'den',
    });
  });

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
      'Message from User: hello from wyoming...',
      {
        channelId: 'discord:general',
        attachmentCount: 1,
        attachmentTypes: ['image/png'],
        attachmentNames: ['image.png'],
      },
    );
    expect(harness.agentLoop.handleMessage).toHaveBeenCalledWith(message);
    expect(harness.gateway.discordSend).toHaveBeenCalledWith('discord:general', 'discord response');
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

    expect(harness.log.error).toHaveBeenCalledWith('Error handling message', {
      channelId: 'discord:general',
      messageId: 'msg-1',
      error: 'agent handling failure',
    });
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith('discord.message.error', {
      channelId: 'discord:general',
      messageId: 'msg-1',
      error: 'agent handling failure',
    });
    expect(harness.gateway.discordSend).not.toHaveBeenCalled();
  });
});
