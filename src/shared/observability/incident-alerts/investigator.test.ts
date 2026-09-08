import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  createHealthEvent,
  hashHealthEventSubject,
  processObserverId,
  type HealthEvent,
  type HealthEventInput,
} from '../../contracts/health-event.js';
import { DEFAULT_HEALTH_DETECTORS_CONFIG } from '../../../system/config/scheduler-config/health-detectors.js';
import type { HealthEventStorePort } from '../health-event-stream.js';
import {
  createIncidentInvestigator,
  INCIDENT_INVESTIGATOR_BOUNDARY,
} from './investigator.js';

const NOW_MS = 1_800_000_000_000;
const MINUTE_MS = 60_000;
const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = hashHealthEventSubject('lane:active_context');
const CONFIG = () => DEFAULT_HEALTH_DETECTORS_CONFIG;

function event(overrides: Partial<HealthEventInput> & Pick<HealthEventInput, 'code'>): HealthEvent {
  return createHealthEvent({
    owner: { kind: 'system' },
    severity: 'critical',
    provenance: {
      process: 'agent',
      component: 'background_work',
      observerId: processObserverId(),
      subjectHash: SUBJECT,
    },
    observedAtMs: NOW_MS,
    recordedAtMs: NOW_MS,
    ...overrides,
  });
}

