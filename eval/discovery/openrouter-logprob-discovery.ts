import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OUTPUT_PATH = 'eval/discovery/artifacts/openrouter-logprob-support.json';
const DEFAULT_TARGETS_PATH = 'config/models.seed.json';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_TOKENS = 16;
const DEFAULT_TOP_LOGPROBS = 5;
const DEFAULT_PROMPT = 'Reply with exactly OK and nothing else.';
const DEFAULT_STOP_SEQUENCES = ['\n'];
const AVAILABLE_ENDPOINT_STATUS = 0;

type LiveMode = 'auto' | 'live' | 'metadata_only';

interface CliOptions {
  baseUrl: string;
  outPath: string;
  models: string[];
  modelsFile?: string;
  timeoutMs: number;
  concurrency: number;
  maxTokens: number;
  topLogprobs: number;
  liveMode: LiveMode;
  includeInactiveProviders: boolean;
}

interface TargetSpec {
  model: string;
  providers?: string[];
}

interface OpenRouterModelEntry {
  id: string;
  canonical_slug?: string;
  name?: string;
  context_length?: number | null;
  supported_parameters?: string[] | null;
  top_provider?: {
    context_length?: number | null;
    max_completion_tokens?: number | null;
  } | null;
  pricing?: Record<string, string | undefined> | null;
}

interface OpenRouterEndpointEntry {
  name?: string;
  provider_name?: string;
  tag?: string;
  quantization?: string;
  status?: number;
  context_length?: number | null;
  max_completion_tokens?: number | null;
  supported_parameters?: string[] | null;
  pricing?: Record<string, string | number | undefined> | null;
}

interface ProviderEndpointSummary {
  name: string | null;
  tag: string | null;
  quantization: string | null;
  status: number | null;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  claimsLogprobs: boolean;
  claimsTopLogprobs: boolean;
}

interface ProviderCandidate {
  slug: string;
  providerName: string;
  discovered: boolean;
  endpointCount: number;
  availableEndpointCount: number;
  endpointTags: string[];
  statuses: number[];
  claimsLogprobsAny: boolean;
  claimsTopLogprobsAny: boolean;
  claimsLogprobsAll: boolean;
  claimsTopLogprobsAll: boolean;
  maxContextLength: number | null;
  maxCompletionTokens: number | null;
  endpoints: ProviderEndpointSummary[];
}

interface LogprobSample {
  token: string | null;
  logprob: number | null;
  topLogprobsCount: number;
}

interface LogprobInspection {
  shape: 'chat_content' | 'legacy_tokens' | 'missing' | 'unknown';
  hasPayload: boolean;
  tokenCount: number;
  topLogprobsCount: number;
  sample: LogprobSample | null;
}

interface ProbeResult {
  kind: 'router' | 'provider';
  status: 'supported' | 'unsupported' | 'blocked' | 'skipped' | 'error';
  provider?: string;
  providerRouting?: {
    allow_fallbacks?: boolean;
    only?: string[];
    require_parameters?: boolean;
  };
  httpStatus?: number;
  responseModel?: string;
  finishReason?: string | null;
  outputPreview?: string | null;
  logprobs?: LogprobInspection;
  headers?: Record<string, string>;
  error?: {
    classification: string;
    message: string;
  };
}

interface ModelResult {
  model: string;
  modelLookupKey: string;
  targetProviders?: string[];
  metadata: {
    found: boolean;
    canonicalSlug: string | null;
    name: string | null;
    supportedParameters: string[];
    claimsLogprobs: boolean;
    claimsTopLogprobs: boolean;
    contextLength: number | null;
    maxCompletionTokens: number | null;
    pricing: Record<string, string>;
  };
  routerProbe: ProbeResult;
  providers: Array<ProviderCandidate & {
    probeEligible: boolean;
    probeSkippedReason?: string;
    probe: ProbeResult;
  }>;
}

interface SupportArtifact {
  schemaVersion: 1;
  generatedAt: string;
  tool: {
    name: 'openrouter-logprob-discovery';
    prompt: string;
    stop: string[];
  };
  input: {
    baseUrl: string;
    outputPath: string;
    targetSource: string;
    targetCount: number;
    liveMode: LiveMode;
    liveProbeEnabled: boolean;
    apiKeyPresent: boolean;
    timeoutMs: number;
    concurrency: number;
    maxTokens: number;
    topLogprobs: number;
    includeInactiveProviders: boolean;
  };
  summary: {
    modelCount: number;
    providerCount: number;
    providerProbeEligibleCount: number;
    modelsClaimingLogprobs: number;
    providersClaimingLogprobs: number;
    supportedRouterProbeCount: number;
    supportedProviderProbeCount: number;
    blockedProbeCount: number;
    unsupportedProbeCount: number;
    errorProbeCount: number;
  };
  results: ModelResult[];
}

