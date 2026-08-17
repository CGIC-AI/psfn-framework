import { describe, expect, it } from 'vitest';
import {
  MODEL_USAGE_RETIRED_CHARGE_SURFACE,
  MODEL_USAGE_UNKNOWN_DIMENSION,
  normalizeStoredModelUsageChargeSurface,
  normalizeModelUsageAttribution,
} from './model-usage-attribution.js';

describe('normalizeModelUsageAttribution', () => {
  it('normalizes a complete typed envelope without persisting message content', () => {
    const attribution = normalizeModelUsageAttribution({
      companionId: ' companion-alpha ',
      sessionId: 'session-1',
      channelId: 'discord:room-1',
      channelType: 'discord',
      callType: 'tool',
      purpose: 'agent.tool.continuation',
      originType: 'chat',
      originStage: 'agent.turn',
      service: 'agent',
      process: 'turn-execution',
      turnId: 'turn-1',
      requestId: 'request-1',
      toolName: 'memory',
      toolCallId: 'tool-call-1',
      runtimeLaneClass: 'background_continuation',
      chargeLane: 'interactive',
      chargeSurface: 'externalModelConsult',
      chargeEventId: 'charge-event-1',
      chargeRunId: 'run-1',
      chargeRootRunId: 'root-run-1',
      chargeParentRunId: 'parent-run-1',
      shardId: 'shard-1',
      subagentId: 'subagent-1',
      conversationId: 'conversation-1',
      rootInitiationId: 'initiation-1',
      workloadType: 'analysis',
      workloadId: 'analysis-1',
    });

    expect(attribution).toEqual({
      companionId: 'companion-alpha',
      sessionId: 'session-1',
      channelId: 'discord:room-1',
      channelType: 'discord',
      callType: 'tool',
      purpose: 'agent.tool.continuation',
      originType: 'chat',
      originStage: 'agent.turn',
      service: 'agent',
      process: 'turn-execution',
      turnId: 'turn-1',
      requestId: 'request-1',
      toolName: 'memory',
      toolCallId: 'tool-call-1',
      runtimeLaneClass: 'background_continuation',
      chargeLane: 'interactive',
      chargeSurface: 'externalModelConsult',
      chargeEventId: 'charge-event-1',
      chargeRunId: 'run-1',
      chargeRootRunId: 'root-run-1',
      chargeParentRunId: 'parent-run-1',
      shardId: 'shard-1',
      subagentId: 'subagent-1',
      conversationId: 'conversation-1',
      rootInitiationId: 'initiation-1',
      workloadType: 'analysis',
      workloadId: 'analysis-1',
    });
    expect(attribution).not.toHaveProperty('content');
    expect(attribution).not.toHaveProperty('prompt');
  });

  it('uses explicit unknowns and the canonical channel as the default session', () => {
    const attribution = normalizeModelUsageAttribution({
      channelId: 'api:room-1',
      channelType: 'api',
      callType: 'chat',
      purpose: 'chat',
    });

    expect(attribution.sessionId).toBe('api:room-1');
    expect(attribution.companionId).toBe(MODEL_USAGE_UNKNOWN_DIMENSION);
    expect(attribution.originType).toBe(MODEL_USAGE_UNKNOWN_DIMENSION);
    expect(attribution.toolName).toBe(MODEL_USAGE_UNKNOWN_DIMENSION);
    expect(attribution.runtimeLaneClass).toBe(MODEL_USAGE_UNKNOWN_DIMENSION);
    expect(attribution.chargeLane).toBe('interactive');
    expect(attribution.chargeEventId).toBe(MODEL_USAGE_UNKNOWN_DIMENSION);
    expect(attribution.conversationId).toBe(MODEL_USAGE_UNKNOWN_DIMENSION);
  });

  it('classifies session-attributed embeddings as background spend', () => {
    expect(normalizeModelUsageAttribution({
      companionId: 'companion-alpha',
      sessionId: 'session-extraction',
      callType: 'memory',
      purpose: 'embedding',
      originStage: 'embedding',
    }).chargeLane).toBe('background');
  });

  it.each([
    ['post_turn_appraisal', 'background'],
    ['background_continuation', 'background'],
    ['maintenance_reflection', 'maintenance'],
  ] as const)('maps the already-resolved runtime class %s to reporting lane %s', (
    runtimeLaneClass,
    chargeLane,
  ) => {
    expect(normalizeModelUsageAttribution({
      companionId: 'companion-alpha',
      callType: 'background',
      purpose: 'sessionless.embedding',
      runtimeLaneClass,
    }).chargeLane).toBe(chargeLane);
  });

  it('keeps a session-less foreground tool probe unknown without companion attribution', () => {
    expect(normalizeModelUsageAttribution({
      companionId: 'companion-alpha',
      callType: 'tool',
      purpose: 'reasoning',
      runtimeLaneClass: 'foreground_chat',
    }).chargeLane).toBe(MODEL_USAGE_UNKNOWN_DIMENSION);
  });

  it('never records foreground chat as unknown even without session metadata', () => {
    expect(normalizeModelUsageAttribution({
      companionId: 'companion-alpha',
      callType: 'chat',
      purpose: 'agent.turn.prompt',
    }).chargeLane).toBe('interactive');
  });

  it('does not rewrite a durable unknown lane while normalizing a stored row', () => {
    expect(normalizeModelUsageAttribution({
      companionId: 'companion-alpha',
      sessionId: 'session-a',
      callType: 'chat',
      purpose: 'agent.turn.prompt',
    }, { inferChargeLane: false }).chargeLane).toBe(MODEL_USAGE_UNKNOWN_DIMENSION);
  });

  it('keeps genuinely session-less scheduled work unknown for anomaly accounting', () => {
    const attribution = normalizeModelUsageAttribution({
      companionId: 'companion-alpha',
      channelId: 'internal:health',
      callType: 'scheduled',
      purpose: 'system.health',
      originStage: 'system.health',
    });

    expect(attribution.sessionId).toBe(MODEL_USAGE_UNKNOWN_DIMENSION);
    expect(attribution.channelId).toBe('internal:health');
    expect(attribution.chargeLane).toBe(MODEL_USAGE_UNKNOWN_DIMENSION);
  });

  it('keeps companion, gate-resolved lane, and origin stage independently attributable', () => {
    const attribution = normalizeModelUsageAttribution({
      companionId: 'companion-alpha',
      channelId: 'internal:heartbeat',
      channelType: 'api',
      callType: 'scheduled',
      purpose: 'memory',
      originStage: 'memory.sleeptime.run',
      runtimeLaneClass: 'maintenance_reflection',
    });

    expect(attribution.companionId).toBe('companion-alpha');
    expect(attribution.runtimeLaneClass).toBe('maintenance_reflection');
    expect(attribution.originStage).toBe('memory.sleeptime.run');
  });

  it.each([
    'ownerFileInspection',
    'localFilesystem',
    'localEmbedding',
    'externalEmbedding',
  ])('maps the retired historical charge surface %s into one explicit read category', (
    chargeSurface,
  ) => {
    expect(normalizeStoredModelUsageChargeSurface(chargeSurface))
      .toBe(MODEL_USAGE_RETIRED_CHARGE_SURFACE);
  });

  it('keeps the writer strict while rejecting unknown historical charge surfaces', () => {
    expect(() => normalizeModelUsageAttribution({
      callType: 'chat',
      purpose: 'chat',
      chargeSurface: 'localEmbedding',
    } as never)).toThrow('attribution.chargeSurface has unsupported value');
    expect(() => normalizeStoredModelUsageChargeSurface('inventedLegacySurface'))
      .toThrow('stored attribution.chargeSurface has unsupported value');
  });

  it.each([
    ['shard:worker-7', 'worker-7', 'unknown', 'shard', 'worker-7'],
    ['subagent:worker-8', 'unknown', 'worker-8', 'subagent', 'worker-8'],
  ])('derives bounded worker attribution from canonical channel %s', (
    channelId,
    shardId,
    subagentId,
    workloadType,
    workloadId,
  ) => {
    expect(normalizeModelUsageAttribution({
      channelId,
      channelType: 'api',
      callType: 'tool',
      purpose: 'worker.execution',
    })).toMatchObject({ shardId, subagentId, workloadType, workloadId });
  });

  it.each([
    [{ callType: 'invalid' }, 'attribution.callType has unsupported value'],
    [{ channelType: 'irc' }, 'attribution.channelType has unsupported value'],
    [{ chargeLane: 'free_money' }, 'attribution.chargeLane has unsupported value'],
    [{ runtimeLaneClass: 'daydreaming' }, 'attribution.runtimeLaneClass has unsupported value'],
    [{ companionId: '' }, 'attribution.companionId must be non-empty'],
    [{ channelId: 'discord:room\nforged' }, 'attribution.channelId must not contain control'],
    [{ workloadId: 'x'.repeat(513) }, 'attribution.workloadId must be at most 512'],
  ])('fails closed for malformed dimension %#', (overrides, message) => {
    expect(() => normalizeModelUsageAttribution({
      callType: 'chat',
      purpose: 'chat',
      ...overrides,
    } as never)).toThrow(message);
  });
});
