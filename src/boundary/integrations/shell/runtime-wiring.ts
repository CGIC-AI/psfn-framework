import type { AgentTool } from '../../pi-agent/index.js';
import type { ToolRegistrar } from '../../../core/agent/tool-registrar.js';
import type { ToolWiringMeta, WirableTool } from '../../../core/agent/tool-wiring-validator.js';
import type { ShellOperations } from './ops.js';
import { createShellTool } from './tools.js';

export interface ShellRuntimeTarget {
  registerTool: ToolRegistrar;
}

const SHELL_TOOL_GATEWAY_METHODS: Record<string, string[]> = {
  shell: ['shell.exec'],
};

function attachWiringMeta(tool: AgentTool<any>, meta: ToolWiringMeta): WirableTool {
  const wirable = tool as WirableTool;
  wirable.wiringMeta = meta;
  return wirable;
}

export interface RegisterShellToolsOptions {
  gatewayMode?: boolean;
}

export function registerShellTools(
  target: ShellRuntimeTarget,
  ops: ShellOperations,
  options?: RegisterShellToolsOptions,
): void {
  const tools: AgentTool<any>[] = [createShellTool(ops)];

  for (const tool of tools) {
    if (options?.gatewayMode) {
      attachWiringMeta(tool, { requiredGatewayMethods: SHELL_TOOL_GATEWAY_METHODS[tool.name] });
    }
    // psfn img2 audit: shell is the heaviest/most-dangerous boundary surface
    // and a deliberate dev/ops tool, never part of the default social stack.
    // Registered extended so it stays behind toolset/load + promotion.
    target.registerTool(tool, 'extended');
  }
}
