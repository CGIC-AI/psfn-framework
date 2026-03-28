import { describe, expect, it, vi } from 'vitest';
import { createDiscordReverseRpcVoiceModule } from './voice-surfaces.js';

describe('createDiscordReverseRpcVoiceModule', () => {
  it('registers a discord voice handler that proxies through gateway voice streaming', async () => {
    let voiceHandler: ((message: any) => Promise<any>) | undefined;
    const gateway = {
      requestAgentVoiceStream: vi.fn(async () => ({
        content: 'voice reply',
        channelId: 'discord-voice',
        model: 'test-model',
        durationMs: 27,
      })),
    };
    const discord = {
      setVoiceHandler: vi.fn((handler) => {
        voiceHandler = handler;
      }),
    };

    await createDiscordReverseRpcVoiceModule().register?.({
      gateway: gateway as any,
      discord: discord as any,
      eventBus: {} as any,
    });

    const response = await voiceHandler?.({
      channelId: 'discord-voice',
      content: 'hello',
    });

    expect(gateway.requestAgentVoiceStream).toHaveBeenCalledWith({
      channelId: 'discord-voice',
      content: 'hello',
    });
    expect(response).toEqual({
      content: 'voice reply',
      channelId: 'discord-voice',
      metadata: {
        model: 'test-model',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 27,
      },
    });
  });
});
