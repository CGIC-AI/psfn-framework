import { describe, expect, it } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import { createLegacyAliasTelemetryEmitter } from './legacy-alias-telemetry.js';

describe('createLegacyAliasTelemetryEmitter', () => {
  it('emits correlated legacy alias telemetry', async () => {
    const eventBus = new EventBus();
    const seen: Array<Record<string, unknown>> = [];
    eventBus.on('agent.tools.legacy_alias', (payload) => {
      seen.push(payload as unknown as Record<string, unknown>);
    });

    const emit = createLegacyAliasTelemetryEmitter(eventBus);
    expect(emit).toBeDefined();

    await runWithRequestContext({
      callType: 'tool',
      purpose: 'agent.turn.prompt',
      channelId: 'api:alias-test',
      requestId: 'req-alias-1',
      turnId: 'turn-alias-1',
      toolName: 'vault',
      toolCallId: 'call-alias-1',
    }, async () => {
      emit?.({
        toolName: 'vault',
        alias: 'vault_read',
        canonicalAction: 'read',
        migrationSurface: 'vault',
      });
    });

    expect(seen).toEqual([
      expect.objectContaining({
        toolName: 'vault',
        alias: 'vault_read',
        canonicalAction: 'read',
        migrationSurface: 'vault',
        channelId: 'api:alias-test',
        requestId: 'req-alias-1',
        turnId: 'turn-alias-1',
        callType: 'tool',
      }),
    ]);
  });
});
