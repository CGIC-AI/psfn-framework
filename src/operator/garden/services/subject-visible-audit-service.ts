import { checkedEscalationReason } from '../../../boundary/fleet-auth/escalation.js';
import type { SessionManager } from '../../../core/session/manager.js';
import { readLastActiveSession } from '../../../system/lifecycle/notifications.js';
import type { FleetAuthAction } from '../../../system/config/fleet-auth-config.js';
import type { FleetGardenRequestContext } from '../garden-request-context.js';
import type { AdminAuditHistoryService } from './audit-history-service.js';

export type ProtectedConcernAction = 'resolve' | 'suppress' | 'transition' | 'resolve_stale';
export type ProtectedQuarantineAction = 'release_raw' | 'release_sanitized' | 'discard';

interface ProtectedActionCategory {
  readonly label: string;
  readonly action: FleetAuthAction;
  readonly area: FleetGardenRequestContext['resource']['area'];
  readonly routeId: string;
  readonly contentFreeSuffix: string;
}

const SUBJECT_NOTICE_SOURCE = 'garden:protected-action-audit';
const COMPANION_HOME_SESSION = 'api:companion-home';

const CONCERN_ACTION_BY_ROUTE_ID: Readonly<Record<string, ProtectedConcernAction>> = Object.freeze({
  'POST /api/admin/concerns/:concernId/resolve': 'resolve',
  'POST /api/admin/concerns/:concernId/suppress': 'suppress',
  'POST /api/admin/concerns/:concernId/transition': 'transition',
  'POST /api/admin/concerns/resolve-stale': 'resolve_stale',
});

const CONCERN_CATEGORY: ProtectedActionCategory = Object.freeze({
  label: 'Cognitive Security concern',
  action: 'cogsec.manage',
  area: 'cognitive_security',
  routeId: '',
  contentFreeSuffix: 'No protected concern content is included in this notice.',
});

const MEMORY_REVEAL_CATEGORY: ProtectedActionCategory = Object.freeze({
  label: 'high-intimacy memory body',
  action: 'memory.reveal',
  area: 'memory',
  routeId: 'POST /api/admin/memory/:id/reveal',
  contentFreeSuffix: 'No memory body content is included in this notice.',
});

const QUARANTINE_DECIDE_CATEGORY: ProtectedActionCategory = Object.freeze({
  label: 'Cognitive Security quarantine item',
  action: 'cogsec.manage',
  area: 'cognitive_security',
  routeId: 'POST /api/admin/intake/quarantine/:id/decide',
  contentFreeSuffix: 'No quarantined content or sensitive target detail is included in this notice.',
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
 * Every notice is content-free: it names the actor, time, protected category,
 * the concrete action, and the operator-stated reason, but never the memory
 * body, concern text, quarantined payload, or sensitive target parameters.
 */
export class AdminSubjectVisibleAuditService {
  constructor(private readonly options: AdminSubjectVisibleAuditServiceOptions) {}

  recordConcernAction(input: {
    context: FleetGardenRequestContext;
    action: ProtectedConcernAction;
    reason: string;
  }): void {
    const expectedRouteId = Object.entries(CONCERN_ACTION_BY_ROUTE_ID)
      .find(([, action]) => action === input.action)?.[0];
    if (!expectedRouteId) {
      throw new Error('Subject-visible CogSec concern action is not recognized');
    }
    this.recordProtectedAction({
      context: input.context,
      category: CONCERN_CATEGORY,
      expectedRouteId,
      actionLabel: input.action,
      reason: input.reason,
    });
  }

  /**
   * Records a fleet memory body reveal. The gateway has already consumed an
   * audited escalation grant bound to exactly this reveal route and memory id;
   * this notice makes that protected access companion-visible without copying
   * the body or the memory id.
   */
  recordMemoryReveal(input: {
    context: FleetGardenRequestContext;
    reason: string;
  }): void {
    this.recordProtectedAction({
      context: input.context,
      category: MEMORY_REVEAL_CATEGORY,
      expectedRouteId: MEMORY_REVEAL_CATEGORY.routeId,
      actionLabel: 'reveal',
      reason: input.reason,
    });
  }

  /**
   * Records a fleet quarantine disposition decision. The gateway has already
   * consumed an audited escalation grant bound to exactly this decide route;
   * this notice names the outcome (release raw, release sanitized, or discard)
   * without copying the held content, content hash, or sender identity.
   */
  recordIntakeQuarantineDecision(input: {
    context: FleetGardenRequestContext;
    action: ProtectedQuarantineAction;
    reason: string;
  }): void {
    this.recordProtectedAction({
      context: input.context,
      category: QUARANTINE_DECIDE_CATEGORY,
      expectedRouteId: QUARANTINE_DECIDE_CATEGORY.routeId,
      actionLabel: input.action,
      reason: input.reason,
    });
  }

  private recordProtectedAction(input: {
    context: FleetGardenRequestContext;
    category: ProtectedActionCategory;
    expectedRouteId: string;
    actionLabel: string;
    reason: string;
  }): void {
    const { context, category, expectedRouteId, actionLabel } = input;
    if (context.action !== category.action
      || context.resource.area !== category.area
      || context.actor.sessionAssurance !== 'escalated'
      || context.resource.routeId !== expectedRouteId) {
      throw new Error('Subject-visible protected action requires an exact escalated request');
    }

    const actor = context.actor.principalId.trim();
    if (!actor) {
      throw new Error('Subject-visible protected action requires an authenticated actor');
    }
    const reason = checkedEscalationReason(input.reason);
    const timestamp = this.options.now?.() ?? Date.now();
    if (!Number.isFinite(timestamp)) {
      throw new Error('Subject-visible protected action requires a valid timestamp');
    }
    const occurredAt = new Date(timestamp).toISOString();
    const narrative = `Fleet administrator ${actor} requested ${actionLabel} on protected category ${category.label}.`;
    const details = [
      `actorPrincipalId=${actor}`,
      `action=${actionLabel}`,
      `protectedCategory=${JSON.stringify(category.label)}`,
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
        + category.contentFreeSuffix,
      SUBJECT_NOTICE_SOURCE,
    );
  }
}
