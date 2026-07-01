import { createHash } from 'node:crypto';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
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
import type { SessionManager } from '../../core/session/manager.js';
import type { EpisodicProcessingRestWindowConfig } from '../../system/config/scheduler-config.js';
import type {
  CoreMemoryStorePort,
  MemoryMaintenanceDiagnostics,
  MemoryMaintenanceReview,
  MemoryMaintenanceReviewInput,
  MemoryStorePort,
} from './memory-store-port.js';
import type { MemoryWriteOptions, MemoryWriter, WriteResult } from './writer.js';
import type { EpisodicSynthesisRunResult, EpisodicSynthesizer } from './episodic/synthesis.js';
import type { SleepCycleEpisodeConsolidator } from './episodic/sleep-consolidation.js';
import type { EpisodeArcWeaver } from './episodic/arc-formation.js';
import type { DreamMeaningPass } from './episodic/dream-meaning-pass.js';
import type { EpisodicMaintenanceDiagnostics } from './episodic/store.js';
import {
  buildConflictingMemoryReviewInput,
  buildHighImpactLowConfidenceReviewInput,
  buildStaleMemoryReviewInput,
  type UncertainMemoryReviewSubject,
} from './maintenance-review.js';
import {
  VALID_MEMORY_TYPES,
  VALID_SENSITIVITY_LEVELS,
  type MemoryType,
  type PurrMemory,
  type SensitivityLevel,
} from './types.js';

const log = createComponentLogger('SleeptimeMemoryAgent');

export const SLEEPTIME_MEMORY_ACTION_KIND = 'memory.sleeptime.run';

const DEFAULT_CADENCE_TURNS = 3;
const DEFAULT_IDLE_SESSION_LIMIT = 20;
const DEFAULT_TRANSCRIPT_MESSAGE_LIMIT = 24;
const DEFAULT_MAX_MEMORY_WRITES = 4;
const MAX_TRANSCRIPT_ENTRY_CHARS = 600;
const MAX_STALE_REVIEW_SCAN = 50;
const MAX_STALE_REVIEWS_PER_RUN = 3;
const MAX_BEHAVIORAL_SUMMARY_WRITES = 1;
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
type SessionMemoryReader = Pick<SessionManager, 'resolveSessionChannelId' | 'getRecentMessages'>
  & Partial<Pick<SessionManager, 'listRecentSessions' | 'isSessionRetiredOrQuarantined'>>;
type SleeptimeMemoryWriter = Pick<MemoryWriter, 'write'>;
type SleeptimeEpisodicSynthesizer = Pick<EpisodicSynthesizer, 'run'>;
type SleeptimeEpisodeConsolidator = Pick<SleepCycleEpisodeConsolidator, 'run'>;
type SleeptimeArcWeaver = Pick<EpisodeArcWeaver, 'run'>;
type SleeptimeDreamMeaningPass = Pick<DreamMeaningPass, 'run'>;
type SleeptimeMaintenanceStore = Pick<
  MemoryStorePort,
  'upsertMemoryMaintenanceReview' | 'listActiveMemories' | 'getById' | 'getMemoryMaintenanceDiagnostics'
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
}

type SleeptimeOrientBlockName = keyof NormalizedSleeptimePlan['orient'];
interface SleeptimeOrientCandidacyRejection {
  block: SleeptimeOrientBlockName;
  decision: CogSecMemoryCandidacyDecision;
}

export interface SleeptimeMemoryAgentOptions {
  llmProvider: LLMProviderPort;
  sessionManager: SessionMemoryReader;
  coreMemoryStore: CoreMemoryRewriter;
  memoryWriter: SleeptimeMemoryWriter;
  promptRegistry?: PromptRegistryStatePort | null;
  cadenceTurns?: number;
  transcriptMessageLimit?: number;
  maxMemoryWrites?: number;
  restWindow?: EpisodicProcessingRestWindowConfig;
  episodicSynthesizer?: SleeptimeEpisodicSynthesizer | null;
  sleepConsolidator?: SleeptimeEpisodeConsolidator | null;
  arcWeaver?: SleeptimeArcWeaver | null;
  dreamMeaningPass?: SleeptimeDreamMeaningPass | null;
  memoryMaintenanceStore?: SleeptimeMaintenanceStore | null;
  episodicDiagnosticsStore?: SleeptimeEpisodicDiagnosticsStore | null;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function clampUnit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(-1, Math.min(1, value));
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
  const normalized = raw.trim() as MemoryType;
  if (!VALID_MEMORY_TYPES.includes(normalized)) {
    throw new Error(`Sleeptime memory write type "${raw}" is invalid`);
  }
  return normalized;
}

