import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type { ToolWiringMeta, WirableTool } from '../agent/tool-wiring-validator.js';
import type { ImageOperations } from './ops.js';
import type { ImageRuntimeConfig } from './types.js';
import { ImageService } from './service.js';
import { createImageCreateTool, createImageEditTool } from './tools.js';

export interface ImagesRuntimeTarget {
  registerTool: ToolRegistrar;
}

const IMAGE_TOOL_GATEWAY_METHODS: Record<string, string[]> = {
  image_create: ['image.create'],
  image_edit: ['image.edit'],
};

function attachWiringMeta(tool: AgentTool<any>, meta: ToolWiringMeta): WirableTool {
  const wirable = tool as WirableTool;
  wirable.wiringMeta = meta;
  return wirable;
}

export interface RegisterImagesToolsOptions {
  gatewayMode?: boolean;
}

export function registerImageTools(
  target: ImagesRuntimeTarget,
  ops: ImageOperations,
  options?: RegisterImagesToolsOptions,
): void {
  const tools: AgentTool<any>[] = [
    createImageCreateTool(ops),
    createImageEditTool(ops),
  ];

  for (const tool of tools) {
    if (options?.gatewayMode) {
      attachWiringMeta(tool, { requiredGatewayMethods: IMAGE_TOOL_GATEWAY_METHODS[tool.name] });
    }
    target.registerTool(tool, 'extended');
  }
}

export function wireImageRuntime(
  target: ImagesRuntimeTarget,
  config: ImageRuntimeConfig,
): ImageService {
  const service = new ImageService(config);
  registerImageTools(target, service);
  return service;
}
