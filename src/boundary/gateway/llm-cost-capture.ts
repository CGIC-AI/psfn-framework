import { AsyncLocalStorage } from 'node:async_hooks';
import type { LLMResponse } from '../../shared/contracts/runtime.js';

export interface GatewayCapturedLLMCost {
  providerCostUsd?: number;
}

interface GatewayLLMCostCaptureContext {
  captures: GatewayCapturedLLMCost[];
}

const captureStorage = new AsyncLocalStorage<GatewayLLMCostCaptureContext>();
const ORIGINAL_FETCH_SYMBOL = Symbol.for('psfn.gatewayLlmCostCapture.originalFetch');

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

function parsePositiveCost(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : (typeof value === 'string' ? Number(value.trim().replace(/^\$/, '')) : NaN);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function providerCostFromHeaders(headers: Headers): number | undefined {
  for (const name of COST_HEADER_NAMES) {
    const cost = parsePositiveCost(headers.get(name));
    if (cost !== undefined) return cost;
  }
  return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function providerCostFromPayload(value: unknown): number | undefined {
  const record = objectRecord(value);
  if (!record) return parsePositiveCost(value);
  const usage = objectRecord(record.usage);
  const usageCostDetails = objectRecord(usage?.cost_details);
  const costDetails = objectRecord(record.cost_details);
  return parsePositiveCost(usage?.cost)
    ?? parsePositiveCost(usageCostDetails?.upstream_inference_cost)
    ?? parsePositiveCost(usageCostDetails?.total)
    ?? parsePositiveCost(record.cost)
    ?? parsePositiveCost(costDetails?.upstream_inference_cost)
    ?? parsePositiveCost(costDetails?.total);
}

function recordProviderCost(capture: GatewayCapturedLLMCost, providerCostUsd: number | undefined): void {
  if (providerCostUsd !== undefined) {
    capture.providerCostUsd = providerCostUsd;
  }
}

function inspectSseEvent(rawEvent: string, capture: GatewayCapturedLLMCost): void {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trim());
  if (dataLines.length === 0) return;
  const payload = dataLines.join('\n').trim();
  if (!payload || payload === '[DONE]') return;
  try {
    recordProviderCost(capture, providerCostFromPayload(JSON.parse(payload) as unknown));
  } catch {
    return;
  }
}

function createSseInspector(capture: GatewayCapturedLLMCost): (text: string, final?: boolean) => void {
  let pending = '';
  return (text: string, final = false): void => {
    pending += text;
    const events = pending.split(/\r?\n\r?\n/);
    pending = final ? '' : (events.pop() ?? '');
    for (const event of events) {
      inspectSseEvent(event, capture);
    }
    if (final && pending.trim().length > 0) {
      inspectSseEvent(pending, capture);
      pending = '';
    }
  };
}

function wrapStreamingBody(response: Response, capture: GatewayCapturedLLMCost): Response {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!response.body || !contentType.includes('text/event-stream')) return response;
  const decoder = new TextDecoder();
  const inspect = createSseInspector(capture);
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      inspect(decoder.decode(chunk, { stream: true }));
      controller.enqueue(chunk);
    },
    flush() {
      const finalText = decoder.decode();
      if (finalText) inspect(finalText);
      inspect('', true);
    },
  }));
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function inspectJsonBody(response: Response, capture: GatewayCapturedLLMCost): Promise<void> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) return;
  try {
    recordProviderCost(capture, providerCostFromPayload(await response.clone().json() as unknown));
  } catch {
    return;
  }
}

function ensureGatewayLLMCostCaptureInstalled(): void {
  const currentFetch = globalThis.fetch as FetchWithOriginal | undefined;
  if (typeof currentFetch !== 'function') return;
  if (currentFetch[ORIGINAL_FETCH_SYMBOL]) return;

  const originalFetch = currentFetch.bind(globalThis) as typeof fetch;
  const wrappedFetch = (async (input, init) => {
    const response = await originalFetch(input, init);
    const context = captureStorage.getStore();
    if (!context) return response;

    const capture: GatewayCapturedLLMCost = {};
    recordProviderCost(capture, providerCostFromHeaders(response.headers));
    context.captures.push(capture);
    await inspectJsonBody(response, capture);
    return wrapStreamingBody(response, capture);
  }) as FetchWithOriginal;
  wrappedFetch[ORIGINAL_FETCH_SYMBOL] = originalFetch;
  globalThis.fetch = wrappedFetch;
}

export async function withGatewayLLMCostCapture<T>(
  operation: () => Promise<T>,
): Promise<{ result: T; captures: GatewayCapturedLLMCost[] }> {
  if (typeof globalThis.fetch !== 'function') {
    return { result: await operation(), captures: [] };
  }
  ensureGatewayLLMCostCaptureInstalled();
  const context: GatewayLLMCostCaptureContext = { captures: [] };
  const result = await captureStorage.run(context, operation);
  return { result, captures: context.captures };
}

export function latestGatewayCapturedProviderCostUsd(
  captures: readonly GatewayCapturedLLMCost[],
): number | undefined {
  for (let index = captures.length - 1; index >= 0; index -= 1) {
    const cost = captures[index]?.providerCostUsd;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) return cost;
  }
  return undefined;
}

export function applyGatewayCapturedProviderCost<T extends LLMResponse>(
  response: T,
  captures: readonly GatewayCapturedLLMCost[],
): T {
  const providerCostUsd = latestGatewayCapturedProviderCostUsd(captures);
  if (providerCostUsd === undefined) return response;
  const usageDetails = response.usageDetails ?? {
    input: response.inputTokens,
    output: response.outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: response.inputTokens + response.outputTokens,
  };
  return {
    ...response,
    usageDetails: {
      ...usageDetails,
      cost: {
        ...(usageDetails.cost ?? {}),
        total: providerCostUsd,
        currency: usageDetails.cost?.currency ?? 'USD',
      },
    },
  };
}
