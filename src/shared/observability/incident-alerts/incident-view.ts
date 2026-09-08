// ── Incident projection (bead psfn-framework-7qeo1.24.5) ──
//
// Rows in, incidents out. Pure: no clock, no store, no bus. That is what lets
// the alert path and the Garden timeline (child .6) call the same function over
// the same rows and be guaranteed to agree on the incident id, its timeline,
// and its evidence, rather than agreeing by convention.
//
// Grouping is by `correlationId` alone. The envelope makes that safe: a
// detector opens an episode with a fresh UUID and every later statement of that
// episode reuses it, while an ordinary observation (a pool sample, one
// background-work failure) gets a correlation id of its own and is therefore
// never mistaken for an incident. A correlation that contains no incident
// statement at all projects to nothing, which is exactly why healthy traffic
// produces an empty operator surface.

import {
  type HealthEvent,
  type HealthEventOwner,
  type HealthEventSeverity,
} from '../../contracts/health-event.js';
import { sameHealthEventOwner } from '../health-detectors/owner.js';
import {
  classifyIncidentStatement,
  type IncidentSummary,
  type IncidentTimelineEntry,
} from './contracts.js';

/** Ordered least to most severe, mirroring the envelope's own ordering. */
const SEVERITY_RANK: Readonly<Record<HealthEventSeverity, number>> = {
  info: 0,
  warning: 1,
  degraded: 2,
  critical: 3,
};

function maxSeverity(
  left: HealthEventSeverity,
  right: HealthEventSeverity,
): HealthEventSeverity {
  return SEVERITY_RANK[right] > SEVERITY_RANK[left] ? right : left;
}

function toTimelineEntry(event: HealthEvent): IncidentTimelineEntry {
  const statement = classifyIncidentStatement(event);
  return {
    eventId: event.eventId,
    ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
    code: event.code,
    severity: event.severity,
    ...(statement === null ? {} : { phase: statement.phase }),
    occurrenceCount: event.occurrenceCount,
    firstObservedAtMs: event.firstObservedAtMs,
    lastObservedAtMs: event.lastObservedAtMs,
    recordedAtMs: event.recordedAtMs,
    evidence: event.evidence,
  };
}

function byRecordedAtThenId(left: HealthEvent, right: HealthEvent): number {
  return left.recordedAtMs - right.recordedAtMs || left.eventId.localeCompare(right.eventId);
}

export interface IncidentProjectionOptions {
  /** Timeline rows kept per incident, newest retained. Owner-file bounded. */
  timelineLimit: number;
  /**
   * Restrict the projection to one tenancy. The alert path passes the
   * triggering event's owner so an incident bundle can never quote another
   * companion's rows; the Garden service passes the surface's own tenancy.
   */
  owner?: HealthEventOwner;
}

/**
 * Project the rows of ONE correlation into an incident, or null when they carry
 * no incident statement at all.
 *
 * A `closed` statement anywhere in the window closes the incident, because the
 * detector cycle emits exactly one close per episode and never reopens the same
 * correlation id afterwards — a recurrence is a new episode with a new id.
 */
export function summarizeIncident(
  events: readonly HealthEvent[],
  options: IncidentProjectionOptions,
): IncidentSummary | null {
  if (options.timelineLimit < 1 || !Number.isSafeInteger(options.timelineLimit)) {
    throw new Error('Incident projection timelineLimit must be a positive integer');
  }
  const scoped = options.owner === undefined
    ? [...events]
    : events.filter(event => sameHealthEventOwner(event.owner, options.owner!));
  if (scoped.length === 0) return null;
  const ordered = scoped.sort(byRecordedAtThenId);

  let opening: HealthEvent | undefined;
  let newestOpening: HealthEvent | undefined;
  let closing: HealthEvent | undefined;
  let statementCount = 0;
  let severity: HealthEventSeverity = 'info';
  for (const event of ordered) {
    const statement = classifyIncidentStatement(event);
    if (!statement) continue;
    statementCount += 1;
    severity = maxSeverity(severity, event.severity);
    if (statement.phase === 'closed') {
      closing = event;
      continue;
    }
    opening ??= event;
    newestOpening = event;
  }
  if (!opening || !newestOpening) return null;

  const anchor = closing ?? newestOpening;
  const timeline = ordered.slice(-options.timelineLimit).map(toTimelineEntry);
  const family = classifyIncidentStatement(opening)?.family ?? null;
  return {
    incidentId: opening.correlationId,
    family,
    code: opening.code,
    status: closing ? 'closed' : 'open',
    owner: opening.owner,
    component: opening.provenance.component,
    process: opening.provenance.process,
    severity,
    ...(opening.provenance.subjectHash === undefined
      ? {}
      : { subjectHash: opening.provenance.subjectHash }),
    openedAtMs: opening.firstObservedAtMs,
    lastObservedAtMs: anchor.lastObservedAtMs,
    closedAtMs: closing ? closing.lastObservedAtMs : null,
    occurrenceCount: anchor.occurrenceCount,
    statementCount,
    evidence: newestOpening.evidence,
    timeline,
    timelineTruncated: ordered.length > timeline.length,
  };
}

/**
 * Project a mixed stream window into every incident it contains, newest
 * activity first. Rows belonging to no incident are dropped rather than
 * fabricated into one, so a window of pure evidence yields an empty list.
 */
export function summarizeIncidents(
  events: readonly HealthEvent[],
  options: IncidentProjectionOptions,
): IncidentSummary[] {
  const byCorrelation = new Map<string, HealthEvent[]>();
  for (const event of events) {
    const existing = byCorrelation.get(event.correlationId);
    if (existing) {
      existing.push(event);
      continue;
    }
    byCorrelation.set(event.correlationId, [event]);
  }
  const incidents: IncidentSummary[] = [];
  for (const group of byCorrelation.values()) {
    const incident = summarizeIncident(group, options);
    if (incident) incidents.push(incident);
  }
  return incidents.sort((left, right) => (
    right.lastObservedAtMs - left.lastObservedAtMs
    || right.openedAtMs - left.openedAtMs
    || left.incidentId.localeCompare(right.incidentId)
  ));
}
