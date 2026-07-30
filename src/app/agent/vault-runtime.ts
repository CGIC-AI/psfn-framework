import type { GatewayClient } from '../../boundary/gateway/client.js';
import {
  requireEnabledVaultName,
  resolveVaultToolsEnabled,
} from '../../boundary/integrations/vault/enablement.js';
import { GatewayVaultOps } from '../../boundary/integrations/vault/gateway-ops.js';
import {
  registerVaultTools,
  type VaultRuntimeTarget,
} from '../../boundary/integrations/vault/runtime-wiring.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

export function wireAgentVaultRuntime(input: {
  target: VaultRuntimeTarget;
  gateway: GatewayClient;
  config: Pick<SubstrateConfig, 'obsidianVaultName'>;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = input.env ?? process.env;
  if (!resolveVaultToolsEnabled(env.VAULT_TOOLS_ENABLED)) {
    return false;
  }

  const vaultName = requireEnabledVaultName(input.config.obsidianVaultName);

  registerVaultTools(
    input.target,
    new GatewayVaultOps(input.gateway, { vaultName }),
    { gatewayMode: true },
  );
  return true;
}
