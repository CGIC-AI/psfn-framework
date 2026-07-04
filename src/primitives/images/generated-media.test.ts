import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import {
  collectGeneratedImageAttachments,
  summarizeChargedImageDeliverables,
} from './generated-media.js';
import { resolveGeneratedImagesDir } from '../../persistence/layout.js';

describe('collectGeneratedImageAttachments', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('persists generated image tool results into companion storage', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-generated-media-'));
    tempDirs.push(companionDataDir);

    const attachments = await collectGeneratedImageAttachments({
      companionDataDir,
      galleryContext: {
        channelId: 'discord:gallery',
        channelType: 'discord',
        turnId: 'turn-gallery-1',
        requestId: 'turn-request-1',
        sourceMessageId: 'message-gallery-1',
        userSessionEntryId: 42,
      },
      turnMessages: [
        {
          role: 'toolResult',
          toolName: 'selfie_create',
          toolCallId: 'call-gallery-1',
          content: [{
            type: 'text',
            text: JSON.stringify({
              provider: 'fal',
              mode: 'create',
              requestId: 'req-123',
              fallbackUsed: false,
              images: [
                {
                  url: 'https://images.example.test/purr.png',
                  contentType: 'image/png',
                  fileName: 'purr.png',
                },
              ],
            }),
          }],
        } as any,
      ],
      fetchImpl: async () => (
        new Response(Buffer.from('png-bytes'), {
          status: 200,
          headers: {
            'content-type': 'image/png',
          },
        })
      ) as Response,
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.url).toBe('https://images.example.test/purr.png');
    expect(attachments[0]?.contentType).toBe('image/png');
    expect(attachments[0]?.name).toBe('purr.png');
    expect(attachments[0]?.localPath).toBeTruthy();
    expect(existsSync(attachments[0]!.localPath!)).toBe(true);
    expect(readFileSync(attachments[0]!.localPath!)).toEqual(Buffer.from('png-bytes'));
    const metadata = JSON.parse(readFileSync(`${attachments[0]!.localPath!}.image-meta.json`, 'utf-8')) as {
      sourceToolName: string;
      toolCallId: string;
      requestId: string;
      originalUrl: string;
      conversation: {
        channelId: string;
        turnId: string;
        userSessionEntryId: number;
      };
      artifactRefs: Array<{ kind: string; url: string; localPath: string }>;
    };
    expect(metadata).toMatchObject({
      sourceToolName: 'selfie_create',
      toolCallId: 'call-gallery-1',
      requestId: 'req-123',
      originalUrl: 'https://images.example.test/purr.png',
      conversation: {
        channelId: 'discord:gallery',
        turnId: 'turn-gallery-1',
        userSessionEntryId: 42,
      },
    });
    expect(metadata.artifactRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'shared_image',
        url: 'https://images.example.test/purr.png',
        localPath: attachments[0]!.localPath,
      }),
    ]));
  });

  it('uses structured media tool details when available', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-generated-media-'));
    tempDirs.push(companionDataDir);

    const attachments = await collectGeneratedImageAttachments({
      companionDataDir,
      turnMessages: [
        {
          role: 'toolResult',
          toolName: 'media',
          content: [{ type: 'text', text: 'not-json' }],
          details: {
            mediaResult: {
              provider: 'fal',
              mode: 'create',
              requestId: 'req-456',
              fallbackUsed: false,
              images: [
                {
                  url: 'https://images.example.test/purr-2.png',
                  contentType: 'image/png',
                  fileName: 'purr-2.png',
                },
              ],
            },
          },
        } as any,
      ],
      fetchImpl: async () => (
        new Response(Buffer.from('png-two'), {
          status: 200,
          headers: {
            'content-type': 'image/png',
          },
        })
      ) as Response,
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.url).toBe('https://images.example.test/purr-2.png');
    expect(attachments[0]?.name).toBe('purr-2.png');
    expect(readFileSync(attachments[0]!.localPath!)).toEqual(Buffer.from('png-two'));
  });

  it('uses structured unified media tool details when available', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-generated-media-'));
    tempDirs.push(companionDataDir);

    const attachments = await collectGeneratedImageAttachments({
      companionDataDir,
      turnMessages: [
        {
          role: 'toolResult',
          toolName: 'media',
          content: [{ type: 'text', text: 'not-json' }],
          details: {
            mediaResult: {
              provider: 'fal',
              mode: 'edit',
              requestId: 'req-789',
              fallbackUsed: false,
              images: [
                {
                  url: 'https://images.example.test/purr-3.png',
                  contentType: 'image/png',
                  fileName: 'purr-3.png',
                },
              ],
            },
          },
        } as any,
      ],
      fetchImpl: async () => (
        new Response(Buffer.from('png-three'), {
          status: 200,
          headers: {
            'content-type': 'image/png',
          },
        })
      ) as Response,
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.url).toBe('https://images.example.test/purr-3.png');
    expect(attachments[0]?.name).toBe('purr-3.png');
    expect(readFileSync(attachments[0]!.localPath!)).toEqual(Buffer.from('png-three'));
  });

  it('reuses existing local paths from generated media results instead of downloading again', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-generated-media-'));
    const personalDir = mkdtempSync(join(tmpdir(), 'psfn-personal-images-'));
    tempDirs.push(companionDataDir, personalDir);
    const localPath = join(personalDir, 'purr-existing.png');

    const attachments = await collectGeneratedImageAttachments({
      companionDataDir,
      turnMessages: [
        {
          role: 'toolResult',
          toolName: 'media',
          content: [{
            type: 'text',
            text: JSON.stringify({
              provider: 'fal',
              mode: 'create',
              images: [
                {
                  url: 'https://images.example.test/purr-existing.png',
                  contentType: 'image/png',
                  fileName: 'purr-existing.png',
                  localPath,
                },
              ],
            }),
          }],
        } as any,
      ],
      fetchImpl: async () => {
        throw new Error('fetch should not be called for existing local image paths');
      },
    });

    expect(attachments).toEqual([
      {
        url: 'https://images.example.test/purr-existing.png',
        contentType: 'image/png',
        name: 'purr-existing.png',
        localPath,
      },
    ]);
    expect(existsSync(resolveGeneratedImagesDir(companionDataDir))).toBe(false);
  });

  it('ignores non-image tool results and malformed payloads', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-generated-media-'));
    tempDirs.push(companionDataDir);

    const attachments = await collectGeneratedImageAttachments({
      companionDataDir,
      turnMessages: [
        {
          role: 'toolResult',
          toolName: 'shell_exec',
          content: [{ type: 'text', text: '{"ok":true}' }],
        } as any,
        {
          role: 'toolResult',
          toolName: 'media',
          content: [{ type: 'text', text: 'not json' }],
        } as any,
      ],
    });

    expect(attachments).toEqual([]);
  });
});

