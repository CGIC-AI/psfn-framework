import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolRegistrar } from '../../../agent/tool-registrar.js';
import type { ToolWiringMeta, WirableTool } from '../../../agent/tool-wiring-validator.js';
import { createWebFetchTool } from './tools.js';
import type { WebFetchOperations } from './ops.js';

export interface WebRuntimeTarget {
  registerTool: ToolRegistrar;
}

function attachWiringMeta(tool: AgentTool<any>, meta: ToolWiringMeta): WirableTool {
  const wirable = tool as WirableTool;
  wirable.wiringMeta = meta;
  return wirable;
}

export interface RegisterWebToolsOptions {
  gatewayMode?: boolean;
}

export function registerWebTools(
  target: WebRuntimeTarget,
  ops: WebFetchOperations,
  options?: RegisterWebToolsOptions,
): void {
  const tool = createWebFetchTool(ops);
  if (options?.gatewayMode) {
    attachWiringMeta(tool, { requiredGatewayMethods: ['web.fetch'] });
  }
  target.registerTool(tool, 'core');
}
