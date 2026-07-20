import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  AdminTurnMemorySnapshotData,
  AdminTurnSnapshotData,
} from '../types';
import {
  mergePromptMonitorEvent,
  type PromptMonitorSnapshotRejection,
} from './prompt-monitor';
import {
  parsePersistedTurnSnapshot,
  parsePersistedTurnSnapshotEventData,
} from './turn-snapshot-parser';

function minimalSnapshot() {
  return {
    turnId: 'turn-1',
    requestId: 'request-1',
    channelId: 'api:dm',
    capturedAt: 1_000,
    trustLevel: 'regular',
  };
}

function fullSnapshot() {
  return {
    ...minimalSnapshot(),
    promptContext: {
      messages: [{ role: 'user', content: 'hello' }],
      currentTurnInput: 'hello',
      providerObservability: {
        routeKind: 'registered_model',
        requestedProvider: 'test',
        requestedModel: 'test-model',
        backendProvider: 'test',
        backendModel: 'test-model',
        backendApi: 'openai-completions',
        systemRole: {
          transport: 'openai_system',
          supportsSystemRole: true,
          supportsDeveloperRole: false,
          usesOutOfBandSystemPrompt: false,
        },
        promptCaching: {
          configured: false,
          engaged: false,
        },
        providerWireMessages: [
          { role: 'user', source: 'message', content: 'hello' },
        ],
      },
    },
    toolContext: {
      activeTools: [
        {
          name: 'contact_lookup',
          description: 'Look up a contact.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
      ],
    },
  };
}

function slimSnapshot() {
  const full = fullSnapshot();
  const provider = full.promptContext.providerObservability;
  return {
    ...full,
    promptContext: {
      ...full.promptContext,
      providerObservability: {
        routeKind: provider.routeKind,
        requestedProvider: provider.requestedProvider,
        requestedModel: provider.requestedModel,
        backendProvider: provider.backendProvider,
        backendModel: provider.backendModel,
        backendApi: provider.backendApi,
        systemRole: provider.systemRole,
        promptCaching: provider.promptCaching,
      },
    },
    toolContext: {},
  };
}

function eventData(snapshot: unknown = minimalSnapshot()) {
  return {
    snapshot,
    turnId: 'turn-1',
    requestId: 'request-1',
    channelId: 'api:dm',
    channelType: 'api',
    callType: 'chat',
    purpose: 'agent.turn.snapshot',
  };
}

function observedMemory(): AdminTurnMemorySnapshotData['contactEmotionalMemories'][number] {
  return {
    id: 'memory-1',
    text: 'A canonical memory.',
    type: 'semantic',
    importance: 0.8,
    confidence: 0.9,
    emotionalValence: 0.2,
    formationVAD: { valence: 0.2, arousal: 0.3, dominance: -0.1 },
    salience: 0.7,
    sourceRef: 'turn:turn-1',
    sourceType: 'turn',
    provenance: {
      channelId: 'api:dm',
      turnId: 'turn-1',
      actor: 'companion',
      subjectContactIds: ['contact-1'],
      addressMode: 'direct_to_companion',
      sourceMessageIds: [1],
      sourceSpanStartMessageId: 1,
      sourceSpanEndMessageId: 1,
    },
    extractedAt: 900,
    lastAccessed: 950,
    accessCount: 1,
    tags: ['canonical'],
    scopeRef: { kind: 'contact', id: 'contact-1', label: 'Contact' },
    scopeTags: ['contact:contact-1'],
    provenanceRefs: ['turn:turn-1'],
    retentionClass: 'standard',
    sensitivity: 'personal',
    consentFlags: {
      allowRecall: true,
      allowAbstraction: false,
      deleteOnRequest: true,
      redactionBehavior: 'abstract',
    },
    contactId: 'contact-1',
  };
}

function episodicChain(): NonNullable<AdminTurnMemorySnapshotData['episodicChains']>[number] {
  const episode: NonNullable<AdminTurnMemorySnapshotData['episodicChains']>[number]['episodes'][number] = {
    schemaVersion: 1,
    id: 'episode-1',
    title: 'A canonical episode',
    landmark: 'The important moment',
    startedAt: '2026-07-16T00:00:00.000Z',
    endedAt: '2026-07-16T00:01:00.000Z',
    participantContactIds: ['contact-1'],
    salience: { score: 0.9, novelty: 0.5, emotionalIntensity: 0.4 },
    affect: { valence: 0.2, arousal: 0.3, dominance: 0.1, labels: ['warm'] },
    themes: ['continuity'],
    spanRefs: [{ spanId: 'span-1', channelId: 'api:dm' }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'turn', refId: 'turn-1' }],
    meaning: {
      text: 'Continuity matters.',
      recordedAt: '2026-07-16T00:02:00.000Z',
      source: 'companion_direct',
    },
    createdAt: '2026-07-16T00:02:00.000Z',
    updatedAt: '2026-07-16T00:02:00.000Z',
  };
  return {
    rootEpisodeId: episode.id,
    episodes: [episode],
    arcs: [],
    score: 0.85,
    matchedTerms: ['continuity'],
  };
}

