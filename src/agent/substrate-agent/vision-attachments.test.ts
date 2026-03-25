import { describe, expect, it, vi } from 'vitest';
import type { SubstrateMessage } from '../../types.js';
import { buildTurnUserContent } from './vision-attachments.js';

function makeMessage(overrides: Partial<SubstrateMessage> = {}): SubstrateMessage {
  return {
    id: 'msg-1',
    channelId: 'discord-channel',
    channelType: 'discord',
    authorId: 'user-1',
    authorName: 'Operator',
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

describe('buildTurnUserContent', () => {
  it('instructs the model to inspect the current live attachment directly', async () => {
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
    expect(result).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('Do not call image_analyze for the current attachment'),
      },
      {
        type: 'image',
        data: 'YWJjZA==',
        mimeType: 'image/jpeg',
      },
    ]);
    expect((result as Array<{ type: string; text?: string }>)[0].text).toContain('My little satellite');
  });

  it('falls back to plain text when the current attachment cannot be resolved', async () => {
    const result = await buildTurnUserContent({
      message: makeMessage(),
      llmClient: {
        webFetchBinary: vi.fn(async () => {
          throw new Error('404 Not Found');
        }),
      } as any,
      runtimeMode: 'gateway',
      logger: {
        warn: vi.fn(),
        debug: vi.fn(),
      },
    });

    expect(result).toBe('My little satellite');
  });
});
