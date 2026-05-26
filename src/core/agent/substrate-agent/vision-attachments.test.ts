import { describe, expect, it, vi } from 'vitest';
import type { ImageVisionReviewer } from '../../../primitives/images/types.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import {
  buildTurnUserContent,
  collectVisionTurnImageUrls,
  hasVisionTurnInputs,
} from './vision-attachments.js';

function makeMessage(overrides: Partial<SubstrateMessage> = {}): SubstrateMessage {
  return {
    id: 'msg-1',
    channelId: 'discord-channel',
    channelType: 'discord',
    authorId: 'user-1',
    authorName: 'Alex',
    content: 'My little satellite',
    timestamp: new Date(),
    attachments: [{
      url: 'https://media.discordapp.net/attachments/a/b/current-photo.jpg?width=1024&height=768',
      contentType: 'image/jpeg',
      name: 'current-photo.jpg',
    }],
    ...overrides,
  };
}

function makeReviewer(summary = 'A catgirl sits on a server rack holding a pink rifle.'): {
  reviewer: ImageVisionReviewer;
  analyze: ReturnType<typeof vi.fn>;
} {
  const analyze = vi.fn(async () => ({
    question: 'Describe exactly what is visible in the current image input.',
    summary,
    model: 'vision-model',
    imageCount: 1,
  }));
  return {
    reviewer: { analyze },
    analyze,
  };
}

