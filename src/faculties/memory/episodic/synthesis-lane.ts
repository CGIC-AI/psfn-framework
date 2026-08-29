import { createComponentLogger } from '../../../shared/logger.js';
import type { InferredPostTurnAction, PostTurnActionCandidate, SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { Episode, EpisodeArc } from '../../../shared/contracts/episodic-memory.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type {
  ConversationalActivityWorkItem,
  ConversationalActivityWorksetPort,
} from '../../../core/session/conversational-activity-workset.js';
import {
  isExperientialSelfDirectedSessionId,
  isTestingSessionId,
} from '../../../core/session/session-id.js';
import type { EpisodeSynthesisLaneConfig } from '../../../system/config/scheduler-config.js';
import type { MemoryWriteOptions, MemoryWriter } from '../writer.js';
import type { NearTurnMemoryScopeClassifierPort } from '../near-turn-memory-lane.js';
import { classifySessionEntryCompanionRelevance } from '../extraction/speaker-routing.js';
import type { EpisodicSynthesisRunResult, EpisodicSynthesizer } from './synthesis.js';
import type {
  EpisodicStorePort,
} from './store-port.js';

const log = createComponentLogger('EpisodeSynthesisLane');

export const EPISODE_SYNTHESIS_ACTION_KIND = 'memory.episode-synthesis.run';
export const EPISODE_SYNTHESIS_TIMER_TASK_ID = 'memory.episode-synthesis.timer';
export const EPISODE_SYNTHESIS_DRAIN_CLAIMANT_ID = 'episode-synthesis-drain';

const EPISODIC_SYNTHESIS_PROCESSOR = 'episodic_synthesis';
const MAX_BEHAVIORAL_SUMMARY_WRITES = 1;

export type EpisodeSynthesisTrigger = 'timer' | 'turn_threshold';
export type EpisodeSynthesisSkipReason =
  | 'no_new_messages'
  | 'below_relevance_minimum'
  | 'session_retired'
  | 'testing_session';

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
  & Partial<Pick<SessionManager, 'isSessionRetiredOrQuarantined'>>;

