// ── PromptPlan (E2.2) ──
// The single per-turn prompt-assembly artifact. Every producer (composer
// layers, runtime-context sections, memory blocks, session context, the
// datetime anchor) emits an ordered PromptPlanBlock INTO the plan, and
// provider serialization is a pure function OF the plan. The persisted turn
// snapshot carries the plan (schema-versioned); the Loom reads the same
// artifact that shipped to the provider. One artifact, one assembly path.
//
// SEAM (E2 epic): `variables` is the frozen TurnPromptVariableNamespace
// snapshot. When the Context Envelope lands, the 'turn'-volatility block
// inputs and the turn-phase variables are sourced from the envelope; the plan
// shape (ordered blocks + frozen variables + messages + cache boundaries)
// stays the provider-facing contract.

import type {
  ContextMessage,
  LLMProviderWireMessage,
  LLMSystemPromptTransport,
  ToolSchema,
} from '../../../../shared/contracts/runtime.js';
import type { ConversationScope } from '../../../session/conversation-scope.js';
import { countTokens } from '../../../../primitives/llm/tokens.js';
import {
  contextMessagesToPiMessages,
  type PiChatMessage,
} from '../../../../primitives/llm/message-conversion.js';

export const PROMPT_PLAN_SCHEMA_VERSION = 1 as const;

/** Canonical block id for the turn-volatile datetime proximity anchor. */
export const DATETIME_ANCHOR_BLOCK_ID = 'runtime.current_datetime';

/**
 * Volatility classes mirror the prompt variable namespace (E2.1):
 * - static: byte-stable across turns while the prompt stack is unchanged
 * - session_stable: stable for the session/scope, re-rendered on session events
 * - turn: re-rendered every turn
 */
export type PromptPlanVolatility = 'static' | 'session_stable' | 'turn';

export type PromptPlanLayer =
  /** Composer-owned prompt stack (frozen static prefix / dynamic suffix). */
  | 'prompt_stack'
  /** Per-turn runtime sections (persona adaptation, runtime context, scratchpad). */
  | 'runtime'
  /** Session-derived blocks appended by the session context builder. */
  | 'session'
  /** Provider-facing blocks (folded system-role session context, datetime anchor). */
  | 'provider';

export interface PromptPlanBlock {
  id: string;
  layer: PromptPlanLayer;
  volatility: PromptPlanVolatility;
  /** Producer module that rendered the block (E0.3 scope provenance, native). */
  producer: string;
  /** Resolved scope key ('global' | 'room:<id>' | 'dm:<contactId>') when known. */
  scopeKey?: string;
  renderedText: string;
  tokensEst: number;
}

export interface PromptPlanCachePlan {
  /** blocks[0..staticBoundary) are volatility 'static' (frozen-prefix cache line). */
  staticBoundary: number;
  /** blocks[0..sessionStableBoundary) are 'static' or 'session_stable'. */
  sessionStableBoundary: number;
}

export interface PromptPlan {
  schemaVersion: typeof PROMPT_PLAN_SCHEMA_VERSION;
  /** Ordered system-prompt blocks, exactly as serialized to the provider. */
  blocks: PromptPlanBlock[];
  /** Frozen per-turn variable namespace snapshot (TurnPromptVariableNamespace.freeze()). */
  variables: Readonly<Record<string, string>>;
  /** Session history with attribution, exactly as shipped (non-system roles). */
  messages: ContextMessage[];
  /** Tool definitions that ship to the provider for this turn. */
  toolDefinitions: ToolSchema[];
  cachePlan: PromptPlanCachePlan;
  /** The turn's ConversationScope (resolved once at session-manager ingress). */
  scope: ConversationScope;
}

// ── Datetime anchor (ordered turn-volatile block, not string surgery) ──