function printUsage(): void {
  console.log(
    [
      'Usage: npx tsx eval/discovery/openrouter-logprob-discovery.ts [options]',
      '',
      'Options:',
      `  --out <path>                    Output artifact path (default: ${DEFAULT_OUTPUT_PATH})`,
      `  --base-url <url>               OpenRouter API base URL (default: ${DEFAULT_BASE_URL})`,
      '  --model <author/slug>          Target model id (repeatable)',
      '  --models-file <path>           JSON file containing model ids or target objects',
      `  --timeout-ms <ms>              Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})`,
      `  --concurrency <n>              Max concurrent live probes (default: ${DEFAULT_CONCURRENCY})`,
      `  --max-tokens <n>               Completion max_tokens for live probes (default: ${DEFAULT_MAX_TOKENS})`,
      `  --top-logprobs <n>             top_logprobs request value (default: ${DEFAULT_TOP_LOGPROBS})`,
      '  --live                         Force live completion probes',
      '  --metadata-only                Skip live completion probes even when API key is present',
      '  --include-inactive-providers   Probe providers whose endpoint status is not 0',
      '  --help                         Show this help text',
      '',
      'If no models are provided, targets are derived from config/models.seed.json.',
    ].join('\n'),
  );
}

function parsePositiveInteger(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    baseUrl: DEFAULT_BASE_URL,
    outPath: DEFAULT_OUTPUT_PATH,
    models: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    concurrency: DEFAULT_CONCURRENCY,
    maxTokens: DEFAULT_MAX_TOKENS,
    topLogprobs: DEFAULT_TOP_LOGPROBS,
    liveMode: 'auto',
    includeInactiveProviders: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      case '--out':
        options.outPath = requireString(argv[++index], '--out');
        break;
      case '--base-url':
        options.baseUrl = requireString(argv[++index], '--base-url');
        break;
      case '--model':
        options.models.push(requireString(argv[++index], '--model'));
        break;
      case '--models-file':
        options.modelsFile = requireString(argv[++index], '--models-file');
        break;
      case '--timeout-ms':
        options.timeoutMs = parsePositiveInteger(argv[++index], '--timeout-ms', DEFAULT_TIMEOUT_MS);
        break;
      case '--concurrency':
        options.concurrency = parsePositiveInteger(argv[++index], '--concurrency', DEFAULT_CONCURRENCY);
        break;
      case '--max-tokens':
        options.maxTokens = parsePositiveInteger(argv[++index], '--max-tokens', DEFAULT_MAX_TOKENS);
        break;
      case '--top-logprobs':
        options.topLogprobs = parsePositiveInteger(argv[++index], '--top-logprobs', DEFAULT_TOP_LOGPROBS);
        break;
      case '--live':
        options.liveMode = 'live';
        break;
      case '--metadata-only':
        options.liveMode = 'metadata_only';
        break;
      case '--include-inactive-providers':
        options.includeInactiveProviders = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireString(value: string | undefined, flag: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${flag} requires a value`);
  }
  return value.trim();
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
}

function normalizeModelId(model: string): string {
  const trimmed = model.trim();
  return trimmed.toLowerCase().startsWith('openrouter/')
    ? trimmed.slice('openrouter/'.length)
    : trimmed;
}

function normalizeProviderSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function hasOwn(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && key in value;
}

function readTargetsFromModelsFile(modelsFile: string): TargetSpec[] {
  const payload = readJsonFile(modelsFile);
  const rawTargets = Array.isArray(payload)
    ? payload
    : hasOwn(payload, 'targets') && Array.isArray((payload as { targets?: unknown[] }).targets)
      ? (payload as { targets: unknown[] }).targets
      : hasOwn(payload, 'models') && Array.isArray((payload as { models?: unknown[] }).models)
        ? (payload as { models: unknown[] }).models
        : null;

  if (!rawTargets) {
    throw new Error(`Unsupported models file shape: ${modelsFile}`);
  }

  return rawTargets.map((entry, index) => parseTargetSpec(entry, `${modelsFile}[${index}]`));
}

function parseTargetSpec(value: unknown, location: string): TargetSpec {
  if (typeof value === 'string' && value.trim().length > 0) {
    return { model: normalizeModelId(value) };
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Invalid target entry at ${location}`);
  }
  const model = hasOwn(value, 'model') ? (value as { model?: unknown }).model : undefined;
  if (typeof model !== 'string' || model.trim().length === 0) {
    throw new Error(`Target entry at ${location} is missing a non-empty model`);
  }
  const rawProviders = hasOwn(value, 'providers') ? (value as { providers?: unknown }).providers : undefined;
  const providers = Array.isArray(rawProviders)
    ? rawProviders
      .map((entry) => {
        if (typeof entry !== 'string' || entry.trim().length === 0) {
          throw new Error(`Invalid provider slug in ${location}`);
        }
        return normalizeProviderSlug(entry);
      })
    : undefined;
  return {
    model: normalizeModelId(model),
    ...(providers && providers.length > 0 ? { providers } : {}),
  };
}

