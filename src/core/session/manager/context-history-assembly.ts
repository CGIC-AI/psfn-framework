import { countMessageTokens } from '../../../primitives/llm/tokens.js';
import type { ContextMessage } from '../../../shared/contracts/runtime.js';
import {
  buildAuthenticityProvenance,
  DERIVED_DETAIL_LOSS_NOTE,
  DERIVED_EMOTIONAL_TEXTURE_NOTE,
} from '../../../shared/authenticity-provenance.js';
import { SESSION_HISTORY_MIN_MESSAGES } from '../../../shared/context-budget.js';
import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { SessionEntry } from '../types.js';
import { filterSupersededTemporalWakeupRefreshers } from '../session-lane-metadata.js';
import {
  buildRecentSessionSummaryFallbackText,
  isUntrustedVisibility,
  trimRecentEntriesToTokenBudget,
  wrapUntrustedContext,
} from '../manager-primitives.js';
import { entriesToMessages } from './context-support.js';

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

export async function assembleSessionHistoryForContext(params: {
  entries: SessionEntry[];
  channelVisibility: ChannelPrivacy;
  renderGroupUserAttribution: boolean;
  tokenBudget: number;
}): Promise<{
  summaryText: string;
  summarizedEntryCount: number;
  verbatimEntries: SessionEntry[];
  messages: ContextMessage[];
}> {
  const projectedParams = {
    ...params,
    entries: filterSupersededTemporalWakeupRefreshers(params.entries),
  };
  const directAssembly = assembleVerbatimSessionHistory(projectedParams);
  if (directAssembly) return directAssembly;

  return assembleTrimmedSessionHistory(projectedParams);
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


function stripHistorySummaryHeader(summaryText: string): string {
  return summaryText
    .replace(/^\[History summary\]\s*/iu, '')
    .replace(/\s+/g, ' ')
    .trim();
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
