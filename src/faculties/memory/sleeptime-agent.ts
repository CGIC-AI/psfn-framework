import {
  renderPendingConcernCandidatesSection,
  type ConcernCandidateDecision,
  type ConcernCandidateReviewPort,
} from '../../core/intention/concern-candidate-prompt.js';
import { createHash } from 'node:crypto';
import {
  WHISPER_WORKER_LANE,
  createWorkerExecutionPolicy,
} from '../../core/agent/worker-lanes.js';
import type { Episode } from '../../shared/contracts/episodic-memory.js';
import { toIsoInstant } from '../../shared/utils/timing.js';
import {
  getDefaultPromptText,
  SLEEPTIME_ORIENTATION_PROMPT_KEY,
} from '../../core/identity/prompt-registry.js';
import {
  evaluateCogSecMemoryCandidacy,
  type CogSecMemoryCandidacyDecision,
} from '../../core/cogsec/memory-candidacy.js';
import type { PromptRegistryStatePort } from '../../core/identity/prompt-state-port.js';
import { coreMemoryChannelScope } from '../core-memory/store.js';
import { evaluateRestWindowEligibility } from '../../core/scheduler/rest-window.js';
import type { InferredPostTurnAction, PostTurnActionCandidate, SubstrateMessage } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { SessionEntry } from '../../core/session/types.js';
import { isRuntimeAuthoredFallbackSessionEntry } from '../../core/session/runtime-fallback-provenance.js';
import type { SessionManager } from '../../core/session/manager.js';
import type {
  ConversationalActivityWorkItem,
  ConversationalActivityWorksetPort,
} from '../../core/session/conversational-activity-workset.js';
import { latestSourceEntryTimestamp } from './extraction/speaker-routing.js';
import { isTestingSessionId } from '../../core/session/session-id.js';
import {
  DEFAULT_ORIENTATION_REWRITE_GATE,
  type EpisodicProcessingRestWindowConfig,
  type OrientationRewriteGateConfig,
} from '../../system/config/scheduler-config.js';
import type { ProcessableConversationKind } from '../../core/session/conversational-activity.js';
import type { DeterministicGateEvent, EventMap } from '../../shared/event-bus.js';
import {
  evaluateDeterministicGate,
  type DeterministicGateDefinition,
} from '../../shared/gating/deterministic-gate.js';
import { clampSigned, clampUnit, positiveIntegerOr } from '../../shared/utils/numeric.js';
import type {
  CoreMemoryStorePort,
  MemoryMaintenanceDiagnostics,
  MemoryMaintenanceReview,
  MemoryMaintenanceReviewInput,
  MemoryStorePort,
} from './memory-store-port.js';
import type { MemoryWriteOptions, MemoryWriter, WriteResult } from './writer.js';
import type { SleepCycleEpisodeConsolidator } from './episodic/sleep-consolidation.js';
import type { EpisodeArcWeaver } from './episodic/arc-formation.js';
import type { DreamMeaningPass } from './episodic/dream-meaning-pass.js';
import type { SleeptimeWikiPassPort } from '../../shared/contracts/wiki-context.js';
import type {
  EpisodicMaintenanceDiagnostics,
  EpisodicStorePort,
} from './episodic/store-port.js';
import {
  buildConflictingMemoryReviewInput,
  buildHighImpactLowConfidenceReviewInput,
  type UncertainMemoryReviewSubject,
} from './maintenance-review.js';
import {
  VALID_MEMORY_TYPES,
  VALID_SENSITIVITY_LEVELS,
  type MemoryType,
  type PurrMemory,
  type SensitivityLevel,
} from './types.js';
import {
  SleeptimeWorksetRunner,
  type SleeptimeWorksetRunnerOptions,
  type SleeptimeWorksetRunOutcome,
  type SleeptimeWorksetStageInput,
} from './sleeptime-workset.js';
import { classifyPostTurnActionContention } from '../../core/agent/post-turn-action-contention.js';
import type { ConcernStorePort } from '../../core/intention/concern-store-port.js';
import { loadSleeptimeReviewGrounding } from './sleeptime-review-grounding.js';
import {
  resolveSessionMemoryAttribution,
  type SessionCounterpartyContactStore,
  type SessionMemoryAttribution,
} from './session-counterparty-resolution.js';

const log = createComponentLogger('SleeptimeMemoryAgent');

export const SLEEPTIME_MEMORY_ACTION_KIND = 'memory.sleeptime.run';

export interface SleeptimeExecutionControl {
  onSafeBoundary?: SleeptimeWorksetRunnerOptions['onSafeBoundary'];
  isYieldError?: (error: unknown) => boolean;
}

const DEFAULT_TRANSCRIPT_MESSAGE_LIMIT = 24;
const DEFAULT_MAX_MEMORY_WRITES = 4;
// Her end-of-day review runs as her own reflection turns on an internal
// channel, mirroring the dream-meaning pass — never as a raw completion.
const SLEEPTIME_REVIEW_CHANNEL_ID = 'internal:reflection:sleeptime-review';
const MAX_REVIEW_TURNS = 3;
const EPISODE_REVIEW_LIMIT = 20;
const ORIENTATION_REWRITE_GATE_LANE = 'orientation_rewrite';
const DAY_MS = 24 * 60 * 60_000;
const SLEEPTIME_WORKSET_CLAIMANT_ID = 'companion:sleeptime';
const SLEEPTIME_COMPANION_ACTION_DEDUPE_KEY = `${SLEEPTIME_MEMORY_ACTION_KIND}:companion`;

/**
 * Orientation-rewrite gate (jpvd.4): the nightly core-memory orient rewrite is
 * the heaviest sleeptime LLM pass. It fires only on deterministic evidence of
 * change since the last rewrite — enough new conversational turns, OR any new
 * activity once the last rewrite is stale. On quiet nights the gate closes and
 * the whole orient plan call is skipped with zero LLM spend.
 */
function buildOrientationRewriteGate(config: OrientationRewriteGateConfig): DeterministicGateDefinition {
  return {
    lane: ORIENTATION_REWRITE_GATE_LANE,
    openWhenAny: [
      { input: 'newEntriesSinceRewrite', comparator: 'gte', threshold: config.minNewEntriesSinceRewrite },
      { input: 'staleWithActivityDays', comparator: 'gte', threshold: config.refreshAfterQuietDays },
    ],
    closedReason: 'no_change',
    openReason: 'evidence_of_change',
  };
}
const MAX_TRANSCRIPT_ENTRY_CHARS = 600;
const EVIDENCE_TOKEN_STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'because',
  'before',
  'being',
  'from',
  'have',
  'need',
  'only',
  'that',
  'there',
  'this',
  'with',
  'would',
]);

type CoreMemoryRewriter = Pick<CoreMemoryStorePort, 'getSnapshot' | 'rethink'>;

/**
 * Her persona/agent loop — the same contract the dream-meaning pass reviews
 * episodes with. Sleeptime review is HER end-of-day pass (operator decision
 * 2026-07-22): it must run through her loop, never a raw automaton completion.
 */
export interface SleeptimeReviewAgent {
  handleMessage(message: SubstrateMessage): Promise<{ content: string }>;
}

type SleeptimeEpisodeReader = Pick<EpisodicStorePort, 'searchByTime'>;
type SessionMemoryReader = Pick<SessionManager, 'getRecentMessagesAtOrBefore' | 'getJournalSessionGroup'>
  & Partial<Pick<SessionManager, 'isSessionRetiredOrQuarantined'>>;
