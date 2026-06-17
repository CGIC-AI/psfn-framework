// ── Model Discovery ──
// Fetches available models from LiteLLM proxy and enriches with OpenRouter metadata.
// Admin-only — not a runtime dependency. 5-minute cache.

import { createComponentLogger } from '../../shared/logger.js';

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
  zdrAvailable?: boolean;
  zdrEndpointCount?: number;
  zdrProviderTags?: string[];
  zdrProviderNames?: string[];
}

export interface ModelDiscoveryOptions {
  fetchFn?: typeof fetch;
  allowDirectNetworkEgress?: boolean;
  openRouterModelsApiUrl: string;
  openRouterZdrEndpointsApiUrl?: string;
}

export interface ModelDiscoveryBackend {
  getAvailableModels(): Promise<DiscoveredModel[]>;
  invalidateCache(): void;
}

export interface GatewayModelDiscoveryTransport {
  getAvailableModels(): Promise<DiscoveredModel[]>;
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

interface OpenRouterZdrEndpointEntry {
  model_id?: string;
  provider_name?: string;
  tag?: string;
}

interface OpenRouterZdrEndpointSummary {
  count: number;
  providerTags: string[];
  providerNames: string[];
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

function normalizeModalityTokens(values: readonly unknown[]): string[] {
  const tokens: string[] = [];
  for (const value of values) {
    const normalized = normalizeLowerToken(value);
    if (!normalized) continue;
    for (const token of normalized.split(/[^a-z0-9]+/i)) {
      if (token.length > 0) {
        tokens.push(token);
      }
    }
  }
  return tokens;
}

function inferOutputsText(meta: OpenRouterModelEntry): boolean {
  const explicitOutputModalities = Array.isArray(meta.architecture?.output_modalities)
    ? normalizeModalityTokens(meta.architecture.output_modalities)
    : [];
  if (explicitOutputModalities.length > 0) {
    return explicitOutputModalities.includes('text');
  }

  if (typeof meta.architecture?.modality === 'string') {
    const normalizedModality = meta.architecture.modality.trim();
    if (normalizedModality.length > 0) {
      const arrowIndex = normalizedModality.indexOf('->');
      const outputSide = arrowIndex >= 0
        ? normalizedModality.slice(arrowIndex + 2)
        : normalizedModality;
      const tokens = normalizeModalityTokens([outputSide]);
      if (tokens.length > 0) {
        return tokens.includes('text');
      }
    }
  }

  const modalities = Array.isArray(meta.modalities)
    ? normalizeModalityTokens(meta.modalities)
    : [];
  if (modalities.length > 0) {
    return modalities.includes('text');
  }

  return true;
}

function buildLiteLLMModelMap(litellmModels: LiteLLMModelEntry[]): Map<string, LiteLLMModelEntry> {
  const modelMap = new Map<string, LiteLLMModelEntry>();
  for (const model of litellmModels) {
    for (const key of expandModelLookupKeys(model.id)) {
      if (!modelMap.has(key)) {
        modelMap.set(key, model);
      }
    }
  }
  return modelMap;
}

function pushUnique(target: string[], value: string | undefined): void {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || target.includes(trimmed)) return;
  target.push(trimmed);
}

function buildOpenRouterZdrEndpointMap(
  openRouterZdrEndpoints: OpenRouterZdrEndpointEntry[],
): Map<string, OpenRouterZdrEndpointSummary> {
  const endpointMap = new Map<string, OpenRouterZdrEndpointSummary>();
  for (const endpoint of openRouterZdrEndpoints) {
    const keys = expandModelLookupKeys(endpoint.model_id);
    if (keys.length === 0) continue;
    for (const key of keys) {
      const summary = endpointMap.get(key) ?? { count: 0, providerTags: [], providerNames: [] };
      summary.count += 1;
      pushUnique(summary.providerTags, endpoint.tag);
      pushUnique(summary.providerNames, endpoint.provider_name);
      endpointMap.set(key, summary);
    }
  }
  return endpointMap;
}

function findLiteLLMModel(
  meta: OpenRouterModelEntry,
  litellmModelMap: Map<string, LiteLLMModelEntry>,
): LiteLLMModelEntry | undefined {
  for (const key of [
    ...expandModelLookupKeys(meta.id),
    ...expandModelLookupKeys(meta.canonical_slug),
  ]) {
    const matched = litellmModelMap.get(key);
    if (matched) return matched;
  }
  return undefined;
}

function findOpenRouterZdrEndpointSummary(
  litellmId: string,
  meta: OpenRouterModelEntry | undefined,
  endpointMap: Map<string, OpenRouterZdrEndpointSummary>,
): OpenRouterZdrEndpointSummary | undefined {
  for (const key of [
    ...expandModelLookupKeys(litellmId),
    ...expandModelLookupKeys(meta?.id),
    ...expandModelLookupKeys(meta?.canonical_slug),
  ]) {
    const matched = endpointMap.get(key);
    if (matched) return matched;
  }
  return undefined;
}

function discoveredModelFromOpenRouterMeta(
  meta: OpenRouterModelEntry,
  litellmModelMap: Map<string, LiteLLMModelEntry>,
  endpointMap: Map<string, OpenRouterZdrEndpointSummary>,
): DiscoveredModel {
  const litellmModel = findLiteLLMModel(meta, litellmModelMap);
  const zdrEndpointSummary = findOpenRouterZdrEndpointSummary(litellmModel?.id ?? meta.id, meta, endpointMap);
  const providerHints = normalizeProviderHints([
    'openrouter',
    ...(litellmModel ? providerHintsFromLiteLLM(litellmModel) : []),
    providerFromModelId(meta.canonical_slug ?? meta.id),
  ]);

  return {
    id: meta.id,
    description: meta.description ?? meta.name,
    ...(providerHints.length > 0 ? { providerHints } : {}),
    contextLength: meta.top_provider?.context_length ?? meta.context_length,
    maxCompletionTokens: meta.top_provider?.max_completion_tokens,
    pricing: normalizePricing(meta.pricing),
    ...(inferSupportsVision(meta) ? { supportsVision: true } : {}),
    ...(inferSupportsReasoning(meta) ? { supportsReasoning: true } : {}),
    ...(zdrEndpointSummary
      ? {
          zdrAvailable: true,
          zdrEndpointCount: zdrEndpointSummary.count,
          ...(zdrEndpointSummary.providerTags.length > 0
            ? { zdrProviderTags: zdrEndpointSummary.providerTags }
            : {}),
          ...(zdrEndpointSummary.providerNames.length > 0
            ? { zdrProviderNames: zdrEndpointSummary.providerNames }
            : {}),
        }
      : {}),
  };
}

function deriveOpenRouterZdrEndpointsApiUrl(openRouterModelsApiUrl: string): string {
  try {
    const parsed = new URL(openRouterModelsApiUrl);
    parsed.pathname = '/api/v1/endpoints/zdr';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return 'https://openrouter.ai/api/v1/endpoints/zdr';
  }
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
  private openRouterZdrEndpointsApiUrl: string;
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
    this.openRouterZdrEndpointsApiUrl = options.openRouterZdrEndpointsApiUrl?.trim()
      || deriveOpenRouterZdrEndpointsApiUrl(openRouterModelsApiUrl);
    this.fetchFn = options.fetchFn;
    this.allowDirectNetworkEgress = options.allowDirectNetworkEgress ?? !isGatewayAgentEntrypoint();
  }