function readDefaultTargets(): TargetSpec[] {
  const payload = readJsonFile(DEFAULT_TARGETS_PATH);
  if (!hasOwn(payload, 'models') || !Array.isArray((payload as { models?: unknown[] }).models)) {
    throw new Error(`Unsupported default targets source: ${DEFAULT_TARGETS_PATH}`);
  }

  const models = (payload as { models: unknown[] }).models;
  const discovered = new Set<string>();
  for (const [index, modelEntry] of models.entries()) {
    if (typeof modelEntry !== 'object' || modelEntry === null) {
      throw new Error(`Invalid model entry in ${DEFAULT_TARGETS_PATH} at index ${index}`);
    }
    const identity = hasOwn(modelEntry, 'identity')
      ? (modelEntry as { identity?: unknown }).identity
      : undefined;
    if (typeof identity !== 'object' || identity === null) continue;
    const provider = hasOwn(identity, 'provider') ? (identity as { provider?: unknown }).provider : undefined;
    const model = hasOwn(identity, 'model') ? (identity as { model?: unknown }).model : undefined;
    if (provider === 'openrouter' && typeof model === 'string' && model.trim().length > 0) {
      discovered.add(normalizeModelId(model));
    }
  }

  if (discovered.size === 0) {
    throw new Error(`No OpenRouter targets found in ${DEFAULT_TARGETS_PATH}`);
  }

  return [...discovered].sort((left, right) => left.localeCompare(right)).map(model => ({ model }));
}

function mergeTargets(cliOptions: CliOptions): { targetSource: string; targets: TargetSpec[] } {
  const seen = new Map<string, TargetSpec>();

  const push = (spec: TargetSpec): void => {
    const key = normalizeModelId(spec.model);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { model: key, ...(spec.providers ? { providers: [...new Set(spec.providers)] } : {}) });
      return;
    }
    if (spec.providers && spec.providers.length > 0) {
      const providers = new Set([...(existing.providers ?? []), ...spec.providers]);
      seen.set(key, { model: key, providers: [...providers] });
    }
  };

  let targetSource = DEFAULT_TARGETS_PATH;
  if (cliOptions.modelsFile) {
    targetSource = cliOptions.modelsFile;
    for (const target of readTargetsFromModelsFile(cliOptions.modelsFile)) {
      push(target);
    }
  } else if (cliOptions.models.length > 0) {
    targetSource = 'cli';
    for (const model of cliOptions.models) {
      push({ model: normalizeModelId(model) });
    }
  } else {
    for (const target of readDefaultTargets()) {
      push(target);
    }
  }

  const targets = [...seen.values()].sort((left, right) => left.model.localeCompare(right.model));
  if (targets.length === 0) {
    throw new Error('No discovery targets were resolved');
  }
  return { targetSource, targets };
}

function buildAuthorizationHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  return parseJsonLoose(text);
}

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { rawText: text };
  }
}

async function fetchOpenRouterJson(
  url: string,
  options: { apiKey?: string; timeoutMs: number },
): Promise<unknown> {
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: buildAuthorizationHeaders(options.apiKey),
  }, options.timeoutMs);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`GET ${url} failed (${response.status}): ${text.slice(0, 280)}`);
  }
  return await readJsonResponse(response);
}

function extractModelEntries(payload: unknown): OpenRouterModelEntry[] {
  if (!hasOwn(payload, 'data') || !Array.isArray((payload as { data?: unknown[] }).data)) {
    throw new Error('OpenRouter /models payload did not include a data array');
  }
  return (payload as { data: OpenRouterModelEntry[] }).data;
}

function extractEndpointEntries(payload: unknown): OpenRouterEndpointEntry[] {
  if (!hasOwn(payload, 'data')) {
    throw new Error('OpenRouter endpoints payload did not include a data object');
  }
  const data = (payload as { data?: unknown }).data;
  if (!hasOwn(data, 'endpoints') || !Array.isArray((data as { endpoints?: unknown[] }).endpoints)) {
    throw new Error('OpenRouter endpoints payload did not include an endpoints array');
  }
  return (data as { endpoints: OpenRouterEndpointEntry[] }).endpoints;
}

