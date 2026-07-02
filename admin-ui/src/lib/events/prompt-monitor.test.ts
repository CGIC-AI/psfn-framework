import assert from 'node:assert/strict';
import test from 'node:test';
import type { TurnID } from '../../../../src/shared/contracts/runtime.js';
import type { AdminPromptPlanData, AdminSessionTurnData } from '../types';
import {
  buildPromptMonitorTurns,
  buildStaticPrefixHashTimeline,
  diffPromptPlanBlocks,
  formatPromptMonitorStageLabel,
  mergePromptMonitorEvent,
  resolvePromptMonitorMetrics,
  resolvePromptMonitorPlan,
  resolvePromptMonitorPromptLoom,
  resolvePromptMonitorSummary,
} from './prompt-monitor';

function asTurnId(value: string): TurnID {
  return value as TurnID;
}

function buildTurn(seed: {
  turnId: string;
  channelId: string;
  promptVersionPointer: string;
  completedAt: number;
  ttftMs: number;
  promptDurationMs: number;
}): AdminSessionTurnData {
  return {
    record: {
      schemaVersion: 1,
      turnId: asTurnId(seed.turnId),
      requestId: seed.turnId,
      channelId: seed.channelId,
      channelType: 'api',
      startedAt: seed.completedAt - 50,
      completedAt: seed.completedAt,
      status: 'completed',
      userMessage: {
        role: 'user',
        content: 'hello',
        timestamp: seed.completedAt - 50,
      },
      assistantMessage: {
        role: 'assistant',
        content: 'world',
        timestamp: seed.completedAt,
      },
      toolCalls: [],
      extractedMemoryIds: [],
      concernDeltaRefs: [],
      contactDeltaRefs: [],
      versionPointers: {
        model: 'test-model',
        promptStack: seed.promptVersionPointer,
        promptMode: 'default',
      },
      provenanceRefs: [],
    },
    roleEnvelopeRefs: [],
    continuityProvenance: [],
    stages: [
      {
        observedAt: seed.completedAt - 40,
        turnId: seed.turnId,
        requestId: seed.turnId,
        channelId: seed.channelId,
        callType: 'chat',
        purpose: 'agent.turn.stage.first-token',
        stage: 'first-token',
        elapsedMs: seed.ttftMs,
        data: {
          ttftMs: seed.ttftMs,
          source: 'stream',
        },
      },
      {
        observedAt: seed.completedAt - 10,
        turnId: seed.turnId,
        requestId: seed.turnId,
        channelId: seed.channelId,
        callType: 'chat',
        purpose: 'agent.turn.stage.prompt',
        stage: 'prompt',
        elapsedMs: seed.promptDurationMs,
        data: {
          ttftMs: seed.ttftMs,
          promptMode: 'default',
        },
      },
      {
        observedAt: seed.completedAt,
        turnId: seed.turnId,
        requestId: seed.turnId,
        channelId: seed.channelId,
        callType: 'chat',
        purpose: 'agent.turn.stage.end',
        stage: 'end',
        elapsedMs: seed.promptDurationMs + 12,
        data: {},
      },
    ],
    retrievals: [],
    snapshot: {
      turnId: seed.turnId,
      requestId: seed.turnId,
      channelId: seed.channelId,
      capturedAt: seed.completedAt - 45,
      trustLevel: 'regular',
      prompt: {
        staticPrefixTemplate: 'Static prefix',
        dynamicSuffixTemplate: 'Dynamic suffix',
        staticHash: `${seed.promptVersionPointer}-hash`,
        versionPointer: seed.promptVersionPointer,
      },
      // Historical persisted snapshot shape: records that predate the
      // PromptPlan (E2.2) stored rendered prompt strings on promptContext.
      promptContext: {
        renderedStaticPrefix: 'Rendered static prefix',
        renderedDynamicSuffix: 'Rendered dynamic suffix',
        runtimeContext: 'Runtime context',
        memoryContextBlock: 'Memory block',
        scratchpadContext: 'Scratchpad block',
        assembledPrompt: 'Assembled prompt',
        finalSystemPrompt: 'Final system prompt',
        currentTurnInput: 'hello',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'world' },
        ],
          providerObservability: {
            routeKind: 'registered_model',
            requestedProvider: 'test',
            requestedModel: 'test-model',
            backendProvider: 'test',
            backendModel: 'test-model',
            backendApi: 'openai-completions',
            promptCaching: {
              configured: false,
              engaged: false,
            },
            systemRole: {
              transport: 'openai_system',
              supportsSystemRole: true,
            supportsDeveloperRole: false,
            usesOutOfBandSystemPrompt: false,
          },
          providerWireMessages: [
            { role: 'system', source: 'system_prompt', content: 'Final system prompt' },
            { role: 'user', source: 'message', content: 'hello' },
          ],
        },
        response: {
          content: 'world',
          reasoning: 'straight shot',
          model: 'test-model',
          stopReason: 'stop',
          toolCallCount: 0,
        },
      } as unknown as NonNullable<AdminSessionTurnData['snapshot']>['promptContext'],
      toolContext: {
        activeTools: [
          {
            name: 'contact_lookup',
            description: 'Look up a contact.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' },
              },
            },
          },
        ],
        adaptiveSnapshot: {
          timestamp: seed.completedAt - 40,
          turnId: seed.turnId,
          requestId: seed.turnId,
          channelId: seed.channelId,
          callType: 'chat',
          purpose: 'agent.tools.adaptive.snapshot',
          tools: [{ toolName: 'contact_lookup', source: 'core' }],
          skipped: [],
          counts: {
            core: 1,
            promoted: 0,
            extendedLoaded: 0,
            autoload: 0,
            deferred: 0,
            total: 1,
          },
          taskKind: null,
          intent: 'chat',
        },
      },
    },
  };
}