function fatigue(): NonNullable<AdminTurnSnapshotData['fatigue']> {
  return {
    schemaVersion: 1,
    decision: 'allowed_charged',
    modelDisposition: 'allowed',
    alertInjected: false,
    shouldRecordSpend: true,
    spendDecision: 'charged',
    spendReason: 'machine_intelligence_response',
    policyState: 'normal',
    policyBaseState: 'normal',
    intent: 'casual',
    relationshipClass: 'trusted_collaborator_mi',
    channelSetting: 'dm',
    overchargeEligible: false,
    overchargePermitted: false,
    overchargeBlockedReasons: [
      'normal_allowance_not_exhausted',
      'no_qualifying_overcharge_trigger',
    ],
    overchargeReasons: [],
    scope: {
      localCompanionId: 'companion-local',
      peerContactId: 'contact-1',
      channelId: 'api:dm',
      dayKey: '2026-07-16',
    },
    peer: {
      contactId: 'contact-1',
      channelAuthorId: 'companion-peer',
      displayName: 'Peer',
      isMachineIntelligence: true,
    },
    triggeringAuthor: {
      role: 'machine_intelligence',
      contactId: 'contact-1',
      channelAuthorId: 'companion-peer',
      displayName: 'Peer',
      isMachineIntelligence: true,
    },
    budget: {
      spentBefore: 0,
      remainingBefore: 2,
      allowance: 2,
      softLimit: 1,
      hardLimit: 2,
      amount: 1,
      spentAfterProjected: 1,
      remainingAfterProjected: 1,
      normalSpentBefore: 0,
      normalSpentAfterProjected: 1,
      overchargeSpentBefore: 0,
      overchargeSpentAfterProjected: 0,
      overchargeAllowance: 1,
      overchargeRemainingBefore: 1,
      overchargeRemainingAfterProjected: 1,
    },
    socialRegulation: {
      state: 'normal',
      chargeLane: 'interactive',
      relationshipPressure: 0,
      rootNormalSpent: 0,
      rootOverchargeSpent: 0,
      contributingEventCount: 0,
      marginalChargeUnits: 0,
      closeoutReserveRemainingBefore: 1,
      closeoutReserveRemainingAfterProjected: 1,
      continuationEvidence: [],
    },
    recordedEvent: {
      timestampMs: 1_000,
      amount: 1,
      decision: 'charged',
      reason: 'machine_intelligence_response',
      spentAfter: 1,
      remainingAllowance: 1,
      normalSpentAfter: 1,
      overchargeSpentAfter: 0,
      overchargeAllowance: 1,
      remainingOvercharge: 1,
      softState: 'soft_limit_reached',
      hardState: 'available',
    },
  };
}

