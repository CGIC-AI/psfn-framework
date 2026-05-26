import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultImageVisionReviewer } from './vision-reviewer.js';
import { resolveRoutingCandidates } from '../llm/routing.js';

vi.mock('../../core/agent/stream-adapter.js', () => ({
  resolveModel: vi.fn(() => ({
    id: 'vision-model',
    provider: 'openrouter',
    maxTokens: 1024,
    input: ['text', 'image'],
  })),
}));

vi.mock('../llm/routing.js', () => ({
  resolveRoutingCandidates: vi.fn(() => [{
    model: 'vision-model',
    provider: 'openrouter',
    maxTokens: 1024,
  }]),
}));

const mockedResolveRoutingCandidates = vi.mocked(resolveRoutingCandidates);

describe('DefaultImageVisionReviewer', () => {
  beforeEach(() => {
    mockedResolveRoutingCandidates.mockReturnValue([{
      model: 'vision-model',
      provider: 'openrouter',
      maxTokens: 1024,
    }]);
  });

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

  it('routes configured ComfyUI output URLs through the local crawler lane and still fails closed on gateway denial', async () => {
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
    expect(binaryFetcher).toHaveBeenCalledWith(
      'https://comfy.local.example.test/view?filename=review.png',
      { lane: 'local_crawler', maxBytes: 8 * 1024 * 1024 },
    );
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
          pin: true,
        }),
      }),
      'vision',
    );
    expect(completeImpl).not.toHaveBeenCalled();
    expect(result.summary).toBe('Gateway review summary');
    expect(result.model).toBe('gateway-vision-model');
  });

  it('tries the next configured vision model when a vision completion returns empty content', async () => {
    mockedResolveRoutingCandidates.mockReturnValueOnce([
      {
        model: 'primary-vision-model',
        provider: 'openrouter',
        maxTokens: 1024,
      },
      {
        model: 'fallback-vision-model',
        provider: 'openrouter',
        maxTokens: 2048,
      },
    ]);
    const llmProvider = {
      complete: vi.fn()
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [],
          model: 'primary-vision-model',
          inputTokens: 11,
          outputTokens: 0,
          stopReason: 'stop',
        })
        .mockResolvedValueOnce({
          content: 'Fallback model can see the image.',
          toolCalls: [],
          model: 'fallback-vision-model',
          inputTokens: 12,
          outputTokens: 8,
          stopReason: 'stop',
        }),
    };
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
      },
    );

    const result = await reviewer.analyze({
      imageUrls: ['https://images.example.test/review.png'],
      question: 'Describe it.',
    });

    expect(llmProvider.complete).toHaveBeenCalledTimes(2);
    expect(llmProvider.complete).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        modelHint: expect.objectContaining({
          model: 'primary-vision-model',
          pin: true,
        }),
      }),
      'vision',
    );
    expect(llmProvider.complete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        modelHint: expect.objectContaining({
          model: 'fallback-vision-model',
          pin: true,
        }),
      }),
      'vision',
    );
    expect(result.summary).toBe('Fallback model can see the image.');
    expect(result.model).toBe('fallback-vision-model');
  });

  it('prefers a saved local image path over gateway fetch for generated outputs', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-vision-local-'));
    const imagePath = join(tempDir, 'saved-output.png');
    writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]));

    try {
      const binaryFetcher = vi.fn(async () => ({
        dataBase64: 'AQID',
        mimeType: 'image/png',
        sizeBytes: 3,
      }));
      const completeImpl = vi.fn(async (_model, context) => {
        const message = context.messages[0] as {
          content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
        };
        expect(message.content[1]).toEqual({
          type: 'image',
          data: Buffer.from([1, 2, 3, 4]).toString('base64'),
          mimeType: 'image/png',
        });
        return {
          model: 'vision-model',
          content: [{ type: 'text', text: 'The saved local image was reviewed directly.' }],
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
        imageLocalPaths: [imagePath],
        question: 'What is in this image?',
      });

      expect(binaryFetcher).not.toHaveBeenCalled();
      expect(result.summary).toContain('reviewed directly');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