function expandModelLookupKeys(modelId: string | undefined): string[] {
  if (!modelId) return [];
  const normalized = normalizeModelId(modelId).trim().toLowerCase();
  if (!normalized) return [];
  const keys = [normalized];
  const slashIndex = normalized.indexOf('/');
  if (slashIndex > 0) {
    keys.push(normalized.slice(slashIndex + 1));
  }
  return [...new Set(keys)];
}

function indexModelEntries(entries: OpenRouterModelEntry[]): Map<string, OpenRouterModelEntry> {
  const index = new Map<string, OpenRouterModelEntry>();
  for (const entry of entries) {
    for (const key of [
      ...expandModelLookupKeys(entry.id),
      ...expandModelLookupKeys(entry.canonical_slug),
    ]) {
      if (!index.has(key)) {
        index.set(key, entry);
      }
    }
  }
  return index;
}

function normalizeSupportedParameters(value: string[] | null | undefined): string[] {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map(entry => entry.trim()),
  )].sort((left, right) => left.localeCompare(right));
}

function normalizePricingRecord(
  value: Record<string, string | number | undefined> | null | undefined,
): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const entries = Object.entries(value)
    .map(([key, raw]) => {
      if (typeof raw === 'string') return [key, raw.trim()] as const;
      if (typeof raw === 'number' && Number.isFinite(raw)) return [key, String(raw)] as const;
      return [key, ''] as const;
    })
    .filter(([, raw]) => raw.length > 0);
  return Object.fromEntries(entries);
}

function toNullableNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toModelMetadata(entry: OpenRouterModelEntry | undefined): ModelResult['metadata'] {
  const supportedParameters = normalizeSupportedParameters(entry?.supported_parameters);
  return {
    found: Boolean(entry),
    canonicalSlug: entry?.canonical_slug ?? null,
    name: entry?.name ?? null,
    supportedParameters,
    claimsLogprobs: supportedParameters.includes('logprobs'),
    claimsTopLogprobs: supportedParameters.includes('top_logprobs'),
    contextLength: toNullableNumber(entry?.top_provider?.context_length ?? entry?.context_length),
    maxCompletionTokens: toNullableNumber(entry?.top_provider?.max_completion_tokens),
    pricing: normalizePricingRecord(entry?.pricing),
  };
}

function deriveProviderSlug(endpoint: OpenRouterEndpointEntry): string {
  const tagPrefix = endpoint.tag?.split('/')[0]?.trim();
  if (tagPrefix) return normalizeProviderSlug(tagPrefix);
  const providerName = endpoint.provider_name?.trim();
  if (providerName) return normalizeProviderSlug(providerName);
  return 'unknown-provider';
}

function compareNumbersDescending(left: number | null, right: number | null): number {
  const leftValue = left ?? Number.NEGATIVE_INFINITY;
  const rightValue = right ?? Number.NEGATIVE_INFINITY;
  return rightValue - leftValue;
}

