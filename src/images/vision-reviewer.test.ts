import { describe, expect, it, vi } from 'vitest';
import { DefaultImageVisionReviewer } from './vision-reviewer.js';

vi.mock('../agent/stream-adapter.js', () => ({
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
    const fetchImpl = vi.fn();
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
        fetchImpl: fetchImpl as typeof fetch,
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
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.summary).toContain('matches the expected look');
    expect(result.model).toBe('vision-model');
  });

  it('falls back to direct fetch for configured ComfyUI hosts when gateway fetch fails', async () => {
    const binaryFetcher = vi.fn(async () => {
      throw new Error('gateway denied');
    });
    const fetchImpl = vi.fn(async () => (
      new Response(Buffer.from('png-bytes'), {
        status: 200,
        headers: {
          'content-type': 'image/png',
        },
      })
    )) as typeof fetch;
    const completeImpl = vi.fn(async () => ({
      model: 'vision-model',
      content: [{ type: 'text', text: 'The Comfy output still looks like the companion.' }],
    }));

    const reviewer = new DefaultImageVisionReviewer(
      {
        primaryProvider: 'openrouter',
        comfyUiBaseUrl: 'https://comfy.local.operator.nyc',
      } as any,
      {
        binaryFetcher,
        fetchImpl,
        completeImpl,
      },
    );

    const result = await reviewer.analyze({
      imageUrls: ['https://comfy.local.operator.nyc/view?filename=review.png'],
      prompt: 'a new selfie',
      mode: 'create',
    });

    expect(binaryFetcher).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://comfy.local.operator.nyc/view?filename=review.png',
      expect.objectContaining({
        headers: {
          Accept: 'image/*',
        },
      }),
    );
    expect(result.summary).toContain('Comfy output still looks like the companion');
  });
});
