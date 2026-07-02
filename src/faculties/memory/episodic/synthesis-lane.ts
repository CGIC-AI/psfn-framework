import { createComponentLogger } from '../../../shared/logger.js';
import type { InferredPostTurnAction, PostTurnActionCandidate, SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { EpisodeSynthesisLaneConfig } from '../../../system/config/scheduler-config.js';
import type { MemoryWriteOptions, MemoryWriter } from '../writer.js';
import type { NearTurnMemoryScopeClassifierPort } from '../near-turn-memory-lane.js';
import { classifySessionEntryCompanionRelevance } from '../extraction/speaker-routing.js';
import type { EpisodicSynthesisRunResult, EpisodicSynthesizer } from './synthesis.js';
import type { EpisodicStorePort } from './store.js';

const log = createComponentLogger('EpisodeSynthesisLane');

export const EPISODE_SYNTHESIS_ACTION_KIND = 'memory.episode-synthesis.run';
export const EPISODE_SYNTHESIS_TIMER_TASK_ID = 'memory.episode-synthesis.timer';

const EPISODIC_SYNTHESIS_PROCESSOR = 'episodic_synthesis';
const DEFAULT_TIMER_SESSION_LIMIT = 20;
const MAX_BEHAVIORAL_SUMMARY_WRITES = 1;

export type EpisodeSynthesisTrigger = 'timer' | 'turn_threshold';
export type EpisodeSynthesisSkipReason =
  | 'no_new_messages'
  | 'below_relevance_minimum'
  | 'session_retired';

/**
 * Typed gate outcome. Every skip carries a reason so the Garden
 * subsystem-health view can display why the lane did or did not process.
 */
export interface EpisodeSynthesisGateEvent {
  sessionId: string;
  channelId: string;
  trigger: EpisodeSynthesisTrigger;
  outcome: 'processed' | 'skipped';
  reason?: EpisodeSynthesisSkipReason;
  newEntryCount: number;
  relevantTurnCount: number;
  minRelevantTurns: number;
  timestamp: number;
}

type SynthesisLaneSessionReader = Pick<SessionManager, 'resolveSessionChannelId' | 'getRecentMessages'>
  & Partial<Pick<SessionManager, 'listRecentSessions' | 'isSessionRetiredOrQuarantined'>>;

export interface EpisodeSynthesisLaneOptions {
  sessionManager: SynthesisLaneSessionReader;
  synthesizer: Pick<EpisodicSynthesizer, 'run'>;
  /** Read-only watermark access shared with the synthesizer's durable scope. */
  watermarkStore: Pick<EpisodicStorePort, 'getProcessingWatermark'>;
  /** JSON-owned gate config (scheduler.json `episodeSynthesis`). Required. */
  config: EpisodeSynthesisLaneConfig;
  /** Canonical direct-vs-group scope classification; absent => direct scope. */
  scopeClassifier?: NearTurnMemoryScopeClassifierPort | null;
  /** Companion aliases for deterministic relevance classification. */
  companionNames?: readonly string[];
  /** Companion author ids (e.g. Discord bot id) for mention detection. */
  companionAuthorIds?: readonly string[];
  /** Deterministic behavioral-summary writes derived from synthesis arcs. */
  memoryWriter?: Pick<MemoryWriter, 'write'> | null;
  /** Gate telemetry sink; wired to the runtime event bus by composition. */
  onGateEvent?: (event: EpisodeSynthesisGateEvent) => void;
  now?: () => number;
}

function assertPositiveInteger(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`EpisodeSynthesisLane config.${field} must be an integer >= 1`);
  }
  return value;
}

function isConversational(entry: SessionEntry): boolean {
  return (entry.role === 'user' || entry.role === 'assistant')
    && entry.content.replace(/\s+/g, ' ').trim().length > 0;
}

