import { describe, expect, it, vi } from 'vitest';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import { createImageAnalyzeTool, createImageCreateTool, createImageEditTool } from './tools.js';
import { IMAGE_ASPECT_RATIO_VALUES, type ImageToolResultDetails, type ImageVisionReviewer } from './types.js';

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

describe('image tools', () => {
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

    const tool = createImageCreateTool(ops, reviewer);
    const result = await tool.execute('tool-call-1', {
      prompt: 'a cute mirror selfie of me in warm morning light',
      aspect_ratio: '3:4',
    }) as AgentToolResult<ImageToolResultDetails>;

    expect(ops.create).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'a cute mirror selfie of me in warm morning light',
      aspectRatio: '3:4',
    }));
    expect(reviewer.analyze).toHaveBeenCalledWith({
      imageUrls: ['https://images.example.test/selfie.png'],
      prompt: 'a cute mirror selfie of me in warm morning light',
      mode: 'create',
    });
    expect(result.details.imageResult?.requestId).toBe('req-vision-1');
    expect(result.details.visionReview?.summary).toContain('matches the companion look');
    expect(resultText(result)).toContain('"requestId": "req-vision-1"');
    expect(resultText(result)).toContain('Vision review:');
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
});
