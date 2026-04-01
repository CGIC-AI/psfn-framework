// ── Vault Runtime Wiring ──
// Instantiates VaultOps and registers the unified vault tool on a target.

import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type { WirableTool, ToolWiringMeta } from '../agent/tool-wiring-validator.js';
import { VaultOps, type VaultOpsConfig, type VaultOperations } from './ops.js';
import { createVaultTool } from './tools.js';

export interface VaultRuntimeTarget {
  registerTool: ToolRegistrar;
}

const VAULT_TOOL_GATEWAY_METHODS = [
  'vault.write',
  'vault.read',
  'vault.search',
  'vault.daily',
] as const;

function attachWiringMeta(tool: AgentTool<any>, meta: ToolWiringMeta): WirableTool {
  const wirable = tool as WirableTool;
  wirable.wiringMeta = {
    ...(wirable.wiringMeta ?? {}),
    ...meta,
  };
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
  const tool = createVaultTool(vaultOps);
  attachWiringMeta(tool, {
    ...(options?.gatewayMode ? { requiredGatewayMethods: [...VAULT_TOOL_GATEWAY_METHODS] } : {}),
    requiredServices: ['vault'],
  });
  target.registerTool(tool, 'extended');
}

export function wireVaultRuntime(
  target: VaultRuntimeTarget,
  config: Partial<VaultOpsConfig> & Pick<VaultOpsConfig, 'vaultName'>,
): VaultOps {
  const vaultOps = new VaultOps(config);
  registerVaultTools(target, vaultOps);
  return vaultOps;
}