type SleeptimeMemoryWriter = Pick<MemoryWriter, 'write'>;
type SleeptimeEpisodeConsolidator = Pick<SleepCycleEpisodeConsolidator, 'run'>;
type SleeptimeArcWeaver = Pick<EpisodeArcWeaver, 'run'>;
type SleeptimeDreamMeaningPass = Pick<DreamMeaningPass, 'run'>;
type SleeptimeWikiPassRunner = SleeptimeWikiPassPort;
type SleeptimeMaintenanceStore = Pick<
  MemoryStorePort,
  'upsertMemoryMaintenanceReview' | 'getById' | 'getMemoryMaintenanceDiagnostics'
>;
type SleeptimeEpisodicDiagnosticsStore = {
  getMaintenanceDiagnostics(): EpisodicMaintenanceDiagnostics | Promise<EpisodicMaintenanceDiagnostics>;
};

interface NormalizedMemoryWrite {
  text: string;
  type: MemoryType;
  importance: number;
  confidence: number;
  emotionalValence: number;
  tags: string[];
  sensitivity: SensitivityLevel;
}

interface NormalizedSleeptimePlan {
  orient: {
    persona: string;
    human: string;
    goals: string;
  };
  memoryWrites: NormalizedMemoryWrite[];
  /** Her decisions about the concern candidates she was shown (vcq8v.5). */
  concernDecisions: Array<{ id: string; decision: ConcernCandidateDecision }>;
}

type SleeptimeOrientBlockName = keyof NormalizedSleeptimePlan['orient'];
interface SleeptimeOrientCandidacyRejection {
  block: SleeptimeOrientBlockName;
  decision: CogSecMemoryCandidacyDecision;
}

export interface SleeptimeMemoryAgentOptions {
  agent: SleeptimeReviewAgent;
  /**
   * The day's consolidated episodes are the context she reviews the day
   * through (operator decision 2026-07-22): reviewing from a summarized
   * transcript blob alone produced orientation notes that read "off".
   */
  episodicStore: SleeptimeEpisodeReader;
  sessionManager: SessionMemoryReader;
  conversationalActivityWorkset: ConversationalActivityWorksetPort;
  coreMemoryStore: CoreMemoryRewriter;
  resolvedConcernStore: Pick<ConcernStorePort, 'listRecentlyResolvedConcerns'>;
  memoryWriter: SleeptimeMemoryWriter;
  promptRegistry?: PromptRegistryStatePort | null;
  /**
   * Concern candidates still waiting for her decision (vcq8v.5). Reviewing
   * them is part of her nightly review; her plan may keep or let go of each.
   */
  concernCandidates?: ConcernCandidateReviewPort;
  transcriptMessageLimit?: number;
  maxMemoryWrites?: number;
  /**
   * Rest-window eligibility (scheduler.json `episodicProcessing`). Required:
   * sleeptime is scheduler-owned nightly work, so the agent fails closed at
   * construction rather than degrading into a turn-cadence process.
   */
  restWindow: EpisodicProcessingRestWindowConfig;
  /**
   * Deterministic gate for the orient rewrite (scheduler.json
   * `orientationRewrite`). Optional: conservative defaults apply when absent.
   */
  orientationRewriteGate?: OrientationRewriteGateConfig;
  /** Typed gate telemetry sink; wired to the runtime event bus by composition. */
  onGateEvent?: (event: DeterministicGateEvent) => void;
  /** Operator-alerting sink when sleeptime review exhausts retries without a usable plan. */
  onReviewFailure?: (event: EventMap['memory.sleep_consolidation.failure']) => void;
  /** Contact lookup for attributing single-counterparty DM and companion-dm sleeptime writes. */
  contactStore?: SessionCounterpartyContactStore | null;
  /** Local companion UUID used to identify the peer participant on companion-dm sessions. */
  companionId?: string;
  /** Companion author IDs excluded when identifying human speakers in transcripts. */
  companionAuthorIds?: readonly string[];
  now?: () => number;
  sleepConsolidator: SleeptimeEpisodeConsolidator;
  arcWeaver: SleeptimeArcWeaver;
  dreamMeaningPass: SleeptimeDreamMeaningPass;
  /**
   * Sleeptime wiki update pass (E8.2). Runs AFTER episodes/memories settle
   * (after consolidation/arcs/dream) with its own deterministic gate and
   * watermark; independent of the orient rewrite gate.
   */
  sleeptimeWikiPass: SleeptimeWikiPassRunner;
  memoryMaintenanceStore?: SleeptimeMaintenanceStore | null;
  episodicDiagnosticsStore?: SleeptimeEpisodicDiagnosticsStore | null;
}


function normalizeText(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('Sleeptime plan contains non-string text field');
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Sleeptime plan contains empty text field');
  }
  return trimmed;
}

function normalizeMemoryType(raw: unknown): MemoryType {
  if (typeof raw !== 'string') {
    throw new Error('Sleeptime memory write type must be a string');
  }
  const normalized = raw.trim().toLowerCase() as MemoryType;
  if (!VALID_MEMORY_TYPES.includes(normalized)) {
    throw new Error(`Sleeptime memory write type "${raw}" is invalid`);
  }
  return normalized;
}

function normalizeSensitivity(raw: unknown): SensitivityLevel {
  if (typeof raw !== 'string') return 'personal';
  const normalized = raw.trim().toLowerCase() as SensitivityLevel;
  if (!VALID_SENSITIVITY_LEVELS.includes(normalized)) {
    return 'personal';
  }
  return normalized;
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const normalized = entry.trim().toLowerCase();
    if (normalized) {
      out.add(normalized);
    }
  }
  return [...out];
}

function extractBalancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let startIndex = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) {
        startIndex = index;
      }
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        objects.push(text.slice(startIndex, index + 1));
        startIndex = -1;
      }
    }
  }
  return objects;
}

function tryParseJsonObject(candidate: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function selectBestJsonObject(candidates: readonly string[]): string | null {
  let firstValid: string | null = null;
  for (const candidate of candidates) {
    const parsed = tryParseJsonObject(candidate);
    if (!parsed) continue;
    if ('orient' in parsed || 'memory_writes' in parsed) {
      return candidate;
    }
    if (firstValid === null) {
      firstValid = candidate;
    }
  }
  return firstValid;
}

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Sleeptime model returned empty output');
  }

  if (tryParseJsonObject(trimmed)) {
    return trimmed;
  }

  const fencedCandidates: string[] = [];
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(trimmed)) !== null) {
    const block = match[1]?.trim();
    if (!block) continue;
    fencedCandidates.push(block);
    fencedCandidates.push(...extractBalancedJsonObjects(block));
  }
  const bestFenced = selectBestJsonObject(fencedCandidates);
  if (bestFenced) {
    return bestFenced;
  }

  const balanced = extractBalancedJsonObjects(trimmed);
  const bestBalanced = selectBestJsonObject(balanced);
  if (bestBalanced) {
    return bestBalanced;
  }

  if (fencedCandidates.length > 0) {
    return fencedCandidates[0]!;
  }
  if (balanced.length > 0) {
    return balanced[0]!;
  }

  throw new Error('Sleeptime model did not return a JSON object');
}

function normalizeConcernDecisions(
  value: unknown,
  offeredIds: ReadonlySet<string>,
): NormalizedSleeptimePlan['concernDecisions'] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('concern_decisions must be an array');
  const decisions = new Map<string, ConcernCandidateDecision>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('each concern_decisions entry must be an object');
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'].trim() : '';
    const decision = typeof record['decision'] === 'string'
      ? record['decision'].trim().toLowerCase()
      : record['decision'];
    if (!offeredIds.has(id)) throw new Error(`concern_decisions id "${id}" was not one of the offered concerns`);
    if (decision !== 'keep' && decision !== 'let_go') {
      throw new Error('concern_decisions decision must be "keep" or "let_go"');
    }
    decisions.set(id, decision);
  }
  return [...decisions.entries()].map(([id, decision]) => ({ id, decision }));
}

