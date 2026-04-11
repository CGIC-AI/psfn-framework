import { describe, it, expect } from 'vitest';
import {
  buildAutonomousActionMemoryContext,
  inferImportedMemoryType,
  initializeImportedMemorySalience,
} from './types.js';

describe('memory import normalization policy', () => {
  it('infers type from relational text signals when explicit type is missing', () => {
    const inferred = inferImportedMemoryType({
      text: 'My partner prefers direct communication and quiet evenings.',
      tags: ['legacy-import'],
    });
    expect(inferred).toBe('relational');
  });

  it('biases salience by recency and criticality', () => {
    const now = Date.parse('2026-02-26T00:00:00.000Z');
    const staleLowPriority = initializeImportedMemorySalience({
      type: 'semantic',
      importance: 0.22,
      extractedAt: now - (420 * 24 * 60 * 60 * 1000),
      now,
    });
    const recentCritical = initializeImportedMemorySalience({
      type: 'boundary',
      importance: 0.91,
      tags: ['critical'],
      text: 'Do not disclose private details in public channels.',
      extractedAt: now - (2 * 24 * 60 * 60 * 1000),
      now,
    });

    expect(staleLowPriority).toBeLessThan(0.4);
    expect(recentCritical).toBeGreaterThan(0.85);
  });

  it('builds structured autonomous-action provenance for self-configuration writes', () => {
    const context = buildAutonomousActionMemoryContext({
      toolName: 'heartbeat_update_policy',
      action: 'update',
      reason: 'Reduce pressure from hourly reflections',
      timestampMs: Date.parse('2026-04-01T12:00:00.000Z'),
    });

    expect(context.sourceRef).toBe(
      'source:autonomous_action|tool:heartbeat_update_policy|action:update|timestamp:2026-04-01T12:00:00.000Z',
    );
    expect(context.provenanceRefs).toEqual(expect.arrayContaining([
      'source_type=autonomous_action',
      'tool=heartbeat_update_policy',
      'action=update',
      'timestamp=2026-04-01T12:00:00.000Z',
      'reason=Reduce pressure from hourly reflections',
    ]));
    expect(context.tags).toEqual(expect.arrayContaining([
      'autonomous_action',
      'self_configuration',
      'heartbeat_update_policy',
      'update',
    ]));
    expect(context.scopeRef).toEqual({
      kind: 'system',
      id: 'self-configuration',
      label: 'Self-configuration',
    });
    expect(context.scopeTags).toEqual(expect.arrayContaining([
      'autonomous_action',
      'self_configuration',
      'heartbeat_update_policy',
      'update',
    ]));
  });
});
