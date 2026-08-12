import { describe, expect, it, vi } from 'vitest';

import type { AutomataBusEvent } from './contract.js';
import {
  PostgresAutomataBusStore,
  type AutomataBusSqlClient,
  type AutomataBusSqlPool,
  type AutomataBusSqlQueryResult,
} from './postgres-store.js';

interface StoredEventRow {
  companion_id: string;
  event_id: string;
  sequence: number;
  audiences: string[];
  sensitivity: string;
  event_json: AutomataBusEvent;
}

class TestAutomataBusPool implements AutomataBusSqlPool {
  readonly eventRows: StoredEventRow[] = [];
  readonly currentRows: StoredEventRow[] = [];
  private transactionTail = Promise.resolve();

  async connect(): Promise<AutomataBusSqlClient & { release(): void }> {
    let releaseTransaction!: () => void;
    const previousTransaction = this.transactionTail;
    this.transactionTail = new Promise(resolve => {
      releaseTransaction = resolve;
    });
    await previousTransaction;
    let released = false;
    return {
      query: async <Row>(text: string, values: unknown[] = []) => {
        const normalized = text.replaceAll(/\s+/gu, ' ').trim();
        if (normalized.startsWith('BEGIN') || normalized.startsWith('SELECT pg_advisory_xact_lock')) {
          return result<Row>();
        }
        if (normalized === 'COMMIT' || normalized === 'ROLLBACK') {
          releaseTransaction();
          return result<Row>();
        }
        return this.execute<Row>(normalized, values);
      },
      release: () => {
        if (released) throw new Error('test client released twice');
        released = true;
      },
    };
  }

  async query<Row>(text: string, values: unknown[] = []): Promise<AutomataBusSqlQueryResult<Row>> {
    return this.execute<Row>(text.replaceAll(/\s+/gu, ' ').trim(), values);
  }

  private async execute<Row>(text: string, values: unknown[]): Promise<AutomataBusSqlQueryResult<Row>> {
    if (text.includes('FROM automata_bus_events') && text.includes('event_id = $2')) {
      const [companionId, eventId] = values as [string, string];
      return result<Row>(this.eventRows.filter(row => (
        row.companion_id === companionId && row.event_id === eventId
      )) as Row[]);
    }
    if (text.includes('FROM automata_bus_events')) {
      const [companionId, audience, allowedSensitivities] = values as [string, string | undefined, string[] | undefined];
      return result<Row>(this.eventRows
        .filter(row => row.companion_id === companionId)
        .filter(row => audience === undefined || row.audiences.includes(audience))
        .filter(row => allowedSensitivities === undefined || allowedSensitivities.includes(row.sensitivity))
        .sort((left, right) => left.sequence - right.sequence) as Row[]);
    }
    if (text.startsWith('INSERT INTO automata_bus_events')) {
      const [
        companionId,
        eventId,
        sequence,
        ,
        ,
        ,
        ,
        ,
        ,
        ,
        audiences,
        sensitivity,
        eventJson,
      ] = values as [string, string, number, number, string, string, string, string, string, string | null, string[], string, AutomataBusEvent];
      if (this.eventRows.some(row => (
        row.companion_id === companionId
        && (row.event_id === eventId || row.sequence === sequence)
      ))) {
        throw new Error('test unique constraint violation');
      }
      const row = {
        companion_id: companionId,
        event_id: eventId,
        sequence,
        audiences,
        sensitivity,
        event_json: eventJson,
      };
      this.eventRows.push(row);
      return result<Row>([row as Row]);
    }
    if (text.startsWith('DELETE FROM automata_bus_current_findings')) {
      const [companionId, eventId] = values as [string, string];
      const index = this.currentRows.findIndex(row => (
        row.companion_id === companionId && row.event_id === eventId
      ));
      if (index < 0) return result<Row>();
      const [deleted] = this.currentRows.splice(index, 1);
      return result<Row>([deleted as Row]);
    }
    if (text.includes('FROM automata_bus_current_findings')) {
      const byEventIds = text.includes('event_id = ANY');
      const [companionId, eventIds, audience, allowedSensitivities] = byEventIds
        ? values as [string, string[], string, string[]]
        : [values[0], undefined, values[1], values[2]] as [string, undefined, string, string[]];
      return result<Row>(this.currentRows
        .filter(row => row.companion_id === companionId)
        .filter(row => eventIds === undefined || eventIds.includes(row.event_id))
        .filter(row => row.audiences.includes(audience))
        .filter(row => allowedSensitivities.includes(row.sensitivity))
        .sort((left, right) => left.sequence - right.sequence) as Row[]);
    }
    if (text.startsWith('INSERT INTO automata_bus_current_findings')) {
      const [companionId, eventId, sequence, audiences, sensitivity, eventJson] = values as [
        string,
        string,
        number,
        string[],
        string,
        AutomataBusEvent,
      ];
      const row = {
        companion_id: companionId,
        event_id: eventId,
        sequence,
        audiences,
        sensitivity,
        event_json: eventJson,
      };
      this.currentRows.push(row);
      return result<Row>([row as Row]);
    }
    throw new Error(`Unexpected Automata Bus SQL in test: ${text}`);
  }
}