test('buildPromptMonitorTurns preserves newest-first order and summary metrics', () => {
  const turns = buildPromptMonitorTurns([
    buildTurn({
      turnId: 'turn-1',
      channelId: 'api:monitor',
      promptVersionPointer: 'prompt-v1',
      completedAt: 1_000,
      ttftMs: 20,
      promptDurationMs: 120,
    }),
    buildTurn({
      turnId: 'turn-2',
      channelId: 'api:monitor',
      promptVersionPointer: 'prompt-v2',
      completedAt: 2_000,
      ttftMs: 40,
      promptDurationMs: 160,
    }),
  ]);

  assert.equal(turns[0]?.turnId, 'turn-2');
  assert.equal(turns[1]?.turnId, 'turn-1');

  const metrics = resolvePromptMonitorMetrics(turns[0]!);
  assert.equal(metrics.promptDurationMs, 160);
  assert.equal(metrics.ttftMs, 40);
  assert.equal(metrics.promptVersionPointer, 'prompt-v2');
  assert.equal(metrics.firstTokenSource, 'stream');
  assert.equal(metrics.isComplete, true);

  assert.deepEqual(resolvePromptMonitorSummary(turns), {
    turnCount: 2,
    liveTurnCount: 0,
    averagePromptDurationMs: 140,
    averageTtftMs: 30,
    latestPromptVersionPointer: 'prompt-v2',
    latestStaticHash: 'prompt-v2-hash',
  });
});

