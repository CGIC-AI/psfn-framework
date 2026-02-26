import type { AgentResponse, SubstrateMessage } from '../../../types.js';
import {
  isRecord,
  type WyomingFrame,
  type WyomingJsonObject,
} from '../protocol.js';
import type {
  WyomingServiceAdapter,
  WyomingServiceSessionClosedRequest,
} from './index.js';

export const WYOMING_HANDLE_EVENT_TYPES = [
  'handle',
  'transcript',
  'text',
] as const;

type HandleErrorCode =
  | 'invalid_request'
  | 'timeout'
  | 'unavailable'
  | 'cancelled';

interface EventBusLike {
  emit(event: string, payload: Record<string, unknown>): Promise<void>;
}

export interface WyomingHandleServiceOptions {
  handleMessage: (message: SubstrateMessage) => Promise<AgentResponse>;
  eventBus?: EventBusLike;
  timeoutMs?: number;
  now?: () => number;
}

interface HandleSessionState {
  contextId: string;
  sequence: number;
}

interface ClassifiedHandleError {
  code: Exclude<HandleErrorCode, 'invalid_request'>;
  status: 'timeout' | 'error' | 'cancelled';
  message: string;
}

const DEFAULT_HANDLE_TIMEOUT_MS = 60_000;

function toSessionKey(connectionId: string, sessionId: string): string {
  return `${connectionId}:${sessionId}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  return /abort|cancel/i.test(error.message);
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return DEFAULT_HANDLE_TIMEOUT_MS;
  }

  return Math.floor(value);
}

function readString(data: WyomingJsonObject | undefined, keys: string[]): string | undefined {
  if (!data) return undefined;

  for (const key of keys) {
    const value = data[key];
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

function resolveContextId(data: WyomingJsonObject | undefined): string | undefined {
  const direct = readString(data, ['context_id', 'contextId']);
  if (direct) {
    return direct;
  }

  const contextValue = data?.context;
  if (typeof contextValue === 'string') {
    const trimmed = contextValue.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  if (isRecord(contextValue)) {
    return readString(contextValue as WyomingJsonObject, ['id', 'context_id', 'contextId']);
  }

  return undefined;
}

function resolveChannelId(
  connectionId: string,
  data: WyomingJsonObject | undefined,
): string {
  const siteId = readString(data, ['site_id', 'siteId']);
  const satelliteId = readString(data, ['satellite_id', 'satelliteId']);

  if (!siteId || !satelliteId) {
    return `api:wyoming:unknown:${connectionId}`;
  }

  return `api:wyoming:${siteId}:${satelliteId}`;
}

async function runWithTimeout<T>(
  task: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('Wyoming handle request timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function classifyHandleError(error: unknown): ClassifiedHandleError {
  if (isAbortLikeError(error)) {
    return {
      code: 'cancelled',
      status: 'cancelled',
      message: toError(error).message,
    };
  }

  const normalized = toError(error);
  if (/timed out/i.test(normalized.message)) {
    return {
      code: 'timeout',
      status: 'timeout',
      message: normalized.message,
    };
  }

  return {
    code: 'unavailable',
    status: 'error',
    message: normalized.message,
  };
}

function createServiceErrorFrame(
  code: HandleErrorCode,
  frame: WyomingFrame,
  message: string,
  sessionId?: string,
): WyomingFrame {
  return {
    type: 'error',
    data: {
      code,
      event: frame.type,
      service: 'handle',
      message,
      session_id: sessionId ?? null,
    },
  };
}

export function createWyomingHandleServiceAdapter(
  options: WyomingHandleServiceOptions,
): WyomingServiceAdapter {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const sessionStates = new Map<string, HandleSessionState>();

  return {
    id: 'handle',
    family: 'handle',
    service: {
      name: 'handle',
      description: 'Gateway conversation service bridge',
      version: '1.0.0',
      supports: [...WYOMING_HANDLE_EVENT_TYPES, 'handled'],
    },
    eventTypes: WYOMING_HANDLE_EVENT_TYPES,
    async handle(request): Promise<WyomingFrame> {
      const sessionId = request.sessionId?.trim();
      if (!sessionId) {
        return createServiceErrorFrame(
          'invalid_request',
          request.frame,
          'handle requests require data.session_id',
        );
      }

      const text = readString(request.frame.data, ['text', 'transcript', 'utterance', 'input']);
      if (!text) {
        return createServiceErrorFrame(
          'invalid_request',
          request.frame,
          'handle requests require a non-empty text payload',
          sessionId,
        );
      }

      const connectionId = request.transportSession.connectionId;
      const key = toSessionKey(connectionId, sessionId);
      const requestedContextId = resolveContextId(request.frame.data);
      const state = sessionStates.get(key) ?? {
        contextId: requestedContextId ?? `wyoming-ctx-${connectionId}-${sessionId}`,
        sequence: 0,
      };
      if (requestedContextId) {
        state.contextId = requestedContextId;
      }
      state.sequence += 1;
      sessionStates.set(key, state);

      const channelId = resolveChannelId(connectionId, request.frame.data);
      const satelliteId = readString(request.frame.data, ['satellite_id', 'satelliteId']);
      const userId = readString(request.frame.data, ['ha_user_id', 'haUserId', 'user_id', 'userId'])
        ?? satelliteId
        ?? 'unknown';
      const authorName = readString(request.frame.data, ['user_name', 'userName'])
        ?? 'Wyoming Voice User';
      const turnId = `wyoming-turn-${connectionId}-${sessionId}-${state.sequence}`;
      const timestampMs = now();

      const message: SubstrateMessage = {
        id: `wyoming-msg-${connectionId}-${state.sequence}`,
        channelId,
        channelType: 'api',
        authorId: `wyoming-user:${userId}`,
        authorName,
        content: text,
        isDirectMessage: true,
        timestamp: new Date(timestampMs),
      };

      const emit = options.eventBus?.emit.bind(options.eventBus);
      if (emit) {
        await emit('voice.turn.start', {
          turnId,
          channelId,
          userId: message.authorId,
          timestampMs,
        });
        await emit('voice.stt.final', {
          turnId,
          channelId,
          userId: message.authorId,
          text,
          timestampMs,
        });
        await emit('message.received', { message });
      }

      try {
        const response = await runWithTimeout(
          () => options.handleMessage(message),
          timeoutMs,
        );
        const language = readString(request.frame.data, ['language', 'lang']);
        const modelHint = readString(request.frame.data, ['name', 'model']);
        const resolvedModel = response.metadata.model || modelHint;

        if (emit) {
          await emit('message.sent', { response });
          await emit('voice.tts.requested', {
            turnId,
            channelId,
            userId: message.authorId,
            text: response.content,
            timestampMs: now(),
          });
          await emit('voice.turn.end', {
            turnId,
            channelId,
            userId: message.authorId,
            status: 'completed',
            timestampMs: now(),
          });
        }

        return {
          type: 'handled',
          data: {
            session_id: sessionId,
            turn_id: turnId,
            text: response.content,
            context_id: state.contextId,
            context: {
              id: state.contextId,
            },
            ...(language ? { language } : {}),
            ...(resolvedModel ? { model: resolvedModel } : {}),
          },
        };
      } catch (error) {
        const classified = classifyHandleError(error);

        if (emit) {
          await emit('voice.turn.error', {
            turnId,
            channelId,
            userId: message.authorId,
            stage: 'orchestrator',
            code: classified.code,
            error: classified.message,
            timestampMs: now(),
          });
          await emit('voice.turn.end', {
            turnId,
            channelId,
            userId: message.authorId,
            status: classified.status,
            reason: classified.message,
            timestampMs: now(),
          });
        }

        return createServiceErrorFrame(
          classified.code,
          request.frame,
          classified.message,
          sessionId,
        );
      }
    },
    onSessionClosed(requestContext: WyomingServiceSessionClosedRequest): void {
      sessionStates.delete(toSessionKey(requestContext.connectionId, requestContext.sessionId));
    },
  };
}
