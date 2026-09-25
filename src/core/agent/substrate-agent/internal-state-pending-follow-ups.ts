import { createComponentLogger } from '../../../shared/logger.js';
import {
  filterPendingFollowUpsForActiveChannel,
  type PendingFollowUp,
  type PendingFollowUpContextProvider,
} from '../../intention/pending-follow-ups.js';
import { validatePendingFollowUpForInternalState } from '../../self-model/state.js';

const log = createComponentLogger('InternalStatePendingFollowUps');

/** Typed alarm event for a follow-up row isolated out of InternalState (9rima). */
const INTERNAL_STATE_PENDING_FOLLOW_UP_QUARANTINED = 'internal_state_pending_follow_up_quarantined';
const QUARANTINE_SOURCE = 'internal_state';

/**
 * Resolves the pending follow-ups that feed one InternalState computation.
 *
 * Each row is validated against the InternalState contract on its own. A row
 * that fails is moved into the durable follow-up quarantine table with a typed
 * alarm, and the state is built from the remaining rows: one bad row must not
 * fail every later reply and initiation. A provider that cannot quarantine
 * fails closed with the validation error.
 */
export async function resolveInternalStatePendingFollowUps(
  provider: PendingFollowUpContextProvider | null,
  canonicalContactKey: string | undefined,
  sessionChannelId: string | undefined,
): Promise<PendingFollowUp[]> {
  if (!provider) return [];
  const followUps = provider.getPendingFollowUps(canonicalContactKey);
  if (!Array.isArray(followUps)) {
    throw new Error('Pending follow-up provider returned an invalid payload for InternalState computation');
  }
  const valid: PendingFollowUp[] = [];
  for (const followUp of followUps) {
    try {
      validatePendingFollowUpForInternalState(followUp);
      valid.push(followUp);
    } catch (error) {
      await quarantineInvalidFollowUp(provider, followUp, error);
    }
  }
  return filterPendingFollowUpsForActiveChannel(valid, sessionChannelId);
}

async function quarantineInvalidFollowUp(
  provider: PendingFollowUpContextProvider,
  followUp: PendingFollowUp,
  validationError: unknown,
): Promise<void> {
  const followUpId = typeof (followUp as { id?: unknown }).id === 'string' ? followUp.id : '';
  const reason = validationError instanceof Error ? validationError.message : String(validationError);
  if (!provider.quarantinePendingFollowUp || !followUpId) {
    throw validationError;
  }
  await provider.quarantinePendingFollowUp({
    followUpId,
    reason,
    raw: followUp,
    source: QUARANTINE_SOURCE,
  });
  log.error(INTERNAL_STATE_PENDING_FOLLOW_UP_QUARANTINED, {
    alarm: INTERNAL_STATE_PENDING_FOLLOW_UP_QUARANTINED,
    followUpId,
    channelId: followUp.channelId,
    channelType: followUp.channelType,
    reason,
  });
}
