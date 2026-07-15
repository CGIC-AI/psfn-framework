import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTurnRecord } from './turn-records.js';
import type {
  TurnObservabilityRecord,
  TurnSnapshotRecord,
} from '../../turns/observability.js';
import {
  createPromptPlan,
  createPromptPlanBlock,
  serializePromptPlanForProvider,
  type PromptPlan,
} from './turn-execution/prompt-plan.js';
import { rebuildProviderWireMessagesForPrompt } from './turn-execution/prompt-invocation-history.js';
import { contextMessagesToPiMessages } from '../../../primitives/llm/message-conversion.js';
import { createDmConversationScope } from '../../session/conversation-scope.js';
import { createFilesystemTurnRecordStorePort } from '../../../persistence/sessions/turn-records.js';
import { buildPromptLoomData } from '../../../operator/garden/services/session-turn-observability.js';
import type {
  ContextMessage,
  LLMProviderWireMessage,
  LLMSystemPromptTransport,
  ToolSchema,
  TurnRecord,
} from '../../../shared/contracts/runtime.js';

/**
 * Bead psfn-framework-hgw3.3: turn-record slimming (write side of hgw3.2).
 *
 * buildTurnRecord stops persisting snapshot data that is byte-derivable from
 * the canonical PromptPlan:
 *   - promptContext.providerObservability.providerWireMessages (dropped only
 *     when byte-equal to the read-side derivation; lossy turn shapes keep it)
 *   - toolContext.activeTools (dropped when byte-identical to
 *     plan.toolDefinitions)
 * and the filesystem store content-addresses plan.toolDefinitions into a
 * shared sidecar, persisting only toolDefinitionsRef.
 *
 * Generic fixture strings only — no real names, no live conversation content.
 */

const TRANSPORT: LLMSystemPromptTransport = 'anthropic_system';
const TURN_ID = '019d2326-d9e1-701d-bcee-250d2cbb0e4e';
const REQUEST_ID = 'req-slimming-1';
const CHANNEL_ID = 'api:dm-fixture';
const CURRENT_TURN_INPUT = 'current turn user input line';

function buildToolDefinitions(count: number): ToolSchema[] {
  return Array.from({ length: count }, (_, toolIndex) => ({
    name: `fixture_tool_${toolIndex}`,
    description: `Fixture tool ${toolIndex}. ${'It does a generic fixture thing. '.repeat(10)}`,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 8 }, (_, paramIndex) => [
        `param_${paramIndex}`,
        {
          type: 'string',
          description: `Parameter ${paramIndex} of fixture tool ${toolIndex}. ${'Generic usage note. '.repeat(4)}`,
        },
      ])),
      required: ['param_0'],
    },
  }));
}

function buildHistoryMessages(count: number): ContextMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `history line ${index}: ${'generic fixture sentence. '.repeat(4)}`,
  })) as ContextMessage[];
}

function buildPlan(messages: ContextMessage[], toolDefinitions: ToolSchema[]): PromptPlan {
  const blocks = [
    createPromptPlanBlock({
      id: 'static_prefix',
      layer: 'prompt_stack',
      volatility: 'static',
      producer: 'prompt-composer.static-prefix',
      scopeKey: 'global',
      renderedText: `STATIC PREFIX START\n${'identity fixture line. '.repeat(20)}\nSTATIC PREFIX END`,
    }),
    createPromptPlanBlock({
      id: 'memory.retrieval',
      layer: 'runtime',
      volatility: 'turn',
      producer: 'memory.retrieval',
      scopeKey: 'dm:fixture-contact',
      renderedText: '<memory_context>retrieved fixture memory line</memory_context>',
    }),
  ];
  return createPromptPlan({
    blocks,
    variables: { fixture_variable: 'fixture-value' },
    messages,
    toolDefinitions,
    scope: createDmConversationScope({
      channelId: CHANNEL_ID,
      contact: { contactId: 'fixture-contact', displayName: 'Fixture Contact' },
    }),
  });
}

