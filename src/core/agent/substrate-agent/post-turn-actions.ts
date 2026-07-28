import { createHash } from 'node:crypto';
import type { AgentMessage } from '../../../boundary/pi-agent/index.js';
import type { AgentResponse, InferredPostTurnAction, PostTurnActionCandidate, SubstrateMessage, TurnID } from '../../../shared/contracts/runtime.js';
import type { IcpConversationCorrelation } from '../../../shared/contracts/icp-autonomy.js';
import type { ContextManifest } from '../../session/context-manifest.js';
import type { CapturedSessionReads } from '../../session/manager/captured-session-owner.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';

export interface PostTurnInferenceContext {
  message: SubstrateMessage;
  response: AgentResponse;
  turnMessages: AgentMessage[];
  turnId: TurnID;
  completedAt: number;
  /** Scheduler-owned structured task class; never inferred from model prose. */
  taskKind?: string;
  contextManifest?: ContextManifest;
  canonicalContactKey?: string;
  /**
   * The admitted turn's owner-bound session reads. Inferers run inside the
   * turn's captured-owner scope, so any session-history read they perform (e.g.
   * the intention post-turn appraisal transcript) must go through this facade
   * rather than SessionManager.getRecentMessages, which the read-attribution
   * guard rejects while a turn is admitted on the channel.
   */
  capturedSessionReads: CapturedSessionReads;
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
  icpCorrelation?: IcpConversationCorrelation;
}

export interface IntentionPostTurnHookEffects {
  /** Recheck ownership without promoting the durable receipt to started. */
  assertOwned(): Promise<void>;
  /** Promote the durable receipt immediately before the hook's idempotent sink write. */
  crossBoundary(): Promise<void>;
}

export type IntentionPostTurnHook = (
  context: IntentionPostTurnHookContext,
  effects: IntentionPostTurnHookEffects,
) => Promise<void> | void;

export type IntentionPostTurnHookRunOptions = {
  propagateFailures?: boolean;
} & ({
  assertOwned: () => Promise<void>;
  runEffect: (
    effectKey: string,
    operation: (crossBoundary: () => Promise<void>) => Promise<void>,
  ) => Promise<void>;
} | {
  assertOwned?: undefined;
  runEffect?: undefined;
});

interface PostTurnLogger {
  warn: (message: string, payload: Record<string, unknown>) => void;
}

const IMMEDIATE_INTENTION_EFFECTS: IntentionPostTurnHookEffects = {
  assertOwned: async () => undefined,
  crossBoundary: async () => undefined,
};

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
  options?: IntentionPostTurnHookRunOptions;
}): Promise<void> {
  if (input.hooks.length === 0) {
    return;
  }
  for (let index = 0; index < input.hooks.length; index += 1) {
    const hook = input.hooks[index]!;
    try {
      if (input.options?.runEffect) {
        const { assertOwned } = input.options;
        await input.options.runEffect(`intention-hook:${String(index)}`, async (crossBoundary) => {
          await assertOwned();
          await hook(input.context, { assertOwned, crossBoundary });
        });
      } else {
        await hook(input.context, IMMEDIATE_INTENTION_EFFECTS);
      }
    } catch (error) {
      input.logger.warn('Intention post-turn hook failed', {
        channelId: input.context.message.channelId,
        messageId: input.context.message.id,
        error: toErrorMessage(error),
      });
      if (input.options?.propagateFailures === true) throw error;
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
