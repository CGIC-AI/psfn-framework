import { AsyncLocalStorage } from 'node:async_hooks';

export interface CapturedOpenAICompatibleResponseHeaders {
  headers: Record<string, string>;
  providerCostUsd?: number;
}

interface HeaderCaptureContext {
  baseUrl: string;
  captures: CapturedOpenAICompatibleResponseHeaders[];
}

const captureStorage = new AsyncLocalStorage<HeaderCaptureContext>();
const ORIGINAL_FETCH_SYMBOL = Symbol.for('psfn.openaiCompatibleResponseHeaders.originalFetch');

type FetchWithOriginal = typeof fetch & {
  [ORIGINAL_FETCH_SYMBOL]?: typeof fetch;
};

const COST_HEADER_NAMES = [
  'x-litellm-response-cost',
  'llm_provider-x-litellm-response-cost',
  'llm-provider-x-litellm-response-cost',
  'x-litellm-provider-response-cost',
  'x-litellm-model-response-cost',
] as const;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function requestUrl(input: Parameters<typeof fetch>[0]): string | undefined {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  const candidate = input as { url?: unknown };
  return typeof candidate.url === 'string' ? candidate.url : undefined;
}

function shouldCaptureRequest(url: string | undefined, baseUrl: string): boolean {
  if (!url) return false;
  return normalizeBaseUrl(url).startsWith(baseUrl);
}

function parseCostHeader(value: string | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const firstValue = value.split(',')[0]?.trim().replace(/^\$/, '') ?? '';
  if (!firstValue) return undefined;
  const numeric = Number(firstValue);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

function shouldKeepHeader(name: string): boolean {
  return name.startsWith('x-litellm-')
    || name.startsWith('llm_provider-')
    || name.startsWith('llm-provider-')
    || name.startsWith('x-openrouter-')
    || name.startsWith('openrouter-');
}

function captureResponseHeaders(headers: Headers): CapturedOpenAICompatibleResponseHeaders | null {
  const captured: Record<string, string> = {};
  headers.forEach((value, name) => {
    const normalizedName = name.trim().toLowerCase();
    if (normalizedName && shouldKeepHeader(normalizedName)) {
      captured[normalizedName] = value;
    }
  });

  let providerCostUsd: number | undefined;
  for (const name of COST_HEADER_NAMES) {
    providerCostUsd = parseCostHeader(captured[name]);
    if (providerCostUsd !== undefined) break;
  }

  if (Object.keys(captured).length === 0 && providerCostUsd === undefined) {
    return null;
  }
  return {
    headers: captured,
    ...(providerCostUsd !== undefined ? { providerCostUsd } : {}),
  };
}

function ensureFetchHeaderCaptureInstalled(): void {
  const currentFetch = globalThis.fetch as FetchWithOriginal | undefined;
  if (typeof currentFetch !== 'function') return;
  if (currentFetch[ORIGINAL_FETCH_SYMBOL]) return;

  const originalFetch = currentFetch.bind(globalThis) as typeof fetch;
  const wrappedFetch = (async (input, init) => {
    const response = await originalFetch(input, init);
    const context = captureStorage.getStore();
    if (!context || !shouldCaptureRequest(requestUrl(input), context.baseUrl)) {
      return response;
    }

    const captured = captureResponseHeaders(response.headers);
    if (captured) {
      context.captures.push(captured);
    }
    return response;
  }) as FetchWithOriginal;
  wrappedFetch[ORIGINAL_FETCH_SYMBOL] = originalFetch;
  globalThis.fetch = wrappedFetch;
}

export async function withOpenAICompatibleResponseHeaderCapture<T>(
  baseUrl: string | undefined,
  operation: () => Promise<T>,
): Promise<{ result: T; captures: CapturedOpenAICompatibleResponseHeaders[] }> {
  const normalizedBaseUrl = typeof baseUrl === 'string' && baseUrl.trim().length > 0
    ? normalizeBaseUrl(baseUrl)
    : undefined;
  if (!normalizedBaseUrl || typeof globalThis.fetch !== 'function') {
    return { result: await operation(), captures: [] };
  }

  ensureFetchHeaderCaptureInstalled();
  const context: HeaderCaptureContext = { baseUrl: normalizedBaseUrl, captures: [] };
  const result = await captureStorage.run(context, operation);
  return { result, captures: context.captures };
}

export function latestCapturedProviderCostUsd(
  captures: readonly CapturedOpenAICompatibleResponseHeaders[],
): number | undefined {
  for (let index = captures.length - 1; index >= 0; index -= 1) {
    const cost = captures[index]?.providerCostUsd;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
      return cost;
    }
  }
  return undefined;
}