/**
 * Reproduce the runtime's write-time provider wire capture for a plain DM text
 * turn (agent-invocation.ts): seed the system lane from the serialized plan,
 * history from plan.messages, current turn appended verbatim.
 */
function buildCapturedWire(plan: PromptPlan, currentTurnContent: string): LLMProviderWireMessage[] {
  const seeded = serializePromptPlanForProvider(plan, TRANSPORT).providerWireMessages;
  const history = contextMessagesToPiMessages(plan.messages);
  return rebuildProviderWireMessagesForPrompt(seeded, history, {
    role: 'user',
    content: currentTurnContent,
    timestamp: 1_700_000_000_100,
  });
}

function buildFatSnapshotRecord(input: {
  plan: PromptPlan;
  capturedWire: LLMProviderWireMessage[];
  currentTurnInput: string;
}): TurnSnapshotRecord {
  const activeTools = input.plan.toolDefinitions.map(tool => ({
    ...tool,
    inputSchema: structuredClone(tool.inputSchema),
  }));
  return {
    turnId: TURN_ID,
    requestId: REQUEST_ID,
    channelId: CHANNEL_ID,
    capturedAt: 1_700_000_000_200,
    trustLevel: 'regular',
    plan: input.plan,
    promptContext: {
      currentTurnInput: input.currentTurnInput,
      providerObservability: {
        routeKind: 'registered_model',
        requestedProvider: 'fixture-provider',
        requestedModel: 'fixture-model',
        backendProvider: 'fixture-provider',
        backendModel: 'fixture-model',
        backendApi: 'anthropic-messages',
        systemRole: {
          transport: TRANSPORT,
          supportsSystemRole: true,
          supportsDeveloperRole: false,
          usesOutOfBandSystemPrompt: false,
        },
        promptCaching: { configured: false, engaged: false },
        providerWireMessages: input.capturedWire,
      },
      response: {
        content: 'fixture assistant reply',
        model: 'fixture-model',
        stopReason: 'end_turn',
      },
      // A semantic decomposition distinct from plan blocks: NOT derivable,
      // must keep being persisted (confirmed by the read-side bead hgw3.2).
      finalSystemSections: [
        {
          id: 'pre_session_prompt',
          title: 'Pre-Session Prompt',
          content: 'PRE SESSION PROMPT BODY',
          charCount: 'PRE SESSION PROMPT BODY'.length,
          tokenCount: 5,
        },
      ],
    },
    toolContext: { activeTools },
    sessionContext: {
      channelId: CHANNEL_ID,
      recentEntries: [],
      compactionSummaryTexts: [],
      focusKnowledgeTexts: [],
      continuityEntries: [],
      versionPointer: 'session-fixture-pointer',
    },
  };
}

function buildObservability(snapshot: TurnSnapshotRecord): TurnObservabilityRecord {
  return {
    stages: [],
    retrievals: [],
    snapshot,
  };
}

function buildRecordForSnapshot(snapshot: TurnSnapshotRecord): TurnRecord {
  return buildTurnRecord({
    message: {
      id: 'source-message-slimming',
      channelId: CHANNEL_ID,
      channelType: 'api',
      authorId: 'fixture-user',
      authorName: 'Fixture User',
      content: CURRENT_TURN_INPUT,
      timestamp: new Date(1_700_000_000_000),
    },
    turnId: TURN_ID,
    requestId: REQUEST_ID,
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_000_500,
    userSessionEntryId: 1,
    assistantSessionEntryId: 2,
    model: 'fixture-model',
    assistantMessageContent: 'fixture assistant reply',
    turnMessages: [],
    promptMode: 'default',
    promptText: 'fixture prompt text',
    contextMessageCount: 2,
    memoryContextChars: 0,
    trustLevel: 'regular',
    speakerRole: 'user',
    retrievalProvenanceRefs: [],
    turnObservability: buildObservability(snapshot),
    hashPromptText: () => 'fixture-prompt-hash',
  });
}

