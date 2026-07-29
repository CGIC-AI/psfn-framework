// ── Durable redaction projection-drift incident subscriber (bead 6oott) ──
//
// The Garden-facing half of the redaction projection-drift seam. It receives
// the content-free RedactionProjectionDriftEvent emitted by the Postgres
// transcript-projection adapter and records ONE durable, operator-only CogSec
// incident per affected session in the canonical cogsec-events.json store.
// Garden already reads that store (session-service listCogSecEvents → the
// Cognitive Security > Remediation surface), so no bespoke storage or new
// Garden read path is invented — the same decision g59z made for
// session-integrity incidents.
//
// Case type: reuses `session_integrity` (the operator-attention, agent-
// invisible class introduced by g59z) rather than widening the CogSecCaseType
// union. The condition is the same family — durable session state diverging
// from canon in a way that needs operator repair — and the deterministic
// `cogsec_projectiondrift_` caseId prefix plus the summary text distinguish it
// on the surface. Search is already fail-closed for the channel by the durable
// drift record; this incident is purely the operator signal.
//
// Content posture: the incident carries only the session identifier, a
// database error string, and a fixed operator-safe remediation summary — no
// message text ever crosses this seam.

import { createHash } from 'node:crypto';
import type { CogSecEventStore } from './events.js';
import type {
  RedactionProjectionDriftEvent,
  RedactionProjectionDriftObserver,
} from '../../shared/contracts/projection-drift.js';

export interface ProjectionDriftIncidentObserverDeps {
  /**
   * Provider (not instance): cogsec-events.json is written concurrently by the
   * gateway/Garden, so a fresh store per recording keeps the stale-clobber
   * window to the single write. Mirrors session-integrity-incident.ts.
   */
  cogSecEvents: () => Pick<CogSecEventStore, 'getEvent' | 'createEvent' | 'updateEvent'>;
}

const INCIDENT_ACTOR = 'system:transcript-projection';

/** Deterministic, dedup-stable caseId for a session's projection-drift incident. */
export function projectionDriftCaseId(channelId: string): string {
  const digest = createHash('sha256').update(channelId, 'utf8').digest('hex').slice(0, 40);
  return `cogsec_projectiondrift_${digest}`;
}

function buildSafeSummary(event: RedactionProjectionDriftEvent): string {
  // Single line, no forensic/payload detail — satisfies the CogSec safe-text
  // guard while telling the operator exactly what to do. The error string is a
  // database failure description, never message content.
  return 'A redaction failed to propagate to the transcript search projection; '
    + 'the projection may still hold content canon has redacted. Transcript search is '
    + 'fail-closed for this session until repair succeeds. '
    + 'Run `npm run session:repair:transcript-projection`. '
    + `Database error: ${event.reason}`;
}

/**
 * Builds the subscriber. Recording failures propagate to the caller (the
 * projection adapter logs them without breaking its write chain) — the seam
 * never silently drops.
 */
export function createProjectionDriftIncidentObserver(
  deps: ProjectionDriftIncidentObserverDeps,
): RedactionProjectionDriftObserver {
  return {
    recordRedactionProjectionDrift(event: RedactionProjectionDriftEvent): void {
      const caseId = projectionDriftCaseId(event.channelId);
      const store = deps.cogSecEvents();
      const safeAgentSummary = buildSafeSummary(event);

      const existing = store.getEvent(caseId);
      if (!existing) {
        store.createEvent({
          caseId,
          type: 'session_integrity',
          severity: 'high',
          status: 'open',
          sourceChannelId: event.channelId,
          affectedLogicalSessionIds: [event.channelId],
          affectedMessageRanges: [{
            sourceChannelId: event.channelId,
            logicalSessionId: event.channelId,
          }],
          actor: INCIDENT_ACTOR,
          safeAgentSummary,
        });
        return;
      }

      // Only refresh an incident the operator has not yet acted on. Once a
      // remediation is planned/applied/superseded, leave the case history
      // intact rather than resurrecting or overwriting it.
      if (existing.status !== 'open') return;

      store.updateEvent(caseId, {
        affectedLogicalSessionIds: [event.channelId],
        safeAgentSummary,
      });
    },
  };
}
