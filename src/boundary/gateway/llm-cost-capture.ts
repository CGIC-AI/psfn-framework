import { AsyncLocalStorage } from 'node:async_hooks';
import type { LLMResponse, LLMUsageCostDetails } from '../../shared/contracts/runtime.js';
import {
  combineProviderCostEvidenceObservations,
  mergeProviderCostEvidenceConflicts,
  reconcileProviderCostEvidence,
  type ReconciledProviderCostEvidence,
} from '../../shared/telemetry/provider-cost-evidence.js';
import { isRecord } from '../../shared/utils/types.js';

export type GatewayCapturedLLMCost = ReconciledProviderCostEvidence;

interface GatewayLLMCostCaptureContext {
  captures: GatewayCapturedLLMCost[];
  consumedCaptureCount: number;
  attemptConsumptionCount: number;
  lastConsumedProviderCostEvidence: GatewayCapturedLLMCost | undefined;
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

function parseNonNegativeCost(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : (typeof value === 'string' ? Number(value.trim().replace(/^\$/, '')) : NaN);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

export function extractGatewayProviderCostEvidenceFromHeaders(
  headers: Headers,
): ReconciledProviderCostEvidence {
  const sources: Record<string, LLMUsageCostDetails> = {};
  const conflicts = new Set<string>();
  for (const name of COST_HEADER_NAMES) {
    const rawCost = headers.get(name);
    if (rawCost === null) continue;
    const cost = parseNonNegativeCost(rawCost);
    if (cost !== undefined) {
      sources[`header.${name}`] = { total: cost, currency: 'USD' };
    } else {
      conflicts.add(`header.${name}`);
    }
  }
  return mergeProviderCostEvidenceConflicts(
    reconcileProviderCostEvidence(sources),
    conflicts.size > 0 ? { fields: [...conflicts] } : undefined,
  );
}

export function extractGatewayProviderCostFromHeaders(headers: Headers): LLMUsageCostDetails | undefined {
  return extractGatewayProviderCostEvidenceFromHeaders(headers).providerCost;
}

function recordCostObservation(
  sources: Record<string, LLMUsageCostDetails>,
  conflicts: Set<string>,
  source: string,
  field: keyof Pick<LLMUsageCostDetails, 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'total'>,
  value: unknown,
  currency = 'USD',
): void {
  if (value === undefined) return;
  const cost = parseNonNegativeCost(value);
  if (cost !== undefined) {
    sources[source] = { [field]: cost, currency };
  } else {
    conflicts.add(source);
  }
}

function recordCostDetailObservations(
  sources: Record<string, LLMUsageCostDetails>,
  conflicts: Set<string>,
  prefix: string,
  details: Record<string, unknown> | undefined,
): void {
  if (!details) return;
  const currency = typeof details.currency === 'string' && details.currency.trim().length > 0
    ? details.currency.trim().toUpperCase()
    : 'USD';
  const fields = [
    ['input', 'input'],
    ['input_cost', 'input'],
    ['prompt_cost', 'input'],
    ['output', 'output'],
    ['output_cost', 'output'],
    ['completion_cost', 'output'],
    ['cacheRead', 'cacheRead'],
    ['cache_read_cost', 'cacheRead'],
    ['cached_input_cost', 'cacheRead'],
    ['cacheWrite', 'cacheWrite'],
    ['cache_write_cost', 'cacheWrite'],
    ['cache_creation_cost', 'cacheWrite'],
    ['upstream_inference_cost', 'total'],
    ['total', 'total'],
    ['total_cost', 'total'],
  ] as const;
  for (const [key, field] of fields) {
    recordCostObservation(sources, conflicts, `${prefix}.${key}`, field, details[key], currency);
  }
}

function recordCostValue(
  sources: Record<string, LLMUsageCostDetails>,
  conflicts: Set<string>,
  prefix: string,
  value: unknown,
): void {
  if (isRecord(value)) {
    recordCostDetailObservations(sources, conflicts, prefix, value);
    return;
  }
  recordCostObservation(sources, conflicts, prefix, 'total', value);
}

export function extractGatewayProviderCostEvidence(
  value: unknown,
  prefix = 'body',
): ReconciledProviderCostEvidence {
  const record = isRecord(value) ? value : undefined;
  if (!record) {
    if (value === undefined || value === null) return reconcileProviderCostEvidence({});
    const total = parseNonNegativeCost(value);
    return mergeProviderCostEvidenceConflicts(
      reconcileProviderCostEvidence(total === undefined
        ? {}
        : { [`${prefix}.value`]: { total, currency: 'USD' } }),
      total === undefined ? { fields: [`${prefix}.value`] } : undefined,
    );
  }
  const usage = isRecord(record.usage) ? record.usage : undefined;
  const usageCostDetails = isRecord(usage?.cost_details) ? usage.cost_details : undefined;
  const costDetails = isRecord(record.cost_details) ? record.cost_details : undefined;
  const sources: Record<string, LLMUsageCostDetails> = {};
  const conflicts = new Set<string>();
  recordCostValue(sources, conflicts, `${prefix}.usage.cost`, usage?.cost);
  recordCostDetailObservations(sources, conflicts, `${prefix}.usage.cost_details`, usageCostDetails);
  recordCostDetailObservations(sources, conflicts, `${prefix}.cost_details`, costDetails);
  recordCostValue(sources, conflicts, `${prefix}.cost`, record.cost);
  return mergeProviderCostEvidenceConflicts(
    reconcileProviderCostEvidence(sources),
    conflicts.size > 0 ? { fields: [...conflicts] } : undefined,
  );
}

export function extractGatewayProviderCost(value: unknown): LLMUsageCostDetails | undefined {
  return extractGatewayProviderCostEvidence(value).providerCost;
}

function recordProviderCostEvidence(
  capture: GatewayCapturedLLMCost,
  observation: ReconciledProviderCostEvidence,
): void {
  const priorObservedCount = capture.providerCostEvidenceSummary?.observedSourceCount
    ?? Object.keys(capture.providerCostEvidence).length;
  const observationCount = observation.providerCostEvidenceSummary?.observedSourceCount
    ?? Object.keys(observation.providerCostEvidence).length;
  const combinedSources: Record<string, LLMUsageCostDetails> = {
    ...capture.providerCostEvidence,
  };
  const sourceCounts: Record<string, number> = {
    ...(capture.providerCostEvidenceSummary?.sourceCounts
      ?? Object.fromEntries(Object.keys(capture.providerCostEvidence).map(source => [source, 1]))),
  };
  const sourceFamily = (source: string): string => source.replace(/sse\[\d+\]/gu, 'sse[*]');
  const sameCost = (left: LLMUsageCostDetails, right: LLMUsageCostDetails): boolean => (
    left.input === right.input
    && left.output === right.output
    && left.cacheRead === right.cacheRead
    && left.cacheWrite === right.cacheWrite
    && left.total === right.total
    && left.currency === right.currency
  );
  const observationCounts = observation.providerCostEvidenceSummary?.sourceCounts
    ?? Object.fromEntries(Object.keys(observation.providerCostEvidence).map(source => [source, 1]));
  for (const [source, cost] of Object.entries(observation.providerCostEvidence)) {
    const equivalentSource = Object.entries(combinedSources).find(([existingSource, existingCost]) => (
      sourceFamily(existingSource) === sourceFamily(source) && sameCost(existingCost, cost)
    ))?.[0];
    if (equivalentSource) {
      sourceCounts[equivalentSource] = (sourceCounts[equivalentSource] ?? 1)
        + (observationCounts[source] ?? 1);
    } else {
      combinedSources[source] = cost;
      sourceCounts[source] = observationCounts[source] ?? 1;
    }
  }
  const reconciliation = mergeProviderCostEvidenceConflicts(
    reconcileProviderCostEvidence(combinedSources),
    capture.providerCostEvidenceConflict,
    observation.providerCostEvidenceConflict,
  );
  capture.providerCostEvidence = reconciliation.providerCostEvidence;
  if (reconciliation.providerCost) {
    capture.providerCost = reconciliation.providerCost;
  } else {
    delete capture.providerCost;
  }
  if (reconciliation.providerCostEvidenceConflict) {
    capture.providerCostEvidenceConflict = reconciliation.providerCostEvidenceConflict;
  } else {
    delete capture.providerCostEvidenceConflict;
  }
  const observedSourceCount = priorObservedCount + observationCount;
  const retainedCounts = Object.fromEntries(
    Object.keys(reconciliation.providerCostEvidence).map(source => [source, sourceCounts[source] ?? 1]),
  );
  const retainedObservationCount = Object.values(retainedCounts)
    .reduce((total, count) => total + count, 0);
  if (observedSourceCount > Object.keys(reconciliation.providerCostEvidence).length) {
    capture.providerCostEvidenceSummary = {
      observedSourceCount,
      retainedSourceCount: Object.keys(reconciliation.providerCostEvidence).length,
      truncatedSourceCount: Math.max(0, observedSourceCount - retainedObservationCount),
      sourceCounts: retainedCounts,
    };
  } else {
    delete capture.providerCostEvidenceSummary;
  }
}

function inspectSseEvent(rawEvent: string, capture: GatewayCapturedLLMCost, eventIndex: number): void {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trim());
  if (dataLines.length === 0) return;
  const payload = dataLines.join('\n').trim();
  if (!payload || payload === '[DONE]') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return;
  }
  recordProviderCostEvidence(
    capture,
    extractGatewayProviderCostEvidence(parsed, `sse[${eventIndex}]`),
  );
}

