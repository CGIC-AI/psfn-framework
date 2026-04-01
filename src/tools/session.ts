import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { LLMProvider } from '../agent/contracts.js';
import type { SessionManager } from '../session/manager.js';
import {
  readLastActiveSession,
  writeLastActiveSession,
} from '../lifecycle/notifications.js';
import { inferSessionChannelType } from '../session/session-id.js';
import { getRequestContext } from '../llm/request-context.js';
import { textResult, textResultWithError } from './results.js';
import { createCompleteFocusTool, createStartFocusTool } from './focus.js';
import {
  SessionContinuityArtifactStore,
  type SessionContinuityArtifactKind,
  type SessionContinuityFacet,
  type SessionContinuityOccasion,
} from '../session/continuity-artifacts.js';
import {
  createSessionGrepTool,
  createSessionSearchTool,
  type SessionGrepToolOptions,
} from './session-search.js';
import { resolveSessionContinuityArtifactsDir } from '../persistence/layout.js';
import { toErrorMessage } from '../utils/errors.js';

const DEFAULT_SESSION_PREFIX = 'api:session';
const DEFAULT_SESSION_LIST_LIMIT = 20;
const MAX_SESSION_LIST_LIMIT = 100;
const SESSION_TOOL_ACTION_NAMES = [
  'list',
  'session_list',
  'new',
  'session_new',
  'resume',
  'session_resume',
  'search',
  'session_search',
  'grep',
  'session_grep',
  'list_continuity',
  'continuity_list',
  'checkpoint',
  'wake_return',
  'wake_return_summary',
  'start_focus',
  'focus_start',
  'complete_focus',
  'focus_complete',
] as const;
const SESSION_TOOL_ACTION_HELP = [
  'list',
  'new',
  'resume',
  'search',
  'grep',
  'list_continuity',
  'checkpoint',
  'wake_return',
  'start_focus',
  'complete_focus',
].join(', ');

type SessionToolActionName = (typeof SESSION_TOOL_ACTION_NAMES)[number];
type SessionToolAction =
  | 'list'
  | 'new'
  | 'resume'
  | 'search'
  | 'grep'
  | 'list_continuity'
  | 'checkpoint'
  | 'wake_return'
  | 'start_focus'
  | 'complete_focus';

interface SessionToolOptions {
  dataDir: string;
  now?: () => number;
}

export interface SessionNewToolOptions extends SessionToolOptions {
  idFactory?: (timestamp: number) => string;
  seedSession?: (sessionId: string) => void;
  setActiveSession?: (sessionId: string) => void;
}

