import type { SessionEntry } from '../../../core/session/types.js';
import { parseSessionIcpCorrelation } from '../../../core/session/icp-correlation-metadata.js';
import type { IcpConversationCorrelation } from '../../../shared/contracts/icp-autonomy.js';
import { parseCompanionChannelId } from '../../../shared/contracts/companion-channels.js';
import { isExtractionTranscriptEntry } from './chunk-compose.js';

export interface IcpExtractionLineage {
  icpDyadId?: string;
  sourceActivityIds?: string[];
  sourceTurnIds?: string[];
}

/**
 * Project the durable relationship/activity lineage carried by ordinary ICP
 * session entries onto one extracted fact. Activity episodes remain bounded;
 * the canonical DM session and dyad remain stable across them.
 */
export function resolveIcpExtractionLineage(input: {
  channelId: string;
  entries: readonly SessionEntry[];
  sourceMessageIds?: readonly number[];
  currentCorrelation?: IcpConversationCorrelation;
}): IcpExtractionLineage {
  const parsedChannel = parseCompanionChannelId(input.channelId);
  if (parsedChannel?.kind !== 'dm') return {};

  if (input.currentCorrelation && input.currentCorrelation.channelId !== input.channelId) {
    throw new Error('ICP extraction correlation does not match the source channel');
  }

  const sourceIds = input.sourceMessageIds ? new Set(input.sourceMessageIds) : null;
  const sourceEntries = input.entries.filter(entry => (
    isExtractionTranscriptEntry(entry) && (!sourceIds || sourceIds.has(entry.id))
  ));
  const correlations: IcpConversationCorrelation[] = [];
  for (const entry of sourceEntries) {
    const correlation = parseSessionIcpCorrelation(entry.metadata);
    if (!correlation) continue;
    if (correlation.channelId !== input.channelId) {
      throw new Error('ICP extraction entry correlation does not match the source channel');
    }
    correlations.push(correlation);
  }

  // Old journal entries may predate correlation metadata. The current durable
  // work item is an authoritative fallback only when no selected source entry
  // carries its own lineage; it must never overwrite a mixed historical span.
  if (correlations.length === 0 && input.currentCorrelation) {
    correlations.push(input.currentCorrelation);
  }

  const dyadIds = new Set(correlations.flatMap(correlation => (
    correlation.dyadId ? [correlation.dyadId] : []
  )));
  if (input.currentCorrelation?.dyadId) dyadIds.add(input.currentCorrelation.dyadId);
  if (dyadIds.size > 1) {
    throw new Error('ICP extraction source range crosses durable dyad identities');
  }
  const sourceActivityIds = [...new Set(correlations.map(correlation => correlation.conversationId))].sort();
  const sourceTurnIds = [...new Set(correlations.map(correlation => correlation.turnId))].sort();
  const icpDyadId = [...dyadIds][0];

  return {
    ...(icpDyadId ? { icpDyadId } : {}),
    ...(sourceActivityIds.length > 0 ? { sourceActivityIds } : {}),
    ...(sourceTurnIds.length > 0 ? { sourceTurnIds } : {}),
  };
}
