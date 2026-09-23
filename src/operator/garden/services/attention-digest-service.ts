// ── Companion attention digest (bead psfn-framework-vcq8v.8) ──
//
// One compact, content-free answer to "what is broken on this companion right
// now", served by each companion's Garden so the fleet page can fan out across
// every companion the operator's session may reach and render a single
// cluster-wide "what's broken" view (and a login banner) without digging
// through pod logs.
//
// It invents no store. Every section is a projection of a Garden service this
// process already runs: the persisted incident timeline, the human escalation
// ledger, subsystem-lane health, the deferred post-turn action queue and
// outreach outbox, the model-usage ledger, and the ICP felt-impulse funnel.
//
// Each section is read independently and reports `unavailable` with its error
// when its backend fails or is not wired. One Postgres fault must never take
// down the whole digest, and a missing section must never read as healthy.

import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { IncidentSummary } from '../../../shared/observability/incident-alerts/contracts.js';
import type { HumanEscalationState } from '../../../shared/escalation/contracts.js';
import type { OutreachOutboxPhase } from '../../../core/intention/outreach-outbox.js';
import type { IcpFeltImpulseLifecycleOutcome } from '../../../core/icp/felt-impulse-funnel.js';
import type { AdminIncidentTimelineService } from './incident-timeline-service.js';
import type { AdminHumanEscalationService } from './human-escalation-service.js';
import type {
  AdminSubsystemHealthService,
  SubsystemLaneStatus,
} from './subsystem-health-service.js';
import type { AdminModelUsageService } from './types/runtime-telemetry.js';
import type { AdminActionPipeService } from './types/action-pipe.js';
import type { AdminIcpAutonomyService } from './types/icp-autonomy.js';

const log = createComponentLogger('AdminAttentionDigest');

/** Lane states that need an operator's attention. */
const ATTENTION_LANE_STATUSES: readonly SubsystemLaneStatus[] = ['failed', 'degraded', 'stale'];
/** Outbox phases that ended without reaching the person. */
const OUTREACH_SUPPRESSED_PHASES: readonly OutreachOutboxPhase[] = ['blocked', 'failed', 'skipped'];

type AttentionDigestSection<T> =
  | ({ state: 'ok' } & T)
  | { state: 'unavailable'; error: string };

interface AttentionDigestIncident {
  incidentId: string;
  family: IncidentSummary['family'];
  code: IncidentSummary['code'];
  severity: IncidentSummary['severity'];
  component: IncidentSummary['component'];
  ownerKind: IncidentSummary['owner']['kind'];
  openedAtMs: number;
  lastObservedAtMs: number;
  occurrenceCount: number;
}

interface AttentionDigestLane {
  id: string;
  label: string;
  status: SubsystemLaneStatus;
  lastEventAt: number | null;
  lastReason: string | null;
}

interface AttentionDigestDeferredFailure {
  actionKind: string;
  runtimeClass: string;
  reason: string;
  attempt: number;
  maxAttempts: number;
  failedAt: number;
}

interface AttentionDigestModelFailureGroup {
  runtimeLaneClass: string;
  originStage: string;
  failedCalls: number;
}

export interface CompanionAttentionDigest {
  schemaVersion: 1;
  companionId: string | null;
  generatedAt: number;
  incidents: AttentionDigestSection<{ open: AttentionDigestIncident[] }>;
  escalations: AttentionDigestSection<{ counts: Readonly<Record<HumanEscalationState, number>> }>;
  subsystems: AttentionDigestSection<{ attention: AttentionDigestLane[] }>;
  deferredActions: AttentionDigestSection<{
    /** Terminal failures since this agent process started (the queue keeps them in memory). */
    failedCount: number;
    permanentRejectCount: number;
    retryScheduledCount: number;
    recentFailures: AttentionDigestDeferredFailure[];
  }>;
  modelCalls: AttentionDigestSection<{
    range: 'today';
    totalCalls: number;
    failedCalls: number;
    /**
     * Failures by runtime class and origin. Preemptions are recorded as
     * failures and are not separately classified by the usage ledger.
     */
    failuresByClassAndOrigin: AttentionDigestModelFailureGroup[];
  }>;
  proactivity: AttentionDigestSection<{
    outreach: {
      /** Counts over the outbox's recent window, by phase. */
      byPhase: Partial<Record<OutreachOutboxPhase, number>>;
      /** Blocked/failed/skipped outreach by recorded reason code. */
      suppressedByReason: Record<string, number>;
    } | null;
    feltImpulses: {
      qualified: number;
      candidateLinks: number;
      lifecycle: Record<IcpFeltImpulseLifecycleOutcome, number>;
    } | null;
  }>;
}

export interface AdminAttentionDigestService {
  getDigest(): Promise<CompanionAttentionDigest>;
}

interface AdminAttentionDigestServiceOptions {
  companionId?: string;
  incidents?: AdminIncidentTimelineService | null;
  humanEscalations?: AdminHumanEscalationService | null;
  subsystemHealth?: AdminSubsystemHealthService | null;
  modelUsage?: AdminModelUsageService | null;
  actionPipe?: AdminActionPipeService | null;
  icpAutonomy?: AdminIcpAutonomyService | null;
  now?: () => number;
}

