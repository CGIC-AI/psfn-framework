import type { FatigueLedger } from '../../../shared/telemetry/fatigue-ledger.js';

/**
 * Read the companion-owned fatigue ledger before a shared-device lease may be
 * acquired. No entry means no fatigue spend has been recorded for the exact
 * partner/channel scope; an exhausted latest state closes the gate.
 */
export function resolveSharedSatelliteFatigueEligibility(input: {
  fatigueLedger: Pick<FatigueLedger, 'getData'>;
  localCompanionId: string;
  canonicalContactId: string;
  channelId: string;
}): { fatigueAllows: boolean } {
  const localCompanionId = input.localCompanionId.trim();
  const peerContactId = input.canonicalContactId.trim();
  const channelId = input.channelId.trim();
  if (!localCompanionId || !peerContactId || !channelId) {
    throw new Error(
      'Satellite response eligibility requires exact companion, contact, and channel identity',
    );
  }
  const events = input.fatigueLedger.getData({
    localCompanionId,
    peerContactId,
    channelId,
    limit: 1,
  }).events;
  const latest = events.length > 0 ? events[0]?.event : undefined;
  return { fatigueAllows: latest?.hardState !== 'exhausted' };
}
