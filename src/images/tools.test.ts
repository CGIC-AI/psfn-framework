import { describe, expect, it, vi } from 'vitest';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import { runWithVisionToolRequestContext } from './request-context.js';
import { createMediaTool } from './tools.js';
import {
  IMAGE_ASPECT_RATIO_VALUES,
  type ImageVisionReviewer,
  type MediaToolResultDetails,
} from './types.js';

function resultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function readActions(tool: ReturnType<typeof createMediaTool>): string[] {
  const schema = (tool.parameters as {
    properties?: Record<string, { anyOf?: Array<{ const?: string }> }>;
  }).properties?.action;
  return (schema?.anyOf ?? [])
    .map((entry) => entry.const)
    .filter((value): value is string => typeof value === 'string');
}

function readAspectRatios(tool: ReturnType<typeof createMediaTool>): string[] {
  const schema = (tool.parameters as {
    properties?: Record<string, { anyOf?: Array<{ const?: string }> }>;
  }).properties?.aspect_ratio;
  return (schema?.anyOf ?? [])
    .map((entry) => entry.const)
    .filter((value): value is string => typeof value === 'string');
}

describe('media tool', () => {
  it('exposes generate, edit, and analyze actions and constrains aspect_ratio to supported presets', () => {
    const tool = createMediaTool({
      create: vi.fn(),
      edit: vi.fn(),
    });

    expect(readActions(tool)).toEqual(['generate', 'edit', 'analyze']);
    expect(readAspectRatios(tool)).toEqual([...IMAGE_ASPECT_RATIO_VALUES]);
  });

  it('returns generated media results plus an in-turn vision review for generate', async () => {
    const ops = {
      create: vi.fn(async () => ({
        provider: 'fal',
        mode: 'create' as const,
        model: 'fal-ai/nano-banana-2',
        fallbackUsed: false,
        requestId: 'req-vision-1',
        images: [{
          url: 'https://images.example.test/selfie.png',
          contentType: 'image/png',
          fileName: 'selfie.png',
        }],
      })),
      edit: vi.fn(),
    };
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'Describe the generated image.',
        summary: 'The selfie matches the companion look and reads as cute and consistent.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };

    const tool = createMediaTool(ops, reviewer);
    const result = await tool.execute('tool-call-1', {
      action: 'generate',
      prompt: 'a cute mirror selfie of me in warm morning light',
      aspect_ratio: '3:4',
    }) as AgentToolResult<MediaToolResultDetails>;

    expect(ops.create).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'a cute mirror selfie of me in warm morning light',
      aspectRatio: '3:4',
    }));
    expect(reviewer.analyze).toHaveBeenCalledWith({
      imageUrls: ['https://images.example.test/selfie.png'],
      prompt: 'a cute mirror selfie of me in warm morning light',
      mode: 'create',
    });
    expect(result.details.mediaResult?.requestId).toBe('req-vision-1');
    expect(result.details.visionReview?.summary).toContain('matches the companion look');
    expect(resultText(result)).toContain('"requestId": "req-vision-1"');
    expect(resultText(result)).toContain('Vision review:');
  });

  it('routes edit requests through the same media surface', async () => {
    const ops = {
      create: vi.fn(),
      edit: vi.fn(async () => ({
        provider: 'fal',
        mode: 'edit' as const,
        model: 'fal-ai/nano-banana-2/edit',
        fallbackUsed: false,
        requestId: 'req-edit-1',
        images: [{
          url: 'https://images.example.test/edited.png',
          contentType: 'image/png',
          fileName: 'edited.png',
        }],
      })),
    };
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'Describe the edited image.',
        summary: 'The edit keeps the same identity while shifting the scene to sunset.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };

    const tool = createMediaTool(ops, reviewer);
    const result = await tool.execute('tool-call-edit', {
      action: 'edit',
      prompt: 'turn this into a sunset selfie while keeping my identity the same',
      input_urls: ['https://images.example.test/original.png'],
      aspect_ratio: '3:4',
    }) as AgentToolResult<MediaToolResultDetails>;

    expect(ops.edit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'turn this into a sunset selfie while keeping my identity the same',
      imageUrls: ['https://images.example.test/original.png'],
      aspectRatio: '3:4',
    }));
    expect(reviewer.analyze).toHaveBeenCalledWith({
      imageUrls: ['https://images.example.test/edited.png'],
      prompt: 'turn this into a sunset selfie while keeping my identity the same',
      mode: 'edit',
    });
    expect(result.details.mediaResult?.requestId).toBe('req-edit-1');
    expect(result.details.visionReview?.summary).toContain('same identity');
  });

  it('exposes analyze as a callable media action', async () => {
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'Does this still look like me?',
        summary: 'Yes. The appearance is consistent and the lighting is the main visible change.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };

    const tool = createMediaTool({
      create: vi.fn(),
      edit: vi.fn(),
    }, reviewer);
    const result = await tool.execute('tool-call-2', {
      action: 'analyze',
      input_urls: ['https://images.example.test/review.png'],
      question: 'Does this still look like me?',
    }) as AgentToolResult<MediaToolResultDetails>;

    expect(reviewer.analyze).toHaveBeenCalledWith({
      imageUrls: ['https://images.example.test/review.png'],
      question: 'Does this still look like me?',
    });
    expect(result.details.visionReview?.model).toBe('vision-model');
    expect(resultText(result)).toContain('Vision review:');
    expect(resultText(result)).toContain('appearance is consistent');
  });

  it('reuses the current-turn vision review when analyze is called with a mismatched stale url', async () => {
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'Does this still look like me?',
        summary: 'Should not be reached.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };

    const tool = createMediaTool({
      create: vi.fn(),
      edit: vi.fn(),
    }, reviewer);
    const result = await runWithVisionToolRequestContext(
      {
        userMessageText: 'did you not see the image?',
        imageAttachmentUrls: [
          'https://files.example.test/uploads/current-image.png?token=fresh',
        ],
        currentTurnVisionReview: {
          imageUrls: ['https://files.example.test/uploads/current-image.png?token=fresh'],
          question: 'Describe exactly what is visible in the current image input.',
          summary: 'A catgirl sits on a server rack holding a pink rifle.',
        },
      },
      async () => tool.execute('tool-call-3', {
        action: 'analyze',
        input_urls: [
          'https://files.example.test/uploads/other-image.png?token=stale',
        ],
        question: 'Does this still look like me?',
      }) as Promise<AgentToolResult<MediaToolResultDetails>>,
    );

    expect(reviewer.analyze).not.toHaveBeenCalled();
    expect(result.details.visionReview?.summary).toBe('A catgirl sits on a server rack holding a pink rifle.');
    expect(result.details.visionReviewError).toBeUndefined();
    expect(resultText(result)).toContain('Vision review:');
    expect(resultText(result)).toContain('server rack holding a pink rifle');
  });

  it('still blocks mismatched image urls when no current-turn review is available', async () => {
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'Should not be reached.',
        summary: 'Should not be reached.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };

    const tool = createMediaTool({
      create: vi.fn(),
      edit: vi.fn(),
    }, reviewer);
    const result = await runWithVisionToolRequestContext(
      {
        userMessageText: 'did you not see the image?',
        imageAttachmentUrls: [
          'https://files.example.test/uploads/current-image.png?token=fresh',
        ],
      },
      async () => tool.execute('tool-call-3b', {
        action: 'analyze',
        input_urls: [
          'https://files.example.test/uploads/other-image.png?token=stale',
        ],
        question: 'Does this still look like me?',
      }) as Promise<AgentToolResult<MediaToolResultDetails>>,
    );

    expect(reviewer.analyze).not.toHaveBeenCalled();
    expect(result.details.visionReview).toBeUndefined();
    expect(result.details.visionReviewError).toContain('live image attachment bytes');
    expect(resultText(result)).toContain('may be stale or refer to a different image');
  });

  it('allows an explicit current-message url even when the turn also has a live attachment', async () => {
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'What is in this image?',
        summary: 'A cozy desk setup.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };
    const explicitUrl = 'https://images.example.test/review/explicit-image.png?token=current';

    const tool = createMediaTool({
      create: vi.fn(),
      edit: vi.fn(),
    }, reviewer);
    const result = await runWithVisionToolRequestContext(
      {
        userMessageText: explicitUrl,
        imageAttachmentUrls: [
          'https://files.example.test/uploads/current-attachment.png?token=fresh',
        ],
      },
      async () => tool.execute('tool-call-4', {
        action: 'analyze',
        input_urls: [explicitUrl],
        question: 'What is in this image?',
      }) as Promise<AgentToolResult<MediaToolResultDetails>>,
    );

    expect(reviewer.analyze).toHaveBeenCalledWith({
      imageUrls: [explicitUrl],
      question: 'What is in this image?',
    });
    expect(result.details.visionReview?.summary).toContain('cozy desk setup');
  });
});
