import type { LLMProviderPort } from '../../agent/contracts.js';
import { countMessageTokens } from '../../../primitives/llm/tokens.js';
import type { ContextMessage } from '../../../shared/contracts/runtime.js';
import {
  buildAuthenticityProvenance,
  DERIVED_DETAIL_LOSS_NOTE,
  DERIVED_EMOTIONAL_TEXTURE_NOTE,
} from '../../../shared/authenticity-provenance.js';
import { SESSION_HISTORY_MIN_MESSAGES } from '../../../shared/context-budget.js';
import type { PromptRegistryStatePort } from '../../identity/prompt-state-port.js';
import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { SessionEntry } from '../types.js';
import {
  buildRecentSessionSummaryFallbackText,
  isUntrustedVisibility,
  repairLeadingMultimodalReviewBoundary,
  trimRecentEntriesToTokenBudget,
  wrapUntrustedContext,
} from '../manager-primitives.js';
import { entriesToMessages } from './context-support.js';
import { summarizeRecentSessionEntries } from './compaction-service.js';

const MIN_HISTORY_SUMMARY_TOKEN_BUDGET = 32;

function buildHistorySummaryMessage(
  summaryText: string,
  channelVisibility: ChannelPrivacy,
  sourceSpanCount: number,
): ContextMessage {
  const content = isUntrustedVisibility(channelVisibility)
    ? wrapUntrustedContext(summaryText)
    : summaryText;
  return {
    role: 'system',
    content,
    provenance: buildAuthenticityProvenance({
      kind: 'compaction_summary',
      sourceAuthor: 'mixed',
      transformedBy: 'compaction',
      wording: 'derived',
      directSpeech: false,
      detailLoss: 'possible',
      emotionalTexture: 'may_be_flattened',
      safeAsPartnerSpeech: false,
      sourceSpanCount,
      notes: [DERIVED_DETAIL_LOSS_NOTE, DERIVED_EMOTIONAL_TEXTURE_NOTE],
    }),
  };
}

export function buildSessionHistoryMessages(
  verbatimEntries: SessionEntry[],
  channelVisibility: ChannelPrivacy,
  renderGroupUserAttribution: boolean,
  summaryText?: string,
  summarySourceSpanCount = 0,
): ContextMessage[] {
  const trimmedSummary = summaryText?.trim();
  const tailMessages = entriesToMessages(
    verbatimEntries,
    channelVisibility,
    true,
    Boolean(trimmedSummary),
    renderGroupUserAttribution,
  );
  if (!trimmedSummary) {
    return tailMessages;
  }
  return [
    buildHistorySummaryMessage(trimmedSummary, channelVisibility, summarySourceSpanCount),
    ...tailMessages,
  ];
}

export async function assembleSessionHistoryForContextWithLlmSummary(params: {
  entries: SessionEntry[];
  channelVisibility: ChannelPrivacy;
  renderGroupUserAttribution: boolean;
  tokenBudget: number;
  characterName?: string;
  channelId: string;
  llmProvider?: LLMProviderPort;
  promptRegistry: PromptRegistryStatePort | null;
}): Promise<{
  summaryText: string;
  summarizedEntryCount: number;
  verbatimEntries: SessionEntry[];
  messages: ContextMessage[];
}> {
  const directAssembly = assembleVerbatimSessionHistory(params);
  if (directAssembly) return directAssembly;

  const candidate = selectHistorySummaryCandidate(params);
  if (candidate) {
    const generatedSummaryText = await summarizeRecentSessionEntries({
      channelId: params.channelId,
      entries: candidate.summaryEntries,
      characterName: params.characterName,
      llmProvider: params.llmProvider,
      promptRegistry: params.promptRegistry,
      maxTokens: candidate.remainingBudget,
      purpose: 'history_budget',
    });
    const fittedGeneratedSummaryText = fitHistorySummaryTextToBudget({
      summaryText: generatedSummaryText,
      candidate,
      channelVisibility: params.channelVisibility,
      renderGroupUserAttribution: params.renderGroupUserAttribution,
      tokenBudget: params.tokenBudget,
    });
    if (fittedGeneratedSummaryText) {
      return buildHistoryAssemblyFromSummary({
        summaryText: fittedGeneratedSummaryText,
        candidate,
        channelVisibility: params.channelVisibility,
        renderGroupUserAttribution: params.renderGroupUserAttribution,
      });
    }
  }

  return assembleTrimmedSessionHistory(params);
}

interface HistorySummaryCandidate {
  summaryEntries: SessionEntry[];
  verbatimEntries: SessionEntry[];
  remainingBudget: number;
}

function assembleVerbatimSessionHistory(params: {
  entries: SessionEntry[];
  channelVisibility: ChannelPrivacy;
  renderGroupUserAttribution: boolean;
  tokenBudget: number;
}): {
  summaryText: string;
  summarizedEntryCount: number;
  verbatimEntries: SessionEntry[];
  messages: ContextMessage[];
} | null {
  const allMessages = entriesToMessages(
    params.entries,
    params.channelVisibility,
    true,
    false,
    params.renderGroupUserAttribution,
  );
  if (params.entries.length <= SESSION_HISTORY_MIN_MESSAGES || countMessageTokens(allMessages) <= params.tokenBudget) {
    return {
      summaryText: '',
      summarizedEntryCount: 0,
      verbatimEntries: params.entries,
      messages: allMessages,
    };
  }

  return null;
}