function buildPlainDmFixture(): {
  plan: PromptPlan;
  fatSnapshot: TurnSnapshotRecord;
  record: TurnRecord;
} {
  const plan = buildPlan(buildHistoryMessages(12), buildToolDefinitions(16));
  const capturedWire = buildCapturedWire(plan, CURRENT_TURN_INPUT);
  const fatSnapshot = buildFatSnapshotRecord({
    plan,
    capturedWire,
    currentTurnInput: CURRENT_TURN_INPUT,
  });
  const record = buildRecordForSnapshot(structuredClone(fatSnapshot));
  return { plan, fatSnapshot, record };
}

/** Rebuild the fat-equivalent persisted record (embedded copies re-inserted). */
function buildFatEquivalentRecord(record: TurnRecord, fatSnapshot: TurnSnapshotRecord): TurnRecord {
  const fat = structuredClone(record);
  fat.observability!.snapshot = structuredClone(fatSnapshot);
  return fat;
}

describe('turn-record slimming (bead hgw3.3)', () => {
  it('drops providerWireMessages and the activeTools duplicate for a plain DM turn', () => {
    const { record } = buildPlainDmFixture();
    const snapshot = record.observability?.snapshot;

    expect(snapshot).toBeDefined();
    // Absence, not [] — the Garden read path treats [] as "captured empty".
    expect(snapshot?.promptContext?.providerObservability).not.toHaveProperty('providerWireMessages');
    // activeTools was byte-identical to plan.toolDefinitions; with no adaptive
    // snapshot the whole toolContext goes.
    expect(snapshot).not.toHaveProperty('toolContext');
    // The canonical plan and the non-derivable semantic sections stay.
    expect(snapshot?.plan?.toolDefinitions.length).toBe(16);
    expect(snapshot?.promptContext?.finalSystemSections).toHaveLength(1);
  });

  it('keeps activeTools when it diverges from plan.toolDefinitions and keeps adaptive snapshots', () => {
    const plan = buildPlan(buildHistoryMessages(2), buildToolDefinitions(2));
    const fatSnapshot = buildFatSnapshotRecord({
      plan,
      capturedWire: buildCapturedWire(plan, CURRENT_TURN_INPUT),
      currentTurnInput: CURRENT_TURN_INPUT,
    });
    // Divergent write shape: one tool got filtered from the shipped set.
    fatSnapshot.toolContext = { activeTools: fatSnapshot.toolContext!.activeTools!.slice(0, 1) };
    const record = buildRecordForSnapshot(fatSnapshot);

    expect(record.observability?.snapshot?.toolContext?.activeTools).toHaveLength(1);
  });

  it('round-trips through the filesystem store: ref on disk, resolved on read, Loom views identical', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-record-slimming-'));
    const { fatSnapshot, record } = buildPlainDmFixture();
    const store = createFilesystemTurnRecordStorePort(sessionsDir);

    store.appendTurnRecord(record);

    const rawLine = readFileSync(join(sessionsDir, '_turn_records', 'api%3Adm-fixture.jsonl'), 'utf-8');
    expect(rawLine).toContain('"toolDefinitionsRef"');
    expect(rawLine).not.toContain('"providerWireMessages"');
    expect(rawLine).not.toContain('"activeTools"');
    // Inline defs are gone from the record line (the name only lives in the sidecar).
    expect(rawLine).not.toContain('fixture_tool_0');

    const [readBack] = store.readRecentTurnRecords(CHANNEL_ID, 5);
    expect(readBack).toEqual(record);

    // Garden derives views deep-equal to the fat-record equivalents.
    const fatRecord = buildFatEquivalentRecord(record, fatSnapshot);
    const fatLoom = buildPromptLoomData(fatRecord, fatRecord.observability!.snapshot!);
    const slimLoom = buildPromptLoomData(readBack!, readBack!.observability!.snapshot!);
    expect(slimLoom).toEqual(fatLoom);
    expect(slimLoom.providerPayload.providerMessages.at(-1)?.content).toBe(CURRENT_TURN_INPUT);
    expect(slimLoom.providerPayload.activeTools.map(tool => tool.name))
      .toEqual(fatSnapshot.plan!.toolDefinitions.map(tool => tool.name));
  });

  it('persists a slim DM record at under 40% of its fat equivalent', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-record-size-'));
    const { fatSnapshot, record } = buildPlainDmFixture();
    const store = createFilesystemTurnRecordStorePort(sessionsDir);

    store.appendTurnRecord(record);

    const slimBytes = readFileSync(join(sessionsDir, '_turn_records', 'api%3Adm-fixture.jsonl'), 'utf-8').length;
    const fatBytes = JSON.stringify(buildFatEquivalentRecord(record, fatSnapshot)).length + 1;
    expect(slimBytes).toBeLessThan(fatBytes * 0.4);
  });

  describe('lossy turn shapes keep the embedded wire capture', () => {
    function buildLossySnapshot(mutateWire: (wire: LLMProviderWireMessage[]) => LLMProviderWireMessage[]): TurnSnapshotRecord {
      const plan = buildPlan(buildHistoryMessages(4), buildToolDefinitions(2));
      const capturedWire = mutateWire(buildCapturedWire(plan, CURRENT_TURN_INPUT));
      return buildFatSnapshotRecord({
        plan,
        capturedWire,
        currentTurnInput: CURRENT_TURN_INPUT,
      });
    }

    it('group-attribution turns (attributed current message) persist wire messages', () => {
      const snapshot = buildLossySnapshot(wire => wire.map((message, index) => (
        index === wire.length - 1
          ? { ...message, content: `[Fixture User (api)] ${CURRENT_TURN_INPUT}` }
          : message
      )));
      const record = buildRecordForSnapshot(snapshot);

      expect(record.observability?.snapshot?.promptContext?.providerObservability?.providerWireMessages)
        .toEqual(snapshot.promptContext!.providerObservability!.providerWireMessages);
    });

    it('system-speaker turns (attributed system note) persist wire messages', () => {
      const snapshot = buildLossySnapshot(wire => wire.map((message, index) => (
        index === wire.length - 1
          ? { ...message, content: '[System note from Fixture Operator]: maintenance complete' }
          : message
      )));
      const record = buildRecordForSnapshot(snapshot);

      expect(record.observability?.snapshot?.promptContext?.providerObservability?.providerWireMessages)
        .toEqual(snapshot.promptContext!.providerObservability!.providerWireMessages);
    });

    it('MoA turns (single collapsed prompt message) persist wire messages', () => {
      const snapshot = buildLossySnapshot(() => [{
        role: 'user',
        source: 'message',
        content: 'collapsed mixture-of-agents fixture prompt',
      }]);
      const record = buildRecordForSnapshot(snapshot);

      expect(record.observability?.snapshot?.promptContext?.providerObservability?.providerWireMessages)
        .toEqual(snapshot.promptContext!.providerObservability!.providerWireMessages);
    });
  });

  it('fails loudly in the Garden read path when a plan carries an unresolved toolDefinitionsRef', () => {
    const { fatSnapshot, record } = buildPlainDmFixture();
    const unresolved = structuredClone(fatSnapshot);
    delete unresolved.toolContext;
    const plan = unresolved.plan as unknown as Record<string, unknown>;
    delete plan.toolDefinitions;
    plan.toolDefinitionsRef = 'deadbeef';

    expect(() => buildPromptLoomData(record, unresolved)).toThrow(/unresolved toolDefinitionsRef "deadbeef"/);
  });
});
