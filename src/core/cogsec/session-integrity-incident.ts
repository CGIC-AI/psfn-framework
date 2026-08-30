// ── Durable session-integrity incident subscriber (bead psfn-framework-g59z) ──
//
// The Garden-facing half of the session-integrity seam. It receives the
// content-free SessionIntegrityFailureEvent emitted by the persistence journal
// readers and records ONE durable, operator-only CogSec incident per affected
// session in the canonical cogsec-events.json store. Garden already reads that
// store (session-service listCogSecEvents → /api/admin/session-routes/cogsec/
// events → the Cognitive Security > Remediation surface), so no bespoke storage
// or new Garden read path is invented.
//
// Durable dedup / collapse: the caseId is deterministic per session, so
// repeated reads of the same broken session update the single incident
// (refreshing counts, range, and timestamp) rather than flooding the store with
// one case per read. This mirrors the render-side run-collapse semantics.
//
// Content posture: the incident carries only structural counts, an entry-id
// range, the session/channel identifier, and a fixed operator-safe summary — no
// message text ever crosses this seam.

import { createHash } from 'node:crypto';
import type { NotificationPort } from '../../boundary/gateway/notification-port.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { CogSecEventStore } from './events.js';
import type {
  SessionIntegrityFailureEvent,
  SessionIntegrityObserver,
} from '../../shared/contracts/session-integrity.js';

export interface SessionIntegrityIncidentObserverDeps {
  /**
   * Provider (not instance): cogsec-events.json is written concurrently by the
   * gateway/Garden, so a fresh store per recording keeps the stale-clobber
   * window to the single write. Mirrors the intake-quarantine service's
   * `cogSecEvents: () => new CogSecEventStore(...)` pattern.
   */
  cogSecEvents: () => Pick<CogSecEventStore, 'getEvent' | 'createEvent' | 'updateEvent'>;
  operatorAlert?: {
    notifier: NotificationPort;
    companionName: string;
  };
  now?: () => number;
}

const log = createComponentLogger('SessionIntegrityIncident');
const INCIDENT_ACTOR = 'system:session-integrity';
const INCIDENT_ALERT_SENDER = Object.freeze({
  kind: 'system' as const,
  provenance: 'system.operator_alert.session_integrity',
});

/** Deterministic, dedup-stable caseId for a session's integrity incident. */
export function sessionIntegrityCaseId(channelId: string): string {
  const digest = createHash('sha256').update(channelId, 'utf8').digest('hex').slice(0, 40);
  return `cogsec_sessionintegrity_${digest}`;
}

function buildSafeSummary(event: SessionIntegrityFailureEvent): string {
  const entries = event.failedEntryCount === 1 ? 'entry' : 'entries';
  const runs = event.contiguousRunCount === 1 ? 'run' : 'runs';
  // Single line, no forensic/payload detail — satisfies the CogSec safe-text
  // guard while telling the operator exactly what to investigate.
  return `Session integrity check failed for ${event.failedEntryCount} L0 journal ${entries} `
    + `(ids ${event.firstFailedEntryId}-${event.lastFailedEntryId}, ${event.contiguousRunCount} ${runs}). `
    + 'The stored HMAC chain no longer matches; history may have been altered or corrupted. '
    + 'Operator review recommended.';
}

/**
 * Builds the subscriber. Recording is best-effort from the reader's point of
 * view (the caller already fenced every failed entry); this factory still lets
 * a store error propagate so the caller can log it — it never silently drops.
 */
export function createSessionIntegrityIncidentObserver(
  deps: SessionIntegrityIncidentObserverDeps,
): SessionIntegrityObserver {
  const operatorAlert = deps.operatorAlert;
  const companionName = operatorAlert?.companionName.trim();
  if (operatorAlert && !companionName) {
    throw new Error('Session integrity operator alerts require a companion name');
  }
  const inFlight = new Set<string>();

  const dispatchOperatorAlert = (
    event: SessionIntegrityFailureEvent,
    caseId: string,
  ): void => {
    if (!operatorAlert || !companionName || inFlight.has(caseId)) return;
    inFlight.add(caseId);
    const completion = async (): Promise<void> => {
      let status: 'delivered' | 'failed' | 'unconfigured';
      try {
        await operatorAlert.notifier.notify({
          sender: INCIDENT_ALERT_SENDER,
          title: `${companionName} session integrity failure`,
          priority: 5,
          message: [
            `${companionName} detected a broken stored-session HMAC chain.`,
            `Case: ${caseId}`,
            `Channel: ${event.channelId}`,
            `First failed entry: ${event.firstFailedEntryId}`,
            `Last failed entry: ${event.lastFailedEntryId}`,
            `Failed entries: ${event.failedEntryCount}`,
            'Review the durable Cognitive Security incident before using the affected history.',
          ].join('\n'),
        });
        status = 'delivered';
      } catch (error) {
        status = toErrorMessage(error).includes('zero configured sinks')
          ? 'unconfigured'
          : 'failed';
        log.error('Failed to deliver session integrity operator alert', {
          caseId,
          channelId: event.channelId,
          status,
          error: toErrorMessage(error),
        });
      }

      try {
        deps.cogSecEvents().updateEvent(caseId, { operatorAlertDeliveryStatus: status });
      } catch (error) {
        log.error('Failed to persist session integrity alert delivery evidence', {
          caseId,
          channelId: event.channelId,
          status,
          error: toErrorMessage(error),
        });
      }
    };
    void completion()
      .catch((error) => {
        log.error('Unexpected session integrity alert dispatch failure', {
          caseId,
          channelId: event.channelId,
          error: toErrorMessage(error),
        });
      })
      .finally(() => inFlight.delete(caseId));
  };

  return {
    recordIntegrityFailure(event: SessionIntegrityFailureEvent): void {
      const caseId = sessionIntegrityCaseId(event.channelId);
      const store = deps.cogSecEvents();
      const affectedMessageRanges = [{
        sourceChannelId: event.channelId,
        logicalSessionId: event.channelId,
        startEntryId: event.firstFailedEntryId,
        endEntryId: event.lastFailedEntryId,
      }];
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
          affectedMessageRanges,
          actor: INCIDENT_ACTOR,
          safeAgentSummary,
          ...(operatorAlert ? { operatorAlertDeliveryStatus: 'pending' as const } : {}),
        });
        dispatchOperatorAlert(event, caseId);
        return;
      }

      // Only refresh an incident the operator has not yet acted on. Once a
      // remediation is planned/applied/superseded, leave the case history
      // intact rather than resurrecting or overwriting it.
      if (existing.status !== 'open') return;

      store.updateEvent(caseId, {
        affectedLogicalSessionIds: [event.channelId],
        affectedMessageRanges,
        safeAgentSummary,
        ...(operatorAlert && existing.operatorAlertDeliveryStatus !== 'delivered'
          ? { operatorAlertDeliveryStatus: 'pending' as const }
          : {}),
      });
      if (existing.operatorAlertDeliveryStatus !== 'delivered') {
        dispatchOperatorAlert(event, caseId);
      }
    },
  };
}
