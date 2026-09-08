// ── Incident alert rendering (bead psfn-framework-7qeo1.24.5) ──
//
// Turns a content-free incident bundle into the notification the existing
// operator-alert dispatcher already accepts. Every value written here comes
// from the health envelope's closed vocabularies, its numeric/boolean evidence,
// its opaque identifiers, or the owner file — so the rendered text is
// content-free by construction rather than by review, and there is no path by
// which conversation content, an error string, or a private identifier could
// appear in an operator notification.
//
// It also carries the two things that make the alert actionable: the incident
// id, which is the same `correlationId` the Garden timeline lists it under, and
// the owner-file thresholds that were in force when the runtime decided this
// was an incident.

import type { HealthEventOwner } from '../../shared/contracts/health-event.js';
import type {
  IncidentBundle,
  IncidentStatementPhase,
} from '../../shared/observability/incident-alerts/contracts.js';
import type { NotifyNtfyParams } from './protocol.js';

/**
 * Provenance of every alert this path delivers. The dispatcher requires a
 * system-kind sender: an incident belongs to the runtime, never to a companion
 * speaking, even when the incident itself is companion-owned.
 */
const INCIDENT_ALERT_SENDER = Object.freeze({
  kind: 'system' as const,
  provenance: 'system.observability.incident_alert',
});

function describeOwner(owner: HealthEventOwner): string {
  return owner.kind === 'companion' ? `companion ${owner.companionId}` : 'system';
}

function describeValues(values: Readonly<Record<string, number | boolean>>): string {
  const entries = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`);
  return entries.length > 0 ? entries.join(', ') : 'none';
}

function describeInstant(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * One notification for one incident statement.
 *
 * `idempotencyKey` is the incident id, its phase, and the alert sequence. It
 * must vary per alert: a sink that collapses repeats on the key would silently
 * swallow the cooldown-gated re-alert that tells an operator a fault is still
 * going, which is the opposite of deduplication.
 */
export function renderIncidentAlert(
  bundle: IncidentBundle,
  phase: IncidentStatementPhase,
  sequence: number,
): NotifyNtfyParams {
  const incident = bundle.incident;
  const subject = incident.family ?? incident.code;
  const lines = [
    `Incident ${incident.incidentId}`,
    `Condition: ${incident.code} (${incident.severity})`,
    `Runtime: ${incident.process} / ${incident.component}, owned by ${
      describeOwner(incident.owner)
    }`,
    `Opened: ${describeInstant(incident.openedAtMs)}`,
    phase === 'closed' && incident.closedAtMs !== null
      ? `Closed: ${describeInstant(incident.closedAtMs)}`
      : `Last observed: ${describeInstant(incident.lastObservedAtMs)}`,
    `Occurrences: ${String(incident.occurrenceCount)} across ${
      String(incident.statementCount)
    } recorded statements`,
    `Evidence: ${describeValues(incident.evidence)}`,
    `Thresholds (${bundle.thresholds.ownerFile} > ${bundle.thresholds.path}): ${
      describeValues(bundle.thresholds.detector)
    }`,
    `Alert policy: ${describeValues(bundle.thresholds.alerts)}`,
    `Garden: /subsystem-health, incident ${incident.incidentId}`,
  ];
  return {
    sender: INCIDENT_ALERT_SENDER,
    title: `PSFN incident ${phase}: ${subject}`,
    message: lines.join('\n'),
    idempotencyKey: `${incident.incidentId}:${phase}:${String(sequence)}`,
  };
}
