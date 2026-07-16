import type {
  ContextMessage,
  LLMCapturedProviderWirePayload,
  LLMProviderWireMessage,
  LLMSystemPromptTransport,
  ToolSchema,
} from './runtime.js';
import { isObjectRecord } from '../utils/types.js';

export const PROMPT_PROJECTION_DATETIME_ANCHOR_BLOCK_ID = 'runtime.current_datetime';

export interface PromptProjectionBlock {
  id: string;
  layer: 'prompt_stack' | 'runtime' | 'session' | 'provider';
  renderedText: string;
}

export interface PromptProjectionPlan {
  blocks: readonly PromptProjectionBlock[];
  messages: readonly ContextMessage[];
  toolDefinitions: readonly ToolSchema[];
}

export interface PromptProjectionSnapshot {
  plan?: PromptProjectionPlan;
  promptContext?: {
    renderedStaticPrefix?: string;
    renderedDynamicSuffix?: string;
    runtimeContext?: string;
    memoryContextBlock?: string;
    scratchpadContext?: string;
    assembledPrompt?: string;
    finalSystemPrompt?: string;
    messages?: ContextMessage[];
    currentTurnInput?: string;
    providerObservability?: {
      systemRole: { transport: LLMSystemPromptTransport };
      providerWireMessages?: LLMProviderWireMessage[];
      capturedWirePayload?: LLMCapturedProviderWirePayload;
    };
  };
  toolContext?: {
    activeTools?: ToolSchema[];
  };
}

export interface PromptProjectionStrings {
  renderedStaticPrefix: string | null;
  renderedDynamicSuffix: string | null;
  runtimeContext: string | null;
  memoryContextBlock: string | null;
  scratchpadContext: string | null;
  assembledPrompt: string | null;
  finalSystemPrompt: string | null;
  contextMessages: ContextMessage[];
}

export interface PromptProjectionProviderWire {
  source: 'prompt_plan' | 'recorded_snapshot';
  legacy: boolean;
  systemRoleTransport: LLMSystemPromptTransport | null;
  systemPrompt: string | null;
  messages: LLMProviderWireMessage[];
  toolDefinitions: ToolSchema[];
  capturedWirePayload?: LLMCapturedProviderWirePayload;
}

export interface TurnSnapshotPromptProjection {
  strings: PromptProjectionStrings;
  providerMessages: LLMProviderWireMessage[];
  activeTools: ToolSchema[];
  providerWire: PromptProjectionProviderWire;
}

interface LoosePromptMessage {
  role?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
}

interface PromptContentBlock {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
  thinking?: unknown;
  thinkingSignature?: unknown;
  redacted?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

function cloneProjectionValue<T>(value: T): T {
  return structuredClone(value);
}

function cloneProviderMessages(
  messages: readonly LLMProviderWireMessage[],
): LLMProviderWireMessage[] {
  return messages.map(message => ({ ...message }));
}

function cloneToolDefinitions(tools: readonly ToolSchema[]): ToolSchema[] {
  return tools.map(tool => ({
    ...tool,
    inputSchema: cloneProjectionValue(tool.inputSchema),
  }));
}

function joinPromptProjectionBlockTexts(blocks: readonly PromptProjectionBlock[]): string {
  return blocks
    .map(block => block.renderedText.trim())
    .filter(text => text.length > 0)
    .join('\n\n');
}

export function getPromptProjectionBlockText(
  plan: Pick<PromptProjectionPlan, 'blocks'>,
  id: string,
): string {
  return plan.blocks.find(block => block.id === id)?.renderedText ?? '';
}

export function stripCurrentDatetimeProjectionBlocks(text: string): string {
  return text
    .replace(/<runtime\.current_datetime(?:\s+[^>]*)?>\s*[\s\S]*?<\/runtime\.current_datetime>/g, '')
    .replace(/<current_datetime>\s*[\s\S]*?<\/current_datetime>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function renderPromptProjectionAssembledPrompt(
  plan: Pick<PromptProjectionPlan, 'blocks'>,
): string {
  return joinPromptProjectionBlockTexts(
    plan.blocks.filter(block => block.layer === 'prompt_stack' || block.layer === 'runtime'),
  );
}

export function serializePromptProjectionSystemPrompt(
  plan: Pick<PromptProjectionPlan, 'blocks'>,
): string {
  const anchorBlock = plan.blocks.find(
    block => block.id === PROMPT_PROJECTION_DATETIME_ANCHOR_BLOCK_ID,
  );
  const body = stripCurrentDatetimeProjectionBlocks(
    joinPromptProjectionBlockTexts(
      plan.blocks.filter(block => block.id !== PROMPT_PROJECTION_DATETIME_ANCHOR_BLOCK_ID),
    ),
  );
  const anchor = anchorBlock?.renderedText.trim() ?? '';
  if (!anchor) return body;
  return body ? `${body}\n\n${anchor}` : anchor;
}

function normalizeTextImageContent(
  content: unknown,
  redactImageData = false,
): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const result: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (!isObjectRecord(block)) continue;
    const candidate: PromptContentBlock = block;
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      result.push({ type: 'text', text: candidate.text });
    } else if (
      candidate.type === 'image'
      && typeof candidate.data === 'string'
      && typeof candidate.mimeType === 'string'
    ) {
      result.push({
        type: 'image',
        data: redactImageData ? '[omitted]' : candidate.data,
        mimeType: candidate.mimeType,
      });
    }
  }
  return result;
}

