import {
  parseIcpConversationCorrelation,
  type IcpConversationCorrelation,
} from '../../shared/contracts/icp-autonomy.js';
import type { AgentResponse } from '../../shared/contracts/runtime.js';
import { isRecord } from '../../shared/utils/types.js';
import { parseIcpRecoveryResponse } from './icp-delivery-recovery.js';

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
  if (value === undefined) {
    throw new Error('Pending ICP assistant entry is missing its durable recovery response');
  }
  const outerCorrelation = parseSessionIcpCorrelation(metadata);
  if (!outerCorrelation) throw new Error('Pending ICP assistant entry is missing correlation');
  return parseIcpRecoveryResponse(value, {
    label: 'Pending ICP recovery response',
    expectedCorrelation: outerCorrelation,
    expectedChannelId: outerCorrelation.channelId,
    expectedSourceMessageId: outerCorrelation.messageId,
  });
}

export function parseSessionIcpCorrelation(
  metadata: string | undefined,
): IcpConversationCorrelation | null {
  const envelope = parseEnvelope(metadata);
  if (envelope.icpCorrelation === undefined) return null;
  return parseIcpConversationCorrelation(envelope.icpCorrelation);
}