function selectHistorySummaryCandidate(params: {
  entries: SessionEntry[];
  channelVisibility: ChannelPrivacy;
  renderGroupUserAttribution: boolean;
  tokenBudget: number;
}): HistorySummaryCandidate | null {
  const maxSplitIndex = params.entries.length - SESSION_HISTORY_MIN_MESSAGES;
  for (let splitIndex = 1; splitIndex <= maxSplitIndex; splitIndex += 1) {
    const initialVerbatimEntries = params.entries.slice(splitIndex);
    const boundaryRepairedVerbatimEntries = repairLeadingMultimodalReviewBoundary(
      params.entries,
      initialVerbatimEntries,
    );
    const boundaryPrependedCount = Math.max(
      0,
      boundaryRepairedVerbatimEntries.length - initialVerbatimEntries.length,
    );
    const safeSplitIndex = Math.max(0, splitIndex - boundaryPrependedCount);
    if (safeSplitIndex === 0) {
      continue;
    }
    const summaryEntries = params.entries.slice(0, safeSplitIndex);
    const verbatimEntries = boundaryPrependedCount > 0
      ? params.entries.slice(safeSplitIndex)
      : boundaryRepairedVerbatimEntries;
    const tailMessages = entriesToMessages(
      verbatimEntries,
      params.channelVisibility,
      true,
      true,
      params.renderGroupUserAttribution,
    );
    const tailTokenCount = countMessageTokens(tailMessages);
    const remainingBudget = params.tokenBudget - tailTokenCount;
    if (remainingBudget < MIN_HISTORY_SUMMARY_TOKEN_BUDGET) {
      continue;
    }

    return {
      summaryEntries,
      verbatimEntries,
      remainingBudget,
    };
  }

  return null;
}

function stripHistorySummaryHeader(summaryText: string): string {
  return summaryText
    .replace(/^\[History summary\]\s*/iu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function withHistorySummaryHeader(summaryText: string): string {
  const normalized = stripHistorySummaryHeader(summaryText);
  return normalized ? `[History summary]\n${normalized}` : '';
}

export function buildOrientationFallbackSummary(
  entries: readonly SessionEntry[],
  characterName?: string,
): string {
  return stripHistorySummaryHeader(buildRecentSessionSummaryFallbackText({
    entries,
    characterName,
    maxTokens: 96,
  }));
}

function fitHistorySummaryTextToBudget(params: {
  summaryText: string;
  candidate: HistorySummaryCandidate;
  channelVisibility: ChannelPrivacy;
  renderGroupUserAttribution: boolean;
  tokenBudget: number;
}): string {
  const normalized = stripHistorySummaryHeader(params.summaryText);
  if (!normalized) return '';

  let candidateText = withHistorySummaryHeader(normalized);
  for (;;) {
    const messages = buildSessionHistoryMessages(
      params.candidate.verbatimEntries,
      params.channelVisibility,
      params.renderGroupUserAttribution,
      candidateText,
      params.candidate.summaryEntries.length,
    );
    if (countMessageTokens(messages) <= params.tokenBudget) {
      return candidateText;
    }

    const body = stripHistorySummaryHeader(candidateText);
    if (body.length < 100) return '';
    candidateText = withHistorySummaryHeader(`${body.slice(0, Math.floor(body.length * 0.8)).trimEnd()}...`);
  }
}

function buildHistoryAssemblyFromSummary(params: {
  summaryText: string;
  candidate: HistorySummaryCandidate;
  channelVisibility: ChannelPrivacy;
  renderGroupUserAttribution: boolean;
}): {
  summaryText: string;
  summarizedEntryCount: number;
  verbatimEntries: SessionEntry[];
  messages: ContextMessage[];
} {
  const messages = buildSessionHistoryMessages(
    params.candidate.verbatimEntries,
    params.channelVisibility,
    params.renderGroupUserAttribution,
    params.summaryText,
    params.candidate.summaryEntries.length,
  );
  return {
    summaryText: params.summaryText,
    summarizedEntryCount: params.candidate.summaryEntries.length,
    verbatimEntries: params.candidate.verbatimEntries,
    messages,
  };
}

function assembleTrimmedSessionHistory(params: {
  entries: SessionEntry[];
  channelVisibility: ChannelPrivacy;
  renderGroupUserAttribution: boolean;
  tokenBudget: number;
}): {
  summaryText: string;
  summarizedEntryCount: number;
  verbatimEntries: SessionEntry[];
  messages: ContextMessage[];
} {
  const fallbackEntries = trimRecentEntriesToTokenBudget(params.entries, params.tokenBudget);
  return {
    summaryText: '',
    summarizedEntryCount: 0,
    verbatimEntries: fallbackEntries,
    messages: entriesToMessages(
      fallbackEntries,
      params.channelVisibility,
      true,
      false,
      params.renderGroupUserAttribution,
    ),
  };
}
