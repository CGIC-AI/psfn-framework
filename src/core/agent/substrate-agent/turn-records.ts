import type { AgentMessage } from '../../../boundary/pi-agent/index.js';
import type { AssistantMessage, TextContent, ToolResultMessage } from '@mariozechner/pi-ai';
import type { SessionManager } from '../../session/manager.js';
import type { AgentResponse, MessagePromptOverrideMode, SubstrateMessage, TurnID, TurnRecord, TurnRecordToolCall, TurnUsage } from '../../../shared/contracts/runtime.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import { normalizeChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import type { TurnSnapshot } from '../../turns/snapshot.js';
import type { TurnObservabilityRecord } from '../../turns/observability.js';
import { cloneTurnObservabilityRecord, cloneUnknownValue } from '../../turns/observability.js';
import type { EmotionStateSnapshot } from '../../emotion/state.js';
import { buildSessionMetadataWithEmotionState } from '../../emotion/session-metadata.js';
import type { TurnToolSummary } from '../../../faculties/skills/reflection-nudge.js';
import { normalizeRoleEnvelopeRefs } from '../../internal-role-envelopes/projections.js';
import { normalizeToolArguments } from '../../../shared/tool-argument-normalization.js';

const INTERNAL_SHARD_SOURCE_PARAM = '__psfnShardSource';
const REASONING_PLACEHOLDER_VALUES = new Set(['none', 'null', 'n/a', 'na', 'nil', 'undefined']);
const REASONING_CONTAMINATION_PATTERNS = [
  /\[scratchpad\]/i,
  /working notes \(short-term, may be stale; verify before acting\)/i,
  /runtime\.scratchpad/i,
  /internal-only thinking/i,
  /hidden reasoning/i,
  /candidate failed; trying fallback/i,
  /please write a ```repl code block/i,
  /toolset with action/i,
  /```/,
];

function resolveSessionChannelMeta(message: SubstrateMessage): ChannelMeta | undefined {
  const privacyLevel = normalizeChannelPrivacy(message.routing?.channelPrivacy);
  if (message.isDirectMessage === undefined && !privacyLevel) return undefined;
  return {
    ...(message.isDirectMessage !== undefined ? { isDirectMessage: message.isDirectMessage } : {}),
    ...(privacyLevel ? { privacyLevel } : {}),
  };
}

export function recordUserMessage(input: {
  sessionManager: SessionManager;
  message: SubstrateMessage;
  turnId: TurnID;
  requestId: string;
  trustLevel: TrustLevel;
  continuityUserId?: string;
  contentOverride?: string;
}): number | null {
  const content = input.contentOverride ?? input.message.content;
  if (input.continuityUserId) {
    return input.sessionManager.recordUserMessage(
      input.message.channelId,
      content,
      input.message.authorId,
      input.message.authorName,
      input.message.isDirectMessage,
      input.continuityUserId,
      {
        trustLevel: input.trustLevel,
        turnId: input.turnId,
        requestId: input.requestId,
        sourceMessageId: input.message.id,
        channelMeta: resolveSessionChannelMeta(input.message),
      },
    );
  }

  return input.sessionManager.recordUserMessage(
    input.message.channelId,
    content,
    input.message.authorId,
    input.message.authorName,
    input.message.isDirectMessage,
    undefined,
    {
      trustLevel: input.trustLevel,
      turnId: input.turnId,
      requestId: input.requestId,
      sourceMessageId: input.message.id,
      channelMeta: resolveSessionChannelMeta(input.message),
    },
  );
}

export function recordAssistantMessage(input: {
  sessionManager: SessionManager;
  message: SubstrateMessage;
  turnId: TurnID;
  requestId: string;
  responseText: string;
  trustLevel: TrustLevel;
  continuityUserId?: string;
  emotionSnapshot?: EmotionStateSnapshot | null;
}): number | null {
  const metadata = input.emotionSnapshot
    ? buildSessionMetadataWithEmotionState(undefined, input.emotionSnapshot)
    : undefined;

  if (input.continuityUserId) {
    return input.sessionManager.recordAssistantMessage(
      input.message.channelId,
      input.responseText,
      input.message.authorId,
      input.message.isDirectMessage,
      input.continuityUserId,
      {
        trustLevel: input.trustLevel,
        turnId: input.turnId,
        requestId: input.requestId,
        sourceMessageId: input.message.id,
        ...(metadata ? { metadata } : {}),
        channelMeta: resolveSessionChannelMeta(input.message),
      },
    );
  }

  return input.sessionManager.recordAssistantMessage(
    input.message.channelId,
    input.responseText,
    input.message.authorId,
    input.message.isDirectMessage,
    undefined,
    {
      trustLevel: input.trustLevel,
      turnId: input.turnId,
      requestId: input.requestId,
      sourceMessageId: input.message.id,
      ...(metadata ? { metadata } : {}),
      channelMeta: resolveSessionChannelMeta(input.message),
    },
  );
}