test('buildPromptMonitorTurns sanitizes uncloneable prompt loom data without dropping useful fields', () => {
  const proxiedSchema = new Proxy({
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    uncloneable: () => 'drop me',
  }, {});
  assert.throws(() => structuredClone(proxiedSchema), {
    name: 'DataCloneError',
  });

  const turn = buildTurn({
    turnId: 'turn-uncloneable',
    channelId: 'api:monitor',
    promptVersionPointer: 'prompt-uncloneable',
    completedAt: 4_000,
    ttftMs: 30,
    promptDurationMs: 140,
  });

  turn.snapshot!.toolContext!.activeTools[0]!.inputSchema = proxiedSchema as Record<string, unknown>;
  turn.promptLoom = {
    source: 'turn_snapshot',
    snapshotCapturedAt: 3_950,
    plan: null,
    providerWire: {
      source: 'recorded_snapshot',
      legacy: true,
      systemRoleTransport: 'openai_system',
      systemPrompt: 'Final system prompt',
      messages: [
        { role: 'system', source: 'system_prompt', content: 'Final system prompt' },
      ],
      toolDefinitions: [],
    },
    historicalSnapshot: {
      label: 'Persisted turn snapshot; not current prompt generator state.',
      removedPromptLayerIds: [],
      hits: [],
    },
    generatedPrompt: {
      renderedStaticPrefix: 'Rendered static prefix',
      renderedDynamicSuffix: 'Rendered dynamic suffix',
      runtimeContext: 'Runtime context',
      memoryContextBlock: 'Memory block',
      scratchpadContext: 'Scratchpad block',
      assembledPrompt: 'Assembled prompt',
      contextMessages: [],
      inputSections: [],
      runtimeContextSections: [],
      memoryContextSections: [],
      finalSystemSections: [],
    },
    providerPayload: {
      finalSystemPrompt: 'Final system prompt',
      providerMessages: [
        { role: 'system', source: 'system_prompt', content: 'Final system prompt' },
      ],
      activeTools: [
        {
          name: 'contact_lookup',
          description: 'Look up a contact.',
          inputSchema: proxiedSchema as Record<string, unknown>,
        },
      ],
    },
    providerResult: {
      response: null,
      renderedChatOutput: 'world',
    },
    memoryCapture: {
      input: {
        currentTurnInput: 'hello',
        renderedChatOutput: 'world',
      },
      output: {
        extractedMemoryIds: [],
      },
    },
    toolActivity: {
      toolCalls: [
        new Proxy({
          id: 'call-1',
          name: 'contact_lookup',
          arguments: { query: 'Vega' },
          uncloneable: () => 'drop me',
        }, {}) as AdminSessionTurnData['record']['toolCalls'][number],
      ],
      toolResults: [],
    },
  };

  const turns = buildPromptMonitorTurns([turn]);
  assert.equal(turns[0]?.snapshot?.toolContext?.activeTools[0]?.inputSchema.type, 'object');
  assert.deepEqual(
    turns[0]?.snapshot?.toolContext?.activeTools[0]?.inputSchema.properties,
    { query: { type: 'string' } },
  );

  const promptLoom = resolvePromptMonitorPromptLoom(turns[0]!);
  assert.equal(promptLoom.providerPayload.finalSystemPrompt, 'Final system prompt');
  assert.equal(promptLoom.providerPayload.providerMessages.length, 1);
  assert.equal(promptLoom.providerPayload.activeTools[0]?.inputSchema.type, 'object');
  assert.deepEqual(
    promptLoom.providerPayload.activeTools[0]?.inputSchema.properties,
    { query: { type: 'string' } },
  );
  assert.equal(
    Object.hasOwn(promptLoom.providerPayload.activeTools[0]?.inputSchema ?? {}, 'uncloneable'),
    false,
  );
});

