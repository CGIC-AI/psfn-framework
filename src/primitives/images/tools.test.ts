import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { TextContent } from '@mariozechner/pi-ai';
import { runWithVisionToolRequestContext } from './request-context.js';
import { createGenerateImageTool, createSelfieTool } from './tools.js';
import { IMAGE_ASPECT_RATIO_VALUES, type ImageToolResultDetails, type ImageVisionReviewer, type MediaToolResultDetails } from './types.js';
import {
  chargeSurface,
  resetRunChargeRollingWindowForTests,
  runWithChargeContext,
} from '../../shared/telemetry/run-charge.js';
import {
  listPendingPaidDeliverables,
  runWithPaidDeliverableTracking,
} from '../../shared/paid-deliverable-tracking.js';
import { resolveToolRequiredCapabilities } from '../../system/capabilities/requirements.js';
import type { ChargePolicyConfig } from '../../system/config/charge-policy-config.js';
import { makeTestFatiguePolicyConfig } from '../../test-support/charge-policy.js';

const tempDirs: string[] = [];

afterEach(() => {
  resetRunChargeRollingWindowForTests();
  tempDirs.splice(0).forEach((dir) => {
    rmSync(dir, { recursive: true, force: true });
  });
});

function resultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function readAspectRatios(tool: { parameters: unknown }): string[] {
  const schema = (tool.parameters as {
    properties?: Record<string, { anyOf?: Array<{ const?: string }> }>;
  }).properties?.aspect_ratio;
  return (schema?.anyOf ?? [])
    .map((entry) => entry.const)
    .filter((value): value is string => typeof value === 'string');
}

function readActions(tool: ReturnType<typeof createGenerateImageTool>): string[] {
  const schema = (tool.parameters as {
    properties?: Record<string, { anyOf?: Array<{ const?: string }> }>;
  }).properties?.action;
  return (schema?.anyOf ?? [])
    .map((entry) => entry.const)
    .filter((value): value is string => typeof value === 'string');
}

function makeChargePolicy(): ChargePolicyConfig {
  return {
    schemaVersion: 1,
    runChargeQuotaByLane: {
      interactive: 100,
      background: 100,
      maintenance: 0,
      subagent: 100,
      shard: 100,
    },
    surfaceCosts: {
      ownerFileInspection: 0,
      localFilesystem: 0,
      memoryRead: 0,
      memoryWrite: 0,
      localEmbedding: 0,
      externalEmbedding: 0,
      localImageGeneration: 0,
      paidImageGeneration: 6,
      analysisWorkbenchExtensionBand: 1,
      subagentLaunch: 1,
      shardLaunch: 8,
      externalModelConsult: 1,
      moaRoundBase: 1,
    },
    moa: {
      perRoundMultiplierByReferenceModelClass: {
        local: 1,
        subscription: 1,
        cheap_cloud: 1,
        premium_cloud: 2,
      },
    },
    referenceModelClassPricing: {
      local: 0,
      subscription: 0,
      cheap_cloud: 1,
      premium_cloud: 4,
    },
    fatigue: makeTestFatiguePolicyConfig(),
  };
}

function makeInteractiveQuotaPolicy(quota: number): ChargePolicyConfig {
  const policy = makeChargePolicy();
  return {
    ...policy,
    runChargeQuotaByLane: {
      ...policy.runChargeQuotaByLane,
      interactive: quota,
    },
  };
}

