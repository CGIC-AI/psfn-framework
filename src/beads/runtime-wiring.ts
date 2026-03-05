import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type { ToolWiringMeta, WirableTool } from '../agent/tool-wiring-validator.js';
import type { BeadsOperations } from './ops.js';
import {
  createIssueCloseTool,
  createIssueCreateTool,
  createIssueReadyTool,
  createIssueShowTool,
  createIssueSyncTool,
  createIssueUpdateTool,
} from './tools.js';

export interface BeadsRuntimeTarget {
  registerTool: ToolRegistrar;
}

const BEADS_TOOL_GATEWAY_METHODS: Record<string, string[]> = {
  issue_ready: ['beads.ready'],
  issue_show: ['beads.show'],
  issue_create: ['beads.create'],
  issue_update: ['beads.update'],
  issue_close: ['beads.close'],
  issue_sync: ['beads.sync'],
};

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
  const tools: AgentTool<any>[] = [
    createIssueReadyTool(ops),
    createIssueShowTool(ops),
    createIssueCreateTool(ops),
    createIssueUpdateTool(ops),
    createIssueCloseTool(ops),
    createIssueSyncTool(ops),
  ];

  for (const tool of tools) {
    if (options?.gatewayMode) {
      const methods = BEADS_TOOL_GATEWAY_METHODS[tool.name];
      if (methods) {
        attachWiringMeta(tool, { requiredGatewayMethods: methods });
      }
    }
    target.registerTool(tool, 'extended');
  }
}
