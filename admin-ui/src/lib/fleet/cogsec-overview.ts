// Fleet CogSec overview (waw5q): the cluster-owned Global Firewall surface.
//
// The fleet page reaches each authorized companion's Garden to read its current
// intake-quarantine queue + shared firewall status, then aggregates them
// client-side with the SAME pure function the backend uses. The result is
// content-free (counts + timings only) and is framed as the shared gateway's
// posture, never the primary companion's personal control.

import {
  aggregateFleetCogSecOverview,
  countIntakeOutcomes,
  type FleetCogSecCompanionProjection,
  type FleetCogSecOverview,
  type FleetCogSecPolicyStatus,
} from '../../../../src/operator/garden/services/fleet-cogsec-overview.js';
import { withFleetSessionRequestLock } from '$lib/api/fleet-session';
import { isRecord } from '../../../../src/shared/utils/types.js';
import type { FleetPortalCompanion } from './portal';
import type {
  AdminIntakeQuarantineFirewallStatus,
  AdminIntakeQuarantineItemView,
  IntakePolicyConfig,
} from '$lib/types';

export interface CompanionCogSecSnapshot {
  companionId: string;
  displayName: string;
  reachable: boolean;
  policy: IntakePolicyConfig | null;
  firewallStatus: AdminIntakeQuarantineFirewallStatus | null;
  items: AdminIntakeQuarantineItemView[];
}

interface CompanionQuarantineResponse {
  items: AdminIntakeQuarantineItemView[];
  firewallStatus: AdminIntakeQuarantineFirewallStatus;
}

function isItemView(value: unknown): value is AdminIntakeQuarantineItemView {
  return isRecord(value) && typeof value.id === 'string' && typeof value.status === 'string';
}

function isQuarantineResponse(value: unknown): value is CompanionQuarantineResponse {
  if (!isRecord(value) || !Array.isArray(value.items)) return false;
  if (!value.items.every(isItemView)) return false;
  const status = value.firewallStatus;
  return isRecord(status)
    && typeof status.mode === 'string'
    && status.queueEmptyDoesNotMeanFirewallOff === true;
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error(`Companion Garden returned ${String(response.status)}`);
  return response.json();
}

/** Reads one authorized companion's current intake-quarantine queue + firewall status. */
export async function fetchCompanionCogSecSnapshot(
  companion: FleetPortalCompanion,
  signal?: AbortSignal,
): Promise<CompanionCogSecSnapshot> {
  const base: CompanionCogSecSnapshot = {
    companionId: companion.companionId,
    displayName: companion.displayName,
    reachable: false,
    policy: null,
    firewallStatus: null,
    items: [],
  };
  if (!companion.gardenPath) return base;
  try {
    const raw = await withFleetSessionRequestLock(async requestSignal => (
      fetchJson(`${companion.gardenPath}/api/admin/intake/quarantine`, requestSignal)
    ), signal);
    if (!isQuarantineResponse(raw)) return base;
    return {
      ...base,
      reachable: true,
      firewallStatus: raw.firewallStatus,
      items: raw.items,
    };
  } catch {
    // A companion whose Garden transport is unreachable contributes no rows;
    // the aggregate records it as not-reachable rather than inventing zeros.
    return base;
  }
}

/**
 * Projects one companion snapshot into the content-free shape the pure
 * aggregator consumes. Outcome counts come from the current queue items;
 * decision latency is computed from items that reached a human decision.
 */
export function projectCompanionCogSec(
  snapshot: CompanionCogSecSnapshot,
): FleetCogSecCompanionProjection {
  const outcomes = countIntakeOutcomes(
    snapshot.items.map(item => ({
      status: item.status,
      ...(item.attribution ? { direction: item.attribution.direction } : {}),
    })),
  );
  const decisionLatencyMs: number[] = [];
  for (const item of snapshot.items) {
    if (!item.operatorDecision || !item.heldAt) continue;
    const heldAt = Date.parse(item.heldAt);
    const decidedAt = Date.parse(item.operatorDecision.at);
    if (Number.isFinite(heldAt) && Number.isFinite(decidedAt) && decidedAt >= heldAt) {
      decisionLatencyMs.push(decidedAt - heldAt);
    }
  }
  const correlationKeys = snapshot.items
    .map(item => item.attribution?.correlationId)
    .filter((key): key is string => typeof key === 'string');
  const severityByStatus = { low: 0, medium: 0, high: 0, critical: 0 };
  // The current queue carries no severity per item; severity history lives in
  // each companion's CogSec events. We surface zero severity counts here
  // rather than fabricating them from the queue.
  const policy = policyStatusFromSnapshot(snapshot);
  return {
    companionId: snapshot.companionId,
    displayName: snapshot.displayName,
    policy,
    outcomeCounts: outcomes,
    severityCounts: severityByStatus,
    decisionLatencyMs,
    correlationKeys,
  };
}

function policyStatusFromSnapshot(snapshot: CompanionCogSecSnapshot): FleetCogSecPolicyStatus {
  const status = snapshot.firewallStatus;
  if (!status) throw new Error('Reachable companion omitted shared firewall status');
  return {
    mode: status.mode,
    quarantineItemTtlHours: status.quarantineItemTtlHours,
    quarantineMaxHeldItems: status.quarantineMaxHeldItems,
    ownership: 'shared-gateway',
  };
}

/**
 * Aggregates authorized companion snapshots into one content-free fleet
 * overview. Pass the access mode the session holds (`sole_admin` vs
 * `multi_admin`) so the result states the scope truthfully.
 */
export function buildFleetCogSecOverview(
  snapshots: readonly CompanionCogSecSnapshot[],
  accessMode: 'sole_admin' | 'multi_admin',
  now: () => Date = () => new Date(),
): FleetCogSecOverview {
  const reachable = snapshots.filter(snapshot => snapshot.reachable);
  return aggregateFleetCogSecOverview(
    reachable.map(projectCompanionCogSec),
    { accessMode, now },
  );
}