function buildBehavioralSummaryWrites(input: {
  sessionId: string;
  actionId: string;
  sourceMessageId?: string;
  synthesis: EpisodicSynthesisRunResult;
}): MemoryWriteOptions[] {
  const arcs = input.synthesis.linkedArcs
    .filter(arc => arc.confidence >= 0.7)
    .filter(arc => arc.arcKind !== 'same_theme')
    .slice(0, MAX_BEHAVIORAL_SUMMARY_WRITES);
  return arcs.map(arc => {
    const themes = arc.themes.slice(0, 3).join(', ') || 'recent continuity';
    const sourceRef = `source:episode_synthesis|session:${input.sessionId}|episode_arc:${arc.id}`;
    return {
      text: `Episode evidence chain shows a ${arc.arcKind.replace(/_/g, ' ')} pattern around ${themes}.`,
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
        reason: 'episode_synthesis_behavioral_summary',
      },
      provenanceRefs: [
        sourceRef,
        `l01_episode_arc:${arc.id}`,
        `l01_episode:${arc.sourceEpisodeId}`,
        `l01_episode:${arc.targetEpisodeId}`,
        `episode_synthesis_action:${input.actionId}`,
        ...(input.sourceMessageId ? [`source_message:${input.sourceMessageId}`] : []),
      ],
      tags: [
        'episode_synthesis',
        'behavioral_summary',
        'evidence_chain',
        `episode_arc:${arc.arcKind}`,
      ],
      scopeRef: {
        kind: 'conversation',
        id: input.sessionId,
        label: 'episode synthesis source session',
      },
      scopeTags: [`channel:${input.sessionId}`, 'episode_synthesis'],
    };
  });
}

/**
 * Candidate-episode synthesis lane with a deterministic trigger gate (E5.3).
 *
 * Trigger: the scheduler timer OR a per-session turn threshold, whichever
 * comes first (both JSON-owned). The gate then runs two deterministic checks
 * with zero LLM spend when closed:
 *
 * 1. Gate 1 — new messages since the durable processing watermark. No new
 *    messages => no-op.
 * 2. Gate 2 — minimum companion-relevant turn count. Relevance reuses the
 *    group-chat addressing/mention/attribution detection
 *    (classifySessionEntryCompanionRelevance); async group traffic between
 *    other members does not count.
 *
 * Below the minimum the lane holds: because synthesis never ran, the
 * watermark does not advance, so unprocessed turns accumulate into the next
 * period (9 relevant now => hold; 25 total next period => process the whole
 * accumulated chunk). Every skip emits a typed gate event with a reason.
 */
export class EpisodeSynthesisLane {
  private readonly sessionManager: SynthesisLaneSessionReader;
  private readonly synthesizer: Pick<EpisodicSynthesizer, 'run'>;
  private readonly watermarkStore: Pick<EpisodicStorePort, 'getProcessingWatermark'>;
  private readonly config: EpisodeSynthesisLaneConfig;
  private readonly scopeClassifier: NearTurnMemoryScopeClassifierPort | null;
  private readonly companionNames: readonly string[];
  private readonly companionAuthorIds: readonly string[];
  private readonly memoryWriter: Pick<MemoryWriter, 'write'> | null;
  private readonly onGateEvent?: (event: EpisodeSynthesisGateEvent) => void;
  private readonly now: () => number;
  private readonly turnCountBySession = new Map<string, number>();

  constructor(options: EpisodeSynthesisLaneOptions) {
    this.sessionManager = options.sessionManager;
    assertPositiveInteger(options.config.timerIntervalMinutes, 'timerIntervalMinutes');
    assertPositiveInteger(options.config.turnThreshold, 'turnThreshold');
    assertPositiveInteger(options.config.minRelevantTurns, 'minRelevantTurns');
    assertPositiveInteger(options.config.transcriptMessageLimit, 'transcriptMessageLimit');
    this.config = options.config;
    this.synthesizer = options.synthesizer;
    this.watermarkStore = options.watermarkStore;
    this.scopeClassifier = options.scopeClassifier ?? null;
    this.companionNames = options.companionNames ?? [];
    this.companionAuthorIds = options.companionAuthorIds ?? [];
    this.memoryWriter = options.memoryWriter ?? null;
    this.onGateEvent = options.onGateEvent;
    this.now = options.now ?? (() => Date.now());
  }

  get timerIntervalMs(): number {
    return this.config.timerIntervalMinutes * 60_000;
  }

