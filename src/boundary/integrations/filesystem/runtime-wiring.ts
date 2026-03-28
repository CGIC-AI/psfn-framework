import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolRegistrar } from '../../../agent/tool-registrar.js';
import type { ToolWiringMeta, WirableTool } from '../../../agent/tool-wiring-validator.js';
import type { FilesystemReadOperations } from './ops.js';
import { WorkspaceFilesystemOps } from './local-ops.js';
import { createFsListTool, createFsReadTool } from './tools.js';

export interface FilesystemRuntimeTarget {
  registerTool: ToolRegistrar;
}

const FILESYSTEM_TOOL_GATEWAY_METHODS: Record<string, string[]> = {
  fs_read: ['fs.read'],
  fs_list: ['fs.list'],
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
  ops: FilesystemReadOperations,
  options?: RegisterFilesystemToolsOptions,
): void {
  const tools: AgentTool<any>[] = [
    createFsListTool(ops),
    createFsReadTool(ops),
  ];

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
