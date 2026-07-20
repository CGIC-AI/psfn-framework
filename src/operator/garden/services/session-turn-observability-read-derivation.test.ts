import { describe, expect, it } from 'vitest';
import { buildPromptLoomData } from './session-turn-observability.js';
import type { AdminSessionTurnData, AdminTurnSnapshotData } from './types.js';
import type { ContextMessage, LLMSystemPromptTransport } from '../../../shared/contracts/runtime.js';
import {
  createPromptPlan,
  createPromptPlanBlock,
  DATETIME_ANCHOR_BLOCK_ID,
  serializePromptPlanForProvider,
  type PromptPlan,
} from '../../../core/agent/substrate-agent/turn-execution/prompt-plan.js';
import { rebuildProviderWireMessagesForPrompt } from '../../../core/agent/substrate-agent/turn-execution/prompt-invocation-history.js';
import { contextMessagesToPiMessages } from '../../../primitives/llm/message-conversion.js';
import { createDmConversationScope } from '../../../core/session/conversation-scope.js';

/**
 * Bead psfn-framework-hgw3.2: Loom read-path derivation.
 *
 * The persisted turn snapshot embeds three duplicated copies of data that are
 * derivable from the canonical PromptPlan:
 *   - promptContext.providerObservability.providerWireMessages
 *   - toolContext.activeTools           (byte-identical to plan.toolDefinitions)
 *   - promptContext.finalSystemSections (a plan-block projection)
 *
 * These tests prove that when a "slim" record omits those fields, the Loom read
 * path reconstructs each view from the canonical fields, and that a "fat" record
 * (embedded copy present) keeps rendering the embedded copy verbatim.
 *
 * No real conversation content or names — generic fixture strings only.
 */

const TRANSPORT: LLMSystemPromptTransport = 'anthropic_system';
const CURRENT_TURN_INPUT = 'current turn user input line';

function buildPlan(messages: ContextMessage[]): PromptPlan {
  const blocks = [
    createPromptPlanBlock({
      id: 'static_prefix',
      layer: 'prompt_stack',
      volatility: 'static',
      producer: 'prompt-composer.static-prefix',
      scopeKey: 'global',
      renderedText: 'STATIC PREFIX START\nidentity line one.\nidentity line two.\nSTATIC PREFIX END',
    }),
    createPromptPlanBlock({
      id: 'core_memory',
      layer: 'runtime',
      volatility: 'session_stable',
      producer: 'core-memory.blocks',
      scopeKey: 'dm:contact-1',
      renderedText: '<core_memory>persona and human blocks</core_memory>',
    }),
    createPromptPlanBlock({
      id: 'memory.retrieval',
      layer: 'runtime',
      volatility: 'turn',
      producer: 'memory.retrieval',
      scopeKey: 'dm:contact-1',
      renderedText: '<memory_context>retrieved memory line</memory_context>',
    }),
    createPromptPlanBlock({
      id: DATETIME_ANCHOR_BLOCK_ID,
      layer: 'provider',
      volatility: 'turn',
      producer: 'runtime-context.current-datetime',
      scopeKey: 'global',
      renderedText:
        '<runtime.current_datetime authority="canonical" overrides="memory,conversation_history,cross_channel_continuity">\n<iso>2026-07-01T12:00:00-04:00</iso>\n</runtime.current_datetime>',
    }),
  ];
  return createPromptPlan({
    blocks,
    variables: { runtime_current_datetime_iso: '2026-07-01T12:00:00-04:00' },
    messages,
    toolDefinitions: [
      {
        name: 'memory_search',
        description: 'Search stored memories.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
      {
        name: 'lookup_tool',
        description: 'Look something up.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    ],
    scope: createDmConversationScope({
      channelId: 'discord:dm:contact-1',
      contact: { contactId: 'contact-1', displayName: 'Contact One' },
    }),
  });
}

/**
 * Reproduce the runtime's write-time provider wire capture (agent-invocation.ts):
 * seed the system lane from the serialized plan, convert plan.messages into the
 * provider history, and append the current turn. This is the embedded copy a fat
 * record persists; the Loom derivation must reproduce it byte-for-byte.
 */
function buildEmbeddedWire(plan: PromptPlan, currentTurnInput: string) {
  const seeded = serializePromptPlanForProvider(plan, TRANSPORT).providerWireMessages;
  const history = contextMessagesToPiMessages(plan.messages);
  return rebuildProviderWireMessagesForPrompt(seeded, history, {
    role: 'user',
    content: currentTurnInput,
    timestamp: 0,
  });
}

function buildFatSnapshot(plan: PromptPlan, currentTurnInput: string): AdminTurnSnapshotData {
  const activeTools = plan.toolDefinitions.map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema } }));
  return {
    turnId: 'turn-fat',
    requestId: 'request-1',
    channelId: 'discord:dm:contact-1',
    capturedAt: 3_000,
    trustLevel: 'regular',
    plan,
    promptContext: {
      currentTurnInput,
      providerObservability: {
        routeKind: 'registered_model',
        requestedProvider: 'anthropic',
        requestedModel: 'model-x',
        backendProvider: 'anthropic',
        backendModel: 'model-x',
        backendApi: 'anthropic-messages',
        systemRole: {
          transport: TRANSPORT,
          supportsSystemRole: true,
          supportsDeveloperRole: false,
          usesOutOfBandSystemPrompt: false,
        },
        promptCaching: { configured: false, engaged: false },
        providerWireMessages: buildEmbeddedWire(plan, currentTurnInput),
      },
      // A semantic decomposition distinct from the plan blocks (titled sections,
      // ids that do not match plan block ids) — the real write-time shape.
      finalSystemSections: [
        {
          id: 'pre_session_prompt',
          title: 'Pre-Session Prompt',
          content: 'PRE SESSION PROMPT BODY',
          charCount: 'PRE SESSION PROMPT BODY'.length,
          tokenCount: 5,
        },
        {
          id: 'session_context',
          title: 'Session Context',
          content: '<session_context>context body</session_context>',
          charCount: '<session_context>context body</session_context>'.length,
          tokenCount: 7,
        },
      ],
    },
    toolContext: { activeTools },
  } as unknown as AdminTurnSnapshotData;
}

