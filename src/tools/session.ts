import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { SessionManager } from '../session/manager.js';
import {
  readLastActiveSession,
  writeLastActiveSession,
} from '../lifecycle/notifications.js';
import { inferSessionChannelType } from '../session/session-id.js';
import { textResult, textResultWithError } from './results.js';
import { toErrorMessage } from '../utils/errors.js';

const DEFAULT_SESSION_PREFIX = 'api:session';
const DEFAULT_SESSION_LIST_LIMIT = 20;
const MAX_SESSION_LIST_LIMIT = 100;

interface SessionToolOptions {
  dataDir: string;
  now?: () => number;
}

export interface SessionNewToolOptions extends SessionToolOptions {
  idFactory?: (timestamp: number) => string;
  seedSession?: (sessionId: string) => void;
  setActiveSession?: (sessionId: string) => void;
}

type SessionToolManager = Pick<
SessionManager,
  'appendSystemNote'
  | 'listRecentSessions'
  | 'getSessionActivity'
  | 'setActiveContextSession'
  | 'getActiveContextSession'
>;

interface ResolvedPreviousSession {
  sessionId: string | null;
  channelType: string | null;
}

interface SessionNewParams {
  metadata?: Record<string, unknown>;
}

interface SessionNewDetails {
  action: 'session_new';
  switched: true;
  previousSessionId: string | null;
  previousChannelType: string | null;
  newSessionId: string;
  newChannelType: string;
  timestamp: number;
}

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeChannelType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function toMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function resolvePreviousSession(dataDir: string, metadata: Record<string, unknown>): ResolvedPreviousSession {
  const hintedId = normalizeSessionId(metadata.previousSessionId ?? metadata.sessionId);
  if (hintedId) {
    return {
      sessionId: hintedId,
      channelType: (
        normalizeChannelType(metadata.previousChannelType)
        ?? normalizeChannelType(metadata.channelType)
        ?? inferSessionChannelType(hintedId)
        ?? null
      ),
    };
  }

  const active = readLastActiveSession(dataDir);
  if (!active?.sessionId) {
    return { sessionId: null, channelType: null };
  }

  return {
    sessionId: active.sessionId,
    channelType: active.channelType ?? inferSessionChannelType(active.sessionId) ?? null,
  };
}

function buildSessionId(timestamp: number): string {
  return `${DEFAULT_SESSION_PREFIX}-${timestamp.toString(36)}-${randomUUID().slice(0, 8)}`;
}

function normalizeListLimit(rawLimit: number | undefined): number {
  if (!Number.isFinite(rawLimit) || rawLimit === undefined) {
    return DEFAULT_SESSION_LIST_LIMIT;
  }
  return Math.max(1, Math.min(MAX_SESSION_LIST_LIMIT, Math.floor(rawLimit)));
}

function buildListPayload(
  manager: SessionToolManager,
  dataDir: string,
  limit: number,
): Record<string, unknown> {
  const activeSessionId = manager.getActiveContextSession()
    ?? readLastActiveSession(dataDir)?.sessionId
    ?? null;
  const sessions = manager.listRecentSessions(limit).map((session) => ({
    sessionId: session.sessionId,
    channelType: session.channelType ?? null,
    lastActivityAt: session.lastActivityAt,
    messageCount: session.messageCount,
    lastRole: session.lastRole,
    lastAuthorName: session.lastAuthorName ?? null,
    lastMessagePreview: session.lastMessagePreview,
    isActive: activeSessionId != null && session.sessionId === activeSessionId,
  }));

  return {
    activeSessionId,
    count: sessions.length,
    sessions,
  };
}

