// ── Durable operator visibility for intake sink-gate blocks (hrmrq.77) ──
//
// Sink-gate warnings are useful runtime diagnostics, but they are not an
// operator work surface. Hard lethal-trifecta blocks are therefore mirrored
// into the canonical CogSec event store that Garden already reads. The event
// contains only structural routing facts and fixed safe text; envelope ids,
// tool arguments, and content never cross this seam.

import type { NotificationPort } from '../../../boundary/gateway/notification-port.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { CogSecEventStore } from '../events.js';
import type {
  BlockedEgressTrifectaContext,
  BlockedEgressTrifectaIncident,
  OrdinaryIntakeSinkDenial,
  OrdinaryIntakeSinkDenialEvidence,
  OrdinaryIntakeSinkDenialNotificationStatus,
  OrdinaryIntakeSinkDenialRecorder,
} from './sink-gates.js';

const log = createComponentLogger('IntakeSinkGateIncidents');
const ORDINARY_DENIAL_ALERT_SENDER = Object.freeze({
  kind: 'system' as const,
  provenance: 'system.operator_alert.intake_sink_denial',
});

export interface IntakeSinkGateIncidentRecorderDeps {
  /** Narrow provider keeps persistence construction outside the CogSec decision layer. */
  cogSecEvents: () => Pick<CogSecEventStore, 'createEvent'>;
}

export interface OrdinaryIntakeSinkDenialRecorderDeps {
  cogSecEvents: () => Pick<CogSecEventStore, 'upsertEvent' | 'updateEvent'>;
  notifier: NotificationPort;
  companionName: string;
}

function ordinaryDenialSummary(
  sink: OrdinaryIntakeSinkDenial['decision']['sink'],
  delivery: OrdinaryIntakeSinkDenialNotificationStatus | 'pending',
): string {
  return `The intake firewall denied an enforce-mode ${sink} operation. `
    + `Operator alert delivery: ${delivery}.`;
}

function notificationFailureStatus(error: unknown): Exclude<
OrdinaryIntakeSinkDenialNotificationStatus,
'delivered'
> {
  return toErrorMessage(error).includes('zero configured sinks') ? 'unconfigured' : 'failed';
}

/**
 * Records one deterministic incident per logical ordinary denial, then uses
 * the canonical system-only NotificationPort. Notification failures resolve
 * as typed evidence and update the incident with a fixed status; transport
 * errors and payload content never enter the CogSec store.
 */
