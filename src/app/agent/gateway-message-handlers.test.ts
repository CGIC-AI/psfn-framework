import { describe, expect, it, vi } from 'vitest';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { SatelliteRoutingMetadata } from '../../core/agent/satellite-adapter-port.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { registerGatewayMessageHandlers } from './gateway-message-handlers.js';
import { createWyomingSatelliteRoutingPort } from '../../../satellites/wyoming/host/routing.js';

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
    discordSendMedia: vi.fn(async () => {}),
  };
  const agentLoop = {
    handleMessage: vi.fn(overrides?.handleMessage ?? (async () => makeResponse('primary response'))),
  };
  const shardManager = {
    delegateSatelliteSession: vi.fn(
      overrides?.delegateSatelliteSession
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
  const satelliteRouting = createWyomingSatelliteRoutingPort();
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
    wyomingShardRouting: { enabled: true },
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
    expect(harness.shardManager.delegateSatelliteSession).toHaveBeenCalledWith({
      message,
      routing: expect.objectContaining({
        connectionId: 'conn-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        siteId: 'ha-main',
        satelliteId: 'den',
        presence: expect.objectContaining({
          kind: 'satellite',
          siteId: 'ha-main',
          satelliteId: 'den',
        }),
      }),
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
    expect(harness.safeguardAuditTrail.append).toHaveBeenNthCalledWith(1, 'satellite.routing.decision', {
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
    expect(harness.safeguardAuditTrail.append).toHaveBeenNthCalledWith(2, 'satellite.routing.delegated', {
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
      delegateSatelliteSession: async () => {
        throw new Error('No ready agent connected');
      },
      handleMessage: async () => makeResponse('fallback response'),
    });
    const message = makeMessage();

    const response = await harness.onHandleMessage(message);

    expect(response).toEqual(makeResponse('fallback response'));
    expect(harness.agentLoop.handleMessage).toHaveBeenCalledWith(message);
    expect(harness.log.warn).toHaveBeenCalledWith(
      'Satellite delegation failed; falling back to primary path',
      {
        channelId: message.channelId,
        error: 'No ready agent connected',
      },
    );
    expect(harness.safeguardAuditTrail.append).toHaveBeenNthCalledWith(2, 'satellite.routing.fallback', {
      channelId: message.channelId,
      messageId: message.id,
      reason: 'delegation_error',
      error: 'No ready agent connected',
      connectionId: 'conn-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
    expect(harness.safeguardAuditTrail.append).toHaveBeenNthCalledWith(3, 'satellite.routing.primary', {
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

    expect(harness.gateway.discordSend).not.toHaveBeenCalled();
    expect(harness.gateway.discordSendMedia).toHaveBeenCalledWith('discord:general', {
      url: 'https://images.example.test/purr.png',
      contentType: 'image/png',
      name: 'purr.png',
      localPath: '/tmp/purr.png',
    });
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
    expect(harness.gateway.discordSendMedia).not.toHaveBeenCalled();
  });

  it('drops duplicate discord notifications by message id within dedupe window', async () => {
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

    expect(harness.agentLoop.handleMessage).toHaveBeenCalledTimes(1);
    expect(harness.gateway.discordSend).toHaveBeenCalledTimes(1);
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
    expect(harness.shardManager.delegateSatelliteSession).toHaveBeenCalledTimes(1);
    expect(harness.safeguardAuditTrail.append).toHaveBeenCalledWith('gateway.message.duplicate', {
      route: 'handle',
      channelId: message.channelId,
      messageId: 'msg-dup-2',
      disposition: 'cached',
    });
  });
});