  /**
   * Turn-threshold trigger: counts turns per session and forces a gate
   * evaluation once `turnThreshold` turns accumulate before the timer fires.
   * Deterministic and free — the gate itself decides whether anything runs.
   */
  noteTurn(
    message: Pick<SubstrateMessage, 'id' | 'channelId'>
      & Partial<Pick<SubstrateMessage, 'channelType'>>,
  ): PostTurnActionCandidate | null {
    if (message.channelId.startsWith('internal:')) {
      return null;
    }
    const sessionId = this.sessionManager.resolveSessionChannelId(message.channelId);
    if (this.sessionManager.isSessionRetiredOrQuarantined?.(sessionId)) return null;
    const nextCount = (this.turnCountBySession.get(sessionId) ?? 0) + 1;
    if (nextCount < this.config.turnThreshold) {
      this.turnCountBySession.set(sessionId, nextCount);
      return null;
    }
    this.turnCountBySession.set(sessionId, 0);
    return this.buildActionCandidate(sessionId, message.channelId, 'turn_threshold', message.channelType);
  }

  /**
   * Timer trigger: evaluated by the scheduler task on `timerIntervalMinutes`.
   * Emits one gate-evaluation action per recent session; the deterministic
   * gates inside `execute` decide whether synthesis actually runs.
   */
  inferTimerActions(options: { limit?: number } = {}): PostTurnActionCandidate[] {
    if (!this.sessionManager.listRecentSessions) {
      return [];
    }
    const limit = options.limit ?? DEFAULT_TIMER_SESSION_LIMIT;
    const actions: PostTurnActionCandidate[] = [];
    for (const session of this.sessionManager.listRecentSessions(limit)) {
      const sessionId = this.sessionManager.resolveSessionChannelId(session.channelId);
      if (sessionId.startsWith('internal:')) continue;
      if (this.sessionManager.isSessionRetiredOrQuarantined?.(sessionId)) continue;
      const channelType = 'channelType' in session
        ? (session as { channelType?: SubstrateMessage['channelType'] }).channelType
        : undefined;
      actions.push(this.buildActionCandidate(sessionId, session.channelId, 'timer', channelType));
      this.turnCountBySession.set(sessionId, 0);
    }
    return actions;
  }

  async execute(action: Pick<InferredPostTurnAction, 'id' | 'channelId' | 'sourceMessageId' | 'payload'>): Promise<void> {
    const sessionId = this.resolveActionSessionId(action);
    const trigger = this.resolveActionTrigger(action);

    if (this.sessionManager.isSessionRetiredOrQuarantined?.(sessionId)) {
      this.emitGateEvent({
        sessionId,
        channelId: sessionId,
        trigger,
        outcome: 'skipped',
        reason: 'session_retired',
        newEntryCount: 0,
        relevantTurnCount: 0,
      });
      return;
    }

    const entries = this.sessionManager
      .getRecentMessages(sessionId, this.config.transcriptMessageLimit)
      .filter(isConversational);
    const channelId = entries[0]?.channelId ?? sessionId;

    // Gate 1 (free, deterministic): any new messages since the durable
    // synthesis watermark? Scope construction mirrors EpisodicSynthesizer.
    const watermark = await this.watermarkStore.getProcessingWatermark({
      processor: EPISODIC_SYNTHESIS_PROCESSOR,
      sourceRef: sessionId,
      channelId,
      threadId: sessionId,
      sessionId,
    });
    const processedEndedAtMs = watermark?.processedEndedAt
      ? Date.parse(watermark.processedEndedAt)
      : Number.NaN;
    const newEntries = Number.isFinite(processedEndedAtMs)
      ? entries.filter(entry => entry.timestamp > processedEndedAtMs)
      : entries;
    if (newEntries.length === 0) {
      this.emitGateEvent({
        sessionId,
        channelId,
        trigger,
        outcome: 'skipped',
        reason: 'no_new_messages',
        newEntryCount: 0,
        relevantTurnCount: 0,
      });
      return;
    }

    // Gate 2 (deterministic): minimum companion-relevant turn count. Below
    // the minimum the lane holds; the watermark does not advance, so the
    // unprocessed turns accumulate into the next period.
    const scope = await this.resolveMemoryScope(channelId, this.resolveActionChannelType(action));
    const relevantTurnCount = scope === 'direct'
      ? newEntries.length
      : newEntries.filter(entry => (
        classifySessionEntryCompanionRelevance(entry, {
          companionNames: this.companionNames,
          companionAuthorIds: this.companionAuthorIds,
        }) !== 'not_relevant'
      )).length;
    if (relevantTurnCount < this.config.minRelevantTurns) {
      this.emitGateEvent({
        sessionId,
        channelId,
        trigger,
        outcome: 'skipped',
        reason: 'below_relevance_minimum',
        newEntryCount: newEntries.length,
        relevantTurnCount,
      });
      return;
    }

    const synthesis = await this.synthesizer.run({
      sessionId,
      sourceMessageId: action.sourceMessageId,
    });
    await this.writeBehavioralSummaries({
      sessionId,
      actionId: action.id,
      sourceMessageId: action.sourceMessageId,
      synthesis,
    });
    this.emitGateEvent({
      sessionId,
      channelId,
      trigger,
      outcome: 'processed',
      newEntryCount: newEntries.length,
      relevantTurnCount,
    });
    log.info('Episode synthesis lane processed accumulated chunk', {
      sessionId,
      actionId: action.id,
      trigger,
      newEntryCount: newEntries.length,
      relevantTurnCount,
      candidateEpisodes: synthesis.candidateEpisodeCount,
      createdEpisodes: synthesis.createdEpisodes.length,
      skippedEpisodes: synthesis.skippedEpisodeIds.length,
      linkedArcs: synthesis.linkedArcs.length,
      heldBackEntries: synthesis.heldBackEntryCount,
      segmentationFailedChunks: synthesis.segmentationFailedChunkCount,
    });
  }

