// ── Fleet CogSec: cluster-owned, content-free firewall overview (waw5q) ──
//
// The Global Firewall surface is cluster-owned: it presents the ONE shared
// gateway intake policy plus content-free aggregate outcomes across the
// companions the viewer is authorized to reach. It must never look like the
// primary companion's personal control, never expose message bodies, and never
// leak cross-companion private data — only counts and timings.
//
// This module is a pure aggregation over per-companion projections the caller
// has already gathered under authorization. It owns no store and performs no
// I/O. Authorization (sole-admin vs multi-admin) is expressed by which
// companion projections the caller passes in: the caller is responsible for
// passing exactly the authorized set, and this module records that scope on
// the result so the UI can state it truthfully.

import type { IntakeCogSecDirection, IntakeCogSecScreeningStage } from './cogsec-intake-attribution.js';

type FleetCogSecFirewallMode = 'off' | 'shadow' | 'enforce';

/** Shared gateway policy/status — cluster-owned, identical across companions. */
export interface FleetCogSecPolicyStatus {
  readonly mode: FleetCogSecFirewallMode;
  readonly quarantineItemTtlHours: number;
  readonly quarantineMaxHeldItems: number;
  /**
   * Explicit marker: this policy is the shared gateway's, not a companion's.
   * Lets the UI frame the surface as cluster-owned without ambiguity.
   */
  readonly ownership: 'shared-gateway';
}

export interface FleetCogSecOutcomeCounts {
  readonly held: number;
  readonly releasedSanitized: number;
  readonly releasedRaw: number;
  readonly discarded: number;
  readonly expired: number;
  /** L3-cleared items substituted with a safe representation (auto-released). */
  readonly cleared: number;
  /** Hard egress-trifecta blocks (sink-gate denials). */
  readonly blockedEgress: number;
}

interface FleetCogSecSeverityCounts {
  readonly low: number;
  readonly medium: number;
  readonly high: number;
  readonly critical: number;
}

interface FleetCogSecLatencyProjection {
  /** Number of decided items the latency figures were computed over. */
  readonly decidedCount: number;
  readonly medianDecisionMs: number;
  readonly p95DecisionMs: number;
  readonly maxDecisionMs: number;
}

interface FleetCogSecCorrelationProjection {
  /** Distinct group-fanout correlation groups observed (content-free). */
  readonly groupCount: number;
  /** Total members across those groups. */
  readonly totalMembers: number;
  readonly largestGroup: number;
}

/**
 * Per-companion, content-free projection the caller gathers under
 * authorization. Carries only counts and the shared policy — never bodies,
 * never private peer data.
 */
export interface FleetCogSecCompanionProjection {
  readonly companionId: string;
  readonly displayName: string;
  readonly policy: FleetCogSecPolicyStatus;
  readonly outcomeCounts: FleetCogSecOutcomeCounts;
  readonly severityCounts: FleetCogSecSeverityCounts;
  /**
   * Decided-item latencies (decision time minus hold time), one entry per
   * decided item. Content-free: only a duration in milliseconds.
   */
  readonly decisionLatencyMs: readonly number[];
  /**
   * Correlation keys observed on this companion's rows (group fanout). Each
   * key is an opaque content-free token; duplicates within a companion count
   * as one group with multiple members.
   */
  readonly correlationKeys: readonly string[];
}

export interface FleetCogSecOverview {
  readonly generatedAt: string;
  /** Authorized companion scope this aggregate covers. */
  readonly companionScope: {
    readonly count: number;
    readonly displayNames: readonly string[];
    /** `sole_admin` (one rostered human) vs `multi_admin` (subject boundary). */
    readonly accessMode: 'sole_admin' | 'multi_admin';
  };
  /** Shared gateway firewall policy/status (cluster-owned). */
  readonly policyStatus: FleetCogSecPolicyStatus;
  readonly outcomeCounts: FleetCogSecOutcomeCounts;
  readonly severityCounts: FleetCogSecSeverityCounts;
  readonly latency: FleetCogSecLatencyProjection;
  readonly correlation: FleetCogSecCorrelationProjection;
}