function buildProviderCandidates(
  endpoints: OpenRouterEndpointEntry[],
  requestedProviders: string[] | undefined,
): ProviderCandidate[] {
  const grouped = new Map<string, ProviderCandidate>();

  for (const endpoint of endpoints) {
    const slug = deriveProviderSlug(endpoint);
    const supportedParameters = normalizeSupportedParameters(endpoint.supported_parameters);
    const claimsLogprobs = supportedParameters.includes('logprobs');
    const claimsTopLogprobs = supportedParameters.includes('top_logprobs');
    const existing = grouped.get(slug);

    if (!existing) {
      grouped.set(slug, {
        slug,
        providerName: endpoint.provider_name?.trim() || slug,
        discovered: true,
        endpointCount: 1,
        availableEndpointCount: endpoint.status === AVAILABLE_ENDPOINT_STATUS ? 1 : 0,
        endpointTags: endpoint.tag ? [endpoint.tag] : [],
        statuses: typeof endpoint.status === 'number' ? [endpoint.status] : [],
        claimsLogprobsAny: claimsLogprobs,
        claimsTopLogprobsAny: claimsTopLogprobs,
        claimsLogprobsAll: claimsLogprobs,
        claimsTopLogprobsAll: claimsTopLogprobs,
        maxContextLength: toNullableNumber(endpoint.context_length),
        maxCompletionTokens: toNullableNumber(endpoint.max_completion_tokens),
        endpoints: [{
          name: endpoint.name ?? null,
          tag: endpoint.tag ?? null,
          quantization: endpoint.quantization ?? null,
          status: typeof endpoint.status === 'number' ? endpoint.status : null,
          contextLength: toNullableNumber(endpoint.context_length),
          maxCompletionTokens: toNullableNumber(endpoint.max_completion_tokens),
          claimsLogprobs,
          claimsTopLogprobs,
        }],
      });
      continue;
    }

    existing.endpointCount += 1;
    if (endpoint.status === AVAILABLE_ENDPOINT_STATUS) {
      existing.availableEndpointCount += 1;
    }
    if (endpoint.tag && !existing.endpointTags.includes(endpoint.tag)) {
      existing.endpointTags.push(endpoint.tag);
    }
    if (typeof endpoint.status === 'number') {
      existing.statuses.push(endpoint.status);
    }
    existing.claimsLogprobsAny = existing.claimsLogprobsAny || claimsLogprobs;
    existing.claimsTopLogprobsAny = existing.claimsTopLogprobsAny || claimsTopLogprobs;
    existing.claimsLogprobsAll = existing.claimsLogprobsAll && claimsLogprobs;
    existing.claimsTopLogprobsAll = existing.claimsTopLogprobsAll && claimsTopLogprobs;
    existing.maxContextLength = Math.max(existing.maxContextLength ?? 0, endpoint.context_length ?? 0) || null;
    existing.maxCompletionTokens = Math.max(existing.maxCompletionTokens ?? 0, endpoint.max_completion_tokens ?? 0) || null;
    existing.endpoints.push({
      name: endpoint.name ?? null,
      tag: endpoint.tag ?? null,
      quantization: endpoint.quantization ?? null,
      status: typeof endpoint.status === 'number' ? endpoint.status : null,
      contextLength: toNullableNumber(endpoint.context_length),
      maxCompletionTokens: toNullableNumber(endpoint.max_completion_tokens),
      claimsLogprobs,
      claimsTopLogprobs,
    });
  }

  const ordered = [...grouped.values()].sort((left, right) => {
    if (left.availableEndpointCount !== right.availableEndpointCount) {
      return right.availableEndpointCount - left.availableEndpointCount;
    }
    if (left.claimsLogprobsAny !== right.claimsLogprobsAny) {
      return Number(right.claimsLogprobsAny) - Number(left.claimsLogprobsAny);
    }
    const contextComparison = compareNumbersDescending(left.maxContextLength, right.maxContextLength);
    if (contextComparison !== 0) return contextComparison;
    return left.slug.localeCompare(right.slug);
  });

  if (!requestedProviders || requestedProviders.length === 0) {
    return ordered;
  }

  const requestedSet = new Set(requestedProviders.map(normalizeProviderSlug));
  const selected = ordered.filter(candidate => requestedSet.has(candidate.slug));
  for (const provider of requestedProviders) {
    const slug = normalizeProviderSlug(provider);
    if (!selected.some(candidate => candidate.slug === slug)) {
      selected.push({
        slug,
        providerName: slug,
        discovered: false,
        endpointCount: 0,
        availableEndpointCount: 0,
        endpointTags: [],
        statuses: [],
        claimsLogprobsAny: false,
        claimsTopLogprobsAny: false,
        claimsLogprobsAll: false,
        claimsTopLogprobsAll: false,
        maxContextLength: null,
        maxCompletionTokens: null,
        endpoints: [],
      });
    }
  }
  return selected;
}

function captureRelevantHeaders(headers: Headers): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const lowered = key.toLowerCase();
    if (
      lowered.startsWith('x-openrouter-')
      || lowered.startsWith('x-ratelimit-')
      || lowered === 'x-request-id'
    ) {
      snapshot[lowered] = value;
    }
  }
  return snapshot;
}

function inspectLogprobs(value: unknown): LogprobInspection {
  if (!value || typeof value !== 'object') {
    return { shape: 'missing', hasPayload: false, tokenCount: 0, topLogprobsCount: 0, sample: null };
  }

  if (hasOwn(value, 'content') && Array.isArray((value as { content?: unknown[] }).content)) {
    const content = (value as { content: unknown[] }).content;
    const firstToken = content[0];
    const topLogprobs = hasOwn(firstToken, 'top_logprobs') && Array.isArray((firstToken as { top_logprobs?: unknown[] }).top_logprobs)
      ? (firstToken as { top_logprobs: unknown[] }).top_logprobs
      : [];
    return {
      shape: 'chat_content',
      hasPayload: content.length > 0,
      tokenCount: content.length,
      topLogprobsCount: topLogprobs.length,
      sample: content.length > 0
        ? {
          token: hasOwn(firstToken, 'token') && typeof (firstToken as { token?: unknown }).token === 'string'
            ? (firstToken as { token: string }).token
            : null,
          logprob: hasOwn(firstToken, 'logprob') && typeof (firstToken as { logprob?: unknown }).logprob === 'number'
            ? (firstToken as { logprob: number }).logprob
            : null,
          topLogprobsCount: topLogprobs.length,
        }
        : null,
    };
  }

  if (hasOwn(value, 'tokens') && Array.isArray((value as { tokens?: unknown[] }).tokens)) {
    const tokens = (value as { tokens: unknown[] }).tokens;
    const topLogprobs = hasOwn(value, 'top_logprobs') && Array.isArray((value as { top_logprobs?: unknown[] }).top_logprobs)
      ? (value as { top_logprobs: unknown[] }).top_logprobs
      : [];
    const firstTopLogprobs = Array.isArray(topLogprobs[0]) ? topLogprobs[0] : [];
    return {
      shape: 'legacy_tokens',
      hasPayload: tokens.length > 0,
      tokenCount: tokens.length,
      topLogprobsCount: firstTopLogprobs.length,
      sample: tokens.length > 0
        ? {
          token: typeof tokens[0] === 'string' ? tokens[0] : null,
          logprob: hasOwn(value, 'token_logprobs') && Array.isArray((value as { token_logprobs?: unknown[] }).token_logprobs)
            && typeof (value as { token_logprobs: unknown[] }).token_logprobs[0] === 'number'
            ? (value as { token_logprobs: number[] }).token_logprobs[0]
            : null,
          topLogprobsCount: firstTopLogprobs.length,
        }
        : null,
    };
  }

  return { shape: 'unknown', hasPayload: true, tokenCount: 0, topLogprobsCount: 0, sample: null };
}