describe('summarizeChargedImageDeliverables', () => {
  it('summarizes paid fal image tool results', () => {
    const summaries = summarizeChargedImageDeliverables([
      {
        role: 'toolResult',
        toolName: 'selfie_create',
        toolCallId: 'call-paid-1',
        isError: false,
        details: {
          imageResult: {
            provider: 'fal',
            mode: 'create',
            requestId: 'req-paid-1',
            fallbackUsed: false,
            images: [
              { url: 'https://images.example.test/a.png', fileName: 'a.png' },
              { url: 'https://images.example.test/b.png', fileName: 'b.png' },
            ],
          },
        },
      } as any,
    ]);

    expect(summaries).toEqual([{
      toolName: 'selfie_create',
      toolCallId: 'call-paid-1',
      requestId: 'req-paid-1',
      imageCount: 2,
    }]);
  });

  it('excludes free comfyui, errored, and non-image results', () => {
    const summaries = summarizeChargedImageDeliverables([
      {
        role: 'toolResult',
        toolName: 'media',
        toolCallId: 'call-free',
        isError: false,
        details: {
          mediaResult: {
            provider: 'comfyui',
            mode: 'create',
            fallbackUsed: false,
            images: [{ url: 'https://images.example.test/free.png', fileName: 'free.png' }],
          },
        },
      } as any,
      {
        role: 'toolResult',
        toolName: 'selfie_create',
        toolCallId: 'call-errored',
        isError: true,
        details: {
          imageResult: {
            provider: 'fal',
            mode: 'create',
            fallbackUsed: false,
            images: [{ url: 'https://images.example.test/errored.png', fileName: 'errored.png' }],
          },
        },
      } as any,
      {
        role: 'toolResult',
        toolName: 'scratchpad',
        toolCallId: 'call-other',
        isError: false,
        content: [{ type: 'text', text: 'unrelated' }],
      } as any,
    ]);

    expect(summaries).toEqual([]);
  });
});