export interface AggregateFleetCogSecOverviewOptions {
  readonly now?: () => Date;
  readonly accessMode: 'sole_admin' | 'multi_admin';
}

const EMPTY_OUTCOMES: FleetCogSecOutcomeCounts = Object.freeze({
  held: 0,
  releasedSanitized: 0,
  releasedRaw: 0,
  discarded: 0,
  expired: 0,
  cleared: 0,
  blockedEgress: 0,
});
const EMPTY_SEVERITY: FleetCogSecSeverityCounts = Object.freeze({
  low: 0,
  medium: 0,
  high: 0,
  critical: 0,
});
const EMPTY_LATENCY: FleetCogSecLatencyProjection = Object.freeze({
  decidedCount: 0,
  medianDecisionMs: 0,
  p95DecisionMs: 0,
  maxDecisionMs: 0,
});
const EMPTY_CORRELATION: FleetCogSecCorrelationProjection = Object.freeze({
  groupCount: 0,
  totalMembers: 0,
  largestGroup: 0,
});

function addOutcomes(into: FleetCogSecOutcomeCounts, add: FleetCogSecOutcomeCounts): FleetCogSecOutcomeCounts {
  return {
    held: into.held + add.held,
    releasedSanitized: into.releasedSanitized + add.releasedSanitized,
    releasedRaw: into.releasedRaw + add.releasedRaw,
    discarded: into.discarded + add.discarded,
    expired: into.expired + add.expired,
    cleared: into.cleared + add.cleared,
    blockedEgress: into.blockedEgress + add.blockedEgress,
  };
}

function addSeverity(into: FleetCogSecSeverityCounts, add: FleetCogSecSeverityCounts): FleetCogSecSeverityCounts {
  return {
    low: into.low + add.low,
    medium: into.medium + add.medium,
    high: into.high + add.high,
    critical: into.critical + add.critical,
  };
}

function quantile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0] ?? 0;
  // Nearest-rank quantile (inclusive), stable and allocation-free.
  const rank = Math.ceil(q * sortedAsc.length);
  const index = Math.min(Math.max(rank, 1), sortedAsc.length) - 1;
  return sortedAsc[index] ?? 0;
}

function median(sortedAsc: readonly number[]): number {
  if (sortedAsc.length === 0) return 0;
  const mid = Math.floor(sortedAsc.length / 2);
  if (sortedAsc.length % 2 !== 0) return sortedAsc[mid] ?? 0;
  const left = sortedAsc[mid - 1] ?? 0;
  const right = sortedAsc[mid] ?? 0;
  return Math.round((left + right) / 2);
}

function projectLatency(latencies: readonly number[]): FleetCogSecLatencyProjection {
  if (latencies.length === 0) return EMPTY_LATENCY;
  const sorted = [...latencies].sort((left, right) => left - right);
  return {
    decidedCount: sorted.length,
    medianDecisionMs: median(sorted),
    p95DecisionMs: quantile(sorted, 0.95),
    maxDecisionMs: sorted[sorted.length - 1] ?? 0,
  };
}

