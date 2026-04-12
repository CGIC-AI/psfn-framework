import { describe, expect, it, vi } from 'vitest';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import { runWithVisionToolRequestContext } from './request-context.js';
import { createImageAnalyzeTool, createImageCreateTool, createImageEditTool, createMediaTool, createSelfieTool } from './tools.js';
import { IMAGE_ASPECT_RATIO_VALUES, type ImageToolResultDetails, type ImageVisionReviewer, type MediaToolResultDetails } from './types.js';

function resultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function readAspectRatios(tool: ReturnType<typeof createImageCreateTool> | ReturnType<typeof createImageEditTool>): string[] {
  const schema = (tool.parameters as {
    properties?: Record<string, { anyOf?: Array<{ const?: string }> }>;
  }).properties?.aspect_ratio;
  return (schema?.anyOf ?? [])
    .map((entry) => entry.const)
    .filter((value): value is string => typeof value === 'string');
}

function readActions(tool: ReturnType<typeof createMediaTool>): string[] {
  const schema = (tool.parameters as {
    properties?: Record<string, { anyOf?: Array<{ const?: string }> }>;
  }).properties?.action;
  return (schema?.anyOf ?? [])
    .map((entry) => entry.const)
    .filter((value): value is string => typeof value === 'string');
}

describe('image tools', () => {
  it('exposes generate, edit, and analyze actions on the unified media surface', () => {
    const tool = createMediaTool({
      create: vi.fn(),
      edit: vi.fn(),
    });

    expect(readActions(tool)).toEqual(['generate', 'edit', 'analyze']);
  });

  it('returns generated media results plus an in-turn vision review from the unified media tool', async () => {
    const ops = {
      create: vi.fn(async () => ({
        provider: 'fal',
        mode: 'create' as const,
        model: 'fal-ai/nano-banana-2',
        fallbackUsed: false,
        requestId: 'req-media-1',
        images: [{
          url: 'https://images.example.test/media-selfie.png',
          contentType: 'image/png',
          fileName: 'media-selfie.png',
          localPath: '/tmp/media-selfie.png',
        }],
      })),
      edit: vi.fn(),
    };
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'Describe the generated image.',
        summary: 'The portrait reads as consistent and well lit.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };

    const tool = createMediaTool(ops, reviewer);
    const result = await tool.execute('tool-call-media-generate', {
      action: 'generate',
      prompt: 'a cinematic portrait in warm morning light',
      aspect_ratio: '3:4',
    }) as AgentToolResult<MediaToolResultDetails>;

    expect(ops.create).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'a cinematic portrait in warm morning light',
      aspectRatio: '3:4',
    }));
    expect(reviewer.analyze).toHaveBeenCalledWith({
      imageUrls: ['https://images.example.test/media-selfie.png'],
      imageLocalPaths: ['/tmp/media-selfie.png'],
      prompt: 'a cinematic portrait in warm morning light',
      mode: 'create',
    });
    expect(result.details.mediaResult?.requestId).toBe('req-media-1');
    expect(result.details.visionReview?.summary).toContain('consistent');
  });

  it('analyzes images through the unified media tool', async () => {
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'What is in this image?',
        summary: 'A cozy desk setup.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };

    const tool = createMediaTool({
      create: vi.fn(),
      edit: vi.fn(),
    }, reviewer);
    const result = await tool.execute('tool-call-media-analyze', {
      action: 'analyze',
      input_urls: ['https://images.example.test/review.png'],
      question: 'What is in this image?',
    }) as AgentToolResult<MediaToolResultDetails>;

    expect(reviewer.analyze).toHaveBeenCalledWith({
      imageUrls: ['https://images.example.test/review.png'],
      question: 'What is in this image?',
    });
    expect(result.details.visionReview?.summary).toContain('cozy desk setup');
  });

  it('constrains aspect_ratio to the supported preset list for create and edit', () => {
    const createTool = createImageCreateTool({
      create: vi.fn(),
      edit: vi.fn(),
    });
    const editTool = createImageEditTool({
      create: vi.fn(),
      edit: vi.fn(),
    });

    expect(readAspectRatios(createTool)).toEqual([...IMAGE_ASPECT_RATIO_VALUES]);
    expect(readAspectRatios(editTool)).toEqual([...IMAGE_ASPECT_RATIO_VALUES]);
  });

  it('returns generated image results plus an in-turn vision review', async () => {
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
          localPath: '/tmp/selfie.png',
        }],
      })),
      edit: vi.fn(),
    };
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'Describe the generated image.',
        summary: 'The portrait reads as cute and visually consistent.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };

    const tool = createImageCreateTool(ops, reviewer);
    const result = await tool.execute('tool-call-1', {
      prompt: 'a cozy bedroom portrait in warm morning light',
      aspect_ratio: '3:4',
    }) as AgentToolResult<ImageToolResultDetails>;

    expect(ops.create).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'a cozy bedroom portrait in warm morning light',
      aspectRatio: '3:4',
    }));
    expect(reviewer.analyze).toHaveBeenCalledWith({
      imageUrls: ['https://images.example.test/selfie.png'],
      imageLocalPaths: ['/tmp/selfie.png'],
      prompt: 'a cozy bedroom portrait in warm morning light',
      mode: 'create',
    });
    expect(result.details.imageResult?.requestId).toBe('req-vision-1');
    expect(result.details.visionReview?.summary).toContain('visually consistent');
    expect(resultText(result)).toContain('"requestId": "req-vision-1"');
    expect(resultText(result)).toContain('Vision review:');
  });

  it('exposes a dedicated selfie tool that uses the same image pipeline', async () => {
    const ops = {
      create: vi.fn(async () => ({
        provider: 'fal',
        mode: 'create' as const,
        model: 'fal-ai/nano-banana-2',
        fallbackUsed: false,
        requestId: 'req-selfie-1',
        images: [{
          url: 'https://images.example.test/selfie-explicit.png',
          contentType: 'image/png',
          fileName: 'selfie-explicit.png',
          localPath: '/tmp/selfie-explicit.png',
        }],
      })),
      edit: vi.fn(),
    };
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'Describe the generated image.',
        summary: 'The selfie reads as a consistent companion portrait.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };

    const tool = createSelfieTool(ops, reviewer);
    const result = await tool.execute('tool-call-selfie', {
      prompt: 'a candid mirror selfie of me, soft morning light, cozy bedroom, natural expression',
      aspect_ratio: '3:4',
    }) as AgentToolResult<ImageToolResultDetails>;

    expect(tool.name).toBe('selfie_create');
    expect(ops.create).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'a candid mirror selfie of me, soft morning light, cozy bedroom, natural expression',
      aspectRatio: '3:4',
    }));
    expect(reviewer.analyze).toHaveBeenCalledWith({
      imageUrls: ['https://images.example.test/selfie-explicit.png'],
      imageLocalPaths: ['/tmp/selfie-explicit.png'],
      prompt: 'a candid mirror selfie of me, soft morning light, cozy bedroom, natural expression',
      mode: 'create',
    });
    expect(result.details.visionReview?.summary).toContain('consistent companion portrait');
    expect(resultText(result)).toContain('"requestId": "req-selfie-1"');
    expect(resultText(result)).toContain('Vision review:');
  });

  it('injects appearance context into selfie_create backend prompts', async () => {
    const ops = {
      create: vi.fn(async () => ({
        provider: 'fal',
        mode: 'create' as const,
        model: 'fal-ai/nano-banana-2',
        fallbackUsed: false,
        requestId: 'req-selfie-appearance-1',
        images: [{
          url: 'https://images.example.test/selfie-appearance.png',
          contentType: 'image/png',
          fileName: 'selfie-appearance.png',
          localPath: '/tmp/selfie-appearance.png',
        }],
      })),
      edit: vi.fn(),
    };
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'Describe the generated image.',
        summary: 'The selfie matches the requested appearance context.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };

    const tool = createSelfieTool(ops, reviewer);
    await runWithVisionToolRequestContext(
      {
        userMessageText: 'take a selfie',
        imageAttachmentUrls: [],
        appearanceContext: 'Platinum-white hair, bright blue eyes, white feline ears, and twin tails.',
      },
      async () => tool.execute('tool-call-selfie-appearance', {
        prompt: 'a candid mirror selfie of me in soft morning light',
        aspect_ratio: '3:4',
      }) as Promise<AgentToolResult<ImageToolResultDetails>>,
    );

    const effectivePrompt = ops.create.mock.calls[0]?.[0]?.prompt;
    expect(effectivePrompt).toContain('Appearance context (canonical subject identity):');
    expect(effectivePrompt).toContain('Platinum-white hair, bright blue eyes, white feline ears, and twin tails.');
    expect(effectivePrompt).toContain('Requested shot:');
    expect(effectivePrompt).toContain('a candid mirror selfie of me in soft morning light');
    expect(reviewer.analyze).toHaveBeenCalledWith(expect.objectContaining({
      prompt: effectivePrompt,
    }));
  });

  it('fails closed when image_create is asked for a self-portrait', async () => {
    const ops = {
      create: vi.fn(async () => ({
        provider: 'fal',
        mode: 'create' as const,
        model: 'fal-ai/nano-banana-2',
        fallbackUsed: false,
        requestId: 'req-generic-selfie-blocked',
        images: [],
      })),
      edit: vi.fn(),
    };

    const tool = createImageCreateTool(ops);
    const result = await tool.execute('tool-call-selfie-blocked', {
      prompt: 'a mirror selfie of me in warm morning light',
    }) as AgentToolResult<ImageToolResultDetails>;

    expect(ops.create).not.toHaveBeenCalled();
    expect(resultText(result)).toContain('Use selfie_create for selfies or self-portraits');
  });
  it('exposes image_analyze as a callable vision tool', async () => {
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'Does this still look like me?',
        summary: 'Yes. The appearance is consistent and the lighting is the main visible change.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };

    const tool = createImageAnalyzeTool(reviewer);
    const result = await tool.execute('tool-call-2', {
      image_urls: ['https://images.example.test/review.png'],
      question: 'Does this still look like me?',
    }) as AgentToolResult<ImageToolResultDetails>;

    expect(reviewer.analyze).toHaveBeenCalledWith({
      imageUrls: ['https://images.example.test/review.png'],
      question: 'Does this still look like me?',
    });
    expect(result.details.visionReview?.model).toBe('vision-model');
    expect(resultText(result)).toContain('Vision review:');
    expect(resultText(result)).toContain('appearance is consistent');
  });

  it('reuses the current-turn vision review when image_analyze is called with a mismatched stale url', async () => {
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'Does this still look like me?',
        summary: 'Should not be reached.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };

    const tool = createImageAnalyzeTool(reviewer);
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
        image_urls: [
          'https://files.example.test/uploads/other-image.png?token=stale',
        ],
        question: 'Does this still look like me?',
      }) as Promise<AgentToolResult<ImageToolResultDetails>>,
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

    const tool = createImageAnalyzeTool(reviewer);
    const result = await runWithVisionToolRequestContext(
      {
        userMessageText: 'did you not see the image?',
        imageAttachmentUrls: [
          'https://files.example.test/uploads/current-image.png?token=fresh',
        ],
      },
      async () => tool.execute('tool-call-3b', {
        image_urls: [
          'https://files.example.test/uploads/other-image.png?token=stale',
        ],
        question: 'Does this still look like me?',
      }) as Promise<AgentToolResult<ImageToolResultDetails>>,
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

    const tool = createImageAnalyzeTool(reviewer);
    const result = await runWithVisionToolRequestContext(
      {
        userMessageText: explicitUrl,
        imageAttachmentUrls: [
          'https://files.example.test/uploads/current-attachment.png?token=fresh',
        ],
      },
      async () => tool.execute('tool-call-4', {
        image_urls: [explicitUrl],
        question: 'What is in this image?',
      }) as Promise<AgentToolResult<ImageToolResultDetails>>,
    );

    expect(reviewer.analyze).toHaveBeenCalledWith({
      imageUrls: [explicitUrl],
      question: 'What is in this image?',
    });
    expect(result.details.visionReview?.summary).toContain('cozy desk setup');
  });
});