function normalizeAssistantContent(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const result: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (!isObjectRecord(block)) continue;
    const candidate: PromptContentBlock = block;
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      result.push({ type: 'text', text: candidate.text });
      continue;
    }
    if (candidate.type === 'thinking' && typeof candidate.thinking === 'string') {
      result.push({
        type: 'thinking',
        thinking: candidate.thinking,
        ...(typeof candidate.thinkingSignature === 'string'
          ? { thinkingSignature: candidate.thinkingSignature }
          : {}),
        ...(candidate.redacted === true ? { redacted: true } : {}),
      });
      continue;
    }
    if (
      candidate.type === 'toolCall'
      && typeof candidate.id === 'string'
      && typeof candidate.name === 'string'
    ) {
      result.push({
        type: 'toolCall',
        id: candidate.id,
        name: candidate.name,
        arguments: isObjectRecord(candidate.arguments) ? candidate.arguments : {},
      });
    }
  }
  return result;
}

function serializeProjectionMessage(
  value: unknown,
  mode: 'provider_plan' | 'durable_history',
): LLMProviderWireMessage | null {
  if (!isObjectRecord(value)) throw new Error('PromptPlan message must be an object');
  const message: LoosePromptMessage = value;
  if (message.role === 'system') return null;
  if (message.role === 'user') {
    const blocks = normalizeTextImageContent(message.content, mode === 'durable_history');
    if (blocks.length === 0) return null;
    const textOnly = blocks.every(block => block.type === 'text');
    return {
      role: 'user',
      source: 'message',
      content: textOnly
        ? blocks.map(block => String(block.text ?? '')).join('\n')
        : JSON.stringify(blocks),
    };
  }
  if (message.role === 'assistant') {
    const blocks = normalizeAssistantContent(message.content);
    if (blocks.length === 0) return null;
    return {
      role: 'assistant',
      source: 'message',
      content: JSON.stringify(blocks),
    };
  }
  if (message.role === 'toolResult') {
    const blocks = normalizeTextImageContent(message.content, mode === 'durable_history');
    if (
      blocks.length === 0
      || typeof message.toolCallId !== 'string'
      || typeof message.toolName !== 'string'
    ) {
      return null;
    }
    return {
      // The provider-plan projection mirrors contextMessagesToPiMessages():
      // tool results are flattened into the non-assistant (user) lane. Durable
      // invocation history records the actual transcript lane as `tool`.
      role: mode === 'durable_history' ? 'tool' : 'user',
      source: 'message',
      content: JSON.stringify(blocks),
    };
  }
  throw new Error(`PromptPlan message carries unsupported role ${JSON.stringify(message.role)}`);
}

function resolveSystemWireRole(
  transport: LLMSystemPromptTransport,
): LLMProviderWireMessage['role'] {
  if (transport === 'openai_developer') return 'developer';
  if (transport === 'google_system_instruction') return 'system_instruction';
  return 'system';
}

export function serializePromptProjectionForProvider(
  plan: Pick<PromptProjectionPlan, 'blocks' | 'messages'>,
  transport: LLMSystemPromptTransport,
): { systemPrompt: string; providerWireMessages: LLMProviderWireMessage[] } {
  const systemPrompt = serializePromptProjectionSystemPrompt(plan);
  const providerWireMessages: LLMProviderWireMessage[] = [];
  if (systemPrompt) {
    providerWireMessages.push({
      role: resolveSystemWireRole(transport),
      source: 'system_prompt',
      content: systemPrompt,
    });
  }
  for (const message of plan.messages) {
    const projected = serializeProjectionMessage(message, 'provider_plan');
    if (projected) providerWireMessages.push(projected);
  }
  return { systemPrompt, providerWireMessages };
}