function createSseInspector(capture: GatewayCapturedLLMCost): (text: string, final?: boolean) => void {
  let pending = '';
  let eventIndex = 0;
  return (text: string, final = false): void => {
    pending += text;
    const events = pending.split(/\r?\n\r?\n/);
    pending = final ? '' : (events.pop() ?? '');
    for (const event of events) {
      inspectSseEvent(event, capture, eventIndex);
      eventIndex += 1;
    }
    if (final && pending.trim().length > 0) {
      inspectSseEvent(pending, capture, eventIndex);
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
  let parsed: unknown;
  try {
    parsed = await response.clone().json() as unknown;
  } catch {
    return;
  }
  recordProviderCostEvidence(
    capture,
    extractGatewayProviderCostEvidence(parsed, 'jsonBody'),
  );
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

    const capture: GatewayCapturedLLMCost = { providerCostEvidence: {} };
    recordProviderCostEvidence(capture, extractGatewayProviderCostEvidenceFromHeaders(response.headers));
    context.captures.push(capture);
    await inspectJsonBody(response, capture);
    return wrapStreamingBody(response, capture);
  }) as FetchWithOriginal;
  wrappedFetch[ORIGINAL_FETCH_SYMBOL] = originalFetch;
  globalThis.fetch = wrappedFetch;
}