export function recordToolObservations(input: {
  sessionManager: SessionManager;
  message: SubstrateMessage;
  turnId: TurnID;
  requestId: string;
  turnMessages: AgentMessage[];
  trustLevel: TrustLevel;
}): void {
  for (const entry of input.turnMessages) {
    if (!isToolResultAgentMessage(entry)) continue;
    input.sessionManager.recordToolObservation(
      input.message.channelId,
      {
        toolName: entry.toolName,
        content: extractToolResultText(entry),
        ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
        ...(typeof entry.isError === 'boolean' ? { isError: entry.isError } : {}),
      },
      input.message.isDirectMessage,
      {
        trustLevel: input.trustLevel,
        turnId: input.turnId,
        requestId: input.requestId,
        sourceMessageId: input.message.id,
        channelMeta: resolveSessionChannelMeta(input.message),
      },
    );
  }
}

export function buildTurnRecord(input: {
  message: SubstrateMessage;
  turnId: TurnID;
  requestId: string;
  startedAt: number;
  completedAt: number;
  userSessionEntryId: number | null;
  assistantSessionEntryId: number | null;
  response?: AgentResponse;
  model?: string;
  assistantMessageContent?: string;
  turnMessages: AgentMessage[];
  status?: TurnRecord['status'];
  promptMode: MessagePromptOverrideMode;
  promptText: string;
  contextMessageCount: number;
  memoryContextChars: number;
  trustLevel: TrustLevel;
  speakerRole: 'user' | 'system';
  canonicalContactKey?: string;
  retrievalProvenanceRefs: string[];
  roleEnvelopeRefs?: string[];
  turnSnapshot?: TurnSnapshot;
  turnObservability?: TurnObservabilityRecord;
  internalStateSnapshotRef?: string;
  persistedUserMessageContent?: string;
  hashPromptText: (text: string) => string;
}): TurnRecord {
  const toolCalls = buildTurnToolCalls(input.turnMessages);
  const roleEnvelopeRefs = normalizeRoleEnvelopeRefs(input.roleEnvelopeRefs);
  const provenanceRefs = [...new Set([
    `turn:${input.turnId}`,
    ...input.retrievalProvenanceRefs,
  ])];
  const status = input.status ?? 'completed';
  const assistantMessageContent = (input.assistantMessageContent ?? input.response?.content ?? '').trim();
  const model = input.response?.metadata.model ?? input.model?.trim();
  if (!model) {
    throw new Error('Turn record requires response metadata model or explicit model');
  }

  const observability = cloneTurnObservabilityForRecord(input.turnObservability);

  // Durable satellite/place origin. Fail-closed: only recorded when the turn
  // actually carried a bound placeId (see satellite→place binding). Nothing is
  // fabricated for non-satellite or unbound turns.
  const satelliteRouting = input.message.routing?.satellite;
  const boundPlaceId = satelliteRouting?.placeId?.trim();
  const location = boundPlaceId
    ? {
      placeId: boundPlaceId,
      ...(satelliteRouting?.satelliteId.trim()
        ? { satelliteId: satelliteRouting.satelliteId.trim() }
        : {}),
    }
    : undefined;

  return {
    schemaVersion: 1,
    turnId: input.turnId,
    requestId: input.requestId,
    channelId: input.message.channelId,
    channelType: input.message.channelType,
    startedAt: input.startedAt,
    completedAt: Math.max(input.startedAt, input.completedAt),
    status,
    ...(location ? { location } : {}),
    userMessage: {
      role: input.speakerRole,
      content: input.persistedUserMessageContent ?? input.message.content,
      timestamp: input.message.timestamp.getTime(),
      sourceMessageId: input.message.id,
      authorId: input.message.authorId,
      authorName: input.message.authorName,
      ...(input.userSessionEntryId != null ? { sessionEntryId: input.userSessionEntryId } : {}),
    },
    ...(assistantMessageContent
      ? {
        assistantMessage: {
          role: 'assistant' as const,
          content: assistantMessageContent,
          timestamp: Math.max(input.startedAt, input.completedAt),
          sourceMessageId: input.message.id,
          ...(input.assistantSessionEntryId != null ? { sessionEntryId: input.assistantSessionEntryId } : {}),
        },
      }
      : {}),
    toolCalls,
    contextManifestRef: `session:${input.message.channelId}|messages:${input.contextMessageCount}|memory_chars:${input.memoryContextChars}`,
    internalStateSnapshotRef: [
      `trust:${input.trustLevel}`,
      `contact:${input.canonicalContactKey ?? 'none'}`,
      `prompt:${input.turnSnapshot?.prompt?.versionPointer ?? 'none'}`,
      `memory:${input.turnSnapshot?.memory?.versionPointer ?? 'none'}`,
      `session:${input.turnSnapshot?.sessionContext?.versionPointer ?? 'none'}`,
      `self:${input.internalStateSnapshotRef ?? 'none'}`,
    ].join('|'),
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    ...(roleEnvelopeRefs.length > 0 ? { roleEnvelopeRefs } : {}),
    ...(observability
      ? { observability }
      : {}),
    versionPointers: {
      model,
      promptMode: input.promptMode,
      promptHash: input.hashPromptText(input.promptText),
      ...(input.turnSnapshot?.prompt?.versionPointer
        ? { promptStack: input.turnSnapshot.prompt.versionPointer }
        : {}),
      ...(input.turnSnapshot?.memory?.versionPointer
        ? { memoryState: input.turnSnapshot.memory.versionPointer }
        : {}),
      ...(input.turnSnapshot?.sessionContext?.versionPointer
        ? { sessionState: input.turnSnapshot.sessionContext.versionPointer }
        : {}),
    },
    provenanceRefs,
  };
}

