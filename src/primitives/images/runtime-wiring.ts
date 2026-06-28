import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolRegistrar } from '../../core/agent/tool-registrar.js';
import type { ToolWiringMeta, WirableTool } from '../../core/agent/tool-wiring-validator.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { resolveConfiguredCompanionDataDir } from '../../persistence/layout.js';
import { ImageReferenceStore } from './reference-store.js';
import type { ImageOperations } from './ops.js';
import { ImageService } from './service.js';
import {
  createMediaTool,
  createSelfieTool,
  type ImageReferenceResolver,
} from './tools.js';
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
    case 'media':
      return ['image.create', 'image.edit', 'web.fetch_binary'];
    case 'selfie_create':
      return includeVisionReview
        ? ['image.create', 'image.edit', 'web.fetch_binary']
        : ['image.create', 'image.edit'];
    default:
      return [];
  }
}

export interface RegisterImagesToolsOptions {
  gatewayMode?: boolean;
  reviewer?: ImageVisionReviewer;
  referenceResolver?: ImageReferenceResolver;
}

export function registerImageTools(
  target: ImagesRuntimeTarget,
  ops: ImageOperations,
  options?: RegisterImagesToolsOptions,
): void {
  const tools: AgentTool<any>[] = [
    createMediaTool(ops, options?.reviewer, { referenceResolver: options?.referenceResolver }),
    createSelfieTool(ops, options?.reviewer, { referenceResolver: options?.referenceResolver }),
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
  const referenceStore = new ImageReferenceStore(resolveConfiguredCompanionDataDir(config));
  registerImageTools(target, service, { reviewer, referenceResolver: referenceStore });
  return service;
}
