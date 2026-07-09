import type { AgentTool } from '../../pi-agent/index.js';
import type { ToolRegistrar } from '../../../core/agent/tool-registrar.js';
import type { ToolWiringMeta, WirableTool } from '../../../core/agent/tool-wiring-validator.js';
import type { BeadsOperations } from './ops.js';
import { createBeadsTool } from './tools.js';

export interface BeadsRuntimeTarget {
  registerTool: ToolRegistrar;
}

const BEADS_TOOL_GATEWAY_METHODS = [
  'beads.ready',
  'beads.show',
  'beads.create',
  'beads.update',
  'beads.close',
  'beads.sync',
] as const;

function attachWiringMeta(tool: AgentTool<any>, meta: ToolWiringMeta): WirableTool {
  const wirable = tool as WirableTool;
  wirable.wiringMeta = meta;
  return wirable;
}

export interface RegisterBeadsToolsOptions {
  gatewayMode?: boolean;
}

export function registerBeadsTools(
  target: BeadsRuntimeTarget,
  ops: BeadsOperations,
  options?: RegisterBeadsToolsOptions,
): void {
  const tool: AgentTool<any> = createBeadsTool(ops);
  if (options?.gatewayMode) {
    attachWiringMeta(tool, { requiredGatewayMethods: [...BEADS_TOOL_GATEWAY_METHODS] });
  }
  target.registerTool(tool, 'extended');
}