export function accumulateTurnUsage(messages: AgentMessage[], contextWindow: number): TurnUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let llmCalls = 0;
  let toolCalls = 0;
  let maxInputTokens = 0;
  let estimatedCostUsd = 0;

  for (const message of messages) {
    if (isAssistantAgentMessage(message)) {
      llmCalls += 1;
      inputTokens += message.usage.input;
      outputTokens += message.usage.output;
      cacheReadTokens += message.usage.cacheRead;
      maxInputTokens = Math.max(maxInputTokens, message.usage.input);
      estimatedCostUsd += message.usage.cost.total;
      continue;
    }

    if (isToolResultAgentMessage(message)) {
      toolCalls += 1;
    }
  }

  const contextUtilization = contextWindow > 0
    ? Math.min(100, (maxInputTokens / contextWindow) * 100)
    : 0;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    llmCalls,
    toolCalls,
    contextUtilization,
    ...(estimatedCostUsd > 0 ? { estimatedCostUsd } : {}),
  };
}

export function buildTurnToolSummary(turnMessages: AgentMessage[]): TurnToolSummary {
  let toolCalls = 0;
  let usedThinkTool = false;
  for (const msg of turnMessages) {
    if (isToolResultAgentMessage(msg)) {
      toolCalls += 1;
      if (msg.toolName === 'analysis_workbench') {
        usedThinkTool = true;
      }
    }
  }
  return { toolCalls, usedThinkTool };
}

export function isAssistantAgentMessage(message: AgentMessage): message is AssistantMessage {
  return (message as { role?: string }).role === 'assistant';
}

export function isToolResultAgentMessage(message: AgentMessage): message is ToolResultMessage {
  return (message as { role?: string }).role === 'toolResult';
}

export function sanitizePersistedReasoningText(reasoning: string | undefined): string | undefined {
  if (typeof reasoning !== 'string') return undefined;
  const normalized = reasoning
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
  if (!normalized) return undefined;
  if (REASONING_PLACEHOLDER_VALUES.has(normalized.toLowerCase())) return undefined;
  if (normalized.length > 280) return undefined;
  if (normalized.split('\n').length > 3) return undefined;
  if (REASONING_CONTAMINATION_PATTERNS.some(pattern => pattern.test(normalized))) return undefined;
  return normalized;
}

function buildTurnToolCalls(turnMessages: AgentMessage[]): TurnRecordToolCall[] {
  const toolCalls: TurnRecordToolCall[] = [];
  const toolCallsById = new Map<string, TurnRecordToolCall>();
  for (const entry of turnMessages) {
    if (isAssistantAgentMessage(entry)) {
      const rationale = extractAssistantReasoning(entry);
      for (const toolCall of extractAssistantToolCalls(entry)) {
        const normalizedArguments = normalizeToolArguments(toolCall.name, toolCall.arguments);
        const provenanceRefs = collectToolProvenanceRefs({
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          argumentsValue: normalizedArguments,
        });
        const record: TurnRecordToolCall = {
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          ...(hasOwnKeys(normalizedArguments)
            ? { arguments: cloneUnknownValue(normalizedArguments) as Record<string, unknown> }
            : {}),
          ...(provenanceRefs.length > 0 ? { provenanceRefs } : {}),
          ...(rationale ? { rationale } : {}),
          ...(toolCall.thoughtSignature?.trim()
            ? { thoughtSignature: toolCall.thoughtSignature.trim() }
            : {}),
        };
        toolCalls.push(record);
        toolCallsById.set(toolCall.id, record);
      }
      continue;
    }

    if (!isToolResultAgentMessage(entry)) continue;
    const target = toolCallsById.get(entry.toolCallId);
    const resultText = extractToolResultText(entry).trim();
    const toolResultFields = {
      ...(typeof entry.isError === 'boolean' ? { isError: entry.isError } : {}),
      ...(resultText ? { resultText } : {}),
      ...(entry.details !== undefined ? { details: cloneUnknownValue(entry.details) } : {}),
    };
    const provenanceRefs = collectToolProvenanceRefs({
      toolName: entry.toolName,
      toolCallId: entry.toolCallId,
      details: entry.details,
      existing: target?.provenanceRefs,
    });

    if (target) {
      Object.assign(target, toolResultFields);
      if (provenanceRefs.length > 0) {
        target.provenanceRefs = provenanceRefs;
      }
      continue;
    }

    toolCalls.push({
      toolName: entry.toolName,
      toolCallId: entry.toolCallId,
      ...(provenanceRefs.length > 0 ? { provenanceRefs } : {}),
      ...toolResultFields,
    });
  }
  return toolCalls;
}