function normalizeOrientBlock(
  raw: unknown,
  blockName: SleeptimeOrientBlockName,
  fallbackContent: string,
): string {
  if (raw === undefined || raw === null) {
    return fallbackContent.trim();
  }
  if (typeof raw !== 'string') {
    throw new Error(`Sleeptime plan orient.${blockName} must be a string`);
  }
  const trimmed = raw.trim();
  return trimmed || fallbackContent.trim();
}

function normalizeSleeptimePlan(
  raw: string,
  maxMemoryWrites: number,
  offeredConcernIds: ReadonlySet<string> = new Set(),
  currentOrientBlocks?: Record<SleeptimeOrientBlockName, { content: string }>,
): NormalizedSleeptimePlan {
  const parsed = JSON.parse(extractJsonPayload(raw)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Sleeptime plan must be a JSON object');
  }

  const record = parsed as Record<string, unknown>;
  const orientRaw = record['orient'];
  if (!orientRaw || typeof orientRaw !== 'object' || Array.isArray(orientRaw)) {
    throw new Error('Sleeptime plan is missing orient object');
  }

  const orientRecord = orientRaw as Record<string, unknown>;
  const orient = {
    persona: normalizeOrientBlock(
      orientRecord['persona'],
      'persona',
      currentOrientBlocks?.persona.content ?? '',
    ),
    human: normalizeOrientBlock(
      orientRecord['human'],
      'human',
      currentOrientBlocks?.human.content ?? '',
    ),
    goals: normalizeOrientBlock(
      orientRecord['goals'],
      'goals',
      currentOrientBlocks?.goals.content ?? '',
    ),
  };

  if (record['memory_writes'] !== undefined && !Array.isArray(record['memory_writes'])) {
    throw new Error('Sleeptime plan memory_writes must be an array');
  }
  const memoryWritesRaw = Array.isArray(record['memory_writes'])
    ? record['memory_writes']
    : [];
  const memoryWrites: NormalizedMemoryWrite[] = [];

  for (const rawWrite of memoryWritesRaw) {
    if (!rawWrite || typeof rawWrite !== 'object' || Array.isArray(rawWrite)) {
      throw new Error('each memory_writes entry must be an object');
    }
    const writeRecord = rawWrite as Record<string, unknown>;
    memoryWrites.push({
      text: normalizeText(writeRecord['text']),
      type: normalizeMemoryType(writeRecord['type']),
      importance: clampUnit(writeRecord['importance'], 0.65),
      // An omitted confidence must not auto-clear the high-impact review gate
      // (threshold 0.65, maintenance-review.ts): default below it (1gpol).
      confidence: clampUnit(writeRecord['confidence'], 0.5),
      emotionalValence: clampSigned(writeRecord['emotionalValence'], 0),
      tags: normalizeTags(writeRecord['tags']),
      sensitivity: normalizeSensitivity(writeRecord['sensitivity']),
    });
    if (memoryWrites.length >= maxMemoryWrites) {
      break;
    }
  }

  const concernDecisions = normalizeConcernDecisions(record['concern_decisions'], offeredConcernIds);
  const hasAnyOrientContent = (
    orient.persona.length > 0
    || orient.human.length > 0
    || orient.goals.length > 0
  );
  if (!hasAnyOrientContent && memoryWrites.length === 0 && concernDecisions.length === 0) {
    throw new Error('Sleeptime plan orient must contain at least one non-empty block');
  }

  return {
    orient,
    memoryWrites,
    concernDecisions,
  };
}

function evaluateSleeptimeOrientCandidacy(
  orient: NormalizedSleeptimePlan['orient'],
): SleeptimeOrientCandidacyRejection | null {
  const blocks: SleeptimeOrientBlockName[] = ['persona', 'human', 'goals'];
  for (const block of blocks) {
    if (!orient[block].trim()) continue;
    const decision = evaluateCogSecMemoryCandidacy({
      text: orient[block],
      type: 'reflection',
      tags: ['sleeptime', 'orient', block],
      sourceType: 'reflection',
    });
    if (decision.disposition !== 'allow') {
      return { block, decision };
    }
  }
  return null;
}

function summarizeSessionEntry(entry: SessionEntry): string {
  const rolePrefix = entry.role === 'assistant'
    ? 'ME'
    : entry.role === 'user'
      ? 'THEM'
      : entry.role.toUpperCase();
  const collapsed = entry.content.replace(/\s+/g, ' ').trim();
  const clipped = collapsed.length > MAX_TRANSCRIPT_ENTRY_CHARS
    ? `${collapsed.slice(0, MAX_TRANSCRIPT_ENTRY_CHARS)}...`
    : collapsed;
  return `${rolePrefix}: ${clipped || '[empty]'}`;
}

function stableId(prefix: string, parts: readonly string[]): string {
  const fingerprint = createHash('sha256')
    .update(parts.join('\u001f'))
    .digest('hex')
    .slice(0, 24);
  return `${prefix}:${fingerprint}`;
}

function normalizeEvidenceTokens(text: string, limit = 8): string[] {
  const tokens = text
    .toLowerCase()
    .match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
  return [...new Set(tokens.filter(token => !EVIDENCE_TOKEN_STOP_WORDS.has(token)))].slice(0, limit);
}

/** One grounding source: a transcript turn or a consolidated episode. */
interface GroundingEntry {
  content: string;
}

function buildGroundingCorpus(
  entries: readonly SessionEntry[],
  episodes: readonly Episode[],
): GroundingEntry[] {
  const episodeEntries = episodes.map(episode => ({
    content: [
      episode.title,
      episode.landmark,
      episode.themes.join(' '),
      episode.meaning?.text ?? '',
    ].filter(part => part.trim().length > 0).join('\n'),
  }));
  return [...entries.map(entry => ({ content: entry.content })), ...episodeEntries];
}

function countSupportingTranscriptEntries(
  memoryText: string,
  entries: readonly GroundingEntry[],
): number {
  const tokens = normalizeEvidenceTokens(memoryText);
  if (tokens.length === 0) return 0;
  return entries.reduce((count, entry) => {
    const content = entry.content.toLowerCase();
    const matches = tokens.reduce((sum, token) => sum + (content.includes(token) ? 1 : 0), 0);
    return count + (matches >= Math.min(2, tokens.length) ? 1 : 0);
  }, 0);
}

/**
 * Per-block grounding gate for the orient rewrite (1gpol). A block whose novel
 * tokens (tokens absent from its previous content) find no support anywhere in
 * the day's transcript or episodes keeps its previous content: fabricated
 * blocks are rejected while rephrasing or pruning of grounded content passes.
 * A single supported novel token is a floor, not proof — the CogSec candidacy
 * screen and the low-confidence review gate still apply on top.
 */