export async function withGatewayLLMCostCapture<T>(
  operation: () => Promise<T>,
): Promise<{
  result: T;
  captures: GatewayCapturedLLMCost[];
  finalAttemptProviderCostEvidence?: GatewayCapturedLLMCost;
}> {
  if (typeof globalThis.fetch !== 'function') {
    return { result: await operation(), captures: [] };
  }
  ensureGatewayLLMCostCaptureInstalled();
  const context: GatewayLLMCostCaptureContext = {
    captures: [],
    consumedCaptureCount: 0,
    attemptConsumptionCount: 0,
    lastConsumedProviderCostEvidence: undefined,
  };
  const result = await captureStorage.run(context, operation);
  const finalAttemptProviderCostEvidence = context.attemptConsumptionCount > 0
    ? context.lastConsumedProviderCostEvidence
    : latestGatewayCapturedProviderCostEvidence(context.captures);
  return {
    result,
    captures: context.captures,
    ...(finalAttemptProviderCostEvidence ? { finalAttemptProviderCostEvidence } : {}),
  };
}

function latestGatewayCapturedProviderCostEvidence(
  captures: readonly GatewayCapturedLLMCost[],
): GatewayCapturedLLMCost | undefined {
  for (let index = captures.length - 1; index >= 0; index -= 1) {
    const capture = captures[index];
    if (
      Object.keys(capture.providerCostEvidence).length > 0
      || capture.providerCostEvidenceConflict !== undefined
      || capture.providerCostEvidenceSummary !== undefined
    ) return capture;
  }
  return undefined;
}

export function consumeActiveGatewayCapturedProviderCostEvidence(): GatewayCapturedLLMCost | undefined {
  const context = captureStorage.getStore();
  if (!context) return undefined;
  const attemptCaptures = context.captures.slice(context.consumedCaptureCount);
  context.consumedCaptureCount = context.captures.length;
  context.attemptConsumptionCount += 1;
  context.lastConsumedProviderCostEvidence = latestGatewayCapturedProviderCostEvidence(attemptCaptures);
  return context.lastConsumedProviderCostEvidence;
}

export function applyGatewayCapturedProviderCost<T extends LLMResponse>(
  response: T,
  capturedCost: GatewayCapturedLLMCost | undefined,
): T {
  if (!capturedCost) return response;
  const usageDetails = response.usageDetails ?? {
    input: response.inputTokens,
    output: response.outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: response.inputTokens + response.outputTokens,
  };
  const responseUsageEvidence = usageDetails.cost
    ? { responseUsage: usageDetails.cost }
    : {};
  const reconciliation = mergeProviderCostEvidenceConflicts(
    reconcileProviderCostEvidence({
      ...responseUsageEvidence,
      ...capturedCost.providerCostEvidence,
    }, {
      input: usageDetails.input,
      output: usageDetails.output,
      cacheRead: usageDetails.cacheRead,
      cacheWrite: usageDetails.cacheWrite,
    }, combineProviderCostEvidenceObservations(
      { providerCostEvidence: responseUsageEvidence },
      {
        providerCostEvidence: capturedCost.providerCostEvidence,
        ...(capturedCost.providerCostEvidenceSummary
          ? { providerCostEvidenceSummary: capturedCost.providerCostEvidenceSummary }
          : {}),
      },
    )),
    capturedCost.providerCostEvidenceConflict,
    usageDetails.costEvidenceConflict,
  );
  const { cost: _quarantinedCost, raw, ...usageWithoutCost } = usageDetails;
  return {
    ...response,
    usageDetails: {
      ...usageWithoutCost,
      ...(reconciliation.providerCost ? { cost: reconciliation.providerCost } : {}),
      raw: {
        ...(raw ?? {}),
        providerCostEvidence: reconciliation.providerCostEvidence,
        ...(reconciliation.providerCostEvidenceConflict
          ? { providerCostEvidenceConflict: reconciliation.providerCostEvidenceConflict }
          : {}),
        ...(reconciliation.providerCostEvidenceSummary
          ? { providerCostEvidenceSummary: reconciliation.providerCostEvidenceSummary }
          : {}),
      },
    },
  };
}
