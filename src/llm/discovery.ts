// ── Model Discovery ──
// Fetches available models from LiteLLM proxy and enriches with OpenRouter metadata.
// Admin-only — not a runtime dependency. 5-minute cache.

import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('ModelDiscovery');

export interface DiscoveredModel {
  id: string;
  description?: string;
  providerHints?: string[];
  contextLength?: number;
  maxCompletionTokens?: number;
  pricing?: Record<string, string>;
}

export interface ModelDiscoveryOptions {
  fetchFn?: typeof fetch;
  allowDirectNetworkEgress?: boolean;
}

interface LiteLLMModelEntry {
  id: string;
  object?: string;
  provider?: string;
  litellm_provider?: string;
  owned_by?: string;
  model_info?: {
    provider?: string;
    litellm_provider?: string;
    providers?: string[];
  };
}

interface OpenRouterModelEntry {
  id: string;
  canonical_slug?: string;
  name?: string;
  description?: string;
  context_length?: number;
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
  pricing?: Record<string, string | undefined>;
}

function providerFromModelId(modelId: string): string | undefined {
  const [prefix] = modelId.split('/');
  const trimmed = prefix.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeProviderHints(values: Array<string | undefined>): string[] {
  return [...new Set(
    values
      .map(value => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean),
  )];
}

function providerHintsFromLiteLLM(entry: LiteLLMModelEntry): string[] {
  const modelInfoProviders = Array.isArray(entry.model_info?.providers)
    ? entry.model_info.providers
    : [];
  return normalizeProviderHints([
    entry.provider,
    entry.litellm_provider,
    entry.owned_by,
    entry.model_info?.provider,
    entry.model_info?.litellm_provider,
    ...modelInfoProviders,
  ]);
}

function normalizePricing(pricing: OpenRouterModelEntry['pricing']): Record<string, string> | undefined {
  if (!pricing || typeof pricing !== 'object') return undefined;
  const entries = Object.entries(pricing)
    .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : ''] as const)
    .filter(([, value]) => value.length > 0);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

function isGatewayAgentEntrypoint(): boolean {
  const entrypoint = (process.argv[1] ?? '')
    .replace(/\\/g, '/')
    .toLowerCase();
  return entrypoint.endsWith('/agent-main.ts') || entrypoint.endsWith('/agent-main.js');
}

export class ModelDiscovery {
  private litellmBaseUrl: string;
  private litellmApiKey?: string;
  private fetchFn?: typeof fetch;
  private allowDirectNetworkEgress: boolean;
  private cache: DiscoveredModel[] | null = null;
  private cacheTime = 0;

  constructor(
    litellmBaseUrl: string,
    litellmApiKey?: string,
    options: ModelDiscoveryOptions = {},
  ) {
    // Strip trailing /v1 if present — we add our own paths
    this.litellmBaseUrl = litellmBaseUrl.replace(/\/v1\/?$/, '');
    this.litellmApiKey = litellmApiKey;
    this.fetchFn = options.fetchFn;
    this.allowDirectNetworkEgress = options.allowDirectNetworkEgress ?? !isGatewayAgentEntrypoint();
  }

  async getAvailableModels(): Promise<DiscoveredModel[]> {
    if (this.cache && Date.now() - this.cacheTime < CACHE_TTL_MS) {
      return this.cache;
    }

    const [litellmModels, openRouterMeta] = await Promise.all([
      this.fetchLiteLLM(),
      this.fetchOpenRouterMeta(),
    ]);

    // Build a metadata lookup from OpenRouter
    const metaMap = new Map<string, OpenRouterModelEntry>();
    for (const m of openRouterMeta) {
      metaMap.set(m.id, m);
    }

    // Merge: LiteLLM provides the available model list, OpenRouter enriches it
    const models: DiscoveredModel[] = litellmModels.map(lm => {
      const meta = metaMap.get(lm.id);
      const providerHints = normalizeProviderHints([
        ...providerHintsFromLiteLLM(lm),
        ...(meta ? ['openrouter'] : []),
        providerFromModelId(meta?.canonical_slug ?? lm.id),
      ]);
      return {
        id: lm.id,
        description: meta?.description ?? meta?.name,
        ...(providerHints.length > 0 ? { providerHints } : {}),
        contextLength: meta?.top_provider?.context_length ?? meta?.context_length,
        maxCompletionTokens: meta?.top_provider?.max_completion_tokens,
        pricing: normalizePricing(meta?.pricing),
      };
    });

    this.cache = models;
    this.cacheTime = Date.now();
    log.info(`Discovered ${models.length} models`);
    return models;
  }

  invalidateCache(): void {
    this.cache = null;
    this.cacheTime = 0;
  }

  private resolveFetch(): typeof fetch {
    if (this.fetchFn) return this.fetchFn;
    if (this.allowDirectNetworkEgress) return fetch;
    throw new Error(
      'Direct network egress is disabled; model discovery requires gateway-backed fetch wiring.',
    );
  }

  private async fetchLiteLLM(): Promise<LiteLLMModelEntry[]> {
    try {
      const headers: Record<string, string> = {};
      if (this.litellmApiKey) {
        headers['Authorization'] = `Bearer ${this.litellmApiKey}`;
      }
      const res = await this.resolveFetch()(`${this.litellmBaseUrl}/v1/models`, { headers });
      if (!res.ok) {
        log.warn(`LiteLLM /v1/models returned ${res.status}`);
        return [];
      }
      const data = await res.json() as { data?: LiteLLMModelEntry[] };
      return data.data ?? [];
    } catch (err) {
      log.warn('Failed to fetch LiteLLM models', { error: String(err) });
      return [];
    }
  }

  private async fetchOpenRouterMeta(): Promise<OpenRouterModelEntry[]> {
    try {
      const res = await this.resolveFetch()('https://openrouter.ai/api/v1/models');
      if (!res.ok) {
        log.warn(`OpenRouter /api/v1/models returned ${res.status}`);
        return [];
      }
      const data = await res.json() as { data?: OpenRouterModelEntry[] };
      return data.data ?? [];
    } catch (err) {
      log.warn('Failed to fetch OpenRouter metadata', { error: String(err) });
      return [];
    }
  }
}
