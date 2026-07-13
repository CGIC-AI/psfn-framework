import {
  parseIcpConversationCorrelation,
  type IcpConversationCorrelation,
} from '../../shared/contracts/icp-autonomy.js';
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
  options: { deliveryStatus?: 'pending' } = {},
): string {
  const envelope = parseEnvelope(metadata);
  return JSON.stringify({
    ...envelope,
    icpCorrelation: parseIcpConversationCorrelation(correlation),
    ...(options.deliveryStatus
      ? {
          icpDelivery: {
            schemaVersion: 1,
            status: options.deliveryStatus,
          },
        }
      : {}),
  });
}

export function parseSessionIcpCorrelation(
  metadata: string | undefined,
): IcpConversationCorrelation | null {
  const envelope = parseEnvelope(metadata);
  if (envelope.icpCorrelation === undefined) return null;
  return parseIcpConversationCorrelation(envelope.icpCorrelation);
}
