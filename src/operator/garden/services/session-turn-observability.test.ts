import { describe, expect, it } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import { AdminSessionTurnObservabilityStore } from './session-turn-observability.js';
import type { AdminSessionTurnData } from './types.js';
import type { TurnSnapshot } from '../../../core/turns/snapshot.js';
import {
  createPromptPlan,
  createPromptPlanBlock,
  DATETIME_ANCHOR_BLOCK_ID,
  serializePromptPlanForProvider,
  type PromptPlan,
} from '../../../core/agent/substrate-agent/turn-execution/prompt-plan.js';
import { createDmConversationScope } from '../../../core/session/conversation-scope.js';

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

function buildLiveShapedPlan(): PromptPlan {
  const blocks = [
    createPromptPlanBlock({
      id: 'static_prefix',
      layer: 'prompt_stack',
      volatility: 'static',
      producer: 'prompt-composer.static-prefix',
      scopeKey: 'global',
      renderedText: `STATIC PREFIX START\n${'static prefix identity line.\n'.repeat(700)}STATIC PREFIX END`,
    }),
    createPromptPlanBlock({
      id: 'core_memory',
      layer: 'runtime',
      volatility: 'session_stable',
      producer: 'core-memory.blocks',
      scopeKey: 'dm:contact-1',
      renderedText: '<core_memory>persona + human blocks</core_memory>',
    }),
    createPromptPlanBlock({
      id: 'runtime.context',
      layer: 'runtime',
      volatility: 'turn',
      producer: 'runtime-context.builder',
      scopeKey: 'dm:contact-1',
      renderedText: '<runtime_context>turn-volatile state</runtime_context>',
    }),
    createPromptPlanBlock({
      id: 'memory.retrieval',
      layer: 'runtime',
      volatility: 'turn',
      producer: 'memory.retrieval',
      scopeKey: 'dm:contact-1',
      renderedText: '<memory_context>retrieved memories</memory_context>',
    }),
    createPromptPlanBlock({
      id: DATETIME_ANCHOR_BLOCK_ID,
      layer: 'provider',
      volatility: 'turn',
      producer: 'runtime-context.current-datetime',
      scopeKey: 'global',
      renderedText: '<runtime.current_datetime authority="canonical" overrides="memory,conversation_history,continuity_anchor,wake_orientation,cross_channel_continuity">\n<iso>2026-07-01T12:00:00-04:00</iso>\n</runtime.current_datetime>',
    }),
  ];
  return createPromptPlan({
    blocks,
    variables: { runtime_current_datetime_iso: '2026-07-01T12:00:00-04:00' },
    messages: [
      { role: 'user', content: `history user: ${'long user history line. '.repeat(120)}` },
      { role: 'assistant', content: `history assistant: ${'long assistant history line. '.repeat(120)}` },
      { role: 'user', content: 'current turn input' },
    ],
    toolDefinitions: [
      {
        name: 'memory_search',
        description: 'Search stored memories.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    ],
    scope: createDmConversationScope({
      channelId: 'discord:dm:contact-1',
      contact: { contactId: 'contact-1', displayName: 'Contact One' },
    }),
  });
}

function buildPlanBackedSnapshot(turnId: string, channelId: string): TurnSnapshot {
  const plan = buildLiveShapedPlan();
  const payload = serializePromptPlanForProvider(plan, 'anthropic_system');
  return {
    turnId,
    requestId: 'request-1',
    channelId,
    capturedAt: 2_000,
    trustLevel: 'regular',
    plan,
    promptContext: {
      providerObservability: {
        routeKind: 'registered_model',
        requestedProvider: 'anthropic',
        requestedModel: 'model-x',
        backendProvider: 'anthropic',
        backendModel: 'model-x',
        backendApi: 'anthropic-messages',
        systemRole: {
          transport: 'anthropic_system',
          supportsSystemRole: true,
          supportsDeveloperRole: false,
          usesOutOfBandSystemPrompt: false,
        },
        promptCaching: { configured: false, engaged: false },
        providerWireMessages: payload.providerWireMessages,
      },
    },
  } as TurnSnapshot;
}

describe('promptLoom renders the PromptPlan (E2.3)', () => {
  it('serves the schema-versioned plan itself with full block provenance', async () => {
    const eventBus = new EventBus();
    const store = new AdminSessionTurnObservabilityStore({ eventBus });
    const snapshot = buildPlanBackedSnapshot('turn-plan-1', 'discord:dm:contact-1');

    await eventBus.emit('agent.turn.snapshot', { snapshot });
    const data = store.buildTurnData(minimalRecord('turn-plan-1', 'discord:dm:contact-1'));

    const plan = data.promptLoom.plan;
    expect(plan).not.toBeNull();
    expect(plan?.schemaVersion).toBe(1);
    expect(plan?.blocks).toHaveLength(5);
    // AC3: every block carries producer / scopeKey / volatility / tokensEst.
    for (const block of plan?.blocks ?? []) {
      expect(block.producer.length).toBeGreaterThan(0);
      expect(typeof block.scopeKey).toBe('string');
      expect(['static', 'session_stable', 'turn']).toContain(block.volatility);
      expect(block.tokensEst).toBeGreaterThan(0);
      expect(block.renderedText.length).toBeGreaterThan(0);
    }
    expect(plan?.cachePlan).toEqual({ staticBoundary: 1, sessionStableBoundary: 2 });
    expect(plan?.toolDefinitions.map(tool => tool.name)).toEqual(['memory_search']);
  });

  it('serves a Provider Wire view byte-equal to serializePromptPlanForProvider output', async () => {
    const eventBus = new EventBus();
    const store = new AdminSessionTurnObservabilityStore({ eventBus });
    const snapshot = buildPlanBackedSnapshot('turn-plan-2', 'discord:dm:contact-1');

    await eventBus.emit('agent.turn.snapshot', { snapshot });
    const data = store.buildTurnData(minimalRecord('turn-plan-2', 'discord:dm:contact-1'));

    const wire = data.promptLoom.providerWire;
    expect(wire.source).toBe('prompt_plan');
    expect(wire.legacy).toBe(false);
    expect(wire.systemRoleTransport).toBe('anthropic_system');

    // AC1: byte-equal to the pure serialization of the served plan.
    const expected = serializePromptPlanForProvider(
      data.promptLoom.plan!,
      'anthropic_system',
    );
    expect(wire.systemPrompt).toBe(expected.systemPrompt);
    expect(JSON.stringify(wire.messages)).toBe(JSON.stringify(expected.providerWireMessages));
    // ...and identical to what actually shipped (recorded wire capture).
    expect(JSON.stringify(wire.messages)).toBe(
      JSON.stringify(data.snapshot?.promptContext?.providerObservability?.providerWireMessages),
    );
    // Tool definitions ship from the plan, byte-equal to the wire set.
    expect(JSON.stringify(wire.toolDefinitions)).toBe(
      JSON.stringify(data.promptLoom.plan!.toolDefinitions),
    );
  });

  it('degrades to the recorded wire capture for legacy pre-plan records', async () => {
    const eventBus = new EventBus();
    const store = new AdminSessionTurnObservabilityStore({ eventBus });
    const snapshot = buildLiveShapedSnapshot('turn-legacy-1', 'discord:dm:contact-1');

    await eventBus.emit('agent.turn.snapshot', { snapshot });
    const data = store.buildTurnData(minimalRecord('turn-legacy-1', 'discord:dm:contact-1'));

    expect(data.promptLoom.plan).toBeNull();
    const wire = data.promptLoom.providerWire;
    expect(wire.source).toBe('recorded_snapshot');
    expect(wire.legacy).toBe(true);
    expect(wire.systemPrompt).toBe(LARGE_SYSTEM_PROMPT);
    expect(wire.messages).toHaveLength(1 + 40);
    expect(wire.messages[0]?.content).toBe(LARGE_SYSTEM_PROMPT);
  });
});

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
