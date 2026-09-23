import { describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import { AdminAttentionDigestDataService } from './attention-digest-service.js';
import type { AdminIncidentTimelineService } from './incident-timeline-service.js';
import type { AdminHumanEscalationService } from './human-escalation-service.js';
import type { AdminSubsystemHealthService } from './subsystem-health-service.js';
import type { AdminModelUsageService } from './types/runtime-telemetry.js';
import type { AdminActionPipeService } from './types/action-pipe.js';
import type { AdminIcpAutonomyService } from './types/icp-autonomy.js';
import { buildAdminAttentionDigestRoutes } from '../routes/attention-digest-routes.js';

const COMPANION_ID = '00000000-0000-4000-8000-000000000001';

function incident(incidentId: string, status: 'open' | 'closed') {
  return {
    incidentId,
    family: 'stuck_runtime_job',
    code: 'stuck_runtime_job_opened',
    status,
    owner: { kind: 'companion', companionId: COMPANION_ID },
    component: 'automata',
    process: 'agent',
    severity: 'degraded',
    openedAtMs: 10,
    lastObservedAtMs: 20,
    closedAtMs: status === 'closed' ? 30 : null,
    occurrenceCount: 3,
    statementCount: 2,
    evidence: {},
    timeline: [],
    timelineTruncated: false,
  };
}

function healthyServices() {
  const getModelUsageData = vi.fn(async (query: { status?: string }) => (query.status === 'failure'
    ? {
        totals: { calls: 4, failedCalls: 4 },
        groups: [
          { dimensions: { runtimeLaneClass: 'maintenance_reflection', originStage: 'health.probe' }, isOther: false, metrics: { calls: 3 } },
          { dimensions: { runtimeLaneClass: 'foreground_chat', originStage: 'agent.turn.prompt' }, isOther: false, metrics: { calls: 1 } },
          { dimensions: {}, isOther: true, metrics: { calls: 0 } },
        ],
      }
    : { totals: { calls: 40, failedCalls: 4 }, groups: [] }));
  return {
    getModelUsageData,
    options: {
      companionId: COMPANION_ID,
      now: () => 1_000,
      incidents: fromPartial<AdminIncidentTimelineService>({
        getSnapshot: async () => fromPartial({ incidents: [incident('open-1', 'open'), incident('closed-1', 'closed')] }),
      }),
      humanEscalations: fromPartial<AdminHumanEscalationService>({
        getSnapshot: async () => fromPartial({ counts: { open: 2, acknowledged: 1, resolved: 0, dismissed: 0 } }),
      }),
      subsystemHealth: fromPartial<AdminSubsystemHealthService>({
        getSnapshot: async () => fromPartial({
          lanes: [
            { id: 'ok-lane', label: 'OK', status: 'ok', lastEventAt: 1, lastReason: null },
            { id: 'post_turn_action_queue', label: 'Deferred action queue', status: 'failed', lastEventAt: 2, lastReason: 'queue_entries_quarantined' },
            { id: 'sleep', label: 'Sleep', status: 'stale', lastEventAt: null, lastReason: null },
          ],
        }),
      }),
      modelUsage: fromPartial<AdminModelUsageService>({ getModelUsageData }),
      actionPipe: fromPartial<AdminActionPipeService>({
        getActionPipeStatus: async () => fromPartial({
          retryScheduledCount: 1,
          failures: {
            failedCount: 5,
            permanentRejectCount: 1,
            retryableFailureCount: 0,
            recentFailures: [{
              actionId: 'a', actionKind: 'memory.sleeptime.run', dedupeKey: 'k', capability: 'x',
              runtimeClass: 'maintenance_reflection', reason: 'retry_exhausted', failedAt: 9,
              attempt: 3, maxAttempts: 3, error: 'provider said something private',
            }],
          },
          outreachOutbox: {
            recentRecords: [
              { phase: 'sent' }, { phase: 'blocked', reason: 'quiet_hours' },
              { phase: 'blocked', reason: 'quiet_hours' }, { phase: 'skipped' },
            ],
          },
        }),
      }),
      icpAutonomy: fromPartial<AdminIcpAutonomyService>({
        getData: async () => fromPartial({
          feltImpulseFunnel: {
            totalQualified: 7,
            candidateLinks: { total: 2, submitted: 2, deduped: 0 },
            candidateLifecycle: { pending: 0, permitted: 0, deferred: 1, declined: 0, rejected: 0, delivered: 1, suppressed: 0, expired: 0, cancelled: 0 },
          },
        }),
      }),
    },
  };
}

describe('AdminAttentionDigestDataService', () => {
  it('projects only what needs attention, content-free, from the existing Garden services', async () => {
    const { options, getModelUsageData } = healthyServices();
    const digest = await new AdminAttentionDigestDataService(options).getDigest();

    expect(digest).toMatchObject({
      schemaVersion: 1,
      companionId: COMPANION_ID,
      generatedAt: 1_000,
      incidents: { state: 'ok', open: [{ incidentId: 'open-1', code: 'stuck_runtime_job_opened', occurrenceCount: 3 }] },
      escalations: { state: 'ok', counts: { open: 2, acknowledged: 1 } },
      subsystems: { state: 'ok', attention: [{ id: 'post_turn_action_queue', status: 'failed' }, { id: 'sleep', status: 'stale' }] },
      deferredActions: {
        state: 'ok', failedCount: 5, permanentRejectCount: 1, retryScheduledCount: 1,
        recentFailures: [{ actionKind: 'memory.sleeptime.run', reason: 'retry_exhausted', attempt: 3 }],
      },
      modelCalls: {
        state: 'ok', range: 'today', totalCalls: 40, failedCalls: 4,
        failuresByClassAndOrigin: [
          { runtimeLaneClass: 'maintenance_reflection', originStage: 'health.probe', failedCalls: 3 },
          { runtimeLaneClass: 'foreground_chat', originStage: 'agent.turn.prompt', failedCalls: 1 },
        ],
      },
      proactivity: {
        state: 'ok',
        outreach: { byPhase: { sent: 1, blocked: 2, skipped: 1 }, suppressedByReason: { quiet_hours: 2, unspecified: 1 } },
        feltImpulses: { qualified: 7, candidateLinks: 2, lifecycle: { delivered: 1, deferred: 1 } },
      },
    });
    expect(digest.incidents.state === 'ok' && digest.incidents.open).toHaveLength(1);
    expect(JSON.stringify(digest)).not.toContain('provider said something private');
    // Scoped to this companion so a fleet-shared ledger cannot leak other companions' failures.
    expect(getModelUsageData).toHaveBeenCalledWith(expect.objectContaining({ companionId: COMPANION_ID, status: 'failure' }));
  });

  it('reports each failing or unwired backend as unavailable without hiding the others', async () => {
    const { options } = healthyServices();
    const digest = await new AdminAttentionDigestDataService({
      ...options,
      incidents: fromPartial<AdminIncidentTimelineService>({
        getSnapshot: async () => { throw new Error('health stream down'); },
      }),
      modelUsage: null,
    }).getDigest();

    expect(digest.incidents).toEqual({ state: 'unavailable', error: 'incidents backend unavailable: health stream down' });
    expect(digest.modelCalls).toEqual({ state: 'unavailable', error: 'model usage backend is not wired in this process' });
    expect(digest.escalations.state).toBe('ok');
    expect(digest.subsystems.state).toBe('ok');
  });
});

describe('buildAdminAttentionDigestRoutes', () => {
  it('answers 503 rather than a healthy-looking body when no service is composed', () => {
    const [route] = buildAdminAttentionDigestRoutes({ attentionDigest: null });
    const res = { writeHead: vi.fn(), setHeader: vi.fn(), end: vi.fn(), statusCode: 0 };
    route!.handle(fromPartial({}), fromPartial(res), fromPartial({}));
    const status = res.writeHead.mock.calls[0]?.[0] ?? res.statusCode;
    expect(status).toBe(503);
  });
});
