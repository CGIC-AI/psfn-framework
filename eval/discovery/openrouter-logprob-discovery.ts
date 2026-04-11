export const DEFAULT_OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_TOP_LOGPROBS_MAX = 20;

export type TargetModelGroup = 'key' | 'additional';
export type ProbeMode = 'none' | 'ambiguous' | 'supported';

export interface TargetModel {
  id: string;
  group: TargetModelGroup;
}

export interface OpenRouterModelEntry {
  id: string;
  name?: string;
  description?: string;
  supported_parameters?: string[] | null;
}

export interface OpenRouterEndpointEntry {
  name?: string;
  provider_name?: string;
  tag?: string;
  quantization?: string | null;
  status?: number;
  supported_parameters?: string[] | null;
}

export interface ProviderProbeResult {
  attempted: boolean;
  status: 'supported' | 'unsupported' | 'skipped' | 'error';
  httpStatus?: number;
  error?: string;
  responseId?: string;
  responseModel?: string;
}

export interface ProviderSupportRecord {
  id: string;
  baseSlug: string;
  providerName?: string;
  endpointName?: string;
  quantization?: string | null;
  routeStatus: number | null;
  routeHealthy: boolean;
  supportedParameters: string[];
  logprobs: boolean;
  topLogprobs: boolean;
  topLogprobsMax: number;
  discoverySource: 'endpoint_metadata' | 'live_probe' | 'endpoint_metadata+live_probe' | 'unknown';
  probe: ProviderProbeResult;
}

export interface ModelSupportRecord {
  group: TargetModelGroup;
  label?: string;
  supportedParameters: string[];
  supported: boolean;
  topLogprobsSupported: boolean;
  providerCount: number;
  healthyProviderCount: number;
  providers: ProviderSupportRecord[];
  notes: string[];
}

export interface LogprobSupportTable {
  schemaVersion: 1;
  generatedAt: string;
  apiBaseUrl: string;
  probeMode: ProbeMode;
  topLogprobsMax: number;
  targets: TargetModel[];
  warnings: string[];
  missingModels: string[];
  models: Record<string, ModelSupportRecord>;
}

export interface DiscoverOpenRouterLogprobSupportOptions {
  fetchFn?: typeof fetch;
  apiBaseUrl?: string;
  apiKey?: string;
  targets?: readonly TargetModel[];
  probeMode?: ProbeMode;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export const TARGET_MODELS: readonly TargetModel[] = Object.freeze([
  { id: 'moonshotai/kimi-k2.5', group: 'key' },
  { id: 'z-ai/glm-5', group: 'key' },
  { id: 'deepseek/deepseek-v3.2', group: 'key' },
  { id: 'minimax/minimax-m2.7', group: 'key' },
  { id: 'qwen/qwen3.6-plus:free', group: 'key' },
  { id: 'openai/gpt-5.3-chat', group: 'additional' },
  { id: 'arcee-ai/trinity-large-thinking', group: 'additional' },
  { id: 'google/gemini-3.1-pro-preview', group: 'additional' },
  { id: 'nvidia/nemotron-3-super-120b-a12b', group: 'additional' },
  { id: 'xiaomi/mimo-v2-pro', group: 'additional' },
  { id: 'stepfun/step-3.5-flash:free', group: 'additional' },
  { id: 'mistralai/mistral-small-2603', group: 'additional' },
]);

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSupportedParameters(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const entry of value) {
    const normalized = normalizeOptionalString(entry)?.toLowerCase();
    if (normalized) {
      unique.add(normalized);
    }
  }
  return [...unique].sort((left, right) => left.localeCompare(right));
}

function normalizeBaseUrl(value: string | undefined): string {
  const raw = normalizeOptionalString(value) ?? DEFAULT_OPENROUTER_API_BASE_URL;
  return raw.replace(/\/+$/, '');
}

function normalizeApiKey(value: string | undefined): string | undefined {
  return normalizeOptionalString(value);
}

