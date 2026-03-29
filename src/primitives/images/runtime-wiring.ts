import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolRegistrar } from '../../core/agent/tool-registrar.js';
import type { ToolWiringMeta, WirableTool } from '../../core/agent/tool-wiring-validator.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { ImageOperations } from './ops.js';
import { ImageService } from './service.js';
import { createImageAnalyzeTool, createImageCreateTool, createImageEditTool, createSelfieTool } from './tools.js';
import {
  DefaultImageVisionReviewer,
  type ImageVisionReviewerOptions,
} from './vision-reviewer.js';
import type { ImageVisionReviewer } from './types.js';

export interface ImagesRuntimeTarget {
  registerTool: ToolRegistrar;
}

function attachWiringMeta(tool: AgentTool<any>, meta: ToolWiringMeta): WirableTool {
  const wirable = tool as WirableTool;
  wirable.wiringMeta = meta;
  return wirable;
}

function resolveRequiredGatewayMethods(
  toolName: string,
  includeVisionReview: boolean,
): string[] {
  switch (toolName) {
    case 'image_create':
    case 'selfie_create':
      return includeVisionReview
        ? ['image.create', 'web.fetch_binary']
        : ['image.create'];
    case 'image_edit':
      return includeVisionReview
        ? ['image.edit', 'web.fetch_binary']
        : ['image.edit'];
    case 'image_analyze':
      return ['web.fetch_binary'];
    default:
      return [];
  }
}

export interface RegisterImagesToolsOptions {
  gatewayMode?: boolean;
  reviewer?: ImageVisionReviewer;
}

export function registerImageTools(
  target: ImagesRuntimeTarget,
  ops: ImageOperations,
  options?: RegisterImagesToolsOptions,
): void {
  const tools: AgentTool<any>[] = [
    createImageCreateTool(ops, options?.reviewer),
    createSelfieTool(ops, options?.reviewer),
    createImageEditTool(ops, options?.reviewer),
    ...(options?.reviewer ? [createImageAnalyzeTool(options.reviewer)] : []),
  ];

  for (const tool of tools) {
    if (options?.gatewayMode) {
      attachWiringMeta(tool, {
        requiredGatewayMethods: resolveRequiredGatewayMethods(
          tool.name,
          options.reviewer !== undefined,
        ),
      });
    }
    target.registerTool(tool, 'extended');
  }
}

export interface WireImageRuntimeOptions {
  reviewer?: ImageVisionReviewer;
  reviewerOptions?: ImageVisionReviewerOptions;
}

export function wireImageRuntime(
  target: ImagesRuntimeTarget,
  config: SubstrateConfig,
  options?: WireImageRuntimeOptions,
): ImageService {
  const service = new ImageService(config);
  const reviewer = options?.reviewer ?? new DefaultImageVisionReviewer(config, options?.reviewerOptions);
  registerImageTools(target, service, { reviewer });
  return service;
}