function result<Row>(rows: Row[] = []): AutomataBusSqlQueryResult<Row> {
  return { rows, rowCount: rows.length };
}

function finding(overrides: Partial<AutomataBusEvent> = {}): AutomataBusEvent {
  return {
    schemaVersion: 1,
    eventId: 'finding-1',
    companionId: 'companion-a',
    sequence: 1,
    occurredAt: '2026-08-11T12:00:00.000Z',
    mustUnderstand: [],
    context: {
      automatonClass: 'memory-extraction',
      runId: 'run-1',
      taskId: 'task-1',
      sessionIds: ['session-1'],
      artifactRefs: ['artifact:report'],
    },
    type: 'finding',
    body: {
      claim: 'The report uses deterministic section ordering.',
      provenance: 'computed',
      evidence: [{
        kind: 'artifact',
        reference: 'artifact:report',
        summary: 'Rendered report snapshot',
      }],
      verification: { status: 'pending' },
    },
    ...overrides,
  } as AutomataBusEvent;
}

describe('PostgresAutomataBusStore', () => {
  it('authorizes only a new immutable event and preserves replay idempotency', async () => {
    const pool = new TestAutomataBusPool();
    const authorizeAppend = vi.fn(async () => undefined);
    const store = new PostgresAutomataBusStore(pool, { authorizeAppend });
    const input = {
      companionId: 'companion-a',
      event: finding(),
      audiences: ['eligible-automata'] as const,
      sensitivity: 'personal' as const,
    };

    await expect(store.append(input)).resolves.toMatchObject({ inserted: true });
    authorizeAppend.mockRejectedValueOnce(new Error('run no longer retained'));
    await expect(store.append(input)).resolves.toMatchObject({ inserted: false });

    expect(authorizeAppend).toHaveBeenCalledTimes(1);
    expect(authorizeAppend).toHaveBeenCalledWith(finding());
  });

  it('makes concurrent duplicate appends atomic and idempotent', async () => {
    const pool = new TestAutomataBusPool();
    const store = new PostgresAutomataBusStore(pool);
    const input = {
      companionId: 'companion-a',
      event: finding(),
      audiences: ['eligible-automata'] as const,
      sensitivity: 'personal' as const,
    };

    const results = await Promise.all([store.append(input), store.append(input)]);

    expect(results.map(entry => entry.inserted).sort()).toEqual([false, true]);
    await expect(store.readHistory({
      companionId: 'companion-a',
      audience: 'eligible-automata',
      maxSensitivity: 'personal',
    })).resolves.toEqual([finding()]);
  });

  it('materializes a correction chain deterministically across store restart', async () => {
    const pool = new TestAutomataBusPool();
    const store = new PostgresAutomataBusStore(pool);
    const first = finding({ eventId: 'event-finding-1' });
    const correction: AutomataBusEvent = {
      ...finding({
        eventId: 'event-correction-2',
        sequence: 2,
        occurredAt: '2026-08-11T12:01:00.000Z',
        mustUnderstand: ['finding-relations-v1'],
      }),
      type: 'relation',
      body: {
        targetEventId: 'event-finding-1',
        relation: 'corrects',
        reason: 'A route inspection contradicted the recalled path.',
        replacement: {
          claim: 'The endpoint uses the current path.',
          provenance: 'computed',
          evidence: [{
            kind: 'artifact',
            reference: 'artifact:report',
            summary: 'The registered route uses the current path.',
          }],
          verification: { status: 'pending' },
        },
      },
    };
    const supersession: AutomataBusEvent = {
      ...correction,
      eventId: 'event-supersession-3',
      sequence: 3,
      occurredAt: '2026-08-11T12:02:00.000Z',
      body: {
        targetEventId: 'event-correction-2',
        relation: 'supersedes',
        reason: 'A later execution test gives stronger evidence.',
        replacement: {
          claim: 'The endpoint uses the current path and passes its route test.',
          provenance: 'computed',
          evidence: [{
            kind: 'command',
            reference: 'artifact:report',
            summary: 'The focused route test passed.',
          }],
          verification: { status: 'pending' },
        },
      },
    };
    const visibility = {
      companionId: 'companion-a',
      audiences: ['eligible-automata'] as const,
      sensitivity: 'personal' as const,
    };
    await store.append({ ...visibility, event: first });
    await store.append({ ...visibility, event: correction });
    await store.append({ ...visibility, event: supersession });

    const restartedStore = new PostgresAutomataBusStore(pool);
    const state = await restartedStore.readCurrentState({
      companionId: 'companion-a',
      audience: 'eligible-automata',
      maxSensitivity: 'personal',
    });

    expect(state.history).toHaveLength(3);
    expect(state.effectiveFindings.map(entry => ({
      eventId: entry.eventId,
      claim: entry.body.claim,
    }))).toEqual([{
      eventId: 'event-supersession-3',
      claim: 'The endpoint uses the current path and passes its route test.',
    }]);
    expect(state.dispositions).toEqual([
      {
        targetEventId: 'event-finding-1',
        relation: 'corrects',
        byEventId: 'event-correction-2',
      },
      {
        targetEventId: 'event-correction-2',
        relation: 'supersedes',
        byEventId: 'event-supersession-3',
      },
    ]);
  });

  it('removes only the retracted finding from current state', async () => {
    const pool = new TestAutomataBusPool();
    const store = new PostgresAutomataBusStore(pool);
    const visibility = {
      companionId: 'companion-a',
      audiences: ['eligible-automata'] as const,
      sensitivity: 'personal' as const,
    };
    await store.append({ ...visibility, event: finding({ eventId: 'withdrawn-lead' }) });
    await store.append({
      ...visibility,
      event: finding({
        eventId: 'current-lead',
        sequence: 2,
        occurredAt: '2026-08-11T12:01:00.000Z',
      }),
    });
    await store.append({
      ...visibility,
      event: {
        ...finding({
          eventId: 'retraction-3',
          sequence: 3,
          occurredAt: '2026-08-11T12:02:00.000Z',
          mustUnderstand: ['finding-relations-v1'],
        }),
        type: 'relation',
        body: {
          targetEventId: 'withdrawn-lead',
          relation: 'retracts',
          reason: 'The worker withdrew the unsupported lead.',
        },
      },
    });

    const state = await store.readCurrentState({
      companionId: 'companion-a',
      audience: 'eligible-automata',
      maxSensitivity: 'personal',
    });

    expect(state.history).toHaveLength(3);
    expect(state.effectiveFindings.map(entry => entry.eventId)).toEqual(['current-lead']);
    expect(state.dispositions).toEqual([{
      targetEventId: 'withdrawn-lead',
      relation: 'retracts',
      byEventId: 'retraction-3',
    }]);
  });

  it('rejects malformed provenance and evidence before persistence', async () => {
    const pool = new TestAutomataBusPool();
    const store = new PostgresAutomataBusStore(pool);
    const malformed = {
      ...finding(),
      body: {
        claim: 'An ungrounded fetched claim.',
        provenance: 'fetched',
        evidence: [{
          kind: 'artifact',
          reference: 'artifact:report',
          summary: 'This is not external evidence.',
          unrecognized: true,
        }],
        verification: { status: 'pending' },
      },
    };

    await expect(store.append({
      companionId: 'companion-a',
      event: malformed,
      audiences: ['eligible-automata'],
      sensitivity: 'personal',
    })).rejects.toThrow(/unknown fields|require external evidence/u);
    expect(pool.eventRows).toEqual([]);
  });

  it('rejects event ID reuse with different content', async () => {
    const pool = new TestAutomataBusPool();
    const store = new PostgresAutomataBusStore(pool);
    const visibility = {
      companionId: 'companion-a',
      audiences: ['eligible-automata'] as const,
      sensitivity: 'personal' as const,
    };
    await store.append({ ...visibility, event: finding() });

    await expect(store.append({
      ...visibility,
      event: finding({
        body: {
          claim: 'Different content under the same idempotency key.',
          provenance: 'computed',
          evidence: [{
            kind: 'artifact',
            reference: 'artifact:report',
            summary: 'Rendered report snapshot',
          }],
          verification: { status: 'pending' },
        },
      } as Partial<AutomataBusEvent>),
    })).rejects.toThrow(/reused with different content/u);
    expect(pool.eventRows).toHaveLength(1);
  });

  it('filters every read by companion, audience, and sensitivity ceiling', async () => {
    const pool = new TestAutomataBusPool();
    const store = new PostgresAutomataBusStore(pool);
    await store.append({
      companionId: 'companion-a',
      event: finding({ eventId: 'automata-public' }),
      audiences: ['eligible-automata'],
      sensitivity: 'public',
    });
    await store.append({
      companionId: 'companion-a',
      event: finding({
        eventId: 'operator-personal',
        sequence: 2,
        occurredAt: '2026-08-11T12:01:00.000Z',
      }),
      audiences: ['operator'],
      sensitivity: 'personal',
    });
    await store.append({
      companionId: 'companion-a',
      event: finding({
        eventId: 'automata-confidential',
        sequence: 3,
        occurredAt: '2026-08-11T12:02:00.000Z',
      }),
      audiences: ['eligible-automata'],
      sensitivity: 'confidential',
    });
    await store.append({
      companionId: 'companion-b',
      event: finding({ companionId: 'companion-b', eventId: 'other-companion' }),
      audiences: ['eligible-automata'],
      sensitivity: 'public',
    });

    await expect(store.readHistory({
      companionId: 'companion-a',
      audience: 'eligible-automata',
      maxSensitivity: 'personal',
    })).resolves.toEqual([finding({ eventId: 'automata-public' })]);
    await expect(store.readHistory({
      companionId: 'companion-a',
      audience: 'operator',
      maxSensitivity: 'personal',
    })).resolves.toEqual([finding({
      eventId: 'operator-personal',
      sequence: 2,
      occurredAt: '2026-08-11T12:01:00.000Z',
    })]);
  });

  it('rehydrates current findings by event ID without dropping visibility metadata', async () => {
    const pool = new TestAutomataBusPool();
    const store = new PostgresAutomataBusStore(pool);
    await store.append({
      companionId: 'companion-a',
      event: finding({ eventId: 'visible-current' }),
      audiences: ['eligible-automata'],
      sensitivity: 'personal',
    });
    await store.append({
      companionId: 'companion-a',
      event: finding({
        eventId: 'operator-current',
        sequence: 2,
        occurredAt: '2026-08-11T12:01:00.000Z',
      }),
      audiences: ['operator'],
      sensitivity: 'personal',
    });

    await expect(store.readCurrentFindingsByEventIds({
      companionId: 'companion-a',
      audience: 'eligible-automata',
      maxSensitivity: 'personal',
      eventIds: ['operator-current', 'visible-current'],
    })).resolves.toEqual([{
      effectiveFinding: expect.objectContaining({ eventId: 'visible-current' }),
      audiences: ['eligible-automata'],
      sensitivity: 'personal',
    }]);
  });

  it('fails closed when persisted authority columns disagree with event JSON', async () => {
    const pool = new TestAutomataBusPool();
    pool.eventRows.push({
      companion_id: 'companion-a',
      event_id: 'finding-1',
      sequence: 1,
      audiences: ['eligible-automata'],
      sensitivity: 'personal',
      event_json: finding({ companionId: 'companion-b' }),
    });
    const store = new PostgresAutomataBusStore(pool);

    await expect(store.readHistory({
      companionId: 'companion-a',
      audience: 'eligible-automata',
      maxSensitivity: 'personal',
    })).rejects.toThrow(/authority columns disagree/u);
  });
});
