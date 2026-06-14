import type { SubstrateConfig } from './runtime-config-contracts.js';
import { LLMClient, type LLMClientRuntimeOptions } from '../../primitives/llm/client.js';
import {
  createEmbeddingProviderFromConfig,
  type EmbeddingRuntimeProvider,
} from '../../faculties/memory/embedding.js';
import {
  createPostgresModelUsageStoreFromConfig,
  type PostgresModelUsageStore,
} from '../../persistence/postgres/model-usage-store.js';

export interface ProviderRuntimeServices {
  llmClient: LLMClient;
  embeddingProvider: EmbeddingRuntimeProvider;
  modelUsageStore?: PostgresModelUsageStore;
}

export interface ProviderRuntimeFactoryOptions {
  config: SubstrateConfig;
  providerEnv?: NodeJS.ProcessEnv;
  llmOptions?: LLMClientRuntimeOptions;
}

export function createProviderRuntimeServices(
  options: ProviderRuntimeFactoryOptions,
): ProviderRuntimeServices {
  const providerEnv = options.providerEnv ?? process.env;
  const modelUsageStore = createPostgresModelUsageStoreFromConfig(options.config);
  const llmOptions = modelUsageStore
    ? {
        ...(options.llmOptions ?? {}),
        usageRecorder: options.llmOptions?.usageRecorder ?? modelUsageStore,
      }
    : options.llmOptions;
  return {
    llmClient: new LLMClient(options.config, llmOptions),
    embeddingProvider: createEmbeddingProviderFromConfig(options.config, providerEnv),
    ...(modelUsageStore ? { modelUsageStore } : {}),
  };
}
