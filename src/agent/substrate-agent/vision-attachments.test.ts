import { describe, expect, it, vi } from 'vitest';
import type { ImageVisionReviewer } from '../../images/types.js';
import type { SubstrateMessage } from '../../types.js';
import {
  buildTurnUserContent,
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

    expect(typeof result).toBe('string');
    expect(result).toContain('dedicated vision pipeline');
    expect(result).toContain('Current image review: A catgirl sits on a server rack holding a pink rifle.');
    expect(result).toContain('User text: My little satellite');
    expect(analyze).toHaveBeenCalledWith({
      imageUrls: ['https://media.discordapp.net/attachments/a/b/current-photo.jpg?width=1024&height=768'],
      question: 'Describe exactly what is visible in the current image input. Be concrete and concise. Ignore prior conversation or earlier image descriptions.',
    });
  });

  it('routes pasted image urls through the dedicated reviewer path even without attachments', async () => {
    const imageUrl = 'https://cdn.discordapp.com/attachments/a/b/current-photo.png?ex=fresh';
    const { reviewer } = makeReviewer('A close-up portrait with blue eyes and white hair.');
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
    }))).toBe(true);
    expect(result).toContain('Current image review: A close-up portrait with blue eyes and white hair.');
    expect(result).not.toContain(imageUrl);
    expect(result).not.toContain('User text:');
  });

  it('strips current-turn image urls out of mixed semantic text before building response context', async () => {
    const imageUrl = 'https://cdn.discordapp.com/attachments/a/b/current-photo.png?ex=fresh';
    const { reviewer } = makeReviewer();
    const result = await buildTurnUserContent({
      message: makeMessage({
        content: `ok love lets see if you can see ${imageUrl}`,
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

    expect(result).toContain('User text: ok love lets see if you can see');
    expect(result).not.toContain(imageUrl);
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

    expect(result).toContain('dedicated vision pipeline failed');
    expect(result).toContain('You cannot reliably see the current image');
    expect(result).toContain('404 Not Found');
    expect(result).toContain('User text: My little satellite');
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

    expect(Array.isArray(result)).toBe(true);
    const blocks = result as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(blocks[0]?.type).toBe('text');
    expect(blocks[1]).toEqual({
      type: 'image',
      data: 'YWJjZA==',
      mimeType: 'image/jpeg',
    });
  });
});
