import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { LLMProviderPort } from '../agent/contracts.js';
import type { SessionEntry, JournalEntry } from '../session/types.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import type { TrustLevel } from '../../system/trust/types.js';
import type { PromptRegistryStatePort } from '../identity/prompt-state-port.js';
import { normalizeChannelPrivacy, type ChannelPrivacy } from '../../system/trust/context-envelope.js';
import type { TranscriptSearchPort } from '../../persistence/sessions/transcript-search-port.js';
import {
  canViewerAccessSessionHit,
  resolveSessionSearchRouteLabel,
  resolveSessionSearchHitVisibility,
  runSessionSearch,
  truncateSessionSearchSnippet,
  type SessionSearchRouteLabel,
  type SessionSearchRouteStateProvider,
  type SessionSearchViewerContext,
} from '../session/search-runtime.js';
import { textResult, textResultWithError } from './results.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { isCogSecTombstoneSessionEntry } from '../cogsec/tombstones.js';

const DEFAULT_SESSION_GREP_LIMIT = 10;
const MAX_SESSION_GREP_LIMIT = 50;
const SESSION_GREP_OVERSAMPLE_FACTOR = 6;
const SESSION_GREP_SNIPPET_RADIUS = 90;

type SessionGrepMode = 'literal' | 'regex';

export interface SessionGrepHitResult {
  channelId: string;
  messageId: number;
  role: SessionEntry['role'];
  timestamp: number;
  channelVisibility: ChannelPrivacy;
  authorName?: string;
  filePath: string;
  lineNumber: number;
  snippet: string;
  sessionRoute?: SessionSearchRouteLabel;
}

export interface SessionGrepResult {
  pattern: string;
  mode: SessionGrepMode;
  caseSensitive: boolean;
  truncated: boolean;
  scannedMatchCount: number;
  gatedOutCount: number;
  hits: SessionGrepHitResult[];
}

interface SessionGrepRawMatch {
  filePath: string;
  lineNumber: number;
  lineText: string;
}

interface SessionGrepRunnerResult {
  matches: SessionGrepRawMatch[];
  truncated: boolean;
}

interface SessionGrepRunnerParams {
  sessionsDir: string;
  pattern: string;
  mode: SessionGrepMode;
  caseSensitive: boolean;
  maxMatches: number;
  signal?: AbortSignal;
}

export interface SessionGrepToolOptions {
  sessionsDir: string;
  runRipgrep?: (params: SessionGrepRunnerParams) => Promise<SessionGrepRunnerResult>;
  sessionRouteState?: SessionSearchRouteStateProvider;
}

function asSessionRouteStateProvider(value: unknown): SessionSearchRouteStateProvider | undefined {
  const candidate = value as {
    getRouteForLogicalSession?: unknown;
    getSessionRouteForLogicalSession?: unknown;
  } | null | undefined;
  return typeof candidate?.getRouteForLogicalSession === 'function'
    || typeof candidate?.getSessionRouteForLogicalSession === 'function'
    ? value as SessionSearchRouteStateProvider
    : undefined;
}

function normalizeOptionalTrustLevel(value: unknown): TrustLevel | undefined {
  switch (value) {
    case 'primary':
    case 'trusted':
    case 'regular':
    case 'public':
      return value;
    default:
      return undefined;
  }
}

function normalizeOptionalChannelVisibility(value: unknown): ChannelPrivacy | undefined {
  return normalizeChannelPrivacy(value);
}

function resolveViewerContextFromRequest(): SessionSearchViewerContext {
  const requestContext = getRequestContext();
  const channelId = typeof requestContext?.channelId === 'string' && requestContext.channelId.trim().length > 0
    ? requestContext.channelId.trim()
    : undefined;
  const trustLevel = normalizeOptionalTrustLevel(requestContext?.viewerTrustLevel);
  const channelVisibility = normalizeOptionalChannelVisibility(requestContext?.viewerChannelPrivacy);
  return {
    ...(channelId ? { channelId } : {}),
    ...(trustLevel ? { trustLevel } : {}),
    ...(channelVisibility ? { channelVisibility } : {}),
    ...(typeof requestContext?.viewerIsDirectMessage === 'boolean'
      ? { isDirectMessage: requestContext.viewerIsDirectMessage }
      : {}),
  };
}

function normalizeSessionGrepLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined) {
    return DEFAULT_SESSION_GREP_LIMIT;
  }
  const normalized = Math.floor(limit);
  if (normalized <= 0) return DEFAULT_SESSION_GREP_LIMIT;
  return Math.min(normalized, MAX_SESSION_GREP_LIMIT);
}

