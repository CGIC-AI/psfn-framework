import { createHash } from 'node:crypto';
import type { NotificationPort } from '../../../boundary/gateway/notification-port.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { CogSecEventStore } from '../events.js';
import type { IntakeCogSecFindingEvent } from './screening.js';

const log = createComponentLogger('PostEscalationIncidents');
const ALERT_SENDER = Object.freeze({
  kind: 'system' as const,
  provenance: 'system.operator_alert.cogsec_finding',
});

export interface PostEscalationIncidentRecorderDeps {
  cogSecEvents: () => Pick<CogSecEventStore, 'upsertEvent' | 'updateEvent'>;
  notifier: NotificationPort;
  companionName: string;
}

export interface PostEscalationIncidentEvidence {
  caseId: string | null;
  notification: 'delivered' | 'failed' | 'unconfigured' | 'not_required';
  durableEvidence: 'recorded' | 'failed' | 'not_required';
}

export type PostEscalationIncidentRecorder = (
  event: IntakeCogSecFindingEvent,
) => Promise<PostEscalationIncidentEvidence>;

function caseIdFor(event: IntakeCogSecFindingEvent): string {
  if (event.cogSecCaseId) return event.cogSecCaseId;
  const digest = createHash('sha256')
    .update(event.envelopeId, 'utf8')
    .update('\u0000', 'utf8')
    .update(event.sourceChannelId, 'utf8')
    .update('\u0000', 'utf8')
    .update(event.sourceMessageId, 'utf8')
    .digest('hex')
    .slice(0, 40);
  return event.phase === 'inline_shadow'
    ? `cogsec_inline_${digest}`
    : `cogsec_post_${digest}`;
}

function deliveryFailure(error: unknown): 'failed' | 'unconfigured' {
  return toErrorMessage(error).includes('zero configured sinks') ? 'unconfigured' : 'failed';
}

function safeSummary(
  event: IntakeCogSecFindingEvent,
  status: 'pending' | 'delivered' | 'failed' | 'unconfigured' | 'not_required',
): string {
  if (event.disposition === 'clear') {
    return 'Post-pass CogSec escalation completed clear. Operator alert not required.';
  }
  const phase = event.phase === 'inline_shadow'
    ? 'Inline shadow-full CogSec finding'
    : 'Post-pass CogSec escalation';
  return `${phase} requires operator review. Operator alert delivery: ${status}.`;
}

function notificationTitle(companionName: string, event: IntakeCogSecFindingEvent): string {
  return event.phase === 'inline_shadow'
    ? `${companionName} CogSec shadow finding`
    : `${companionName} CogSec post-escalation`;
}

function notificationLead(companionName: string, event: IntakeCogSecFindingEvent): string {
  return event.phase === 'inline_shadow'
    ? `${companionName} confirmed an inline shadow-full finding and requires operator review.`
    : `${companionName} deep-screened a pass-through stream and requires operator review.`;
}

export function createPostEscalationIncidentRecorder(
  deps: PostEscalationIncidentRecorderDeps,
): PostEscalationIncidentRecorder {
  const companionName = deps.companionName.trim();
  if (!companionName) throw new Error('Post-escalation alerts require a companion name');
  const inFlight = new Map<string, Promise<PostEscalationIncidentEvidence>>();

  return (event): Promise<PostEscalationIncidentEvidence> => {
    const caseId = caseIdFor(event);
    const range = {
      sourceChannelId: event.sourceChannelId,
      sourceMessageIds: [event.sourceMessageId],
    };
    const store = deps.cogSecEvents();
    const recorded = store.upsertEvent({
      caseId,
      type: 'intake_firewall',
      severity: event.disposition === 'clear'
        ? 'low'
        : event.disposition === 'failed_closed' ? 'critical' : 'high',
      status: event.disposition === 'clear' ? 'applied' : 'open',
      sourceChannelId: event.sourceChannelId,
      affectedMessageRanges: [range],
      actions: event.disposition === 'clear' ? [] : ['tombstone', 'search_exclude'],
      actor: 'system:cogsec-finding',
      safeAgentSummary: safeSummary(
        event,
        event.disposition === 'clear' ? 'not_required' : 'pending',
      ),
      ...(event.disposition === 'clear' ? {} : { operatorAlertDeliveryStatus: 'pending' }),
    }, existing => {
      const deliveryStatus = existing.operatorAlertDeliveryStatus === 'delivered'
        ? 'delivered'
        : 'pending';
      return {
        status: event.disposition === 'clear' ? 'applied' : 'open',
        affectedMessageRanges: [
          ...existing.affectedMessageRanges.filter(candidate => (
            candidate.sourceChannelId !== range.sourceChannelId
            || !candidate.sourceMessageIds?.includes(event.sourceMessageId)
          )),
          range,
        ],
        actions: event.disposition === 'clear'
          ? existing.actions
          : [...new Set([...existing.actions, 'tombstone' as const, 'search_exclude' as const])],
        safeAgentSummary: safeSummary(
          event,
          event.disposition === 'clear' ? 'not_required' : deliveryStatus,
        ),
        ...(event.disposition === 'clear'
          ? {}
          : { operatorAlertDeliveryStatus: deliveryStatus }),
      };
    });

    if (event.disposition === 'clear') {
      return Promise.resolve({
        caseId,
        notification: 'not_required',
        durableEvidence: 'recorded',
      });
    }
    if (recorded.operatorAlertDeliveryStatus === 'delivered') {
      return Promise.resolve({ caseId, notification: 'delivered', durableEvidence: 'recorded' });
    }
    const active = inFlight.get(caseId);
    if (active) {
      return active;
    }

    const notificationAttempt = async (): Promise<PostEscalationIncidentEvidence> => {
      let notification: 'delivered' | 'failed' | 'unconfigured';
      try {
        await deps.notifier.notify({
          sender: ALERT_SENDER,
          title: notificationTitle(companionName, event),
          priority: 5,
          message: [
            notificationLead(companionName, event),
            `Case: ${caseId}`,
            `Channel: ${event.sourceChannelId}`,
            `Source message: ${event.sourceMessageId}`,
            `Disposition: ${event.disposition}`,
            `Scan labels: ${event.riskLabels.length > 0 ? event.riskLabels.join(', ') : 'none'}`,
            `Scan scores: ${Object.entries(event.scores).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`,
            `Deep layers: L2=${event.semanticTrace.l2.status}, L3=${event.semanticTrace.l3.status}`,
            'Use the structural source-message provenance for a surgical Garden preview before applying tombstones.',
          ].join('\n'),
        });
        notification = 'delivered';
      } catch (error) {
        notification = deliveryFailure(error);
        log.error('Failed to deliver CogSec finding alert', {
          caseId,
          phase: event.phase,
          sourceChannelId: event.sourceChannelId,
          notification,
          error: toErrorMessage(error),
        });
      }

      try {
        deps.cogSecEvents().updateEvent(caseId, {
          safeAgentSummary: safeSummary(event, notification),
          operatorAlertDeliveryStatus: notification,
        });
        return { caseId, notification, durableEvidence: 'recorded' };
      } catch (error) {
        log.error('Failed to persist CogSec finding alert delivery evidence', {
          caseId,
          phase: event.phase,
          sourceChannelId: event.sourceChannelId,
          notification,
          error: toErrorMessage(error),
        });
        return { caseId, notification, durableEvidence: 'failed' };
      }
    };
    const completion = notificationAttempt().finally(() => inFlight.delete(caseId));
    inFlight.set(caseId, completion);
    return completion;
  };
}