function normalizeSensitivity(raw: unknown): SensitivityLevel {
  if (typeof raw !== 'string') return 'personal';
  const normalized = raw.trim() as SensitivityLevel;
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

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Sleeptime model returned empty output');
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) {
      return candidate;
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error('Sleeptime model did not return a JSON object');
}

function normalizeSleeptimePlan(raw: string, maxMemoryWrites: number): NormalizedSleeptimePlan {
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
    persona: normalizeText(orientRecord['persona']),
    human: normalizeText(orientRecord['human']),
    goals: normalizeText(orientRecord['goals']),
  };

  const memoryWritesRaw = Array.isArray(record['memory_writes'])
    ? record['memory_writes']
    : [];
  const memoryWrites: NormalizedMemoryWrite[] = [];

  for (const rawWrite of memoryWritesRaw) {
    if (!rawWrite || typeof rawWrite !== 'object' || Array.isArray(rawWrite)) {
      continue;
    }
    const writeRecord = rawWrite as Record<string, unknown>;
    memoryWrites.push({
      text: normalizeText(writeRecord['text']),
      type: normalizeMemoryType(writeRecord['type']),
      importance: clampUnit(writeRecord['importance'], 0.65),
      confidence: clampUnit(writeRecord['confidence'], 0.75),
      emotionalValence: clampSigned(writeRecord['emotionalValence'], 0),
      tags: normalizeTags(writeRecord['tags']),
      sensitivity: normalizeSensitivity(writeRecord['sensitivity']),
    });
    if (memoryWrites.length >= maxMemoryWrites) {
      break;
    }
  }

  return {
    orient,
    memoryWrites,
  };
}