export function createSessionNewTool(options: SessionNewToolOptions): AgentTool<any> {
  const now = options.now ?? Date.now;

  return {
    name: 'session_new',
    label: 'session_new',
    description:
      'Start a fresh session and switch the active runtime context to that session. '
      + 'Returns previous/new session IDs for follow-up operations.',
    parameters: Type.Object({
      metadata: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Unknown(),
          {
            description:
              'Optional metadata. You may include previousSessionId/previousChannelType hints.',
          },
        ),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: SessionNewParams,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<SessionNewDetails | { isError?: boolean }>> => {
      const metadata = toMetadata(params.metadata);
      const previous = resolvePreviousSession(options.dataDir, metadata);
      const timestamp = now();
      const newSessionId = normalizeSessionId(
        options.idFactory?.(timestamp) ?? buildSessionId(timestamp),
      );
      if (!newSessionId) {
        return textResultWithError('session_new failed: generated session ID is invalid.', true);
      }

      const newChannelType = inferSessionChannelType(newSessionId) ?? 'api';
      try {
        options.setActiveSession?.(newSessionId);
        options.seedSession?.(newSessionId);
        writeLastActiveSession(options.dataDir, {
          sessionId: newSessionId,
          channelType: newChannelType,
          timestamp,
        });
      } catch (error) {
        return textResultWithError(`session_new failed: ${toErrorMessage(error)}.`, true);
      }

      const details: SessionNewDetails = {
        action: 'session_new',
        switched: true,
        previousSessionId: previous.sessionId,
        previousChannelType: previous.channelType,
        newSessionId,
        newChannelType,
        timestamp,
      };

      return {
        content: [{
          type: 'text',
          text:
            `session_new: active context switched to "${newSessionId}"`
            + `${previous.sessionId ? ` (previous "${previous.sessionId}")` : ''}.`,
        }] satisfies TextContent[],
        details,
      };
    },
  };
}

export function createSessionListTool(
  manager: SessionToolManager,
  options: SessionToolOptions,
): AgentTool<any> {
  return {
    name: 'session_list',
    label: 'session_list',
    description:
      'List recent sessions ordered by last activity, including message counts and a preview of each latest message.',
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({
        minimum: 1,
        maximum: MAX_SESSION_LIST_LIMIT,
        description: `Max sessions to return (default ${DEFAULT_SESSION_LIST_LIMIT}).`,
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: { limit?: number },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<Record<string, never>>> => {
      const limit = normalizeListLimit(params.limit);
      return textResult(JSON.stringify(buildListPayload(manager, options.dataDir, limit), null, 2));
    },
  };
}

export function createSessionResumeTool(
  manager: SessionToolManager,
  options: SessionToolOptions,
): AgentTool<any> {
  const now = options.now ?? Date.now;
  return {
    name: 'session_resume',
    label: 'session_resume',
    description:
      'Resume a prior session by session ID. Updates active context so subsequent API/terminal turns continue in that session.',
    parameters: Type.Object({
      sessionId: Type.String({
        minLength: 1,
        description: 'Exact session ID to resume.',
      }),
    }),
    execute: async (
      _toolCallId: string,
      params: { sessionId: string },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const requestedSessionId = params.sessionId?.trim();
      if (!requestedSessionId) {
        return textResultWithError('session_resume requires a non-empty sessionId.', true);
      }

      const target = manager.getSessionActivity(requestedSessionId);
      if (!target) {
        return textResultWithError(`Session not found: ${requestedSessionId}`, true);
      }

      const previousSessionId = manager.getActiveContextSession()
        ?? readLastActiveSession(options.dataDir)?.sessionId
        ?? null;
      manager.setActiveContextSession(target.sessionId);
      writeLastActiveSession(options.dataDir, {
        sessionId: target.sessionId,
        channelType: target.channelType,
        timestamp: now(),
      });

      return textResult(JSON.stringify({
        resumed: true,
        previousSessionId,
        session: {
          sessionId: target.sessionId,
          channelType: target.channelType ?? null,
          lastActivityAt: target.lastActivityAt,
          messageCount: target.messageCount,
          lastRole: target.lastRole,
          lastAuthorName: target.lastAuthorName ?? null,
          lastMessagePreview: target.lastMessagePreview,
        },
      }, null, 2));
    },
  };
}
