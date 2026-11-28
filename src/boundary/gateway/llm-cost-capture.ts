import { AsyncLocalStorage } from 'node:async_hooks';
import type { LLMResponse, LLMUsageCostDetails } from '../../shared/contracts/runtime.js';
import {
  combineProviderCostEvidenceObservations,
  mergeProviderCostEvidenceConflicts,
  reconcileProviderCostEvidence,
  type ReconciledProviderCostEvidence,
} from '../../shared/telemetry/provider-cost-evidence.js';
import {
  extractGatewayProviderCost,
  extractGatewayProviderCostEvidence,
  extractGatewayProviderCostEvidenceFromHeaders,
} from '../../shared/telemetry/provider-cost-extraction.js';
import {
  extractProviderResponseMetadata,
  mergeProviderResponseMetadata,
  type CapturedProviderEvidence,
} from '../../shared/telemetry/provider-response-metadata.js';

export {
  extractGatewayProviderCost,
  extractGatewayProviderCostEvidence,
  extractGatewayProviderCostEvidenceFromHeaders,
};

export type GatewayCapturedLLMCost = CapturedProviderEvidence;

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
  capture.providerResponse = mergeProviderResponseMetadata(
    capture.providerResponse,
    extractProviderResponseMetadata(parsed),
  );
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
  capture.providerResponse = extractProviderResponseMetadata(parsed);
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
    if (!capture) continue;
    if (
      Object.keys(capture.providerCostEvidence).length > 0
      || capture.providerCostEvidenceConflict !== undefined
      || capture.providerCostEvidenceSummary !== undefined
      || capture.providerResponse !== undefined
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
  // The wire capture is the only provider cost: the client never reports
  // pi-ai's locally calculated cost as one (lomm1).
  const reconciliation = mergeProviderCostEvidenceConflicts(
    reconcileProviderCostEvidence({
      ...capturedCost.providerCostEvidence,
    }, {
      input: usageDetails.input,
      output: usageDetails.output,
      cacheRead: usageDetails.cacheRead,
      cacheWrite: usageDetails.cacheWrite,
    }, combineProviderCostEvidenceObservations({
      providerCostEvidence: capturedCost.providerCostEvidence,
      ...(capturedCost.providerCostEvidenceSummary
        ? { providerCostEvidenceSummary: capturedCost.providerCostEvidenceSummary }
        : {}),
    })),
    capturedCost.providerCostEvidenceConflict,
  );
  const { cost: _quarantinedCost, raw, ...usageWithoutCost } = usageDetails;
  return {
    ...response,
    ...(response.providerObservability ? {
      providerObservability: {
        ...response.providerObservability,
        providerResponse: mergeProviderResponseMetadata(
          response.providerObservability.providerResponse,
          capturedCost.providerResponse,
        ),
      },
    } : {}),
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