function structuredSnapshot() {
  const full = fullSnapshot();
  const memory = observedMemory();
  return {
    ...full,
    toolContext: {
      ...full.toolContext,
      adaptiveSnapshot: {
        timestamp: 900,
        tools: [{ toolName: 'contact_lookup', source: 'core' }],
        skipped: [{
          toolName: 'email_send',
          source: 'extended',
          reason: 'missing capability',
          missingTokens: ['external.email'],
        }],
        counts: { core: 1, extended: 0, total: 1 },
        taskKind: 'conversation',
        intent: null,
        turnId: 'turn-1',
        requestId: 'request-1',
        channelId: 'api:dm',
        callType: 'chat',
        purpose: 'agent.turn.snapshot',
      },
    },
    memory: {
      channelId: 'api:dm',
      profile: {
        contactId: 'contact-1',
        summary: 'A known contact.',
        sourceMemoryIds: ['memory-1'],
        confidenceScore: 0.9,
        noveltyScore: 0.2,
        updatedAt: 950,
      },
      emotionalSnapshot: {
        baselineValence: 0.1,
        moodValence: 0.2,
        moodDrift: 0.1,
        moodSamples: 2,
        lastMoodUpdateEpochMs: 900,
      },
      contactEmotionalMemories: [memory],
      semanticCandidates: [{ ...memory, similarity: 0.8 }],
      lexicalCandidates: [{ ...memory, similarity: 0.7 }],
      episodicChains: [episodicChain()],
      proactiveCandidates: [memory],
      withheldSummary: {
        totalCount: 1,
        reasonCounts: { 'trust.ceiling_exceeded': 1 },
        relevanceBands: { high: 1 },
      },
      versionPointer: 'memory-v1',
    } satisfies AdminTurnMemorySnapshotData,
    fatigue: fatigue(),
  };
}

test('snapshot parser preserves valid slim, explicit-empty, and full snapshot semantics', () => {
  const slim = parsePersistedTurnSnapshot(slimSnapshot());
  assert.equal(slim.ok, true);
  if (!slim.ok) return;
  assert.equal(
    Object.hasOwn(slim.value.promptContext?.providerObservability ?? {}, 'providerWireMessages'),
    false,
  );
  assert.equal(Object.hasOwn(slim.value.toolContext ?? {}, 'activeTools'), false);

  const explicitEmpty = fullSnapshot();
  explicitEmpty.promptContext.providerObservability.providerWireMessages = [];
  explicitEmpty.toolContext.activeTools = [];
  const emptyResult = parsePersistedTurnSnapshot(explicitEmpty);
  assert.equal(emptyResult.ok, true);
  if (!emptyResult.ok) return;
  assert.deepEqual(
    emptyResult.value.promptContext?.providerObservability?.providerWireMessages,
    [],
  );
  assert.deepEqual(emptyResult.value.toolContext?.activeTools, []);

  const full = fullSnapshot();
  const fullResult = parsePersistedTurnSnapshot(full);
  assert.equal(fullResult.ok, true);
  if (!fullResult.ok) return;
  const parsedMessages = fullResult.value.promptContext
    ?.providerObservability
    ?.providerWireMessages;
  const parsedTools = fullResult.value.toolContext?.activeTools;
  assert.ok(parsedMessages);
  assert.ok(parsedTools);
  const parsedMessage = parsedMessages[0];
  const parsedTool = parsedTools[0];
  assert.ok(parsedMessage);
  assert.ok(parsedTool);
  parsedMessage.content = 'changed';
  parsedTool.inputSchema.type = 'changed';
  assert.equal(full.promptContext.providerObservability.providerWireMessages[0]?.content, 'hello');
  assert.equal(full.toolContext.activeTools[0]?.inputSchema.type, 'object');
});