  private buildActionCandidate(
    sessionId: string,
    sourceChannelId: string,
    trigger: EpisodeSynthesisTrigger,
    channelType: SubstrateMessage['channelType'] | undefined,
  ): PostTurnActionCandidate {
    return {
      kind: EPISODE_SYNTHESIS_ACTION_KIND,
      payload: {
        sessionId,
        sourceChannelId,
        trigger,
        ...(channelType ? { channelType } : {}),
      },
      dedupeKey: `${EPISODE_SYNTHESIS_ACTION_KIND}:${sessionId}`,
      maxRetries: 1,
    };
  }

  /**
   * Direct-vs-group via the injected canonical group-memory classifier.
   * Without a classifier (or channelType) the historical direct posture
   * applies; classification failures degrade to 'group' — the conservative
   * direction for background compute (the relevance minimum still gates).
   */
  private async resolveMemoryScope(
    channelId: string,
    channelType: SubstrateMessage['channelType'] | undefined,
  ): Promise<'direct' | 'group'> {
    if (!this.scopeClassifier || !channelType) {
      return 'direct';
    }
    try {
      return await this.scopeClassifier.classifyChannelMemoryScope({ channelId, channelType });
    } catch (error) {
      log.warn('Episode-synthesis scope classification failed; gating as group scope', {
        channelId,
        channelType,
        error: String(error),
      });
      return 'group';
    }
  }

  private async writeBehavioralSummaries(input: {
    sessionId: string;
    actionId: string;
    sourceMessageId?: string;
    synthesis: EpisodicSynthesisRunResult;
  }): Promise<void> {
    if (!this.memoryWriter) return;
    for (const writePayload of buildBehavioralSummaryWrites(input)) {
      try {
        await this.memoryWriter.write(writePayload);
      } catch (error) {
        log.warn('Episode-synthesis behavioral summary write skipped after error', {
          sessionId: input.sessionId,
          actionId: input.actionId,
          error: String(error),
        });
      }
    }
  }

  private emitGateEvent(event: Omit<EpisodeSynthesisGateEvent, 'timestamp' | 'minRelevantTurns'>): void {
    if (!this.onGateEvent) return;
    this.onGateEvent({
      ...event,
      minRelevantTurns: this.config.minRelevantTurns,
      timestamp: this.now(),
    });
  }

  private resolveActionSessionId(action: Pick<InferredPostTurnAction, 'channelId' | 'payload'>): string {
    const payloadSession = action.payload['sessionId'];
    if (typeof payloadSession === 'string' && payloadSession.trim().length > 0) {
      return payloadSession.trim();
    }
    return this.sessionManager.resolveSessionChannelId(action.channelId);
  }

  private resolveActionTrigger(action: Pick<InferredPostTurnAction, 'payload'>): EpisodeSynthesisTrigger {
    return action.payload['trigger'] === 'timer' ? 'timer' : 'turn_threshold';
  }

  private resolveActionChannelType(
    action: Pick<InferredPostTurnAction, 'payload'>,
  ): SubstrateMessage['channelType'] | undefined {
    const value = action.payload['channelType'];
    return typeof value === 'string' && value.trim().length > 0
      ? value as SubstrateMessage['channelType']
      : undefined;
  }
}
