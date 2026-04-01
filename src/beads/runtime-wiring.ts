import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { EventBus } from '../event-bus.js';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type { ToolWiringMeta, WirableTool } from '../agent/tool-wiring-validator.js';
import type { BeadsOperations } from './ops.js';
import { createLegacyAliasTelemetryEmitter } from '../tools/legacy-alias-telemetry.js';
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
  eventBus?: EventBus;
  gatewayMode?: boolean;
}

export function registerBeadsTools(
  target: BeadsRuntimeTarget,
  ops: BeadsOperations,
  options?: RegisterBeadsToolsOptions,
): void {
  const tool: AgentTool<any> = createBeadsTool(ops, {
    emitLegacyAliasTelemetry: createLegacyAliasTelemetryEmitter(options?.eventBus),
  });
  if (options?.gatewayMode) {
    attachWiringMeta(tool, { requiredGatewayMethods: [...BEADS_TOOL_GATEWAY_METHODS] });
  }
  target.registerTool(tool, 'extended');
}
