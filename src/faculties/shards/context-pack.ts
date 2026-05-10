import type { SessionStore } from '../../persistence/sessions/store.js';
import type { SessionEntry } from '../../core/session/types.js';
import type { SessionManager } from '../../core/session/manager.js';
import type {
  ShardConfig,
  ShardContextPackEntry,
  ShardCreationMode,
  ShardParentContextSnapshot,
  ShardPromptDiscipline,
  ShardSourceContext,
} from './types.js';

export function truncateShardContextText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}

export function normalizeShardSourceContext(
  sourceContext: ShardSourceContext | undefined,
): ShardSourceContext | null {
  const channelId = sourceContext?.channelId.trim();
  if (!channelId || !sourceContext) {
    return null;
  }

  const requestId = sourceContext.requestId?.trim();
  const turnId = sourceContext.turnId?.trim();
  return {
    channelId,
    ...(requestId ? { requestId } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

export function buildShardContextPackEntries(input: {
  sessionStore: SessionStore;
  source: ShardSourceContext;
  sessionScanLimit: number;
  sessionEntryLimit: number;
  entryContentMaxChars: number;
}): ShardContextPackEntry[] {
  const recentEntries = input.sessionStore.getRecent(
    input.source.channelId,
    input.sessionScanLimit,
  );
  const focusedEntries = selectContextPackEntries(recentEntries, input.source, input.sessionEntryLimit);
  return focusedEntries.map(entry => ({
    role: entry.role,
    content: truncateShardContextText(entry.content, input.entryContentMaxChars),
    ...(entry.authorName ? { authorName: entry.authorName } : {}),
    timestamp: entry.timestamp,
  }));
}

function selectContextPackEntries(
  recentEntries: readonly SessionEntry[],
  source: ShardSourceContext,
  sessionEntryLimit: number,
): SessionEntry[] {
  if (recentEntries.length <= sessionEntryLimit) {
    return [...recentEntries];
  }

  const anchorIndex = findContextPackAnchorIndex(recentEntries, source);
  if (anchorIndex < 0) {
    return recentEntries.slice(-sessionEntryLimit);
  }

  const endExclusive = anchorIndex + 1;
  const start = Math.max(0, endExclusive - sessionEntryLimit);
  return recentEntries.slice(start, endExclusive);
}

function findContextPackAnchorIndex(
  recentEntries: readonly SessionEntry[],
  source: ShardSourceContext,
): number {
  for (let index = recentEntries.length - 1; index >= 0; index -= 1) {
    const entry = recentEntries.at(index);
    if (!entry) {
      continue;
    }
    if (sessionEntryMatchesSource(entry, source)) {
      return index;
    }
  }
  return -1;
}

function sessionEntryMatchesSource(entry: SessionEntry, source: ShardSourceContext): boolean {
  const metadata = entry.metadata;
  if (!metadata) {
    return false;
  }

  return metadataIncludesField(metadata, 'requestId', source.requestId)
    || metadataIncludesField(metadata, 'turnId', source.turnId);
}

function metadataIncludesField(
  metadata: string,
  field: 'requestId' | 'turnId',
  value: string | undefined,
): boolean {
  if (!value) {
    return false;
  }
  return metadata.includes(`"${field}":${JSON.stringify(value)}`);
}

export function resolveShardContextPackMemoryScopeQuery(
  sessionManager: SessionManager | null | undefined,
  sourceChannelId: string,
): import('../memory/types.js').MemoryScopeQuery | undefined {
  return sessionManager?.getActiveFocusMemoryScopeQuery(sourceChannelId) ?? undefined;
}

export function buildShardPromptDiscipline(input: {
  parentSystemPrompt: string;
  shardConfig: ShardConfig;
  creationMode: ShardCreationMode;
  parentContext: ShardParentContextSnapshot | undefined;
  taskMaxChars: number;
  defaultGuardrails: readonly string[];
}): ShardPromptDiscipline {
  const stablePrefix = input.parentSystemPrompt.trim();
  const remitSupplement = input.shardConfig.systemPrompt?.trim();

  return {
    stablePrefix,
    remit: [
      `Creation mode: ${input.creationMode}.`,
      `Shard name: ${input.shardConfig.name.trim()}.`,
      `Shard task: ${truncateShardContextText(input.shardConfig.task, input.taskMaxChars)}.`,
      ...(remitSupplement ? [`Remit notes: ${remitSupplement}`] : []),
      ...(input.parentContext ? [`Inherited source channel: ${input.parentContext.source.channelId}.`] : []),
    ].join('\n'),
    guardrails: [
      ...input.defaultGuardrails,
      ...(input.creationMode === 'forked'
        ? ['Treat inherited parent context as a read-only snapshot, not as a live conversation to continue.']
        : ['Do not assume any hidden parent context beyond the shard remit.']),
    ],
  };
}

export function renderShardPromptDiscipline(promptDiscipline: ShardPromptDiscipline): string {
  return [
    '[Shard remit]',
    promptDiscipline.remit,
    '',
    '[Shard guardrails]',
    ...promptDiscipline.guardrails.map(guardrail => `- ${guardrail}`),
  ].join('\n');
}

export function renderShardParentContextSnapshot(
  parentContext: ShardParentContextSnapshot,
  taskMaxChars: number,
): string {
  const sourceConversation = parentContext.transcript.entries
    .map(entry => {
      const speaker = entry.role === 'assistant'
        ? 'Assistant'
        : entry.role === 'system'
          ? 'System'
          : (entry.authorName?.trim() || 'User');
      return `${speaker}: ${entry.content}`;
    })
    .join('\n');

  return [
    '[Forked shard parent context]',
    'Use this inherited parent snapshot as read-only context while completing the shard remit.',
    `Inherited from: ${parentContext.inheritedFrom}`,
    `Source channel: ${parentContext.source.channelId}`,
    ...(parentContext.source.requestId ? [`Source requestId: ${parentContext.source.requestId}`] : []),
    ...(parentContext.source.turnId ? [`Source turnId: ${parentContext.source.turnId}`] : []),
    `Task scope: ${truncateShardContextText(parentContext.task, taskMaxChars)}`,
    ...(sourceConversation
      ? [
        '',
        '[Focused source conversation]',
        sourceConversation,
      ]
      : []),
    ...(parentContext.memory?.content
      ? [
        '',
        '[Task-scoped memory]',
        parentContext.memory.content,
      ]
      : []),
  ].join('\n');
}

export function resolveShardSystemPrompt(input: {
  promptDiscipline: ShardPromptDiscipline;
  parentContext?: ShardParentContextSnapshot;
  taskMaxChars: number;
}): string {
  return [
    input.promptDiscipline.stablePrefix,
    renderShardPromptDiscipline(input.promptDiscipline),
    ...(input.parentContext ? [renderShardParentContextSnapshot(input.parentContext, input.taskMaxChars)] : []),
  ]
    .map(section => section.trim())
    .filter(section => section.length > 0)
    .join('\n\n');
}
