import {
  parseIcpConversationCorrelation,
  type IcpConversationCorrelation,
} from '../../shared/contracts/icp-autonomy.js';
import type { AgentResponse } from '../../shared/contracts/runtime.js';
import { isRecord } from '../../shared/utils/types.js';

interface SessionMetadataEnvelope {
  icpCorrelation?: unknown;
  icpDelivery?: unknown;
  [key: string]: unknown;
}

function parseEnvelope(metadata: string | undefined): SessionMetadataEnvelope {
  if (!metadata) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    throw new Error('Session metadata is malformed JSON; refusing ICP correlation merge');
  }
  if (!isRecord(parsed)) {
    throw new Error('Session metadata must be an object for ICP correlation');
  }
  return parsed;
}

export function buildSessionMetadataWithIcpCorrelation(
  metadata: string | undefined,
  correlation: IcpConversationCorrelation,
  options: {
    deliveryStatus?: 'pending';
    recoveryResponse?: AgentResponse;
  } = {},
): string {
  if (options.recoveryResponse && options.deliveryStatus !== 'pending') {
    throw new Error('ICP recovery response requires pending delivery metadata');
  }
  const envelope = parseEnvelope(metadata);
  return JSON.stringify({
    ...envelope,
    icpCorrelation: parseIcpConversationCorrelation(correlation),
    ...(options.deliveryStatus
      ? {
          icpDelivery: {
            schemaVersion: 1,
            status: options.deliveryStatus,
            ...(options.recoveryResponse
              ? { recoveryResponse: structuredClone(options.recoveryResponse) }
              : {}),
          },
        }
      : {}),
  });
}

export function parseSessionIcpRecoveryResponse(
  metadata: string | undefined,
): AgentResponse | null {
  const envelope = parseEnvelope(metadata);
  if (envelope.icpDelivery === undefined) return null;
  if (!isRecord(envelope.icpDelivery)
    || envelope.icpDelivery.schemaVersion !== 1
    || envelope.icpDelivery.status !== 'pending') {
    throw new Error('Session ICP delivery metadata is malformed');
  }
  const value = envelope.icpDelivery.recoveryResponse;
  if (!isRecord(value)
    || typeof value.content !== 'string'
    || typeof value.channelId !== 'string'
    || !isRecord(value.metadata)
    || typeof value.metadata.model !== 'string'
    || typeof value.metadata.inputTokens !== 'number'
    || typeof value.metadata.outputTokens !== 'number'
    || typeof value.metadata.durationMs !== 'number'
    || !Number.isFinite(value.metadata.inputTokens)
    || !Number.isFinite(value.metadata.outputTokens)
    || !Number.isFinite(value.metadata.durationMs)
    || value.metadata.inputTokens < 0
    || value.metadata.outputTokens < 0
    || value.metadata.durationMs < 0) {
    throw new Error('Pending ICP assistant entry is missing its durable recovery response');
  }
  const correlation = parseIcpConversationCorrelation(value.metadata.icpCorrelation);
  const outerCorrelation = parseSessionIcpCorrelation(metadata);
  if (!outerCorrelation
    || JSON.stringify(correlation) !== JSON.stringify(outerCorrelation)
    || value.channelId !== correlation.channelId
    || (value.metadata.turnId !== undefined && value.metadata.turnId !== correlation.turnId)
    || (value.metadata.requestId !== undefined && value.metadata.requestId !== correlation.requestId)) {
    throw new Error('Pending ICP recovery response does not match its assistant entry correlation');
  }
  return structuredClone({
    ...value,
    metadata: {
      ...value.metadata,
      icpCorrelation: correlation,
    },
  }) as AgentResponse;
}

export function parseSessionIcpCorrelation(
  metadata: string | undefined,
): IcpConversationCorrelation | null {
  const envelope = parseEnvelope(metadata);
  if (envelope.icpCorrelation === undefined) return null;
  return parseIcpConversationCorrelation(envelope.icpCorrelation);
}
