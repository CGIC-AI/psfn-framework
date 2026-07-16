import assert from 'node:assert/strict';
import test from 'node:test';
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
