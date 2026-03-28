import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { LLMProvider } from '../core/agent/contracts.js';
import { getRequestContext } from '../llm/request-context.js';
import { textResultWithError } from './results.js';
import { toErrorMessage } from '../shared/utils/errors.js';

interface FocusSessionManager {
  getActiveContextSession(): string | null;
  startFocusSession(channelId: string, scope: string): {
    focusId: string;
    channelId: string;
    scope: string;
    startedAt: number;
    startEntryId: number;
    existingProjectContext: {
      knowledgeBlockCount: number;
      totalEvidenceCount: number;
      latestKnowledge: string;
    } | null;
  };
  getFocusSessionContext(channelId: string): {
    session: {
      focusId: string;
      channelId: string;
      scope: string;
      startedAt: number;
      startEntryId: number;
      evidenceCount: number;
    };
    rangeStartId: number;
    rangeEndId: number;
    entries: Array<{ id: number; role: string; content: string; authorName?: string }>;
    evidence: Array<{
      source: string;
      snippet: string;
      query?: string;
      resultCount?: number;
      attempt?: number;
      timestamp: number;
    }>;
  } | null;
  completeFocusSession(channelId: string, knowledge: string): {
    focusId: string;
    channelId: string;
    scope: string;
    rangeStartId: number | null;
    rangeEndId: number | null;
    knowledgeBlock: {
      id: string;
      evidenceCount: number;
      createdAt: number;
    };
    projectContext: {
      knowledgeBlockCount: number;
      totalEvidenceCount: number;
      latestKnowledge: string;
    };
  };
}

const MAX_FOCUS_TRANSCRIPT_LINES = 120;
const MAX_FOCUS_TRANSCRIPT_CHARS = 12_000;
const MAX_EVIDENCE_LINES = 24;
const MAX_LINE_CHARS = 260;

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function resolveTargetChannelId(
  sessionManager: FocusSessionManager,
  channelId?: string,
): string | null {
  if (typeof channelId === 'string' && channelId.trim().length > 0) {
    return channelId.trim();
  }

  const requestChannelId = getRequestContext()?.channelId;
  if (typeof requestChannelId === 'string' && requestChannelId.trim().length > 0) {
    return requestChannelId.trim();
  }

  const active = sessionManager.getActiveContextSession();
  if (typeof active === 'string' && active.trim().length > 0) {
    return active.trim();
  }
  return null;
}

function clampLine(value: string): string {
  const compact = compactText(value);
  if (compact.length <= MAX_LINE_CHARS) return compact;
  return `${compact.slice(0, MAX_LINE_CHARS - 3)}...`;
}

function formatFocusTranscript(
  entries: Array<{ id: number; role: string; content: string; authorName?: string }>,
): string {
  const lines = entries
    .slice(0, MAX_FOCUS_TRANSCRIPT_LINES)
    .map((entry) => {
      const author = clampLine(entry.authorName ?? entry.role);
      const content = clampLine(entry.content);
      return `${entry.id}. ${author} (${entry.role}): ${content}`;
    });
  const transcript = lines.join('\n');
  if (transcript.length <= MAX_FOCUS_TRANSCRIPT_CHARS) return transcript;
  return `${transcript.slice(0, MAX_FOCUS_TRANSCRIPT_CHARS - 3)}...`;
}

function formatFocusEvidence(
  evidence: Array<{
    source: string;
    snippet: string;
    query?: string;
    resultCount?: number;
    attempt?: number;
    timestamp: number;
  }>,
): string {
  if (evidence.length === 0) {
    return '- none';
  }

  return evidence
    .slice(0, MAX_EVIDENCE_LINES)
    .map((item, index) => {
      const source = clampLine(item.source);
      const snippet = clampLine(item.snippet);
      const query = item.query ? ` query="${clampLine(item.query)}"` : '';
      const resultCount = typeof item.resultCount === 'number' ? ` results=${item.resultCount}` : '';
      const attempt = typeof item.attempt === 'number' ? ` attempt=${item.attempt}` : '';
      return `${index + 1}. [${source}]${query}${resultCount}${attempt} -> ${snippet}`;
    })
    .join('\n');
}

function buildDistillationInput(params: {
  scope: string;
  conclusion?: string;
  transcript: string;
  evidenceText: string;
  evidenceCount: number;
}): string {
  const lines = [
    `Focus scope: ${params.scope}`,
    `Evidence count: ${params.evidenceCount}`,
    params.conclusion ? `Completion notes: ${params.conclusion}` : null,
    '',
    'Transcript excerpt:',
    params.transcript || '[none]',
    '',
    'Evidence log:',
    params.evidenceText,
  ];
  return lines.filter((line): line is string => line !== null).join('\n');
}