test('mergePromptMonitorEvent overlays live snapshots and stages onto the selected turn', () => {
  const seeded = buildPromptMonitorTurns([
    buildTurn({
      turnId: 'turn-3',
      channelId: 'api:monitor',
      promptVersionPointer: 'prompt-v3',
      completedAt: 3_000,
      ttftMs: 25,
      promptDurationMs: 110,
    }),
  ]);

  const mergedSnapshot = mergePromptMonitorEvent(seeded, {
    type: 'agent.turn.snapshot',
    timestamp: 3_100,
    correlation: {
      channelId: 'api:monitor',
      turnId: 'turn-live',
    },
    data: {
      snapshot: {
        turnId: 'turn-live',
        requestId: 'turn-live',
        channelId: 'api:monitor',
        capturedAt: 3_050,
        trustLevel: 'regular',
        prompt: {
          staticPrefixTemplate: 'Live static',
          dynamicSuffixTemplate: 'Live dynamic',
          staticHash: 'live-hash',
          versionPointer: 'prompt-live',
        },
        plan: {
          schemaVersion: 1,
          blocks: [
            {
              id: 'static_prefix',
              layer: 'prompt_stack',
              volatility: 'static',
              producer: 'identity.prompt-runtime',
              renderedText: 'Rendered live static',
              tokensEst: 3,
            },
            {
              id: 'dynamic_suffix',
              layer: 'prompt_stack',
              volatility: 'turn',
              producer: 'identity.prompt-runtime',
              renderedText: 'Rendered live dynamic',
              tokensEst: 3,
            },
            {
              id: 'runtime.context',
              layer: 'runtime',
              volatility: 'turn',
              producer: 'substrate-agent.runtime-context',
              renderedText: 'Live runtime context',
              tokensEst: 3,
            },
            {
              id: 'runtime.scratchpad',
              layer: 'runtime',
              volatility: 'turn',
              producer: 'substrate-agent.scratchpad',
              renderedText: 'Live scratchpad block',
              tokensEst: 3,
            },
            {
              id: 'memory.retrieval',
              layer: 'session',
              volatility: 'turn',
              producer: 'memory.retrieval.formatting',
              renderedText: 'Live memory block',
              tokensEst: 3,
            },
          ],
          variables: {},
          messages: [
            {
              role: 'user',
              content: 'earlier',
              provenance: {
                schemaVersion: 1,
                kind: 'user_direct',
                sourceAuthor: 'partner',
                transformedBy: 'none',
                wording: 'direct',
                directSpeech: true,
                detailLoss: 'none',
                emotionalTexture: 'preserved',
                safeAsPartnerSpeech: true,
                sourceSpanCount: 1,
                sourceEntryIds: [1],
              },
            },
            { role: 'assistant', content: 'reply' },
          ],
          toolDefinitions: [],
          cachePlan: { staticBoundary: 1, sessionStableBoundary: 1 },
          scope: {
            kind: 'group',
            channelId: 'api:monitor',
            recentSpeakers: [],
            key: 'room:api:monitor',
          },
        },
        promptContext: {
          currentTurnInput: 'live user input',
          inputSections: [
            {
              id: 'analysis_workbench_guidance',
              title: 'Analysis Workbench Guidance',
              content: 'Historical removed prompt layer content.',
              charCount: 40,
              tokenCount: 5,
            },
          ],
          finalSystemSections: [
            {
              id: 'retrieved_memory',
              title: 'Retrieved Memory',
              content: 'Live memory block',
              charCount: 17,
              tokenCount: 3,
              provenance: {
                schemaVersion: 1,
                kind: 'memory_retrieval',
                sourceAuthor: 'memory',
                transformedBy: 'retrieval',
                wording: 'derived',
                directSpeech: false,
                detailLoss: 'possible',
                emotionalTexture: 'may_be_flattened',
                safeAsPartnerSpeech: false,
                notes: ['Derived context; exact details may be lost.'],
              },
            },
          ],
          providerObservability: {
            routeKind: 'configured_litellm_proxy',
            requestedProvider: 'openrouter',
            requestedModel: 'openrouter/live',
            backendProvider: 'litellm',
            backendModel: 'openrouter/live',
            backendApi: 'openai-responses',
            promptCaching: {
              configured: false,
              engaged: false,
            },
            systemRole: {
              transport: 'openai_developer',
              supportsSystemRole: true,
              supportsDeveloperRole: true,
              usesOutOfBandSystemPrompt: false,
            },
            providerWireMessages: [
              { role: 'developer', source: 'system_prompt', content: 'Live final system prompt' },
              { role: 'user', source: 'message', content: 'earlier' },
            ],
          },
          response: {
            content: 'reply',
            reasoning: 'live reasoning',
            model: 'openrouter/live',
            stopReason: 'stop',
          },
        },
        toolContext: {
          activeTools: [
            {
              name: 'session_list',
              description: 'List sessions.',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
          ],
          adaptiveSnapshot: {
            timestamp: 3_060,
            turnId: 'turn-live',
            requestId: 'turn-live',
            channelId: 'api:monitor',
            callType: 'chat',
            purpose: 'agent.tools.adaptive.snapshot',
            tools: [{ toolName: 'session_list', source: 'core' }],
            skipped: [{ toolName: 'notify_operator', source: 'autoload', reason: 'not_needed_for_turn' }],
            counts: {
              core: 1,
              promoted: 0,
              extendedLoaded: 0,
              autoload: 0,
              deferred: 0,
              total: 1,
            },
            taskKind: null,
            intent: 'chat',
          },
        },
      },
    },
  });

  const mergedStages = mergePromptMonitorEvent(mergedSnapshot, {
    type: 'agent.turn.stage',
    timestamp: 3_200,
    correlation: {
      channelId: 'api:monitor',
      turnId: 'turn-live',
    },
    data: {
      observedAt: 3_200,
      turnId: 'turn-live',
      requestId: 'turn-live',
      channelId: 'api:monitor',
      callType: 'chat',
      purpose: 'agent.turn.stage.prompt',
      stage: 'prompt',
      elapsedMs: 95,
      data: {
        ttftMs: 18,
        mode: 'default',
      },
    },
  });

  assert.equal(mergedStages[0]?.turnId, 'turn-live');
  const metrics = resolvePromptMonitorMetrics(mergedStages[0]!);
  assert.equal(metrics.promptDurationMs, 95);
  assert.equal(metrics.ttftMs, 18);
  assert.equal(metrics.promptVersionPointer, 'prompt-live');
  assert.equal(metrics.isComplete, false);
  const liveFinalSystemPrompt = [
    'Rendered live static',
    'Rendered live dynamic',
    'Live runtime context',
    'Live scratchpad block',
    'Live memory block',
  ].join('\n\n');
  assert.equal(
    mergedStages[0]?.snapshot?.plan?.blocks.find(block => block.id === 'static_prefix')?.renderedText,
    'Rendered live static',
  );
  assert.equal(mergedStages[0]?.snapshot?.promptContext?.currentTurnInput, 'live user input');
  assert.deepEqual(mergedStages[0]?.snapshot?.plan?.messages, [
    {
      role: 'user',
      content: 'earlier',
      provenance: {
        schemaVersion: 1,
        kind: 'user_direct',
        sourceAuthor: 'partner',
        transformedBy: 'none',
        wording: 'direct',
        directSpeech: true,
        detailLoss: 'none',
        emotionalTexture: 'preserved',
        safeAsPartnerSpeech: true,
        sourceSpanCount: 1,
        sourceEntryIds: [1],
      },
    },
    { role: 'assistant', content: 'reply' },
  ]);
  assert.equal(
    mergedStages[0]?.snapshot?.promptContext?.finalSystemSections?.[0]?.provenance?.kind,
    'memory_retrieval',
  );
  assert.deepEqual(mergedStages[0]?.snapshot?.promptContext?.providerObservability?.providerWireMessages, [
    { role: 'developer', source: 'system_prompt', content: 'Live final system prompt' },
    { role: 'user', source: 'message', content: 'earlier' },
  ]);
  assert.equal(mergedStages[0]?.snapshot?.plan?.cachePlan.staticBoundary, 1);
  assert.deepEqual(mergedStages[0]?.snapshot?.promptContext?.response, {
    content: 'reply',
    reasoning: 'live reasoning',
    model: 'openrouter/live',
    stopReason: 'stop',
  });
  assert.deepEqual(mergedStages[0]?.snapshot?.toolContext?.activeTools, [
    {
      name: 'session_list',
      description: 'List sessions.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ]);
  const promptLoom = resolvePromptMonitorPromptLoom(mergedStages[0]!);
  assert.equal(promptLoom.providerPayload.finalSystemPrompt, liveFinalSystemPrompt);
  assert.equal(promptLoom.generatedPrompt.renderedStaticPrefix, 'Rendered live static');
  assert.equal(promptLoom.generatedPrompt.memoryContextBlock, 'Live memory block');
  assert.equal(promptLoom.generatedPrompt.assembledPrompt, [
    'Rendered live static',
    'Rendered live dynamic',
    'Live runtime context',
    'Live scratchpad block',
  ].join('\n\n'));
  assert.deepEqual(promptLoom.providerPayload.providerMessages, [
    { role: 'developer', source: 'system_prompt', content: 'Live final system prompt' },
    { role: 'user', source: 'message', content: 'earlier' },
  ]);
  assert.deepEqual(promptLoom.providerPayload.activeTools, [
    {
      name: 'session_list',
      description: 'List sessions.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ]);
  assert.deepEqual(promptLoom.historicalSnapshot.removedPromptLayerIds, ['analysis_workbench_guidance']);
  assert.equal(promptLoom.historicalSnapshot.label, 'Persisted turn snapshot; not current prompt generator state.');

  // E2.3: the plan and Provider Wire projections survive the live-bus fallback.
  assert.equal(promptLoom.plan?.schemaVersion, 1);
  assert.equal(promptLoom.plan?.blocks.length, 5);
  assert.equal(promptLoom.providerWire.source, 'recorded_snapshot');
  assert.equal(promptLoom.providerWire.legacy, false);
  assert.equal(promptLoom.providerWire.systemRoleTransport, 'openai_developer');
  assert.equal(promptLoom.providerWire.systemPrompt, liveFinalSystemPrompt);
  assert.deepEqual(promptLoom.providerWire.messages, [
    { role: 'developer', source: 'system_prompt', content: 'Live final system prompt' },
    { role: 'user', source: 'message', content: 'earlier' },
  ]);
  const resolvedPlan = resolvePromptMonitorPlan(mergedStages[0]!);
  assert.equal(resolvedPlan?.cachePlan.staticBoundary, 1);
});

// ── E2.3 projections: block diff, static-hash timeline, legacy fallback ──

function buildPlanFixture(seed: {
  staticText?: string;
  coreMemoryText?: string;
  runtimeText?: string;
  datetimeText?: string;
  includeScratchpad?: boolean;
  includeSessionContext?: boolean;
}): AdminPromptPlanData {
  const blocks: AdminPromptPlanData['blocks'] = [
    {
      id: 'static_prefix',
      layer: 'prompt_stack',
      volatility: 'static',
      producer: 'identity.prompt-runtime',
      scopeKey: 'global',
      renderedText: seed.staticText ?? 'Frozen static identity prefix.',
      tokensEst: 6,
    },
    {
      id: 'core_memory',
      layer: 'runtime',
      volatility: 'session_stable',
      producer: 'core-memory.blocks',
      scopeKey: 'dm:contact-1',
      renderedText: seed.coreMemoryText ?? 'Core memory: persona + human.',
      tokensEst: 6,
    },
    {
      id: 'runtime.context',
      layer: 'runtime',
      volatility: 'turn',
      producer: 'substrate-agent.runtime-context',
      scopeKey: 'dm:contact-1',
      renderedText: seed.runtimeText ?? 'Runtime context turn state.',
      tokensEst: 5,
    },
    ...(seed.includeScratchpad
      ? [{
        id: 'runtime.scratchpad',
        layer: 'runtime' as const,
        volatility: 'turn' as const,
        producer: 'substrate-agent.scratchpad',
        scopeKey: 'dm:contact-1',
        renderedText: 'Scratchpad block.',
        tokensEst: 3,
      }]
      : []),
    ...(seed.includeSessionContext
      ? [{
        id: 'session_context',
        layer: 'provider' as const,
        volatility: 'turn' as const,
        producer: 'session.context-builder',
        scopeKey: 'dm:contact-1',
        renderedText: 'Folded session context.',
        tokensEst: 4,
      }]
      : []),
    {
      id: 'runtime.current_datetime',
      layer: 'provider',
      volatility: 'turn',
      producer: 'runtime-context.current-datetime',
      scopeKey: 'global',
      renderedText: seed.datetimeText ?? '<runtime.current_datetime authority="canonical" overrides="memory,conversation_history,continuity_anchor,wake_orientation,cross_channel_continuity">\n<iso>2026-07-01T12:00:00-04:00</iso>\n</runtime.current_datetime>',
      tokensEst: 20,
    },
  ];
  return {
    schemaVersion: 1,
    blocks,
    variables: {},
    messages: [{ role: 'user', content: 'hello' }],
    toolDefinitions: [],
    cachePlan: { staticBoundary: 1, sessionStableBoundary: 2 },
    scope: { kind: 'dm', channelId: 'api:dm', recentSpeakers: [], key: 'dm:contact-1' },
  };
}

test('diffPromptPlanBlocks: quiet consecutive pair diffs only the turn-volatile blocks', () => {
  const before = buildPlanFixture({
    runtimeText: 'Runtime context turn 1.',
    datetimeText: '<runtime.current_datetime><iso>T1</iso></runtime.current_datetime>',
  });
  const after = buildPlanFixture({
    runtimeText: 'Runtime context turn 2 with more text.',
    datetimeText: '<runtime.current_datetime><iso>T2</iso></runtime.current_datetime>',
  });

  const diff = diffPromptPlanBlocks(before, after);
  assert.equal(diff.comparable, true);
  assert.equal(diff.addedCount, 0);
  assert.equal(diff.removedCount, 0);
  assert.equal(diff.changedCount, 2);
  assert.equal(diff.unchangedCount, 2);
  // AC2: the static region shows zero changed blocks for a quiet pair.
  assert.equal(diff.staticRegionChangedCount, 0);

  const byId = new Map(diff.entries.map(entry => [entry.id, entry]));
  assert.equal(byId.get('static_prefix')?.status, 'unchanged');
  assert.equal(byId.get('core_memory')?.status, 'unchanged');
  assert.equal(byId.get('runtime.context')?.status, 'changed');
  assert.equal(byId.get('runtime.current_datetime')?.status, 'changed');
  // Changed-bytes indicator per block.
  const runtimeEntry = byId.get('runtime.context')!;
  assert.equal(runtimeEntry.bytesBefore, Buffer.byteLength('Runtime context turn 1.', 'utf8'));
  assert.equal(runtimeEntry.bytesAfter, Buffer.byteLength('Runtime context turn 2 with more text.', 'utf8'));
  assert.equal(runtimeEntry.bytesDelta, runtimeEntry.bytesAfter! - runtimeEntry.bytesBefore!);
});

test('diffPromptPlanBlocks: appeared/disappeared blocks are id-level added/removed', () => {
  const before = buildPlanFixture({ includeScratchpad: true });
  const after = buildPlanFixture({ includeSessionContext: true });

  const diff = diffPromptPlanBlocks(before, after);
  const byId = new Map(diff.entries.map(entry => [entry.id, entry]));
  assert.equal(diff.addedCount, 1);
  assert.equal(diff.removedCount, 1);
  assert.equal(byId.get('session_context')?.status, 'added');
  assert.equal(byId.get('session_context')?.bytesBefore, null);
  assert.equal(byId.get('runtime.scratchpad')?.status, 'removed');
  assert.equal(byId.get('runtime.scratchpad')?.bytesAfter, null);
  assert.equal(diff.staticRegionChangedCount, 0);
  // Removed entries are appended after the after-plan-ordered entries.
  assert.equal(diff.entries.at(-1)?.id, 'runtime.scratchpad');
});

test('diffPromptPlanBlocks: legacy pre-plan turns are not comparable', () => {
  const plan = buildPlanFixture({});
  assert.equal(diffPromptPlanBlocks(null, plan).comparable, false);
  assert.equal(diffPromptPlanBlocks(plan, null).comparable, false);
  assert.deepEqual(diffPromptPlanBlocks(null, null).entries, []);
});

test('buildStaticPrefixHashTimeline orders oldest-first and flags hash changes', () => {
  const turns = buildPromptMonitorTurns([
    buildTurn({
      turnId: 'turn-a',
      channelId: 'api:monitor',
      promptVersionPointer: 'v1',
      completedAt: 1_000,
      ttftMs: 10,
      promptDurationMs: 100,
    }),
    buildTurn({
      turnId: 'turn-b',
      channelId: 'api:monitor',
      promptVersionPointer: 'v1',
      completedAt: 2_000,
      ttftMs: 10,
      promptDurationMs: 100,
    }),
    buildTurn({
      turnId: 'turn-c',
      channelId: 'api:monitor',
      promptVersionPointer: 'v2',
      completedAt: 3_000,
      ttftMs: 10,
      promptDurationMs: 100,
    }),
  ]);

  const timeline = buildStaticPrefixHashTimeline(turns);
  assert.deepEqual(timeline.map(entry => entry.turnId), ['turn-a', 'turn-b', 'turn-c']);
  assert.deepEqual(
    timeline.map(entry => entry.changedFromPrevious),
    [null, false, true],
  );
  assert.equal(timeline[0]?.staticHash, 'v1-hash');
  assert.equal(timeline[2]?.staticHash, 'v2-hash');
});

test('legacy pre-plan turns degrade to the recorded wire with an explicit legacy marker', () => {
  const turns = buildPromptMonitorTurns([
    buildTurn({
      turnId: 'turn-legacy',
      channelId: 'api:monitor',
      promptVersionPointer: 'v1',
      completedAt: 1_000,
      ttftMs: 10,
      promptDurationMs: 100,
    }),
  ]);

  assert.equal(resolvePromptMonitorPlan(turns[0]!), null);
  const promptLoom = resolvePromptMonitorPromptLoom(turns[0]!);
  assert.equal(promptLoom.plan, null);
  assert.equal(promptLoom.providerWire.source, 'recorded_snapshot');
  assert.equal(promptLoom.providerWire.legacy, true);
  assert.equal(promptLoom.providerWire.systemPrompt, 'Final system prompt');
  assert.deepEqual(promptLoom.providerWire.messages, [
    { role: 'system', source: 'system_prompt', content: 'Final system prompt' },
    { role: 'user', source: 'message', content: 'hello' },
  ]);
  // Legacy wire falls back to the recorded active tool schemas.
  assert.equal(promptLoom.providerWire.toolDefinitions[0]?.name, 'contact_lookup');
});

test('plan-backed fallback strips stale datetime anchors and serializes the ordered anchor last', () => {
  const seeded = buildPromptMonitorTurns([]);
  const merged = mergePromptMonitorEvent(seeded, {
    type: 'agent.turn.snapshot',
    timestamp: 5_000,
    correlation: { channelId: 'api:monitor', turnId: 'turn-anchor' },
    data: {
      snapshot: {
        turnId: 'turn-anchor',
        requestId: 'turn-anchor',
        channelId: 'api:monitor',
        capturedAt: 5_000,
        trustLevel: 'regular',
        plan: buildPlanFixture({
          // A stale anchor leaked into upstream content: must be stripped.
          runtimeText: 'Runtime state.\n<current_datetime>stale</current_datetime>\nMore state.',
          datetimeText: '<runtime.current_datetime><iso>CANONICAL</iso></runtime.current_datetime>',
        }),
      },
    },
  });

  const promptLoom = resolvePromptMonitorPromptLoom(merged[0]!);
  const systemPrompt = promptLoom.providerWire.systemPrompt ?? '';
  assert.equal(systemPrompt.includes('stale'), false);
  assert.equal(
    systemPrompt.endsWith('<runtime.current_datetime><iso>CANONICAL</iso></runtime.current_datetime>'),
    true,
  );
  assert.equal(systemPrompt.match(/<runtime\.current_datetime/g)?.length, 1);
});

test('mergePromptMonitorEvent ignores unrelated payloads and labels stages clearly', () => {
  const seeded = buildPromptMonitorTurns([]);
  const untouched = mergePromptMonitorEvent(seeded, {
    type: 'message.sent',
    timestamp: 1,
    correlation: {},
    data: {},
  });

  assert.deepEqual(untouched, []);
  assert.equal(formatPromptMonitorStageLabel('first-token'), 'First Token');
  assert.equal(formatPromptMonitorStageLabel('memory'), 'Memory');
});
