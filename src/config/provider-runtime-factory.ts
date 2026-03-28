import type { SubstrateConfig } from '../types.js';
import { LLMClient, type LLMClientRuntimeOptions } from '../llm/client.js';
import {
  createEmbeddingProviderFromConfig,
  type EmbeddingRuntimeProvider,
} from '../memory/embedding.js';

export interface ProviderRuntimeServices {
  llmClient: LLMClient;
  embeddingProvider: EmbeddingRuntimeProvider;
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
  return {
    llmClient: new LLMClient(options.config, options.llmOptions),
    embeddingProvider: createEmbeddingProviderFromConfig(options.config, providerEnv),
  };
}