describe('buildTurnUserContent', () => {
  it('routes current-turn attachments through the dedicated reviewer path', async () => {
    const { reviewer, analyze } = makeReviewer();
    const result = await buildTurnUserContent({
      message: makeMessage(),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger: {
        warn: vi.fn(),
        debug: vi.fn(),
      },
      visionReviewer: reviewer,
    });

    expect(typeof result.content).toBe('string');
    expect(result.content).toContain('dedicated vision pipeline');
    expect(result.content).toContain('Current image review: A catgirl sits on a server rack holding a pink rifle.');
    expect(result.content).toContain('User text: My little satellite');
    expect(result.currentTurnVisionReview).toEqual({
      imageUrls: ['https://media.discordapp.net/attachments/a/b/current-photo.jpg?width=1024&height=768'],
      question: 'Describe exactly what is visible in the current image input.',
      summary: 'A catgirl sits on a server rack holding a pink rifle.',
    });
    expect(analyze).toHaveBeenCalledWith({
      imageUrls: ['https://media.discordapp.net/attachments/a/b/current-photo.jpg?width=1024&height=768'],
      question: 'Describe exactly what is visible in the current image input. Be concrete and concise. Ignore prior conversation or earlier image descriptions.',
    });
  });

  it('does not treat pasted image urls as automatic current-turn vision input without attachments', async () => {
    const imageUrl = 'https://cdn.discordapp.com/attachments/a/b/current-photo.png?ex=fresh';
    const { reviewer, analyze } = makeReviewer('A close-up portrait with blue eyes and white hair.');
    const result = await buildTurnUserContent({
      message: makeMessage({
        content: imageUrl,
        attachments: [],
      }),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger: {
        warn: vi.fn(),
        debug: vi.fn(),
      },
      visionReviewer: reviewer,
    });

    expect(hasVisionTurnInputs(makeMessage({
      content: imageUrl,
      attachments: [],
    }))).toBe(false);
    expect(result.content).toBe(imageUrl);
    expect(result.currentTurnVisionReview).toBeUndefined();
    expect(analyze).not.toHaveBeenCalled();
  });

  it('strips attachment urls out of mixed semantic text before building response context', async () => {
    const imageUrl = 'https://media.discordapp.net/attachments/a/b/current-photo.jpg?width=1024&height=768';
    const { reviewer } = makeReviewer();
    const result = await buildTurnUserContent({
      message: makeMessage({
        content: `ok love lets see if you can see ${imageUrl}`,
      }),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger: {
        warn: vi.fn(),
        debug: vi.fn(),
      },
      visionReviewer: reviewer,
    });

    expect(result.content).toContain('User text: ok love lets see if you can see');
    expect(result.content).not.toContain(imageUrl);
  });

  it('fails closed when the dedicated reviewer errors', async () => {
    const result = await buildTurnUserContent({
      message: makeMessage(),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger: {
        warn: vi.fn(),
        debug: vi.fn(),
      },
      visionReviewer: {
        analyze: vi.fn(async () => {
          throw new Error('vision fetch failed for current-photo.jpg: 404 Not Found');
        }),
      },
    });

    expect(result.content).toContain('dedicated vision pipeline failed');
    expect(result.content).toContain('You cannot reliably see the current image');
    expect(result.content).toContain('404 Not Found');
    expect(result.content).toContain('User text: My little satellite');
    expect(result.currentTurnVisionReview).toBeUndefined();
  });

  it('retries transient dedicated reviewer failures before degrading', async () => {
    const analyze = vi.fn()
      .mockRejectedValueOnce(new Error('vision provider returned empty text'))
      .mockRejectedValueOnce(new Error('vision provider timed out'))
      .mockResolvedValueOnce({
        question: 'Describe exactly what is visible in the current image input.',
        summary: 'A photo of a white-haired companion holding a tablet.',
        model: 'fallback-vision-model',
        imageCount: 1,
      });
    const logger = {
      warn: vi.fn(),
      debug: vi.fn(),
    };

    const result = await buildTurnUserContent({
      message: makeMessage(),
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger,
      visionReviewer: { analyze },
    });

    expect(analyze).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(result.content).toContain('Current image review: A photo of a white-haired companion holding a tablet.');
    expect(result.currentTurnVisionReview).toEqual({
      imageUrls: ['https://media.discordapp.net/attachments/a/b/current-photo.jpg?width=1024&height=768'],
      question: 'Describe exactly what is visible in the current image input.',
      summary: 'A photo of a white-haired companion holding a tablet.',
    });
  });

  it('keeps the multimodal fallback path when no reviewer is wired', async () => {
    const result = await buildTurnUserContent({
      message: makeMessage(),
      llmClient: {
        webFetchBinary: vi.fn(async () => ({
          dataBase64: 'YWJjZA==',
          mimeType: 'image/jpeg',
          sizeBytes: 4,
        })),
      } as any,
      runtimeMode: 'gateway',
      logger: {
        warn: vi.fn(),
        debug: vi.fn(),
      },
    });

    expect(Array.isArray(result.content)).toBe(true);
    const blocks = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(blocks[0]?.type).toBe('text');
    expect(blocks[1]).toEqual({
      type: 'image',
      data: 'YWJjZA==',
      mimeType: 'image/jpeg',
    });
  });

  it('routes inline base64 images directly to the multimodal prompt path', async () => {
    const { reviewer, analyze } = makeReviewer();
    const message = makeMessage({
      attachments: [{
        url: 'inline:image:0',
        contentType: 'image/jpeg',
        name: 'vam-screen.jpg',
        dataBase64: 'YWJjZA==',
      }],
    });

    expect(hasVisionTurnInputs(message)).toBe(true);
    expect(collectVisionTurnImageUrls(message)).toEqual(['inline:image:0']);

    const result = await buildTurnUserContent({
      message,
      llmClient: {} as any,
      runtimeMode: 'gateway',
      logger: {
        warn: vi.fn(),
        debug: vi.fn(),
      },
      visionReviewer: reviewer,
    });

    expect(analyze).not.toHaveBeenCalled();
    expect(Array.isArray(result.content)).toBe(true);
    const blocks = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(blocks[0]?.type).toBe('text');
    expect(blocks[1]).toEqual({
      type: 'image',
      data: 'YWJjZA==',
      mimeType: 'image/jpeg',
    });
  });
});
