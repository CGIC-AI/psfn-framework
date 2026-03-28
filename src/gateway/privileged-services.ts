import type { SubstrateConfig } from '../types.js';
import { createEmbeddingProviderFromConfig, type EmbeddingRuntimeProvider } from '../memory/embedding.js';
import { LLMClient, type LLMClientRuntimeOptions } from '../llm/client.js';
import { VaultOps, type VaultOperations } from '../vault/ops.js';
import type { PolicyConfig } from './policy.js';

export interface GatewayPrivilegedServiceRegistry {
  embeddingProvider: EmbeddingRuntimeProvider;
  llmClient: LLMClient;
  vaultOps?: VaultOperations;
}

export interface GatewayPrivilegedServiceRegistryInput {
  config: SubstrateConfig;
  providerEnv: NodeJS.ProcessEnv;
  llmOptions?: LLMClientRuntimeOptions;
  vaultPolicyConfig?: PolicyConfig['vault'];
}

function createGatewayVaultOps(
  config: SubstrateConfig,
  vaultPolicyConfig?: PolicyConfig['vault'],
): VaultOperations | undefined {
  if (!vaultPolicyConfig?.enabled) {
    return undefined;
  }

  if (!config.obsidianVaultName) {
    throw new Error(
      'VAULT_TOOLS_ENABLED is true but obsidianVaultName is not configured in settings.',
    );
  }

  return new VaultOps({
    vaultName: config.obsidianVaultName,
    ...(config.obsidianCliPath ? { cliPath: config.obsidianCliPath } : {}),
    ...(typeof config.obsidianTimeoutMs === 'number'
      ? { timeoutMs: config.obsidianTimeoutMs }
      : {}),
  });
}

export function createGatewayPrivilegedServiceRegistry(
  input: GatewayPrivilegedServiceRegistryInput,
): GatewayPrivilegedServiceRegistry {
  const embeddingProvider = createEmbeddingProviderFromConfig(input.config, input.providerEnv);
  const llmClient = new LLMClient(input.config, input.llmOptions);
  const vaultOps = createGatewayVaultOps(input.config, input.vaultPolicyConfig);

  return {
    embeddingProvider,
    llmClient,
    ...(vaultOps ? { vaultOps } : {}),
  };
}