/** Drop the three duplicated fields the follow-up bead stops persisting. */
function toSlimSnapshot(fat: AdminTurnSnapshotData): AdminTurnSnapshotData {
  const slim = structuredClone(fat) as AdminTurnSnapshotData;
  const promptContext = slim.promptContext as Record<string, unknown> | undefined;
  const providerObservability = promptContext?.providerObservability as Record<string, unknown> | undefined;
  if (providerObservability) delete providerObservability.providerWireMessages;
  if (promptContext) delete promptContext.finalSystemSections;
  delete (slim as Record<string, unknown>).toolContext;
  return slim;
}

function minimalRecord(): AdminSessionTurnData['record'] {
  return {
    turnId: 'turn-fat',
    channelId: 'discord:dm:contact-1',
    requestId: 'request-1',
    userMessage: { role: 'user', content: 'hello' },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
  } as unknown as AdminSessionTurnData['record'];
}

describe('Loom read-path derivation (bead hgw3.2)', () => {
  describe('provider wire messages', () => {
    it('derives system + history + current turn when the embedded copy is absent', () => {
      const plan = buildPlan([
        { role: 'user', content: 'history user line one' },
        { role: 'assistant', content: 'history assistant line one' },
      ] as ContextMessage[]);
      const fat = buildFatSnapshot(plan, CURRENT_TURN_INPUT);
      const slim = toSlimSnapshot(fat);

      const fatLoom = buildPromptLoomData(minimalRecord(), fat);
      const slimLoom = buildPromptLoomData(minimalRecord(), slim);

      // The fat record renders the embedded copy verbatim.
      expect(fatLoom.providerPayload.providerMessages).toEqual(
        fat.promptContext!.providerObservability!.providerWireMessages,
      );
      // The slim record derives the identical view.
      expect(slimLoom.providerPayload.providerMessages).toEqual(
        fatLoom.providerPayload.providerMessages,
      );
      // Shape sanity: one system entry, two history entries, one current turn.
      const roles = slimLoom.providerPayload.providerMessages.map(message => message.role);
      expect(roles[0]).toBe('system');
      expect(slimLoom.providerPayload.providerMessages).toHaveLength(1 + 2 + 1);
      expect(slimLoom.providerPayload.providerMessages.at(-1)?.content).toBe(CURRENT_TURN_INPUT);
    });

    it('derives tool-call turns (tool role) from plan.messages', () => {
      const plan = buildPlan([
        { role: 'user', content: 'please look that up' },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'lookup_tool', arguments: { query: 'q' } }] },
        { role: 'toolResult', toolCallId: 'call-1', toolName: 'lookup_tool', content: 'lookup result payload' },
      ] as unknown as ContextMessage[]);
      const fat = buildFatSnapshot(plan, CURRENT_TURN_INPUT);
      const slim = toSlimSnapshot(fat);

      const fatLoom = buildPromptLoomData(minimalRecord(), fat);
      const slimLoom = buildPromptLoomData(minimalRecord(), slim);

      expect(slimLoom.providerPayload.providerMessages).toEqual(
        fatLoom.providerPayload.providerMessages,
      );
      // The tool result maps to a `tool` wire role (proves tool-call handling).
      const roles = slimLoom.providerPayload.providerMessages.map(message => message.role);
      expect(roles).toContain('tool');
    });

    it('derives a system + current-turn wire for empty history', () => {
      const plan = buildPlan([] as ContextMessage[]);
      const fat = buildFatSnapshot(plan, CURRENT_TURN_INPUT);
      const slim = toSlimSnapshot(fat);

      const fatLoom = buildPromptLoomData(minimalRecord(), fat);
      const slimLoom = buildPromptLoomData(minimalRecord(), slim);

      expect(slimLoom.providerPayload.providerMessages).toEqual(
        fatLoom.providerPayload.providerMessages,
      );
      expect(slimLoom.providerPayload.providerMessages).toHaveLength(1 + 0 + 1);
      expect(slimLoom.providerPayload.providerMessages[0]?.role).toBe('system');
      expect(slimLoom.providerPayload.providerMessages.at(-1)?.content).toBe(CURRENT_TURN_INPUT);
    });
  });

  describe('active tools', () => {
    it('falls back to plan.toolDefinitions (byte-identical) when toolContext is absent', () => {
      const plan = buildPlan([{ role: 'user', content: 'hi' }] as ContextMessage[]);
      const fat = buildFatSnapshot(plan, CURRENT_TURN_INPUT);
      const slim = toSlimSnapshot(fat);

      const fatLoom = buildPromptLoomData(minimalRecord(), fat);
      const slimLoom = buildPromptLoomData(minimalRecord(), slim);

      // Fat renders the embedded activeTools verbatim; slim derives from the plan.
      expect(fatLoom.providerPayload.activeTools).toEqual(slimLoom.providerPayload.activeTools);
      expect(slimLoom.providerPayload.activeTools.map(tool => tool.name)).toEqual([
        'memory_search',
        'lookup_tool',
      ]);
      expect(slimLoom.providerPayload.activeTools).toEqual(plan.toolDefinitions);
    });
  });

  describe('final system sections', () => {
    it('prefers the embedded semantic sections verbatim for fat records', () => {
      const plan = buildPlan([{ role: 'user', content: 'hi' }] as ContextMessage[]);
      const fat = buildFatSnapshot(plan, CURRENT_TURN_INPUT);

      const fatLoom = buildPromptLoomData(minimalRecord(), fat);

      expect(fatLoom.generatedPrompt.finalSystemSections).toEqual(
        fat.promptContext!.finalSystemSections,
      );
    });

    it('derives a plan-block projection when the embedded sections are absent', () => {
      const plan = buildPlan([{ role: 'user', content: 'hi' }] as ContextMessage[]);
      const fat = buildFatSnapshot(plan, CURRENT_TURN_INPUT);
      const slim = toSlimSnapshot(fat);

      const slimLoom = buildPromptLoomData(minimalRecord(), slim);

      // One section per non-empty plan block, in block order, carrying the block
      // renderedText and token estimate.
      expect(slimLoom.generatedPrompt.finalSystemSections).toEqual(
        plan.blocks.map(block => ({
          id: block.id,
          title: block.id,
          content: block.renderedText,
          charCount: block.renderedText.length,
          tokenCount: block.tokensEst,
        })),
      );
    });
  });
});
