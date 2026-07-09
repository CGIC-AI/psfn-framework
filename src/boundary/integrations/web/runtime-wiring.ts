import type { AgentTool } from '../../pi-agent/index.js';
import type { ToolRegistrar } from '../../../core/agent/tool-registrar.js';
import type { ToolWiringMeta, WirableTool } from '../../../core/agent/tool-wiring-validator.js';
import { createWebTool } from './tools.js';
import type { WebFetchOperations } from './ops.js';
import type { WebSearchQueryJson } from './search.js';

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
  searchQueryJson?: WebSearchQueryJson;
}

export function registerWebTools(
  target: WebRuntimeTarget,
  ops: WebFetchOperations,
  options?: RegisterWebToolsOptions,
): void {
  const tool = createWebTool(ops, options?.searchQueryJson);
  if (options?.gatewayMode) {
    attachWiringMeta(tool, { requiredGatewayMethods: ['web.fetch'] });
  }
  target.registerTool(tool, 'core');
}
