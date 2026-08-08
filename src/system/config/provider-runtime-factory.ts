import type { SubstrateConfig } from './runtime-config-contracts.js';
import { LLMClient, type LLMClientRuntimeOptions } from '../../primitives/llm/client.js';
import {
  PiProviderRuntime,
  type ProviderRuntime,
} from '../../primitives/llm/provider-runtime.js';
import {
  createEmbeddingProviderFromConfig,
  type EmbeddingRuntimeProvider,
} from '../../faculties/memory/embedding.js';
import { withEmbeddingUsageAccounting } from '../../faculties/memory/embedding-accounting.js';
import { resolveModelUsageCostRatesForIdentity } from '../../primitives/llm/model-budget.js';
import {
  createPostgresModelUsageStoreFromConfig,
  type ModelUsageStoreScope,
  type PostgresModelUsageStore,
} from '../../persistence/postgres/model-usage-store.js';

export interface ProviderRuntimeServices {
  runtime: ProviderRuntime;
  llmClient: LLMClient;
  embeddingProvider: EmbeddingRuntimeProvider;
  modelUsageStore?: PostgresModelUsageStore;
}

export interface ProviderRuntimeFactoryOptions {
  config: SubstrateConfig;
  providerEnv?: NodeJS.ProcessEnv;
  llmOptions?: LLMClientRuntimeOptions;
  modelUsageScope?: ModelUsageStoreScope;
}

export function createProviderRuntimeServices(
  options: ProviderRuntimeFactoryOptions,
): ProviderRuntimeServices {
  const providerEnv = options.providerEnv ?? process.env;
  const runtime = options.llmOptions?.runtime ?? new PiProviderRuntime();
  const modelUsageStore = createPostgresModelUsageStoreFromConfig(
    options.config,
    options.modelUsageScope,
  );
  const usageCompanionId = options.modelUsageScope
    ? ('companionId' in options.modelUsageScope
      ? options.modelUsageScope.companionId
      : undefined)
    : options.config.companionId;
  const embeddingProvider = createEmbeddingProviderFromConfig(options.config, providerEnv);
  const embeddingRates = resolveModelUsageCostRatesForIdentity(options.config, {
    provider: embeddingProvider.kind,
    model: embeddingProvider.model,
  });
  const llmOptions = modelUsageStore
    ? {
        ...(options.llmOptions ?? {}),
        runtime,
        usageRecorder: options.llmOptions?.usageRecorder ?? modelUsageStore,
        usageBudgetQuery: options.llmOptions?.usageBudgetQuery ?? modelUsageStore,
        ...(
          options.modelUsageScope
          && 'fleetAggregation' in options.modelUsageScope
          && options.modelUsageScope.fleetAggregation === true
            ? {
                icpConversationCostAccounting:
                  options.llmOptions?.icpConversationCostAccounting ?? modelUsageStore,
              }
            : {}
        ),
      }
    : {
        ...(options.llmOptions ?? {}),
        runtime,
      };
  return {
    runtime,
    llmClient: new LLMClient(options.config, llmOptions),
    embeddingProvider: modelUsageStore
      ? withEmbeddingUsageAccounting(embeddingProvider, modelUsageStore, {
          estimatedRates: embeddingRates,
          ...(usageCompanionId ? { companionId: usageCompanionId } : {}),
        })
      : embeddingProvider,
    ...(modelUsageStore ? { modelUsageStore } : {}),
  };
}