describe('incident investigator capability boundary', () => {
  it('declares every sandbox capability denied and no mutation authority', () => {
    expect(INCIDENT_INVESTIGATOR_BOUNDARY.kind).toBe('read_only_investigator');
    expect(INCIDENT_INVESTIGATOR_BOUNDARY.mutationAuthority).toBe(false);
    expect([...INCIDENT_INVESTIGATOR_BOUNDARY.deniedCapabilities].sort()).toEqual([
      'child_process',
      'environment',
      'filesystem',
      'global_escape',
      'module_import',
      'network',
      'process',
    ]);
    expect(Object.isFrozen(INCIDENT_INVESTIGATOR_BOUNDARY)).toBe(true);
  });

  it('cannot mutate runtime state: it touches only the stream read it was given', async () => {
    const record = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const touched: string[] = [];
    const opened = event({ code: 'background_work_failures_opened' });
    // A full store port behind a Proxy: any property the investigator reaches
    // for is recorded, and every mutating member is present and callable — so
    // the assertion below is about what the investigator DOES, not about what
    // the test made unavailable.
    const store = new Proxy({
      record,
      close,
      listRecent: async () => [opened],
    } as HealthEventStorePort, {
      get(target, property, receiver) {
        touched.push(String(property));
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const investigator = createIncidentInvestigator({
      readStream: query => store.listRecent(query),
      config: CONFIG,
      now: () => NOW_MS,
    });
    const bundle = await investigator.investigate(opened);

    expect(bundle).not.toBeNull();
    expect(touched).toEqual(['listRecent']);
    expect(record).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(bundle!.boundary).toBe(INCIDENT_INVESTIGATOR_BOUNDARY);
    expect(Object.isFrozen(bundle)).toBe(true);
  });

  it('imports no shell, filesystem, network, or persistence authority', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./investigator.ts', import.meta.url)),
      'utf8',
    );
    const imports = [...source.matchAll(/from '([^']+)'/gu)].map(match => match[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier.startsWith('node:')).toBe(false);
      expect(specifier).not.toMatch(/(^|\/)(pg|undici|node-fetch|execa)$/u);
      expect(specifier).not.toMatch(/persistence|boundary\//u);
    }
    // Nor does it reach a runtime authority through a global.
    expect(source).not.toMatch(/\b(require|fetch|globalThis|process\.env)\b/u);
  });
});

describe('incident investigator bundle', () => {
  it('carries the incident identity, evidence, and the owner-file thresholds', async () => {
    const opened = event({
      code: 'background_work_failures_opened',
      evidence: { failureCount: 4, windowMs: 3_600_000 },
    });

    const bundle = (await createIncidentInvestigator({
      readStream: async () => [opened],
      config: CONFIG,
      now: () => NOW_MS + MINUTE_MS,
    }).investigate(opened))!;

    expect(bundle.incident.incidentId).toBe(opened.correlationId);
    expect(bundle.incident.evidence).toEqual({ failureCount: 4, windowMs: 3_600_000 });
    expect(bundle.assembledAtMs).toBe(NOW_MS + MINUTE_MS);
    expect(bundle.thresholds.ownerFile).toBe('scheduler.json');
    expect(bundle.thresholds.path).toBe('healthDetectors.backgroundFailures');
    expect(bundle.thresholds.detector).toEqual(DEFAULT_HEALTH_DETECTORS_CONFIG.backgroundFailures);
    expect(bundle.thresholds.alerts).toEqual(DEFAULT_HEALTH_DETECTORS_CONFIG.incidentAlerts);
    expect(bundle.thresholds.cycle.cooldownMs).toBe(DEFAULT_HEALTH_DETECTORS_CONFIG.cooldownMs);
  });

  it('reports the standalone alert-sink incident with the cycle policy only', async () => {
    const unconfigured = createHealthEvent({
      owner: { kind: 'system' },
      severity: 'critical',
      code: 'operator_alert_sinks_unconfigured',
      provenance: {
        process: 'gateway',
        component: 'operator_alerting',
        observerId: processObserverId(),
      },
      observedAtMs: NOW_MS,
      evidence: { configuredSinkCount: 0 },
    });

    const bundle = (await createIncidentInvestigator({
      readStream: async () => [],
      config: CONFIG,
      now: () => NOW_MS,
    }).investigate(unconfigured))!;

    expect(bundle.incident.incidentId).toBe(unconfigured.correlationId);
    expect(bundle.incident.family).toBeNull();
    expect(bundle.thresholds.path).toBe('healthDetectors');
    expect(bundle.thresholds.detector).toEqual({});
  });

  it('includes the triggering event even when the persisting sink has not landed', async () => {
    const opened = event({ code: 'stuck_runtime_job_opened' });

    const bundle = (await createIncidentInvestigator({
      // The concurrent stream sink has written nothing yet.
      readStream: async () => [],
      config: CONFIG,
      now: () => NOW_MS,
    }).investigate(opened))!;

    expect(bundle.incident.statementCount).toBe(1);
    expect(bundle.incident.timeline.map(entry => entry.eventId)).toEqual([opened.eventId]);
  });

  it('fences the bundle to the incident owner so no companion evidence crosses', async () => {
    const opened = event({
      code: 'background_work_failures_opened',
      owner: { kind: 'companion', companionId: COMPANION_A },
    });
    const foreign = event({
      code: 'background_work_failures_opened',
      owner: { kind: 'companion', companionId: COMPANION_B },
      correlationId: opened.correlationId,
      recordedAtMs: NOW_MS + MINUTE_MS,
      lastObservedAtMs: NOW_MS + MINUTE_MS,
    });

    const bundle = (await createIncidentInvestigator({
      readStream: async () => [opened, foreign],
      config: CONFIG,
      now: () => NOW_MS,
    }).investigate(opened))!;

    expect(bundle.incident.owner).toEqual({ kind: 'companion', companionId: COMPANION_A });
    expect(bundle.incident.statementCount).toBe(1);
    expect(bundle.incident.timeline.map(entry => entry.eventId)).toEqual([opened.eventId]);
  });

  it('returns nothing for ordinary evidence and never reads the stream for it', async () => {
    const readStream = vi.fn(async () => []);
    const sample = event({ code: 'postgres_pool_pressure_sampled', severity: 'warning' });

    const bundle = await createIncidentInvestigator({
      readStream,
      config: CONFIG,
      now: () => NOW_MS,
    }).investigate(sample);

    expect(bundle).toBeNull();
    expect(readStream).not.toHaveBeenCalled();
  });

  it('bounds its read by the owner-file bundle limit', async () => {
    const readStream = vi.fn(async () => []);
    const opened = event({ code: 'stuck_runtime_job_opened' });

    await createIncidentInvestigator({ readStream, config: CONFIG, now: () => NOW_MS })
      .investigate(opened);

    expect(readStream).toHaveBeenCalledWith({
      correlationId: opened.correlationId,
      limit: DEFAULT_HEALTH_DETECTORS_CONFIG.incidentAlerts.bundleEventLimit,
    });
  });
});