test('snapshot parser accepts and clones every canonical structured snapshot field', () => {
  const snapshot = structuredSnapshot();
  const replay = parsePersistedTurnSnapshot(snapshot);
  const live = parsePersistedTurnSnapshotEventData(eventData(snapshot));
  assert.equal(replay.ok, true);
  assert.equal(live.ok, true);
  if (!replay.ok || !live.ok) return;
  assert.deepEqual(replay.value.memory, snapshot.memory);
  assert.deepEqual(live.value.fatigue, snapshot.fatigue);
  assert.notEqual(replay.value.memory, snapshot.memory);
  assert.notEqual(replay.value.memory?.episodicChains, snapshot.memory.episodicChains);
  assert.notEqual(replay.value.fatigue, snapshot.fatigue);
});

test('snapshot parser rejects malformed nested arrays, messages, tools, and discriminants', () => {
  const malformedProviderMessages = fullSnapshot();
  Object.defineProperty(
    malformedProviderMessages.promptContext.providerObservability,
    'providerWireMessages',
    { value: {}, enumerable: true },
  );
  const malformedActiveTools = fullSnapshot();
  Object.defineProperty(malformedActiveTools.toolContext, 'activeTools', {
    value: {},
    enumerable: true,
  });
  const malformedContextMessage = fullSnapshot();
  Object.defineProperty(malformedContextMessage.promptContext, 'messages', {
    value: [{ role: 'operator', content: 'nope' }],
    enumerable: true,
  });
  const malformedToolSchema = fullSnapshot();
  const malformedTool = malformedToolSchema.toolContext.activeTools[0];
  assert.ok(malformedTool);
  Object.defineProperty(malformedTool, 'inputSchema', {
    value: [],
    enumerable: true,
  });
  const malformedTransport = fullSnapshot();
  Object.defineProperty(
    malformedTransport.promptContext.providerObservability.systemRole,
    'transport',
    { value: 'raw_system', enumerable: true },
  );

  const cases = [
    malformedProviderMessages,
    malformedActiveTools,
    malformedContextMessage,
    malformedToolSchema,
    malformedTransport,
  ];
  for (const value of cases) {
    assert.doesNotThrow(() => parsePersistedTurnSnapshot(value));
    const result = parsePersistedTurnSnapshot(value);
    assert.equal(result.ok, false);
  }
});

test('snapshot parser rejects unknown fields and non-canonical prototypes', () => {
  const unknownSnapshotField = { ...minimalSnapshot(), surprise: true };
  const unknownNestedField = fullSnapshot();
  const unknownNestedTool = unknownNestedField.toolContext.activeTools[0];
  assert.ok(unknownNestedTool);
  Object.defineProperty(unknownNestedTool, 'surprise', {
    value: true,
    enumerable: true,
  });
  const inheritedSnapshot = Object.create({ inherited: true });
  Object.assign(inheritedSnapshot, minimalSnapshot());
  const nullPrototypeSnapshot = Object.create(null);
  Object.assign(nullPrototypeSnapshot, minimalSnapshot());
  const protoKeySnapshot = minimalSnapshot();
  Object.defineProperty(protoKeySnapshot, '__proto__', {
    value: { polluted: true },
    enumerable: true,
  });

  for (const value of [
    unknownSnapshotField,
    unknownNestedField,
    inheritedSnapshot,
    nullPrototypeSnapshot,
    protoKeySnapshot,
  ]) {
    const result = parsePersistedTurnSnapshot(value);
    assert.equal(result.ok, false);
  }

  const unknownEventField = { ...eventData(), surprise: true };
  const inheritedEvent = Object.create({ snapshot: minimalSnapshot() });
  Object.assign(inheritedEvent, eventData());
  assert.equal(parsePersistedTurnSnapshotEventData(unknownEventField).ok, false);
  assert.equal(parsePersistedTurnSnapshotEventData(inheritedEvent).ok, false);
});

