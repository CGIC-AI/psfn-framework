import { createHash } from 'node:crypto';
import type { NotificationPort } from '../../../boundary/gateway/notification-port.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { CogSecEventStore } from '../events.js';
import type { IntakePostEscalationEvent } from './screening.js';

const log = createComponentLogger('PostEscalationIncidents');
const ALERT_SENDER = Object.freeze({
  kind: 'system' as const,
  provenance: 'system.operator_alert.cogsec_post_escalation',
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
  event: IntakePostEscalationEvent,
) => Promise<PostEscalationIncidentEvidence>;

function caseIdFor(event: IntakePostEscalationEvent): string {
  if (event.cogSecCaseId) return event.cogSecCaseId;
  const digest = createHash('sha256')
    .update(event.envelopeId, 'utf8')
    .update('\u0000', 'utf8')
    .update(event.sourceChannelId, 'utf8')
    .update('\u0000', 'utf8')
    .update(event.sourceMessageId, 'utf8')
    .digest('hex')
    .slice(0, 40);
  return `cogsec_post_${digest}`;
}

function deliveryFailure(error: unknown): 'failed' | 'unconfigured' {
  return toErrorMessage(error).includes('zero configured sinks') ? 'unconfigured' : 'failed';
}

function safeSummary(
  disposition: IntakePostEscalationEvent['disposition'],
  status: 'pending' | 'delivered' | 'failed' | 'unconfigured' | 'not_required',
): string {
  return disposition === 'clear'
    ? 'Post-pass CogSec escalation completed clear. Operator alert not required.'
    : `Post-pass CogSec escalation requires operator review. Operator alert delivery: ${status}.`;
}

export function createPostEscalationIncidentRecorder(
  deps: PostEscalationIncidentRecorderDeps,
): PostEscalationIncidentRecorder {
  const companionName = deps.companionName.trim();
  if (!companionName) throw new Error('Post-escalation alerts require a companion name');

  return async (event): Promise<PostEscalationIncidentEvidence> => {
    const caseId = caseIdFor(event);
    const range = {
      sourceChannelId: event.sourceChannelId,
      sourceMessageIds: [event.sourceMessageId],
    };
    const store = deps.cogSecEvents();
    store.upsertEvent({
      caseId,
      type: 'intake_firewall',
      severity: event.disposition === 'clear'
        ? 'low'
        : event.disposition === 'failed_closed' ? 'critical' : 'high',
      status: event.disposition === 'clear' ? 'applied' : 'open',
      sourceChannelId: event.sourceChannelId,
      affectedMessageRanges: [range],
      actions: event.disposition === 'clear' ? [] : ['tombstone', 'search_exclude'],
      actor: 'system:cogsec-post-escalation',
      safeAgentSummary: safeSummary(
        event.disposition,
        event.disposition === 'clear' ? 'not_required' : 'pending',
      ),
      ...(event.disposition === 'clear' ? {} : { operatorAlertDeliveryStatus: 'pending' }),
    }, existing => ({
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
        event.disposition,
        event.disposition === 'clear' ? 'not_required' : 'pending',
      ),
      ...(event.disposition === 'clear' ? {} : { operatorAlertDeliveryStatus: 'pending' }),
    }));

    if (event.disposition === 'clear') {
      return { caseId, notification: 'not_required', durableEvidence: 'recorded' };
    }

    let notification: 'delivered' | 'failed' | 'unconfigured';
    try {
      await deps.notifier.notify({
        sender: ALERT_SENDER,
        title: `${companionName} CogSec post-escalation`,
        priority: 5,
        message: [
          `${companionName} deep-screened a pass-through stream and requires operator review.`,
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
      log.error('Failed to deliver post-escalation CogSec alert', {
        caseId,
        sourceChannelId: event.sourceChannelId,
        notification,
        error: toErrorMessage(error),
      });
    }

    try {
      deps.cogSecEvents().updateEvent(caseId, {
        safeAgentSummary: safeSummary(event.disposition, notification),
        operatorAlertDeliveryStatus: notification,
      });
      return { caseId, notification, durableEvidence: 'recorded' };
    } catch (error) {
      log.error('Failed to persist post-escalation alert delivery evidence', {
        caseId,
        sourceChannelId: event.sourceChannelId,
        notification,
        error: toErrorMessage(error),
      });
      return { caseId, notification, durableEvidence: 'failed' };
    }
  };
}
