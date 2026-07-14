import { describe, expect, it } from 'vitest';
import type { ModelUsageExportData } from '../../../shared/telemetry/model-usage.js';
import { serializeModelUsageExport } from './model-usage-export.js';

const fixture: ModelUsageExportData = {
  query: { range: 'custom', sinceMs: 1, untilMs: 2, provider: '=formula' },
  resolvedRange: {
    range: 'custom', timezone: 'UTC', sinceMs: 1, untilMs: 2, bucket: 'hour',
    boundary: '[sinceMs, untilMs)', calendarWeekStartsOn: 'monday',
  },
  rows: [{
    id: 'event-1', logicalCallId: 'logical-1', attempt: 0, recordedAtMs: 1,
    status: 'success', callKind: 'chat',
    attribution: {
      companionId: 'companion-a', sessionId: 'session-a', channelId: '=cmd', channelType: 'api',
      callType: 'chat', purpose: 'test', originType: 'chat', originStage: 'turn', service: 'agent',
      process: 'agent', turnId: 'turn-a', requestId: 'request-a', toolName: 'unknown',
      toolCallId: 'unknown', chargeLane: 'interactive', chargeSurface: 'externalModelConsult',
      chargeRunId: 'run-a', chargeRootRunId: 'run-a', chargeParentRunId: 'unknown', shardId: 'unknown',
      subagentId: 'unknown', conversationId: 'conversation-a', rootInitiationId: 'root-a',
      workloadType: 'interactive', workloadId: 'turn-a',
    },
    provider: '=formula', model: 'model-a', inputTokens: 1, cacheReadTokens: 2,
    cacheWriteTokens: 3, outputTokens: 4, totalTokens: 10,
    providerCost: { total: 0.1 }, estimatedCost: {}, effectiveCost: { total: 0.1 },
    costSource: 'provider', durationMs: 5, ttftMs: 2,
  }],
};

describe('serializeModelUsageExport', () => {
  it('serializes content-free JSON from the canonical filtered export', () => {
    const result = serializeModelUsageExport(fixture, 'json');
    expect(result.contentType).toBe('application/json; charset=utf-8');
    expect(JSON.parse(result.body)).toEqual(fixture);
    expect(result.body).not.toContain('metadata');
    expect(result.body).not.toContain('errorMessage');
  });

  it('serializes stable RFC 4180 CSV and neutralizes spreadsheet formulas', () => {
    const result = serializeModelUsageExport(fixture, 'csv');
    const lines = result.body.trimEnd().split('\r\n');
    expect(result.contentType).toBe('text/csv; charset=utf-8');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('cacheReadTokens');
    expect(lines[0]).toContain('effectiveCacheWriteCostUsd');
    expect(lines[1]).toContain("'=formula");
    expect(lines[1]).toContain("'=cmd");
  });
});
