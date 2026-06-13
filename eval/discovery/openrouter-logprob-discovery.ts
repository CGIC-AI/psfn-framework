import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_TOP_LOGPROBS_MAX = 20;

export type TargetModelGroup = 'key' | 'additional';
export type ProbeMode = 'none' | 'ambiguous' | 'supported' | 'all';
export type LogprobSupportStatus =
  | 'Works'
  | 'Top-k works'
  | 'Param accepted, no data'
  | 'Rejected'
  | 'Router-dependent'
  | 'Model-dependent'
  | 'Unstable'
  | 'Skipped'
  | 'Error';
export type YesNoPartial = 'yes' | 'no' | 'partial';
export type RouterFallbackUsed = 'true' | 'false' | 'unknown';

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

export interface ProbeDefinition {
  id:
    | 'basic_generated_logprobs'
    | 'top_alternatives'
    | 'streaming'
    | 'prompt_scoring'
    | 'deterministic_classification'
    | 'tokenization_edge'
    | 'top_logprobs_max';
  purpose: string;
  prompt: string;
  stream: boolean;
  maxTokens: number;
  topLogprobs: number;
  promptLogprobs: boolean;
}

export interface RouteDefinition {
  id: string;
  label: string;
  endpoint: 'chat' | 'chat_streaming';
  underlyingProvider: string | null;
  providerBody?: Record<string, unknown>;
  routerFallbackUsed: RouterFallbackUsed;
}

export interface ProbeObservation {
  provider: 'OpenRouter';
  underlyingProvider: string | null;
  modelId: string;
  endpoint: 'chat' | 'chat_streaming';
  routeId: string;
  routeLabel: string;
  test: ProbeDefinition['id'];
  prompt: string;
  generatedLogprobs: YesNoPartial;
  topLogprobs: YesNoPartial;
  topLogprobsRequested: number;
  topLogprobsMaxObserved: number;
  promptLogprobs: YesNoPartial;
  streamingLogprobs: YesNoPartial;
  bytesIncluded: boolean;
  tokenTextIncluded: boolean;
  nullVsErrorBehavior: 'data' | 'null' | 'missing' | 'error';
  routerFallbackUsed: RouterFallbackUsed;
  responseModel?: string;
  responseProvider?: string;
  latencyMs: number | null;
  latencyCostImpact: string | null;
  status: LogprobSupportStatus;
  error?: string;
  httpStatus?: number;
  dataPath: string | null;
  rawResponseArchived: string | null;
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
  promptLogprobs: boolean;
  streamingLogprobs: boolean;
  bytesOrTokenTextIncluded: boolean;
  nullVsErrorBehavior: 'data' | 'null' | 'missing' | 'error' | 'unknown';
  routerFallbackUsed: RouterFallbackUsed;
  generatedLogprobs: YesNoPartial;
  observedStatus: LogprobSupportStatus;
  latencyMs: number | null;
  latencyCostImpact: string | null;
  rawResponseArchived: string[];
  discoverySource: 'endpoint_metadata' | 'live_probe' | 'endpoint_metadata+live_probe' | 'unknown';
  probe: ProviderProbeResult;
  observations: ProbeObservation[];
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
  routerObservations: ProbeObservation[];
  notes: string[];
}

export interface EngineerViewRow {
  provider: 'OpenRouter';
  underlyingProvider: string | null;
  model: string;
  endpoint: string;
  generated: YesNoPartial;
  topK: YesNoPartial;
  prompt: YesNoPartial;
  stream: YesNoPartial;
  maxTopK: number;
  notes: string;
}

export interface UseCaseViewRow {
  useCase: 'Cheap label confidence' | 'Calibration experiments' | 'Perplexity / scoring' | 'Router exploration';
  recommendedProviders: string[];
  avoid: string[];
}

export interface LogprobSupportTable {
  schemaVersion: 2;
  generatedAt: string;
  apiBaseUrl: string;
  probeMode: ProbeMode;
  dateTested: string;
  topLogprobsMaxRequested: number;
  targets: TargetModel[];
  tests: ProbeDefinition[];
  warnings: string[];
  missingModels: string[];
  models: Record<string, ModelSupportRecord>;
  engineerView: EngineerViewRow[];
  useCaseView: UseCaseViewRow[];
}

export interface DiscoverOpenRouterLogprobSupportOptions {
  fetchFn?: typeof fetch;
  apiBaseUrl?: string;
  apiKey?: string;
  targets?: readonly TargetModel[];
  probeMode?: ProbeMode;
  timeoutMs?: number;
  rawArchiveDir?: string;
}

