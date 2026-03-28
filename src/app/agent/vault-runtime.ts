import type { SubstrateAgent } from '../../agent/substrate-agent.js';
import type { GatewayClient } from '../../boundary/gateway/client.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

const log = createComponentLogger('Agent');

type VaultAutoPublisher = import('../../boundary/integrations/vault/auto-publish.js').VaultAutoPublisher;

async function createGatewayVaultOps(
  gateway: GatewayClient,
  config: SubstrateConfig,
) {
  const { GatewayVaultOps } = await import('../../boundary/integrations/vault/gateway-ops.js');
  return new GatewayVaultOps(gateway, {
    vaultName: config.obsidianVaultName!,
    cliPath: config.obsidianCliPath,
    timeoutMs: config.obsidianTimeoutMs,
  });
}

export async function registerOptionalVaultTools(
  agentLoop: SubstrateAgent,
  gateway: GatewayClient,
  config: SubstrateConfig,
): Promise<void> {
  if (!config.obsidianVaultName) {
    return;
  }

  const [{ registerVaultTools }, vaultOps] = await Promise.all([
    import('../../boundary/integrations/vault/runtime-wiring.js'),
    createGatewayVaultOps(gateway, config),
  ]);
  registerVaultTools(agentLoop, vaultOps, { gatewayMode: true });
  log.info('Obsidian vault tools enabled', { vault: config.obsidianVaultName });
}

export async function createOptionalVaultAutoPublisher(
  gateway: GatewayClient,
  config: SubstrateConfig,
): Promise<VaultAutoPublisher | undefined> {
  if (!config.obsidianAutoPublish || !config.obsidianVaultName) {
    return undefined;
  }

  const [{ VaultAutoPublisher }, vaultOps] = await Promise.all([
    import('../../boundary/integrations/vault/auto-publish.js'),
    createGatewayVaultOps(gateway, config),
  ]);
  const vaultAutoPublisher = new VaultAutoPublisher(vaultOps);
  log.info('Vault auto-publish enabled for reflections');
  return vaultAutoPublisher;
}
