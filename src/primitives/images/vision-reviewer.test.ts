import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fromAny } from '@total-typescript/shoehorn';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { DefaultImageVisionReviewer } from './vision-reviewer.js';
import { VISION_IMAGE_MAX_BYTES } from './vision-policy.js';
import { runWithRequestContext } from '../llm/request-context.js';
import type { TurnID } from '../../shared/contracts/runtime.js';

vi.mock('../../core/agent/stream-adapter.js', () => ({
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
      fromAny({
        primaryProvider: 'openrouter',
      }),
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
      { lane: 'default', maxBytes: VISION_IMAGE_MAX_BYTES },
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
      fromAny({
        primaryProvider: 'openrouter',
        comfyUiBaseUrl: 'https://comfy.local.example.test',
      }),
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
      { lane: 'local_crawler', maxBytes: VISION_IMAGE_MAX_BYTES },
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
      fromAny({
        primaryProvider: 'openrouter',
      }),
      {
        llmProvider: fromAny(llmProvider),
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
        correlation: expect.objectContaining({
          requestId: expect.stringMatching(/^vision-review-/),
          callType: 'tool',
          purpose: 'images.vision_review',
          originType: 'tool',
          originStage: 'images.vision_review',
        }),
      }),
      'vision',
    );
    const completionContext = llmProvider.complete.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(completionContext.modelHint).toBeUndefined();
    expect(completeImpl).not.toHaveBeenCalled();
    expect(result.summary).toBe('Gateway review summary');
    expect(result.model).toBe('gateway-vision-model');
  });

  it('derives correlation metadata from the active request context', async () => {
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
    const reviewer = new DefaultImageVisionReviewer(
      fromAny({
        primaryProvider: 'openrouter',
      }),
      {
        llmProvider: fromAny(llmProvider),
        binaryFetcher: vi.fn(async () => ({
          dataBase64: 'AQID',
          mimeType: 'image/png',
          sizeBytes: 3,
        })),
      },
    );

    await runWithRequestContext(
      {
        sessionId: 'logical-session-1',
        turnId: 'turn-1' as TurnID,
        channelId: 'discord:guild:channel-1',
        channelType: 'discord',
        requestId: 'req-1',
        originType: 'chat',
        toolName: 'media',
        toolCallId: 'call-1',
        conversationId: 'logical-session-1',
        rootInitiationId: 'root-initiation-1',
        shardId: 'shard-1',
        subagentId: 'subagent-1',
        workloadType: 'subagent',
        workloadId: 'subagent-1',
      },
      async () => {
        await reviewer.analyze({
          imageUrls: ['https://images.example.test/review.png'],
          question: 'Describe it.',
        });
      },
    );

    expect(llmProvider.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        correlation: expect.objectContaining({
          sessionId: 'logical-session-1',
          turnId: 'turn-1',
          channelId: 'discord:guild:channel-1',
          channelType: 'discord',
          requestId: 'req-1:vision-review',
          callType: 'tool',
          toolName: 'media',
          toolCallId: 'call-1',
          conversationId: 'logical-session-1',
          rootInitiationId: 'root-initiation-1',
          shardId: 'shard-1',
          subagentId: 'subagent-1',
          workloadType: 'subagent',
          workloadId: 'subagent-1',
          purpose: 'images.vision_review',
          originType: 'chat',
          originStage: 'images.vision_review',
        }),
      }),
      'vision',
    );
  });

  it('fails closed when the vision completion returns empty content', async () => {
    const llmProvider = {
      complete: vi.fn(async () => ({
        content: '',
        toolCalls: [],
        model: 'primary-vision-model',
        inputTokens: 11,
        outputTokens: 0,
        stopReason: 'stop',
      })),
    };
    const reviewer = new DefaultImageVisionReviewer(
      fromAny({
        primaryProvider: 'openrouter',
      }),
      {
        llmProvider: fromAny(llmProvider),
        binaryFetcher: vi.fn(async () => ({
          dataBase64: 'AQID',
          mimeType: 'image/png',
          sizeBytes: 3,
        })),
      },
    );

    await expect(reviewer.analyze({
      imageUrls: ['https://images.example.test/review.png'],
      question: 'Describe it.',
    })).rejects.toThrow(
      'vision_empty_response: vision review returned empty text from primary-vision-model',
    );

    expect(llmProvider.complete).toHaveBeenCalledTimes(1);
  });

  it('propagates vision completion failures without swallowing them', async () => {
    const llmProvider = {
      complete: vi.fn(async () => {
        throw new Error('all vision candidates exhausted');
      }),
    };
    const reviewer = new DefaultImageVisionReviewer(
      fromAny({
        primaryProvider: 'openrouter',
      }),
      {
        llmProvider: fromAny(llmProvider),
        binaryFetcher: vi.fn(async () => ({
          dataBase64: 'AQID',
          mimeType: 'image/png',
          sizeBytes: 3,
        })),
      },
    );

    await expect(reviewer.analyze({
      imageUrls: ['https://images.example.test/review.png'],
      question: 'Describe it.',
    })).rejects.toThrow('all vision candidates exhausted');

    expect(llmProvider.complete).toHaveBeenCalledTimes(1);
  });

  it('emits distinct embodiment descriptors for matching and divergent renders', async () => {
    const referenceResolver = {
      resolveForTool: vi.fn(async () => ({
        id: 'ref-1',
        dataUrl: 'data:image/png;base64,AQID',
        description: 'default selfie',
      })),
    };
    const makeReviewer = (text: string) => new DefaultImageVisionReviewer(
      fromAny({ primaryProvider: 'openrouter' }),
      {
        referenceResolver,
        binaryFetcher: vi.fn(async () => ({
          dataBase64: 'BAUG',
          mimeType: 'image/png',
          sizeBytes: 3,
        })),
        completeImpl: vi.fn(async (_model, context) => {
          const message = context.messages[0] as {
            content: Array<{ type: string; data?: string }>;
          };
          // Reference identity image is attached first, render(s) after it.
          expect(message.content[1]).toMatchObject({ type: 'image', data: 'AQID' });
          expect(message.content[2]).toMatchObject({ type: 'image', data: 'BAUG' });
          return { model: 'vision-model', content: [{ type: 'text', text }] };
        }),
      },
    );

    const same = await makeReviewer('Looks consistent. EMBODIMENT: same_me — same eyes and jaw.').analyze({
      imageUrls: ['https://images.example.test/render.png'],
      mode: 'create',
      prompt: 'a selfie',
      compareToReference: true,
    });
    expect(same.embodiment).toMatchObject({
      verdict: 'same_me',
      framing: 'This still reads as me.',
      note: 'same eyes and jaw.',
      referenceId: 'ref-1',
      referenceDescription: 'default selfie',
    });

    const divergent = await makeReviewer('This face changed. EMBODIMENT: different_person — different face shape.').analyze({
      imageUrls: ['https://images.example.test/render.png'],
      mode: 'create',
      prompt: 'a selfie',
      compareToReference: true,
    });
    expect(divergent.embodiment?.verdict).toBe('different_person');
    expect(divergent.embodiment?.framing).toBe('This does not look like me.');
    expect(same.embodiment?.verdict).not.toBe(divergent.embodiment?.verdict);
  });

  it('skips embodiment when the review does not opt into reference comparison', async () => {
    const referenceResolver = { resolveForTool: vi.fn() };
    const reviewer = new DefaultImageVisionReviewer(
      fromAny({ primaryProvider: 'openrouter' }),
      {
        referenceResolver,
        binaryFetcher: vi.fn(async () => ({
          dataBase64: 'AQID',
          mimeType: 'image/png',
          sizeBytes: 3,
        })),
        completeImpl: vi.fn(async () => ({
          model: 'vision-model',
          content: [{ type: 'text', text: 'A clear image.' }],
        })),
      },
    );

    const result = await reviewer.analyze({
      imageUrls: ['https://images.example.test/render.png'],
      question: 'Describe it.',
    });
    expect(result.embodiment).toBeUndefined();
    expect(referenceResolver.resolveForTool).not.toHaveBeenCalled();
  });

  it('reviews without an embodiment descriptor when no active reference is set', async () => {
    const referenceResolver = { resolveForTool: vi.fn(async () => null) };
    const reviewer = new DefaultImageVisionReviewer(
      fromAny({ primaryProvider: 'openrouter' }),
      {
        referenceResolver,
        binaryFetcher: vi.fn(async () => ({
          dataBase64: 'AQID',
          mimeType: 'image/png',
          sizeBytes: 3,
        })),
        completeImpl: vi.fn(async () => ({
          model: 'vision-model',
          content: [{ type: 'text', text: 'A clear render. EMBODIMENT: same_me — ignored without a reference.' }],
        })),
      },
    );

    const result = await reviewer.analyze({
      imageUrls: ['https://images.example.test/render.png'],
      mode: 'create',
      prompt: 'a selfie',
      compareToReference: true,
    });
    expect(referenceResolver.resolveForTool).toHaveBeenCalledWith({ useDefaultReference: true });
    expect(result.embodiment).toBeUndefined();
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
        fromAny({
          primaryProvider: 'openrouter',
        }),
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