export function deriveProviderWireMessagesForPromptProjection(input: {
  plan: Pick<PromptProjectionPlan, 'blocks' | 'messages'>;
  transport: LLMSystemPromptTransport;
  currentTurnInput: string | undefined;
}): LLMProviderWireMessage[] {
  const serialized = serializePromptProjectionForProvider(input.plan, input.transport);
  const systemMessages = serialized.providerWireMessages.filter(
    message => message.source === 'system_prompt',
  );
  const historyMessages = input.plan.messages.flatMap(message => {
    const projected = serializeProjectionMessage(message, 'durable_history');
    return projected ? [projected] : [];
  });
  return [...systemMessages, ...historyMessages, {
    role: 'user',
    source: 'message',
    content: input.currentTurnInput ?? '',
  }];
}

function requirePlanToolDefinitions(plan: PromptProjectionPlan): readonly ToolSchema[] {
  if (!Array.isArray(plan.toolDefinitions)) {
    const record = plan as unknown as Record<string, unknown>;
    throw new Error(
      typeof record.toolDefinitionsRef === 'string'
        ? `Turn snapshot plan carries unresolved toolDefinitionsRef "${record.toolDefinitionsRef}"; records must be read through the resolving turn-record store`
        : 'Turn snapshot plan is missing toolDefinitions',
    );
  }
  return plan.toolDefinitions;
}

function deriveProjectionStrings(snapshot: PromptProjectionSnapshot | null): PromptProjectionStrings {
  const plan = snapshot?.plan;
  if (plan) {
    return {
      renderedStaticPrefix: getPromptProjectionBlockText(plan, 'static_prefix'),
      renderedDynamicSuffix: getPromptProjectionBlockText(plan, 'dynamic_suffix'),
      runtimeContext: getPromptProjectionBlockText(plan, 'runtime.context'),
      memoryContextBlock: getPromptProjectionBlockText(plan, 'memory.retrieval'),
      scratchpadContext: getPromptProjectionBlockText(plan, 'runtime.scratchpad'),
      assembledPrompt: renderPromptProjectionAssembledPrompt(plan),
      finalSystemPrompt: serializePromptProjectionSystemPrompt(plan),
      contextMessages: plan.messages.map(message => cloneProjectionValue(message)),
    };
  }
  const historical = snapshot?.promptContext;
  return {
    renderedStaticPrefix: historical?.renderedStaticPrefix ?? null,
    renderedDynamicSuffix: historical?.renderedDynamicSuffix ?? null,
    runtimeContext: historical?.runtimeContext ?? null,
    memoryContextBlock: historical?.memoryContextBlock ?? null,
    scratchpadContext: historical?.scratchpadContext ?? null,
    assembledPrompt: historical?.assembledPrompt ?? null,
    finalSystemPrompt: historical?.finalSystemPrompt ?? null,
    contextMessages: historical?.messages?.map(message => cloneProjectionValue(message)) ?? [],
  };
}

export function projectTurnSnapshotPrompt(
  snapshot: PromptProjectionSnapshot | null,
): TurnSnapshotPromptProjection {
  const plan = snapshot?.plan ?? null;
  const providerObservability = snapshot?.promptContext?.providerObservability;
  const transport = providerObservability?.systemRole.transport ?? null;
  const strings = deriveProjectionStrings(snapshot);
  const embeddedMessages = providerObservability?.providerWireMessages;
  const providerMessages = embeddedMessages !== undefined
    ? cloneProviderMessages(embeddedMessages)
    : plan && transport
      ? deriveProviderWireMessagesForPromptProjection({
        plan,
        transport,
        currentTurnInput: snapshot?.promptContext?.currentTurnInput,
      })
      : [];
  const embeddedTools = snapshot?.toolContext?.activeTools;
  const activeTools = cloneToolDefinitions(
    embeddedTools !== undefined
      ? embeddedTools
      : plan
        ? requirePlanToolDefinitions(plan)
        : [],
  );
  const capturedWirePayload = providerObservability?.capturedWirePayload;
  if (plan && transport) {
    const serialized = serializePromptProjectionForProvider(plan, transport);
    return {
      strings,
      providerMessages,
      activeTools,
      providerWire: {
        source: 'prompt_plan',
        legacy: false,
        systemRoleTransport: transport,
        systemPrompt: serialized.systemPrompt,
        messages: cloneProviderMessages(serialized.providerWireMessages),
        toolDefinitions: cloneToolDefinitions(requirePlanToolDefinitions(plan)),
        ...(capturedWirePayload
          ? { capturedWirePayload: cloneProjectionValue(capturedWirePayload) }
          : {}),
      },
    };
  }
  return {
    strings,
    providerMessages,
    activeTools,
    providerWire: {
      source: 'recorded_snapshot',
      legacy: plan === null,
      systemRoleTransport: transport,
      systemPrompt: strings.finalSystemPrompt,
      messages: cloneProviderMessages(providerMessages),
      toolDefinitions: cloneToolDefinitions(activeTools),
      ...(capturedWirePayload
        ? { capturedWirePayload: cloneProjectionValue(capturedWirePayload) }
        : {}),
    },
  };
}