export interface UnifiedSessionToolOptions extends SessionNewToolOptions {
  manager: SessionManager;
  llmProvider: LLMProvider;
  sessionsDir: string;
  runRipgrep?: SessionGrepToolOptions['runRipgrep'];
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

interface SessionToolParams extends SessionNewParams {
  action?: SessionToolActionName;
  limit?: number;
  sessionId?: string;
  query?: string;
  summarize?: boolean;
  pattern?: string;
  mode?: 'literal' | 'regex';
  caseSensitive?: boolean;
  channelId?: string;
  summary?: string;
  next_anchor?: string;
  facets?: SessionContinuityFacet[];
  occasion?: SessionContinuityOccasion;
  kind?: SessionContinuityArtifactKind;
  scope?: string;
  conclusion?: string;
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

function isBackgroundContinuationContext(): boolean {
  const requestContext = getRequestContext();
  if (!requestContext) {
    return false;
  }
  if (requestContext.callType === 'background') {
    return true;
  }
  const purpose = typeof requestContext.purpose === 'string'
    ? requestContext.purpose.trim().toLowerCase()
    : '';
  return purpose.includes('deferred_tool_handoff');
}

function rejectBackgroundSessionMutation(action: 'session_new' | 'session_resume') {
  return textResultWithError(
    `${action} is unavailable during background continuation execution. Start a foreground turn to switch sessions.`,
    true,
  );
}

function normalizeSessionAction(params: SessionToolParams): SessionToolAction {
  const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
  if (!rawAction) {
    const hasNonListParams = Object.entries(params).some(([key, value]) => (
      key !== 'action'
      && key !== 'limit'
      && value !== undefined
    ));
    if (!hasNonListParams) {
      return 'list';
    }
    throw new Error(`action is required unless using the default list behavior (${SESSION_TOOL_ACTION_HELP})`);
  }

  switch (rawAction) {
    case 'list':
    case 'session_list':
      return 'list';
    case 'new':
    case 'session_new':
      return 'new';
    case 'resume':
    case 'session_resume':
      return 'resume';
    case 'search':
    case 'session_search':
      return 'search';
    case 'grep':
    case 'session_grep':
      return 'grep';
    case 'list_continuity':
    case 'continuity_list':
      return 'list_continuity';
    case 'checkpoint':
      return 'checkpoint';
    case 'wake_return':
    case 'wake_return_summary':
      return 'wake_return';
    case 'start_focus':
    case 'focus_start':
      return 'start_focus';
    case 'complete_focus':
    case 'focus_complete':
      return 'complete_focus';
    default:
      throw new Error(`action must be one of: ${SESSION_TOOL_ACTION_HELP}`);
  }
}

function resolveContinuityTargetSessionId(
  manager: SessionToolManager,
  channelId?: string,
): string | null {
  if (typeof channelId === 'string' && channelId.trim().length > 0) {
    return channelId.trim();
  }

  const requestChannelId = getRequestContext()?.channelId;
  if (typeof requestChannelId === 'string' && requestChannelId.trim().length > 0) {
    return requestChannelId.trim();
  }

  const activeSessionId = manager.getActiveContextSession();
  if (typeof activeSessionId === 'string' && activeSessionId.trim().length > 0) {
    return activeSessionId.trim();
  }

  return null;
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
      if (isBackgroundContinuationContext()) {
        return rejectBackgroundSessionMutation('session_new');
      }
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
      if (isBackgroundContinuationContext()) {
        return rejectBackgroundSessionMutation('session_resume');
      }
      const requestedSessionId = params.sessionId.trim();
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

export function createSessionTool(options: UnifiedSessionToolOptions): AgentTool<any> {
  const sessionSearchTool = createSessionSearchTool(options.manager, options.llmProvider);
  const sessionGrepTool = createSessionGrepTool({
    sessionsDir: options.sessionsDir,
    ...(options.runRipgrep ? { runRipgrep: options.runRipgrep } : {}),
  });
  const continuityArtifactStore = new SessionContinuityArtifactStore(
    resolveSessionContinuityArtifactsDir(options.dataDir),
  );
  const sessionNewTool = createSessionNewTool(options);
  const sessionListTool = createSessionListTool(options.manager, options);
  const sessionResumeTool = createSessionResumeTool(options.manager, options);
  const startFocusTool = createStartFocusTool(options.manager);
  const completeFocusTool = createCompleteFocusTool(options.manager, options.llmProvider);

  return {
    name: 'session',
    label: 'session',
    description:
      'Unified session continuity surface for list/search/grep/new/resume, low-stress continuity checkpoints, '
      + 'wake/return summaries, and focus workflow actions. '
      + `Use action=${SESSION_TOOL_ACTION_HELP}. Legacy action aliases remain available during migration.`,
    parameters: Type.Object({
      action: Type.Optional(Type.Union(SESSION_TOOL_ACTION_NAMES.map((action) => Type.Literal(action)), {
        description:
          'Session action. Defaults to list when omitted and no action-specific parameters are provided.',
      })),
      limit: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_SESSION_LIST_LIMIT,
        description: 'Optional result limit for list/search/grep actions.',
      })),
      sessionId: Type.Optional(Type.String({
        minLength: 1,
        description: 'Session ID for action=resume.',
      })),
      query: Type.Optional(Type.String({
        minLength: 1,
        description: 'Transcript query for action=search.',
      })),
      summarize: Type.Optional(Type.Boolean({
        description: 'When true, action=search adds a short synthesis over the visible hits.',
      })),
      pattern: Type.Optional(Type.String({
        minLength: 1,
        description: 'Literal text or regex pattern for action=grep.',
      })),
      mode: Type.Optional(Type.Union([
        Type.Literal('literal'),
        Type.Literal('regex'),
      ], {
        description: 'Match mode for action=grep. Defaults to literal.',
      })),
      caseSensitive: Type.Optional(Type.Boolean({
        description: 'Case-sensitive match flag for action=grep.',
      })),
      metadata: Type.Optional(Type.Record(
        Type.String(),
        Type.Unknown(),
        {
          description: 'Optional metadata for action=new.',
        },
      )),
      channelId: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional exact channel/session scope filter, focus target, or continuity target session.',
      })),
      summary: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 800,
        description: 'Bounded continuity summary text for action=checkpoint or action=wake_return.',
      })),
      next_anchor: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 240,
        description: 'Optional gentle next-step anchor for action=checkpoint or action=wake_return.',
      })),
      facets: Type.Optional(Type.Array(Type.Union([
        Type.Literal('task'),
        Type.Literal('relational'),
        Type.Literal('life'),
      ]), {
        maxItems: 3,
        uniqueItems: true,
        description:
          'Optional continuity facets. Use these to mark whether the note is task, relational, life continuity, or a mix.',
      })),
      occasion: Type.Optional(Type.Union([
        Type.Literal('wake'),
        Type.Literal('return'),
      ], {
        description: 'Required for action=wake_return. Distinguishes wake summaries from return-after-absence summaries.',
      })),
      kind: Type.Optional(Type.Union([
        Type.Literal('checkpoint'),
        Type.Literal('wake_return'),
      ], {
        description: 'Optional filter for action=list_continuity.',
      })),
      scope: Type.Optional(Type.String({
        minLength: 1,
        description: 'Focus scope for action=start_focus.',
      })),
      conclusion: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional completion notes for action=complete_focus.',
      })),
    }),
    execute: async (
      toolCallId: string,
      params: SessionToolParams,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<Record<string, unknown>>> => {
      try {
        switch (normalizeSessionAction(params)) {
          case 'list':
            return sessionListTool.execute(toolCallId, {
              ...(typeof params.limit === 'number' ? { limit: params.limit } : {}),
            }, signal);
          case 'new':
            return sessionNewTool.execute(toolCallId, {
              ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
            }, signal);
          case 'resume':
            return sessionResumeTool.execute(toolCallId, {
              sessionId: typeof params.sessionId === 'string' ? params.sessionId : '',
            }, signal);
          case 'search':
            return sessionSearchTool.execute(toolCallId, {
              query: typeof params.query === 'string' ? params.query : '',
              ...(typeof params.limit === 'number' ? { limit: params.limit } : {}),
              ...(typeof params.channelId === 'string' ? { channelId: params.channelId } : {}),
              ...(typeof params.summarize === 'boolean' ? { summarize: params.summarize } : {}),
            }, signal);
          case 'grep':
            return sessionGrepTool.execute(toolCallId, {
              pattern: typeof params.pattern === 'string' ? params.pattern : '',
              ...(typeof params.mode === 'string' ? { mode: params.mode } : {}),
              ...(typeof params.caseSensitive === 'boolean' ? { caseSensitive: params.caseSensitive } : {}),
              ...(typeof params.limit === 'number' ? { limit: params.limit } : {}),
              ...(typeof params.channelId === 'string' ? { channelId: params.channelId } : {}),
            }, signal);
          case 'list_continuity': {
            const targetSessionId = resolveContinuityTargetSessionId(options.manager, params.channelId);
            if (!targetSessionId) {
              return textResultWithError(
                'session list_continuity failed: unable to resolve channelId for this turn.',
                true,
              );
            }

            const artifacts = continuityArtifactStore.listRecent(targetSessionId, {
              ...(typeof params.limit === 'number' ? { limit: params.limit } : {}),
              ...(typeof params.kind === 'string' ? { kind: params.kind } : {}),
            });
            return textResult(JSON.stringify({
              sessionId: targetSessionId,
              count: artifacts.length,
              artifacts,
            }, null, 2));
          }
          case 'checkpoint': {
            const targetSessionId = resolveContinuityTargetSessionId(options.manager, params.channelId);
            if (!targetSessionId) {
              return textResultWithError(
                'session checkpoint failed: unable to resolve channelId for this turn.',
                true,
              );
            }

            const artifact = continuityArtifactStore.append({
              sessionId: targetSessionId,
              kind: 'checkpoint',
              summary: typeof params.summary === 'string' ? params.summary : '',
              ...(typeof params.next_anchor === 'string' ? { nextAnchor: params.next_anchor } : {}),
              ...(Array.isArray(params.facets) ? { facets: params.facets } : {}),
            });
            return {
              content: [{
                type: 'text',
                text:
                  `session checkpoint saved for "${targetSessionId}" (id ${artifact.id}).`
                  + `${artifact.nextAnchor ? ` Next anchor: ${artifact.nextAnchor}.` : ''}`,
              }] satisfies TextContent[],
              details: {
                sessionId: targetSessionId,
                artifact,
              },
            };
          }
          case 'wake_return': {
            const targetSessionId = resolveContinuityTargetSessionId(options.manager, params.channelId);
            if (!targetSessionId) {
              return textResultWithError(
                'session wake_return failed: unable to resolve channelId for this turn.',
                true,
              );
            }

            const artifact = continuityArtifactStore.append({
              sessionId: targetSessionId,
              kind: 'wake_return',
              summary: typeof params.summary === 'string' ? params.summary : '',
              occasion: params.occasion,
              ...(typeof params.next_anchor === 'string' ? { nextAnchor: params.next_anchor } : {}),
              ...(Array.isArray(params.facets) ? { facets: params.facets } : {}),
            });
            return {
              content: [{
                type: 'text',
                text:
                  `session ${artifact.occasion}_summary saved for "${targetSessionId}" (id ${artifact.id}).`
                  + `${artifact.nextAnchor ? ` Next anchor: ${artifact.nextAnchor}.` : ''}`,
              }] satisfies TextContent[],
              details: {
                sessionId: targetSessionId,
                artifact,
              },
            };
          }
          case 'start_focus':
            return startFocusTool.execute(toolCallId, {
              scope: typeof params.scope === 'string' ? params.scope : '',
              ...(typeof params.channelId === 'string' ? { channelId: params.channelId } : {}),
            }, signal);
          case 'complete_focus':
            return completeFocusTool.execute(toolCallId, {
              ...(typeof params.channelId === 'string' ? { channelId: params.channelId } : {}),
              ...(typeof params.conclusion === 'string' ? { conclusion: params.conclusion } : {}),
            }, signal);
        }
      } catch (error) {
        return textResultWithError(`session failed: ${toErrorMessage(error)}.`, true);
      }
    },
  };
}
