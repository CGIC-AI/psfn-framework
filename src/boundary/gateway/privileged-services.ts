import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { LLMClientRuntimeOptions } from '../../primitives/llm/client.js';
import { ModelDiscovery } from '../../primitives/llm/discovery.js';
import { VaultOps, type VaultOperations } from '../integrations/vault/ops.js';
import {
  createProviderRuntimeServices,
  type ProviderRuntimeServices,
} from '../../system/config/provider-runtime-factory.js';
import {
  resolveConfiguredLiteLLMApiKey,
  resolveConfiguredLiteLLMBaseUrl,
} from '../../system/config/providers-config.js';
import type { PolicyConfig } from './policy.js';
import { consumeActiveGatewayCapturedProviderCostEvidence } from './llm-cost-capture.js';
import { requireEnabledVaultName } from '../integrations/vault/enablement.js';

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

  const vaultName = requireEnabledVaultName(config.obsidianVaultName);

  return new VaultOps({
    vaultName,
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
    modelUsageScope: { fleetAggregation: true },
    llmOptions: {
      ...(input.llmOptions ?? {}),
      providerCostResolver: input.llmOptions?.providerCostResolver
        ?? consumeActiveGatewayCapturedProviderCostEvidence,
    },
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
