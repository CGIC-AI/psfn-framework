import { describe, expect, it, vi } from 'vitest';

import type {
  AutomataRunRecord,
  EffectiveAutomataClassDescriptor,
} from '../registry-contract.js';
import type { AutomataBusEvent } from './contract.js';
import {
  AUTOMATA_BUS_POSTGRES_READINESS_REQUIREMENTS,
  PostgresAutomataBusRuntimeStore,
  assertAutomataBusEventAuthorized,
  assertAutomataBusPostgresReady,
  type AutomataBusRunAuthority,
  type AutomataBusRuntimePool,
} from './runtime-store.js';

function event(overrides: Partial<AutomataBusEvent> = {}): AutomataBusEvent {
  return {
    schemaVersion: 1,
    eventId: 'event-1',
    companionId: 'companion-a',
    sequence: 1,
    occurredAt: '2026-08-11T12:00:00.000Z',
    mustUnderstand: [],
    context: {
      automatonClass: 'memory.extraction',
      runId: 'run-1',
      taskId: 'task-1',
      sessionIds: [],
      artifactRefs: [],
    },
    type: 'finding',
    body: {
      claim: 'The focused test passed.',
      provenance: 'computed',
      evidence: [{
        kind: 'command',
        reference: 'test:focused',
        summary: 'Focused test result.',
      }],
      verification: { status: 'verified', by: 'test-runner' },
    },
    ...overrides,
  } as AutomataBusEvent;
}

function run(overrides: Partial<AutomataRunRecord> = {}): AutomataRunRecord {
  return {
    companionId: 'companion-a',
    runId: 'run-1',
    automatonClass: 'memory.extraction',
    workerId: 'worker-1',
    workerGeneration: 1,
    taskId: 'task-1',
    taskLabel: 'Task',
    taskSummary: 'Task summary',
    sessionIds: [],
    artifacts: [],
    status: 'running',
    statusReason: 'started',
    promotionState: 'not_requested',
    foldState: 'not_required',
    createdAtMs: 1,
    startedAtMs: 2,
    retentionDeadlineMs: 10_000,
    ...overrides,
  };
}

function authority(input: {
  record?: AutomataRunRecord | null;
  eligibility?: 'eligible' | 'excluded';
} = {}): AutomataBusRunAuthority {
  const record = input.record === undefined ? run() : input.record;
  const descriptor = {
    id: 'memory.extraction',
    workerKind: 'background',
    trigger: 'background-work:memory_extraction',
    promptPolicy: 'inherited_identity_bus_task',
    chargeClass: 'background',
    concurrencyClass: 'background_session',
    failureClass: 'lease_retry',
    retentionClass: 'standard',
    retentionMs: 1_000,
    busEligibility: input.eligibility ?? 'eligible',
  } satisfies EffectiveAutomataClassDescriptor;
  return {
    getRun: runId => runId === 'run-1' ? record : null,
    listClasses: () => [descriptor],
  };
}

describe('Automata Bus production runtime store', () => {
  it('binds new events to an eligible companion-scoped registry run', () => {
    expect(() => assertAutomataBusEventAuthorized(event(), 'companion-a', authority()))
      .not.toThrow();
    expect(() => assertAutomataBusEventAuthorized(
      event({ context: { ...event().context, runId: 'unknown' } }),
      'companion-a',
      authority(),
    )).toThrow(/registered Automata run/u);
    expect(() => assertAutomataBusEventAuthorized(event(), 'companion-a', authority({
      eligibility: 'excluded',
    }))).toThrow(/not eligible/u);
    expect(() => assertAutomataBusEventAuthorized(event(), 'companion-a', authority({
      record: run({ taskId: 'other-task' }),
    }))).toThrow(/taskId/u);
  });

  it('fails readiness closed unless both relations and immutable triggers are usable', async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes('to_regclass')) {
        return {
          rows: AUTOMATA_BUS_POSTGRES_READINESS_REQUIREMENTS.relations.map(relation => ({
            relation_name: relation,
            relation,
            can_select: true,
            can_insert: true,
            can_delete: relation === 'automata_bus_current_findings',
          })),
          rowCount: 2,
        };
      }
      return {
        rows: AUTOMATA_BUS_POSTGRES_READINESS_REQUIREMENTS.immutableEventTriggers.map(
          trigger => ({ trigger_name: trigger }),
        ),
        rowCount: 2,
      };
    });
    const end = vi.fn(async () => undefined);
    const pool = {
      query,
      connect: vi.fn(),
      end,
    } satisfies AutomataBusRuntimePool;

    await expect(assertAutomataBusPostgresReady(pool)).resolves.toBeUndefined();
    const store = new PostgresAutomataBusRuntimeStore(pool, 'companion-a', authority());
    expect(store.getQueryPool()).toBe(pool);
    await expect(store.readHistory({
      companionId: 'companion-b',
      audience: 'operator',
      maxSensitivity: 'confidential',
    })).rejects.toThrow(/companion scope mismatch/u);
    await store.close();
    await store.close();
    expect(end).toHaveBeenCalledTimes(1);
  });
});
