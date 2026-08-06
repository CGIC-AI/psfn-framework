import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../../faculties/memory/types.js';
import type { EpisodicStorePort } from '../../../faculties/memory/episodic/store-port.js';
import type { Episode } from '../../../shared/contracts/episodic-memory.js';
import type { SessionEntry } from '../../session/types.js';
import type { PromptAssemblyGateSummary } from '../../session/intake-sink-gating.js';
import { REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT } from './runtime-helpers.js';

const DAILY_REVIEW_EVIDENCE_SHAPE = Object.freeze({
  conversationSamples: 3,
  episodeSamples: 2,
  memorySamples: 3,
  lineLength: 220,
});

export const DAILY_REVIEW_EVIDENCE_DEGRADATION = Object.freeze({
  metacognitiveFlag: Object.freeze({
    flag: 'daily_review_evidence_degraded',
    confidence: 1,
    evidence: 'The bounded daily evidence summary was empty, incomplete, or unavailable.',
  }),
  dailyJournalTags: Object.freeze([
    'degraded',
    'daily-evidence-unavailable',
  ]),
});

export type DailyReviewEvidenceScope =
  | { kind: 'contact'; sessionId: string; canonicalContactId: string }
  | { kind: 'group'; sessionId: string }
  | { kind: 'companion' };

interface DailyReviewEvidenceLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface DailyReviewEvidenceResult {
  promptSection: string;
  provenanceRefs: string[];
  degraded: boolean;
  degradationReasons: string[];
}

export interface CollectDailyReviewEvidenceInput {
  nowMs: number;
  windowMs: number;
  scope: DailyReviewEvidenceScope;
  sessionManager?: {
    getRecentMessages(channelId: string, limit?: number): SessionEntry[];
    getConversationEvidenceWindow?(
      channelId: string,
      options: { fromMs: number; toMs: number; limit: number },
    ): {
      entries: SessionEntry[];
      saturated: boolean;
      promptAssemblyGate?: PromptAssemblyGateSummary;
    };
  };
  episodicStore?: Pick<EpisodicStorePort, 'searchByTime'> | null;
  memoryStore?: Pick<MemoryStorePort, 'listActiveMemories' | 'listActiveMemoriesInWindow'> | null;
  logger?: DailyReviewEvidenceLogger;
}

function truncateEvidenceLine(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= DAILY_REVIEW_EVIDENCE_SHAPE.lineLength) {
    return normalized;
  }
  return `${normalized.slice(0, DAILY_REVIEW_EVIDENCE_SHAPE.lineLength - 1).trimEnd()}…`;
}

function selectEvenlyDistributed<T>(values: readonly T[], limit: number): T[] {
  if (limit < 1 || values.length === 0) {
    return [];
  }
  if (values.length <= limit) {
    return [...values];
  }
  if (limit === 1) {
    return [values.at(-1)!];
  }
  return Array.from({ length: limit }, (_, index) => (
    values[Math.floor((index * (values.length - 1)) / (limit - 1))]!
  ));
}

function normalizeConversationEntries(
  entries: readonly SessionEntry[],
  expectedSessionId: string,
  windowStartMs: number,
  nowMs: number,
): SessionEntry[] {
  return entries
    .filter(entry => (
      entry.channelId === expectedSessionId
      && (entry.role === 'user' || entry.role === 'assistant')
      && Number.isFinite(entry.timestamp)
      && entry.timestamp >= windowStartMs
      && entry.timestamp <= nowMs
      && entry.content.trim().length > 0
    ))
    .sort((left, right) => left.timestamp - right.timestamp || left.id - right.id);
}

function formatConversationLine(entry: SessionEntry): string {
  const speaker = entry.authorName?.trim()
    || (entry.role === 'assistant' ? 'Companion' : 'Contact');
  return truncateEvidenceLine(`${speaker}: ${entry.content}`);
}

function isSameConversationScope(left: string | undefined, right: string): boolean {
  return left === right;
}