type AssistantToolCall = Extract<AssistantMessage['content'][number], { type: 'toolCall' }>;

function extractAssistantToolCalls(message: AssistantMessage): AssistantToolCall[] {
  return message.content.filter((block): block is AssistantToolCall => block.type === 'toolCall');
}

function extractAssistantReasoning(message: AssistantMessage): string | undefined {
  const reasoning = message.content
    .filter((block): block is Extract<AssistantMessage['content'][number], { type: 'thinking' }> => (
      block.type === 'thinking' && typeof block.thinking === 'string'
    ))
    .map(block => block.thinking.trim())
    .filter(Boolean)
    .join('\n\n');
  return sanitizePersistedReasoningText(reasoning);
}

function cloneTurnObservabilityForRecord(
  turnObservability: TurnObservabilityRecord | undefined,
): TurnObservabilityRecord | undefined {
  if (!turnObservability) return undefined;
  const cloned = cloneTurnObservabilityRecord(turnObservability);
  const sanitizedReasoning = sanitizePersistedReasoningText(
    cloned.snapshot?.promptContext?.response?.reasoning,
  );
  if (cloned.snapshot?.promptContext?.response) {
    if (sanitizedReasoning) {
      cloned.snapshot.promptContext.response.reasoning = sanitizedReasoning;
    } else {
      delete cloned.snapshot.promptContext.response.reasoning;
    }
  }
  return cloned;
}

function hasOwnKeys(value: Record<string, unknown> | undefined): boolean {
  return Object.keys(value ?? {}).length > 0;
}

function collectToolProvenanceRefs(input: {
  toolName: string;
  toolCallId?: string;
  argumentsValue?: Record<string, unknown>;
  details?: unknown;
  existing?: string[];
}): string[] {
  const refs = new Set<string>();
  for (const ref of input.existing ?? []) {
    const normalized = ref.trim();
    if (normalized) refs.add(normalized);
  }

  const invocationRef = buildToolInvocationProvenanceRef(
    input.toolName,
    input.toolCallId,
    input.argumentsValue,
  );
  if (invocationRef) refs.add(invocationRef);

  collectProvenanceRefsFromUnknown(input.details, refs, false);
  return [...refs];
}

function buildToolInvocationProvenanceRef(
  toolName: string,
  toolCallId: string | undefined,
  argumentsValue: Record<string, unknown> | undefined,
): string | undefined {
  const normalizedToolName = toolName.trim();
  const normalizedToolCallId = toolCallId?.trim();
  if (!normalizedToolName || !normalizedToolCallId) return undefined;
  const shardSource = normalizeShardSource(argumentsValue?.[INTERNAL_SHARD_SOURCE_PARAM]);
  if (shardSource) {
    return `source:${shardSource}|tool:${normalizedToolName}|invocation:${normalizedToolCallId}`;
  }
  return `source:tool:${normalizedToolName}|invocation:${normalizedToolCallId}`;
}

function normalizeShardSource(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function collectProvenanceRefsFromUnknown(
  value: unknown,
  refs: Set<string>,
  collectDirectString: boolean,
): void {
  if (typeof value === 'string') {
    if (!collectDirectString) return;
    const normalized = value.trim();
    if (normalized) refs.add(normalized);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectProvenanceRefsFromUnknown(entry, refs, collectDirectString);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    const shouldCollectString = key === 'provenanceRef'
      || key === 'sourceRef'
      || key === 'provenanceRefs'
      || key === 'sourceRefs';
    collectProvenanceRefsFromUnknown(entry, refs, shouldCollectString);
  }
}

function extractToolResultText(message: ToolResultMessage): string {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .filter((block): block is TextContent => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('');
    if (textParts.trim()) {
      return textParts;
    }

    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }

  return '';
}
