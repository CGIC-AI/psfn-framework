import { describe, expect, it } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import { AdminSessionTurnObservabilityStore } from './session-turn-observability.js';
import type { AdminSessionTurnData } from './types.js';
import type { TurnSnapshot } from '../../../core/turns/snapshot.js';

/**
 * Bead psfn-framework-u9jo.2: truncation honesty. These tests use live-shaped
 * fixture data (a large provider system prompt + a long history) to prove:
 *  - the snapshot flows capture → event bus → admin store → buildTurnData with
 *    NO content truncation (classifications a/b/c inventory in the store);
 *  - the ONLY subtraction in the observability path is the in-memory buffer
 *    COUNT cap (storage cap, classification b), which drops whole old events,
 *    never the content within a retained event.
 */

const LARGE_SYSTEM_PROMPT = `SYSTEM PROMPT START\n${'x'.repeat(50_000)}\nSYSTEM PROMPT END`;

function buildLiveShapedSnapshot(turnId: string, channelId: string): TurnSnapshot {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `message ${index}: ${'m'.repeat(2_000)}`,
  }));
  return {
    turnId,
    requestId: 'request-1',
    channelId,
    capturedAt: 1_000,
    trustLevel: 'regular',
    promptContext: {
      renderedStaticPrefix: '',
      renderedDynamicSuffix: '',
      runtimeContext: '',
      memoryContextBlock: '',
      scratchpadContext: '',
      assembledPrompt: LARGE_SYSTEM_PROMPT,
      finalSystemPrompt: LARGE_SYSTEM_PROMPT,
      messages,
      providerObservability: {
        routeKind: 'registered_model',
        requestedProvider: 'anthropic',
        requestedModel: 'model-x',
        backendProvider: 'anthropic',
        backendModel: 'model-x',
        backendApi: 'anthropic-messages',
        systemRole: {
          transport: 'system',
          supportsSystemRole: true,
          supportsDeveloperRole: false,
          usesOutOfBandSystemPrompt: false,
        },
        providerWireMessages: [
          { role: 'system', source: 'system_prompt', content: LARGE_SYSTEM_PROMPT },
          ...messages.map(message => ({
            role: message.role,
            source: 'message',
            content: message.content,
          })),
        ],
      },
    },
  } as TurnSnapshot;
}

function minimalRecord(turnId: string, channelId: string): AdminSessionTurnData['record'] {
  return {
    turnId,
    channelId,
    requestId: 'request-1',
    userMessage: { role: 'user', content: 'hello' },
    toolCalls: [],
    extractedMemoryIds: [],
  } as unknown as AdminSessionTurnData['record'];
}

describe('admin turn observability truncation honesty', () => {
  it('preserves provider system prompt and history byte-for-byte through the store', async () => {
    const eventBus = new EventBus();
    const store = new AdminSessionTurnObservabilityStore({ eventBus });
    const snapshot = buildLiveShapedSnapshot('turn-1', 'discord:dm:contact-1');

    await eventBus.emit('agent.turn.snapshot', { snapshot });

    const data = store.buildTurnData(minimalRecord('turn-1', 'discord:dm:contact-1'));
    const wire = data.snapshot?.promptContext?.providerObservability?.providerWireMessages ?? [];

    // Nothing shrank: system prompt + every history message survive verbatim.
    expect(wire[0]?.content).toBe(LARGE_SYSTEM_PROMPT);
    expect(wire[0]?.content.length).toBe(LARGE_SYSTEM_PROMPT.length);
    expect(wire).toHaveLength(1 + 40);
    expect(data.snapshot?.promptContext?.assembledPrompt).toBe(LARGE_SYSTEM_PROMPT);
    expect(data.snapshot?.promptContext?.messages).toHaveLength(40);
    expect(data.snapshot?.promptContext?.messages.at(-1)?.content.length).toBe(
      'message 39: '.length + 2_000,
    );

    // The exact-payload Loom view surfaces the same full provider payload.
    expect(data.promptLoom.providerPayload.finalSystemPrompt).toBe(LARGE_SYSTEM_PROMPT);
    expect(data.promptLoom.providerPayload.providerMessages).toHaveLength(1 + 40);
  });

  it('caps buffered stage events by COUNT (storage cap), not by content', async () => {
    const eventBus = new EventBus();
    const store = new AdminSessionTurnObservabilityStore({ eventBus, stageBufferLimit: 4 });

    // Emit more stage events than the buffer limit for one turn.
    for (let index = 0; index < 10; index += 1) {
      await eventBus.emit('agent.turn.stage', {
        turnId: 'turn-2',
        channelId: 'discord:guild:room-1',
        stage: `stage-${index}`,
        elapsedMs: index,
        payloadText: `full-payload-${index}-${'z'.repeat(500)}`,
      });
    }

    const data = store.buildTurnData(minimalRecord('turn-2', 'discord:guild:room-1'));

    // Only the last N events are retained (the cap drops whole old events)...
    expect(data.stages).toHaveLength(4);
    expect(data.stages.map(stage => stage.stage)).toEqual([
      'stage-6',
      'stage-7',
      'stage-8',
      'stage-9',
    ]);
    // ...and the content within each retained event is untouched.
    expect(data.stages.at(-1)?.data.payloadText).toBe(`full-payload-9-${'z'.repeat(500)}`);
  });
});
