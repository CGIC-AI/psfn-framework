import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { ImageOperations } from './ops.js';
import { textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../utils/errors.js';
import {
  FAL_CREATE_MODELS,
  FAL_EDIT_MODELS,
  IMAGE_PROVIDER_PREFERENCE_VALUES,
  type ImageGenerationResult,
  type ImageToolResultDetails,
} from './types.js';

function formatResult(result: ImageGenerationResult): string {
  return JSON.stringify(result, null, 2);
}

function providerPreferenceSchema() {
  return Type.Optional(Type.Union(
    IMAGE_PROVIDER_PREFERENCE_VALUES.map((value) => Type.Literal(value)),
  ));
}

export function createImageCreateTool(ops: ImageOperations): AgentTool<any> {
  return {
    name: 'image_create',
    label: 'image_create',
    description:
      'Generate a new image. Write the prompt as the full image you want to create, including subject, framing, pose, lighting, setting, mood, and style. For self-portraits or selfies, reuse the runtime Appearance context as the companion\'s canonical look and describe the shot directly, for example: "a candid mirror selfie of me, soft morning light, cozy bedroom, natural expression". FAL is used by default and can fall back to configured local ComfyUI workflows on FAL 422 content-policy failures.',
    parameters: Type.Object({
      prompt: Type.String({
        description:
          'Full generation prompt. For selfies/self-portraits, explicitly describe the companion using the runtime Appearance context plus the desired pose, camera angle, lighting, background, and style.',
      }),
      provider: providerPreferenceSchema(),
      model: Type.Optional(Type.Union(FAL_CREATE_MODELS.map((value) => Type.Literal(value)))),
      num_images: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
      width: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096 })),
      height: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096 })),
      aspect_ratio: Type.Optional(Type.String()),
      resolution: Type.Optional(Type.String()),
      image_size: Type.Optional(Type.String()),
      background: Type.Optional(Type.String()),
      output_format: Type.Optional(Type.String()),
      seed: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        prompt: string;
        provider?: 'auto' | 'fal' | 'comfyui';
        model?: typeof FAL_CREATE_MODELS[number];
        num_images?: number;
        width?: number;
        height?: number;
        aspect_ratio?: string;
        resolution?: string;
        image_size?: string;
        background?: string;
        output_format?: string;
        seed?: number;
      },
    ): Promise<AgentToolResult<ImageToolResultDetails>> => {
      try {
        const result = await ops.create({
          prompt: params.prompt,
          provider: params.provider,
          model: params.model,
          numImages: params.num_images,
          width: params.width,
          height: params.height,
          aspectRatio: params.aspect_ratio,
          resolution: params.resolution,
          imageSize: params.image_size,
          background: params.background,
          outputFormat: params.output_format,
          seed: params.seed,
        });
        return {
          content: [{ type: 'text', text: formatResult(result) }] satisfies TextContent[],
          details: { imageResult: result },
        };
      } catch (error) {
        return textResultWithError(`image_create failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createImageEditTool(ops: ImageOperations): AgentTool<any> {
  return {
    name: 'image_edit',
    label: 'image_edit',
    description:
      'Edit one or more existing images. Write the prompt as the exact transformation you want, including what should change and what must stay the same. For edits of the companion\'s own image, keep the runtime Appearance context aligned with the prompt so her look stays consistent, for example: "turn this into a playful selfie of me at sunset while keeping my usual hair, eyes, cat ears, and tail". FAL is used by default, with optional configured local ComfyUI fallback.',
    parameters: Type.Object({
      prompt: Type.String({
        description:
          'Full edit instruction. State the target result clearly and mention any identity details that must remain unchanged; for self-edits, keep the runtime Appearance context consistent.',
      }),
      image_urls: Type.Array(Type.String(), { minItems: 1, maxItems: 4 }),
      provider: providerPreferenceSchema(),
      model: Type.Optional(Type.Union(FAL_EDIT_MODELS.map((value) => Type.Literal(value)))),
      num_images: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
      width: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096 })),
      height: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096 })),
      aspect_ratio: Type.Optional(Type.String()),
      resolution: Type.Optional(Type.String()),
      image_size: Type.Optional(Type.String()),
      background: Type.Optional(Type.String()),
      output_format: Type.Optional(Type.String()),
      mask_image_url: Type.Optional(Type.String()),
      input_fidelity: Type.Optional(Type.String()),
      seed: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        prompt: string;
        image_urls: string[];
        provider?: 'auto' | 'fal' | 'comfyui';
        model?: typeof FAL_EDIT_MODELS[number];
        num_images?: number;
        width?: number;
        height?: number;
        aspect_ratio?: string;
        resolution?: string;
        image_size?: string;
        background?: string;
        output_format?: string;
        mask_image_url?: string;
        input_fidelity?: string;
        seed?: number;
      },
    ): Promise<AgentToolResult<ImageToolResultDetails>> => {
      try {
        const result = await ops.edit({
          prompt: params.prompt,
          imageUrls: [...params.image_urls],
          provider: params.provider,
          model: params.model,
          numImages: params.num_images,
          width: params.width,
          height: params.height,
          aspectRatio: params.aspect_ratio,
          resolution: params.resolution,
          imageSize: params.image_size,
          background: params.background,
          outputFormat: params.output_format,
          maskImageUrl: params.mask_image_url,
          inputFidelity: params.input_fidelity,
          seed: params.seed,
        });
        return {
          content: [{ type: 'text', text: formatResult(result) }] satisfies TextContent[],
          details: { imageResult: result },
        };
      } catch (error) {
        return textResultWithError(`image_edit failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}
