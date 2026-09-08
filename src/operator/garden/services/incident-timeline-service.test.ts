import { describe, expect, it, vi } from 'vitest';
import {
  createHealthEvent,
  hashHealthEventSubject,
  processObserverId,
  type HealthEvent,
  type HealthEventInput,
} from '../../../shared/contracts/health-event.js';
import {
  DEFAULT_HEALTH_DETECTORS_CONFIG,
} from '../../../system/config/scheduler-config/health-detectors.js';
import { createIncidentInvestigator } from '../../../shared/observability/incident-alerts/investigator.js';
import { AdminIncidentTimelineDataService } from './incident-timeline-service.js';

const NOW_MS = 1_800_000_000_000;
const MINUTE_MS = 60_000;
const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

function event(overrides: Partial<HealthEventInput> & Pick<HealthEventInput, 'code'>): HealthEvent {
  return createHealthEvent({
    owner: { kind: 'system' },
    severity: 'critical',
    provenance: {
      process: 'agent',
      component: 'background_work',
      observerId: processObserverId(),
      subjectHash: hashHealthEventSubject('memory_refresh:active_context'),
    },
    observedAtMs: NOW_MS,
    recordedAtMs: NOW_MS,
    ...overrides,
  });
}

function service(rows: HealthEvent[], companionId?: string): AdminIncidentTimelineDataService {
  return new AdminIncidentTimelineDataService({
    readStream: async (query) => rows.filter(row => row.recordedAtMs >= (query.sinceMs ?? 0)),
    config: () => DEFAULT_HEALTH_DETECTORS_CONFIG,
    ...(companionId === undefined ? {} : { companionId }),
    now: () => NOW_MS + MINUTE_MS,
  });
}

describe('Garden incident timeline', () => {
  it('is empty under healthy traffic', async () => {
    const snapshot = await service([
      event({ code: 'postgres_pool_pressure_sampled', severity: 'warning' }),
      event({ code: 'background_work_job_failed', severity: 'warning' }),
    ]).getSnapshot();

    expect(snapshot.incidents).toEqual([]);
    expect(snapshot.generatedAt).toBe(NOW_MS + MINUTE_MS);
    expect(snapshot.scope).toEqual({
      streams: ['companion'],
      owner: { kind: 'system' },
      process: 'agent',
      windowMs: DEFAULT_HEALTH_DETECTORS_CONFIG.incidentWindowMs,
    });
  });

  it('shows the same incident id the operator alert carried', async () => {
    const opened = event({
      code: 'background_work_failures_opened',
      evidence: { failureCount: 3, windowMs: 3_600_000 },
    });
    const rows = [opened];

    // Exactly the assembly the alert path used, over the same rows.
    const bundle = (await createIncidentInvestigator({
      readStream: async () => rows,
      config: () => DEFAULT_HEALTH_DETECTORS_CONFIG,
      now: () => NOW_MS,
    }).investigate(opened))!;
    const snapshot = await service(rows).getSnapshot();

    expect(snapshot.incidents).toHaveLength(1);
    expect(snapshot.incidents[0]!.incidentId).toBe(bundle.incident.incidentId);
    expect(snapshot.incidents[0]!.incidentId).toBe(opened.correlationId);
    expect(snapshot.incidents[0]).toEqual(bundle.incident);
  });

  it('renders the timeline, evidence, and resolution of a closed episode', async () => {
    const opened = event({ code: 'stuck_runtime_job_opened', evidence: { elapsedMs: 5_400_000 } });
    const closed = event({
      code: 'stuck_runtime_job_closed',
      severity: 'info',
      correlationId: opened.correlationId,
      causationId: opened.eventId,
      occurrenceCount: 2,
      recordedAtMs: NOW_MS + MINUTE_MS,
      lastObservedAtMs: NOW_MS + MINUTE_MS,
      evidence: { terminal: true, durationMs: MINUTE_MS },
    });

    const snapshot = await service([opened, closed]).getSnapshot();

    const incident = snapshot.incidents[0]!;
    expect(incident.status).toBe('closed');
    expect(incident.closedAtMs).toBe(NOW_MS + MINUTE_MS);
    expect(incident.evidence).toEqual({ elapsedMs: 5_400_000 });
    expect(incident.timeline.map(entry => entry.code)).toEqual([
      'stuck_runtime_job_opened',
      'stuck_runtime_job_closed',
    ]);
    expect(incident.timeline[1]!.causationId).toBe(opened.eventId);
  });

  it('never shows one companion incident under another companion', async () => {
    const mine = event({
      code: 'background_work_failures_opened',
      owner: { kind: 'companion', companionId: COMPANION_A },
    });
    const theirs = event({
      code: 'background_work_failures_opened',
      owner: { kind: 'companion', companionId: COMPANION_B },
    });
    const shared = event({
      code: 'postgres_pool_pressure_opened',
      component: 'persistence',
      owner: { kind: 'system' },
    });

    const snapshot = await service([mine, theirs, shared], COMPANION_A).getSnapshot();

    expect(snapshot.scope.owner).toEqual({ kind: 'companion', companionId: COMPANION_A });
    expect(snapshot.incidents.map(incident => incident.incidentId).sort()).toEqual(
      [mine.correlationId, shared.correlationId].sort(),
    );
  });

  it('bounds its read by the owner-file incident window and scan limit', async () => {
    const readStream = vi.fn(async () => []);
    await new AdminIncidentTimelineDataService({
      readStream,
      config: () => DEFAULT_HEALTH_DETECTORS_CONFIG,
      now: () => NOW_MS,
    }).getSnapshot();

    expect(readStream).toHaveBeenCalledWith({
      sinceMs: NOW_MS - DEFAULT_HEALTH_DETECTORS_CONFIG.incidentWindowMs,
      limit: DEFAULT_HEALTH_DETECTORS_CONFIG.incidentScanLimit,
    });
  });

  it('surfaces a stream fault instead of reporting a quiet runtime', async () => {
    const failing = new AdminIncidentTimelineDataService({
      readStream: async () => { throw new Error('health stream unavailable'); },
      config: () => DEFAULT_HEALTH_DETECTORS_CONFIG,
    });

    await expect(failing.getSnapshot()).rejects.toThrow(/health stream unavailable/u);
  });
});
