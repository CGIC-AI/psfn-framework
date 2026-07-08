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
import type { InferredPostTurnAction, PostTurnActionCandidate } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { SessionEntry } from '../../core/session/types.js';
import type { SessionManager } from '../../core/session/manager.js';
import {
  DEFAULT_ORIENTATION_REWRITE_GATE,
  type EpisodicProcessingRestWindowConfig,
  type OrientationRewriteGateConfig,
} from '../../system/config/scheduler-config.js';
import type { DeterministicGateEvent } from '../../shared/event-bus.js';
import {
  evaluateDeterministicGate,
  type DeterministicGateDefinition,
} from '../../shared/gating/deterministic-gate.js';
import { clampSigned, clampUnit } from '../../shared/utils/numeric.js';
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
import type { SleeptimeWikiPass } from '../wiki/sleeptime-wiki-pass.js';
import type {
  EpisodicMaintenanceDiagnostics,
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

const log = createComponentLogger('SleeptimeMemoryAgent');

export const SLEEPTIME_MEMORY_ACTION_KIND = 'memory.sleeptime.run';

const DEFAULT_IDLE_SESSION_LIMIT = 20;
const DEFAULT_TRANSCRIPT_MESSAGE_LIMIT = 24;
const DEFAULT_MAX_MEMORY_WRITES = 4;
const ORIENTATION_REWRITE_GATE_LANE = 'orientation_rewrite';
const DAY_MS = 24 * 60 * 60_000;

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
type SessionMemoryReader = Pick<SessionManager, 'resolveSessionChannelId' | 'getRecentMessages'>
  & Partial<Pick<SessionManager, 'listRecentSessions' | 'isSessionRetiredOrQuarantined'>>;
type SleeptimeMemoryWriter = Pick<MemoryWriter, 'write'>;
type SleeptimeEpisodeConsolidator = Pick<SleepCycleEpisodeConsolidator, 'run'>;
type SleeptimeArcWeaver = Pick<EpisodeArcWeaver, 'run'>;
type SleeptimeDreamMeaningPass = Pick<DreamMeaningPass, 'run'>;
type SleeptimeWikiPassRunner = Pick<SleeptimeWikiPass, 'run'>;
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
  now?: () => number;
  sleepConsolidator?: SleeptimeEpisodeConsolidator | null;
  arcWeaver?: SleeptimeArcWeaver | null;
  dreamMeaningPass?: SleeptimeDreamMeaningPass | null;
  /**
   * Sleeptime wiki update pass (E8.2). Runs AFTER episodes/memories settle
   * (after consolidation/arcs/dream) with its own deterministic gate and
   * watermark; independent of the orient rewrite gate.
   */
  sleeptimeWikiPass?: SleeptimeWikiPassRunner | null;
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

export class SleeptimeMemoryAgent {
  private readonly llmProvider: LLMProviderPort;
  private readonly sessionManager: SessionMemoryReader;
  private readonly coreMemoryStore: CoreMemoryRewriter;
  private readonly memoryWriter: SleeptimeMemoryWriter;
  private readonly promptRegistry: PromptRegistryStatePort | null;
  private readonly transcriptMessageLimit: number;
  private readonly maxMemoryWrites: number;
  private readonly restWindow: EpisodicProcessingRestWindowConfig;
  private readonly orientationRewriteGate: DeterministicGateDefinition;
  private readonly onGateEvent: ((event: DeterministicGateEvent) => void) | null;
  private readonly now: () => number;
  private readonly sleepConsolidator: SleeptimeEpisodeConsolidator | null;
  private readonly arcWeaver: SleeptimeArcWeaver | null;
  private readonly dreamMeaningPass: SleeptimeDreamMeaningPass | null;
  private readonly sleeptimeWikiPass: SleeptimeWikiPassRunner | null;
  private readonly memoryMaintenanceStore: SleeptimeMaintenanceStore | null;
  private readonly episodicDiagnosticsStore: SleeptimeEpisodicDiagnosticsStore | null;

  constructor(options: SleeptimeMemoryAgentOptions) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard for JS callers
    if (!options.restWindow) {
      throw new Error(
        'SleeptimeMemoryAgent requires a rest-window config (scheduler.json episodicProcessing); '
        + 'sleeptime is scheduler-owned nightly work and must not run from turn cadence',
      );
    }
    this.llmProvider = options.llmProvider;
    this.sessionManager = options.sessionManager;
    this.coreMemoryStore = options.coreMemoryStore;
    this.memoryWriter = options.memoryWriter;
    this.promptRegistry = options.promptRegistry ?? null;
    this.transcriptMessageLimit = normalizePositiveInteger(
      options.transcriptMessageLimit,
      DEFAULT_TRANSCRIPT_MESSAGE_LIMIT,
    );
    this.maxMemoryWrites = normalizePositiveInteger(
      options.maxMemoryWrites,
      DEFAULT_MAX_MEMORY_WRITES,
    );
    this.restWindow = options.restWindow;
    this.orientationRewriteGate = buildOrientationRewriteGate(
      options.orientationRewriteGate ?? DEFAULT_ORIENTATION_REWRITE_GATE,
    );
    this.onGateEvent = options.onGateEvent ?? null;
    this.now = options.now ?? (() => Date.now());
    this.sleepConsolidator = options.sleepConsolidator ?? null;
    this.arcWeaver = options.arcWeaver ?? null;
    this.dreamMeaningPass = options.dreamMeaningPass ?? null;
    this.sleeptimeWikiPass = options.sleeptimeWikiPass ?? null;
    this.memoryMaintenanceStore = options.memoryMaintenanceStore ?? null;
    this.episodicDiagnosticsStore = options.episodicDiagnosticsStore ?? null;
  }

  /**
   * Rest-window inference is the ONLY trigger surface for sleeptime work. The
   * scheduler polls this on an interval; turn cadence has no code path here.
   */
  inferIdlePostTurnActions(options: {
    nowMs?: number;
    limit?: number;
  } = {}): PostTurnActionCandidate[] {
    if (!this.sessionManager.listRecentSessions) {
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
	    const restWindowDecision = evaluateRestWindowEligibility({
      config: this.restWindow,
      lastUserActivityAtMs: this.resolveActionLastUserActivityAtMs(action),
    });
    if (!restWindowDecision.allowed) {
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

    // Sleeptime wiki update pass (E8.2): runs here, AFTER episodes/memories
    // settle, with its OWN deterministic gate + watermark. It is independent of
    // the orient-rewrite gate below, so quiet-orientation nights that still
    // produced wiki-shaped world knowledge are not skipped.
    const wikiPass = this.sleeptimeWikiPass
      ? await this.sleeptimeWikiPass.run({
        sessionId,
        sourceMessageId: action.sourceMessageId,
      })
      : null;

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
    let reviewQueuedCount = 0;
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
      ...(sleepConsolidation ? { sleepConsolidation } : {}),
      ...(arcFormation?.ran ? { arcFormation } : {}),
      ...(dreamMeaning?.ran ? { dreamMeaning } : {}),
      ...(wikiPass?.ran ? { wikiPass } : {}),
      ...(memoryMaintenanceDiagnostics ? { memoryMaintenanceDiagnostics } : {}),
      ...(episodicMaintenanceDiagnostics ? { episodicMaintenanceDiagnostics } : {}),
    });
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