function evaluateSleeptimeOrientCandidacy(
  orient: NormalizedSleeptimePlan['orient'],
): SleeptimeOrientCandidacyRejection | null {
  const blocks: SleeptimeOrientBlockName[] = ['persona', 'human', 'goals'];
  for (const block of blocks) {
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
    ? 'ASSISTANT'
    : entry.role === 'user'
      ? 'USER'
      : entry.role.toUpperCase();
  const collapsed = entry.content.replace(/\s+/g, ' ').trim();
  const clipped = collapsed.length > MAX_TRANSCRIPT_ENTRY_CHARS
    ? `${collapsed.slice(0, MAX_TRANSCRIPT_ENTRY_CHARS)}...`
    : collapsed;
  return `${rolePrefix}: ${clipped || '[empty]'}`;
}

function summarizeEpisodicSynthesis(result: EpisodicSynthesisRunResult): {
  episodicCandidateEpisodes: number;
  episodicCreatedEpisodes: number;
  episodicSkippedEpisodes: number;
  episodicLinkedArcs: number;
} {
  return {
    episodicCandidateEpisodes: result.candidateEpisodeCount,
    episodicCreatedEpisodes: result.createdEpisodes.length,
    episodicSkippedEpisodes: result.skippedEpisodeIds.length,
    episodicLinkedArcs: result.linkedArcs.length,
  };
}

function stableId(prefix: string, parts: readonly string[]): string {
  const fingerprint = createHash('sha256')
    .update(parts.join('\u001f'))
    .digest('hex')
    .slice(0, 24);
  return `${prefix}:${fingerprint}`;
}

function normalizeEvidenceTokens(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
  return [...new Set(tokens.filter(token => !EVIDENCE_TOKEN_STOP_WORDS.has(token)))].slice(0, 8);
}

function countSupportingTranscriptEntries(
  memoryText: string,
  entries: readonly SessionEntry[],
): number {
  const tokens = normalizeEvidenceTokens(memoryText);
  if (tokens.length === 0) return 0;
  return entries.reduce((count, entry) => {
    const content = entry.content.toLowerCase();
    const matches = tokens.reduce((sum, token) => sum + (content.includes(token) ? 1 : 0), 0);
    return count + (matches >= Math.min(2, tokens.length) ? 1 : 0);
  }, 0);
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

function buildSleepTimeMemoryWritePayload(input: {
  memory: NormalizedMemoryWrite;
  sessionId: string;
  actionId: string;
  sourceMessageId?: string;
  evidenceCount: number;
}): MemoryWriteOptions {
  const sourceRef = `source:sleeptime|session:${input.sessionId}|message:${input.sourceMessageId ?? 'unknown'}`;
  const repeatedFact = input.evidenceCount >= 2 && input.memory.confidence >= 0.72 && input.memory.importance >= 0.65;
  return {
    text: input.memory.text,
    type: input.memory.type,
    importance: input.memory.importance,
    confidence: input.memory.confidence,
    emotionalValence: input.memory.emotionalValence,
    sensitivity: input.memory.sensitivity,
    sourceRef,
    sourceType: 'autonomous_action',
    provenance: {
      channelId: input.sessionId,
      sessionId: input.sessionId,
      actor: 'system',
      reason: 'sleeptime',
      ...(input.sourceMessageId ? { sourceMessageIds: [Number(input.sourceMessageId)].filter(Number.isFinite) } : {}),
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

function buildBehavioralSummaryWrites(input: {
  sessionId: string;
  actionId: string;
  sourceMessageId?: string;
  episodicSynthesis: EpisodicSynthesisRunResult | null;
}): MemoryWriteOptions[] {
  const arcs = input.episodicSynthesis?.linkedArcs
    .filter(arc => arc.confidence >= 0.7)
    .filter(arc => arc.arcKind !== 'same_theme')
    .slice(0, MAX_BEHAVIORAL_SUMMARY_WRITES) ?? [];
  return arcs.map(arc => {
    const themes = arc.themes.slice(0, 3).join(', ') || 'recent continuity';
    const sourceRef = `source:sleeptime|session:${input.sessionId}|episode_arc:${arc.id}`;
    return {
      text: `Sleep-time evidence chain shows a ${arc.arcKind.replace(/_/g, ' ')} pattern around ${themes}.`,
      type: 'reflection',
      importance: 0.62,
      confidence: Math.min(0.84, Math.max(0.7, arc.confidence)),
      emotionalValence: 0,
      sensitivity: 'personal',
      sourceRef,
      sourceType: 'autonomous_action',
      provenance: {
        channelId: input.sessionId,
        sessionId: input.sessionId,
        actor: 'system',
        reason: 'sleeptime_behavioral_summary',
      },
      provenanceRefs: [
        sourceRef,
        `l01_episode_arc:${arc.id}`,
        `l01_episode:${arc.sourceEpisodeId}`,
        `l01_episode:${arc.targetEpisodeId}`,
        `sleeptime_action:${input.actionId}`,
        ...(input.sourceMessageId ? [`source_message:${input.sourceMessageId}`] : []),
      ],
      tags: [
        'sleeptime',
        'behavioral_summary',
        'evidence_chain',
        `episode_arc:${arc.arcKind}`,
      ],
      scopeRef: {
        kind: 'conversation',
        id: input.sessionId,
        label: 'sleeptime source session',
      },
      scopeTags: [`channel:${input.sessionId}`, 'sleeptime'],
    };
  });
}

export class SleeptimeMemoryAgent {
  private readonly llmProvider: LLMProviderPort;
  private readonly sessionManager: SessionMemoryReader;
  private readonly coreMemoryStore: CoreMemoryRewriter;
  private readonly memoryWriter: SleeptimeMemoryWriter;
  private readonly promptRegistry: PromptRegistryStatePort | null;
  private readonly cadenceTurns: number;
  private readonly transcriptMessageLimit: number;
  private readonly maxMemoryWrites: number;
  private readonly restWindow?: EpisodicProcessingRestWindowConfig;
  private readonly episodicSynthesizer: SleeptimeEpisodicSynthesizer | null;
  private readonly sleepConsolidator: SleeptimeEpisodeConsolidator | null;
  private readonly arcWeaver: SleeptimeArcWeaver | null;
  private readonly dreamMeaningPass: SleeptimeDreamMeaningPass | null;
  private readonly memoryMaintenanceStore: SleeptimeMaintenanceStore | null;
  private readonly episodicDiagnosticsStore: SleeptimeEpisodicDiagnosticsStore | null;
  private readonly turnCountBySession = new Map<string, number>();

  constructor(options: SleeptimeMemoryAgentOptions) {
    this.llmProvider = options.llmProvider;
    this.sessionManager = options.sessionManager;
    this.coreMemoryStore = options.coreMemoryStore;
    this.memoryWriter = options.memoryWriter;
    this.promptRegistry = options.promptRegistry ?? null;
    this.cadenceTurns = normalizePositiveInteger(options.cadenceTurns, DEFAULT_CADENCE_TURNS);
    this.transcriptMessageLimit = normalizePositiveInteger(
      options.transcriptMessageLimit,
      DEFAULT_TRANSCRIPT_MESSAGE_LIMIT,
    );
    this.maxMemoryWrites = normalizePositiveInteger(
      options.maxMemoryWrites,
      DEFAULT_MAX_MEMORY_WRITES,
    );
    this.restWindow = options.restWindow;
    this.episodicSynthesizer = options.episodicSynthesizer ?? null;
    this.sleepConsolidator = options.sleepConsolidator ?? null;
    this.arcWeaver = options.arcWeaver ?? null;
    this.dreamMeaningPass = options.dreamMeaningPass ?? null;
    this.memoryMaintenanceStore = options.memoryMaintenanceStore ?? null;
    this.episodicDiagnosticsStore = options.episodicDiagnosticsStore ?? null;
  }

  inferPostTurnActions(input: {
    message: Pick<SubstrateMessage, 'id' | 'channelId'> & { timestamp?: Date };
  }): PostTurnActionCandidate[] {
    const candidate = this.inferPostTurnAction(input.message);
    return candidate ? [candidate] : [];
  }

  inferPostTurnAction(
    message: Pick<SubstrateMessage, 'id' | 'channelId'> & { timestamp?: Date },
  ): PostTurnActionCandidate | null {
    if (message.channelId.startsWith('internal:')) {
      return null;
    }

	    const sessionId = this.sessionManager.resolveSessionChannelId(message.channelId);
	    if (this.sessionManager.isSessionRetiredOrQuarantined?.(sessionId)) return null;
	    const nextCount = (this.turnCountBySession.get(sessionId) ?? 0) + 1;
    this.turnCountBySession.set(sessionId, nextCount);
    const lastUserActivityAtMs = message.timestamp instanceof Date
      ? message.timestamp.getTime()
      : Date.now();
    if (this.restWindow) {
      const restWindowDecision = evaluateRestWindowEligibility({
        config: this.restWindow,
        nowMs: lastUserActivityAtMs,
        lastUserActivityAtMs,
      });
      if (!restWindowDecision.allowed) {
        return null;
      }
    } else if (nextCount % this.cadenceTurns !== 0) {
      return null;
    }

    return {
      kind: SLEEPTIME_MEMORY_ACTION_KIND,
      payload: {
        sessionId,
        sourceChannelId: message.channelId,
        cadenceTurn: nextCount,
        lastUserActivityAtMs,
      },
      dedupeKey: `${SLEEPTIME_MEMORY_ACTION_KIND}:${sessionId}`,
      maxRetries: 1,
    };
  }

  inferIdlePostTurnActions(options: {
    nowMs?: number;
    limit?: number;
  } = {}): PostTurnActionCandidate[] {
    if (!this.restWindow || !this.sessionManager.listRecentSessions) {
      return [];
    }
    const nowMs = typeof options.nowMs === 'number' && Number.isFinite(options.nowMs)
      ? options.nowMs
      : Date.now();
    const limit = normalizePositiveInteger(options.limit, DEFAULT_IDLE_SESSION_LIMIT);
    const actions: PostTurnActionCandidate[] = [];
	    for (const session of this.sessionManager.listRecentSessions(limit)) {
	      const sessionId = this.sessionManager.resolveSessionChannelId(session.channelId);
	      if (sessionId.startsWith('internal:')) continue;
	      if (this.sessionManager.isSessionRetiredOrQuarantined?.(sessionId)) continue;
	      const lastUserActivityAtMs = session.lastActivityAt;
      const restWindowDecision = evaluateRestWindowEligibility({
        config: this.restWindow,
        nowMs,
        lastUserActivityAtMs,
      });
      if (!restWindowDecision.allowed) continue;
      actions.push({
        kind: SLEEPTIME_MEMORY_ACTION_KIND,
        payload: {
          sessionId,
          sourceChannelId: session.channelId,
          trigger: 'idle_rest_window',
          lastUserActivityAtMs,
        },
        dedupeKey: `${SLEEPTIME_MEMORY_ACTION_KIND}:${sessionId}`,
        maxRetries: 1,
      });
    }
    return actions;
  }

	  async execute(action: Pick<InferredPostTurnAction, 'id' | 'channelId' | 'sourceMessageId' | 'payload'>): Promise<void> {
	    const sessionId = this.resolveActionSessionId(action);
	    if (this.sessionManager.isSessionRetiredOrQuarantined?.(sessionId)) {
	      log.info('Skipping sleeptime run for retired session', {
	        sessionId,
	        actionId: action.id,
	      });
	      return;
	    }
	    const restWindowDecision = this.restWindow
      ? evaluateRestWindowEligibility({
        config: this.restWindow,
        lastUserActivityAtMs: this.resolveActionLastUserActivityAtMs(action),
      })
      : null;
    if (restWindowDecision && !restWindowDecision.allowed) {
      log.info('Skipping sleeptime run outside rest-window eligibility', {
        sessionId,
        actionId: action.id,
        reasonCode: restWindowDecision.reasonCode,
        nextEligibleAtMs: restWindowDecision.nextEligibleAtMs,
        inactiveForMs: restWindowDecision.inactiveForMs,
        requiredInactiveMs: restWindowDecision.requiredInactiveMs,
        timeZone: restWindowDecision.timeZone,
      });
      return;
    }

    const recentEntries = this.sessionManager
      .getRecentMessages(sessionId, this.transcriptMessageLimit)
      .filter(entry => entry.role === 'user' || entry.role === 'assistant');
    if (recentEntries.length === 0) {
      log.debug('Skipping sleeptime run: no recent conversational transcript', {
        sessionId,
        actionId: action.id,
      });
      return;
    }

    const episodicSynthesis = this.episodicSynthesizer
      ? await this.episodicSynthesizer.run({
        sessionId,
        sourceMessageId: action.sourceMessageId,
      })
      : null;

    const sleepConsolidation = this.sleepConsolidator
      ? await this.sleepConsolidator.run({
        sessionId,
        sourceMessageId: action.sourceMessageId,
      })
      : null;

    const arcFormation = this.arcWeaver
      ? await this.arcWeaver.run({
        sessionId,
        sourceMessageId: action.sourceMessageId,
      })
      : null;

    const dreamMeaning = this.dreamMeaningPass
      ? await this.dreamMeaningPass.run({
        sessionId,
        sourceMessageId: action.sourceMessageId,
      })
      : null;

    const coreMemoryScope = coreMemoryChannelScope({ channelId: sessionId });
    const currentSnapshot = this.coreMemoryStore.getSnapshot({ scope: coreMemoryScope });
    const transcript = recentEntries.map(summarizeSessionEntry).join('\n');
    const requestPrompt = [
      'Current orientation blocks:',
      `persona:\n${currentSnapshot.blocks.persona.content || '[empty]'}`,
      `human:\n${currentSnapshot.blocks.human.content || '[empty]'}`,
      `goals:\n${currentSnapshot.blocks.goals.content || '[empty]'}`,
      '',
      'Recent transcript:',
      transcript,
      '',
      `Return strict JSON with keys "orient" and "memory_writes" (max ${this.maxMemoryWrites}).`,
    ].join('\n');

    const response = await this.llmProvider.complete(
      {
        systemPrompt: this.resolveSleeptimePromptText(),
        messages: [{ role: 'user', content: requestPrompt }],
        correlation: {
          requestId: `sleeptime:${sessionId}:${action.id}`,
          channelId: action.channelId,
          callType: 'memory',
          purpose: 'memory.sleeptime.plan',
          originType: 'memory',
          originStage: 'memory.sleeptime.plan',
        },
      },
      'memory',
    );
    const plan = normalizeSleeptimePlan(response.content, this.maxMemoryWrites);

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
      this.coreMemoryStore.rethink({
        persona: plan.orient.persona,
        human: plan.orient.human,
        goals: plan.orient.goals,
      }, { scope: coreMemoryScope });
    }

    let writtenCount = 0;
    let reviewQueuedCount = await this.queueStaleMemoryReviews();
    for (const memory of plan.memoryWrites) {
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

      const evidenceCount = countSupportingTranscriptEntries(memory.text, recentEntries);
      const writePayload = buildSleepTimeMemoryWritePayload({
        memory,
        sessionId,
        actionId: action.id,
        sourceMessageId: action.sourceMessageId,
        evidenceCount,
      });
      try {
        const result = await this.memoryWriter.write(writePayload);
        writtenCount += 1;
        reviewQueuedCount += await this.queueConflictReviewFromWriteResult(result);
      } catch (error) {
        log.warn('Sleeptime memory write skipped after error', {
          sessionId,
          actionId: action.id,
          type: memory.type,
          error: String(error),
        });
      }
    }
    for (const writePayload of buildBehavioralSummaryWrites({
      sessionId,
      actionId: action.id,
      sourceMessageId: action.sourceMessageId,
      episodicSynthesis,
    })) {
      try {
        await this.memoryWriter.write(writePayload);
        writtenCount += 1;
      } catch (error) {
        log.warn('Sleeptime behavioral summary write skipped after error', {
          sessionId,
          actionId: action.id,
          error: String(error),
        });
      }
    }

    const memoryMaintenanceDiagnostics = await this.getMemoryMaintenanceDiagnostics();
    const episodicMaintenanceDiagnostics = await this.getEpisodicMaintenanceDiagnostics();

    log.info('Sleeptime memory run complete', {
      sessionId,
      actionId: action.id,
      sourceMessageId: action.sourceMessageId,
      transcriptEntries: recentEntries.length,
      memoryWritesRequested: plan.memoryWrites.length,
      memoryWritesSucceeded: writtenCount,
      memoryMaintenanceReviewsQueued: reviewQueuedCount,
      ...(episodicSynthesis ? summarizeEpisodicSynthesis(episodicSynthesis) : {}),
      ...(sleepConsolidation ? { sleepConsolidation } : {}),
      ...(arcFormation?.ran ? { arcFormation } : {}),
      ...(dreamMeaning?.ran ? { dreamMeaning } : {}),
      ...(memoryMaintenanceDiagnostics ? { memoryMaintenanceDiagnostics } : {}),
      ...(episodicMaintenanceDiagnostics ? { episodicMaintenanceDiagnostics } : {}),
    });
  }

  private resolveSleeptimePromptText(): string {
    return this.promptRegistry?.getPrompt(SLEEPTIME_ORIENTATION_PROMPT_KEY)
      ?? getDefaultPromptText(SLEEPTIME_ORIENTATION_PROMPT_KEY);
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

  private async queueStaleMemoryReviews(): Promise<number> {
    if (!this.memoryMaintenanceStore?.listActiveMemories || !this.memoryMaintenanceStore.upsertMemoryMaintenanceReview) {
      return 0;
    }
    const memories = await this.memoryMaintenanceStore.listActiveMemories({ limit: MAX_STALE_REVIEW_SCAN });
    let queued = 0;
    for (const memory of memories) {
      if (queued >= MAX_STALE_REVIEWS_PER_RUN) break;
      const review = await this.queueMaintenanceReview(buildStaleMemoryReviewInput(memory));
      if (review) queued += 1;
    }
    return queued;
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

  private resolveActionSessionId(action: Pick<InferredPostTurnAction, 'channelId' | 'payload'>): string {
    const payloadSession = action.payload['sessionId'];
    if (typeof payloadSession === 'string' && payloadSession.trim().length > 0) {
      return payloadSession.trim();
    }
    return this.sessionManager.resolveSessionChannelId(action.channelId);
  }

  private resolveActionLastUserActivityAtMs(action: Pick<InferredPostTurnAction, 'payload'>): number | undefined {
    const value = action.payload['lastUserActivityAtMs'];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    return undefined;
  }
}
