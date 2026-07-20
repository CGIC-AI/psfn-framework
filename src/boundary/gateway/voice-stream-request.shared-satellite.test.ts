import { describe, expect, it, vi } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { requestAgentVoiceStream } from './voice-stream-request.js';

describe('shared-satellite structured silence transport', () => {
  it('preserves an intentional decline through transcript streaming', async () => {
    const request = vi.fn(async (method: string, params: any) => {
      if (method === 'voice.transcript.begin' || method === 'voice.transcript.chunk') {
        return {
          correlationId: params.correlationId,
          streamId: params.streamId,
          sequence: params.sequence,
          accepted: true,
          queueDepth: 0,
          droppedChunks: 0,
        };
      }
      if (method === 'voice.transcript.end') {
        return {
          correlationId: params.correlationId,
          streamId: params.streamId,
          droppedChunks: 0,
          content: '',
          channelId: 'satellite:voice:session-1',
          model: 'test-model',
          durationMs: 10,
          disposition: 'decline',
        };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await expect(requestAgentVoiceStream({
      client: { request } as any,
      message: {
        id: 'message-1',
        channelId: 'satellite:voice:session-1',
        channelType: 'api',
        authorId: 'partner',
        authorName: 'Partner',
        content: 'hello',
        timestamp: new Date('2026-07-19T12:00:00.000Z'),
      },
      wyomingShardRouting: {
        enabled: false,
        provider: 'openrouter',
        model: 'openai/gpt-4.1-mini',
        maxTokens: 1_000,
        timeoutMs: 30_000,
      },
      companionId: createCompanionId('11111111-1111-4111-8111-111111111111'),
      nextRequestCounter: () => 1,
    })).resolves.toMatchObject({
      content: '',
      disposition: 'decline',
    });
  });
});
