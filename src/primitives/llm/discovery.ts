// ── Model Discovery ──
// Provider-driven discovery. Enumerates configured discovery sources
// (OpenRouter metadata/ZDR, configured generic OpenAI-compatible external
// routers, and deterministic catalog models) and joins authoritative catalogs
// with optional OpenRouter enrichment. No LiteLLM URL prerequisite.
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

export interface ModelDiscoveryBackend {
  getAvailableModels(): Promise<DiscoveredModel[]>;
  invalidateCache(): void;
}

export interface GatewayModelDiscoveryTransport {
  getAvailableModels(): Promise<DiscoveredModel[]>;
  invalidateModelDiscoveryCache(): Promise<void>;
}

/**
 * Auth presence for a discovery source. Carried in cache/in-flight identity so
 * two credential states never share a fetch, but the secret value itself is
 * never part of any key.
 */
export type ModelDiscoveryAuthPresence = 'present' | 'none';

/**
 * Credential handle for a discovery source. `authPresence` is computed once at
 * construction (so it can key caches) and the value is resolved lazily at fetch
 * time; the resolved secret is never stored on the handle.
 */
export interface ModelDiscoveryCredential {
  readonly authPresence: ModelDiscoveryAuthPresence;
  resolve(): string | undefined;
}

/**
 * Authoritative OpenRouter source. The OpenRouter models API is the
 * authoritative catalog for OpenRouter-routed models and also supplies the ZDR
 * endpoint enrichment and the global metadata map used to enrich other sources.
 */
export interface OpenRouterDiscoverySource {
  readonly kind: 'openrouter';
  readonly providerId: string;
  readonly modelsApiUrl: string;
  readonly zdrEndpointsApiUrl?: string;
  readonly credential?: ModelDiscoveryCredential;
  readonly label?: string;
}

/**
 * Configured generic OpenAI-compatible external router. Its `/v1/models` catalog
 * is authoritative for the models that endpoint serves; entries are enriched
 * with OpenRouter metadata/ZDR when OpenRouter is also configured. The router's
 * implementation identity is operational detail, never inferred from the URL.
 */
export interface GenericOpenAiDiscoverySource {
  readonly kind: 'generic-openai-compatible';
  readonly providerId: string;
  readonly modelsApiUrl: string;
  readonly credential?: ModelDiscoveryCredential;
  readonly label?: string;
}

/**
 * Deterministic catalog source with no network egress. Used for tests and for
 * configured providers whose models are known statically (e.g. direct
 * built-in providers registered in the pi-ai runtime).
 */
export interface CatalogDiscoverySource {
  readonly kind: 'catalog';
  readonly providerId: string;
  readonly models: readonly DiscoveredModel[];
  readonly label?: string;
}

export type ModelDiscoverySource =
  | OpenRouterDiscoverySource
  | GenericOpenAiDiscoverySource
  | CatalogDiscoverySource;

export interface ModelDiscoveryOptions {
  fetchFn?: typeof fetch;
  allowDirectNetworkEgress?: boolean;
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

/**
 * Minimal OpenAI-compatible `/v1/models` entry (`{ id, object, owned_by }`).
 * Generic external routers speak this shape; richer metadata comes from
 * OpenRouter enrichment when available.
 */
interface GenericModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
}

const MODEL_ID_WRAPPER_PREFIXES = new Set(['openrouter']);