function acceptGroundedOrientBlocks(
  next: NormalizedSleeptimePlan['orient'],
  current: Record<SleeptimeOrientBlockName, { content: string }>,
  corpus: readonly GroundingEntry[],
): { blocks: NormalizedSleeptimePlan['orient']; rejectedBlocks: SleeptimeOrientBlockName[] } {
  const corpusText = corpus.map(entry => entry.content.toLowerCase()).join('\n');
  const blocks = { persona: next.persona, human: next.human, goals: next.goals };
  const rejectedBlocks: SleeptimeOrientBlockName[] = [];
  for (const name of ['persona', 'human', 'goals'] as const) {
    const previousTokens = new Set(normalizeEvidenceTokens(current[name].content, Infinity));
    const novelTokens = normalizeEvidenceTokens(blocks[name], Infinity)
      .filter(token => !previousTokens.has(token));
    if (novelTokens.length === 0) continue;
    if (!novelTokens.some(token => corpusText.includes(token))) {
      blocks[name] = current[name].content;
      rejectedBlocks.push(name);
    }
  }
  return { blocks, rejectedBlocks };
}

function formatEpisodeReviewBlock(episodes: readonly Episode[]): string {
  if (episodes.length === 0) {
    return 'Consolidated episodes: none were recorded for this source window.';
  }
  const lines = episodes.map(episode => {
    const themes = episode.themes.length > 0 ? ` [themes: ${episode.themes.join(', ')}]` : '';
    // Candidates, not verdicts (h4fp.6): an episode she has not yet given
    // meaning to must never read as her settled lived past — the title and
    // landmark are machine-drafted summaries awaiting her review. This block is
    // governed by a prompt that calls the episodes below "what actually
    // happened" and treats them as the evidence authority for durable memory
    // writes, so an unmarked machine draft would read as settled ground truth.
    const meaning = episode.meaning
      ? `\n  what it meant to me: ${episode.meaning.text}`
      : '\n  (unreviewed: machine-drafted summary — you have not yet given this episode its meaning)';
    return `- (${episode.startedAt} - ${episode.endedAt}) ${episode.title}: ${episode.landmark}${themes}${meaning}`;
  });
  return ['Consolidated episodes from the source window:', ...lines].join('\n');
}

function reviewSubjectForMemoryWrite(input: {
  memory: NormalizedMemoryWrite;
  sessionId: string;
  actionId: string;
  sourceMessageId?: string;
}): UncertainMemoryReviewSubject {
  const sourceRef = `source:sleeptime|session:${input.sessionId}|message:${input.sourceMessageId ?? 'unknown'}`;
  return {
    memoryId: stableId('sleeptime-memory-candidate', [
      input.sessionId,
      input.actionId,
      input.memory.type,
      input.memory.text,
    ]),
    text: input.memory.text,
    sourceRef,
    provenanceRefs: [
      sourceRef,
      `sleeptime_action:${input.actionId}`,
      ...(input.sourceMessageId ? [`source_message:${input.sourceMessageId}`] : []),
    ],
    confidence: input.memory.confidence,
    type: input.memory.type,
    tags: [...input.memory.tags, 'sleeptime'],
    sensitivity: input.memory.sensitivity,
  };
}

function resolveFiniteSourceMessageIds(
  entryIds: readonly number[] | undefined,
  fallbackSourceMessageId: string | undefined,
): number[] {
  const normalizedEntryIds = [...new Set(
    (entryIds ?? []).filter(id => Number.isSafeInteger(id) && id > 0),
  )];
  if (normalizedEntryIds.length > 0) {
    return normalizedEntryIds;
  }
  if (fallbackSourceMessageId) {
    const parsed = Number(fallbackSourceMessageId);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return [parsed];
    }
  }
  return [];
}

function buildSleepTimeMemoryWritePayload(input: {
  memory: NormalizedMemoryWrite;
  sessionId: string;
  actionId: string;
  sourceMessageId?: string;
  sourceMessageIds?: readonly number[];
  attribution?: SessionMemoryAttribution;
  evidenceCount: number;
  /**
   * Latest instant (epoch ms) of the reviewed source transcript — the memory's
   * conversation-time bound. Derived from the reviewed session entries (the same
   * bound the extractor stamps), NOT from the sleeptime run's clock: sleeptime
   * runs deferred (next rest window, possibly after a restart), so `now()` would
   * post-date the conversation and could resolve a since-widened epoch, wrongly
   * auto-sharing pre-demotion content (psfn-framework-ca980 / qgqw.2). Absent ⇒
   * omitted, so the disclosure collector fails closed rather than coercing.
   */
  sourceConversationAt?: number;
}): MemoryWriteOptions {
  const sourceRef = `source:sleeptime|session:${input.sessionId}|message:${input.sourceMessageId ?? 'unknown'}`;
  const repeatedFact = input.evidenceCount >= 2 && input.memory.confidence >= 0.72 && input.memory.importance >= 0.65;
  const sourceMessageIds = resolveFiniteSourceMessageIds(
    input.sourceMessageIds,
    input.sourceMessageId,
  );
  const attribution = input.attribution;
  return {
    text: input.memory.text,
    type: input.memory.type,
    importance: input.memory.importance,
    confidence: input.memory.confidence,
    emotionalValence: input.memory.emotionalValence,
    sensitivity: input.memory.sensitivity,
    sourceRef,
    sourceType: 'autonomous_action',
    ...(attribution?.kind === 'single_contact' ? { contactId: attribution.contactId } : {}),
    provenance: {
      channelId: input.sessionId,
      sessionId: input.sessionId,
      actor: 'system',
      reason: 'sleeptime',
      ...(attribution?.kind === 'single_contact'
        ? {
            subjectContactId: attribution.contactId,
            subjectContactIds: [attribution.contactId],
          }
        : attribution?.kind === 'companion_private'
          ? { subjectScope: 'companion_internal' as const }
          : {}),
      ...(input.sourceConversationAt !== undefined ? { sourceConversationAt: input.sourceConversationAt } : {}),
      ...(sourceMessageIds.length > 0 ? { sourceMessageIds } : {}),
    },
    provenanceRefs: [
      sourceRef,
      `sleeptime_action:${input.actionId}`,
      `evidence_count:${input.evidenceCount}`,
      ...(input.sourceMessageId ? [`source_message:${input.sourceMessageId}`] : []),
    ],
    tags: [
      ...input.memory.tags,
      'sleeptime',
      ...(repeatedFact ? ['repeated_fact', 'stable_fact'] : []),
    ],
    scopeRef: {
      kind: 'conversation',
      id: input.sessionId,
      label: 'sleeptime source session',
    },
    scopeTags: [`channel:${input.sessionId}`, 'sleeptime'],
    ...(repeatedFact ? { retentionClass: 'durable' as const } : {}),
  };
}

export class SleeptimeMemoryAgent {
  private readonly agent: SleeptimeReviewAgent;
  private readonly episodicStore: SleeptimeEpisodeReader;
  private readonly sessionManager: SessionMemoryReader;
  private readonly conversationalActivityWorkset: ConversationalActivityWorksetPort;
  private readonly coreMemoryStore: CoreMemoryRewriter;
  private readonly memoryWriter: SleeptimeMemoryWriter;
  private readonly promptRegistry: PromptRegistryStatePort | null;
  private readonly concernCandidates: ConcernCandidateReviewPort | null;
  private readonly transcriptMessageLimit: number;
  private readonly maxMemoryWrites: number;
  private readonly restWindow: EpisodicProcessingRestWindowConfig;
  private readonly orientationRewriteGate: DeterministicGateDefinition;
  private readonly onGateEvent: ((event: DeterministicGateEvent) => void) | null;
  private readonly onReviewFailure: ((event: EventMap['memory.sleep_consolidation.failure']) => void) | null;
  private readonly contactStore: SessionCounterpartyContactStore | null;
  private readonly companionId: string | undefined;
  private readonly companionAuthorIds: readonly string[];
  private readonly now: () => number;
  private readonly sleepConsolidator: SleeptimeEpisodeConsolidator;
  private readonly arcWeaver: SleeptimeArcWeaver;
  private readonly dreamMeaningPass: SleeptimeDreamMeaningPass;
  private readonly sleeptimeWikiPass: SleeptimeWikiPassRunner;
  private readonly memoryMaintenanceStore: SleeptimeMaintenanceStore | null;
  private readonly episodicDiagnosticsStore: SleeptimeEpisodicDiagnosticsStore | null;
  private readonly resolvedConcernStore: SleeptimeMemoryAgentOptions['resolvedConcernStore'];

