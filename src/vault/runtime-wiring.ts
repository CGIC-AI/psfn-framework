// ── Vault Runtime Wiring ──
// Instantiates VaultOps and registers all 4 vault tools on a target (SubstrateAgent).

import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type { WirableTool, ToolWiringMeta } from '../agent/tool-wiring-validator.js';
import { VaultOps, type VaultOpsConfig, type VaultOperations } from './ops.js';
import {
  createVaultWriteTool,
  createVaultReadTool,
  createVaultSearchTool,
  createVaultDailyTool,
} from './tools.js';

export interface VaultRuntimeTarget {
  registerTool: ToolRegistrar;
}

/** Gateway RPC methods required by each vault tool */
const VAULT_TOOL_GATEWAY_METHODS: Record<string, string[]> = {
  vault_write: ['vault.write'],
  vault_read: ['vault.read'],
  vault_search: ['vault.search'],
  vault_daily: ['vault.daily'],
};

function attachWiringMeta(tool: AgentTool<any>, meta: ToolWiringMeta): WirableTool {
  const wirable = tool as WirableTool;
  wirable.wiringMeta = meta;
  return wirable;
}

export interface RegisterVaultToolsOptions {
  /** When true, attaches gateway RPC method requirements as wiring metadata */
  gatewayMode?: boolean;
}

export function registerVaultTools(
  target: VaultRuntimeTarget,
  vaultOps: VaultOperations,
  options?: RegisterVaultToolsOptions,
): void {
  const tools: AgentTool<any>[] = [
    createVaultWriteTool(vaultOps),
    createVaultReadTool(vaultOps),
    createVaultSearchTool(vaultOps),
    createVaultDailyTool(vaultOps),
  ];

  for (const tool of tools) {
    if (options?.gatewayMode) {
      const methods = VAULT_TOOL_GATEWAY_METHODS[tool.name];
      attachWiringMeta(tool, { requiredGatewayMethods: methods });
    }
    target.registerTool(tool, 'extended');
  }
}

export function wireVaultRuntime(
  target: VaultRuntimeTarget,
  config: Partial<VaultOpsConfig> & Pick<VaultOpsConfig, 'vaultName'>,
): VaultOps {
  const vaultOps = new VaultOps(config);
  registerVaultTools(target, vaultOps);
  return vaultOps;
}
