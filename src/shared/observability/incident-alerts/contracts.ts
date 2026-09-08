// ── Incident projection contracts (bead psfn-framework-7qeo1.24.5) ──
//
// The detectors (children .2-.4) turn runtime conditions into EPISODES in the
// persisted health stream: one `opened` event carrying a fresh `correlationId`,
// further `opened` events on that same id while the condition persists, and one
// `closed` event on recovery. This module owns the projection of those rows
// into {@link IncidentSummary} — the shape an operator reads.
//
// One projection, two consumers. The alert an operator receives (this bead) and
// the Garden incident timeline (child .6) are built by the same function from
// the same rows, so the incident id in a notification and the incident id on
// the operator surface cannot drift apart.
//
// Everything projected here stays content-free: the envelope's closed
// vocabularies, its numeric/boolean evidence, and its opaque identifiers are
// the only inputs, so a rendered alert cannot carry conversation content, an
// error string, or a private identifier no matter what a detector did.

import {
  resolveHealthIncidentPhase,
  type HealthEvent,
  type HealthEventCode,
  type HealthEventComponent,
  type HealthEventEvidence,
  type HealthEventOwner,
  type HealthEventProcess,
  type HealthEventSeverity,
  type HealthIncidentFamily,
} from '../../contracts/health-event.js';
import type { SandboxDeniedCapability } from '../../contracts/sandbox-analysis-contracts.js';

/**
 * Health-event codes that are an incident in their own right rather than one
 * phase of a detector episode.
 *
 * `operator_alert_sinks_unconfigured` is the only member and the reason this
 * concept exists: a runtime that cannot deliver an operator alert is the one
 * fault nobody would otherwise be told about. It has no detector, no `closed`
 * partner, and no recovery event — the gateway emits it once per boot with its
 * own correlation id — so it is alerted on sight and never re-stated.
 */
export const STANDALONE_INCIDENT_CODES = [
  'operator_alert_sinks_unconfigured',
] as const satisfies readonly HealthEventCode[];

function isStandaloneIncidentCode(code: HealthEventCode): boolean {
  return (STANDALONE_INCIDENT_CODES as readonly HealthEventCode[]).includes(code);
}

/** Where an incident row sits in its episode. */
export type IncidentStatementPhase = 'opened' | 'closed';

/**
 * How one health event relates to an incident.
 *
 * `null` is the common case, and it is why a healthy runtime is quiet: an
 * ordinary observation (a pool-pressure sample, one background-work failure) is
 * stream evidence, never an incident statement. Treating those as alertable
 * would be exactly the alert-per-event behaviour the epic rules out.
 */
export interface IncidentStatement {
  incidentId: string;
  phase: IncidentStatementPhase;
  /** The detector family, or null for a standalone code with no detector. */
  family: HealthIncidentFamily | null;
}

/**
 * The single classification seam. Both the alert path and the Garden timeline
 * decide "is this row part of an incident, and which end of it?" here, so a new
 * code becomes visible to both surfaces at once.
 */
export function classifyIncidentStatement(event: HealthEvent): IncidentStatement | null {
  const episode = resolveHealthIncidentPhase(event.code);
  if (episode) {
    return { incidentId: event.correlationId, phase: episode.phase, family: episode.family };
  }
  if (isStandaloneIncidentCode(event.code)) {
    return { incidentId: event.correlationId, phase: 'opened', family: null };
  }
  return null;
}

/** One stream row of an incident, oldest-first in {@link IncidentSummary}. */
export interface IncidentTimelineEntry {
  eventId: string;
  causationId?: string;
  code: HealthEventCode;
  severity: HealthEventSeverity;
  /** Absent for a row that is evidence rather than an episode boundary. */
  phase?: IncidentStatementPhase;
  occurrenceCount: number;
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  recordedAtMs: number;
  evidence: HealthEventEvidence;
}

/**
 * One incident, projected from its stream rows. `incidentId` IS the envelope's
 * `correlationId`: the alert path and the Garden timeline both key on it, so an
 * operator reading a notification can find the same incident on the surface.
 */
export interface IncidentSummary {
  incidentId: string;
  family: HealthIncidentFamily | null;
  /** The code that opened the incident. */
  code: HealthEventCode;
  status: 'open' | 'closed';
  owner: HealthEventOwner;
  component: HealthEventComponent;
  process: HealthEventProcess;
  /** Highest severity any statement of this incident carried. */
  severity: HealthEventSeverity;
  subjectHash?: string;
  openedAtMs: number;
  lastObservedAtMs: number;
  closedAtMs: number | null;
  /** Occurrences the newest statement reported. */
  occurrenceCount: number;
  /** Rows this incident wrote inside the read window. */
  statementCount: number;
  /** Evidence from the newest opening statement. */
  evidence: HealthEventEvidence;
  timeline: IncidentTimelineEntry[];
  /** True when the incident has more rows than the bounded window returned. */
  timelineTruncated: boolean;
}

/**
 * The owner-file values in force when the incident was assembled. An operator
 * reading an alert needs to know which threshold the runtime actually applied,
 * and the values are content-free numbers and flags, so they travel with the
 * bundle rather than having to be looked up separately.
 */
export interface IncidentThresholdSnapshot {
  ownerFile: 'scheduler.json';
  /** Owner-file path of the detector block that governs this family. */
  path: string;
  detector: Readonly<Record<string, number | boolean>>;
  cycle: Readonly<Record<string, number>>;
  alerts: Readonly<Record<string, number | boolean>>;
}

/**
 * The authority the incident investigator holds. It is declared with the
 * runtime's existing {@link SandboxDeniedCapability} vocabulary rather than a
 * parallel one, and the denial list is exhaustive: the investigator reads a
 * bounded stream window through one injected function and does nothing else.
 */
export interface IncidentInvestigatorBoundary {
  kind: 'read_only_investigator';
  deniedCapabilities: readonly SandboxDeniedCapability[];
  mutationAuthority: false;
  reason: string;
}

/** The content-free evidence package one operator alert carries. */
export interface IncidentBundle {
  boundary: IncidentInvestigatorBoundary;
  incident: IncidentSummary;
  thresholds: IncidentThresholdSnapshot;
  assembledAtMs: number;
}
