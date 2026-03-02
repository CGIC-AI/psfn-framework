import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import {
  readLastActiveSession,
  writeLastActiveSession,
} from '../lifecycle/notifications.js';
import { inferSessionChannelType } from '../session/session-id.js';
import { textResultWithError } from './results.js';
import { toErrorMessage } from '../utils/errors.js';

const DEFAULT_SESSION_PREFIX = 'api:session';

export interface SessionNewToolOptions {
  dataDir: string;
  now?: () => number;
  idFactory?: (timestamp: number) => string;
  seedSession?: (sessionId: string) => void;
}

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

export function createSessionNewTool(options: SessionNewToolOptions): AgentTool<any> {
  const now = options.now ?? Date.now;

  return {
    name: 'session_new',
    label: 'session_new',
    description:
      'Start a fresh session and switch the active runtime context to that session. ' +
      'Returns previous/new session IDs for follow-up operations.',
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
            `session_new: active context switched to "${newSessionId}"` +
            `${previous.sessionId ? ` (previous "${previous.sessionId}")` : ''}.`,
        }] satisfies TextContent[],
        details,
      };
    },
  };
}
