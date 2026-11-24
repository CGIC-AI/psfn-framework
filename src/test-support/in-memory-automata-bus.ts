/**
 * Test support: in-memory stand-in for the Postgres Automata Bus store and
 * production runtime surfaces the worker port calls, preserving eventId replay
 * semantics and current-findings projection.
 */
import { vi } from 'vitest';

import type { AutomataBusEvent } from '../faculties/automata/bus/contract.js';
import type { AutomataBusProductionRuntime } from '../faculties/automata/bus/production-runtime.js';
import type { PostgresAutomataBusRuntimeStore } from '../faculties/automata/bus/runtime-store.js';

export interface InMemoryAutomataBus {
  readonly events: Map<string, { event: AutomataBusEvent; audiences: string[]; sensitivity: string }>;
  readonly store: PostgresAutomataBusRuntimeStore;
  readonly runtime: AutomataBusProductionRuntime;
}

export function createInMemoryAutomataBus(): InMemoryAutomataBus {
  const events: InMemoryAutomataBus['events'] = new Map();
  const current = new Set<string>();
  const store = {
    appendAllocated: vi.fn(async (input: {
      eventId: string;
      createEvent(sequence: number): unknown;
      audiences: string[];
      sensitivity: string;
    }) => {
      const incumbent = events.get(input.eventId);
      const event = input.createEvent(incumbent?.event.sequence ?? events.size + 1) as AutomataBusEvent;
      if (incumbent) {
        if (JSON.stringify(incumbent.event) !== JSON.stringify(event)) {
          throw new Error(`Automata Bus eventId ${input.eventId} was reused with different content`);
        }
        return { event: incumbent.event, inserted: false };
      }
      if (event.type === 'relation' && !current.delete(event.body.targetEventId)) {
        throw new Error('Automata Bus current projection target was not current');
      }
      events.set(event.eventId, { event, audiences: [...input.audiences].sort(), sensitivity: input.sensitivity });
      if (event.type === 'finding' || event.body.relation !== 'retracts') current.add(event.eventId);
      return { event, inserted: true };
    }),
    readEventById: vi.fn(async (input: { eventId: string }) => events.get(input.eventId)?.event ?? null),
    readCurrentFindingsByEventIds: vi.fn(async (input: { eventIds: string[] }) => input.eventIds
      .filter(id => current.has(id))
      .map(id => events.get(id)!)
      .map(({ event, audiences, sensitivity }) => ({
        effectiveFinding: {
          eventId: event.eventId,
          companionId: event.companionId,
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          context: event.context,
          ...(event.type === 'finding'
            ? { body: event.body, sourceEventType: 'finding' }
            : { body: event.body.replacement, sourceEventType: 'relation' }),
        },
        audiences,
        sensitivity,
      }))),
  } as unknown as PostgresAutomataBusRuntimeStore;
  const runtime = {
    canonical: { getCurrentByEventIds: vi.fn(async () => []) },
    indexing: { indexCurrentFinding: vi.fn() },
    query: {
      createSpawnBriefing: vi.fn(async () => ({
        text: '',
        itemCount: 0,
        diagnostics: {
          cache: 'miss',
          semanticPath: 'exact-fallback',
          indexState: 'ready',
          reindexState: 'current',
          modelIdentity: null,
          indexingLag: { pendingCount: 0 },
        },
      })),
      search: vi.fn(async () => ({ results: [] })),
    },
  } as unknown as AutomataBusProductionRuntime;
  return { events, store, runtime };
}
