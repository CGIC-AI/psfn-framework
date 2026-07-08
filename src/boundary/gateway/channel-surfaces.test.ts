import { describe, expect, it, vi } from 'vitest';
import {
  wireGatewayChannelMessages,
  type WireGatewayChannelMessagesInput,
} from './channel-surfaces.js';

function createInput(): {
  input: WireGatewayChannelMessagesInput;
  discordHandler: ((message: any) => Promise<any>) | undefined;
  telegramHandler: ((message: any) => Promise<any>) | undefined;
} {
  let discordHandler: ((message: any) => Promise<any>) | undefined;
  let telegramHandler: ((message: any) => Promise<any>) | undefined;

  return {
    input: {
      discord: {
        onMessage: (handler) => {
          discordHandler = handler as (message: any) => Promise<any>;
        },
      } as any,
      telegram: {
        onMessage: (handler) => {
          telegramHandler = handler as (message: any) => Promise<any>;
        },
      } as any,
      gateway: {
        notifyChannelMessage: vi.fn(),
        requestAgentVoiceStream: vi.fn(async () => ({
          content: 'voice reply',
          channelId: 'telegram-channel',
          model: 'test-model',
          durationMs: 42,
          attachments: [{ kind: 'audio' }],
        })),
      } as any,
      serializeMessage: (message) => ({ ...message, serialized: true }),
    },
    get discordHandler() {
      return discordHandler;
    },
    get telegramHandler() {
      return telegramHandler;
    },
  };
}

describe('wireGatewayChannelMessages', () => {
  it('forwards discord inbound messages to agent notifications and returns a placeholder reply', async () => {
    const setup = createInput();

    wireGatewayChannelMessages(setup.input);

    const response = await setup.discordHandler?.({
      channelId: 'discord-channel',
      content: 'hello',
      timestamp: new Date('2026-03-28T00:00:00.000Z'),
    });

    expect(setup.input.gateway.notifyChannelMessage).toHaveBeenCalledWith('discord', 'discord.message', {
      message: expect.objectContaining({
        channelId: 'discord-channel',
        serialized: true,
      }),
    });
    expect(response).toEqual({
      content: '',
      channelId: 'discord-channel',
      metadata: {
        model: '',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      },
    });
  });

  it('routes telegram inbound messages through requestAgentVoiceStream', async () => {
    const setup = createInput();

    wireGatewayChannelMessages(setup.input);

    const response = await setup.telegramHandler?.({
      channelId: 'telegram-channel',
      content: 'ping',
    });

    expect(setup.input.gateway.requestAgentVoiceStream).toHaveBeenCalledWith({
      channelId: 'telegram-channel',
      content: 'ping',
    });
    expect(response).toEqual({
      content: 'voice reply',
      channelId: 'telegram-channel',
      attachments: [{ kind: 'audio' }],
      metadata: {
        model: 'test-model',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 42,
      },
    });
  });
});
