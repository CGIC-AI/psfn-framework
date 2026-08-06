import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../../faculties/memory/types.js';
import type { EpisodicStorePort } from '../../../faculties/memory/episodic/store-port.js';
import type { Episode } from '../../../shared/contracts/episodic-memory.js';
import type { SessionEntry } from '../../session/types.js';
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
  sessionManager?: Pick<{ getRecentMessages(channelId: string, limit?: number): SessionEntry[] }, 'getRecentMessages'>;
  episodicStore?: Pick<EpisodicStorePort, 'searchByTime'> | null;
  memoryStore?: Pick<MemoryStorePort, 'listActiveMemories'> | null;
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
  windowStartMs: number,
  nowMs: number,
): SessionEntry[] {
  return entries
    .filter(entry => (
      (entry.role === 'user' || entry.role === 'assistant')
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
  if (input.scope.kind === 'companion' || !input.sessionManager) {
    degradationReasons.push('session_source_unavailable');
  } else {
    try {
      scannedSessionEntries = input.sessionManager.getRecentMessages(
        input.scope.sessionId,
        REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT,
      );
    } catch (error) {
      degradationReasons.push('session_read_failed');
      input.logger?.warn('Daily-review session evidence read failed', {
        error: String(error),
      });
    }
  }
  const conversationEntries = normalizeConversationEntries(
    scannedSessionEntries,
    windowStartMs,
    input.nowMs,
  );

  let episodes: Episode[] = [];
  if (!input.episodicStore) {
    degradationReasons.push('episode_source_unavailable');
  } else {
    try {
      episodes = await input.episodicStore.searchByTime({
        from: windowFrom,
        to: windowTo,
        limit: DAILY_REVIEW_EVIDENCE_SHAPE.episodeSamples,
        order: 'desc',
        ...(input.scope.kind === 'companion'
          ? {}
          : { spanSessionId: input.scope.sessionId }),
      });
    } catch (error) {
      degradationReasons.push('episode_read_failed');
      input.logger?.warn('Daily-review episode evidence read failed', {
        error: String(error),
      });
    }
  }

  let memoryDeltas: PurrMemory[] = [];
  if (!input.memoryStore) {
    degradationReasons.push('memory_source_unavailable');
  } else {
    try {
      const activeMemories = await input.memoryStore.listActiveMemories({
        limit: REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT,
      });
      memoryDeltas = activeMemories
        .filter(memory => (
          Number.isFinite(memory.extractedAt)
          && memory.extractedAt >= windowStartMs
          && memory.extractedAt <= input.nowMs
          && memoryMatchesScope(memory, input.scope)
        ))
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

  const conversationIsScanBounded = (
    scannedSessionEntries.length === REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT
    && conversationEntries.length === scannedSessionEntries.length
  );
  const conversationCount = `${String(conversationEntries.length)}${conversationIsScanBounded ? '+' : ''}`;
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
    ...formatEvidenceCategory(
      '[Episodes]',
      `${String(episodes.length)} episode records were found in the bounded window.`,
      episodeLines,
      'No episode records were found in the bounded window.',
    ),
    ...formatEvidenceCategory(
      '[Memory Deltas]',
      `${String(memoryDeltas.length)} memory changes were found in the bounded scan.`,
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
      ...conversationEntries.map(entry => `session_message:${entry.channelId}|entry:${String(entry.id)}`),
      ...episodes.map(value => `episode:${value.id}`),
      ...memoryDeltas.map(value => `memory:${value.id}`),
    ])],
    degraded: degradationReasons.length > 0,
    degradationReasons,
  };
}
