import type { AgentTool } from '../../pi-agent/index.js';
import type { ToolRegistrar } from '../../../core/agent/tool-registrar.js';
import type { ToolWiringMeta, WirableTool } from '../../../core/agent/tool-wiring-validator.js';
import { createWebTool, type WebToolBackend } from './tools.js';
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
  /** Explicit web backend selection (bead psfn-framework-htm9.10). */
  backend?: WebToolBackend;
}

export function registerWebTools(
  target: WebRuntimeTarget,
  ops: WebFetchOperations,
  options?: RegisterWebToolsOptions,
): void {
  const backend = options?.backend ?? 'self_hosted';
  const tool = createWebTool(ops, options?.searchQueryJson, backend);
  if (options?.gatewayMode) {
    const requiredGatewayMethods = backend === 'openrouter'
      ? ['web.fetch', 'web.search']
      : ['web.fetch'];
    attachWiringMeta(tool, { requiredGatewayMethods });
  }
  target.registerTool(tool, 'core');
}