async function section<B, T>(
  name: string,
  backend: B | null | undefined,
  read: (backend: B) => Promise<T>,
): Promise<AttentionDigestSection<T>> {
  if (!backend) return { state: 'unavailable', error: `${name} backend is not wired in this process` };
  try {
    return { state: 'ok', ...(await read(backend)) };
  } catch (error) {
    const message = toErrorMessage(error);
    log.error('Attention digest section failed', { section: name, error: message });
    return { state: 'unavailable', error: `${name} backend unavailable: ${message}` };
  }
}

function countBy<K extends string>(values: readonly K[]): Partial<Record<K, number>> {
  const counts: Partial<Record<K, number>> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export class AdminAttentionDigestDataService implements AdminAttentionDigestService {
  constructor(private readonly options: AdminAttentionDigestServiceOptions) {}

  async getDigest(): Promise<CompanionAttentionDigest> {
    const { options } = this;
    const [incidents, escalations, subsystems, deferredActions, modelCalls, proactivity] = await Promise.all([
      section('incidents', options.incidents, async (incidents) => {
        const snapshot = await incidents.getSnapshot();
        return {
          open: snapshot.incidents
            .filter(incident => incident.status === 'open')
            .map(incident => ({
              incidentId: incident.incidentId,
              family: incident.family,
              code: incident.code,
              severity: incident.severity,
              component: incident.component,
              ownerKind: incident.owner.kind,
              openedAtMs: incident.openedAtMs,
              lastObservedAtMs: incident.lastObservedAtMs,
              occurrenceCount: incident.occurrenceCount,
            })),
        };
      }),
      // Counts only: escalation records are governed by confirmations.read and
      // stay on the escalations page; the digest shares diagnostics.read.
      section('escalations', options.humanEscalations, async (escalationsService) => {
        const snapshot = await escalationsService.getSnapshot(['open']);
        return { counts: snapshot.counts };
      }),
      section('subsystem health', options.subsystemHealth, async (subsystemHealth) => {
        const snapshot = await subsystemHealth.getSnapshot();
        return {
          attention: snapshot.lanes
            .filter(lane => ATTENTION_LANE_STATUSES.includes(lane.status))
            .map(lane => ({
              id: lane.id,
              label: lane.label,
              status: lane.status,
              lastEventAt: lane.lastEventAt,
              lastReason: lane.lastReason,
            })),
        };
      }),
      section('deferred action queue', options.actionPipe, async (actionPipe) => {
        const status = await actionPipe.getActionPipeStatus();
        return {
          failedCount: status.failures.failedCount,
          permanentRejectCount: status.failures.permanentRejectCount,
          retryScheduledCount: status.retryScheduledCount,
          // Error text is omitted: it can carry provider or content detail.
          recentFailures: status.failures.recentFailures.map(failure => ({
            actionKind: failure.actionKind,
            runtimeClass: failure.runtimeClass,
            reason: failure.reason,
            attempt: failure.attempt,
            maxAttempts: failure.maxAttempts,
            failedAt: failure.failedAt,
          })),
        };
      }),
      section('model usage', options.modelUsage, async (modelUsage) => {
        const scope = options.companionId ? { companionId: options.companionId } : {};
        const [all, failures] = await Promise.all([
          modelUsage.getModelUsageData({ range: 'today', ...scope }),
          modelUsage.getModelUsageData({
            range: 'today',
            status: 'failure',
            groupBy: ['runtimeLaneClass', 'originStage'],
            ...scope,
          }),
        ]);
        return {
          range: 'today' as const,
          totalCalls: all.totals.calls,
          failedCalls: all.totals.failedCalls,
          failuresByClassAndOrigin: failures.groups
            .filter(group => !group.isOther && group.metrics.calls > 0)
            .map(group => ({
              runtimeLaneClass: group.dimensions.runtimeLaneClass ?? 'unknown',
              originStage: group.dimensions.originStage ?? 'unknown',
              failedCalls: group.metrics.calls,
            })),
        };
      }),
      section('proactivity', options.actionPipe || options.icpAutonomy ? options : null, async ({ actionPipe, icpAutonomy }) => {
        const [pipe, icp] = await Promise.all([
          actionPipe?.getActionPipeStatus(),
          icpAutonomy?.getData(),
        ]);
        const outboxRecords = pipe?.outreachOutbox?.recentRecords;
        const funnel = icp?.feltImpulseFunnel ?? null;
        return {
          outreach: outboxRecords
            ? {
                byPhase: countBy(outboxRecords.map(record => record.phase)),
                suppressedByReason: countBy(outboxRecords
                  .filter(record => OUTREACH_SUPPRESSED_PHASES.includes(record.phase))
                  .map(record => record.reason ?? 'unspecified')) as Record<string, number>,
              }
            : null,
          feltImpulses: funnel
            ? {
                qualified: funnel.totalQualified,
                candidateLinks: funnel.candidateLinks.total,
                lifecycle: funnel.candidateLifecycle,
              }
            : null,
        };
      }),
    ]);
    return {
      schemaVersion: 1,
      companionId: options.companionId ?? null,
      generatedAt: (options.now ?? Date.now)(),
      incidents,
      escalations,
      subsystems,
      deferredActions,
      modelCalls,
      proactivity,
    };
  }
}