function buildSessionMatchSnippet(
  content: string,
  pattern: string,
  mode: SessionGrepMode,
  caseSensitive: boolean,
): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  let matchIndex = -1;
  let matchLength = pattern.length;
  if (mode === 'literal') {
    matchIndex = caseSensitive
      ? normalized.indexOf(pattern)
      : normalized.toLowerCase().indexOf(pattern.toLowerCase());
  } else {
    try {
      const regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
      const match = regex.exec(normalized);
      if (match && typeof match.index === 'number') {
        matchIndex = match.index;
        matchLength = Math.max(1, match[0].length);
      }
    } catch {
      return truncateSessionSearchSnippet(normalized);
    }
  }

  if (matchIndex < 0) {
    return truncateSessionSearchSnippet(normalized);
  }

  const start = Math.max(0, matchIndex - SESSION_GREP_SNIPPET_RADIUS);
  const end = Math.min(normalized.length, matchIndex + matchLength + SESSION_GREP_SNIPPET_RADIUS);
  const snippet = normalized.slice(start, end).trim();
  const prefix = start > 0 ? '... ' : '';
  const suffix = end < normalized.length ? ' ...' : '';
  return `${prefix}${snippet}${suffix}`;
}

function parseJournalMessageEntry(lineText: string): (JournalEntry & {
  type: 'message';
  role: SessionEntry['role'];
  content: string;
  timestamp: number;
  channelId: string;
}) | null {
  try {
    const parsed = JSON.parse(lineText) as Partial<JournalEntry>;
    if (
      parsed.type !== 'message'
      || typeof parsed.channelId !== 'string'
      || typeof parsed.role !== 'string'
      || typeof parsed.content !== 'string'
      || typeof parsed.timestamp !== 'number'
      || !Number.isFinite(parsed.timestamp)
      || typeof parsed.id !== 'number'
      || !Number.isFinite(parsed.id)
    ) {
      return null;
    }
    return parsed as JournalEntry & {
      type: 'message';
      role: SessionEntry['role'];
      content: string;
      timestamp: number;
      channelId: string;
    };
  } catch {
    return null;
  }
}

async function runRipgrepSearch(params: SessionGrepRunnerParams): Promise<SessionGrepRunnerResult> {
  const args = [
    '--json',
    '--no-config',
    '--line-number',
    '--color',
    'never',
    '--glob',
    '*.jsonl',
    '--glob',
    '!user_*.jsonl',
    '--glob',
    '!_*.json',
    '--glob',
    '!_*.jsonl',
    '--glob',
    '!_turn_records/**',
  ];
  if (params.mode === 'literal') {
    args.push('-F');
  }
  if (!params.caseSensitive) {
    args.push('-i');
  }
  args.push(params.pattern, '.');

  return new Promise<SessionGrepRunnerResult>((resolve, reject) => {
    const child = spawn('rg', args, {
      cwd: params.sessionsDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = createInterface({ input: child.stdout! });
    const matches: SessionGrepRawMatch[] = [];
    let stderr = '';
    let truncated = false;
    let settled = false;
    let aborted = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      stdout.close();
      fn();
    };

    const stopProcess = () => {
      if (child.killed) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore already-exited process teardown failures.
      }
    };

    const abortHandler = () => {
      aborted = true;
      stopProcess();
    };

    params.signal?.addEventListener('abort', abortHandler, { once: true });

    child.stderr!.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      params.signal?.removeEventListener('abort', abortHandler);
      settle(() => reject(error));
    });

    stdout.on('line', (line) => {
      if (settled || !line) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event.type !== 'match') return;
      const data = event.data as {
        path?: { text?: string };
        line_number?: number;
        lines?: { text?: string };
      } | undefined;
      const filePath = data?.path?.text;
      const lineNumber = data?.line_number;
      const lineText = data?.lines?.text;
      if (typeof filePath !== 'string' || typeof lineNumber !== 'number' || typeof lineText !== 'string') {
        return;
      }
      matches.push({
        filePath,
        lineNumber,
        lineText: lineText.trimEnd(),
      });
      if (matches.length >= params.maxMatches) {
        truncated = true;
        stopProcess();
      }
    });

    child.on('close', (code, signal) => {
      params.signal?.removeEventListener('abort', abortHandler);
      if (aborted || params.signal?.aborted) {
        settle(() => reject(new Error('session_grep aborted')));
        return;
      }
      if (truncated || signal === 'SIGTERM') {
        settle(() => resolve({ matches, truncated: true }));
        return;
      }
      if (code === 0 || code === 1) {
        settle(() => resolve({ matches, truncated: false }));
        return;
      }
      const message = stderr.trim() || `rg exited with code ${code ?? 'unknown'}`;
      settle(() => reject(new Error(message)));
    });
  });
}