function memoryMatchesScope(memory: PurrMemory, scope: DailyReviewEvidenceScope): boolean {
  if (scope.kind === 'companion') {
    return true;
  }
  const sourceChannelId = memory.provenance?.channelId?.trim();
  const conversationScopeId = memory.scopeRef?.kind === 'conversation'
    ? memory.scopeRef.id.trim()
    : undefined;
  if (scope.kind === 'group') {
    return isSameConversationScope(sourceChannelId, scope.sessionId)
      || isSameConversationScope(conversationScopeId, scope.sessionId);
  }
  return memory.contactId === scope.canonicalContactId
    || isSameConversationScope(sourceChannelId, scope.sessionId)
    || isSameConversationScope(conversationScopeId, scope.sessionId);
}

function formatEpisodeLine(value: Episode): string {
  return truncateEvidenceLine(`${value.title}: ${value.landmark}`);
}

function formatMemoryLine(value: PurrMemory): string {
  return truncateEvidenceLine(`[${value.type}] ${value.text}`);
}

function episodeMatchesScope(value: Episode, scope: DailyReviewEvidenceScope): boolean {
  return scope.kind === 'companion'
    || value.spanRefs.some(span => span.sessionId === scope.sessionId);
}

function episodeMatchesWindow(value: Episode, windowStartMs: number, nowMs: number): boolean {
  const startedAt = Date.parse(value.startedAt);
  const endedAt = Date.parse(value.endedAt);
  return Number.isFinite(startedAt)
    && Number.isFinite(endedAt)
    && endedAt >= windowStartMs
    && startedAt <= nowMs;
}

function memoryMatchesWindow(value: PurrMemory, windowStartMs: number, nowMs: number): boolean {
  return Number.isFinite(value.extractedAt)
    && value.extractedAt >= windowStartMs
    && value.extractedAt <= nowMs;
}

function addDegradationReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function formatEvidenceCategory(
  heading: string,
  countSummary: string,
  lines: readonly string[],
  emptySummary: string,
): string[] {
  return [
    heading,
    `- ${countSummary}`,
    ...(lines.length > 0 ? lines.map(line => `  - ${line}`) : [`  - ${emptySummary}`]),
  ];
}