test('event-data parser enforces correlation identity and canonical discriminants', () => {
  const wrongIdentity = { ...eventData(), turnId: 'turn-other' };
  const wrongCallType = { ...eventData(), callType: 'chatty' };
  const wrongChannelType = { ...eventData(), channelType: 'websocket' };

  assert.equal(parsePersistedTurnSnapshotEventData(wrongIdentity).ok, false);
  assert.equal(parsePersistedTurnSnapshotEventData(wrongCallType).ok, false);
  assert.equal(parsePersistedTurnSnapshotEventData(wrongChannelType).ok, false);

  const valid = parsePersistedTurnSnapshotEventData(eventData(fullSnapshot()));
  assert.equal(valid.ok, true);
});

test('malformed live snapshot events are surfaced without mutating monitor state', () => {
  const seeded = mergePromptMonitorEvent([], {
    type: 'agent.turn.snapshot',
    timestamp: 1_000,
    correlation: { turnId: 'turn-1', channelId: 'api:dm' },
    data: eventData(fullSnapshot()),
  });
  const before = structuredClone(seeded);
  const rejections: PromptMonitorSnapshotRejection[] = [];

  const malformed = fullSnapshot();
  Object.defineProperty(malformed.toolContext, 'activeTools', {
    value: [{ name: 'bad', description: 'bad', inputSchema: [] }],
    enumerable: true,
  });
  let merged = seeded;
  assert.doesNotThrow(() => {
    merged = mergePromptMonitorEvent(seeded, {
      type: 'agent.turn.snapshot',
      timestamp: 2_000,
      correlation: { turnId: 'turn-1', channelId: 'api:dm' },
      data: eventData(malformed),
    }, {
      onRejectedSnapshot(rejection) {
        rejections.push(rejection);
      },
    });
  });

  assert.deepEqual(merged, before);
  assert.deepEqual(seeded, before);
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0]?.source, 'live');
  assert.match(rejections[0]?.message ?? '', /inputSchema/u);
});

function firstObservedMemory(snapshot: ReturnType<typeof structuredSnapshot>) {
  const memory = snapshot.memory.contactEmotionalMemories[0];
  assert.ok(memory);
  return memory;
}

function firstEpisodicChain(snapshot: ReturnType<typeof structuredSnapshot>) {
  const chain = snapshot.memory.episodicChains[0];
  assert.ok(chain);
  return chain;
}

