import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type { ToolWiringMeta, WirableTool } from '../agent/tool-wiring-validator.js';
import type { SubstrateConfig } from '../types.js';
import type { ImageOperations } from './ops.js';
import { ImageService } from './service.js';
import { createMediaTool } from './tools.js';
import {
  DefaultImageVisionReviewer,
  type ImageVisionReviewerOptions,
} from './vision-reviewer.js';
import type { ImageVisionReviewer } from './types.js';

export interface MediaRuntimeTarget {
  registerTool: ToolRegistrar;
}

function attachWiringMeta(tool: AgentTool<any>, meta: ToolWiringMeta): WirableTool {
  const wirable = tool as WirableTool;
  wirable.wiringMeta = meta;
  return wirable;
}

function resolveRequiredGatewayMethods(): string[] {
  return ['image.create', 'image.edit', 'web.fetch_binary'];
}

export interface RegisterMediaToolOptions {
  gatewayMode?: boolean;
  reviewer?: ImageVisionReviewer;
}

export function registerMediaTool(
  target: MediaRuntimeTarget,
  ops: ImageOperations,
  options?: RegisterMediaToolOptions,
): void {
  const tool = createMediaTool(ops, options?.reviewer);

  if (options?.gatewayMode) {
    attachWiringMeta(tool, {
      requiredGatewayMethods: resolveRequiredGatewayMethods(),
    });
  }
  target.registerTool(tool, 'extended');
}

export interface WireMediaRuntimeOptions {
  reviewer?: ImageVisionReviewer;
  reviewerOptions?: ImageVisionReviewerOptions;
}

export function wireMediaRuntime(
  target: MediaRuntimeTarget,
  config: SubstrateConfig,
  options?: WireMediaRuntimeOptions,
): ImageService {
  const service = new ImageService(config);
  const reviewer = options?.reviewer ?? new DefaultImageVisionReviewer(config, options?.reviewerOptions);
  registerMediaTool(target, service, { reviewer });
  return service;
}
