import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type { ToolWiringMeta, WirableTool } from '../agent/tool-wiring-validator.js';
import type { FilesystemOperations } from './ops.js';
import { WorkspaceFilesystemOps } from './local-ops.js';
import { createFsTool } from './tools.js';

export interface FilesystemRuntimeTarget {
  registerTool: ToolRegistrar;
}

const FILESYSTEM_TOOL_GATEWAY_METHODS: Record<string, string[]> = {
  fs: ['fs.read', 'fs.list', 'fs.search', 'fs.write', 'fs.edit'],
};

function attachWiringMeta(tool: AgentTool<any>, meta: ToolWiringMeta): WirableTool {
  const wirable = tool as WirableTool;
  wirable.wiringMeta = meta;
  return wirable;
}

export interface RegisterFilesystemToolsOptions {
  gatewayMode?: boolean;
}

export function registerFilesystemTools(
  target: FilesystemRuntimeTarget,
  ops: FilesystemOperations,
  options?: RegisterFilesystemToolsOptions,
): void {
  const tools: AgentTool<any>[] = [createFsTool(ops)];

  for (const tool of tools) {
    if (options?.gatewayMode) {
      attachWiringMeta(tool, { requiredGatewayMethods: FILESYSTEM_TOOL_GATEWAY_METHODS[tool.name] });
    }
    target.registerTool(tool, 'core');
  }
}

export function wireFilesystemRuntime(
  target: FilesystemRuntimeTarget,
  workspacePath: string,
): WorkspaceFilesystemOps {
  const ops = new WorkspaceFilesystemOps(workspacePath);
  registerFilesystemTools(target, ops);
  return ops;
}