test('every malformed structured field rejects replay and live without state mutation', () => {
  const cases: Array<{
    name: string;
    expectedPath: RegExp;
    mutate(snapshot: ReturnType<typeof structuredSnapshot>): void;
  }> = [
    {
      name: 'fatigue discriminant',
      expectedPath: /snapshot\.fatigue\.decision/u,
      mutate(snapshot) {
        Object.defineProperty(snapshot.fatigue, 'decision', {
          value: 'sometimes',
          enumerable: true,
        });
      },
    },
    {
      name: 'fatigue nested range',
      expectedPath: /snapshot\.fatigue\.budget\.amount/u,
      mutate(snapshot) {
        Object.defineProperty(snapshot.fatigue.budget, 'amount', {
          value: -1,
          enumerable: true,
        });
      },
    },
    {
      name: 'adaptive capability token',
      expectedPath: /adaptiveSnapshot\.skipped\[0\]\.missingTokens\[0\]/u,
      mutate(snapshot) {
        const skipped = snapshot.toolContext.adaptiveSnapshot.skipped[0];
        assert.ok(skipped);
        Object.defineProperty(skipped.missingTokens, '0', {
          value: 'root.everything',
          enumerable: true,
        });
      },
    },
    {
      name: 'formation VAD range',
      expectedPath: /formationVAD\.valence/u,
      mutate(snapshot) {
        const memory = firstObservedMemory(snapshot);
        assert.ok(memory.formationVAD);
        memory.formationVAD.valence = 2;
      },
    },
    {
      name: 'memory provenance unknown field',
      expectedPath: /provenance.*surprise/u,
      mutate(snapshot) {
        const memory = firstObservedMemory(snapshot);
        assert.ok(memory.provenance);
        Object.defineProperty(memory.provenance, 'surprise', {
          value: true,
          enumerable: true,
        });
      },
    },
    {
      name: 'memory scope discriminant',
      expectedPath: /scopeRef\.kind/u,
      mutate(snapshot) {
        const memory = firstObservedMemory(snapshot);
        assert.ok(memory.scopeRef);
        Object.defineProperty(memory.scopeRef, 'kind', {
          value: 'everyone',
          enumerable: true,
        });
      },
    },
    {
      name: 'consent flag type',
      expectedPath: /consentFlags\.allowRecall/u,
      mutate(snapshot) {
        const memory = firstObservedMemory(snapshot);
        assert.ok(memory.consentFlags);
        Object.defineProperty(memory.consentFlags, 'allowRecall', {
          value: 'yes',
          enumerable: true,
        });
      },
    },
    {
      name: 'profile confidence range',
      expectedPath: /profile\.confidenceScore/u,
      mutate(snapshot) {
        snapshot.memory.profile.confidenceScore = 1.1;
      },
    },
    {
      name: 'emotional snapshot count',
      expectedPath: /emotionalSnapshot\.moodSamples/u,
      mutate(snapshot) {
        snapshot.memory.emotionalSnapshot.moodSamples = -1;
      },
    },
    {
      name: 'episodic nested unknown field',
      expectedPath: /episodicChains\[0\].episodes\[0\]/u,
      mutate(snapshot) {
        const episode = firstEpisodicChain(snapshot).episodes[0];
        assert.ok(episode);
        Object.defineProperty(episode, 'surprise', { value: true, enumerable: true });
      },
    },
    {
      name: 'episodic nested range',
      expectedPath: /episodicChains\[0\].episodes\[0\]/u,
      mutate(snapshot) {
        const episode = firstEpisodicChain(snapshot).episodes[0];
        assert.ok(episode);
        episode.salience.score = 2;
      },
    },
    {
      name: 'nested sparse array',
      expectedPath: /episodicChains\[0\].matchedTerms/u,
      mutate(snapshot) {
        Reflect.deleteProperty(firstEpisodicChain(snapshot).matchedTerms, '0');
      },
    },
    {
      name: 'nested non-canonical prototype',
      expectedPath: /snapshot\.memory\.profile/u,
      mutate(snapshot) {
        Object.setPrototypeOf(snapshot.memory.profile, { inherited: true });
      },
    },
  ];

  const seeded = mergePromptMonitorEvent([], {
    type: 'agent.turn.snapshot',
    timestamp: 1_000,
    correlation: { turnId: 'turn-1', channelId: 'api:dm' },
    data: eventData(structuredSnapshot()),
  });
  const before = structuredClone(seeded);

  for (const testCase of cases) {
    const malformed = structuredSnapshot();
    testCase.mutate(malformed);
    const replay = parsePersistedTurnSnapshot(malformed);
    const live = parsePersistedTurnSnapshotEventData(eventData(malformed));
    assert.equal(replay.ok, false, `${testCase.name} replay`);
    assert.equal(live.ok, false, `${testCase.name} live`);
    if (!replay.ok) assert.match(replay.error, testCase.expectedPath, testCase.name);
    if (!live.ok) assert.match(live.error, testCase.expectedPath, testCase.name);

    const rejections: PromptMonitorSnapshotRejection[] = [];
    const merged = mergePromptMonitorEvent(seeded, {
      type: 'agent.turn.snapshot',
      timestamp: 2_000,
      correlation: { turnId: 'turn-1', channelId: 'api:dm' },
      data: eventData(malformed),
    }, {
      onRejectedSnapshot(rejection) {
        rejections.push(rejection);
      },
    });
    assert.deepEqual(merged, before, `${testCase.name} merge result`);
    assert.deepEqual(seeded, before, `${testCase.name} source state`);
    assert.equal(rejections.length, 1, `${testCase.name} rejection count`);
    assert.equal(rejections[0]?.source, 'live', `${testCase.name} rejection source`);
  }
});