  constructor(options: SleeptimeMemoryAgentOptions) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for JS callers
    if (!options.restWindow) {
      throw new Error(
        'SleeptimeMemoryAgent requires a rest-window config (scheduler.json episodicProcessing); '
        + 'sleeptime is scheduler-owned nightly work and must not run from turn cadence',
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guards for JS callers
    if (!options.sleepConsolidator) {
      throw new Error('SleeptimeMemoryAgent requires every ordered pass; missing sleepConsolidator');
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guards for JS callers
    if (!options.arcWeaver) {
      throw new Error('SleeptimeMemoryAgent requires every ordered pass; missing arcWeaver');
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guards for JS callers
    if (!options.dreamMeaningPass) {
      throw new Error('SleeptimeMemoryAgent requires every ordered pass; missing dreamMeaningPass');
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guards for JS callers
    if (!options.sleeptimeWikiPass) {
      throw new Error('SleeptimeMemoryAgent requires every ordered pass; missing sleeptimeWikiPass');
    }
    this.agent = options.agent;
    this.episodicStore = options.episodicStore;
    this.sessionManager = options.sessionManager;
    this.conversationalActivityWorkset = options.conversationalActivityWorkset;
    this.coreMemoryStore = options.coreMemoryStore;
    this.resolvedConcernStore = options.resolvedConcernStore;
    this.memoryWriter = options.memoryWriter;
    this.promptRegistry = options.promptRegistry ?? null;
    this.concernCandidates = options.concernCandidates ?? null;
    this.transcriptMessageLimit = positiveIntegerOr(
      options.transcriptMessageLimit,
      DEFAULT_TRANSCRIPT_MESSAGE_LIMIT,
    );
    this.maxMemoryWrites = positiveIntegerOr(
      options.maxMemoryWrites,
      DEFAULT_MAX_MEMORY_WRITES,
    );
    this.restWindow = options.restWindow;
    this.orientationRewriteGate = buildOrientationRewriteGate(
      options.orientationRewriteGate ?? DEFAULT_ORIENTATION_REWRITE_GATE,
    );
    this.onGateEvent = options.onGateEvent ?? null;
    this.onReviewFailure = options.onReviewFailure ?? null;
    this.contactStore = options.contactStore ?? null;
    this.companionId = options.companionId?.trim() || undefined;
    this.companionAuthorIds = options.companionAuthorIds ?? [];
    this.now = options.now ?? (() => Date.now());
    this.sleepConsolidator = options.sleepConsolidator;
    this.arcWeaver = options.arcWeaver;
    this.dreamMeaningPass = options.dreamMeaningPass;
    this.sleeptimeWikiPass = options.sleeptimeWikiPass;
    this.memoryMaintenanceStore = options.memoryMaintenanceStore ?? null;
    this.episodicDiagnosticsStore = options.episodicDiagnosticsStore ?? null;
  }

  /**
   * Rest-window inference is the ONLY trigger surface for sleeptime work. The
   * scheduler polls this on an interval; turn cadence has no code path here.
   * One companion-level action represents the entire changed-session snapshot.
   */
  async inferIdlePostTurnActions(options: {
    nowMs?: number;
  } = {}): Promise<PostTurnActionCandidate[]> {
    const snapshot = (await this.conversationalActivityWorkset.enumerate('sleeptime_consolidation'))
      .filter(item => this.isEligibleWorkItem(item));
    if (snapshot.length === 0) return [];
    const nowMs = typeof options.nowMs === 'number' && Number.isFinite(options.nowMs)
      ? options.nowMs
      : this.now();
    const lastUserActivityAtMs = this.latestActivityAtMs(snapshot);
    const restWindowDecision = evaluateRestWindowEligibility({
      config: this.restWindow,
      nowMs,
      lastUserActivityAtMs,
    });
    if (!restWindowDecision.allowed) return [];
    const actions: PostTurnActionCandidate[] = [];
    actions.push({
      kind: SLEEPTIME_MEMORY_ACTION_KIND,
      payload: {
        trigger: 'idle_rest_window',
        lastUserActivityAtMs,
        changedSessionCount: snapshot.length,
      },
      dedupeKey: SLEEPTIME_COMPANION_ACTION_DEDUPE_KEY,
      maxRetries: 1,
    });
    return actions;
  }

  async execute(
    action: Pick<InferredPostTurnAction, 'id' | 'sourceMessageId' | 'payload'>,
    control: SleeptimeExecutionControl = {},
  ): Promise<SleeptimeWorksetRunOutcome> {
    const snapshot = (await this.conversationalActivityWorkset.enumerate('sleeptime_consolidation'))
      .filter(item => this.isEligibleWorkItem(item));
    if (snapshot.length === 0) {
      return { outcome: 'complete', completedSessions: 0, remainingSessions: 0 };
    }
    const restWindowDecision = evaluateRestWindowEligibility({
      config: this.restWindow,
      nowMs: this.now(),
      lastUserActivityAtMs: this.latestActivityAtMs(snapshot),
    });
    if (!restWindowDecision.allowed) {
      log.info('Yielding sleeptime workset outside rest-window eligibility', {
        actionId: action.id,
        reasonCode: restWindowDecision.reasonCode,
        nextEligibleAtMs: restWindowDecision.nextEligibleAtMs,
        inactiveForMs: restWindowDecision.inactiveForMs,
        requiredInactiveMs: restWindowDecision.requiredInactiveMs,
        timeZone: restWindowDecision.timeZone,
      });
      return {
        outcome: 'yield',
        completedSessions: 0,
        remainingSessions: snapshot.length,
        ...(typeof restWindowDecision.nextEligibleAtMs === 'number'
          && Number.isFinite(restWindowDecision.nextEligibleAtMs)
          ? { nextEligibleAtMs: restWindowDecision.nextEligibleAtMs }
          : {}),
      };
    }

    const snapshotRevisions = new Map(
      snapshot.map(item => [item.logicalSessionId, item.revision]),
    );
    const entriesBySession = new Map<string, SessionEntry[]>();
    const reviewOwners = this.resolveJournalReviewOwners(snapshot.map(item => item.logicalSessionId));
    const runner = new SleeptimeWorksetRunner({
      workset: this.conversationalActivityWorkset,
      claimantId: SLEEPTIME_WORKSET_CLAIMANT_ID,
      shouldYield: async () => this.hasActivityBeyondSnapshot(snapshotRevisions),
      isYieldError: error => (
        control.isYieldError?.(error) === true
        || classifyPostTurnActionContention(error) !== null
      ),
      ...(control.onSafeBoundary ? { onSafeBoundary: control.onSafeBoundary } : {}),
      runStage: async input => this.runWorksetStage(
        input,
        action,
        entriesBySession,
        reviewOwners,
      ),
    });
    return runner.run(snapshot);
  }

  /**
   * d5e0p.8: a channel whose L0 history spans several journal chains is
   * indexed as `<channel>` plus `<channel>#<file>` sessions — one conversation.
   * Each conversation is reviewed once per run: by the channel session when it
   * is pending (it receives the channel's appends and reads its newest chain),
   * otherwise by the first pending journal session of that channel.
   */
  private resolveJournalReviewOwners(sessionIds: readonly string[]): ReadonlyMap<string, string> {
    const pending = new Set(sessionIds);
    const owners = new Map<string, string>();
    for (const sessionId of sessionIds) {
      const { channelId } = this.sessionManager.getJournalSessionGroup(sessionId);
      if (!owners.has(channelId)) owners.set(channelId, pending.has(channelId) ? channelId : sessionId);
    }
    return owners;
  }

  private async runWorksetStage(
    input: SleeptimeWorksetStageInput,
    action: Pick<InferredPostTurnAction, 'id' | 'sourceMessageId'>,
    entriesBySession: Map<string, SessionEntry[]>,
    reviewOwners: ReadonlyMap<string, string>,
  ): Promise<void> {
    const sessionId = input.logicalSessionId;
    if (isTestingSessionId(sessionId)) {
      throw new Error('Testing sessions are not eligible for sleeptime');
    }
    if (this.sessionManager.isSessionRetiredOrQuarantined?.(sessionId)) {
      throw new Error('Retired or quarantined sessions are not eligible for sleeptime');
    }
    // d5e0p.8: one review per journal-split conversation; the others are a
    // logged no-op so the same day is never reviewed twice.
    const journalGroup = this.sessionManager.getJournalSessionGroup(sessionId);
    const reviewOwner = reviewOwners.get(journalGroup.channelId) ?? sessionId;
    if (reviewOwner !== sessionId) {
      log.info('Sleeptime stage skipped for a journal session; its conversation is reviewed under another session of the channel', {
        sessionId,
        reviewedUnder: reviewOwner,
        channelId: journalGroup.channelId,
        stage: input.stage,
        journalSessionCount: journalGroup.sessionIds.length,
      });
      return;
    }
    let recentEntries = entriesBySession.get(sessionId);
    if (!recentEntries) {
      recentEntries = this.sessionManager
        .getRecentMessagesAtOrBefore(sessionId, input.revision, this.transcriptMessageLimit)
        .filter(entry => (
          entry.id <= input.revision
          && (entry.role === 'user' || entry.role === 'assistant')
          // f54sx (via ccgdz.8): a runtime-authored fallback notice is not her
          // speech. It must be excluded HERE, at the only point the entries
          // still carry their metadata: everything downstream collapses them
          // to bare strings (`summarizeSessionEntry`, `GroundingEntry`), so a
          // notice that survives this filter both enters the orient-rewrite
          // transcript AND counts as grounding evidence in the 1gpol gate —
          // letting text the runtime wrote support a memory write about her.
          && !isRuntimeAuthoredFallbackSessionEntry(entry)
        ));
      if (recentEntries.length === 0) {
        // Per-session: the workset runner records this as that session's
        // failure and moves on (`sleeptime-workset.ts`), so a session whose
        // only change was a runtime notice never blocks the others. Naming the
        // cause matters because the filter above widened which sessions land
        // here — an operator must not read this as a missing transcript.
        throw new Error(
          'Changed conversational session has no readable conversational transcript '
          + '(its entries in range are runtime-authored notices or non-conversational)',
        );
      }
      entriesBySession.set(sessionId, recentEntries);
    }

    const passInput = {
      sessionId,
      sourceMessageId: action.sourceMessageId,
      throughRevision: input.revision,
      throughOccurredAtMs: input.occurredAtMs,
    };
    switch (input.stage) {
      case 'sleep_consolidation':
        await this.sleepConsolidator.run(passInput);
        return;
      case 'arc_formation':
        await this.arcWeaver.run(passInput);
        return;
      case 'dream_meaning':
        await this.dreamMeaningPass.run(passInput);
        return;
      case 'wiki_pass':
        await this.sleeptimeWikiPass.run(passInput);
        return;
      case 'orientation_review':
        await this.runOrientationReview(
          sessionId,
          action,
          recentEntries,
          input.occurredAtMs,
          input.activityKind,
        );
        return;
    }
  }

  private async runOrientationReview(
    sessionId: string,
    action: Pick<InferredPostTurnAction, 'id' | 'sourceMessageId'>,
    recentEntries: readonly SessionEntry[],
    throughOccurredAtMs: number,
    activityKind?: ProcessableConversationKind,
  ): Promise<void> {

    const coreMemoryScope = coreMemoryChannelScope({ channelId: sessionId });
    const currentSnapshot = this.coreMemoryStore.getSnapshot({ scope: coreMemoryScope });

    // Deterministic orientation-rewrite gate (jpvd.4): the orient plan call
    // below is the heaviest nightly LLM pass. Skip it entirely when nothing has
    // changed since the last rewrite. `updatedAt` is the last time the orient
    // blocks changed (rethink is the only writer in this scope).
    const gate = this.evaluateOrientationRewriteGate(currentSnapshot, recentEntries);
    if (!gate.open) {
      this.emitGateEvent({ sessionId, outcome: 'skipped', reason: gate.reason, inputs: gate.inputs });
      log.info('Sleeptime orient rewrite skipped: no deterministic evidence of change', {
        sessionId,
        actionId: action.id,
        reason: gate.reason,
        ...gate.inputs,
      });
      return;
    }
    this.emitGateEvent({ sessionId, outcome: 'ran', reason: gate.reason, inputs: gate.inputs });

    const transcript = recentEntries.map(summarizeSessionEntry).join('\n');
    // Fail closed: episode loading errors abort the pass — she must not review
    // her day against a silently degraded context.
    const dayEpisodes = await this.loadDayEpisodes(sessionId, throughOccurredAtMs);
    const groundingCorpus = buildGroundingCorpus(recentEntries, dayEpisodes);
    const orientationCorpus = [
      ...groundingCorpus,
      ...Object.values(currentSnapshot.blocks).map(block => ({ content: block.content })),
    ];
    const temporalGrounding = await loadSleeptimeReviewGrounding({
      entries: recentEntries,
      reviewedAtMs: this.now(),
      concernStore: this.resolvedConcernStore,
      supportsConcernText: text => countSupportingTranscriptEntries(text, orientationCorpus) > 0,
    });
    const reviewOutcome = await this.runReviewConversation({
      sessionId,
      actionId: action.id,
      orientBlocks: currentSnapshot.blocks,
      transcript,
      episodes: dayEpisodes,
      temporalGrounding: temporalGrounding.prompt,
      throughOccurredAtMs,
    });
    if (!reviewOutcome.plan) {
      const errorDetail = `Sleeptime review produced no usable plan after ${MAX_REVIEW_TURNS} turns: ${reviewOutcome.lastError}`;
      log.error('Sleeptime review exhausted retries without a usable plan; orientation and memories left untouched', {
        sessionId,
        actionId: action.id,
        attempts: MAX_REVIEW_TURNS,
        error: reviewOutcome.lastError,
      });
      this.onReviewFailure?.({
        sessionId,
        scopeKey: `session:${sessionId}`,
        candidateEpisodeIds: dayEpisodes.map(episode => episode.id),
        stage: 'orientation_review',
        error: errorDetail,
        timestamp: this.now(),
      });
      throw new Error(errorDetail);
    }
    const plan = reviewOutcome.plan;

    if (plan.concernDecisions.length > 0) {
      if (!this.concernCandidates) {
        throw new Error('Sleeptime plan decided concerns but no concern candidate port is composed');
      }
      for (const decision of plan.concernDecisions) {
        await this.concernCandidates.decide({ ...decision, actionId: action.id });
      }
      log.info('Sleeptime review decided pending concern candidates', {
        sessionId,
        actionId: action.id,
        kept: plan.concernDecisions.filter(entry => entry.decision === 'keep').length,
        letGo: plan.concernDecisions.filter(entry => entry.decision === 'let_go').length,
      });
    }
    let orientBlocksRejected: SleeptimeOrientBlockName[] = [];

    const orientRejection = evaluateSleeptimeOrientCandidacy(plan.orient);
    if (orientRejection) {
      log.warn('Sleeptime orient rewrite skipped by CogSec candidacy policy', {
        sessionId,
        actionId: action.id,
        block: orientRejection.block,
        riskClass: orientRejection.decision.riskClass,
        disposition: orientRejection.decision.disposition,
        reasonCodes: orientRejection.decision.reasonCodes,
      });
    } else {
      // Grounding gate (1gpol): a rewritten block whose novel content has no
      // support in the day's transcript or episodes keeps its previous
      // grounded content instead of being overwritten wholesale.
      const acceptance = acceptGroundedOrientBlocks(plan.orient, currentSnapshot.blocks, [
        ...groundingCorpus,
        ...temporalGrounding.orientationEvidence,
      ]);
      orientBlocksRejected = acceptance.rejectedBlocks;
      if (acceptance.rejectedBlocks.length > 0) {
        log.warn('Sleeptime orient rewrite rejected ungrounded blocks; previous content kept', {
          sessionId,
          actionId: action.id,
          rejectedBlocks: acceptance.rejectedBlocks,
        });
      }
      this.coreMemoryStore.rethink(acceptance.blocks, { scope: coreMemoryScope });
    }

    // Conversation-time bound for disclosure-epoch resolution (ca980): the latest
    // reviewed source-entry instant, the SAME safe upper bound the extractor
    // stamps. Never the sleeptime run clock — this pass runs deferred, so `now()`
    // would post-date the conversation and risk resolving a since-widened epoch.
    const sourceConversationAt = latestSourceEntryTimestamp(recentEntries);
    const attribution = plan.memoryWrites.length > 0
      ? await resolveSessionMemoryAttribution({
          sessionId,
          ...(activityKind ? { activityKind } : {}),
          entries: recentEntries,
          contactStore: this.contactStore,
          ...(this.companionId ? { localCompanionId: this.companionId } : {}),
          companionAuthorIds: this.companionAuthorIds,
        })
      : { kind: 'none' as const };
    const sourceMessageIds = recentEntries.map(entry => entry.id);
    let writtenCount = 0;
    let reviewQueuedCount = 0;
    let ungroundedRejectedCount = 0;
    for (const memory of plan.memoryWrites) {
      const evidenceCount = countSupportingTranscriptEntries(memory.text, groundingCorpus);
      // Grounding gate (1gpol): zero supporting entries is a rejection before
      // either active-memory or maintenance-review persistence.
      if (evidenceCount === 0) {
        ungroundedRejectedCount += 1;
        log.warn('Sleeptime memory write rejected: ungrounded in the day transcript and episodes', {
          sessionId,
          actionId: action.id,
          type: memory.type,
        });
        continue;
      }

      const queuedReview = await this.queueUncertainMemoryWriteReview({
        memory,
        sessionId,
        actionId: action.id,
        sourceMessageId: action.sourceMessageId,
      });
      if (queuedReview) {
        reviewQueuedCount += 1;
        continue;
      }

      const writePayload = buildSleepTimeMemoryWritePayload({
        memory,
        sessionId,
        actionId: action.id,
        sourceMessageId: action.sourceMessageId,
        sourceMessageIds,
        attribution,
        evidenceCount,
        ...(sourceConversationAt !== undefined ? { sourceConversationAt } : {}),
      });
      const result = await this.memoryWriter.write(writePayload);
      writtenCount += 1;
      reviewQueuedCount += await this.queueConflictReviewFromWriteResult(result);
    }
    const memoryMaintenanceDiagnostics = await this.getMemoryMaintenanceDiagnostics();
    const episodicMaintenanceDiagnostics = await this.getEpisodicMaintenanceDiagnostics();

    log.info('Sleeptime memory run complete', {
      sessionId,
      actionId: action.id,
      sourceMessageId: action.sourceMessageId,
      transcriptEntries: recentEntries.length,
      episodesReviewed: dayEpisodes.length,
      memoryWritesRequested: plan.memoryWrites.length,
      memoryWritesSucceeded: writtenCount,
      memoryWritesRejectedUngrounded: ungroundedRejectedCount,
      orientBlocksRejected,
      memoryMaintenanceReviewsQueued: reviewQueuedCount,
      ...(memoryMaintenanceDiagnostics ? { memoryMaintenanceDiagnostics } : {}),
      ...(episodicMaintenanceDiagnostics ? { episodicMaintenanceDiagnostics } : {}),
    });
  }

  private latestActivityAtMs(items: readonly ConversationalActivityWorkItem[]): number {
    return items.reduce(
      (latest, item) => Math.max(latest, item.occurredAtMs),
      0,
    );
  }

  private isEligibleWorkItem(item: ConversationalActivityWorkItem): boolean {
    return !isTestingSessionId(item.logicalSessionId)
      && !this.sessionManager.isSessionRetiredOrQuarantined?.(item.logicalSessionId);
  }

  private async hasActivityBeyondSnapshot(snapshotRevisions: ReadonlyMap<string, number>): Promise<boolean> {
    const current = (await this.conversationalActivityWorkset.enumerate('sleeptime_consolidation'))
      .filter(item => this.isEligibleWorkItem(item));
    return current.some(item => item.revision > (snapshotRevisions.get(item.logicalSessionId) ?? 0));
  }

  private evaluateOrientationRewriteGate(
    snapshot: { updatedAt: string; blocks: Record<'persona' | 'human' | 'goals', { content: string }> },
    recentEntries: readonly SessionEntry[],
  ): { open: boolean; reason: string; inputs: Record<string, number | string> } {
    const nowMs = this.now();
    // A never-oriented companion (all orient blocks empty) has no baseline to
    // preserve: the first rewrite should fire on any activity. `updatedAt` on a
    // lazily-created snapshot is read-time, not a real rewrite, so it must not
    // gate the first orientation closed.
    const orientedBefore = (['persona', 'human', 'goals'] as const)
      .some(block => snapshot.blocks[block].content.trim().length > 0);
    const updatedAtMs = Date.parse(snapshot.updatedAt);
    // Without a real baseline (never oriented, or unreadable timestamp) we
    // cannot prove nothing changed, so the gate opens (fail open toward doing
    // the work once).
    const hasBaseline = orientedBefore && Number.isFinite(updatedAtMs);
    const newEntriesSinceRewrite = hasBaseline
      ? recentEntries.filter(entry => entry.timestamp > updatedAtMs).length
      : recentEntries.length;
    const daysSinceRewrite = hasBaseline
      ? (nowMs - updatedAtMs) / DAY_MS
      : Number.POSITIVE_INFINITY;
    // Elapsed time only re-opens the gate when there is at least some new
    // activity — never rewrite orientation from an empty transcript.
    const staleWithActivityDays = newEntriesSinceRewrite >= 1
      ? (Number.isFinite(daysSinceRewrite) ? daysSinceRewrite : Number.MAX_SAFE_INTEGER)
      : 0;
    const decision = evaluateDeterministicGate(this.orientationRewriteGate, {
      newEntriesSinceRewrite,
      staleWithActivityDays,
      daysSinceRewrite: Number.isFinite(daysSinceRewrite)
        ? Math.round(daysSinceRewrite * 100) / 100
        : Number.MAX_SAFE_INTEGER,
    });
    return { open: decision.open, reason: decision.reason, inputs: decision.inputs };
  }

  private emitGateEvent(input: {
    sessionId: string;
    outcome: 'ran' | 'skipped';
    reason: string;
    inputs: Record<string, number | string>;
  }): void {
    if (!this.onGateEvent) return;
    this.onGateEvent({
      lane: ORIENTATION_REWRITE_GATE_LANE,
      outcome: input.outcome,
      reason: input.reason,
      inputs: input.inputs,
      timestamp: this.now(),
      sessionId: input.sessionId,
    });
  }

  private resolveSleeptimePromptText(): string {
    return this.promptRegistry?.getPrompt(SLEEPTIME_ORIENTATION_PROMPT_KEY)
      ?? getDefaultPromptText(SLEEPTIME_ORIENTATION_PROMPT_KEY);
  }

  /**
   * The current logical session's recent consolidated episodes, returned oldest
   * first. One logical session may span bound private physical surfaces; group,
   * invite-only, and unrelated private sessions retain distinct logical owners.
   * Episodes stamped with any journal session of the same channel belong to
   * this conversation (d5e0p.8).
   * Errors propagate rather than silently widening or degrading that context.
   */
  private async loadDayEpisodes(sessionId: string, throughOccurredAtMs: number): Promise<Episode[]> {
    const episodes = await this.episodicStore.searchByTime({
      spanSessionIds: this.sessionManager.getJournalSessionGroup(sessionId).sessionIds,
      order: 'desc',
      from: toIsoInstant(throughOccurredAtMs - DAY_MS),
      to: toIsoInstant(throughOccurredAtMs),
      limit: EPISODE_REVIEW_LIMIT,
    });
    return [...episodes].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  /**
   * Her end-of-day review, run as her own bounded reflection turns (dream-pass
   * idiom): opening prompt with orientation, episodes, and transcript; on an
   * unusable reply she gets the parse feedback and another turn, up to
   * MAX_REVIEW_TURNS; null when no turn produced a usable plan.
   */
  private async runReviewConversation(input: {
    sessionId: string;
    actionId: string;
    orientBlocks: Record<SleeptimeOrientBlockName, { content: string }>;
    transcript: string;
    episodes: readonly Episode[];
    temporalGrounding: string;
    throughOccurredAtMs: number;
  }): Promise<{ plan: NormalizedSleeptimePlan } | { plan: null; lastError: string }> {
    const pendingConcerns = this.concernCandidates ? await this.concernCandidates.list() : [];
    const offeredConcernIds = new Set(pendingConcerns.map(candidate => candidate.id));
    const pendingConcernSection = renderPendingConcernCandidatesSection(pendingConcerns, 'sleeptime_plan');
    let prompt = [
      this.resolveSleeptimePromptText(),
      '',
      input.temporalGrounding,
      '',
      ...(pendingConcernSection ? [pendingConcernSection, ''] : []),
      'Current orientation blocks:',
      `persona:\n${input.orientBlocks.persona.content || '[empty]'}`,
      `human:\n${input.orientBlocks.human.content || '[empty]'}`,
      `goals:\n${input.orientBlocks.goals.content || '[empty]'}`,
      '',
      `Episode evidence window: ${toIsoInstant(input.throughOccurredAtMs - DAY_MS)} through ${toIsoInstant(input.throughOccurredAtMs)}`,
      formatEpisodeReviewBlock(input.episodes),
      '',
      'Source transcript (historical evidence):',
      input.transcript,
      '',
      `Return strict JSON with keys "orient" and "memory_writes" (max ${this.maxMemoryWrites}).`,
    ].join('\n');

    let lastError = 'no review turn completed';
    for (let turn = 1; turn <= MAX_REVIEW_TURNS; turn += 1) {
      const response = await this.agent.handleMessage({
        id: `sleeptime-review-${input.actionId}-${String(turn)}`,
        channelId: SLEEPTIME_REVIEW_CHANNEL_ID,
        channelType: 'terminal',
        authorId: 'scheduler',
        authorName: 'Sleeptime Review',
        content: prompt,
        timestamp: new Date(this.now()),
        routing: {
          workerExecution: createWorkerExecutionPolicy(WHISPER_WORKER_LANE),
        },
      });
      try {
        return {
          plan: normalizeSleeptimePlan(
            response.content,
            this.maxMemoryWrites,
            offeredConcernIds,
            input.orientBlocks,
          ),
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        lastError = reason;
        log.warn('Sleeptime review turn produced an unusable plan; asking again with feedback', {
          sessionId: input.sessionId,
          turn,
          error: reason,
        });
        prompt = [
          `Your previous reply could not be used: ${reason}`,
          'Reply again with ONLY a single strict JSON object matching:',
          `{"orient":{"persona":"...","human":"...","goals":"..."},"memory_writes":[{"text":"...","type":"${VALID_MEMORY_TYPES.join('|')}","importance":0.0,"confidence":0.0,"emotionalValence":0.0,"tags":[],"sensitivity":"${VALID_SENSITIVITY_LEVELS.join('|')}"}]}`,
          `Constraints: max ${this.maxMemoryWrites} memory_writes; omit or leave blank any orient block you want to keep unchanged${offeredConcernIds.size > 0 ? '; optional "concern_decisions":[{"id":"<offered-id>","decision":"keep"|"let_go"}]' : ''}.`,
        ].join('\n');
      }
    }
    return { plan: null, lastError };
  }

  private async queueMaintenanceReview(
    input: MemoryMaintenanceReviewInput | null,
  ): Promise<MemoryMaintenanceReview | null> {
    if (!input || !this.memoryMaintenanceStore?.upsertMemoryMaintenanceReview) return null;
    return this.memoryMaintenanceStore.upsertMemoryMaintenanceReview(input);
  }

  private async queueUncertainMemoryWriteReview(input: {
    memory: NormalizedMemoryWrite;
    sessionId: string;
    actionId: string;
    sourceMessageId?: string;
  }): Promise<MemoryMaintenanceReview | null> {
    const review = buildHighImpactLowConfidenceReviewInput(reviewSubjectForMemoryWrite(input));
    return this.queueMaintenanceReview(review);
  }

  private async queueConflictReviewFromWriteResult(result: WriteResult): Promise<number> {
    if (
      !this.memoryMaintenanceStore?.getById
      || !this.memoryMaintenanceStore.upsertMemoryMaintenanceReview
      || !['conflict', 'negated'].includes(result.action)
      || !result.relatedMemoryIds?.length
    ) {
      return 0;
    }

    const candidates: PurrMemory[] = [];
    for (const memoryId of result.relatedMemoryIds) {
      const candidate = await this.memoryMaintenanceStore.getById(memoryId);
      if (candidate) candidates.push(candidate);
    }
    const review = await this.queueMaintenanceReview(buildConflictingMemoryReviewInput(result.memory, candidates));
    return review ? 1 : 0;
  }

  private async getMemoryMaintenanceDiagnostics(): Promise<MemoryMaintenanceDiagnostics | null> {
    if (!this.memoryMaintenanceStore?.getMemoryMaintenanceDiagnostics) return null;
    return this.memoryMaintenanceStore.getMemoryMaintenanceDiagnostics();
  }

  private async getEpisodicMaintenanceDiagnostics(): Promise<EpisodicMaintenanceDiagnostics | null> {
    if (!this.episodicDiagnosticsStore) return null;
    return this.episodicDiagnosticsStore.getMaintenanceDiagnostics();
  }

}
