import type {
  ObservabilityCallType,
  PostTurnActionCandidate,
  SubstrateMessage,
} from '../types.js';
import {
  buildDeferredToolHandoffCandidate,
  normalizeDeferredToolHandoffIntent,
  normalizeDeferredToolHandoffPayload,
  type DeferredToolHandoffIntent,
  type DeferredToolHandoffPayload,
} from '../agent/deferred-tool-handoff.js';

const HEARTBEAT_RUN_TEMPLATE_TOOL_NAME = 'heartbeat_run_template';
const LOAD_TOOLS_TOOL_NAME = 'load_tools';

export interface InferDeferredPostTurnActionsInput {
  message: SubstrateMessage;
  turnMessages: readonly unknown[];
  deferredHeartbeatActionKind: string;
  onDeferredToolHandoffPayload?: (dedupeKey: string, payload: DeferredToolHandoffPayload) => void;
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

function isHeartbeatRunTemplateToolResult(message: unknown): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  return (
    candidate.role === 'toolResult'
    && candidate.toolName === HEARTBEAT_RUN_TEMPLATE_TOOL_NAME
  );
}

function isLoadToolsToolResult(message: unknown): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  return (
    candidate.role === 'toolResult'
    && candidate.toolName === LOAD_TOOLS_TOOL_NAME
  );
}

function extractDeferredToolHandoffIntent(message: unknown): DeferredToolHandoffIntent | null {
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
    const deferredToolHandoff = normalizeDeferredToolHandoffIntent(record.deferredToolHandoff);
    if (deferredToolHandoff) {
      return deferredToolHandoff;
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return null;
}

function resolvePostTurnCallType(message: SubstrateMessage): ObservabilityCallType {
  if (message.channelId.startsWith('internal:')) {
    return 'scheduled';
  }
  return 'chat';
}

export function inferDeferredPostTurnActions({
  message,
  turnMessages,
  deferredHeartbeatActionKind,
  onDeferredToolHandoffPayload,
}: InferDeferredPostTurnActionsInput): PostTurnActionCandidate[] {
  const callType = resolvePostTurnCallType(message);
  const inferred: PostTurnActionCandidate[] = [];
  for (const turnMessage of turnMessages) {
    if (isHeartbeatRunTemplateToolResult(turnMessage)) {
      const candidate = extractDeferredActionCandidate(turnMessage);
      if (candidate && candidate.kind === deferredHeartbeatActionKind) {
        inferred.push(candidate);
      }
      continue;
    }

    if (!isLoadToolsToolResult(turnMessage)) continue;
    const deferredToolHandoff = extractDeferredToolHandoffIntent(turnMessage);
    if (!deferredToolHandoff) continue;
    const candidate = buildDeferredToolHandoffCandidate(
      deferredToolHandoff,
      message,
      callType,
    );
    const normalizedPayload = normalizeDeferredToolHandoffPayload(candidate.payload);
    if (!normalizedPayload) continue;
    if (candidate.dedupeKey && onDeferredToolHandoffPayload) {
      onDeferredToolHandoffPayload(candidate.dedupeKey, normalizedPayload);
    }
    inferred.push(candidate);
  }
  return inferred;
}
