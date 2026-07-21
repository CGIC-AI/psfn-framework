import type {
  ObservabilityCallType,
  PostTurnActionCandidate,
  SubstrateMessage,
} from '../../shared/contracts/runtime.js';
import { createSignalWisePostTurnAppraiser } from '../intention/post-turn-appraisal.js';

// Preserve the model-facing tool name because stored transcripts contain tool
// results under this value. The surrounding inference machinery is reflection-
// named, but changing the wire value would break replay.
const LEGACY_REFLECTION_RUN_TEMPLATE_TOOL_NAME = 'heartbeat_run_template';
const SCHEDULE_TOOL_NAME = 'schedule';

export interface InferDeferredPostTurnActionsInput {
  message: SubstrateMessage;
  turnMessages: readonly unknown[];
  deferredReflectionActionKind: string;
}

function normalizeDeferredActionCandidate(raw: unknown): PostTurnActionCandidate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  const kind = typeof candidate.kind === 'string' ? candidate.kind.trim() : '';
  if (!kind) {
    return null;
  }

  const payload = (
    candidate.payload
    && typeof candidate.payload === 'object'
    && !Array.isArray(candidate.payload)
  )
    ? candidate.payload as Record<string, unknown>
    : undefined;
  const dedupeKey = typeof candidate.dedupeKey === 'string' ? candidate.dedupeKey.trim() : '';
  const normalizedMaxRetries = (
    typeof candidate.maxRetries === 'number'
    && Number.isFinite(candidate.maxRetries)
    && candidate.maxRetries >= 0
  )
    ? Math.floor(candidate.maxRetries)
    : undefined;

  return {
    kind,
    ...(payload ? { payload } : {}),
    ...(dedupeKey ? { dedupeKey } : {}),
    ...(normalizedMaxRetries !== undefined ? { maxRetries: normalizedMaxRetries } : {}),
  };
}

function extractDeferredActionCandidate(message: unknown): PostTurnActionCandidate | null {
  const stack: unknown[] = [message];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const entry of current) {
        if (entry && typeof entry === 'object') {
          stack.push(entry);
        }
      }
      continue;
    }

    const record = current as Record<string, unknown>;
    const deferredAction = normalizeDeferredActionCandidate(record.deferredAction);
    if (deferredAction) {
      return deferredAction;
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return null;
}

function isDeferredReflectionActionToolResult(message: unknown): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  return (
    candidate.role === 'toolResult'
    && (
      candidate.toolName === LEGACY_REFLECTION_RUN_TEMPLATE_TOOL_NAME
      || candidate.toolName === SCHEDULE_TOOL_NAME
    )
  );
}

function resolvePostTurnCallType(message: SubstrateMessage): ObservabilityCallType {
  if (message.channelId.startsWith('internal:')) {
    return 'scheduled';
  }
  return 'chat';
}

function inferDeferredReflectionActions(
  turnMessages: readonly unknown[],
  deferredReflectionActionKind: string,
): PostTurnActionCandidate[] {
  const inferred: PostTurnActionCandidate[] = [];
  for (const turnMessage of turnMessages) {
    if (!isDeferredReflectionActionToolResult(turnMessage)) continue;
    const candidate = extractDeferredActionCandidate(turnMessage);
    if (candidate && candidate.kind === deferredReflectionActionKind) {
      inferred.push(candidate);
    }
  }
  return inferred;
}

export function inferDeferredPostTurnActions({
  turnMessages,
  deferredReflectionActionKind,
}: InferDeferredPostTurnActionsInput): PostTurnActionCandidate[] {
  return inferDeferredReflectionActions(turnMessages, deferredReflectionActionKind);
}

const inferSignalWisePostTurnActions = createSignalWisePostTurnAppraiser<
InferDeferredPostTurnActionsInput & { callType: ObservabilityCallType }
>([
  {
    name: 'reflection_deferred_action',
    infer: (context) => inferDeferredReflectionActions(
      context.turnMessages,
      context.deferredReflectionActionKind,
    ),
  },
]);

export async function inferComposedDeferredPostTurnActions(
  input: InferDeferredPostTurnActionsInput,
): Promise<PostTurnActionCandidate[]> {
  return inferSignalWisePostTurnActions({
    ...input,
    callType: resolvePostTurnCallType(input.message),
  });
}
