import { describe, expect, it } from 'vitest';
import {
  createHealthEvent,
  hashHealthEventSubject,
  processObserverId,
  type HealthEvent,
  type HealthEventInput,
} from '../../contracts/health-event.js';
import { summarizeIncident, summarizeIncidents } from './incident-view.js';
import { classifyIncidentStatement } from './contracts.js';

const NOW_MS = 1_800_000_000_000;
const MINUTE_MS = 60_000;
const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = hashHealthEventSubject('pool:runtime');
const TIMELINE_LIMIT = 50;

function event(overrides: Partial<HealthEventInput> & Pick<HealthEventInput, 'code'>): HealthEvent {
  return createHealthEvent({
    owner: { kind: 'system' },
    severity: 'critical',
    provenance: {
      process: 'gateway',
      component: 'persistence',
      observerId: processObserverId(),
      subjectHash: SUBJECT,
    },
    observedAtMs: NOW_MS,
    ...overrides,
  });
}

describe('incident projection', () => {
  it('projects an open episode with its evidence and timeline', () => {
    const opened = event({
      code: 'postgres_pool_pressure_opened',
      observedAtMs: NOW_MS,
      recordedAtMs: NOW_MS,
      evidence: { saturationPercent: 97, sampleCount: 3 },
    });
    const restated = event({
      code: 'postgres_pool_pressure_opened',
      correlationId: opened.correlationId,
      causationId: opened.eventId,
      occurrenceCount: 2,
      observedAtMs: NOW_MS,
      lastObservedAtMs: NOW_MS + 15 * MINUTE_MS,
      recordedAtMs: NOW_MS + 15 * MINUTE_MS,
      evidence: { saturationPercent: 99, durationMs: 15 * MINUTE_MS },
    });

    const incident = summarizeIncident([restated, opened], { timelineLimit: TIMELINE_LIMIT });

    expect(incident).not.toBeNull();
    expect(incident!.incidentId).toBe(opened.correlationId);
    expect(incident!.family).toBe('postgres_pool_pressure');
    expect(incident!.status).toBe('open');
    expect(incident!.closedAtMs).toBeNull();
    expect(incident!.statementCount).toBe(2);
    expect(incident!.occurrenceCount).toBe(2);
    // Evidence is the newest opening statement's, so an operator reads current
    // pressure rather than the value that first crossed the threshold.
    expect(incident!.evidence).toEqual({ saturationPercent: 99, durationMs: 15 * MINUTE_MS });
    expect(incident!.timeline.map(entry => entry.eventId)).toEqual([
      opened.eventId,
      restated.eventId,
    ]);
    expect(incident!.timeline[1]?.causationId).toBe(opened.eventId);
    expect(incident!.timelineTruncated).toBe(false);
  });

  it('closes the incident and keeps the identity the alert carried', () => {
    const opened = event({ code: 'stuck_runtime_job_opened', recordedAtMs: NOW_MS });
    const closed = event({
      code: 'stuck_runtime_job_closed',
      severity: 'info',
      correlationId: opened.correlationId,
      occurrenceCount: 2,
      observedAtMs: NOW_MS,
      lastObservedAtMs: NOW_MS + MINUTE_MS,
      recordedAtMs: NOW_MS + MINUTE_MS,
      evidence: { terminal: true, durationMs: MINUTE_MS },
    });

    const incident = summarizeIncident([opened, closed], { timelineLimit: TIMELINE_LIMIT })!;

    expect(incident.incidentId).toBe(opened.correlationId);
    expect(incident.status).toBe('closed');
    expect(incident.closedAtMs).toBe(NOW_MS + MINUTE_MS);
    // Severity is the worst the episode reached, not the info-level close.
    expect(incident.severity).toBe('critical');
  });

  it('projects nothing from evidence that never became an incident', () => {
    const sample = event({ code: 'postgres_pool_pressure_sampled', severity: 'warning' });
    const failure = event({ code: 'background_work_job_failed', severity: 'warning' });

    expect(classifyIncidentStatement(sample)).toBeNull();
    expect(summarizeIncident([sample], { timelineLimit: TIMELINE_LIMIT })).toBeNull();
    expect(summarizeIncidents([sample, failure], { timelineLimit: TIMELINE_LIMIT })).toEqual([]);
  });

  it('treats an unconfigured alert sink as an incident of its own', () => {
    const unconfigured = event({
      code: 'operator_alert_sinks_unconfigured',
      component: 'operator_alerting',
      provenance: {
        process: 'gateway',
        component: 'operator_alerting',
        observerId: processObserverId(),
      },
      evidence: { configuredSinkCount: 0 },
    } as Partial<HealthEventInput> & Pick<HealthEventInput, 'code'>);

    const incident = summarizeIncident([unconfigured], { timelineLimit: TIMELINE_LIMIT })!;

    expect(incident.incidentId).toBe(unconfigured.correlationId);
    expect(incident.family).toBeNull();
    expect(incident.status).toBe('open');
    expect(incident.evidence).toEqual({ configuredSinkCount: 0 });
  });

  it('never mixes one companion incident into another companion tenancy', () => {
    const opened = event({
      code: 'background_work_failures_opened',
      owner: { kind: 'companion', companionId: COMPANION_A },
      provenance: {
        process: 'agent',
        component: 'background_work',
        observerId: processObserverId(),
        subjectHash: SUBJECT,
      },
      recordedAtMs: NOW_MS,
    });
    const foreign = event({
      code: 'background_work_failures_opened',
      owner: { kind: 'companion', companionId: COMPANION_B },
      correlationId: opened.correlationId,
      provenance: {
        process: 'agent',
        component: 'background_work',
        observerId: processObserverId(),
        subjectHash: SUBJECT,
      },
      recordedAtMs: NOW_MS + MINUTE_MS,
    });

    const scoped = summarizeIncident([opened, foreign], {
      timelineLimit: TIMELINE_LIMIT,
      owner: { kind: 'companion', companionId: COMPANION_A },
    })!;

    expect(scoped.statementCount).toBe(1);
    expect(scoped.timeline.map(entry => entry.eventId)).toEqual([opened.eventId]);
    expect(summarizeIncident([foreign], {
      timelineLimit: TIMELINE_LIMIT,
      owner: { kind: 'system' },
    })).toBeNull();
  });

  it('bounds the timeline and says so', () => {
    const opened = event({ code: 'stuck_runtime_job_opened', recordedAtMs: NOW_MS });
    const rows = [opened, ...Array.from({ length: 4 }, (_unused, index) => event({
      code: 'stuck_runtime_job_opened',
      correlationId: opened.correlationId,
      occurrenceCount: index + 2,
      recordedAtMs: NOW_MS + (index + 1) * MINUTE_MS,
      lastObservedAtMs: NOW_MS + (index + 1) * MINUTE_MS,
    }))];

    const incident = summarizeIncident(rows, { timelineLimit: 2 })!;

    expect(incident.timeline).toHaveLength(2);
    expect(incident.timelineTruncated).toBe(true);
    // The retained rows are the newest ones: an operator wants current state.
    expect(incident.timeline[1]?.recordedAtMs).toBe(NOW_MS + 4 * MINUTE_MS);
    expect(incident.openedAtMs).toBe(NOW_MS);
  });

  it('orders many incidents by most recent activity', () => {
    const older = event({ code: 'stuck_runtime_job_opened', recordedAtMs: NOW_MS });
    const newer = event({
      code: 'background_work_failures_opened',
      component: 'background_work',
      recordedAtMs: NOW_MS + MINUTE_MS,
      lastObservedAtMs: NOW_MS + MINUTE_MS,
      observedAtMs: NOW_MS + MINUTE_MS,
    });

    const incidents = summarizeIncidents([older, newer], { timelineLimit: TIMELINE_LIMIT });

    expect(incidents.map(incident => incident.incidentId)).toEqual([
      newer.correlationId,
      older.correlationId,
    ]);
  });

  it('refuses a non-positive timeline bound rather than reading unbounded', () => {
    const opened = event({ code: 'stuck_runtime_job_opened' });
    expect(() => summarizeIncident([opened], { timelineLimit: 0 })).toThrow(/positive integer/u);
  });
});
