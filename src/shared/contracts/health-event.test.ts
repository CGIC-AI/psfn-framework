import { describe, expect, it } from 'vitest';
import {
  createHealthEvent,
  emitHealthEvent,
  hashHealthEventSubject,
  processObserverId,
  resolveHealthEventOwner,
  validateHealthEvent,
  type HealthEvent,
  type HealthEventInput,
  type HealthEventPublisher,
} from './health-event.js';

const COMPANION_ID = '3f2b1a8c-5d4e-4c7a-9b2f-0a1c2d3e4f50';
const OBSERVED_AT_MS = 1_800_000_000_000;

function input(overrides: Partial<HealthEventInput> = {}): HealthEventInput {
  return {
    owner: { kind: 'system' },
    severity: 'degraded',
    code: 'scheduler_task_failed',
    provenance: {
      process: 'agent',
      component: 'scheduler',
      observerId: processObserverId(),
    },
    observedAtMs: OBSERVED_AT_MS,
    ...overrides,
  };
}

/** A structurally valid persisted row, for mutation in rejection cases. */
function persistedShape(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(createHealthEvent(input()) as unknown as Record<string, unknown>), ...overrides };
}

describe('health event envelope', () => {
  it('mints identity and timestamps for a single occurrence', () => {
    const event = createHealthEvent(input());
    expect(event.schemaVersion).toBe(1);
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(event.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(event.eventId).not.toBe(event.correlationId);
    expect(event.occurrenceCount).toBe(1);
    expect(event.firstObservedAtMs).toBe(OBSERVED_AT_MS);
    expect(event.lastObservedAtMs).toBe(OBSERVED_AT_MS);
    expect(event.recordedAtMs).toBe(OBSERVED_AT_MS);
    expect(event.evidence).toEqual({});
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.evidence)).toBe(true);
  });

  it('joins an existing incident through correlation and causation ids', () => {
    const cause = createHealthEvent(input());
    const effect = createHealthEvent(input({
      correlationId: cause.correlationId,
      causationId: cause.eventId,
      code: 'background_work_job_failed',
      provenance: {
        process: 'agent',
        component: 'background_work',
        observerId: processObserverId(),
      },
    }));
    expect(effect.correlationId).toBe(cause.correlationId);
    expect(effect.causationId).toBe(cause.eventId);
  });

  it('binds companion ownership to a validated routing identity', () => {
    const event = createHealthEvent(input({
      owner: { kind: 'companion', companionId: COMPANION_ID as never },
    }));
    expect(event.owner).toEqual({ kind: 'companion', companionId: COMPANION_ID });
    expect(() => createHealthEvent(input({
      owner: { kind: 'companion', companionId: 'sunny the companion' as never },
    }))).toThrow(/owner\.companionId/u);
    expect(() => createHealthEvent(input({
      owner: { kind: 'system', companionId: COMPANION_ID } as never,
    }))).toThrow(/must be absent for system-owned events/u);
  });

  it('bounds a coalesced burst with an ordered observation window', () => {
    const event = createHealthEvent(input({
      occurrenceCount: 7,
      lastObservedAtMs: OBSERVED_AT_MS + 5_000,
      recordedAtMs: OBSERVED_AT_MS + 6_000,
    }));
    expect(event.occurrenceCount).toBe(7);
    expect(event.lastObservedAtMs).toBe(OBSERVED_AT_MS + 5_000);
    expect(event.recordedAtMs).toBe(OBSERVED_AT_MS + 6_000);
    expect(() => createHealthEvent(input({ lastObservedAtMs: OBSERVED_AT_MS - 1 })))
      .toThrow(/lastObservedAtMs/u);
    expect(() => createHealthEvent(input({ occurrenceCount: 0 })))
      .toThrow(/occurrenceCount/u);
    expect(() => createHealthEvent(input({ occurrenceCount: 1.5 })))
      .toThrow(/occurrenceCount/u);
  });

  it('binds ownership from a routing identity and never guesses a companion', () => {
    expect(resolveHealthEventOwner(COMPANION_ID))
      .toEqual({ kind: 'companion', companionId: COMPANION_ID });
    // Defensive floor only: loadConfig already validates COMPANION_ID through
    // createCompanionId for the agent and gateway processes, so neither an
    // absent nor an unrecognized identity reaches an emitter in a real
    // runtime. It must still refuse to invent a tenant.
    expect(resolveHealthEventOwner(undefined)).toEqual({ kind: 'system' });
    expect(resolveHealthEventOwner('not-a-routing-identity')).toEqual({ kind: 'system' });
  });

  it('stamps one observer identity for every emitter in the process', () => {
    expect(processObserverId()).toBe(processObserverId());
    expect(processObserverId()).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('carries a runtime subject only as an opaque digest', () => {
    const digest = hashHealthEventSubject('memory_refresh');
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(digest).not.toContain('memory');
    // Same subject, same group — that is what makes repeat detection possible.
    expect(hashHealthEventSubject('  memory_refresh  ')).toBe(digest);
    expect(hashHealthEventSubject('other_kind')).not.toBe(digest);
    expect(() => hashHealthEventSubject('   ')).toThrow(/non-empty/u);
    const event = createHealthEvent(input({
      provenance: {
        process: 'agent',
        component: 'scheduler',
        observerId: processObserverId(),
        subjectHash: digest,
      },
    }));
    expect(event.provenance.subjectHash).toBe(digest);
  });
});

describe('health event content-free guarantee', () => {
  it('has no field that accepts free text', () => {
    const event = createHealthEvent(input({
      owner: { kind: 'companion', companionId: COMPANION_ID as never },
      evidence: { attemptCount: 3, terminal: true },
    }));
    // Every string the envelope can carry is either an enumerated vocabulary
    // member or a structural identifier. Nothing else is a string at all.
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(event);
    const allowed = new Set<string>([
      'companion',
      'degraded',
      'scheduler_task_failed',
      'agent',
      'scheduler',
      COMPANION_ID,
      event.eventId,
      event.correlationId,
      processObserverId(),
    ]);
    expect(strings.filter((value) => !allowed.has(value))).toEqual([]);
  });

  it('refuses a string, object, or non-finite number as evidence', () => {
    for (const value of ['boom', { nested: 1 }, [1, 2], Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createHealthEvent(input({
        evidence: { attemptCount: value } as never,
      }))).toThrow(/evidence\.attemptCount/u);
    }
  });

  it('refuses an unenumerated evidence key and an oversized evidence map', () => {
    expect(() => createHealthEvent(input({
      evidence: { errorMessage: 1 } as never,
    }))).toThrow(/evidence has unsupported key: errorMessage/u);
    const oversized: Record<string, number> = {};
    for (let index = 0; index < 17; index += 1) oversized[`attemptCount${String(index)}`] = index;
    expect(() => createHealthEvent(input({ evidence: oversized as never })))
      .toThrow(/evidence exceeds 16 entries/u);
  });

  it('refuses an unknown top-level, provenance, or owner key at the persistence boundary', () => {
    expect(() => validateHealthEvent(persistedShape({ message: 'the pool exploded' })))
      .toThrow(/event has unsupported keys: message/u);
    expect(() => validateHealthEvent(persistedShape({
      provenance: {
        process: 'agent',
        component: 'scheduler',
        observerId: processObserverId(),
        detail: 'ECONNREFUSED 192.0.2.4:5432',
      },
    }))).toThrow(/provenance has unsupported keys: detail/u);
    expect(() => validateHealthEvent(persistedShape({
      owner: { kind: 'system', label: 'primary cluster' },
    }))).toThrow(/owner has unsupported keys: label/u);
  });
});

describe('validateHealthEvent', () => {
  it('round-trips a well-formed persisted envelope', () => {
    const event = createHealthEvent(input({
      owner: { kind: 'companion', companionId: COMPANION_ID as never },
      evidence: { attemptCount: 4, jobAgeMs: 900 },
      occurrenceCount: 3,
      lastObservedAtMs: OBSERVED_AT_MS + 10,
    }));
    // JSON round-trip stands in for the persistence boundary.
    expect(validateHealthEvent(JSON.parse(JSON.stringify(event)) as unknown)).toEqual(event);
  });

  it('fails closed on every malformed structural field', () => {
    expect(() => validateHealthEvent('nope')).toThrow(/event must be an object/u);
    expect(() => validateHealthEvent(persistedShape({ schemaVersion: 2 })))
      .toThrow(/schemaVersion must be 1/u);
    expect(() => validateHealthEvent(persistedShape({ severity: 'catastrophic' })))
      .toThrow(/severity must be one of/u);
    expect(() => validateHealthEvent(persistedShape({ code: 'everything_broke' })))
      .toThrow(/code must be one of/u);
    expect(() => validateHealthEvent(persistedShape({ eventId: 'not-a-uuid' })))
      .toThrow(/eventId must be a lowercase RFC-4122 UUID/u);
    expect(() => validateHealthEvent(persistedShape({ recordedAtMs: -1 })))
      .toThrow(/recordedAtMs/u);
    expect(() => validateHealthEvent(persistedShape({
      provenance: { process: 'satellite', component: 'scheduler', observerId: processObserverId() },
    }))).toThrow(/provenance\.process must be one of/u);
    expect(() => validateHealthEvent(persistedShape({
      provenance: { process: 'agent', component: 'wiki', observerId: processObserverId() },
    }))).toThrow(/provenance\.component must be one of/u);
    expect(() => validateHealthEvent(persistedShape({
      provenance: {
        process: 'agent',
        component: 'scheduler',
        observerId: processObserverId(),
        subjectHash: 'short',
      },
    }))).toThrow(/subjectHash must be 64 lowercase hex characters/u);
  });
});

describe('emitHealthEvent', () => {
  it('publishes the envelope beside optional in-process correlation metadata', async () => {
    const published: { event: HealthEvent; sessionId?: string }[] = [];
    const publisher: HealthEventPublisher = {
      emit: async (_event, data) => {
        published.push(data);
        await Promise.resolve();
      },
    };
    await emitHealthEvent(publisher, input(), { sessionId: 'session-7', callType: 'chat', purpose: 'x' });
    expect(published).toHaveLength(1);
    expect(published[0].sessionId).toBe('session-7');
    expect(published[0].event.code).toBe('scheduler_task_failed');
  });

  it('rejects rather than throwing when the envelope is malformed', async () => {
    const publisher: HealthEventPublisher = { emit: async () => { await Promise.resolve(); } };
    await expect(emitHealthEvent(publisher, input({ observedAtMs: -1 })))
      .rejects.toThrow(/observedAtMs/u);
  });
});