function projectCorrelation(
  perCompanionKeys: ReadonlyArray<readonly string[]>,
): FleetCogSecCorrelationProjection {
  if (perCompanionKeys.length === 0) return EMPTY_CORRELATION;
  // A correlation group spans companions (one fanout reaching several targets).
  // Group members are counted across the whole authorized scope.
  const groups = new Map<string, number>();
  for (const keys of perCompanionKeys) {
    for (const key of keys) {
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
  }
  if (groups.size === 0) return EMPTY_CORRELATION;
  let totalMembers = 0;
  let largestGroup = 0;
  for (const size of groups.values()) {
    totalMembers += size;
    if (size > largestGroup) largestGroup = size;
  }
  return { groupCount: groups.size, totalMembers, largestGroup };
}

/**
 * Aggregates authorized per-companion projections into one content-free fleet
 * overview. The caller MUST pass exactly the companions the viewer is
 * authorized to reach; this function does not re-check authorization, but it
 * does record the scope on the result so the UI can state it truthfully.
 */
export function aggregateFleetCogSecOverview(
  companions: readonly FleetCogSecCompanionProjection[],
  options: AggregateFleetCogSecOverviewOptions,
): FleetCogSecOverview {
  const now = (options.now ?? (() => new Date()))();
  if (companions.length === 0) {
    return {
      generatedAt: now.toISOString(),
      companionScope: { count: 0, displayNames: [], accessMode: options.accessMode },
      // With no authorized companions there is no shared policy to report; the
      // UI frames this as "no cluster access", never as "firewall off".
      policyStatus: {
        mode: 'off',
        quarantineItemTtlHours: 0,
        quarantineMaxHeldItems: 0,
        ownership: 'shared-gateway',
      },
      outcomeCounts: EMPTY_OUTCOMES,
      severityCounts: EMPTY_SEVERITY,
      latency: EMPTY_LATENCY,
      correlation: EMPTY_CORRELATION,
    };
  }

  let outcomes: FleetCogSecOutcomeCounts = EMPTY_OUTCOMES;
  let severity: FleetCogSecSeverityCounts = EMPTY_SEVERITY;
  let policy: FleetCogSecPolicyStatus | undefined;
  const latencies: number[] = [];
  const correlationKeys: string[][] = [];
  const displayNames: string[] = [];
  const seenCompanions = new Set<string>();
  for (const companion of companions) {
    if (seenCompanions.has(companion.companionId)) {
      throw new Error(`Fleet CogSec overview received a duplicate companion: ${companion.companionId}`);
    }
    seenCompanions.add(companion.companionId);
    outcomes = addOutcomes(outcomes, companion.outcomeCounts);
    severity = addSeverity(severity, companion.severityCounts);
    // The shared gateway policy is identical across companions; take the first
    // and assert the rest agree so a drift is never silently averaged away.
    if (!policy) {
      policy = companion.policy;
    } else if (!samePolicyStatus(policy, companion.policy)) {
      throw new Error('Fleet CogSec overview companions disagree on the shared gateway policy');
    }
    latencies.push(...companion.decisionLatencyMs);
    correlationKeys.push([...companion.correlationKeys]);
    displayNames.push(companion.displayName);
  }

  return {
    generatedAt: now.toISOString(),
    companionScope: {
      count: companions.length,
      displayNames: Object.freeze(displayNames),
      accessMode: options.accessMode,
    },
    policyStatus: policy!,
    outcomeCounts: outcomes,
    severityCounts: severity,
    latency: projectLatency(latencies),
    correlation: projectCorrelation(correlationKeys),
  };
}

function samePolicyStatus(left: FleetCogSecPolicyStatus, right: FleetCogSecPolicyStatus): boolean {
  return left.mode === right.mode
    && left.quarantineItemTtlHours === right.quarantineItemTtlHours
    && left.quarantineMaxHeldItems === right.quarantineMaxHeldItems;
}

// ── Helpers for callers building per-companion projections ──

/**
 * Counts quarantine/CogSec rows into outcome buckets. Direction and stage are
 * accepted so a caller can split egress blocks from inbound holds if desired;
 * by default every row is counted once.
 */
export function countIntakeOutcomes(rows: ReadonlyArray<{
  status: string;
  decision?: string;
  direction?: IntakeCogSecDirection;
  screeningStage?: IntakeCogSecScreeningStage;
}>): FleetCogSecOutcomeCounts {
  const counts = { ...EMPTY_OUTCOMES };
  for (const row of rows) {
    if (row.direction === 'outbound' && row.status === 'applied') {
      counts.blockedEgress += 1;
      continue;
    }
    switch (row.status) {
      case 'held': counts.held += 1; break;
      case 'released_sanitized': counts.releasedSanitized += 1; break;
      case 'released_raw': counts.releasedRaw += 1; break;
      case 'discarded': counts.discarded += 1; break;
      case 'expired': counts.expired += 1; break;
      case 'cleared': counts.cleared += 1; break;
      default: break;
    }
  }
  return Object.freeze(counts);
}
