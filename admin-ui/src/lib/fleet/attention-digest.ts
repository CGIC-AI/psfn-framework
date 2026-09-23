import { throwIfAborted } from '../api/abort';
import { withFleetSessionRequestLock } from '../api/fleet-session';
import { isRecord } from '../../../../src/shared/utils/types.js';
import type { CompanionAttentionDigest } from '../../../../src/operator/garden/services/attention-digest-service.js';
import type { FleetPortalCompanion } from './portal';

/**
 * Cluster-wide "what's broken" (bead psfn-framework-vcq8v.8).
 *
 * Every companion Garden serves a content-free attention digest built from its
 * own incident timeline, escalation ledger, subsystem lanes, deferred-action
 * queue, model-usage ledger, and proactivity stores. The fleet page fans out
 * across the companions this session may reach, exactly like the card-detail
 * probe, and merges the answers. A companion whose Garden cannot be reached is
 * reported as unreachable — never counted as clean.
 */

export type CompanionAttentionResult =
  | { companionId: string; displayName: string; state: 'ok'; digest: CompanionAttentionDigest }
  | { companionId: string; displayName: string; state: 'unreachable' | 'denied'; reason: string };

export interface FleetAttentionSummary {
  companions: number;
  unreachable: number;
  openIncidents: number;
  openEscalations: number;
  attentionLanes: number;
  exhaustedDeferredActions: number;
  failedModelCalls: number;
  /** Companions with at least one open incident, open escalation, or attention lane. */
  companionsNeedingAttention: number;
}

const DIGEST_SECTIONS = [
  'incidents',
  'escalations',
  'subsystems',
  'deferredActions',
  'modelCalls',
  'proactivity',
] as const;

export function parseCompanionAttentionDigest(
  value: unknown,
  expectedCompanionId: string,
): CompanionAttentionDigest {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Companion attention digest has an unsupported shape');
  }
  if (value.companionId !== expectedCompanionId) {
    throw new Error('Companion attention digest answered for a different companion');
  }
  for (const name of DIGEST_SECTIONS) {
    const section = value[name];
    if (!isRecord(section) || (section.state !== 'ok' && section.state !== 'unavailable')) {
      throw new Error(`Companion attention digest section ${name} is malformed`);
    }
  }
  return value as unknown as CompanionAttentionDigest;
}

export async function fetchCompanionAttention(
  companion: FleetPortalCompanion,
  signal?: AbortSignal,
): Promise<CompanionAttentionResult> {
  const base = { companionId: companion.companionId, displayName: companion.displayName };
  if (!companion.gardenPath) {
    return { ...base, state: 'unreachable', reason: 'No Garden link for this companion' };
  }
  const gardenPath = companion.gardenPath;
  try {
    return await withFleetSessionRequestLock(async requestSignal => {
      const response = await fetch(`${gardenPath}/api/admin/attention-digest`, {
        cache: 'no-store',
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal: requestSignal,
      });
      throwIfAborted(requestSignal);
      if (response.status === 401 || response.status === 403) {
        return { ...base, state: 'denied' as const, reason: 'This session may not read diagnostics here' };
      }
      if (!response.ok) {
        return { ...base, state: 'unreachable' as const, reason: `Garden answered HTTP ${response.status}` };
      }
      const digest = parseCompanionAttentionDigest(await response.json(), companion.companionId);
      return { ...base, state: 'ok' as const, digest };
    }, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      ...base,
      state: 'unreachable',
      reason: error instanceof Error ? error.message : 'Garden could not be reached',
    };
  }
}

export function summarizeFleetAttention(
  results: readonly CompanionAttentionResult[],
): FleetAttentionSummary {
  const summary: FleetAttentionSummary = {
    companions: results.length,
    unreachable: 0,
    openIncidents: 0,
    openEscalations: 0,
    attentionLanes: 0,
    exhaustedDeferredActions: 0,
    failedModelCalls: 0,
    companionsNeedingAttention: 0,
  };
  for (const result of results) {
    if (result.state !== 'ok') {
      summary.unreachable += 1;
      continue;
    }
    const { digest } = result;
    const incidents = digest.incidents.state === 'ok' ? digest.incidents.open.length : 0;
    const escalations = digest.escalations.state === 'ok' ? digest.escalations.counts.open : 0;
    const lanes = digest.subsystems.state === 'ok' ? digest.subsystems.attention.length : 0;
    summary.openIncidents += incidents;
    summary.openEscalations += escalations;
    summary.attentionLanes += lanes;
    if (digest.deferredActions.state === 'ok') {
      summary.exhaustedDeferredActions += digest.deferredActions.failedCount;
    }
    if (digest.modelCalls.state === 'ok') summary.failedModelCalls += digest.modelCalls.failedCalls;
    if (incidents + escalations + lanes > 0) summary.companionsNeedingAttention += 1;
  }
  return summary;
}

/** The login banner shows only when something is actually open. */
export function fleetAttentionBannerVisible(summary: FleetAttentionSummary): boolean {
  return summary.openIncidents > 0 || summary.openEscalations > 0;
}