function normalizeTargets(targets: readonly TargetModel[] | undefined): TargetModel[] {
  const selected = targets ?? TARGET_MODELS;
  const seen = new Set<string>();
  const ordered: TargetModel[] = [];
  for (const target of selected) {
    const id = normalizeOptionalString(target.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ordered.push({
      id,
      group: target.group,
    });
  }
  return ordered;
}

function buildFetchInit(
  apiKey: string | undefined,
  init: RequestInit = {},
): RequestInit {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }
  if (apiKey && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${apiKey}`);
  }
  return {
    ...init,
    headers,
  };
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function extractErrorMessage(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const maybeError = (payload as { error?: unknown }).error;
    if (maybeError && typeof maybeError === 'object') {
      const message = normalizeOptionalString((maybeError as { message?: unknown }).message);
      if (message) return message;
    }
    const message = normalizeOptionalString((payload as { message?: unknown }).message);
    if (message) return message;
    const raw = normalizeOptionalString((payload as { raw?: unknown }).raw);
    if (raw) return raw;
  }
  return 'Unknown OpenRouter error';
}

async function fetchJson(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; payload: unknown }> {
  const response = await fetchFn(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await parseJsonResponse(response);
  return { response, payload };
}

function findModelEntry(
  models: readonly OpenRouterModelEntry[],
  modelId: string,
): OpenRouterModelEntry | undefined {
  return models.find((entry) => entry.id === modelId);
}

function providerBaseSlug(tag: string | undefined, providerName: string | undefined): string {
  const normalizedTag = normalizeOptionalString(tag);
  if (normalizedTag) {
    const slashIndex = normalizedTag.indexOf('/');
    return slashIndex > 0 ? normalizedTag.slice(0, slashIndex) : normalizedTag;
  }
  const normalizedProviderName = normalizeOptionalString(providerName)?.toLowerCase();
  if (!normalizedProviderName) return 'unknown';
  return normalizedProviderName
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildProviderRecord(endpoint: OpenRouterEndpointEntry): ProviderSupportRecord {
  const supportedParameters = normalizeSupportedParameters(endpoint.supported_parameters);
  const supportsLogprobs = supportedParameters.includes('logprobs');
  const supportsTopLogprobs = supportedParameters.includes('top_logprobs');
  const id = normalizeOptionalString(endpoint.tag) ?? providerBaseSlug(undefined, endpoint.provider_name);
  const routeStatus = typeof endpoint.status === 'number' ? endpoint.status : null;
  return {
    id,
    baseSlug: providerBaseSlug(id, endpoint.provider_name),
    providerName: normalizeOptionalString(endpoint.provider_name),
    endpointName: normalizeOptionalString(endpoint.name),
    quantization: normalizeOptionalString(endpoint.quantization) ?? null,
    routeStatus,
    routeHealthy: routeStatus === 0,
    supportedParameters,
    logprobs: supportsLogprobs,
    topLogprobs: supportsTopLogprobs,
    topLogprobsMax: supportsTopLogprobs ? OPENROUTER_TOP_LOGPROBS_MAX : 0,
    discoverySource: supportedParameters.length > 0 ? 'endpoint_metadata' : 'unknown',
    probe: {
      attempted: false,
      status: 'skipped',
    },
  };
}

function shouldProbeProvider(
  provider: ProviderSupportRecord,
  probeMode: ProbeMode,
): boolean {
  if (probeMode === 'none') return false;
  if (!provider.routeHealthy) return false;
  if (provider.id === 'unknown') return false;
  if (probeMode === 'supported') {
    return provider.logprobs || provider.topLogprobs || provider.supportedParameters.length === 0;
  }
  return provider.supportedParameters.length === 0;
}

function extractLogprobSupport(payload: unknown): {
  logprobs: boolean;
  topLogprobs: boolean;
  responseId?: string;
  responseModel?: string;
} {
  if (!payload || typeof payload !== 'object') {
    return { logprobs: false, topLogprobs: false };
  }

  const typedPayload = payload as {
    id?: unknown;
    model?: unknown;
    choices?: Array<{
      logprobs?: {
        content?: Array<{
          logprob?: unknown;
          top_logprobs?: unknown;
        }>;
        token_logprobs?: unknown;
        top_logprobs?: unknown;
        tokens?: unknown;
      };
    }>;
  };
  const choice = Array.isArray(typedPayload.choices) ? typedPayload.choices[0] : undefined;
  const logprobs = choice?.logprobs;
  if (!logprobs || typeof logprobs !== 'object') {
    return {
      logprobs: false,
      topLogprobs: false,
      responseId: normalizeOptionalString(typedPayload.id),
      responseModel: normalizeOptionalString(typedPayload.model),
    };
  }

  const content = Array.isArray(logprobs.content) ? logprobs.content : [];
  const contentHasLogprobs = content.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    return typeof (entry as { logprob?: unknown }).logprob === 'number';
  });
  const contentHasTopLogprobs = content.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    return Array.isArray((entry as { top_logprobs?: unknown }).top_logprobs)
      && ((entry as { top_logprobs?: unknown[] }).top_logprobs?.length ?? 0) > 0;
  });

  const legacyHasLogprobs = Array.isArray(logprobs.token_logprobs)
    ? logprobs.token_logprobs.length > 0
    : Array.isArray(logprobs.tokens) && logprobs.tokens.length > 0;
  const legacyHasTopLogprobs = Array.isArray(logprobs.top_logprobs)
    && logprobs.top_logprobs.length > 0;

  return {
    logprobs: contentHasLogprobs || legacyHasLogprobs || contentHasTopLogprobs || legacyHasTopLogprobs,
    topLogprobs: contentHasTopLogprobs || legacyHasTopLogprobs,
    responseId: normalizeOptionalString(typedPayload.id),
    responseModel: normalizeOptionalString(typedPayload.model),
  };
}

async function probeProviderSupport(
  fetchFn: typeof fetch,
  apiBaseUrl: string,
  apiKey: string,
  modelId: string,
  providerId: string,
  timeoutMs: number,
): Promise<ProviderProbeResult & { logprobs: boolean; topLogprobs: boolean }> {
  const { response, payload } = await fetchJson(
    fetchFn,
    `${apiBaseUrl}/chat/completions`,
    buildFetchInit(apiKey, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: 'user',
            content: 'Reply with exactly one token: ok',
          },
        ],
        max_tokens: 1,
        temperature: 0,
        seed: 1,
        logprobs: true,
        top_logprobs: OPENROUTER_TOP_LOGPROBS_MAX,
        provider: {
          order: [providerId],
          allow_fallbacks: false,
          require_parameters: true,
        },
      }),
    }),
    timeoutMs,
  );

  if (!response.ok) {
    return {
      attempted: true,
      status: 'error',
      httpStatus: response.status,
      error: extractErrorMessage(payload),
      logprobs: false,
      topLogprobs: false,
    };
  }

  const support = extractLogprobSupport(payload);
  return {
    attempted: true,
    status: support.logprobs ? 'supported' : 'unsupported',
    responseId: support.responseId,
    responseModel: support.responseModel,
    logprobs: support.logprobs,
    topLogprobs: support.topLogprobs,
  };
}

export async function discoverOpenRouterLogprobSupport(
  options: DiscoverOpenRouterLogprobSupportOptions = {},
): Promise<LogprobSupportTable> {
  const fetchFn = options.fetchFn ?? fetch;
  const apiBaseUrl = normalizeBaseUrl(options.apiBaseUrl);
  const apiKey = normalizeApiKey(options.apiKey);
  const targets = normalizeTargets(options.targets);
  const probeMode = options.probeMode ?? 'ambiguous';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const warnings: string[] = [];
  if (!apiKey && probeMode !== 'none') {
    warnings.push(
      'OPENROUTER_API_KEY is not configured; falling back to metadata-only discovery for live probes.',
    );
  }

  const { response, payload } = await fetchJson(
    fetchFn,
    `${apiBaseUrl}/models`,
    buildFetchInit(apiKey),
    timeoutMs,
  );
  if (!response.ok) {
    throw new Error(`OpenRouter /models returned ${response.status}: ${extractErrorMessage(payload)}`);
  }

  const modelsPayload = payload as { data?: OpenRouterModelEntry[] };
  const catalog = Array.isArray(modelsPayload.data) ? modelsPayload.data : [];
  const missingModels: string[] = [];
  const modelRecords: Record<string, ModelSupportRecord> = {};

  for (const target of targets) {
    const model = findModelEntry(catalog, target.id);
    if (!model) {
      missingModels.push(target.id);
      modelRecords[target.id] = {
        group: target.group,
        supportedParameters: [],
        supported: false,
        topLogprobsSupported: false,
        providerCount: 0,
        healthyProviderCount: 0,
        providers: [],
        notes: ['Model not present in OpenRouter /models response'],
      };
      continue;
    }

    const modelSupportedParameters = normalizeSupportedParameters(model.supported_parameters);
    const notes: string[] = [];
    let endpoints: OpenRouterEndpointEntry[] = [];

    try {
      const endpointsResult = await fetchJson(
        fetchFn,
        `${apiBaseUrl}/models/${target.id}/endpoints`,
        buildFetchInit(apiKey),
        timeoutMs,
      );
      if (!endpointsResult.response.ok) {
        notes.push(
          `OpenRouter /models/${target.id}/endpoints returned ${endpointsResult.response.status}: `
          + extractErrorMessage(endpointsResult.payload),
        );
      } else {
        const endpointsPayload = endpointsResult.payload as {
          data?: { endpoints?: OpenRouterEndpointEntry[] };
        };
        endpoints = Array.isArray(endpointsPayload.data?.endpoints)
          ? endpointsPayload.data.endpoints
          : [];
      }
    } catch (error) {
      notes.push(
        `Failed to fetch /models/${target.id}/endpoints: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const providers = endpoints
      .map((endpoint) => buildProviderRecord(endpoint))
      .sort((left, right) => left.id.localeCompare(right.id));

    if (providers.length === 0) {
      notes.push('No provider endpoints were returned for this model.');
    }

    for (const provider of providers) {
      if (!apiKey || !shouldProbeProvider(provider, probeMode)) {
        continue;
      }
      try {
        const probe = await probeProviderSupport(
          fetchFn,
          apiBaseUrl,
          apiKey,
          target.id,
          provider.id,
          timeoutMs,
        );
        provider.probe = {
          attempted: probe.attempted,
          status: probe.status,
          ...(probe.httpStatus !== undefined ? { httpStatus: probe.httpStatus } : {}),
          ...(probe.error ? { error: probe.error } : {}),
          ...(probe.responseId ? { responseId: probe.responseId } : {}),
          ...(probe.responseModel ? { responseModel: probe.responseModel } : {}),
        };
        if (probe.logprobs) {
          provider.logprobs = true;
          provider.topLogprobs = probe.topLogprobs;
          provider.topLogprobsMax = probe.topLogprobs ? OPENROUTER_TOP_LOGPROBS_MAX : 0;
          provider.discoverySource = provider.discoverySource === 'endpoint_metadata'
            ? 'endpoint_metadata+live_probe'
            : 'live_probe';
        } else if (provider.supportedParameters.length === 0) {
          provider.logprobs = false;
          provider.topLogprobs = false;
          provider.topLogprobsMax = 0;
          provider.discoverySource = 'live_probe';
        }
      } catch (error) {
        provider.probe = {
          attempted: true,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    modelRecords[target.id] = {
      group: target.group,
      ...(normalizeOptionalString(model.name) ? { label: normalizeOptionalString(model.name) } : {}),
      supportedParameters: modelSupportedParameters,
      supported: providers.some((provider) => provider.logprobs),
      topLogprobsSupported: providers.some((provider) => provider.topLogprobs),
      providerCount: providers.length,
      healthyProviderCount: providers.filter((provider) => provider.routeHealthy).length,
      providers,
      notes,
    };
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    apiBaseUrl,
    probeMode,
    topLogprobsMax: OPENROUTER_TOP_LOGPROBS_MAX,
    targets,
    warnings,
    missingModels,
    models: modelRecords,
  };
}