function readPromptVariable(variables: Readonly<Record<string, string>>, key: string): string {
  const value = variables[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Render the canonical datetime proximity anchor from the frozen variable
 * namespace. Returns '' when the runtime clock variables are absent.
 */
export function buildCurrentDatetimeProximityAnchor(
  variables: Readonly<Record<string, string>>,
): string {
  const fields = [
    ['iso', readPromptVariable(variables, 'runtime_current_datetime_iso')],
    ['timezone', readPromptVariable(variables, 'active_timezone')],
    ['weekday', readPromptVariable(variables, 'runtime_current_weekday')],
    ['date', readPromptVariable(variables, 'runtime_current_date_human')],
    ['time', readPromptVariable(variables, 'runtime_current_time_human')],
    ['today', readPromptVariable(variables, 'runtime_current_today')],
    ['yesterday', readPromptVariable(variables, 'runtime_current_yesterday')],
    ['tomorrow', readPromptVariable(variables, 'runtime_current_tomorrow')],
    ['part_of_day', readPromptVariable(variables, 'runtime_current_part_of_day')],
  ] as const;
  const renderedFields = fields
    .filter(([, value]) => value.length > 0)
    .map(([tag, value]) => `<${tag}>${value}</${tag}>`);
  if (renderedFields.length === 0) {
    return '';
  }
  return [
    '<runtime.current_datetime authority="canonical" overrides="memory,conversation_history,continuity_anchor,wake_orientation,cross_channel_continuity">',
    ...renderedFields,
    '</runtime.current_datetime>',
  ].join('\n');
}

/**
 * Fail-closed normalization: remove any stale datetime blocks that leaked into
 * upstream content (templates, memories, history summaries). The ONLY datetime
 * anchor a serialized plan may carry is the ordered DATETIME_ANCHOR_BLOCK_ID
 * block at the end of the plan.
 */
export function stripCurrentDatetimePromptBlocks(text: string): string {
  return text
    .replace(/<runtime\.current_datetime(?:\s+[^>]*)?>\s*[\s\S]*?<\/runtime\.current_datetime>/g, '')
    .replace(/<current_datetime>\s*[\s\S]*?<\/current_datetime>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Plan construction ──

export function createPromptPlanBlock(input: {
  id: string;
  layer: PromptPlanLayer;
  volatility: PromptPlanVolatility;
  producer: string;
  scopeKey?: string;
  renderedText: string;
}): PromptPlanBlock {
  return {
    id: input.id,
    layer: input.layer,
    volatility: input.volatility,
    producer: input.producer,
    ...(input.scopeKey ? { scopeKey: input.scopeKey } : {}),
    renderedText: input.renderedText,
    tokensEst: countTokens(input.renderedText),
  };
}

export function buildPromptPlanCachePlan(blocks: readonly PromptPlanBlock[]): PromptPlanCachePlan {
  let staticBoundary = 0;
  while (staticBoundary < blocks.length && blocks[staticBoundary].volatility === 'static') {
    staticBoundary += 1;
  }
  let sessionStableBoundary = staticBoundary;
  while (
    sessionStableBoundary < blocks.length
    && blocks[sessionStableBoundary].volatility === 'session_stable'
  ) {
    sessionStableBoundary += 1;
  }
  return { staticBoundary, sessionStableBoundary };
}

export function createPromptPlan(input: {
  blocks: PromptPlanBlock[];
  variables: Readonly<Record<string, string>>;
  messages: ContextMessage[];
  toolDefinitions: ToolSchema[];
  scope: ConversationScope;
}): PromptPlan {
  return {
    schemaVersion: PROMPT_PLAN_SCHEMA_VERSION,
    blocks: input.blocks,
    variables: input.variables,
    messages: input.messages,
    toolDefinitions: input.toolDefinitions,
    cachePlan: buildPromptPlanCachePlan(input.blocks),
    scope: input.scope,
  };
}

// ── Pure serialization ──

function joinBlockTexts(blocks: readonly PromptPlanBlock[]): string {
  return blocks
    .map(block => block.renderedText.trim())
    .filter(text => text.length > 0)
    .join('\n\n');
}

export function getPromptPlanBlock(
  plan: Pick<PromptPlan, 'blocks'>,
  id: string,
): PromptPlanBlock | undefined {
  return plan.blocks.find(block => block.id === id);
}

export function getPromptPlanBlockText(plan: Pick<PromptPlan, 'blocks'>, id: string): string {
  return getPromptPlanBlock(plan, id)?.renderedText ?? '';
}

/**
 * The assembled pre-session prompt (composer stack + runtime sections). This
 * is the exact text handed to the session context builder as the base system
 * prompt for the turn.
 */
export function renderPromptPlanAssembledPrompt(plan: Pick<PromptPlan, 'blocks'>): string {
  return joinBlockTexts(
    plan.blocks.filter(block => block.layer === 'prompt_stack' || block.layer === 'runtime'),
  );
}

/**
 * The final provider system prompt: every ordered block, with stale datetime
 * anchors stripped fail-closed, and the plan's own datetime anchor block
 * serialized last as the canonical clock.
 */
export function serializePromptPlanSystemPrompt(plan: Pick<PromptPlan, 'blocks'>): string {
  const anchorBlock = getPromptPlanBlock(plan, DATETIME_ANCHOR_BLOCK_ID);
  const body = stripCurrentDatetimePromptBlocks(
    joinBlockTexts(plan.blocks.filter(block => block.id !== DATETIME_ANCHOR_BLOCK_ID)),
  );
  const anchor = anchorBlock?.renderedText.trim() ?? '';
  if (!anchor) {
    return body;
  }
  return body ? `${body}\n\n${anchor}` : anchor;
}

export interface SerializedPromptPlanProviderPayload {
  systemPrompt: string;
  piMessages: PiChatMessage[];
  providerWireMessages: LLMProviderWireMessage[];
}

/**
 * Full provider serialization as a pure function of the plan: the final
 * system prompt, the provider chat messages, and the flattened wire-message
 * view recorded for observability.
 */
export function serializePromptPlanForProvider(
  plan: Pick<PromptPlan, 'blocks' | 'messages'>,
  systemRoleTransport: LLMSystemPromptTransport,
): SerializedPromptPlanProviderPayload {
  const systemPrompt = serializePromptPlanSystemPrompt(plan);
  const piMessages = contextMessagesToPiMessages(plan.messages);
  const providerWireMessages: LLMProviderWireMessage[] = [];
  if (systemPrompt) {
    providerWireMessages.push({
      role: systemRoleTransport === 'openai_developer'
        ? 'developer'
        : systemRoleTransport === 'google_system_instruction'
          ? 'system_instruction'
          : 'system',
      source: 'system_prompt',
      content: systemPrompt,
    });
  }
  for (const providerMessage of piMessages) {
    providerWireMessages.push({
      role: providerMessage.role === 'assistant' ? 'assistant' : 'user',
      source: 'message',
      content: typeof providerMessage.content === 'string'
        ? providerMessage.content
        : JSON.stringify(providerMessage.content),
    });
  }
  return { systemPrompt, piMessages, providerWireMessages };
}

export function clonePromptPlanBlock(block: PromptPlanBlock): PromptPlanBlock {
  return { ...block };
}

export function clonePromptPlan(
  plan: PromptPlan,
  cloneMessage: (message: ContextMessage) => ContextMessage,
  cloneTool: (tool: ToolSchema) => ToolSchema,
): PromptPlan {
  return {
    schemaVersion: plan.schemaVersion,
    blocks: plan.blocks.map(clonePromptPlanBlock),
    variables: { ...plan.variables },
    messages: plan.messages.map(cloneMessage),
    toolDefinitions: plan.toolDefinitions.map(cloneTool),
    cachePlan: { ...plan.cachePlan },
    scope: structuredClone(plan.scope) as ConversationScope,
  };
}
