import { describe, expect, it } from 'vitest';
import type {
  ModelUsageAttribution,
  ModelUsageEvent,
} from '../../../../src/shared/telemetry/model-usage.js';
import {
  filterUsageEvents,
  sortUsageEvents,
  toggleUsageEventSort,
  type UsageEventSortKey,
} from './event-grid';

const BASE_EVENT = {
  id: 'event-base',
  logicalCallId: 'call-base',
  attempt: 1,
  recordedAtMs: 100,
  startedAtMs: 90,
  status: 'success',
  settlement: 'complete',
  callKind: 'completion',
  telemetryVisibility: 'operator_visible',
  attribution: {
    companionId: 'companion-a',
    sessionId: 'session-a',
    channelId: 'channel-a',
    channelType: 'api',
    callType: 'background',
    purpose: 'summarize',
    originType: 'background',
    originStage: 'agent.turn',
    service: 'agent',
    process: 'turn-execution',
    turnId: 'turn-a',
    requestId: 'request-a',
    toolName: 'unknown',
    toolCallId: 'unknown',
    runtimeLaneClass: 'background_continuation',
    chargeLane: 'background',
    chargeSurface: 'externalModelConsult',
    chargeEventId: 'charge-event-a',
    chargeRunId: 'run-a',
    chargeRootRunId: 'root-a',
    chargeParentRunId: 'parent-a',
    shardId: 'unknown',
    subagentId: 'unknown',
    conversationId: 'conversation-a',
    rootInitiationId: 'initiation-a',
    workloadType: 'unknown',
    workloadId: 'unknown',
  },
  dayKey: '2026-07-19',
  monthKey: '2026-07',
  provider: 'openai',
  model: 'gpt-5',
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 30,
  cacheWriteTokens: 40,
  totalTokens: 100,
  providerCost: {},
  estimatedCost: {},
  effectiveCost: { total: 0.5 },
  costSource: 'provider',
  durationMs: 200,
  metadata: {},
} satisfies ModelUsageEvent;

type EventOverrides = Omit<Partial<ModelUsageEvent>, 'attribution'> & {
  attribution?: Partial<ModelUsageAttribution>;
};

function event(id: string, overrides: EventOverrides = {}): ModelUsageEvent {
  const { attribution, ...eventOverrides } = overrides;
  return {
    ...BASE_EVENT,
    ...eventOverrides,
    id,
    logicalCallId: id,
    attribution: {
      ...BASE_EVENT.attribution,
      ...attribution,
    },
  };
}

describe('usage event grid filtering', () => {
  const events = [
    event('model', { provider: 'Anthropic', model: 'Claude-Sonnet' }),
    event('attribution', {
      attribution: {
        purpose: 'Memory Consolidation',
        callType: 'tool',
        toolName: 'Journal Search',
        sessionId: 'session-midnight',
        channelId: 'discord:quiet-room',
        chargeRunId: 'charge-run-constellation',
      },
    }),
    event('failure', {
      status: 'failure',
      errorCode: 'PROVIDER_QUOTA',
      errorMessage: 'Capacity exhausted for this account',
    }),
  ];

  it.each([
    ['ANTHROPIC:claude', 'model'],
    ['memory consol', 'attribution'],
    ['too', 'attribution'],
    ['journal sea', 'attribution'],
    ['midnight', 'attribution'],
    ['quiet-room', 'attribution'],
    ['constellation', 'attribution'],
    ['quota', 'failure'],
    ['capacity exhausted', 'failure'],
  ])('matches the %s substring across searchable event fields', (query, expectedId) => {
    expect(filterUsageEvents(events, query).map(({ id }) => id)).toEqual([expectedId]);
  });
});

describe('usage event grid sorting', () => {
  it('places unknown effective costs last in both directions', () => {
    const events = [
      event('unknown', { effectiveCost: {} }),
      event('high', { effectiveCost: { total: 9 } }),
      event('low', { effectiveCost: { total: 1 } }),
    ];

    expect(sortUsageEvents(events, { key: 'effectiveCost', direction: 'asc' }).map(({ id }) => id))
      .toEqual(['low', 'high', 'unknown']);
    expect(sortUsageEvents(events, { key: 'effectiveCost', direction: 'desc' }).map(({ id }) => id))
      .toEqual(['high', 'low', 'unknown']);
  });

  it.each([
    ['when', { recordedAtMs: 1 }, { recordedAtMs: 2 }],
    ['model', { provider: 'a', model: 'alpha' }, { provider: 'b', model: 'beta' }],
    ['purpose', { attribution: { purpose: 'alpha' } }, { attribution: { purpose: 'beta' } }],
    ['tool', { attribution: { toolName: 'alpha' } }, { attribution: { toolName: 'beta' } }],
    ['inputTokens', { inputTokens: 1 }, { inputTokens: 2 }],
    ['cacheReadTokens', { cacheReadTokens: 1 }, { cacheReadTokens: 2 }],
    ['cacheWriteTokens', { cacheWriteTokens: 1 }, { cacheWriteTokens: 2 }],
    ['outputTokens', { outputTokens: 1 }, { outputTokens: 2 }],
    ['totalTokens', { totalTokens: 1 }, { totalTokens: 2 }],
    ['effectiveCost', { effectiveCost: { total: 1 } }, { effectiveCost: { total: 2 } }],
    ['duration', { durationMs: 1 }, { durationMs: 2 }],
  ] satisfies Array<[UsageEventSortKey, EventOverrides, EventOverrides]>)
  ('sorts the %s column by its string or numeric value', (key, lower, higher) => {
    const events = [event('higher', higher), event('lower', lower)];

    expect(sortUsageEvents(events, { key, direction: 'asc' }).map(({ id }) => id))
      .toEqual(['lower', 'higher']);
  });

  it('toggles direction without disturbing base order for equal values', () => {
    const events = [event('first'), event('second')];
    const descending = toggleUsageEventSort(null, 'model');
    const ascending = toggleUsageEventSort(descending, 'model');

    expect(descending).toEqual({ key: 'model', direction: 'desc' });
    expect(ascending).toEqual({ key: 'model', direction: 'asc' });
    expect(sortUsageEvents(events, descending).map(({ id }) => id)).toEqual(['first', 'second']);
    expect(sortUsageEvents(events, ascending).map(({ id }) => id)).toEqual(['first', 'second']);
  });
});