export async function collectDailyReviewEvidence(
  input: CollectDailyReviewEvidenceInput,
): Promise<DailyReviewEvidenceResult> {
  if (!Number.isFinite(input.nowMs) || !Number.isFinite(input.windowMs) || input.windowMs <= 0) {
    throw new Error('Daily-review evidence requires a finite timestamp and positive review window');
  }
  const windowStartMs = input.nowMs - input.windowMs;
  const windowFrom = new Date(windowStartMs).toISOString();
  const windowTo = new Date(input.nowMs).toISOString();
  const degradationReasons: string[] = [];

  let scannedSessionEntries: SessionEntry[] = [];
  let reportedWithheldSessionEntryIds: readonly number[] = [];
  let conversationCountIsLowerBound = false;
  if (input.scope.kind === 'companion' || !input.sessionManager) {
    degradationReasons.push('session_source_unavailable');
  } else {
    try {
      if (input.sessionManager.getConversationEvidenceWindow) {
        const window = input.sessionManager.getConversationEvidenceWindow(
          input.scope.sessionId,
          {
            fromMs: windowStartMs,
            toMs: input.nowMs,
            limit: REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT,
          },
        );
        scannedSessionEntries = window.entries.slice(0, REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT);
        reportedWithheldSessionEntryIds = window.promptAssemblyGate?.withheldEntryIds ?? [];
        conversationCountIsLowerBound = window.saturated
          || window.entries.length > REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT;
        if (window.entries.length > REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT) {
          addDegradationReason(degradationReasons, 'session_source_contract_violation');
        }
        if (conversationCountIsLowerBound) {
          addDegradationReason(degradationReasons, 'session_scan_saturated');
        }
      } else {
        scannedSessionEntries = input.sessionManager.getRecentMessages(
          input.scope.sessionId,
          REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT,
        );
        conversationCountIsLowerBound = true;
        addDegradationReason(degradationReasons, 'session_coverage_unverified');
      }
    } catch (error) {
      degradationReasons.push('session_read_failed');
      input.logger?.warn('Daily-review session evidence read failed', {
        error: String(error),
      });
    }
  }
  const expectedSessionId = input.scope.kind === 'companion' ? '' : input.scope.sessionId;
  if (expectedSessionId
    && scannedSessionEntries.some(entry => entry.channelId !== expectedSessionId)) {
    addDegradationReason(degradationReasons, 'session_scope_violation');
  }
  const conversationEntries = normalizeConversationEntries(
    scannedSessionEntries,
    expectedSessionId,
    windowStartMs,
    input.nowMs,
  );
  const conversationEntryIds = new Set(conversationEntries.map(entry => entry.id));
  const withheldConversationEntryIds = new Set(
    reportedWithheldSessionEntryIds.filter(entryId => conversationEntryIds.has(entryId)),
  );
  if (withheldConversationEntryIds.size !== reportedWithheldSessionEntryIds.length) {
    addDegradationReason(degradationReasons, 'session_source_contract_violation');
  }
  if (withheldConversationEntryIds.size > 0) {
    addDegradationReason(degradationReasons, 'session_intake_withheld');
  }

  let scannedEpisodes: Episode[] = [];
  let episodeCountIsLowerBound = false;
  if (!input.episodicStore) {
    degradationReasons.push('episode_source_unavailable');
  } else {
    try {
      const returnedEpisodes = await input.episodicStore.searchByTime({
        from: windowFrom,
        to: windowTo,
        limit: DAILY_REVIEW_EVIDENCE_SHAPE.episodeSamples + 1,
        order: 'desc',
        ...(input.scope.kind === 'companion'
          ? {}
          : { spanSessionId: input.scope.sessionId }),
      });
      const episodeQueryLimit = DAILY_REVIEW_EVIDENCE_SHAPE.episodeSamples + 1;
      scannedEpisodes = returnedEpisodes.slice(0, episodeQueryLimit);
      if (returnedEpisodes.length > episodeQueryLimit) {
        addDegradationReason(degradationReasons, 'episode_source_contract_violation');
      }
      episodeCountIsLowerBound = scannedEpisodes.length > DAILY_REVIEW_EVIDENCE_SHAPE.episodeSamples;
      if (episodeCountIsLowerBound) {
        addDegradationReason(degradationReasons, 'episode_scan_saturated');
      }
    } catch (error) {
      degradationReasons.push('episode_read_failed');
      input.logger?.warn('Daily-review episode evidence read failed', {
        error: String(error),
      });
    }
  }

  if (scannedEpisodes.some(value => !episodeMatchesScope(value, input.scope))) {
    addDegradationReason(degradationReasons, 'episode_scope_violation');
  }
  if (scannedEpisodes.some(value => !episodeMatchesWindow(value, windowStartMs, input.nowMs))) {
    addDegradationReason(degradationReasons, 'episode_window_violation');
  }
  const scopedEpisodes = scannedEpisodes
    .filter(value => episodeMatchesScope(value, input.scope))
    .filter(value => episodeMatchesWindow(value, windowStartMs, input.nowMs));
  const episodes = scopedEpisodes.slice(0, DAILY_REVIEW_EVIDENCE_SHAPE.episodeSamples);

  let memoryDeltas: PurrMemory[] = [];
  let memoryCountIsLowerBound = false;
  if (!input.memoryStore) {
    degradationReasons.push('memory_source_unavailable');
  } else {
    try {
      let activeMemories: PurrMemory[];
      if (input.memoryStore.listActiveMemoriesInWindow) {
        const window = await input.memoryStore.listActiveMemoriesInWindow({
          fromMs: windowStartMs,
          toMs: input.nowMs,
          limit: REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT,
          scope: input.scope.kind === 'companion'
            ? { kind: 'companion' }
            : input.scope.kind === 'group'
              ? { kind: 'conversation', conversationId: input.scope.sessionId }
              : {
                kind: 'contact',
                contactId: input.scope.canonicalContactId,
                conversationId: input.scope.sessionId,
              },
        });
        activeMemories = window.memories.slice(0, REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT);
        memoryCountIsLowerBound = window.saturated
          || window.memories.length > REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT;
        if (window.memories.length > REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT) {
          addDegradationReason(degradationReasons, 'memory_source_contract_violation');
        }
        if (memoryCountIsLowerBound) {
          addDegradationReason(degradationReasons, 'memory_scan_saturated');
        }
      } else {
        activeMemories = await input.memoryStore.listActiveMemories({
          limit: REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT,
        });
        memoryCountIsLowerBound = true;
        addDegradationReason(degradationReasons, 'memory_coverage_unverified');
      }
      if (activeMemories.some(memory => (
        !memoryMatchesWindow(memory, windowStartMs, input.nowMs)
        || !memoryMatchesScope(memory, input.scope)
      ))) {
        addDegradationReason(degradationReasons, 'memory_scope_violation');
      }
      memoryDeltas = activeMemories
        .filter(memory => memoryMatchesWindow(memory, windowStartMs, input.nowMs))
        .filter(memory => memoryMatchesScope(memory, input.scope))
        .sort((left, right) => right.extractedAt - left.extractedAt || right.id.localeCompare(left.id));
    } catch (error) {
      degradationReasons.push('memory_read_failed');
      input.logger?.warn('Daily-review memory-delta evidence read failed', {
        error: String(error),
      });
    }
  }

  if (
    conversationEntries.length === 0
    && episodes.length === 0
    && memoryDeltas.length === 0
    && degradationReasons.length === 0
  ) {
    degradationReasons.push('no_bounded_day_evidence');
  }

  const conversationCount = `${String(conversationEntries.length)}${conversationCountIsLowerBound ? '+' : ''}`;
  const conversationLines = selectEvenlyDistributed(
    conversationEntries,
    DAILY_REVIEW_EVIDENCE_SHAPE.conversationSamples,
  ).map(formatConversationLine);
  const episodeLines = episodes
    .slice(0, DAILY_REVIEW_EVIDENCE_SHAPE.episodeSamples)
    .map(formatEpisodeLine);
  const memoryLines = memoryDeltas
    .slice(0, DAILY_REVIEW_EVIDENCE_SHAPE.memorySamples)
    .map(formatMemoryLine);

  const sections = [
    '[Deterministic Day Evidence]',
    'This bounded summary covers the preceding review window. It is direct evidence, not a complete account.',
    ...formatEvidenceCategory(
      '[Conversation Activity]',
      `${conversationCount} recorded conversation messages were found in the bounded scan.`,
      conversationLines,
      'No conversation messages were found in the bounded window.',
    ),
    ...(withheldConversationEntryIds.size > 0
      ? [`- ${String(withheldConversationEntryIds.size)} conversation messages were withheld by intake policy.`]
      : []),
    ...formatEvidenceCategory(
      '[Episodes]',
      `${String(scopedEpisodes.length)}${episodeCountIsLowerBound ? '+' : ''} episode records were found in the bounded window.`,
      episodeLines,
      'No episode records were found in the bounded window.',
    ),
    ...formatEvidenceCategory(
      '[Memory Deltas]',
      `${String(memoryDeltas.length)}${memoryCountIsLowerBound ? '+' : ''} memory changes were found in the bounded scan.`,
      memoryLines,
      'No memory changes were found in the bounded window.',
    ),
  ];

  if (degradationReasons.length > 0) {
    sections.push(
      '[Daily Evidence Grounding Degraded]',
      'The bounded day evidence set is empty or incomplete. Treat this as missing grounding, not evidence that nothing happened, and name the limited reach of this reflection.',
    );
  }

  return {
    promptSection: sections.join('\n'),
    provenanceRefs: [...new Set([
      ...conversationEntries.map(entry => (
        withheldConversationEntryIds.has(entry.id)
          ? `session_message_withheld:${entry.channelId}|entry:${String(entry.id)}`
          : `session_message:${entry.channelId}|entry:${String(entry.id)}`
      )),
      ...episodes.map(value => `episode:${value.id}`),
      ...memoryDeltas.map(value => `memory:${value.id}`),
    ])],
    degraded: degradationReasons.length > 0,
    degradationReasons,
  };
}