export function createOrdinaryIntakeSinkDenialRecorder(
  deps: OrdinaryIntakeSinkDenialRecorderDeps,
): OrdinaryIntakeSinkDenialRecorder {
  const companionName = deps.companionName.trim();
  if (!companionName) throw new Error('Ordinary intake sink denial alerts require a companion name');
  const inFlight = new Map<string, OrdinaryIntakeSinkDenialEvidence['notification']>();

  return (denial): OrdinaryIntakeSinkDenialEvidence => {
    const { decision, context } = denial;
    if (
      decision.mode !== 'enforce'
      || decision.verdict !== 'deny'
      || decision.allowed
    ) {
      throw new Error('Ordinary intake sink incident recorder requires an enforce-mode denial');
    }

    const sourceChannelId = context.sourceChannelId ?? `intake-sink:${decision.sink}`;
    const affectedLogicalSessionIds = context.logicalSessionId
      ? [context.logicalSessionId]
      : [];
    let incident: OrdinaryIntakeSinkDenialEvidence['incident'] = 'created';
    const store = deps.cogSecEvents();
    const recorded = store.upsertEvent({
      caseId: context.correlationId,
      type: 'intake_firewall',
      severity: 'high',
      status: 'open',
      sourceChannelId,
      affectedLogicalSessionIds,
      actor: 'system:intake-sink-gate',
      safeAgentSummary: ordinaryDenialSummary(decision.sink, 'pending'),
      operatorAlertDeliveryStatus: 'pending',
    }, (_existing) => {
      incident = 'deduplicated';
      return {};
    });
    const priorDelivery = recorded.operatorAlertDeliveryStatus ?? 'pending';

    const activeNotification = inFlight.get(context.correlationId);
    if (activeNotification) {
      return { caseId: context.correlationId, incident, notification: activeNotification };
    }
    if (priorDelivery !== 'pending') {
      return {
        caseId: context.correlationId,
        incident,
        notification: Promise.resolve({ status: priorDelivery, durableEvidence: 'recorded' }),
      };
    }

    const notificationAttempt = async (): Promise<{
      status: OrdinaryIntakeSinkDenialNotificationStatus;
      durableEvidence: 'recorded' | 'failed';
    }> => {
      let status: OrdinaryIntakeSinkDenialNotificationStatus;
      try {
        await deps.notifier.notify({
          sender: ORDINARY_DENIAL_ALERT_SENDER,
          title: `${companionName} intake firewall denial`,
          priority: 5,
          message: [
            `${companionName} blocked an operation at the cognition intake firewall.`,
            `Sink: ${decision.sink}`,
            `Correlation: ${context.correlationId}`,
            `Source channel: ${context.sourceChannelId ?? 'unavailable'}`,
            `Logical session: ${context.logicalSessionId ?? 'unavailable'}`,
            `Reason: ${decision.reason}`,
          ].join('\n'),
        });
        status = 'delivered';
      } catch (error) {
        status = notificationFailureStatus(error);
        log.error('Failed to deliver ordinary intake sink denial alert', {
          caseId: context.correlationId,
          sink: decision.sink,
          status,
          error: toErrorMessage(error),
        });
      }
      try {
        deps.cogSecEvents().updateEvent(context.correlationId, {
          safeAgentSummary: ordinaryDenialSummary(decision.sink, status),
          operatorAlertDeliveryStatus: status,
        });
      } catch (error) {
        log.error('Failed to persist ordinary intake sink notification evidence', {
          caseId: context.correlationId,
          sink: decision.sink,
          status,
          error: toErrorMessage(error),
        });
        return { status, durableEvidence: 'failed' };
      }
      return { status, durableEvidence: 'recorded' };
    };
    const notification = notificationAttempt().catch((error): {
      status: OrdinaryIntakeSinkDenialNotificationStatus;
      durableEvidence: 'failed';
    } => {
      log.error('Unexpected ordinary intake sink denial alert failure', {
        caseId: context.correlationId,
        sink: decision.sink,
        error: toErrorMessage(error),
      });
      return { status: 'failed', durableEvidence: 'failed' };
    });
    inFlight.set(context.correlationId, notification);
    void notification.then(() => inFlight.delete(context.correlationId));
    return { caseId: context.correlationId, incident, notification };
  };
}

function requireContextString(
  context: BlockedEgressTrifectaContext,
  field: 'sourceChannelId' | 'logicalSessionId',
): string {
  const value = context[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Hard egress-trifecta audit is missing ${field}`);
  }
  return value.trim();
}

/**
 * Convert a blocked hard-enforcement trifecta decision into one durable,
 * operator-visible CogSec case per attempted egress. Non-blocking reviews and
 * unrelated sink decisions retain their existing audit behavior.
 */
export function createIntakeSinkGateIncidentRecorder(
  deps: IntakeSinkGateIncidentRecorderDeps,
): (incident: BlockedEgressTrifectaIncident) => void {
  return ({ assessment, context }): void => {
    if (
      assessment.verdict !== 'deny'
      || assessment.allowed
      || !assessment.triggered
      || assessment.enforcement !== 'hard'
    ) {
      return;
    }

    const sourceChannelId = requireContextString(context, 'sourceChannelId');
    const logicalSessionId = requireContextString(context, 'logicalSessionId');
    deps.cogSecEvents().createEvent({
      type: 'intake_firewall',
      severity: 'critical',
      status: 'applied',
      sourceChannelId,
      affectedLogicalSessionIds: [logicalSessionId],
      actor: 'system:intake-sink-gate',
      safeAgentSummary: 'The intake firewall blocked an outbound tool action because external content and private context met in the same path. Operator review recommended.',
    });
  };
}