function extractOutputPreview(payload: unknown): string | null {
  if (!hasOwn(payload, 'choices') || !Array.isArray((payload as { choices?: unknown[] }).choices)) {
    return null;
  }
  const choice = (payload as { choices: unknown[] }).choices[0];
  if (!choice || typeof choice !== 'object') return null;
  if (hasOwn(choice, 'message')) {
    const message = (choice as { message?: unknown }).message;
    if (typeof message === 'object' && message !== null && hasOwn(message, 'content')) {
      const content = (message as { content?: unknown }).content;
      if (typeof content === 'string') return content.slice(0, 200);
    }
  }
  if (hasOwn(choice, 'text') && typeof (choice as { text?: unknown }).text === 'string') {
    return (choice as { text: string }).text.slice(0, 200);
  }
  return null;
}

function extractFinishReason(payload: unknown): string | null {
  if (!hasOwn(payload, 'choices') || !Array.isArray((payload as { choices?: unknown[] }).choices)) {
    return null;
  }
  const choice = (payload as { choices: unknown[] }).choices[0];
  return typeof choice === 'object' && choice !== null && hasOwn(choice, 'finish_reason')
    && typeof (choice as { finish_reason?: unknown }).finish_reason === 'string'
    ? (choice as { finish_reason: string }).finish_reason
    : null;
}

function extractLogprobs(payload: unknown): LogprobInspection {
  if (!hasOwn(payload, 'choices') || !Array.isArray((payload as { choices?: unknown[] }).choices)) {
    return { shape: 'missing', hasPayload: false, tokenCount: 0, topLogprobsCount: 0, sample: null };
  }
  const choice = (payload as { choices: unknown[] }).choices[0];
  if (!choice || typeof choice !== 'object' || !hasOwn(choice, 'logprobs')) {
    return { shape: 'missing', hasPayload: false, tokenCount: 0, topLogprobsCount: 0, sample: null };
  }
  return inspectLogprobs((choice as { logprobs?: unknown }).logprobs);
}

function extractErrorMessage(payload: unknown, fallbackText: string): string {
  if (typeof payload === 'object' && payload !== null && hasOwn(payload, 'error')) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && error !== null && hasOwn(error, 'message')) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim().length > 0) {
        return message;
      }
    }
  }
  return fallbackText.slice(0, 400);
}

function classifyError(status: number, message: string): string {
  const lowered = message.toLowerCase();
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (
    lowered.includes('logprob')
    || lowered.includes('top_logprob')
    || lowered.includes('unsupported parameter')
    || lowered.includes('does not support')
    || lowered.includes('require_parameters')
    || status === 400
    || status === 422
  ) {
    return 'unsupported';
  }
  if (status >= 500) return 'upstream_error';
  return 'request_error';
}

function createBlockedProbe(kind: ProbeResult['kind'], provider: string | undefined, reason: string): ProbeResult {
  return {
    kind,
    status: 'blocked',
    ...(provider ? { provider } : {}),
    error: {
      classification: 'blocked',
      message: reason,
    },
  };
}

function createSkippedProbe(kind: ProbeResult['kind'], provider: string | undefined, reason: string): ProbeResult {
  return {
    kind,
    status: 'skipped',
    ...(provider ? { provider } : {}),
    error: {
      classification: 'skipped',
      message: reason,
    },
  };
}