interface FetchJsonResult {
  response: Response;
  payload: unknown;
  rawText: string;
}

interface ExtractedLogprobs {
  generatedLogprobs: boolean;
  topLogprobs: boolean;
  topLogprobsMaxObserved: number;
  topAlternatives: boolean;
  promptLogprobs: boolean;
  bytesIncluded: boolean;
  tokenTextIncluded: boolean;
  nullVsErrorBehavior: 'data' | 'null' | 'missing';
  dataPath: string | null;
  responseId?: string;
  responseModel?: string;
  responseProvider?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export const TARGET_MODELS: readonly TargetModel[] = Object.freeze([
  { id: 'z-ai/glm-5.1', group: 'key' },
  { id: 'moonshotai/kimi-k2.6', group: 'key' },
  { id: 'deepseek/deepseek-v4-pro', group: 'key' },
]);

export const CANONICAL_PROBES: readonly ProbeDefinition[] = Object.freeze([
  {
    id: 'basic_generated_logprobs',
    purpose: 'Does the provider return logprobs for sampled output tokens?',
    prompt: 'Reply with exactly one word: blue',
    stream: false,
    maxTokens: 5,
    topLogprobs: 5,
    promptLogprobs: false,
  },
  {
    id: 'top_alternatives',
    purpose: 'Does top_logprobs return alternate candidate tokens, not just the chosen token?',
    prompt: 'Reply with exactly one word: blue',
    stream: false,
    maxTokens: 5,
    topLogprobs: 5,
    promptLogprobs: false,
  },
  {
    id: 'streaming',
    purpose: 'Are logprobs available during streaming?',
    prompt: 'Reply with exactly one word: blue',
    stream: true,
    maxTokens: 5,
    topLogprobs: 5,
    promptLogprobs: false,
  },
  {
    id: 'prompt_scoring',
    purpose: 'Can the endpoint return logprobs for prompt/input tokens?',
    prompt: 'Reply with exactly one word: blue',
    stream: false,
    maxTokens: 1,
    topLogprobs: 5,
    promptLogprobs: true,
  },
  {
    id: 'deterministic_classification',
    purpose: 'Can usable probabilities be read for constrained yes/no labels?',
    prompt: 'Answer only yes or no: Is Paris in France?',
    stream: false,
    maxTokens: 3,
    topLogprobs: 5,
    promptLogprobs: false,
  },
  {
    id: 'tokenization_edge',
    purpose: 'Does the provider report each generated token cleanly when text may split?',
    prompt: 'Reply with exactly this string: unbelievable',
    stream: false,
    maxTokens: 5,
    topLogprobs: 5,
    promptLogprobs: false,
  },
  {
    id: 'top_logprobs_max',
    purpose: 'Observe whether the provider honors a larger top_logprobs request.',
    prompt: 'Reply with exactly one word: blue',
    stream: false,
    maxTokens: 5,
    topLogprobs: OPENROUTER_TOP_LOGPROBS_MAX,
    promptLogprobs: false,
  },
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
    if (normalized) unique.add(normalized);
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
    ordered.push({ id, group: target.group });
  }
  return ordered;
}

function buildFetchInit(
  apiKey: string | undefined,
  init: RequestInit = {},
): RequestInit {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (apiKey && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${apiKey}`);
  return { ...init, headers };
}

async function parseJsonResponse(response: Response): Promise<{ payload: unknown; rawText: string }> {
  const rawText = await response.text();
  if (!rawText.trim()) return { payload: {}, rawText };
  try {
    return { payload: JSON.parse(rawText) as unknown, rawText };
  } catch {
    return { payload: { raw: rawText }, rawText };
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
): Promise<FetchJsonResult> {
  const response = await fetchFn(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const { payload, rawText } = await parseJsonResponse(response);
  return { response, payload, rawText };
}

async function fetchStreamingJson(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<FetchJsonResult> {
  const response = await fetchFn(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) {
    const { payload, rawText } = await parseJsonResponse(response);
    return { response, payload, rawText };
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let rawText = '';
  const chunks: unknown[] = [];
  let buffer = '';

  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const decoded = decoder.decode(next.value, { stream: true });
    rawText += decoded;
    buffer += decoded;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice('data:'.length).trim();
      if (!data || data === '[DONE]') continue;
      try {
        chunks.push(JSON.parse(data) as unknown);
      } catch {
        chunks.push({ raw: data });
      }
    }
  }

  return {
    response,
    payload: { streamChunks: chunks },
    rawText,
  };
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
    promptLogprobs: false,
    streamingLogprobs: false,
    bytesOrTokenTextIncluded: false,
    nullVsErrorBehavior: 'unknown',
    routerFallbackUsed: 'false',
    generatedLogprobs: supportsLogprobs ? 'partial' : 'no',
    observedStatus: supportsLogprobs ? 'Works' : 'Skipped',
    latencyMs: null,
    latencyCostImpact: null,
    rawResponseArchived: [],
    discoverySource: supportedParameters.length > 0 ? 'endpoint_metadata' : 'unknown',
    probe: { attempted: false, status: 'skipped' },
    observations: [],
  };
}

function shouldProbeProvider(
  provider: ProviderSupportRecord,
  probeMode: ProbeMode,
): boolean {
  if (probeMode === 'none') return false;
  if (!provider.routeHealthy) return false;
  if (provider.id === 'unknown') return false;
  if (probeMode === 'all') return true;
  if (probeMode === 'supported') {
    return provider.logprobs || provider.topLogprobs || provider.supportedParameters.length === 0;
  }
  return provider.supportedParameters.length === 0;
}

function clearMetadataSupportForLiveMode(provider: ProviderSupportRecord): void {
  provider.logprobs = false;
  provider.topLogprobs = false;
  provider.topLogprobsMax = 0;
  provider.promptLogprobs = false;
  provider.streamingLogprobs = false;
  provider.generatedLogprobs = 'no';
  provider.observedStatus = 'Skipped';
  provider.discoverySource = 'unknown';
}

function tokenFromTopLogprob(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  return normalizeOptionalString((entry as { token?: unknown }).token);
}

function inspectLogprobContainer(logprobs: unknown, basePath: string): Omit<ExtractedLogprobs, 'responseId' | 'responseModel' | 'responseProvider'> {
  if (!logprobs || typeof logprobs !== 'object') {
    return {
      generatedLogprobs: false,
      topLogprobs: false,
      topLogprobsMaxObserved: 0,
      topAlternatives: false,
      promptLogprobs: false,
      bytesIncluded: false,
      tokenTextIncluded: false,
      nullVsErrorBehavior: logprobs === null ? 'null' : 'missing',
      dataPath: null,
    };
  }

  const typed = logprobs as {
    content?: unknown;
    tokens?: unknown;
    token_logprobs?: unknown;
    top_logprobs?: unknown;
    prompt?: unknown;
    prompt_logprobs?: unknown;
  };
  const content = Array.isArray(typed.content) ? typed.content : [];
  const legacyTokens = Array.isArray(typed.tokens) ? typed.tokens : [];
  const legacyTokenLogprobs = Array.isArray(typed.token_logprobs) ? typed.token_logprobs : [];
  const legacyTopLogprobs = Array.isArray(typed.top_logprobs) ? typed.top_logprobs : [];
  const promptEntries = Array.isArray(typed.prompt)
    ? typed.prompt
    : Array.isArray(typed.prompt_logprobs)
      ? typed.prompt_logprobs
      : [];

  let generatedLogprobs = legacyTokenLogprobs.some((entry) => typeof entry === 'number')
    || legacyTokens.length > 0;
  let topLogprobs = legacyTopLogprobs.length > 0;
  let topLogprobsMaxObserved = legacyTopLogprobs.length;
  let topAlternatives = false;
  let bytesIncluded = false;
  let tokenTextIncluded = legacyTokens.some((entry) => typeof entry === 'string');

  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue;
    const token = normalizeOptionalString((entry as { token?: unknown }).token);
    const logprob = (entry as { logprob?: unknown }).logprob;
    const bytes = (entry as { bytes?: unknown }).bytes;
    const top = (entry as { top_logprobs?: unknown }).top_logprobs;
    if (typeof logprob === 'number') generatedLogprobs = true;
    if (token) tokenTextIncluded = true;
    if (Array.isArray(bytes)) bytesIncluded = true;
    if (Array.isArray(top) && top.length > 0) {
      topLogprobs = true;
      topLogprobsMaxObserved = Math.max(topLogprobsMaxObserved, top.length);
      topAlternatives = top.some((candidate) => {
        const candidateToken = tokenFromTopLogprob(candidate);
        return candidateToken !== undefined && candidateToken !== token;
      });
    }
  }

  const promptLogprobs = promptEntries.length > 0;
  const dataPath = content.length > 0
    ? `${basePath}.content[]`
    : legacyTokens.length > 0 || legacyTokenLogprobs.length > 0
      ? `${basePath}.tokens[] / token_logprobs[]`
      : null;

  return {
    generatedLogprobs,
    topLogprobs,
    topLogprobsMaxObserved,
    topAlternatives,
    promptLogprobs,
    bytesIncluded,
    tokenTextIncluded,
    nullVsErrorBehavior: generatedLogprobs || topLogprobs || promptLogprobs ? 'data' : 'missing',
    dataPath,
  };
}

function mergeExtractedLogprobs(left: ExtractedLogprobs, right: ExtractedLogprobs): ExtractedLogprobs {
  return {
    generatedLogprobs: left.generatedLogprobs || right.generatedLogprobs,
    topLogprobs: left.topLogprobs || right.topLogprobs,
    topLogprobsMaxObserved: Math.max(left.topLogprobsMaxObserved, right.topLogprobsMaxObserved),
    topAlternatives: left.topAlternatives || right.topAlternatives,
    promptLogprobs: left.promptLogprobs || right.promptLogprobs,
    bytesIncluded: left.bytesIncluded || right.bytesIncluded,
    tokenTextIncluded: left.tokenTextIncluded || right.tokenTextIncluded,
    nullVsErrorBehavior: left.nullVsErrorBehavior === 'data' || right.nullVsErrorBehavior === 'data'
      ? 'data'
      : left.nullVsErrorBehavior === 'null' || right.nullVsErrorBehavior === 'null'
        ? 'null'
        : 'missing',
    dataPath: left.dataPath ?? right.dataPath,
    responseId: left.responseId ?? right.responseId,
    responseModel: left.responseModel ?? right.responseModel,
    responseProvider: left.responseProvider ?? right.responseProvider,
  };
}

function extractLogprobSupport(payload: unknown): ExtractedLogprobs {
  const empty: ExtractedLogprobs = {
    generatedLogprobs: false,
    topLogprobs: false,
    topLogprobsMaxObserved: 0,
    topAlternatives: false,
    promptLogprobs: false,
    bytesIncluded: false,
    tokenTextIncluded: false,
    nullVsErrorBehavior: 'missing',
    dataPath: null,
  };
  if (!payload || typeof payload !== 'object') return empty;

  const typedPayload = payload as {
    id?: unknown;
    model?: unknown;
    provider?: unknown;
    provider_name?: unknown;
    choices?: Array<{ logprobs?: unknown; delta?: { logprobs?: unknown } }>;
    streamChunks?: unknown[];
  };
  let extracted = {
    ...empty,
    responseId: normalizeOptionalString(typedPayload.id),
    responseModel: normalizeOptionalString(typedPayload.model),
    responseProvider: normalizeOptionalString(typedPayload.provider) ?? normalizeOptionalString(typedPayload.provider_name),
  };

  const choice = Array.isArray(typedPayload.choices) ? typedPayload.choices[0] : undefined;
  if (choice) {
    extracted = mergeExtractedLogprobs(extracted, {
      ...inspectLogprobContainer(choice.logprobs, 'choices[0].logprobs'),
      responseId: extracted.responseId,
      responseModel: extracted.responseModel,
      responseProvider: extracted.responseProvider,
    });
  }

  if (Array.isArray(typedPayload.streamChunks)) {
    for (let index = 0; index < typedPayload.streamChunks.length; index += 1) {
      const chunk = typedPayload.streamChunks[index];
      if (!chunk || typeof chunk !== 'object') continue;
      const chunkPayload = chunk as {
        id?: unknown;
        model?: unknown;
        provider?: unknown;
        provider_name?: unknown;
        choices?: Array<{ logprobs?: unknown; delta?: { logprobs?: unknown } }>;
      };
      extracted.responseId ??= normalizeOptionalString(chunkPayload.id);
      extracted.responseModel ??= normalizeOptionalString(chunkPayload.model);
      extracted.responseProvider ??= normalizeOptionalString(chunkPayload.provider) ?? normalizeOptionalString(chunkPayload.provider_name);
      const chunkChoice = Array.isArray(chunkPayload.choices) ? chunkPayload.choices[0] : undefined;
      if (!chunkChoice) continue;
      const chunkLogprobs = chunkChoice.logprobs ?? chunkChoice.delta?.logprobs;
      extracted = mergeExtractedLogprobs(extracted, {
        ...inspectLogprobContainer(chunkLogprobs, `streamChunks[${index}].choices[0].logprobs`),
        responseId: extracted.responseId,
        responseModel: extracted.responseModel,
        responseProvider: extracted.responseProvider,
      });
    }
  }

  return extracted;
}

function yesNo(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}

function classifyObservation(
  responseOk: boolean,
  probe: ProbeDefinition,
  extracted: ExtractedLogprobs,
  error: string | undefined,
): LogprobSupportStatus {
  if (!responseOk) {
    const normalizedError = error?.toLowerCase() ?? '';
    return normalizedError.includes('logprob') ? 'Rejected' : 'Error';
  }
  if (!extracted.generatedLogprobs && !(probe.promptLogprobs && extracted.promptLogprobs)) {
    return 'Param accepted, no data';
  }
  if (probe.topLogprobs > 0 && extracted.topAlternatives) {
    return 'Top-k works';
  }
  return 'Works';
}

function sanitizeForArchive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitizeForArchive(entry));
  if (!value || typeof value !== 'object') return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    if (lowered.includes('key') || lowered.includes('authorization') || lowered.includes('token')) {
      sanitized[key] = '[redacted]';
    } else {
      sanitized[key] = sanitizeForArchive(nested);
    }
  }
  return sanitized;
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '__').replace(/^_+|_+$/g, '').slice(0, 120);
}

function archiveRawResponse(
  rawArchiveDir: string | undefined,
  observation: Omit<ProbeObservation, 'rawResponseArchived'>,
  payload: unknown,
): string | null {
  if (!rawArchiveDir) return null;
  mkdirSync(rawArchiveDir, { recursive: true });
  const fileName = [
    safeFilePart(observation.modelId),
    safeFilePart(observation.routeId),
    safeFilePart(observation.test),
    `${Date.now()}.json`,
  ].join('__');
  const outputPath = path.resolve(rawArchiveDir, fileName);
  writeFileSync(outputPath, `${JSON.stringify(sanitizeForArchive(payload), null, 2)}\n`, 'utf8');
  return outputPath;
}

function buildChatBody(modelId: string, probe: ProbeDefinition, route: RouteDefinition): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: modelId,
    messages: [{ role: 'user', content: probe.prompt }],
    max_tokens: probe.maxTokens,
    temperature: 0,
    top_p: 1,
    seed: 1,
    logprobs: true,
    top_logprobs: probe.topLogprobs,
    stream: probe.stream,
  };
  if (probe.promptLogprobs) {
    body.prompt_logprobs = true;
  }
  if (route.providerBody) {
    body.provider = route.providerBody;
  }
  return body;
}

async function probeRoute(
  params: {
    fetchFn: typeof fetch;
    apiBaseUrl: string;
    apiKey: string;
    modelId: string;
    route: RouteDefinition;
    probe: ProbeDefinition;
    timeoutMs: number;
    rawArchiveDir?: string;
  },
): Promise<ProbeObservation> {
  const started = performance.now();
  const requestInit = buildFetchInit(params.apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildChatBody(params.modelId, params.probe, params.route)),
  });
  const result = params.probe.stream
    ? await fetchStreamingJson(params.fetchFn, `${params.apiBaseUrl}/chat/completions`, requestInit, params.timeoutMs)
    : await fetchJson(params.fetchFn, `${params.apiBaseUrl}/chat/completions`, requestInit, params.timeoutMs);
  const latencyMs = Math.round(performance.now() - started);
  const extracted = extractLogprobSupport(result.payload);
  const error = result.response.ok ? undefined : extractErrorMessage(result.payload);
  const withoutArchive: Omit<ProbeObservation, 'rawResponseArchived'> = {
    provider: 'OpenRouter',
    underlyingProvider: extracted.responseProvider ?? params.route.underlyingProvider,
    modelId: params.modelId,
    endpoint: params.route.endpoint,
    routeId: params.route.id,
    routeLabel: params.route.label,
    test: params.probe.id,
    prompt: params.probe.prompt,
    generatedLogprobs: yesNo(extracted.generatedLogprobs),
    topLogprobs: yesNo(extracted.topLogprobs),
    topLogprobsRequested: params.probe.topLogprobs,
    topLogprobsMaxObserved: extracted.topLogprobsMaxObserved,
    promptLogprobs: yesNo(extracted.promptLogprobs),
    streamingLogprobs: params.probe.stream ? yesNo(extracted.generatedLogprobs) : 'no',
    bytesIncluded: extracted.bytesIncluded,
    tokenTextIncluded: extracted.tokenTextIncluded,
    nullVsErrorBehavior: result.response.ok ? extracted.nullVsErrorBehavior : 'error',
    routerFallbackUsed: params.route.routerFallbackUsed,
    ...(extracted.responseModel ? { responseModel: extracted.responseModel } : {}),
    ...(extracted.responseProvider ? { responseProvider: extracted.responseProvider } : {}),
    latencyMs,
    latencyCostImpact: null,
    status: classifyObservation(result.response.ok, params.probe, extracted, error),
    ...(error ? { error } : {}),
    ...(!result.response.ok ? { httpStatus: result.response.status } : {}),
    dataPath: extracted.dataPath,
  };

  return {
    ...withoutArchive,
    rawResponseArchived: archiveRawResponse(params.rawArchiveDir, withoutArchive, result.payload),
  };
}

function buildRouterRoutes(): RouteDefinition[] {
  return [
    {
      id: 'openrouter_default',
      label: 'OpenRouter default routing',
      endpoint: 'chat',
      underlyingProvider: null,
      routerFallbackUsed: 'unknown',
    },
    {
      id: 'openrouter_fallbacks_disabled',
      label: 'OpenRouter fallback disabled',
      endpoint: 'chat',
      underlyingProvider: null,
      providerBody: {
        allow_fallbacks: false,
        require_parameters: true,
      },
      routerFallbackUsed: 'false',
    },
  ];
}

function buildProviderRoute(providerId: string): RouteDefinition {
  return {
    id: `provider_${providerId}`,
    label: `Provider pinned: ${providerId}`,
    endpoint: 'chat',
    underlyingProvider: providerId,
    providerBody: {
      order: [providerId],
      only: [providerId],
      allow_fallbacks: false,
      require_parameters: true,
    },
    routerFallbackUsed: 'false',
  };
}

function updateProviderFromObservations(provider: ProviderSupportRecord): void {
  const observations = provider.observations;
  const generated = observations.some((observation) => observation.generatedLogprobs === 'yes');
  const topK = observations.some((observation) => observation.status === 'Top-k works' || observation.topLogprobs === 'yes');
  const prompt = observations.some((observation) => observation.promptLogprobs === 'yes');
  const stream = observations.some((observation) => observation.streamingLogprobs === 'yes');
  const dataObservation = observations.find((observation) => observation.nullVsErrorBehavior === 'data');
  const errorObservation = observations.find((observation) => observation.nullVsErrorBehavior === 'error');
  const firstObservation = observations[0];
  const topLogprobsMaxObserved = Math.max(0, ...observations.map((observation) => observation.topLogprobsMaxObserved));

  if (observations.length > 0) {
    provider.logprobs = generated;
    provider.topLogprobs = topK;
    provider.topLogprobsMax = topLogprobsMaxObserved;
    provider.promptLogprobs = prompt;
    provider.streamingLogprobs = stream;
    provider.bytesOrTokenTextIncluded = observations.some((observation) => observation.bytesIncluded || observation.tokenTextIncluded);
    provider.nullVsErrorBehavior = dataObservation?.nullVsErrorBehavior
      ?? errorObservation?.nullVsErrorBehavior
      ?? firstObservation?.nullVsErrorBehavior
      ?? 'unknown';
    provider.generatedLogprobs = generated ? 'yes' : 'no';
    provider.observedStatus = topK ? 'Top-k works' : generated ? 'Works' : firstObservation?.status ?? 'Param accepted, no data';
    provider.latencyMs = firstObservation?.latencyMs ?? null;
    provider.latencyCostImpact = firstObservation?.latencyCostImpact ?? null;
    provider.rawResponseArchived = observations
      .map((observation) => observation.rawResponseArchived)
      .filter((archivePath): archivePath is string => archivePath !== null);
    provider.probe = {
      attempted: true,
      status: generated ? 'supported' : 'unsupported',
      ...(firstObservation?.httpStatus !== undefined ? { httpStatus: firstObservation.httpStatus } : {}),
      ...(firstObservation?.error ? { error: firstObservation.error } : {}),
      ...(firstObservation?.responseModel ? { responseModel: firstObservation.responseModel } : {}),
    };
    provider.discoverySource = provider.discoverySource === 'endpoint_metadata'
      ? 'endpoint_metadata+live_probe'
      : 'live_probe';
  }
}

function classifyModelDependence(models: Record<string, ModelSupportRecord>): void {
  const byProvider = new Map<string, ProviderSupportRecord[]>();
  for (const model of Object.values(models)) {
    for (const provider of model.providers) {
      const records = byProvider.get(provider.baseSlug) ?? [];
      records.push(provider);
      byProvider.set(provider.baseSlug, records);
    }
  }
  for (const records of byProvider.values()) {
    const supported = records.some((record) => record.logprobs);
    const unsupported = records.some((record) => !record.logprobs && record.observations.length > 0);
    if (!supported || !unsupported) continue;
    for (const record of records) {
      if (record.observations.length > 0) {
        record.observedStatus = 'Model-dependent';
      }
    }
  }
}

function buildEngineerView(models: Record<string, ModelSupportRecord>): EngineerViewRow[] {
  const rows: EngineerViewRow[] = [];
  for (const [modelId, model] of Object.entries(models)) {
    for (const observation of model.routerObservations) {
      rows.push({
        provider: 'OpenRouter',
        underlyingProvider: observation.underlyingProvider,
        model: modelId,
        endpoint: observation.endpoint,
        generated: observation.generatedLogprobs,
        topK: observation.status === 'Top-k works' ? 'yes' : observation.topLogprobs,
        prompt: observation.promptLogprobs,
        stream: observation.streamingLogprobs,
        maxTopK: observation.topLogprobsMaxObserved,
        notes: `${observation.routeLabel}; ${observation.status}; raw=${observation.rawResponseArchived ?? 'not archived'}`,
      });
    }
    for (const provider of model.providers) {
      rows.push({
        provider: 'OpenRouter',
        underlyingProvider: provider.id,
        model: modelId,
        endpoint: 'chat',
        generated: provider.generatedLogprobs,
        topK: provider.topLogprobs ? 'yes' : 'no',
        prompt: provider.promptLogprobs ? 'yes' : 'no',
        stream: provider.streamingLogprobs ? 'yes' : 'no',
        maxTopK: provider.topLogprobsMax,
        notes: `${provider.observedStatus}; route=${provider.routeHealthy ? 'healthy' : 'unhealthy'}; raw=${provider.rawResponseArchived.join(',') || 'not archived'}`,
      });
    }
  }
  return rows;
}

function buildUseCaseView(models: Record<string, ModelSupportRecord>): UseCaseViewRow[] {
  const topKProviders = new Set<string>();
  const generatedOnlyProviders = new Set<string>();
  const avoid = new Set<string>();
  const promptProviders = new Set<string>();

  for (const [modelId, model] of Object.entries(models)) {
    for (const provider of model.providers) {
      const label = `${provider.id} (${modelId})`;
      if (provider.topLogprobs) topKProviders.add(label);
      if (provider.logprobs) generatedOnlyProviders.add(label);
      if (provider.promptLogprobs) promptProviders.add(label);
      if (provider.observations.length > 0 && !provider.logprobs) avoid.add(label);
    }
  }

  return [
    {
      useCase: 'Cheap label confidence',
      recommendedProviders: [...topKProviders].sort(),
      avoid: [...avoid].sort(),
    },
    {
      useCase: 'Calibration experiments',
      recommendedProviders: [...topKProviders].sort(),
      avoid: ['OpenRouter default routing without provider pinning', ...avoid].sort(),
    },
    {
      useCase: 'Perplexity / scoring',
      recommendedProviders: [...promptProviders].sort(),
      avoid: promptProviders.size === 0
        ? ['Hosted chat endpoints without prompt logprobs; use self-hosted vLLM/TGI/llama.cpp or a prompt-logprob API']
        : [],
    },
    {
      useCase: 'Router exploration',
      recommendedProviders: [...generatedOnlyProviders].sort(),
      avoid: ['Unpinned OpenRouter routes when comparing provider support'].sort(),
    },
  ];
}

export async function discoverOpenRouterLogprobSupport(
  options: DiscoverOpenRouterLogprobSupportOptions = {},
): Promise<LogprobSupportTable> {
  const fetchFn = options.fetchFn ?? fetch;
  const apiBaseUrl = normalizeBaseUrl(options.apiBaseUrl);
  const apiKey = normalizeApiKey(options.apiKey);
  const targets = normalizeTargets(options.targets);
  const probeMode = options.probeMode ?? 'all';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rawArchiveDir = normalizeOptionalString(options.rawArchiveDir);

  const warnings: string[] = [];
  if (!apiKey && probeMode !== 'none') {
    warnings.push('OPENROUTER_API_KEY is not configured; live observed-behavior probes were skipped.');
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
        routerObservations: [],
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
        const endpointsPayload = endpointsResult.payload as { data?: { endpoints?: OpenRouterEndpointEntry[] } };
        endpoints = Array.isArray(endpointsPayload.data?.endpoints) ? endpointsPayload.data.endpoints : [];
      }
    } catch (error) {
      notes.push(`Failed to fetch /models/${target.id}/endpoints: ${error instanceof Error ? error.message : String(error)}`);
    }

    const providers = endpoints
      .map((endpoint) => buildProviderRecord(endpoint))
      .sort((left, right) => left.id.localeCompare(right.id));

    if (providers.length === 0) {
      notes.push('No provider endpoints were returned for this model.');
    }

    const routerObservations: ProbeObservation[] = [];
    if (apiKey && probeMode !== 'none') {
      for (const route of buildRouterRoutes()) {
        for (const probe of CANONICAL_PROBES) {
          try {
            routerObservations.push(await probeRoute({
              fetchFn,
              apiBaseUrl,
              apiKey,
              modelId: target.id,
              route: {
                ...route,
                endpoint: probe.stream ? 'chat_streaming' : 'chat',
              },
              probe,
              timeoutMs,
              ...(rawArchiveDir ? { rawArchiveDir } : {}),
            }));
          } catch (error) {
            routerObservations.push({
              provider: 'OpenRouter',
              underlyingProvider: route.underlyingProvider,
              modelId: target.id,
              endpoint: probe.stream ? 'chat_streaming' : 'chat',
              routeId: route.id,
              routeLabel: route.label,
              test: probe.id,
              prompt: probe.prompt,
              generatedLogprobs: 'no',
              topLogprobs: 'no',
              topLogprobsRequested: probe.topLogprobs,
              topLogprobsMaxObserved: 0,
              promptLogprobs: 'no',
              streamingLogprobs: 'no',
              bytesIncluded: false,
              tokenTextIncluded: false,
              nullVsErrorBehavior: 'error',
              routerFallbackUsed: route.routerFallbackUsed,
              latencyMs: null,
              latencyCostImpact: null,
              status: 'Error',
              error: error instanceof Error ? error.message : String(error),
              dataPath: null,
              rawResponseArchived: null,
            });
          }
        }
      }
    }

    for (const provider of providers) {
      const shouldProbe = apiKey ? shouldProbeProvider(provider, probeMode) : false;
      if (apiKey && probeMode !== 'none') {
        clearMetadataSupportForLiveMode(provider);
      }
      if (!apiKey || !shouldProbe) continue;
      const route = buildProviderRoute(provider.id);
      for (const probe of CANONICAL_PROBES) {
        try {
          provider.observations.push(await probeRoute({
            fetchFn,
            apiBaseUrl,
            apiKey,
            modelId: target.id,
            route: {
              ...route,
              endpoint: probe.stream ? 'chat_streaming' : 'chat',
            },
            probe,
            timeoutMs,
            ...(rawArchiveDir ? { rawArchiveDir } : {}),
          }));
        } catch (error) {
          provider.observations.push({
            provider: 'OpenRouter',
            underlyingProvider: provider.id,
            modelId: target.id,
            endpoint: probe.stream ? 'chat_streaming' : 'chat',
            routeId: route.id,
            routeLabel: route.label,
            test: probe.id,
            prompt: probe.prompt,
            generatedLogprobs: 'no',
            topLogprobs: 'no',
            topLogprobsRequested: probe.topLogprobs,
            topLogprobsMaxObserved: 0,
            promptLogprobs: 'no',
            streamingLogprobs: 'no',
            bytesIncluded: false,
            tokenTextIncluded: false,
            nullVsErrorBehavior: 'error',
            routerFallbackUsed: 'false',
            latencyMs: null,
            latencyCostImpact: null,
            status: 'Error',
            error: error instanceof Error ? error.message : String(error),
            dataPath: null,
            rawResponseArchived: null,
          });
        }
      }
      updateProviderFromObservations(provider);
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
      routerObservations,
      notes,
    };
  }

  classifyModelDependence(modelRecords);

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    apiBaseUrl,
    probeMode,
    dateTested: new Date().toISOString().slice(0, 10),
    topLogprobsMaxRequested: OPENROUTER_TOP_LOGPROBS_MAX,
    targets,
    tests: [...CANONICAL_PROBES],
    warnings,
    missingModels,
    models: modelRecords,
    engineerView: buildEngineerView(modelRecords),
    useCaseView: buildUseCaseView(modelRecords),
  };
}
