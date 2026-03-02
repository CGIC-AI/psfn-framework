import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { SessionManager } from '../session/manager.js';
import {
  readLastActiveSession,
  writeLastActiveSession,
} from '../lifecycle/notifications.js';
import { textResult, textResultWithError } from './results.js';

const DEFAULT_SESSION_LIST_LIMIT = 20;
const MAX_SESSION_LIST_LIMIT = 100;

interface SessionToolOptions {
  dataDir: string;
  now?: () => number;
}

type SessionToolManager = Pick<
SessionManager,
  'listRecentSessions'
  | 'getSessionActivity'
  | 'setActiveContextSession'
  | 'getActiveContextSession'
>;

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
