import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import {
  collectGeneratedImageAttachments,
  mergeChargedImageDeliverableSummaries,
  summarizeChargedImageDeliverables,
  summarizePendingPaidImageDeliverables,
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

  it('attaches generate_image results from structured tool details', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-generated-media-'));
    tempDirs.push(companionDataDir);

    const attachments = await collectGeneratedImageAttachments({
      companionDataDir,
      turnMessages: [
        {
          role: 'toolResult',
          toolName: 'generate_image',
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

  it('still attaches legacy media turn-record results (retired name)', async () => {
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

  it('recovers paid image attachments from tracked deliverables when turn messages miss the tool result', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-generated-media-'));
    const personalDir = mkdtempSync(join(tmpdir(), 'psfn-personal-images-'));
    tempDirs.push(companionDataDir, personalDir);
    const localPath = join(personalDir, 'missed-transcript.jpg');

    const attachments = await collectGeneratedImageAttachments({
      companionDataDir,
      turnMessages: [],
      paidDeliverables: [{
        surface: 'paidImageGeneration',
        toolName: 'selfie_create',
        toolCallId: 'call-missed-transcript',
        identifier: 'req-missed-transcript',
        artifactCount: 1,
        artifactKind: 'image',
        provider: 'fal',
        mode: 'edit',
        model: 'xai/grok-imagine-image/quality/edit',
        artifacts: [{
          url: 'https://images.example.test/missed-transcript.jpg',
          contentType: 'image/jpeg',
          fileName: 'missed-transcript.jpg',
          localPath,
        }],
      }],
      galleryContext: {
        channelId: 'discord:gallery',
        channelType: 'discord',
        turnId: 'turn-missed-transcript',
        requestId: 'request-missed-transcript',
        sourceMessageId: 'message-missed-transcript',
      },
      fetchImpl: async () => {
        throw new Error('fetch should not be called for tracked local image artifacts');
      },
    });

    expect(attachments).toEqual([{
      url: 'https://images.example.test/missed-transcript.jpg',
      contentType: 'image/jpeg',
      name: 'missed-transcript.jpg',
      localPath,
    }]);
    const metadata = JSON.parse(readFileSync(`${localPath}.image-meta.json`, 'utf-8')) as {
      toolCallId: string;
      requestId: string;
      conversation: { requestId: string; turnId: string };
    };
    expect(metadata).toMatchObject({
      toolCallId: 'call-missed-transcript',
      requestId: 'req-missed-transcript',
      conversation: {
        requestId: 'request-missed-transcript',
        turnId: 'turn-missed-transcript',
      },
    });
  });

  it('dedupes tracked paid deliverables that are already present in turn messages', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-generated-media-'));
    tempDirs.push(companionDataDir);

    const attachments = await collectGeneratedImageAttachments({
      companionDataDir,
      turnMessages: [
        {
          role: 'toolResult',
          toolName: 'selfie_create',
          toolCallId: 'call-dedupe',
          details: {
            imageResult: {
              provider: 'fal',
              mode: 'edit',
              requestId: 'req-dedupe',
              fallbackUsed: false,
              images: [{
                url: 'https://images.example.test/dedupe.jpg',
                contentType: 'image/jpeg',
                fileName: 'dedupe.jpg',
              }],
            },
          },
          content: [],
        } as any,
      ],
      paidDeliverables: [{
        surface: 'paidImageGeneration',
        toolName: 'selfie_create',
        toolCallId: 'call-dedupe',
        identifier: 'req-dedupe',
        artifactCount: 1,
        artifactKind: 'image',
        provider: 'fal',
        mode: 'edit',
        artifacts: [{
          url: 'https://images.example.test/dedupe.jpg',
          contentType: 'image/jpeg',
          fileName: 'dedupe.jpg',
        }],
      }],
      fetchImpl: async () => (
        new Response(Buffer.from('jpg-dedupe'), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      ) as Response,
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.name).toBe('dedupe.jpg');
    expect(readFileSync(attachments[0]!.localPath!)).toEqual(Buffer.from('jpg-dedupe'));
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

  it('summarizes tracked paid image deliverables and merges them with transcript summaries', () => {
    const pendingSummaries = summarizePendingPaidImageDeliverables([{
      surface: 'paidImageGeneration',
      toolName: 'selfie_create',
      toolCallId: 'call-tracked',
      identifier: 'req-tracked',
      artifactCount: 1,
      artifactKind: 'image',
      provider: 'fal',
      mode: 'edit',
      artifacts: [{
        url: 'https://images.example.test/tracked.jpg',
        fileName: 'tracked.jpg',
      }],
    }]);

    expect(pendingSummaries).toEqual([{
      toolName: 'selfie_create',
      toolCallId: 'call-tracked',
      requestId: 'req-tracked',
      imageCount: 1,
    }]);
    expect(mergeChargedImageDeliverableSummaries(
      [{ toolName: 'selfie_create', toolCallId: 'call-tracked', requestId: 'req-tracked', imageCount: 1 }],
      pendingSummaries,
    )).toEqual([{
      toolName: 'selfie_create',
      toolCallId: 'call-tracked',
      requestId: 'req-tracked',
      imageCount: 1,
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
