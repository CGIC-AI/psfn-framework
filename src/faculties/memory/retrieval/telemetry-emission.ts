import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { CostTelemetryPort } from '../../../shared/telemetry/cost-telemetry-port.js';
import { getRequestContext } from '../../../primitives/llm/request-context.js';
import type { RetrievalTelemetry } from './types.js';

const log = createComponentLogger('Retrieval');

export async function emitRetrievalTelemetry(input: {
  runtimeConfig: SubstrateConfig | null;
  telemetryEnabled: boolean;
  costTelemetry?: CostTelemetryPort;
  telemetry: RetrievalTelemetry;
}): Promise<void> {
  if (input.runtimeConfig?.memoryRetrievalTelemetryEnabled ?? input.telemetryEnabled) {
    log.debug('Retrieval stats', input.telemetry);
  }

  if (!input.costTelemetry) return;

  try {
    const requestContext = getRequestContext();
    const correlation = requestContext
      ? {
        ...(requestContext.turnId ? { turnId: requestContext.turnId } : {}),
        ...(requestContext.requestId ? { requestId: requestContext.requestId } : {}),
        callType: requestContext.callType ?? 'memory',
        purpose: 'memory.retrieval',
        originType: requestContext.originType ?? requestContext.callType ?? 'memory',
        originStage: requestContext.originStage ?? 'memory.retrieval',
        ...(requestContext.toolName ? { toolName: requestContext.toolName } : {}),
        ...(requestContext.toolCallId ? { toolCallId: requestContext.toolCallId } : {}),
      }
      : {};
    await input.costTelemetry.recordMemoryRetrieval(
      {
        ...input.telemetry,
        candidates: input.telemetry.candidateCount,
        ranked: input.telemetry.rankedCount,
        returned: input.telemetry.returnedCount,
        ...correlation,
      },
    );
  } catch (err) {
    log.error('Failed to emit retrieval telemetry', {
      channelId: input.telemetry.channelId,
      error: String(err),
    });
  }
}
