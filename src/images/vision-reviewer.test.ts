import { describe, expect, it, vi } from 'vitest';
import { DefaultImageVisionReviewer } from './vision-reviewer.js';

vi.mock('../core/agent/stream-adapter.js', () => ({
  resolveModel: vi.fn(() => ({
    id: 'vision-model',
    provider: 'openrouter',
    maxTokens: 1024,
    input: ['text', 'image'],
  })),
}));

describe('DefaultImageVisionReviewer', () => {
  it('uses gateway binary fetch when available', async () => {
    const binaryFetcher = vi.fn(async () => ({
      dataBase64: 'AQID',
      mimeType: 'image/png',
      sizeBytes: 3,
    }));
    const completeImpl = vi.fn(async (_model, context) => {
      expect(context.messages).toHaveLength(1);
      const message = context.messages[0] as {
        content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      };
      expect(message.content[0]?.type).toBe('text');
      expect(message.content[1]).toEqual({
        type: 'image',
        data: 'AQID',
        mimeType: 'image/png',
      });
      return {
        model: 'vision-model',
        content: [{ type: 'text', text: 'The image reads clearly and matches the expected look.' }],
      };
    });

    const reviewer = new DefaultImageVisionReviewer(
      {
        primaryProvider: 'openrouter',
      } as any,
      {
        binaryFetcher,
        completeImpl,
      },
    );

    const result = await reviewer.analyze({
      imageUrls: ['https://images.example.test/review.png'],
      question: 'What is in this image?',
    });

    expect(binaryFetcher).toHaveBeenCalledWith(
      'https://images.example.test/review.png',
      { lane: 'default', maxBytes: 8 * 1024 * 1024 },
    );
    expect(result.summary).toContain('matches the expected look');
    expect(result.model).toBe('vision-model');
  });

  it('fails closed when gateway fetch fails even for configured ComfyUI hosts', async () => {
    const binaryFetcher = vi.fn(async () => {
      throw new Error('gateway denied');
    });
    const completeImpl = vi.fn(async () => ({
      model: 'vision-model',
      content: [{ type: 'text', text: 'The Comfy output still looks like the companion.' }],
    }));

    const reviewer = new DefaultImageVisionReviewer(
      {
        primaryProvider: 'openrouter',
        comfyUiBaseUrl: 'https://comfy.local.example.test',
      } as any,
      {
        binaryFetcher,
        completeImpl,
      },
    );

    await expect(reviewer.analyze({
      imageUrls: ['https://comfy.local.example.test/view?filename=review.png'],
      prompt: 'a new selfie',
      mode: 'create',
    })).rejects.toThrow('vision fetch failed for https://comfy.local.example.test/view?filename=review.png: gateway denied');

    expect(binaryFetcher).toHaveBeenCalledTimes(1);
    expect(completeImpl).not.toHaveBeenCalled();
  });

  it('uses injected llmProvider transport instead of local completion transport', async () => {
    const llmProvider = {
      complete: vi.fn(async () => ({
        content: 'Gateway review summary',
        toolCalls: [],
        model: 'gateway-vision-model',
        inputTokens: 11,
        outputTokens: 7,
        stopReason: 'stop',
      })),
    };
    const completeImpl = vi.fn();
    const reviewer = new DefaultImageVisionReviewer(
      {
        primaryProvider: 'openrouter',
      } as any,
      {
        llmProvider: llmProvider as any,
        binaryFetcher: vi.fn(async () => ({
          dataBase64: 'AQID',
          mimeType: 'image/png',
          sizeBytes: 3,
        })),
        completeImpl,
      },
    );

    const result = await reviewer.analyze({
      imageUrls: ['https://images.example.test/review.png'],
      question: 'Describe it.',
    });

    expect(llmProvider.complete).toHaveBeenCalledTimes(1);
    expect(llmProvider.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        modelHint: expect.objectContaining({
          model: 'vision-model',
          provider: 'openrouter',
          maxTokens: 1024,
        }),
      }),
      'background',
    );
    expect(completeImpl).not.toHaveBeenCalled();
    expect(result.summary).toBe('Gateway review summary');
    expect(result.model).toBe('gateway-vision-model');
  });
});
