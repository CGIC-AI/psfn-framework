import { checkedEscalationReason } from '../../../boundary/fleet-auth/escalation.js';
import type { SessionManager } from '../../../core/session/manager.js';
import { readLastActiveSession } from '../../../system/lifecycle/notifications.js';
import type { FleetGardenRequestContext } from '../garden-request-context.js';
import type { AdminAuditHistoryService } from './audit-history-service.js';

export type ProtectedConcernAction = 'resolve' | 'suppress' | 'transition' | 'resolve_stale';

const PROTECTED_CATEGORY = 'Cognitive Security concern';
const SUBJECT_NOTICE_SOURCE = 'garden:protected-action-audit';
const COMPANION_HOME_SESSION = 'api:companion-home';

const CONCERN_ACTION_BY_ROUTE_ID: Readonly<Record<string, ProtectedConcernAction>> = Object.freeze({
  'POST /api/admin/concerns/:concernId/resolve': 'resolve',
  'POST /api/admin/concerns/:concernId/suppress': 'suppress',
  'POST /api/admin/concerns/:concernId/transition': 'transition',
  'POST /api/admin/concerns/resolve-stale': 'resolve_stale',
});

export interface AdminSubjectVisibleAuditServiceOptions {
  auditHistory: Pick<AdminAuditHistoryService, 'appendGardenEntry'>;
  sessionManager: Pick<SessionManager, 'appendContextSystemNote' | 'listRecentSessions'>;
  companionDataDir: string;
  now?: () => number;
}

/**
 * Records a protected Garden action in the selected companion's durable audit
 * history and conversational context without copying the protected record.
 */
export class AdminSubjectVisibleAuditService {
  constructor(private readonly options: AdminSubjectVisibleAuditServiceOptions) {}

  recordConcernAction(input: {
    context: FleetGardenRequestContext;
    action: ProtectedConcernAction;
    reason: string;
  }): void {
    const { context, action } = input;
    if (context.action !== 'cogsec.manage'
      || context.resource.area !== 'cognitive_security'
      || context.actor.sessionAssurance !== 'escalated'
      || CONCERN_ACTION_BY_ROUTE_ID[context.resource.routeId] !== action) {
      throw new Error('Subject-visible CogSec concern action requires an exact escalated request');
    }

    const actor = context.actor.principalId.trim();
    if (!actor) {
      throw new Error('Subject-visible CogSec concern action requires an authenticated actor');
    }
    const reason = checkedEscalationReason(input.reason);
    const timestamp = this.options.now?.() ?? Date.now();
    if (!Number.isFinite(timestamp)) {
      throw new Error('Subject-visible CogSec concern action requires a valid timestamp');
    }
    const occurredAt = new Date(timestamp).toISOString();
    const narrative = `Fleet administrator ${actor} requested ${action} on protected category ${PROTECTED_CATEGORY}.`;
    const details = [
      `actorPrincipalId=${actor}`,
      `action=${action}`,
      `protectedCategory=${JSON.stringify(PROTECTED_CATEGORY)}`,
      `occurredAt=${occurredAt}`,
      `reason=${JSON.stringify(reason)}`,
    ].join(' ');

    // Persist first. If the durable audit sink is unavailable, the caller must
    // refuse the protected mutation rather than create an unaudited action.
    this.options.auditHistory.appendGardenEntry({
      actionType: 'external_action',
      decision: 'allowed',
      narrative,
      details,
      actor: 'operator',
      timestamp,
    });

    const sessionId = readLastActiveSession(this.options.companionDataDir)?.sessionId
      ?? this.options.sessionManager.listRecentSessions(1).at(0)?.sessionId
      ?? COMPANION_HOME_SESSION;
    this.options.sessionManager.appendContextSystemNote(
      sessionId,
      `[System notice: protected administration] ${narrative} `
        + `Time: ${occurredAt}. Stated justification: ${JSON.stringify(reason)}. `
        + 'No protected concern content is included in this notice.',
      SUBJECT_NOTICE_SOURCE,
    );
  }
}
