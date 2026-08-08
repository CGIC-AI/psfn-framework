import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { LLMClientRuntimeOptions } from '../../primitives/llm/client.js';
import {
  ModelDiscovery,
  createModelDiscoveryCredential,
  deriveGenericOpenAiModelsApiUrl,
  type ModelDiscoverySource,
} from '../../primitives/llm/discovery.js';
import { VaultOps, type VaultOperations } from '../integrations/vault/ops.js';
import {
  createProviderRuntimeServices,
  type ProviderRuntimeServices,
} from '../../system/config/provider-runtime-factory.js';
import { resolveOptionalCredentialReference } from '../custody/credential-vault.js';
import type { PolicyConfig } from './policy.js';
import { consumeActiveGatewayCapturedProviderCostEvidence } from './llm-cost-capture.js';
import { requireEnabledVaultName } from '../integrations/vault/enablement.js';
import type { ProviderRegistryEntry } from '../../shared/contracts/runtime.js';

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
  const modelDiscoverySources = deriveModelDiscoverySources(input.config, input.providerEnv);
  const modelDiscovery = modelDiscoverySources.length > 0
    ? new ModelDiscovery(modelDiscoverySources)
    : undefined;
  const vaultOps = createGatewayVaultOps(input.config, input.vaultPolicyConfig);

  return {
    ...providerRuntime,
    ...(modelDiscovery ? { modelDiscovery } : {}),
    ...(vaultOps ? { vaultOps } : {}),
  };
}

/**
 * Derive provider-driven model discovery sources from the canonical provider
 * registry. OpenRouter contributes its authoritative catalog plus ZDR
 * enrichment and the global metadata map; configured generic OpenAI-compatible
 * routers contribute their authoritative `/v1/models` catalog. No LiteLLM URL
 * is required and no router software is inferred from URLs or headers.
 */
function deriveModelDiscoverySources(
  config: SubstrateConfig,
  providerEnv: NodeJS.ProcessEnv,
): ModelDiscoverySource[] {
  const providers = config.providerRegistry?.providers ?? [];
  const sources: ModelDiscoverySource[] = [];

  for (const provider of providers) {
    if (!provider.enabled) continue;
    if (provider.type === 'openrouter') {
      const modelsApiUrl = resolveOpenRouterModelsApiUrl(provider, config);
      if (!modelsApiUrl) continue;
      sources.push({
        kind: 'openrouter',
        providerId: provider.id,
        modelsApiUrl,
        ...(provider.label ? { label: provider.label } : {}),
      });
    } else if (provider.type === 'generic_openai') {
      const modelsApiUrl = provider.modelsApiUrl?.trim()
        ?? deriveGenericOpenAiModelsApiUrl(provider.apiBaseUrl);
      if (!modelsApiUrl) continue;
      const credential = buildProviderDiscoveryCredential(provider, config, providerEnv);
      sources.push({
        kind: 'generic-openai-compatible',
        providerId: provider.id,
        modelsApiUrl,
        ...(provider.label ? { label: provider.label } : {}),
        ...(credential ? { credential } : {}),
      });
    }
  }

  return sources;
}

function resolveOpenRouterModelsApiUrl(
  provider: ProviderRegistryEntry,
  config: SubstrateConfig,
): string | undefined {
  const configured = provider.modelsApiUrl?.trim() ?? config.openRouterModelsApiUrl?.trim();
  return configured && configured.length > 0 ? configured : undefined;
}

function buildProviderDiscoveryCredential(
  provider: ProviderRegistryEntry,
  config: SubstrateConfig,
  providerEnv: NodeJS.ProcessEnv,
): ReturnType<typeof createModelDiscoveryCredential> | undefined {
  const apiKeyRef = provider.apiKeyRef;
  if (!apiKeyRef) return undefined;
  return createModelDiscoveryCredential(
    () => resolveOptionalCredentialReference(config.credentialVault, apiKeyRef, providerEnv),
  );
}
