import type { SubstrateConfig } from '../system/config/runtime-config-contracts.js';
import type { LLMClientRuntimeOptions } from '../llm/client.js';
import { ModelDiscovery } from '../llm/discovery.js';
import { VaultOps, type VaultOperations } from '../vault/ops.js';
import {
  createProviderRuntimeServices,
  type ProviderRuntimeServices,
} from '../system/config/provider-runtime-factory.js';
import {
  resolveConfiguredLiteLLMApiKey,
  resolveConfiguredLiteLLMBaseUrl,
} from '../system/config/providers-config.js';
import type { PolicyConfig } from './policy.js';

export interface GatewayPrivilegedServiceRegistry extends ProviderRuntimeServices {
  modelDiscovery?: ModelDiscovery;
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
  const providerRuntime = createProviderRuntimeServices({
    config: input.config,
    providerEnv: input.providerEnv,
    llmOptions: input.llmOptions,
  });
  const litellmBaseUrl = resolveConfiguredLiteLLMBaseUrl(input.config);
  const modelDiscovery = litellmBaseUrl
    ? new ModelDiscovery(litellmBaseUrl, resolveConfiguredLiteLLMApiKey(input.config), {
      openRouterModelsApiUrl: input.config.openRouterModelsApiUrl ?? '',
    })
    : undefined;
  const vaultOps = createGatewayVaultOps(input.config, input.vaultPolicyConfig);

  return {
    ...providerRuntime,
    ...(modelDiscovery ? { modelDiscovery } : {}),
    ...(vaultOps ? { vaultOps } : {}),
  };
}