  async getAvailableModels(): Promise<DiscoveredModel[]> {
    if (this.cache && Date.now() - this.cacheTime < CACHE_TTL_MS) {
      return this.cache;
    }

    const [litellmModels, openRouterMeta, openRouterZdrEndpoints] = await Promise.all([
      this.fetchLiteLLMForEnrichment(),
      this.fetchOpenRouterMeta(),
      this.fetchOpenRouterZdrEndpoints(),
    ]);

    const textModels = openRouterMeta.filter(inferOutputsText);
    const litellmModelMap = buildLiteLLMModelMap(litellmModels);
    const zdrEndpointMap = buildOpenRouterZdrEndpointMap(openRouterZdrEndpoints);
    const models = textModels.map(meta => discoveredModelFromOpenRouterMeta(meta, litellmModelMap, zdrEndpointMap));

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

  private async fetchLiteLLMForEnrichment(): Promise<LiteLLMModelEntry[]> {
    try {
      return await this.fetchLiteLLM();
    } catch {
      return [];
    }
  }

  private async fetchOpenRouterMeta(): Promise<OpenRouterModelEntry[]> {
    try {
      const res = await this.resolveFetch()(this.openRouterModelsApiUrl);
      if (!res.ok) {
        throw new Error(`OpenRouter /api/v1/models returned ${res.status}`);
      }
      const data = await res.json() as { data?: OpenRouterModelEntry[] };
      if (!Array.isArray(data.data)) {
        throw new Error('OpenRouter /api/v1/models returned invalid payload');
      }
      return data.data;
    } catch (err) {
      log.warn('Failed to fetch OpenRouter metadata', { error: String(err) });
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private async fetchOpenRouterZdrEndpoints(): Promise<OpenRouterZdrEndpointEntry[]> {
    try {
      const res = await this.resolveFetch()(this.openRouterZdrEndpointsApiUrl);
      if (!res.ok) {
        log.warn(`OpenRouter /api/v1/endpoints/zdr returned ${res.status}`);
        return [];
      }
      const data = await res.json() as { data?: OpenRouterZdrEndpointEntry[] };
      return data.data ?? [];
    } catch (err) {
      log.warn('Failed to fetch OpenRouter ZDR endpoints', { error: String(err) });
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
    return await this.transport.getAvailableModels();
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