function createCompletionRequestBody(
  model: string,
  options: CliOptions,
  providerRouting: ProbeResult['providerRouting'] | undefined,
): Record<string, unknown> {
  return {
    model,
    messages: [{ role: 'user', content: DEFAULT_PROMPT }],
    stream: false,
    temperature: 0,
    seed: 1,
    max_tokens: options.maxTokens,
    logprobs: true,
    top_logprobs: options.topLogprobs,
    stop: DEFAULT_STOP_SEQUENCES,
    ...(providerRouting ? { provider: providerRouting } : {}),
  };
}

async function runChatCompletionProbe(
  model: string,
  kind: ProbeResult['kind'],
  provider: string | undefined,
  providerRouting: ProbeResult['providerRouting'] | undefined,
  options: CliOptions,
  apiKey: string,
): Promise<ProbeResult> {
  const url = `${options.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const requestBody = createCompletionRequestBody(model, options, providerRouting);
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      ...buildAuthorizationHeaders(apiKey),
      'Content-Type': 'application/json',
      'X-Title': 'PSFN OpenRouter Logprob Discovery',
    },
    body: JSON.stringify(requestBody),
  }, options.timeoutMs);

  const responseText = await response.text();
  const parsed = responseText.length > 0
    ? parseJsonLoose(responseText)
    : {};
  const headers = captureRelevantHeaders(response.headers);

  if (!response.ok) {
    const message = extractErrorMessage(parsed, responseText);
    const classification = classifyError(response.status, message);
    return {
      kind,
      status: classification === 'unsupported' ? 'unsupported' : 'error',
      ...(provider ? { provider } : {}),
      ...(providerRouting ? { providerRouting } : {}),
      httpStatus: response.status,
      headers,
      error: {
        classification,
        message,
      },
    };
  }

  const logprobs = extractLogprobs(parsed);
  return {
    kind,
    status: logprobs.hasPayload && logprobs.tokenCount > 0 ? 'supported' : 'unsupported',
    ...(provider ? { provider } : {}),
    ...(providerRouting ? { providerRouting } : {}),
    httpStatus: response.status,
    responseModel: hasOwn(parsed, 'model') && typeof (parsed as { model?: unknown }).model === 'string'
      ? (parsed as { model: string }).model
      : undefined,
    finishReason: extractFinishReason(parsed),
    outputPreview: extractOutputPreview(parsed),
    logprobs,
    headers,
    ...(logprobs.hasPayload && logprobs.tokenCount > 0
      ? {}
      : {
        error: {
          classification: 'missing_logprobs_payload',
          message: 'Completion succeeded but the response did not include a usable logprobs payload.',
        },
      }),
  };
}

async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= tasks.length) return;
      await tasks[currentIndex]();
    }
  });
  await Promise.all(workers);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { targets, targetSource } = mergeTargets(options);
  const apiKey = process.env.OPENROUTER_API_KEY?.trim() || undefined;
  const liveProbeEnabled = options.liveMode === 'live'
    || (options.liveMode === 'auto' && typeof apiKey === 'string' && apiKey.length > 0);

  const modelsPayload = await fetchOpenRouterJson(`${options.baseUrl.replace(/\/$/, '')}/models`, {
    apiKey,
    timeoutMs: options.timeoutMs,
  });
  const modelIndex = indexModelEntries(extractModelEntries(modelsPayload));

  const results: ModelResult[] = [];
  for (const target of targets) {
    const modelLookupKey = normalizeModelId(target.model);
    const metadataEntry = modelIndex.get(modelLookupKey);
    const metadata = toModelMetadata(metadataEntry);
    let endpoints: OpenRouterEndpointEntry[] = [];
    try {
      const [author, ...slugParts] = modelLookupKey.split('/');
      if (slugParts.length === 0) {
        throw new Error(`Model "${modelLookupKey}" is not in <author>/<slug> form`);
      }
      const endpointsUrl = `${options.baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(author)}/${encodeURIComponent(slugParts.join('/'))}/endpoints`;
      const endpointsPayload = await fetchOpenRouterJson(endpointsUrl, {
        apiKey,
        timeoutMs: options.timeoutMs,
      });
      endpoints = extractEndpointEntries(endpointsPayload);
    } catch (error) {
      endpoints = [];
      console.error(`[openrouter-logprob-discovery] endpoints lookup failed for ${modelLookupKey}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const providerCandidates = buildProviderCandidates(endpoints, target.providers);
    const routerProbe = liveProbeEnabled
      ? createSkippedProbe('router', undefined, 'pending')
      : createBlockedProbe(
        'router',
        undefined,
        options.liveMode === 'metadata_only'
          ? 'Live probing was disabled by --metadata-only.'
          : 'OPENROUTER_API_KEY is not set; live probing is blocked.',
      );

    results.push({
      model: target.model,
      modelLookupKey,
      ...(target.providers ? { targetProviders: target.providers } : {}),
      metadata,
      routerProbe,
      providers: providerCandidates.map((candidate) => {
        const probeEligible = options.includeInactiveProviders || candidate.availableEndpointCount > 0 || !candidate.discovered;
        const probeSkippedReason = probeEligible
          ? undefined
          : 'No active endpoint is currently reported for this provider.';
        return {
          ...candidate,
          probeEligible,
          ...(probeSkippedReason ? { probeSkippedReason } : {}),
          probe: liveProbeEnabled
            ? (probeEligible
              ? createSkippedProbe('provider', candidate.slug, 'pending')
              : createSkippedProbe('provider', candidate.slug, probeSkippedReason ?? 'Provider is not probe-eligible.'))
            : createBlockedProbe(
              'provider',
              candidate.slug,
              options.liveMode === 'metadata_only'
                ? 'Live probing was disabled by --metadata-only.'
                : 'OPENROUTER_API_KEY is not set; live probing is blocked.',
            ),
        };
      }),
    });
  }

  if (liveProbeEnabled && !apiKey) {
    throw new Error('Live probing was requested, but OPENROUTER_API_KEY is not set.');
  }

  if (liveProbeEnabled && apiKey) {
    const tasks: Array<() => Promise<void>> = [];

    for (const result of results) {
      tasks.push(async () => {
        result.routerProbe = await runChatCompletionProbe(
          result.modelLookupKey,
          'router',
          undefined,
          { require_parameters: true },
          options,
          apiKey,
        );
      });

      for (const provider of result.providers) {
        if (!provider.probeEligible) continue;
        tasks.push(async () => {
          provider.probe = await runChatCompletionProbe(
            result.modelLookupKey,
            'provider',
            provider.slug,
            { only: [provider.slug], allow_fallbacks: false },
            options,
            apiKey,
          );
        });
      }
    }

    await runWithConcurrency(tasks, options.concurrency);
  }

  const artifact: SupportArtifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    tool: {
      name: 'openrouter-logprob-discovery',
      prompt: DEFAULT_PROMPT,
      stop: DEFAULT_STOP_SEQUENCES,
    },
    input: {
      baseUrl: options.baseUrl,
      outputPath: resolve(options.outPath),
      targetSource,
      targetCount: results.length,
      liveMode: options.liveMode,
      liveProbeEnabled,
      apiKeyPresent: Boolean(apiKey),
      timeoutMs: options.timeoutMs,
      concurrency: options.concurrency,
      maxTokens: options.maxTokens,
      topLogprobs: options.topLogprobs,
      includeInactiveProviders: options.includeInactiveProviders,
    },
    summary: {
      modelCount: results.length,
      providerCount: results.reduce((sum, result) => sum + result.providers.length, 0),
      providerProbeEligibleCount: results.reduce((sum, result) => sum + result.providers.filter(provider => provider.probeEligible).length, 0),
      modelsClaimingLogprobs: results.filter(result => result.metadata.claimsLogprobs).length,
      providersClaimingLogprobs: results.reduce((sum, result) => sum + result.providers.filter(provider => provider.claimsLogprobsAny).length, 0),
      supportedRouterProbeCount: results.filter(result => result.routerProbe.status === 'supported').length,
      supportedProviderProbeCount: results.reduce((sum, result) => sum + result.providers.filter(provider => provider.probe.status === 'supported').length, 0),
      blockedProbeCount: results.reduce(
        (sum, result) => sum
          + Number(result.routerProbe.status === 'blocked')
          + result.providers.filter(provider => provider.probe.status === 'blocked').length,
        0,
      ),
      unsupportedProbeCount: results.reduce(
        (sum, result) => sum
          + Number(result.routerProbe.status === 'unsupported')
          + result.providers.filter(provider => provider.probe.status === 'unsupported').length,
        0,
      ),
      errorProbeCount: results.reduce(
        (sum, result) => sum
          + Number(result.routerProbe.status === 'error')
          + result.providers.filter(provider => provider.probe.status === 'error').length,
        0,
      ),
    },
    results,
  };

  const outputPath = resolve(options.outPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    outputPath,
    targetSource,
    modelCount: artifact.summary.modelCount,
    providerCount: artifact.summary.providerCount,
    liveProbeEnabled,
    supportedRouterProbeCount: artifact.summary.supportedRouterProbeCount,
    supportedProviderProbeCount: artifact.summary.supportedProviderProbeCount,
    blockedProbeCount: artifact.summary.blockedProbeCount,
    errorProbeCount: artifact.summary.errorProbeCount,
  }, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[openrouter-logprob-discovery] ${message}`);
  process.exit(1);
});
