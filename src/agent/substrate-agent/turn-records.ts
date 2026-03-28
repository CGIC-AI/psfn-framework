import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, TextContent, ToolResultMessage } from '@mariozechner/pi-ai';
import type { SessionManager } from '../../session/manager.js';
import type { AgentResponse, MessagePromptOverrideMode, SubstrateMessage, TurnID, TurnRecord, TurnRecordToolCall, TurnUsage } from '../../shared/contracts/runtime.js';
import { normalizeChannelVisibility, type TrustLevel } from '../../trust/types.js';
import type { ChannelMeta } from '../../trust/policy.js';
import type { TurnSnapshot } from '../../core/turns/snapshot.js';
import type { TurnObservabilityRecord } from '../../core/turns/observability.js';
import { cloneTurnObservabilityRecord } from '../../core/turns/observability.js';
import type { EmotionStateSnapshot } from '../../core/emotion/state.js';
import { buildSessionMetadataWithEmotionState } from '../../core/emotion/session-metadata.js';
import type { TurnToolSummary } from '../../skills/reflection-nudge.js';
import { normalizeRoleEnvelopeRefs } from '../../internal-role-envelopes/projections.js';

function resolveSessionChannelMeta(message: SubstrateMessage): ChannelMeta | undefined {
  const privacyLevel = normalizeChannelVisibility(message.routing?.channelPrivacy);
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
}): number | null {
  if (input.continuityUserId) {
    return input.sessionManager.recordUserMessage(
      input.message.channelId,
      input.message.content,
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
    input.message.content,
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
  response: AgentResponse;
  turnMessages: AgentMessage[];
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
  hashPromptText: (text: string) => string;
}): TurnRecord {
  const toolCalls = buildTurnToolCalls(input.turnMessages);
  const roleEnvelopeRefs = normalizeRoleEnvelopeRefs(input.roleEnvelopeRefs);
  const provenanceRefs = [...new Set([
    `turn:${input.turnId}`,
    ...input.retrievalProvenanceRefs,
  ])];

  return {
    schemaVersion: 1,
    turnId: input.turnId,
    requestId: input.requestId,
    channelId: input.message.channelId,
    channelType: input.message.channelType,
    startedAt: input.startedAt,
    completedAt: Math.max(input.startedAt, input.completedAt),
    status: 'completed',
    userMessage: {
      role: input.speakerRole,
      content: input.message.content,
      timestamp: input.message.timestamp.getTime(),
      sourceMessageId: input.message.id,
      authorId: input.message.authorId,
      authorName: input.message.authorName,
      ...(input.userSessionEntryId != null ? { sessionEntryId: input.userSessionEntryId } : {}),
    },
    assistantMessage: {
      role: 'assistant',
      content: input.response.content,
      timestamp: Math.max(input.startedAt, input.completedAt),
      sourceMessageId: input.message.id,
      ...(input.assistantSessionEntryId != null ? { sessionEntryId: input.assistantSessionEntryId } : {}),
    },
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
    ...(input.turnObservability
      ? { observability: cloneTurnObservabilityRecord(input.turnObservability) }
      : {}),
    versionPointers: {
      model: input.response.metadata.model,
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
      if (msg.toolName === 'think') {
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

function buildTurnToolCalls(turnMessages: AgentMessage[]): TurnRecordToolCall[] {
  const toolCalls: TurnRecordToolCall[] = [];
  for (const entry of turnMessages) {
    if (!isToolResultAgentMessage(entry)) continue;
    toolCalls.push({
      toolName: entry.toolName,
      toolCallId: entry.toolCallId,
      ...(typeof entry.isError === 'boolean' ? { isError: entry.isError } : {}),
    });
  }
  return toolCalls;
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