export function createStartFocusTool(sessionManager: FocusSessionManager): AgentTool<any> {
  return {
    name: 'start_focus',
    label: 'start_focus',
    description:
      'Start a scoped focus session for the current channel. A focus session records scope and supporting evidence'
      + ' until complete_focus persists distilled knowledge.',
    parameters: Type.Object({
      scope: Type.String({
        minLength: 1,
        description: 'What this focus session is trying to solve or learn.',
      }),
      channelId: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional explicit channel/session id override.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: { scope: string; channelId?: string },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<Record<string, unknown>>> => {
      const channelId = resolveTargetChannelId(sessionManager, params.channelId);
      if (!channelId) {
        return textResultWithError('start_focus failed: unable to resolve channelId for this turn.', true);
      }

      try {
        const started = sessionManager.startFocusSession(channelId, params.scope);
        const resumedContextText = started.existingProjectContext
          ? ` Resuming project context with ${started.existingProjectContext.knowledgeBlockCount} prior distilled block`
            + `${started.existingProjectContext.knowledgeBlockCount === 1 ? '' : 's'}.`
          : ' Starting a new project context.';
        return {
          content: [{
            type: 'text',
            text:
              `start_focus: tracking "${started.scope}" in ${started.channelId}`
              + ` (focusId=${started.focusId}, from entry ${started.startEntryId}).`
              + resumedContextText,
          }] satisfies TextContent[],
          details: {
            focusId: started.focusId,
            channelId: started.channelId,
            scope: started.scope,
            startedAt: started.startedAt,
            startEntryId: started.startEntryId,
            existingProjectContextBlockCount: started.existingProjectContext?.knowledgeBlockCount ?? 0,
            existingProjectContextEvidenceCount: started.existingProjectContext?.totalEvidenceCount ?? 0,
          },
        };
      } catch (error) {
        return textResultWithError(`start_focus failed: ${toErrorMessage(error)}.`, true);
      }
    },
  };
}

export function createCompleteFocusTool(
  sessionManager: FocusSessionManager,
  llmProvider: LLMProvider,
): AgentTool<any> {
  return {
    name: 'complete_focus',
    label: 'complete_focus',
    description:
      'Complete an active focus session by distilling a durable knowledge block with the helper context model'
      + ' and compacting the raw focus range from future context windows.',
    parameters: Type.Object({
      channelId: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional explicit channel/session id override.',
      })),
      conclusion: Type.Optional(Type.String({
        minLength: 1,
        description: 'Optional completion notes that should be considered while distilling knowledge.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: { channelId?: string; conclusion?: string },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<Record<string, unknown>>> => {
      const channelId = resolveTargetChannelId(sessionManager, params.channelId);
      if (!channelId) {
        return textResultWithError('complete_focus failed: unable to resolve channelId for this turn.', true);
      }

      const focusContext = sessionManager.getFocusSessionContext(channelId);
      if (!focusContext) {
        return textResultWithError(`complete_focus failed: no active focus session for "${channelId}".`, true);
      }

      const transcript = formatFocusTranscript(focusContext.entries);
      const evidenceText = formatFocusEvidence(focusContext.evidence);
      const requestContext = getRequestContext();
      const systemPrompt = [
        'You distill investigative work into durable operator knowledge.',
        'Return plain text only (no markdown code fences).',
        'Output format:',
        '1) A one-line title.',
        '2) Up to 6 short bullet points with concrete findings.',
        '3) One final "Open questions:" line (or "Open questions: none").',
        'Do not include speculative claims not supported by the transcript/evidence.',
      ].join('\n');

      const input = buildDistillationInput({
        scope: focusContext.session.scope,
        conclusion: params.conclusion,
        transcript,
        evidenceText,
        evidenceCount: focusContext.evidence.length,
      });

      try {
        const response = await llmProvider.complete(
          {
            systemPrompt,
            messages: [{ role: 'user', content: input }],
            correlation: {
              ...(requestContext?.turnId ? { turnId: requestContext.turnId } : {}),
              ...(requestContext?.requestId ? { requestId: `${requestContext.requestId}:focus_complete` } : {}),
              ...(requestContext?.channelId ? { channelId: requestContext.channelId } : {}),
              callType: 'summary',
              purpose: 'focus.complete.summary',
              originType: 'summary',
              originStage: 'focus.complete.summary',
              ...(requestContext?.toolName ? { toolName: requestContext.toolName } : {}),
              ...(requestContext?.toolCallId ? { toolCallId: requestContext.toolCallId } : {}),
            },
          },
          'context',
        );
        const distilledKnowledge = compactText(response.content);
        if (!distilledKnowledge) {
          return textResultWithError('complete_focus failed: helper model returned an empty summary.', true);
        }

        const completed = sessionManager.completeFocusSession(channelId, distilledKnowledge);
        return {
          content: [{
            type: 'text',
            text:
              `complete_focus: persisted knowledge block ${completed.knowledgeBlock.id} for "${completed.scope}".\n`
              + `Project context now has ${completed.projectContext.knowledgeBlockCount} distilled block`
              + `${completed.projectContext.knowledgeBlockCount === 1 ? '' : 's'}.\n`
              + `${distilledKnowledge}`,
          }] satisfies TextContent[],
          details: {
            focusId: completed.focusId,
            channelId: completed.channelId,
            scope: completed.scope,
            rangeStartId: completed.rangeStartId,
            rangeEndId: completed.rangeEndId,
            knowledgeBlockId: completed.knowledgeBlock.id,
            knowledgeCreatedAt: completed.knowledgeBlock.createdAt,
            evidenceCount: completed.knowledgeBlock.evidenceCount,
            projectContextBlockCount: completed.projectContext.knowledgeBlockCount,
            projectContextEvidenceCount: completed.projectContext.totalEvidenceCount,
          },
        };
      } catch (error) {
        return textResultWithError(`complete_focus failed: ${toErrorMessage(error)}.`, true);
      }
    },
  };
}