function providerFromModelId(modelId: string): string | undefined {
  const [prefix] = modelId.split('/');
  const trimmed = prefix?.trim() ?? '';
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

function readModalitySideTokens(value: string, side: 'input' | 'output'): string[] {
  const arrowIndex = value.indexOf('->');
  const sideValue = arrowIndex >= 0
    ? (side === 'input' ? value.slice(0, arrowIndex) : value.slice(arrowIndex + 2))
    : value;
  return normalizeModalityTokens([sideValue]);
}

function inferDiscoveryTextModel(meta: OpenRouterModelEntry): boolean {
  const outputModalities = Array.isArray(meta.architecture?.output_modalities)
    ? normalizeModalityTokens(meta.architecture.output_modalities)
    : [];
  const modality = typeof meta.architecture?.modality === 'string'
    ? meta.architecture.modality.trim()
    : '';
  const inferredOutputModalities = outputModalities.length > 0
    ? outputModalities
    : (modality.length > 0 ? readModalitySideTokens(modality, 'output') : []);

  if (inferredOutputModalities.length > 0 && (
    inferredOutputModalities.length !== 1
    || inferredOutputModalities[0] !== 'text'
  )) {
    return false;
  }

  const inputModalities = Array.isArray(meta.architecture?.input_modalities)
    ? normalizeModalityTokens(meta.architecture.input_modalities)
    : [];
  const inferredInputModalities = inputModalities.length > 0
    ? inputModalities
    : (modality.length > 0 ? readModalitySideTokens(modality, 'input') : []);

  if (inferredInputModalities.length === 0) {
    return true;
  }

  const inputSet = new Set(inferredInputModalities);
  if (!inputSet.has('text')) {
    return false;
  }

  const auxiliaryModalities = inferredInputModalities.filter(modality => modality !== 'text');
  if (auxiliaryModalities.length > 1) {
    return false;
  }
  return auxiliaryModalities.every(modality => modality === 'image' || modality === 'file');
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

function buildOpenRouterMetaMap(
  metas: readonly OpenRouterModelEntry[],
): Map<string, OpenRouterModelEntry> {
  const metaMap = new Map<string, OpenRouterModelEntry>();
  for (const meta of metas) {
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
  modelId: string,
  metaMap: Map<string, OpenRouterModelEntry>,
): OpenRouterModelEntry | undefined {
  for (const key of expandModelLookupKeys(modelId)) {
    const matched = metaMap.get(key);
    if (matched) return matched;
  }
  return undefined;
}

function findOpenRouterZdrEndpointSummary(
  modelId: string,
  meta: OpenRouterModelEntry | undefined,
  endpointMap: Map<string, OpenRouterZdrEndpointSummary>,
): OpenRouterZdrEndpointSummary | undefined {
  for (const key of [
    ...expandModelLookupKeys(modelId),
    ...expandModelLookupKeys(meta?.id),
    ...expandModelLookupKeys(meta?.canonical_slug),
  ]) {
    const matched = endpointMap.get(key);
    if (matched) return matched;
  }
  return undefined;
}

function withZdrSummary(
  base: Omit<DiscoveredModel, 'zdrAvailable' | 'zdrEndpointCount' | 'zdrProviderTags' | 'zdrProviderNames'>,
  summary: OpenRouterZdrEndpointSummary | undefined,
): DiscoveredModel {
  if (!summary) return base;
  return {
    ...base,
    zdrAvailable: true,
    zdrEndpointCount: summary.count,
    ...(summary.providerTags.length > 0 ? { zdrProviderTags: summary.providerTags } : {}),
    ...(summary.providerNames.length > 0 ? { zdrProviderNames: summary.providerNames } : {}),
  };
}

function discoveredModelFromOpenRouterMeta(
  meta: OpenRouterModelEntry,
  zdrMap: Map<string, OpenRouterZdrEndpointSummary>,
): DiscoveredModel {
  const zdrSummary = findOpenRouterZdrEndpointSummary(meta.id, meta, zdrMap);
  const providerHints = normalizeProviderHints([
    'openrouter',
    providerFromModelId(meta.canonical_slug ?? meta.id),
  ]);

  return withZdrSummary({
    id: meta.id,
    description: meta.description ?? meta.name,
    ...(providerHints.length > 0 ? { providerHints } : {}),
    contextLength: meta.top_provider?.context_length ?? meta.context_length,
    maxCompletionTokens: meta.top_provider?.max_completion_tokens,
    pricing: normalizePricing(meta.pricing),
    ...(inferSupportsVision(meta) ? { supportsVision: true } : {}),
    ...(inferSupportsReasoning(meta) ? { supportsReasoning: true } : {}),
  }, zdrSummary);
}

/**
 * Build a discovered model from a generic OpenAI-compatible `/v1/models` entry.
 * When OpenRouter metadata is available for the same id, the rich pricing/
 * capability/context metadata is adopted; otherwise a minimal id-only entry is
 * returned. Provider hints reflect the serving endpoint, not OpenRouter.
 */
function discoveredModelFromGenericEntry(
  entry: GenericModelEntry,
  source: GenericOpenAiDiscoverySource,
  openRouterMetaMap: Map<string, OpenRouterModelEntry>,
  zdrMap: Map<string, OpenRouterZdrEndpointSummary>,
): DiscoveredModel {
  const meta = findOpenRouterMeta(entry.id, openRouterMetaMap);
  const zdrSummary = findOpenRouterZdrEndpointSummary(entry.id, meta, zdrMap);
  const providerHints = normalizeProviderHints([
    source.providerId,
    entry.owned_by,
    providerFromModelId(entry.id),
  ]);

  if (meta) {
    return withZdrSummary({
      id: entry.id,
      description: meta.description ?? meta.name,
      ...(providerHints.length > 0 ? { providerHints } : {}),
      contextLength: meta.top_provider?.context_length ?? meta.context_length,
      maxCompletionTokens: meta.top_provider?.max_completion_tokens,
      pricing: normalizePricing(meta.pricing),
      ...(inferSupportsVision(meta) ? { supportsVision: true } : {}),
      ...(inferSupportsReasoning(meta) ? { supportsReasoning: true } : {}),
    }, zdrSummary);
  }

  return withZdrSummary({
    id: entry.id,
    ...(providerHints.length > 0 ? { providerHints } : {}),
  }, zdrSummary);
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

/**
 * Derive the standards-based OpenAI-compatible models endpoint from a base URL.
 * This is the well-known `/models` path, not an inference about router software.
 */
export function deriveGenericOpenAiModelsApiUrl(apiBaseUrl: string | undefined): string | undefined {
  if (!apiBaseUrl) return undefined;
  const trimmed = apiBaseUrl.trim().replace(/\/+$/u, '');
  return trimmed.length > 0 ? `${trimmed}/models` : undefined;
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

type ModelDiscoveryFetchPurpose = 'models' | 'zdr-endpoints';

function buildInFlightFetchKey(
  kind: ModelDiscoverySource['kind'],
  providerId: string,
  purpose: ModelDiscoveryFetchPurpose,
  endpoint: string,
  authPresence: ModelDiscoveryAuthPresence,
): string {
  return JSON.stringify([kind, providerId, purpose, endpoint, authPresence]);
}

function isOpenRouterSource(source: ModelDiscoverySource): source is OpenRouterDiscoverySource {
  return source.kind === 'openrouter';
}

function isGenericSource(source: ModelDiscoverySource): source is GenericOpenAiDiscoverySource {
  return source.kind === 'generic-openai-compatible';
}

function isCatalogSource(source: ModelDiscoverySource): source is CatalogDiscoverySource {
  return source.kind === 'catalog';
}

function assertSourceUrl(source: ModelDiscoverySource): string {
  if (source.kind === 'catalog') return '';
  const url = source.modelsApiUrl.trim();
  if (!url) {
    throw new Error(
      `Model discovery ${source.kind} source "${source.providerId}" requires a non-empty modelsApiUrl`,
    );
  }
  return url;
}

function isGatewayAgentEntrypoint(): boolean {
  const entrypoint = (process.argv[1] ?? '')
    .replace(/\\/g, '/')
    .toLowerCase();
  return entrypoint.endsWith('/agent-main.ts') || entrypoint.endsWith('/agent-main.js');
}

/**
 * Create a discovery credential handle. `authPresence` is computed once from a
 * value-free presence probe; the resolver is retained for lazy resolution at
 * fetch time. The resolved secret is never stored on the handle and never
 * appears in a cache/in-flight key.
 */
export function createModelDiscoveryCredential(
  resolveKey: () => string | undefined,
  options: { presenceProbe?: () => string | undefined } = {},
): ModelDiscoveryCredential {
  const probe = options.presenceProbe ?? resolveKey;
  const authPresence: ModelDiscoveryAuthPresence = probe() ? 'present' : 'none';
  return {
    authPresence,
    resolve: resolveKey,
  };
}

export class ModelDiscovery implements ModelDiscoveryBackend {
  private readonly sources: readonly ModelDiscoverySource[];
  private readonly openRouterSource?: OpenRouterDiscoverySource;
  private readonly genericSources: readonly GenericOpenAiDiscoverySource[];
  private readonly catalogSources: readonly CatalogDiscoverySource[];
  private fetchFn?: typeof fetch;
  private allowDirectNetworkEgress: boolean;
  private cache: DiscoveredModel[] | null = null;
  private cacheTime = 0;
  private readonly inFlightFetches = new Map<string, Promise<unknown>>();

  constructor(
    sources: readonly ModelDiscoverySource[],
    options: ModelDiscoveryOptions = {},
  ) {
    this.sources = sources;
    // Validate network source URLs eagerly (fail closed) without mutating input.
    for (const source of sources) {
      assertSourceUrl(source);
    }
    this.openRouterSource = sources.find(isOpenRouterSource);
    this.genericSources = sources.filter(isGenericSource);
    this.catalogSources = sources.filter(isCatalogSource);
    this.fetchFn = options.fetchFn;
    this.allowDirectNetworkEgress = options.allowDirectNetworkEgress ?? !isGatewayAgentEntrypoint();
  }

  async getAvailableModels(): Promise<DiscoveredModel[]> {
    if (this.cache && Date.now() - this.cacheTime < CACHE_TTL_MS) {
      return this.cache;
    }

    let openRouterMetas: OpenRouterModelEntry[] = [];
    let openRouterZdrEndpoints: OpenRouterZdrEndpointEntry[] = [];
    if (this.openRouterSource) {
      [openRouterMetas, openRouterZdrEndpoints] = await Promise.all([
        this.fetchOpenRouterMeta(this.openRouterSource),
        this.fetchOpenRouterZdrEndpoints(this.openRouterSource),
      ]);
    }
    const genericCatalogs = await Promise.all(
      this.genericSources.map(source => this.fetchGenericCatalog(source)),
    );

    const zdrMap = buildOpenRouterZdrEndpointMap(openRouterZdrEndpoints);
    const openRouterMetaMap = buildOpenRouterMetaMap(openRouterMetas);

    // Merge sources into a single id-keyed catalog. Configured serving endpoints
    // (generic routers) take precedence over the OpenRouter direct catalog and
    // deterministic catalog models, so a model routed through a shared external
    // router is reported under the endpoint the operator actually uses rather
    // than duplicated under OpenRouter.
    const byId = new Map<string, DiscoveredModel>();
    const addUnique = (model: DiscoveredModel): void => {
      if (!byId.has(model.id)) byId.set(model.id, model);
    };

    this.genericSources.forEach((source, index) => {
      const catalog = genericCatalogs[index];
      if (catalog === undefined) {
        return;
      }
      for (const entry of catalog) {
        addUnique(discoveredModelFromGenericEntry(entry, source, openRouterMetaMap, zdrMap));
      }
    });

    if (this.openRouterSource) {
      const textModels = openRouterMetas.filter(inferDiscoveryTextModel);
      for (const meta of textModels) {
        addUnique(discoveredModelFromOpenRouterMeta(meta, zdrMap));
      }
    }

    for (const source of this.catalogSources) {
      for (const model of source.models) {
        addUnique(model);
      }
    }

    const models = [...byId.values()];

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

  private coalesceInFlightFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const existing = this.inFlightFetches.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = Promise.resolve()
      .then(fetcher)
      .finally(() => {
        if (this.inFlightFetches.get(key) === promise) {
          this.inFlightFetches.delete(key);
        }
      });
    this.inFlightFetches.set(key, promise);
    return promise;
  }

  private buildAuthHeaders(credential: ModelDiscoveryCredential | undefined): Record<string, string> {
    if (!credential || credential.authPresence !== 'present') return {};
    const key = credential.resolve();
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  private fetchOpenRouterMeta(source: OpenRouterDiscoverySource): Promise<OpenRouterModelEntry[]> {
    const authPresence = source.credential?.authPresence ?? 'none';
    const key = buildInFlightFetchKey('openrouter', source.providerId, 'models', source.modelsApiUrl, authPresence);
    const headers = this.buildAuthHeaders(source.credential);
    return this.coalesceInFlightFetch(key, async () => {
      try {
        const res = await this.resolveFetch()(source.modelsApiUrl, { headers });
        if (!res.ok) {
          throw new Error(`OpenRouter models API at ${redactUrl(source.modelsApiUrl)} returned ${res.status}`);
        }
        const data = await res.json() as { data?: OpenRouterModelEntry[] };
        if (!Array.isArray(data.data)) {
          throw new Error(`OpenRouter models API at ${redactUrl(source.modelsApiUrl)} returned an invalid catalog`);
        }
        return data.data;
      } catch (err) {
        log.warn('Failed to fetch OpenRouter metadata', {
          providerId: source.providerId,
          error: String(err),
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    });
  }

  private fetchOpenRouterZdrEndpoints(source: OpenRouterDiscoverySource): Promise<OpenRouterZdrEndpointEntry[]> {
    const url = source.zdrEndpointsApiUrl?.trim()
      || deriveOpenRouterZdrEndpointsApiUrl(source.modelsApiUrl);
    const key = buildInFlightFetchKey('openrouter', source.providerId, 'zdr-endpoints', url, 'none');
    return this.coalesceInFlightFetch(key, async () => {
      try {
        const res = await this.resolveFetch()(url);
        if (!res.ok) {
          log.warn(`OpenRouter ZDR endpoints API at ${redactUrl(url)} returned ${res.status}`);
          return [];
        }
        const data = await res.json() as { data?: OpenRouterZdrEndpointEntry[] };
        return data.data ?? [];
      } catch (err) {
        log.warn('Failed to fetch OpenRouter ZDR endpoints', {
          providerId: source.providerId,
          error: String(err),
        });
        return [];
      }
    });
  }

  private fetchGenericCatalog(source: GenericOpenAiDiscoverySource): Promise<GenericModelEntry[]> {
    const authPresence = source.credential?.authPresence ?? 'none';
    const key = buildInFlightFetchKey('generic-openai-compatible', source.providerId, 'models', source.modelsApiUrl, authPresence);
    const headers = this.buildAuthHeaders(source.credential);
    return this.coalesceInFlightFetch(key, async () => {
      try {
        const res = await this.resolveFetch()(source.modelsApiUrl, { headers });
        if (!res.ok) {
          throw new Error(
            `Provider "${source.providerId}" models API at ${redactUrl(source.modelsApiUrl)} returned ${res.status}`,
          );
        }
        const data = await res.json() as { data?: GenericModelEntry[] };
        if (!Array.isArray(data.data)) {
          throw new Error(
            `Provider "${source.providerId}" models API at ${redactUrl(source.modelsApiUrl)} returned an invalid catalog`,
          );
        }
        return data.data;
      } catch (err) {
        log.warn('Failed to fetch generic provider models catalog', {
          providerId: source.providerId,
          error: String(err),
        });
        throw err instanceof Error ? err : new Error(String(err));
      }
    });
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
