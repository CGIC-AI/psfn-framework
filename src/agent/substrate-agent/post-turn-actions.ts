import { createHash } from 'node:crypto';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type {
  AgentResponse,
  InferredPostTurnAction,
  PostTurnActionCandidate,
  SubstrateMessage,
  TurnID,
} from '../../types.js';
import type { ContextManifest } from '../../session/context-manifest.js';
import { toErrorMessage } from '../../utils/errors.js';

export interface PostTurnInferenceContext {
  message: SubstrateMessage;
  response: AgentResponse;
  turnMessages: AgentMessage[];
  turnId: TurnID;
  completedAt: number;
  contextManifest?: ContextManifest;
  canonicalContactKey?: string;
}

export type PostTurnActionInferer = (
  context: PostTurnInferenceContext,
) => PostTurnActionCandidate[] | Promise<PostTurnActionCandidate[]>;

export interface IntentionPostTurnHookContext {
  message: SubstrateMessage;
  response: AgentResponse;
  turnMessages: AgentMessage[];
  turnId: TurnID;
  completedAt: number;
  canonicalContactKey?: string;
}

export type IntentionPostTurnHook = (
  context: IntentionPostTurnHookContext,
) => Promise<void> | void;

interface PostTurnLogger {
  warn: (message: string, payload: Record<string, unknown>) => void;
}

export async function inferPostTurnActions(input: {
  inferers: readonly PostTurnActionInferer[];
  context: PostTurnInferenceContext;
  logger: PostTurnLogger;
}): Promise<InferredPostTurnAction[]> {
  if (input.inferers.length === 0) {
    return [];
  }

  const inferred: InferredPostTurnAction[] = [];
  const seenDedupeKeys = new Set<string>();

  for (const inferer of input.inferers) {
    let candidates: PostTurnActionCandidate[] = [];
    try {
      candidates = await inferer(input.context);
    } catch (error) {
      input.logger.warn('Post-turn action inferer failed', {
        channelId: input.context.message.channelId,
        messageId: input.context.message.id,
        error: toErrorMessage(error),
      });
      continue;
    }

    for (const candidate of candidates) {
      const normalized = normalizePostTurnActionCandidate(
        candidate,
        input.context.message,
        inferred.length,
      );
      if (!normalized) continue;
      if (seenDedupeKeys.has(normalized.dedupeKey)) continue;
      seenDedupeKeys.add(normalized.dedupeKey);
      inferred.push(normalized);
    }
  }

  return inferred;
}

export async function runIntentionPostTurnHooks(input: {
  hooks: readonly IntentionPostTurnHook[];
  context: IntentionPostTurnHookContext;
  logger: PostTurnLogger;
}): Promise<void> {
  if (input.hooks.length === 0) {
    return;
  }
  for (const hook of input.hooks) {
    try {
      await hook(input.context);
    } catch (error) {
      input.logger.warn('Intention post-turn hook failed', {
        channelId: input.context.message.channelId,
        messageId: input.context.message.id,
        error: toErrorMessage(error),
      });
    }
  }
}

export function normalizePostTurnActionCandidate(
  candidate: PostTurnActionCandidate | null | undefined,
  message: SubstrateMessage,
  ordinal: number,
): InferredPostTurnAction | null {
  if (!candidate || typeof candidate.kind !== 'string') {
    return null;
  }

  const kind = candidate.kind.trim();
  if (!kind) {
    return null;
  }

  const payload = normalizePostTurnPayload(candidate.payload);
  const explicitDedupeKey = typeof candidate.dedupeKey === 'string' ? candidate.dedupeKey.trim() : '';
  const dedupeKey = explicitDedupeKey || `${kind}:${message.channelId}:${hashPostTurnPayload(payload)}`;
  const inferredAt = Date.now();
  const id = createHash('sha256')
    .update(`${message.id}:${kind}:${dedupeKey}:${ordinal}`)
    .digest('hex')
    .slice(0, 24);

  const normalizedMaxRetries = (
    typeof candidate.maxRetries === 'number'
    && Number.isFinite(candidate.maxRetries)
    && candidate.maxRetries >= 0
  )
    ? Math.floor(candidate.maxRetries)
    : undefined;
  const normalizedRunAt = normalizeActionRunAt(candidate.runAt);

  return {
    id,
    kind,
    payload,
    dedupeKey,
    channelId: message.channelId,
    sourceMessageId: message.id,
    inferredAt,
    ...(normalizedMaxRetries !== undefined ? { maxRetries: normalizedMaxRetries } : {}),
    ...(normalizedRunAt !== undefined ? { runAt: normalizedRunAt } : {}),
  };
}

function normalizePostTurnPayload(
  payload: PostTurnActionCandidate['payload'],
): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  return payload;
}

function normalizeActionRunAt(runAt: unknown): number | undefined {
  if (typeof runAt !== 'number' || !Number.isFinite(runAt) || runAt <= 0) {
    return undefined;
  }
  return Math.floor(runAt);
}

function hashPostTurnPayload(payload: Record<string, unknown>): string {
  const serialized = stableStringify(payload);
  return createHash('sha256').update(serialized).digest('hex').slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  const objectValue = value as Record<string, unknown>;
  const entries = Object.entries(objectValue)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}
