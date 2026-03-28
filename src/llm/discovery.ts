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
  supportsVision?: boolean;
  supportsReasoning?: boolean;
}

export interface ModelDiscoveryOptions {
  fetchFn?: typeof fetch;
  allowDirectNetworkEgress?: boolean;
  openRouterModelsApiUrl: string;
}

export interface ModelDiscoveryBackend {
  getAvailableModels(): Promise<DiscoveredModel[]>;
  invalidateCache(): void;
}

export interface GatewayModelDiscoveryTransport {
  getAvailableModels(): Promise<unknown[]>;
  invalidateModelDiscoveryCache(): Promise<void>;
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
  modalities?: string[] | null;
  architecture?: {
    modality?: string | null;
    input_modalities?: string[] | null;
    output_modalities?: string[] | null;
    tokenizer?: string | null;
    instruct_type?: string | null;
  };
  supported_parameters?: string[] | null;
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
  pricing?: Record<string, string | undefined>;
}

const MODEL_ID_WRAPPER_PREFIXES = new Set(['openrouter', 'litellm', 'proxy']);

function providerFromModelId(modelId: string): string | undefined {
  const [prefix] = modelId.split('/');
  const trimmed = prefix.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeLookupKey(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function expandModelLookupKeys(modelId: string | undefined): string[] {
  const base = normalizeLookupKey(modelId);
  if (!base) return [];
  const queue = [base];
  const keys: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    keys.push(candidate);

    const slashIndex = candidate.indexOf('/');
    if (slashIndex > 0) {
      const prefix = candidate.slice(0, slashIndex);
      const rest = candidate.slice(slashIndex + 1).trim();
      if (rest && MODEL_ID_WRAPPER_PREFIXES.has(prefix)) {
        queue.push(rest);
      }
    }

    const colonIndex = candidate.indexOf(':');
    if (colonIndex > 0) {
      const prefix = candidate.slice(0, colonIndex);
      const rest = candidate.slice(colonIndex + 1).trim();
      if (rest && MODEL_ID_WRAPPER_PREFIXES.has(prefix)) {
        queue.push(rest);
      }
    }
  }
  return keys;
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

function normalizeLowerToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function inferSupportsVision(meta: OpenRouterModelEntry | undefined): boolean | undefined {
  if (!meta) return undefined;
  const tokens = new Set<string>();
  const push = (value: unknown): void => {
    const normalized = normalizeLowerToken(value);
    if (normalized) {
      tokens.add(normalized);
    }
  };

  if (typeof meta.architecture?.modality === 'string') {
    const parts = meta.architecture.modality.split(/[^a-z0-9_+-]+/i);
    for (const part of parts) {
      push(part);
    }
  }
  if (Array.isArray(meta.architecture?.input_modalities)) {
    for (const modality of meta.architecture.input_modalities) {
      push(modality);
    }
  }
  if (Array.isArray(meta.architecture?.output_modalities)) {
    for (const modality of meta.architecture.output_modalities) {
      push(modality);
    }
  }
  if (Array.isArray(meta.modalities)) {
    for (const modality of meta.modalities) {
      push(modality);
    }
  }

  for (const token of tokens) {
    if (token.includes('image') || token.includes('vision') || token.includes('video')) {
      return true;
    }
  }
  return undefined;
}

function inferSupportsReasoning(meta: OpenRouterModelEntry | undefined): boolean | undefined {
  if (!meta) return undefined;
  const supportedParameters = Array.isArray(meta.supported_parameters)
    ? meta.supported_parameters
    : [];
  for (const parameter of supportedParameters) {
    const normalized = normalizeLowerToken(parameter);
    if (!normalized) continue;
    if (normalized === 'reasoning' || normalized === 'include_reasoning') {
      return true;
    }
  }
  if (typeof meta.pricing?.internal_reasoning === 'string' && meta.pricing.internal_reasoning.trim().length > 0) {
    return true;
  }
  return undefined;
}

function buildOpenRouterMetaMap(openRouterMeta: OpenRouterModelEntry[]): Map<string, OpenRouterModelEntry> {
  const metaMap = new Map<string, OpenRouterModelEntry>();
  for (const meta of openRouterMeta) {
    for (const key of [
      ...expandModelLookupKeys(meta.id),
      ...expandModelLookupKeys(meta.canonical_slug),
    ]) {
      if (!metaMap.has(key)) {
        metaMap.set(key, meta);
      }
    }
  }
  return metaMap;
}

function findOpenRouterMeta(
  litellmId: string,
  metaMap: Map<string, OpenRouterModelEntry>,
): OpenRouterModelEntry | undefined {
  for (const key of expandModelLookupKeys(litellmId)) {
    const matched = metaMap.get(key);
    if (matched) return matched;
  }
  return undefined;
}

const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

function isGatewayAgentEntrypoint(): boolean {
  const entrypoint = (process.argv[1] ?? '')
    .replace(/\\/g, '/')
    .toLowerCase();
  return entrypoint.endsWith('/agent-main.ts') || entrypoint.endsWith('/agent-main.js');
}

export class ModelDiscovery implements ModelDiscoveryBackend {
  private litellmBaseUrl: string;
  private litellmApiKey?: string;
  private openRouterModelsApiUrl: string;
  private fetchFn?: typeof fetch;
  private allowDirectNetworkEgress: boolean;
  private cache: DiscoveredModel[] | null = null;
  private cacheTime = 0;

  constructor(
    litellmBaseUrl: string,
    litellmApiKey: string | undefined,
    options: ModelDiscoveryOptions,
  ) {
    // Strip trailing /v1 if present — we add our own paths
    this.litellmBaseUrl = litellmBaseUrl.replace(/\/v1\/?$/, '');
    this.litellmApiKey = litellmApiKey;
    const openRouterModelsApiUrl = options.openRouterModelsApiUrl.trim();
    if (!openRouterModelsApiUrl) {
      throw new Error('Model discovery requires openRouterModelsApiUrl');
    }
    this.openRouterModelsApiUrl = openRouterModelsApiUrl;
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
    const metaMap = buildOpenRouterMetaMap(openRouterMeta);

    // Merge: LiteLLM provides the available model list, OpenRouter enriches it
    const models: DiscoveredModel[] = litellmModels.map(lm => {
      const meta = findOpenRouterMeta(lm.id, metaMap);
      const providerHints = normalizeProviderHints([
        ...providerHintsFromLiteLLM(lm),
        ...(meta ? ['openrouter'] : []),
        providerFromModelId(meta?.canonical_slug ?? meta?.id ?? lm.id),
      ]);
      return {
        id: lm.id,
        description: meta?.description ?? meta?.name,
        ...(providerHints.length > 0 ? { providerHints } : {}),
        contextLength: meta?.top_provider?.context_length ?? meta?.context_length,
        maxCompletionTokens: meta?.top_provider?.max_completion_tokens,
        pricing: normalizePricing(meta?.pricing),
        ...(inferSupportsVision(meta) ? { supportsVision: true } : {}),
        ...(inferSupportsReasoning(meta) ? { supportsReasoning: true } : {}),
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
    const headers: Record<string, string> = {};
    if (this.litellmApiKey) {
      headers['Authorization'] = `Bearer ${this.litellmApiKey}`;
    }

    try {
      const res = await this.resolveFetch()(`${this.litellmBaseUrl}/v1/models`, { headers });
      if (!res.ok) {
        throw new Error(`LiteLLM /v1/models returned ${res.status}`);
      }
      const data = await res.json() as { data?: LiteLLMModelEntry[] };
      if (!Array.isArray(data.data)) {
        throw new Error('LiteLLM /v1/models returned invalid payload');
      }
      return data.data;
    } catch (err) {
      log.warn('Failed to fetch LiteLLM models', { error: String(err) });
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private async fetchOpenRouterMeta(): Promise<OpenRouterModelEntry[]> {
    try {
      const res = await this.resolveFetch()(this.openRouterModelsApiUrl);
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

export class GatewayModelDiscovery implements ModelDiscoveryBackend {
  private pendingInvalidation: Promise<void> | null = null;

  constructor(private readonly transport: GatewayModelDiscoveryTransport) {}

  async getAvailableModels(): Promise<DiscoveredModel[]> {
    if (this.pendingInvalidation) {
      await this.pendingInvalidation;
    }
    return await this.transport.getAvailableModels() as DiscoveredModel[];
  }

  invalidateCache(): void {
    this.pendingInvalidation = this.transport.invalidateModelDiscoveryCache()
      .catch((error) => {
        log.warn('Failed to invalidate gateway-backed model discovery cache', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.pendingInvalidation = null;
      });
  }
}
