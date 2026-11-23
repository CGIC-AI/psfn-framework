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
    // Phase 3.3 (b3h5p.3): shell is a core workspace surface replacing retired
    // repo and fs list/search wrappers; operators can still disable it per
    // companion via capability-tier.json disabledTools.
    target.registerTool(tool, 'core');
  }
}
