import { isAppraiserSystemFailureReason } from '../../core/participation/appraiser.js';
import { parseIcpDeliveryObservation } from '../../core/session/icp-delivery-recovery.js';
import type { SessionEntry } from '../../core/session/types.js';
import { parseCompanionChannelId } from '../../shared/contracts/companion-channels.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { isRecord } from '../../shared/utils/types.js';

const log = createComponentLogger('IcpAppraisalFailureReconciliation');
const DELIVERY_OBSERVATION_PREFIX = '{"schemaVersion":1,"kind":"icp_delivery"';

export interface IcpAppraisalFailureReconciliationInput {
  sessions: {
    listRecentSessions(limit: number): ReadonlyArray<{
      channelId: string;
      lastActivityAt: number;
      messageCount: number;
    }>;
    getRecentSessionEntries(channelId: string, limit: number): SessionEntry[];
  };
  endEpisodeActivity(input: {
    conversationId: string;
    reasonCode: 'peer_appraisal_unavailable';
  }): Promise<unknown>;
  /** Only closures inside the relationship-pressure window still matter. */
  windowMs: number;
  nowMs: number;
}

/**
 * One-time startup correction for 0eq2x/9rima (idempotent on every start).
 *
 * Before 0eq2x, a companion whose participation appraisal failed as a system
 * error (timeout, model error, unparseable or truncated output) closed the
 * ICP conversation as `conversation_ended`, which counts as relationship
 * pressure. This companion's own journal still records each such decision as
 * a suppressed delivery observation carrying the fail-closed appraiser
 * reason. For every such conversation inside the pressure window, ask the
 * gateway to re-record the closure as `peer_appraisal_unavailable`; the
 * gateway accepts only that one correction of an ended `conversation_ended`
 * episode the caller participates in, and ignores it otherwise.
 */
export async function reconcileIcpAppraisalFailureClosures(
  input: IcpAppraisalFailureReconciliationInput,
): Promise<{ scannedChannels: number; conversations: number; failed: number }> {
  const cutoffMs = input.nowMs - input.windowMs;
  const conversationIds = new Set<string>();
  let scannedChannels = 0;
  for (const session of input.sessions.listRecentSessions(Number.MAX_SAFE_INTEGER)) {
    if (session.lastActivityAt < cutoffMs) break;
    if (!parseCompanionChannelId(session.channelId)) continue;
    scannedChannels += 1;
    const entries = input.sessions.getRecentSessionEntries(session.channelId, session.messageCount);
    for (const entry of entries) {
      if (entry.role !== 'system' || entry.timestamp < cutoffMs) continue;
      if (!entry.content.startsWith(DELIVERY_OBSERVATION_PREFIX)) continue;
      const conversationId = appraisalFailureConversationId(session.channelId, entry.content);
      if (conversationId) conversationIds.add(conversationId);
    }
  }
  let failed = 0;
  for (const conversationId of conversationIds) {
    try {
      await input.endEpisodeActivity({ conversationId, reasonCode: 'peer_appraisal_unavailable' });
    } catch (error) {
      failed += 1;
      log.error('Could not re-record an ICP appraisal-failure closure', {
        conversationId,
        error: toErrorMessage(error),
      });
    }
  }
  log.info('ICP appraisal-failure closures reconciled', {
    scannedChannels,
    conversations: conversationIds.size,
    failed,
  });
  return { scannedChannels, conversations: conversationIds.size, failed };
}

function appraisalFailureConversationId(channelId: string, content: string): string | null {
  let sourceMessageId: unknown;
  try {
    const raw: unknown = JSON.parse(content);
    sourceMessageId = isRecord(raw) ? raw.sourceMessageId : undefined;
  } catch (error) {
    throw new Error(`ICP delivery observation on ${channelId} is malformed JSON: ${toErrorMessage(error)}`);
  }
  if (typeof sourceMessageId !== 'string') {
    throw new Error(`ICP delivery observation on ${channelId} has no sourceMessageId`);
  }
  const observation = parseIcpDeliveryObservation(content, { channelId, sourceMessageId });
  const metadata = observation.recoveryResponse?.metadata;
  const noReply = metadata?.noReply;
  if (observation.status !== 'suppressed' || !noReply || !metadata.icpCorrelation) return null;
  if (noReply.source !== 'participation_appraiser' || !isAppraiserSystemFailureReason(noReply.reason)) {
    return null;
  }
  return metadata.icpCorrelation.conversationId;
}
