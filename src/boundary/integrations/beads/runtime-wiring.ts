import type { AgentTool } from '../../pi-agent/index.js';
import type { ToolRegistrar } from '../../../core/agent/tool-registrar.js';
import type { ToolWiringMeta, WirableTool } from '../../../core/agent/tool-wiring-validator.js';
import type { BeadsOperations } from './ops.js';
import { createBeadsTool } from './tools.js';
import type { BeadsAction } from './enablement.js';
import { resolveConfiguredBeadsActionsForCaller } from './enablement.js';

export const BEADS_POLICY_HYDRATION_SOURCE = 'beads caller-action policy';

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
  allowedActions?: readonly BeadsAction[];
}

export function registerBeadsTools(
  target: BeadsRuntimeTarget,
  ops: BeadsOperations,
  options?: RegisterBeadsToolsOptions,
): void {
  const companionActions = resolveConfiguredBeadsActionsForCaller(
    options?.allowedActions ?? ['ready', 'show', 'create', 'update', 'sync'],
    'companion',
  );
  const buildTool = (allowedActions: readonly BeadsAction[]): WirableTool => attachWiringMeta(
    createBeadsTool(ops, { allowedActions }),
    {
      ...(options?.gatewayMode ? { requiredGatewayMethods: [...BEADS_TOOL_GATEWAY_METHODS] } : {}),
      policyHydration: {
        source: BEADS_POLICY_HYDRATION_SOURCE,
        allowedActions: [...allowedActions],
      },
    },
  );
  const tool = buildTool(companionActions) as WirableTool & {
    hydrateForCaller?: (caller: { kind: 'companion' } | { kind: 'shard'; shardId: string }) => AgentTool<any>;
  };
  tool.hydrateForCaller = caller => buildTool(resolveConfiguredBeadsActionsForCaller(
    companionActions,
    caller.kind,
  ));
  target.registerTool(tool, 'extended');
}
