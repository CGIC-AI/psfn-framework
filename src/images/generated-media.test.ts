import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import { collectGeneratedImageAttachments } from './generated-media.js';

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
      turnMessages: [
        {
          role: 'toolResult',
          toolName: 'image_create',
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
  });

  it('uses structured image tool details when available', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-generated-media-'));
    tempDirs.push(companionDataDir);

    const attachments = await collectGeneratedImageAttachments({
      companionDataDir,
      turnMessages: [
        {
          role: 'toolResult',
          toolName: 'image_create',
          content: [{ type: 'text', text: 'not-json' }],
          details: {
            imageResult: {
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
          toolName: 'image_create',
          content: [{ type: 'text', text: 'not json' }],
        } as any,
      ],
    });

    expect(attachments).toEqual([]);
  });
});
