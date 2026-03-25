import { describe, expect, it, vi } from 'vitest';
import type { SubstrateMessage } from '../../types.js';
import { buildTurnUserContent } from './vision-attachments.js';

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
    const blocks = result as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(blocks[0]?.type).toBe('text');
    expect(blocks[0]?.text).toContain('Runtime note');
    expect(blocks[0]?.text).toContain('ground your reply in what is actually visible');
    expect(blocks[0]?.text).toContain('User text: My little satellite');
    expect(blocks[1]).toEqual({
      type: 'image',
      data: 'YWJjZA==',
      mimeType: 'image/jpeg',
    });
  });

  it('surfaces attachment resolution failures as a runtime note when the current attachment cannot be resolved', async () => {
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

    expect(result).toContain('Runtime note');
    expect(result).toContain('could not load their image bytes');
    expect(result).toContain('Do not pretend you saw them');
    expect(result).toContain('404 Not Found');
    expect(result).toContain('User text: My little satellite');
  });

  it('treats transport placeholder text as metadata and grounds image-only turns on the current attachment', async () => {
    const result = await buildTurnUserContent({
      message: makeMessage({
        content: '(image attachment)',
      }),
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

    const blocks = result as Array<{ type: string; text?: string }>;
    expect(blocks[0]?.text).toContain('transport metadata');
    expect(blocks[0]?.text).not.toContain('User text:');
  });

  it('treats pasted current-turn CDN URLs as transport metadata instead of semantic text', async () => {
    const attachmentUrl = 'https://media.discordapp.net/attachments/a/b/current-photo.jpg?width=1024&height=768';
    const result = await buildTurnUserContent({
      message: makeMessage({
        content: attachmentUrl,
      }),
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

    const blocks = result as Array<{ type: string; text?: string }>;
    expect(blocks[0]?.text).toContain('transport metadata');
    expect(blocks[0]?.text).not.toContain(`User text: ${attachmentUrl}`);
  });
});