export interface EpisodeSynthesisLaneOptions {
  sessionManager: SynthesisLaneSessionReader;
  synthesizer: Pick<EpisodicSynthesizer, 'run'>;
  /** Read-only watermark access shared with the synthesizer's durable scope. */
  watermarkStore: Pick<EpisodicStorePort, 'getProcessingWatermark'>;
  /** Durable changed-session workset shared by all episode drain triggers. */
  workset: ConversationalActivityWorksetPort;
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
  /** Stable across restart so an interrupted session claim can be reclaimed. */
  claimantId?: string;
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

/**
 * Conversation-time bound for an arc-derived behavioral summary (ca980): the
 * latest source-content end instant across the arc's endpoint episodes, resolved
 * from this run's `createdEpisodes`. An arc's target episode is always one just
 * created this run (synthesis links each new canonical episode to a prior one),
 * so the target's `endedAt` — the newest source content the summary is about — is
 * always resolvable; the older source endpoint is folded in when it too was
 * created this run. This is the episode-granularity analogue of the extractor's
 * latest source-message instant: it never post-dates the arc's newest content, so
 * a demotion after it is not counted and pre-demotion content is denied to a
 * since-widened room. Absent/unparseable ⇒ undefined, and the disclosure
 * collector fails closed rather than coercing to the run clock.
 */
function arcSourceConversationAt(
  arc: EpisodeArc,
  episodesById: ReadonlyMap<string, Episode>,
): number | undefined {
  let latest: number | undefined;
  for (const episodeId of [arc.targetEpisodeId, arc.sourceEpisodeId]) {
    const endedAt = episodesById.get(episodeId)?.endedAt;
    if (endedAt === undefined) continue;
    const ms = Date.parse(endedAt);
    if (Number.isFinite(ms) && ms > 0 && (latest === undefined || ms > latest)) {
      latest = ms;
    }
  }
  return latest;
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
  const episodesById = new Map(input.synthesis.createdEpisodes.map(episode => [episode.id, episode]));
  return arcs.map(arc => {
    const themes = arc.themes.slice(0, 3).join(', ') || 'recent continuity';
    const sourceRef = `source:episode_synthesis|session:${input.sessionId}|episode_arc:${arc.id}`;
    const sourceConversationAt = arcSourceConversationAt(arc, episodesById);
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
        ...(sourceConversationAt !== undefined ? { sourceConversationAt } : {}),
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
 * Explicit daytime scheduler slots and a companion-level turn threshold both
 * request the same action. One drain snapshots the durable changed-session
 * workset, processes its claims sequentially, and checkpoints only successful
 * evaluations. Each claimed session then runs two deterministic checks with
 * zero LLM spend when closed:
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
 * changed revision (9 relevant now => hold; 25 total after more conversation
 * => process the whole accumulated chunk). Every skip emits a typed gate event
 * with a reason.
 */
export class EpisodeSynthesisLane {
  private readonly sessionManager: SynthesisLaneSessionReader;
  private readonly synthesizer: Pick<EpisodicSynthesizer, 'run'>;
  private readonly watermarkStore: Pick<EpisodicStorePort, 'getProcessingWatermark'>;
  private readonly workset: ConversationalActivityWorksetPort;
  private readonly config: EpisodeSynthesisLaneConfig;
  private readonly scopeClassifier: NearTurnMemoryScopeClassifierPort | null;
  private readonly companionNames: readonly string[];
  private readonly companionAuthorIds: readonly string[];
  private readonly memoryWriter: Pick<MemoryWriter, 'write'> | null;
  private readonly onGateEvent?: (event: EpisodeSynthesisGateEvent) => void;
  private readonly now: () => number;
  private readonly claimantId: string;
  private turnCount = 0;
  private activeDrain: Promise<void> | null = null;

  constructor(options: EpisodeSynthesisLaneOptions) {
    this.sessionManager = options.sessionManager;
    assertPositiveInteger(options.config.turnThreshold, 'turnThreshold');
    assertPositiveInteger(options.config.minRelevantTurns, 'minRelevantTurns');
    assertPositiveInteger(options.config.transcriptMessageLimit, 'transcriptMessageLimit');
    this.config = options.config;
    this.synthesizer = options.synthesizer;
    this.watermarkStore = options.watermarkStore;
    this.workset = options.workset;
    this.scopeClassifier = options.scopeClassifier ?? null;
    this.companionNames = options.companionNames ?? [];
    this.companionAuthorIds = options.companionAuthorIds ?? [];
    this.memoryWriter = options.memoryWriter ?? null;
    this.onGateEvent = options.onGateEvent;
    this.now = options.now ?? (() => Date.now());
    this.claimantId = options.claimantId?.trim() || EPISODE_SYNTHESIS_DRAIN_CLAIMANT_ID;
  }

  /**
   * Turn-threshold trigger: counts companion-level conversational turns and
   * requests one shared drain once `turnThreshold` turns accumulate before the
   * next daytime slot. The durable workset decides which sessions need work.
   */
  noteTurn(
    message: Pick<SubstrateMessage, 'id' | 'channelId'>
      & Partial<Pick<SubstrateMessage, 'channelType'>>,
  ): PostTurnActionCandidate | null {
    if (
      message.channelId.startsWith('internal:')
      && !isExperientialSelfDirectedSessionId(message.channelId)
    ) {
      return null;
    }
    const sessionId = this.sessionManager.resolveSessionChannelId(message.channelId);
    if (isTestingSessionId(sessionId)) return null;
    if (this.sessionManager.isSessionRetiredOrQuarantined?.(sessionId)) return null;
    const nextCount = this.turnCount + 1;
    if (nextCount < this.config.turnThreshold) {
      this.turnCount = nextCount;
      return null;
    }
    this.turnCount = 0;
    return this.buildActionCandidate('turn_threshold', message.channelId, message.channelType);
  }

  /**
   * Daytime slot trigger. Every slot adds one companion-level drain demand;
   * it never fans out into per-session queued actions.
   */
  inferTimerAction(): PostTurnActionCandidate {
    this.turnCount = 0;
    return this.buildActionCandidate('timer');
  }

  async execute(action: Pick<InferredPostTurnAction, 'id' | 'channelId' | 'sourceMessageId' | 'payload'>): Promise<void> {
    if (this.activeDrain) {
      return this.activeDrain;
    }
    let drain!: Promise<void>;
    drain = this.drain(action).finally(() => {
      if (this.activeDrain === drain) this.activeDrain = null;
    });
    this.activeDrain = drain;
    return drain;
  }

  private async drain(
    action: Pick<InferredPostTurnAction, 'id' | 'channelId' | 'sourceMessageId' | 'payload'>,
  ): Promise<void> {
    const workItems = await this.workset.enumerate('episodic_synthesis');
    const failures: Error[] = [];
    for (const workItem of workItems) {
      const claim = await this.workset.claim({
        purpose: 'episodic_synthesis',
        logicalSessionId: workItem.logicalSessionId,
        revision: workItem.revision,
        claimantId: this.claimantId,
      });
      if (!claim) continue;
      try {
        await this.executeSession(action, workItem);
        await this.workset.checkpoint({
          purpose: 'episodic_synthesis',
          logicalSessionId: claim.logicalSessionId,
          revision: claim.revision,
          claimantId: claim.claimantId,
        });
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Episode synthesis drain failed for ${failures.length} session(s)`);
    }
  }

  private async executeSession(
    action: Pick<InferredPostTurnAction, 'id' | 'channelId' | 'sourceMessageId' | 'payload'>,
    workItem: ConversationalActivityWorkItem,
  ): Promise<void> {
    const sessionId = workItem.logicalSessionId;
    const trigger = this.resolveActionTrigger(action);

    if (isTestingSessionId(sessionId)) {
      log.warn('Episode synthesis skipped for testing session', {
        sessionId,
        actionId: action.id,
        trigger,
      });
      this.emitGateEvent({
        sessionId,
        channelId: sessionId,
        trigger,
        outcome: 'skipped',
        reason: 'testing_session',
        newEntryCount: 0,
        relevantTurnCount: 0,
      });
      return;
    }

    if (this.sessionManager.isSessionRetiredOrQuarantined?.(sessionId)) {
      log.warn('Episode synthesis skipped for retired or quarantined session', {
        sessionId,
        actionId: action.id,
        trigger,
      });
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
    const watermarkIsFutureDated = Number.isFinite(processedEndedAtMs)
      && processedEndedAtMs > this.now();
    if (watermarkIsFutureDated) {
      log.warn('Episode synthesis watermark is ahead of the runtime clock; evaluating all retained entries', {
        sessionId,
        channelId,
        processedEndedAt: watermark?.processedEndedAt,
      });
    }
    const newEntries = Number.isFinite(processedEndedAtMs) && !watermarkIsFutureDated
      ? entries.filter(entry => entry.timestamp > processedEndedAtMs)
      : entries;
    if (newEntries.length === 0) {
      log.warn('Episode synthesis skipped because there are no new messages after the watermark', {
        sessionId,
        actionId: action.id,
        trigger,
        processedEndedAt: watermark?.processedEndedAt,
      });
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
    const scope = await this.resolveMemoryScope(
      channelId,
      this.resolveActionChannelType(action),
      workItem.activityKind,
    );
    const relevantTurnCount = scope === 'direct'
      ? newEntries.length
      : newEntries.filter(entry => (
        classifySessionEntryCompanionRelevance(entry, {
          companionNames: this.companionNames,
          companionAuthorIds: this.companionAuthorIds,
        }) !== 'not_relevant'
      )).length;
    if (relevantTurnCount < this.config.minRelevantTurns) {
      log.warn('Episode synthesis skipped below the relevance minimum', {
        sessionId,
        actionId: action.id,
        trigger,
        newEntryCount: newEntries.length,
        relevantTurnCount,
        minRelevantTurns: this.config.minRelevantTurns,
      });
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
    trigger: EpisodeSynthesisTrigger,
    sourceChannelId?: string,
    channelType?: SubstrateMessage['channelType'],
  ): PostTurnActionCandidate {
    return {
      kind: EPISODE_SYNTHESIS_ACTION_KIND,
      payload: {
        trigger,
        ...(sourceChannelId ? { sourceChannelId } : {}),
        ...(channelType ? { channelType } : {}),
      },
      dedupeKey: `${EPISODE_SYNTHESIS_ACTION_KIND}:drain`,
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
    activityKind: ConversationalActivityWorkItem['activityKind'],
  ): Promise<'direct' | 'group'> {
    if (activityKind === 'group_conversation') {
      return 'group';
    }
    if (activityKind === 'direct_message' || activityKind === 'inter_companion') {
      return 'direct';
    }
    if (isExperientialSelfDirectedSessionId(channelId)) {
      return 'direct';
    }
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
