// ── Model Discovery ──
// Fetches available models from LiteLLM proxy and enriches with OpenRouter metadata.
// Admin-only — not a runtime dependency. 5-minute cache.

import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('ModelDiscovery');

export interface DiscoveredModel {
  id: string;
  description?: string;
  contextLength?: number;
  maxCompletionTokens?: number;
  pricing?: { prompt: string; completion: string };
}

interface LiteLLMModelEntry {
  id: string;
  object?: string;
}

interface OpenRouterModelEntry {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  top_provider?: { max_completion_tokens?: number };
  pricing?: { prompt?: string; completion?: string };
}

const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

export class ModelDiscovery {
  private litellmBaseUrl: string;
  private litellmApiKey?: string;
  private cache: DiscoveredModel[] | null = null;
  private cacheTime = 0;

  constructor(litellmBaseUrl: string, litellmApiKey?: string) {
    // Strip trailing /v1 if present — we add our own paths
    this.litellmBaseUrl = litellmBaseUrl.replace(/\/v1\/?$/, '');
    this.litellmApiKey = litellmApiKey;
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
      return {
        id: lm.id,
        description: meta?.description ?? meta?.name,
        contextLength: meta?.context_length,
        maxCompletionTokens: meta?.top_provider?.max_completion_tokens,
        pricing: meta?.pricing ? {
          prompt: meta.pricing.prompt ?? '0',
          completion: meta.pricing.completion ?? '0',
        } : undefined,
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

  private async fetchLiteLLM(): Promise<LiteLLMModelEntry[]> {
    try {
      const headers: Record<string, string> = {};
      if (this.litellmApiKey) {
        headers['Authorization'] = `Bearer ${this.litellmApiKey}`;
      }
      const res = await fetch(`${this.litellmBaseUrl}/v1/models`, { headers });
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
      const res = await fetch('https://openrouter.ai/api/v1/models');
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