export interface SessionSearchActionOptions {
  transcriptSearch: TranscriptSearchPort;
  llmProvider: LLMProviderPort;
  sessionRouteState?: SessionSearchRouteStateProvider;
  promptRegistry?: PromptRegistryStatePort | null;
}

export interface SessionSearchActionParams {
  query?: string;
  limit?: number;
  channelId?: string;
  summarize?: boolean;
}

export async function executeSessionSearchAction(
  options: SessionSearchActionOptions,
  params: SessionSearchActionParams,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const query = (params.query ?? '').trim();
  if (!query) {
    return textResultWithError('session_search requires a non-empty query.', true);
  }

  const result = await runSessionSearch({
    transcriptSearch: options.transcriptSearch,
    llmProvider: options.llmProvider,
    promptRegistry: options.promptRegistry ?? null,
    query,
    limit: params.limit,
    summarize: params.summarize === true,
    targetChannelId: params.channelId,
    viewer: resolveViewerContextFromRequest(),
    sessionRouteState: options.sessionRouteState
      ?? asSessionRouteStateProvider(options.transcriptSearch),
  });
  return textResult(JSON.stringify(result, null, 2));
}

export interface SessionGrepActionParams {
  pattern: string;
  mode?: SessionGrepMode;
  caseSensitive?: boolean;
  limit?: number;
  channelId?: string;
}

export async function executeSessionGrepAction(
  options: SessionGrepToolOptions,
  params: SessionGrepActionParams,
  signal?: AbortSignal,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const grepRunner = options.runRipgrep ?? runRipgrepSearch;
  const pattern = params.pattern.trim();
  if (!pattern) {
    return textResultWithError('session_grep requires a non-empty pattern.', true);
  }

  const mode: SessionGrepMode = params.mode === 'regex' ? 'regex' : 'literal';
  const caseSensitive = params.caseSensitive === true;
  const limit = normalizeSessionGrepLimit(params.limit);
  const channelId = typeof params.channelId === 'string' && params.channelId.trim().length > 0
    ? params.channelId.trim()
    : undefined;
  const viewer = resolveViewerContextFromRequest();

  try {
    const raw = await grepRunner({
      sessionsDir: options.sessionsDir,
      pattern,
      mode,
      caseSensitive,
      maxMatches: limit * SESSION_GREP_OVERSAMPLE_FACTOR,
      signal,
    });

    const visibleHits: SessionGrepHitResult[] = [];
    let scannedMatchCount = 0;
    let gatedOutCount = 0;

    for (const match of raw.matches) {
      const entry = parseJournalMessageEntry(match.lineText);
      if (!entry) continue;
      if (isCogSecTombstoneSessionEntry(entry)) continue;
      if (channelId && entry.channelId !== channelId) continue;
      scannedMatchCount += 1;
      if (!canViewerAccessSessionHit(viewer, entry)) {
        gatedOutCount += 1;
        continue;
      }
      const sessionRoute = resolveSessionSearchRouteLabel(options.sessionRouteState, entry.channelId);
      visibleHits.push({
        channelId: entry.channelId,
        messageId: entry.id,
        role: entry.role,
        timestamp: entry.timestamp,
        channelVisibility: resolveSessionSearchHitVisibility(entry.channelVisibility, entry.channelId),
        ...(typeof entry.authorName === 'string' && entry.authorName.trim().length > 0
          ? { authorName: entry.authorName.trim() }
          : {}),
        filePath: match.filePath,
        lineNumber: match.lineNumber,
        snippet: buildSessionMatchSnippet(entry.content, pattern, mode, caseSensitive),
        ...(sessionRoute ? { sessionRoute } : {}),
      });
      if (visibleHits.length >= limit) {
        break;
      }
    }

    const result: SessionGrepResult = {
      pattern,
      mode,
      caseSensitive,
      truncated: raw.truncated,
      scannedMatchCount,
      gatedOutCount,
      hits: visibleHits,
    };
    return textResult(JSON.stringify(result, null, 2));
  } catch (error) {
    return textResultWithError(`session_grep failed: ${toErrorMessage(error)}`, true);
  }
}