describe('image tools', () => {
  it('exposes generate, edit, and analyze actions on generate_image and cross-references selfie_create', () => {
    const tool = createGenerateImageTool({
      create: vi.fn(),
      edit: vi.fn(),
    });

    expect(tool.name).toBe('generate_image');
    expect(readActions(tool)).toEqual(['generate', 'edit', 'analyze']);
    expect(tool.description).toContain('action="generate" requires prompt');
    expect(tool.description).toContain('action="edit" requires prompt and input_urls');
    expect(tool.description).toContain('action="analyze" requires input_urls');
    // Concrete user trigger phrasing plus an explicit when-NOT-to-use line
    // that routes self-images to selfie_create.
    expect(tool.description).toContain('"draw me a..."');
    expect(tool.description).toContain('Do NOT use this for images of yourself');
    expect(tool.description).toContain('selfie_create');
    expect(tool.description).toContain('what do you look like right now');
    expect((tool.parameters as any).properties.prompt.description).toContain('Required for action=generate');
    expect((tool.parameters as any).properties.input_urls.description).toContain('Required for action=edit');
  });

  it('keeps selfie_create self-image-only and cross-references generate_image for everything else', () => {
    const tool = createSelfieTool({
      create: vi.fn(),
      edit: vi.fn(),
    });

    expect(tool.name).toBe('selfie_create');
    expect(tool.description.length).toBeLessThan(600);
    expect(tool.description).toContain('Requires prompt');
    expect(tool.description).toContain('saved-reference anchoring');
    // Concrete user trigger phrasing plus an explicit when-NOT-to-use line
    // that routes non-self images to generate_image.
    expect(tool.description).toContain('"send me a selfie"');
    expect(tool.description).toContain('what do you look like right now');
    expect(tool.description).toContain('Do NOT use this for anything that is not you');
    expect(tool.description).toContain('generate_image');
    expect(tool.description).not.toContain('content policy');
    expect((tool.parameters as any).properties.edit_model.description.length).toBeLessThan(220);
    expect((tool.parameters as any).properties.edit_model.description).not.toContain('gpt-image-2');
  });

  it('rejects an unknown fal model with an error listing the valid models', async () => {
    const create = vi.fn();
    const tool = createGenerateImageTool({
      create,
      edit: vi.fn(),
    });

    const result = await tool.execute('call-model', {
      action: 'generate',
      prompt: 'a lighthouse at dusk',
      model: 'not-a-real-model',
    }, undefined as any);

    expect(create).not.toHaveBeenCalled();
    expect(result.details?.isError).toBe(true);
    expect(resultText(result)).toContain('Invalid "model" value "not-a-real-model"');
    expect(resultText(result)).toContain('Valid generation models:');
  });

  it('returns minimal valid examples for missing media arguments', async () => {
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'unused',
        summary: 'unused',
        model: 'vision-model',
        imageCount: 1,
      })),
    };
    const tool = createGenerateImageTool({
      create: vi.fn(),
      edit: vi.fn(),
    }, reviewer);

    const missingGeneratePrompt = await tool.execute('media-missing-generate-prompt', {
      action: 'generate',
    }) as AgentToolResult<MediaToolResultDetails>;
    const missingEditPrompt = await tool.execute('media-missing-edit-prompt', {
      action: 'edit',
      input_urls: ['https://images.example.test/source.png'],
    }) as AgentToolResult<MediaToolResultDetails>;
    const missingEditInput = await tool.execute('media-missing-edit-input', {
      action: 'edit',
      prompt: 'make this warmer',
    }) as AgentToolResult<MediaToolResultDetails>;
    const missingAnalyzeInput = await tool.execute('media-missing-analyze-input', {
      action: 'analyze',
    }) as AgentToolResult<MediaToolResultDetails>;

    expect(resultText(missingGeneratePrompt)).toContain('Missing required field "prompt" for generate_image action="generate"');
    expect(resultText(missingGeneratePrompt)).toContain('{"action":"generate","prompt":"full image description"}');
    expect(resultText(missingEditPrompt)).toContain('Missing required field "prompt" for generate_image action="edit"');
    expect(resultText(missingEditInput)).toContain('Missing required field "input_urls" for generate_image action="edit"');
    expect(resultText(missingAnalyzeInput)).toContain('Missing required field "input_urls" for generate_image action="analyze"');
    expect(missingGeneratePrompt.details.isError).toBe(true);
    expect(missingEditPrompt.details.isError).toBe(true);
    expect(missingEditInput.details.isError).toBe(true);
    expect(missingAnalyzeInput.details.isError).toBe(true);
  });

  it('does not capability-gate benign media and selfie actions', () => {
    const mediaTool = createGenerateImageTool({
      create: vi.fn(),
      edit: vi.fn(),
    });
    const selfieTool = createSelfieTool({
      create: vi.fn(),
      edit: vi.fn(),
    });

    expect(resolveToolRequiredCapabilities(mediaTool, { action: 'generate' })).toEqual([]);
    expect(resolveToolRequiredCapabilities(mediaTool, { action: 'edit' })).toEqual([]);
    expect(resolveToolRequiredCapabilities(mediaTool, { action: 'analyze' })).toEqual([]);
    expect(resolveToolRequiredCapabilities(selfieTool, {})).toEqual([]);
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
    const emitted: Array<[string, Record<string, unknown>]> = [];
    const eventBus = {
      emit: vi.fn(async (eventName: string, payload: Record<string, unknown>) => {
        emitted.push([eventName, payload]);
      }),
    } as any;

    const tool = createGenerateImageTool(ops, reviewer);
    const result = await runWithChargeContext({
      chargePolicy: makeChargePolicy(),
      eventBus,
      lane: 'interactive',
      correlation: {
        requestId: 'media-generate-1',
        channelId: 'api:test',
      },
    }, async () => runWithVisionToolRequestContext({
      userMessageText: 'generate',
      imageAttachmentUrls: [],
      appearanceContext: 'neutral',
    }, async () => tool.execute('tool-call-media-generate', {
      action: 'generate',
      prompt: 'a cinematic portrait in warm morning light',
      aspect_ratio: '3:4',
    }) as Promise<AgentToolResult<MediaToolResultDetails>>));

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
    expect(emitted.map(([eventName, payload]) => [eventName, (payload as any).surface])).toEqual([
      ['agent.charge', 'paidImageGeneration'],
      ['agent.charge', 'externalModelConsult'],
    ]);
    expect(result.details.mediaResult?.requestId).toBe('req-media-1');
    expect(result.details.mediaResult?.images[0]?.url).toBe('https://images.example.test/media-selfie.png');
    expect(result.details.visionReview?.summary).toContain('consistent');
    expect(resultText(result)).toContain('"imageCount": 1');
    expect(resultText(result)).toContain('chat attachment');
    expect(resultText(result)).not.toContain('https://images.example.test/media-selfie.png');
    expect(resultText(result)).not.toContain('/tmp/media-selfie.png');
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

    const tool = createGenerateImageTool({
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

  it('keeps local image generation on the zero-charge path', async () => {
    const ops = {
      create: vi.fn(async () => ({
        provider: 'comfyui' as const,
        mode: 'create' as const,
        fallbackUsed: false,
        images: [],
      })),
      edit: vi.fn(),
    };
    const emitted: Array<[string, Record<string, unknown>]> = [];
    const eventBus = {
      emit: vi.fn(async (eventName: string, payload: Record<string, unknown>) => {
        emitted.push([eventName, payload]);
      }),
    } as any;

    const tool = createGenerateImageTool(ops);
    await runWithChargeContext({
      chargePolicy: makeChargePolicy(),
      eventBus,
      lane: 'interactive',
      correlation: {
        requestId: 'media-zero-1',
        channelId: 'api:test',
      },
    }, async () => runWithVisionToolRequestContext({
      userMessageText: 'generate',
      imageAttachmentUrls: [],
    }, async () => tool.execute('tool-call-media-local', {
      action: 'generate',
      prompt: 'a sketch rendered locally',
    })));

    expect(emitted).toHaveLength(0);
  });

  it('rejects exhausted paid image quota before calling the provider or writing artifacts', async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), 'psfn-paid-image-quota-'));
    tempDirs.push(artifactDir);
    const artifactPath = join(artifactDir, 'should-not-exist.png');
    const sidecarPath = `${artifactPath}.image-meta.json`;
    const ops = {
      create: vi.fn(async () => {
        writeFileSync(artifactPath, Buffer.from('provider-bytes'));
        writeFileSync(sidecarPath, '{}');
        return {
          provider: 'fal' as const,
          mode: 'create' as const,
          model: 'fal-ai/nano-banana-2',
          fallbackUsed: false,
          requestId: 'req-should-not-run',
          images: [{
            url: 'https://images.example.test/should-not-run.png',
            contentType: 'image/png',
            fileName: 'should-not-run.png',
            localPath: artifactPath,
          }],
        };
      }),
      edit: vi.fn(),
    };
    const chargePolicy = makeInteractiveQuotaPolicy(6);

    await runWithChargeContext({
      chargePolicy,
      lane: 'interactive',
      runId: 'prior-paid-image',
    }, async () => {
      chargeSurface('paidImageGeneration');
    });

    const tool = createGenerateImageTool(ops);
    const result = await runWithChargeContext({
      chargePolicy,
      lane: 'interactive',
      runId: 'exhausted-paid-image',
    }, async () => tool.execute('tool-call-media-quota', {
      action: 'generate',
      prompt: 'a purring cat on a server rack',
    }) as Promise<AgentToolResult<MediaToolResultDetails>>);

    expect(ops.create).not.toHaveBeenCalled();
    expect(result.details.isError).toBe(true);
    expect(resultText(result)).toContain('generate_image generate failed: Charge quota exceeded');
    expect(resultText(result)).toContain('rolling 24-hour budget');
    expect(existsSync(artifactPath)).toBe(false);
    expect(existsSync(sidecarPath)).toBe(false);
  });

  it('constrains aspect_ratio to the supported preset list for media and selfie tools', () => {
    const mediaTool = createGenerateImageTool({
      create: vi.fn(),
      edit: vi.fn(),
    });
    const selfieTool = createSelfieTool({
      create: vi.fn(),
      edit: vi.fn(),
    });

    expect(readAspectRatios(mediaTool)).toEqual([...IMAGE_ASPECT_RATIO_VALUES]);
    expect(readAspectRatios(selfieTool)).toEqual([...IMAGE_ASPECT_RATIO_VALUES]);
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
        summary: 'The selfie matches the companion look and reads as cute and consistent.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };

    const tool = createGenerateImageTool(ops, reviewer);
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
      imageLocalPaths: ['/tmp/selfie.png'],
      prompt: 'a cute mirror selfie of me in warm morning light',
      mode: 'create',
    });
    expect(result.details.mediaResult?.requestId).toBe('req-vision-1');
    expect(result.details.mediaResult?.images[0]?.url).toBe('https://images.example.test/selfie.png');
    expect(result.details.visionReview?.summary).toContain('matches the companion look');
    expect(resultText(result)).toContain('"imageCount": 1');
    expect(resultText(result)).not.toContain('"requestId": "req-vision-1"');
    expect(resultText(result)).not.toContain('https://images.example.test/selfie.png');
    expect(resultText(result)).not.toContain('/tmp/selfie.png');
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
    expect(result.details.imageResult?.requestId).toBe('req-selfie-1');
    expect(result.details.imageResult?.images[0]?.url).toBe('https://images.example.test/selfie-explicit.png');
    expect(resultText(result)).toContain('"imageCount": 1');
    expect(resultText(result)).not.toContain('"requestId": "req-selfie-1"');
    expect(resultText(result)).not.toContain('https://images.example.test/selfie-explicit.png');
    expect(resultText(result)).not.toContain('/tmp/selfie-explicit.png');
    expect(resultText(result)).toContain('Vision review:');
  });

  it('states the paid image is a pending attachment that requires a reply to deliver', async () => {
    const ops = {
      create: vi.fn(async () => ({
        provider: 'fal' as const,
        mode: 'create' as const,
        model: 'fal-ai/nano-banana-2',
        fallbackUsed: false,
        requestId: 'req-pending-1',
        images: [{
          url: 'https://images.example.test/pending.png',
          contentType: 'image/png',
          fileName: 'pending.png',
          localPath: '/tmp/pending.png',
        }],
      })),
      edit: vi.fn(),
    };

    const tool = createSelfieTool(ops);
    const result = await tool.execute('tool-call-pending', {
      prompt: 'a candid mirror selfie in soft morning light',
    }) as AgentToolResult<ImageToolResultDetails>;

    const text = resultText(result);
    expect(text).toContain('"attachmentPending": true');
    expect(text).toContain('pending chat attachment');
    expect(text).toContain('will NOT be delivered');
    expect(text).toContain('"generationId": "req-pending-1"');
    expect(text).toContain('"fileName": "pending.png"');
  });

  it('registers a pending paid deliverable for a charged selfie generation', async () => {
    const ops = {
      create: vi.fn(async () => ({
        provider: 'fal' as const,
        mode: 'create' as const,
        model: 'fal-ai/nano-banana-2',
        fallbackUsed: false,
        requestId: 'req-deliverable-1',
        images: [{
          url: 'https://images.example.test/deliverable.png',
          contentType: 'image/png',
          fileName: 'deliverable.png',
          localPath: '/tmp/deliverable.png',
        }],
      })),
      edit: vi.fn(),
    };

    const tool = createSelfieTool(ops);
    const pending = await runWithPaidDeliverableTracking(async () => {
      await tool.execute('tool-call-deliverable', {
        prompt: 'a candid mirror selfie in soft morning light',
      });
      return listPendingPaidDeliverables();
    });

    expect(pending).toEqual([{
      surface: 'paidImageGeneration',
      toolName: 'selfie_create',
      toolCallId: 'tool-call-deliverable',
      identifier: 'req-deliverable-1',
      artifactCount: 1,
    }]);
  });

  it('does not register a pending paid deliverable for a free comfyui generation', async () => {
    const ops = {
      create: vi.fn(async () => ({
        provider: 'comfyui' as const,
        mode: 'create' as const,
        fallbackUsed: false,
        requestId: 'req-free-1',
        images: [{
          url: 'https://images.example.test/free.png',
          contentType: 'image/png',
          fileName: 'free.png',
          localPath: '/tmp/free.png',
        }],
      })),
      edit: vi.fn(),
    };

    const tool = createSelfieTool(ops);
    const pending = await runWithPaidDeliverableTracking(async () => {
      await tool.execute('tool-call-free', {
        prompt: 'a candid mirror selfie in soft morning light',
        provider: 'comfyui',
      });
      return listPendingPaidDeliverables();
    });

    expect(pending).toEqual([]);
  });

  it('uses the default reference photo for selfie_create through the edit pipeline', async () => {
    const ops = {
      create: vi.fn(),
      edit: vi.fn(async () => ({
        provider: 'fal',
        mode: 'edit' as const,
        model: 'openai/gpt-image-2/edit',
        fallbackUsed: false,
        requestId: 'req-selfie-ref-1',
        images: [{
          url: 'https://images.example.test/selfie-ref.png',
          contentType: 'image/png',
          fileName: 'selfie-ref.png',
          localPath: '/tmp/selfie-ref.png',
        }],
      })),
    };
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'Describe the generated image.',
        summary: 'The referenced portrait remains recognizable.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };
    const referenceResolver = {
      resolveForTool: vi.fn(async () => ({
        id: 'ref-default',
        dataUrl: 'data:image/png;base64,cmVm',
        description: 'default portrait',
        tags: ['default'],
      })),
    };

    const tool = createSelfieTool(ops, reviewer, { referenceResolver });
    const result = await tool.execute('tool-call-selfie-ref', {
      prompt: 'a candid mirror selfie with short hair and warm daylight',
      aspect_ratio: '3:4',
    }) as AgentToolResult<ImageToolResultDetails>;

    expect(referenceResolver.resolveForTool).toHaveBeenCalledWith({
      useDefaultReference: true,
    });
    expect(ops.create).not.toHaveBeenCalled();
    expect(ops.edit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'a candid mirror selfie with short hair and warm daylight',
      imageUrls: ['data:image/png;base64,cmVm'],
      aspectRatio: '3:4',
      sourceToolName: 'selfie_create',
      referenceImageIds: ['ref-default'],
    }));
    expect(reviewer.analyze).toHaveBeenCalledWith({
      imageUrls: ['https://images.example.test/selfie-ref.png'],
      imageLocalPaths: ['/tmp/selfie-ref.png'],
      prompt: 'a candid mirror selfie with short hair and warm daylight',
      mode: 'edit',
    });
    expect(result.details.imageResult?.requestId).toBe('req-selfie-ref-1');
  });

  it('falls through to the next edit tier with the original prompt when a referenced selfie edit hits provider content policy', async () => {
    const providerBlock = new Error(
      'FAL edit result fetch failed (422): {"detail":[{"type":"content_policy_violation","msg":"The content could not be processed because it contained material flagged by a content checker."}]}',
    );
    let editCalls = 0;
    const ops = {
      create: vi.fn(),
      edit: vi.fn(async () => {
        editCalls += 1;
        if (editCalls === 1) {
          throw providerBlock;
        }
        return {
          provider: 'fal',
          mode: 'edit' as const,
          model: 'fal-ai/nano-banana-2/edit',
          fallbackUsed: false,
          requestId: 'req-selfie-fallback-1',
          images: [{
            url: 'https://images.example.test/selfie-fallback.png',
            contentType: 'image/png',
            fileName: 'selfie-fallback.png',
            localPath: '/tmp/selfie-fallback.png',
          }],
        };
      }),
    };
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'Describe the generated image.',
        summary: 'The fallback portrait still matches the reference.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };
    const referenceResolver = {
      resolveForTool: vi.fn(async () => ({
        id: 'ref-default',
        dataUrl: 'data:image/png;base64,cmVm',
        description: 'default portrait',
        tags: ['default'],
      })),
    };

    const prompt = 'Purrsephone in a soft oversized off-shoulder knit sweater, flirty expression, cozy bedroom background with rumpled sheets';
    const tool = createSelfieTool(ops, reviewer, { referenceResolver });
    const result = await tool.execute('tool-call-selfie-policy-fallback', {
      prompt,
      aspect_ratio: '3:4',
    }) as AgentToolResult<ImageToolResultDetails>;

    expect(ops.create).not.toHaveBeenCalled();
    expect(ops.edit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      prompt,
      model: 'xai/grok-imagine-image/quality/edit',
      imageUrls: ['data:image/png;base64,cmVm'],
      aspectRatio: '3:4',
      sourceToolName: 'selfie_create',
      referenceImageIds: ['ref-default'],
    }));
    expect(ops.edit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      prompt,
      model: 'fal-ai/nano-banana-2/edit',
      imageUrls: ['data:image/png;base64,cmVm'],
      aspectRatio: '3:4',
      sourceToolName: 'selfie_create',
      referenceImageIds: ['ref-default'],
    }));
    expect(reviewer.analyze).toHaveBeenCalledWith({
      imageUrls: ['https://images.example.test/selfie-fallback.png'],
      imageLocalPaths: ['/tmp/selfie-fallback.png'],
      prompt,
      mode: 'edit',
    });
    expect(result.details.imageResult?.fallbackUsed).toBe(true);
    expect(result.details.imageResult?.fallbackReason).toBe('selfie_edit_chain_fallback');
    expect(resultText(result)).toContain('content policy block');
    expect(resultText(result)).toContain('Fell back to fal-ai/nano-banana-2/edit');
    expect(result.details.imageResult?.requestId).toBe('req-selfie-fallback-1');
    expect(resultText(result)).not.toContain('"requestId": "req-selfie-fallback-1"');
    expect(resultText(result)).not.toContain('https://images.example.test/selfie-fallback.png');
  });

  it('starts the selfie edit chain at the requested tier and skips stricter models', async () => {
    const providerBlock = new Error(
      'FAL edit result fetch failed (422): {"detail":[{"type":"content_policy_violation","msg":"flagged by a content checker"}]}',
    );
    let editCalls = 0;
    const ops = {
      create: vi.fn(),
      edit: vi.fn(async () => {
        editCalls += 1;
        if (editCalls === 1) {
          throw providerBlock;
        }
        return {
          provider: 'fal',
          mode: 'edit' as const,
          model: 'openai/gpt-image-2/edit',
          fallbackUsed: false,
          requestId: 'req-selfie-gpt-edit-1',
          images: [{
            url: 'https://images.example.test/selfie-gpt-edit.png',
            contentType: 'image/png',
            fileName: 'selfie-gpt-edit.png',
            localPath: '/tmp/selfie-gpt-edit.png',
          }],
        };
      }),
    };
    const referenceResolver = {
      resolveForTool: vi.fn(async () => ({
        id: 'ref-default',
        dataUrl: 'data:image/png;base64,cmVm',
        description: 'default portrait',
        tags: ['default'],
      })),
    };

    const tool = createSelfieTool(ops, undefined, { referenceResolver });
    const result = await tool.execute('tool-call-selfie-tier-start', {
      prompt: 'me at the beach in a modest one-piece swimsuit, golden hour',
      edit_model: 'fal-ai/nano-banana-2/edit',
    }) as AgentToolResult<ImageToolResultDetails>;

    expect(ops.create).not.toHaveBeenCalled();
    expect(ops.edit).toHaveBeenCalledTimes(2);
    expect(ops.edit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: 'fal-ai/nano-banana-2/edit',
    }));
    expect(ops.edit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: 'openai/gpt-image-2/edit',
      prompt: 'me at the beach in a modest one-piece swimsuit, golden hour',
    }));
    expect(result.details.imageResult?.fallbackUsed).toBe(true);
    expect(result.details.imageResult?.fallbackReason).toBe('selfie_edit_chain_fallback');
  });

  it('falls through the selfie edit chain when a tier times out', async () => {
    const timeoutError = new Error('FAL request req-slow-1 timed out after 300000ms');
    let editCalls = 0;
    const ops = {
      create: vi.fn(),
      edit: vi.fn(async () => {
        editCalls += 1;
        if (editCalls === 1) {
          throw timeoutError;
        }
        return {
          provider: 'fal',
          mode: 'edit' as const,
          model: 'fal-ai/nano-banana-2/edit',
          fallbackUsed: false,
          requestId: 'req-selfie-timeout-1',
          images: [{
            url: 'https://images.example.test/selfie-timeout.png',
            contentType: 'image/png',
            fileName: 'selfie-timeout.png',
            localPath: '/tmp/selfie-timeout.png',
          }],
        };
      }),
    };
    const referenceResolver = {
      resolveForTool: vi.fn(async () => ({
        id: 'ref-default',
        dataUrl: 'data:image/png;base64,cmVm',
        description: 'default portrait',
        tags: ['default'],
      })),
    };

    const tool = createSelfieTool(ops, undefined, { referenceResolver });
    const result = await tool.execute('tool-call-selfie-timeout-fallback', {
      prompt: 'a cozy reading-nook portrait of me',
    }) as AgentToolResult<ImageToolResultDetails>;

    expect(ops.create).not.toHaveBeenCalled();
    expect(ops.edit).toHaveBeenCalledTimes(2);
    expect(result.details.imageResult?.fallbackUsed).toBe(true);
    expect(result.details.imageResult?.fallbackReason).toBe('selfie_edit_chain_fallback');
    expect(resultText(result)).toContain('timeout or provider error');
  });

  it('retries the last configured tier with a sanitized prompt when every tier blocks the original', async () => {
    const providerBlock = new Error(
      'FAL edit result fetch failed (422): {"detail":[{"type":"content_policy_violation","msg":"flagged by a content checker"}]}',
    );
    let editCalls = 0;
    const ops = {
      create: vi.fn(),
      edit: vi.fn(async () => {
        editCalls += 1;
        if (editCalls <= 3) {
          throw providerBlock;
        }
        return {
          provider: 'fal',
          mode: 'edit' as const,
          model: 'openai/gpt-image-2/edit',
          fallbackUsed: false,
          requestId: 'req-selfie-sanitized-1',
          images: [{
            url: 'https://images.example.test/selfie-sanitized.png',
            contentType: 'image/png',
            fileName: 'selfie-sanitized.png',
            localPath: '/tmp/selfie-sanitized.png',
          }],
        };
      }),
    };
    const referenceResolver = {
      resolveForTool: vi.fn(async () => ({
        id: 'ref-default',
        dataUrl: 'data:image/png;base64,cmVm',
        description: 'default portrait',
        tags: ['default'],
      })),
    };

    const tool = createSelfieTool(ops, undefined, { referenceResolver });
    const result = await tool.execute('tool-call-selfie-sanitized', {
      prompt: 'a flirty off-shoulder portrait in the bedroom with rumpled sheets',
    }) as AgentToolResult<ImageToolResultDetails>;

    expect(ops.create).not.toHaveBeenCalled();
    expect(ops.edit).toHaveBeenCalledTimes(4);
    const sanitizedParams = ops.edit.mock.calls[3]?.[0] as { prompt: string; model: string; referenceImageIds: string[] };
    expect(sanitizedParams.model).toBe('openai/gpt-image-2/edit');
    expect(sanitizedParams.referenceImageIds).toEqual(['ref-default']);
    expect(sanitizedParams.prompt).toContain('Tasteful fully clothed companion self-portrait');
    expect(sanitizedParams.prompt).not.toMatch(/flirty|off[- ]shoulder|rumpled sheets|bedroom/i);
    expect(result.details.imageResult?.fallbackUsed).toBe(true);
    expect(result.details.imageResult?.fallbackReason).toBe('selfie_edit_chain_sanitized_prompt');
    expect(resultText(result)).toContain('safer prompt');
  });

  it('tells agents to stop retrying selfie prompts when policy fallback is also blocked', async () => {
    const providerBlock = new Error(
      'FAL edit result fetch failed (422): {"detail":[{"type":"content_policy_violation","msg":"The content could not be processed because it contained material flagged by a content checker."}]}',
    );
    const ops = {
      create: vi.fn(async () => {
        throw providerBlock;
      }),
      edit: vi.fn(async () => {
        throw providerBlock;
      }),
    };
    const referenceResolver = {
      resolveForTool: vi.fn(async () => ({
        id: 'ref-default',
        dataUrl: 'data:image/png;base64,cmVm',
        description: 'default portrait',
        tags: ['default'],
      })),
    };

    const tool = createSelfieTool(ops, undefined, { referenceResolver });
    const result = await tool.execute('tool-call-selfie-policy-blocked', {
      prompt: 'a flirty bedroom selfie',
      aspect_ratio: '3:4',
    }) as AgentToolResult<ImageToolResultDetails>;

    // Three chain tiers with the original prompt plus the sanitized last resort.
    expect(ops.edit).toHaveBeenCalledTimes(4);
    expect(ops.create).not.toHaveBeenCalled();
    expect(result.details.isError).toBe(true);
    expect(resultText(result)).toContain('selfie_create was blocked by the image provider content policy');
    expect(resultText(result)).toContain('A safer edit fallback was attempted and was also blocked');
    expect(resultText(result)).toContain('Do not retry the same prompt');
    expect(resultText(result)).toContain('stop tool attempts');
  });

  it('lets media edit append a selected reference photo to the edit inputs', async () => {
    const ops = {
      create: vi.fn(),
      edit: vi.fn(async () => ({
        provider: 'fal',
        mode: 'edit' as const,
        model: 'openai/gpt-image-2/edit',
        fallbackUsed: false,
        requestId: 'req-edit-ref-1',
        images: [{
          url: 'https://images.example.test/edit-ref.png',
          contentType: 'image/png',
          fileName: 'edit-ref.png',
        }],
      })),
    };
    const referenceResolver = {
      resolveForTool: vi.fn(async () => ({
        id: 'ref-short-hair',
        dataUrl: 'data:image/png;base64,c2hvcnQ=',
        description: 'short hair reference',
        tags: ['short-hair'],
      })),
    };

    const tool = createGenerateImageTool(ops, undefined, { referenceResolver });
    const result = await tool.execute('tool-call-edit-ref', {
      action: 'edit',
      prompt: 'keep the pose, update the hairstyle to match the reference',
      input_urls: ['https://images.example.test/source.png'],
      reference_image_tags: ['short-hair'],
    }) as AgentToolResult<MediaToolResultDetails>;

    expect(referenceResolver.resolveForTool).toHaveBeenCalledWith({
      referenceImageTags: ['short-hair'],
      useDefaultReference: false,
    });
    expect(ops.edit).toHaveBeenCalledWith(expect.objectContaining({
      imageUrls: [
        'https://images.example.test/source.png',
        'data:image/png;base64,c2hvcnQ=',
      ],
      sourceToolName: 'generate_image',
      referenceImageIds: ['ref-short-hair'],
    }));
    expect(result.details.mediaResult?.requestId).toBe('req-edit-ref-1');
  });

  it('exposes media action=analyze as the callable vision path', async () => {
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'Does this still look like me?',
        summary: 'Yes. The appearance is consistent and the lighting is the main visible change.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };

    const tool = createGenerateImageTool({
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

  it('reuses the current-turn vision review when media analyze is called with a mismatched stale url', async () => {
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'Does this still look like me?',
        summary: 'Should not be reached.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };

    const tool = createGenerateImageTool({
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

    const tool = createGenerateImageTool({
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

  it('blocks internal current-turn attachment handles without public fetch', async () => {
    const reviewer: ImageVisionReviewer = {
      analyze: vi.fn(async () => ({
        question: 'Should not be reached.',
        summary: 'Should not be reached.',
        model: 'vision-model',
        imageCount: 1,
      })),
    };

    const tool = createGenerateImageTool({
      create: vi.fn(),
      edit: vi.fn(),
    }, reviewer);
    const result = await runWithVisionToolRequestContext(
      {
        userMessageText: 'can you see this now?',
        imageAttachmentUrls: ['inline:image:0'],
      },
      async () => tool.execute('tool-call-inline', {
        action: 'analyze',
        input_urls: ['attachment:current-turn-image-1'],
        question: 'What is visible?',
      }) as Promise<AgentToolResult<MediaToolResultDetails>>,
    );

    expect(reviewer.analyze).not.toHaveBeenCalled();
    expect(result.details.visionReview).toBeUndefined();
    expect(result.details.visionReviewError).toContain('live image attachment bytes');
    expect(resultText(result)).not.toContain('unsupported image URL protocol');
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

    const tool = createGenerateImageTool({
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
