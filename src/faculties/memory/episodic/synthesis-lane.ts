import { createComponentLogger } from '../../../shared/logger.js';
import { formatErrorCauseChain, toErrorMessage } from '../../../shared/utils/errors.js';
import type { InferredPostTurnAction, PostTurnActionCandidate, SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { Episode, EpisodeArc } from '../../../shared/contracts/episodic-memory.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type {
  ClaimedConversationalActivityWorkItem,
  ConversationalActivityWorkItem,
  RecoverableConversationalActivityWorksetPort,
} from '../../../core/session/conversational-activity-workset.js';
import {
  isExperientialSelfDirectedSessionId,
  isTestingSessionId,
} from '../../../core/session/session-id.js';
import type { EpisodeSynthesisLaneConfig } from '../../../system/config/scheduler-config.js';
import type { MemoryWriteOptions, MemoryWriter } from '../writer.js';
import type { NearTurnMemoryScopeClassifierPort } from '../near-turn-memory-lane.js';
import { classifySessionEntryCompanionRelevance } from '../extraction/speaker-routing.js';
import {
  resolveSessionMemoryAttribution,
  type SessionCounterpartyContactStore,
  type SessionMemoryAttribution,
} from '../session-counterparty-resolution.js';
import type { EpisodicSynthesisRunResult, EpisodicSynthesizer } from './synthesis.js';
import type {
  EpisodicStorePort,
} from './store-port.js';

const log = createComponentLogger('EpisodeSynthesisLane');

export const EPISODE_SYNTHESIS_ACTION_KIND = 'memory.episode-synthesis.run';
export const EPISODE_SYNTHESIS_TIMER_TASK_ID = 'memory.episode-synthesis.timer';
const EPISODE_SYNTHESIS_DRAIN_CLAIMANT_ID = 'episode-synthesis-drain';

const EPISODIC_SYNTHESIS_PROCESSOR = 'episodic_synthesis';
const MAX_BEHAVIORAL_SUMMARY_WRITES = 1;
const BEHAVIORAL_SUMMARY_STAGE_PREFIX = 'behavioral_summary:';
const EPISODE_SYNTHESIS_FAILURE_STAGE = 'episode_synthesis';
const MINUTE_MS = 60_000;

interface BehavioralSummaryWrite {
  arc: EpisodeArc;
  payload: MemoryWriteOptions;
}

class BehavioralSummaryWriteError extends Error {
  readonly stage: string;
  readonly logicalSessionId: string;

  constructor(logicalSessionId: string, stage: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'BehavioralSummaryWriteError';
    this.logicalSessionId = logicalSessionId;
    this.stage = stage;
  }
}

/**
 * The failure bookkeeping itself failed: the session's failure could not be
 * recorded (or its exhausted claim could not be quarantined). This is the only
 * per-session condition the drain still rethrows, because without a durable
 * record nothing bounds the next attempt.
 */
class EpisodeSynthesisFailureRecordError extends AggregateError {
  readonly logicalSessionId: string;
  readonly stage: string;

  constructor(logicalSessionId: string, stage: string, errors: unknown[]) {
    super(errors, `Episode synthesis failure could not be recorded for ${logicalSessionId}`);
    this.name = 'EpisodeSynthesisFailureRecordError';
    this.logicalSessionId = logicalSessionId;
    this.stage = stage;
  }
}

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

/**
 * One durably recorded per-session failure. Content-free apart from the
 * session id (the failure text stays on the workset row): telemetry and the
 * health plane count these, and `quarantined` marks the terminal attempt.
 */
export interface EpisodeSynthesisSessionFailureEvent {
  sessionId: string;
  stage: string;
  attemptCount: number;
  maxAttempts: number;
  quarantined: boolean;
  retryAfterMs?: number;
  timestamp: number;
}

export interface EpisodeSynthesisSafeBoundary {
  logicalSessionId: string;
  revision: number;
}

export interface EpisodeSynthesisDrainOptions {
  /**
   * Called only after the companion-private workset checkpoint commits. A
   * fleet coordinator may request yielding here without exposing the private
   * session identity to the system-scoped baton store.
   */
  onSafeBoundary?: (
    boundary: EpisodeSynthesisSafeBoundary,
  ) => Promise<'continue' | 'yield'> | 'continue' | 'yield';
}

export interface EpisodeSynthesisDrainOutcome {
  outcome: 'complete' | 'yield';
  nextEligibleAtMs?: number;
}

type SynthesisLaneSessionReader = Pick<SessionManager, 'resolveSessionChannelId' | 'getRecentMessages'>
  & Partial<Pick<SessionManager, 'isSessionRetiredOrQuarantined'>>;

export interface EpisodeSynthesisLaneOptions {
  sessionManager: SynthesisLaneSessionReader;
  synthesizer: Pick<EpisodicSynthesizer, 'run'>;
  /** Read-only watermark access shared with the synthesizer's durable scope. */
  watermarkStore: Pick<EpisodicStorePort, 'getProcessingWatermark'>;
  /** Durable episode artifacts used to resume a failed derived-memory write. */
  behavioralSummaryStore?: Pick<
    EpisodicStorePort,
    'getEpisodesByIds' | 'listEpisodeArcsForEpisodes'
  > | null;
  /** Durable changed-session workset shared by all episode drain triggers. */
  workset: RecoverableConversationalActivityWorksetPort;
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
  /** Contact lookup for attributing single-counterparty behavioral summary writes. */
  contactStore?: SessionCounterpartyContactStore | null;
  /** Local companion UUID used to identify the peer participant on companion-dm sessions. */
  companionId?: string;
  /** Gate telemetry sink; wired to the runtime event bus by composition. */
  onGateEvent?: (event: EpisodeSynthesisGateEvent) => void;
  /** Recorded per-session failure sink; wired to the runtime event bus. */
  onSessionFailure?: (event: EpisodeSynthesisSessionFailureEvent) => void;
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
  attribution?: SessionMemoryAttribution;
  synthesis: EpisodicSynthesisRunResult;
}): BehavioralSummaryWrite[] {
  const arcs = input.synthesis.linkedArcs
    .filter(arc => arc.confidence >= 0.7)
    .filter(arc => arc.arcKind !== 'same_theme')
    .slice(0, MAX_BEHAVIORAL_SUMMARY_WRITES);
  const episodesById = new Map(input.synthesis.createdEpisodes.map(episode => [episode.id, episode]));
  const attribution = input.attribution;
  return arcs.map(arc => {
    const themes = arc.themes.slice(0, 3).join(', ') || 'recent continuity';
    const sourceRef = `source:episode_synthesis|session:${input.sessionId}|episode_arc:${arc.id}`;
    const sourceConversationAt = arcSourceConversationAt(arc, episodesById);
    return {
      arc,
      payload: {
        text: `Episode evidence chain shows a ${arc.arcKind.replace(/_/g, ' ')} pattern around ${themes}.`,
        type: 'reflection',
        importance: 0.62,
        confidence: Math.min(0.84, Math.max(0.7, arc.confidence)),
        emotionalValence: 0,
        sensitivity: 'personal',
        sourceRef,
        sourceType: 'autonomous_action',
        ...(attribution?.kind === 'single_contact' ? { contactId: attribution.contactId } : {}),
        provenance: {
          channelId: input.sessionId,
          sessionId: input.sessionId,
          actor: 'system',
          reason: 'episode_synthesis_behavioral_summary',
          ...(attribution?.kind === 'single_contact'
            ? {
                subjectContactId: attribution.contactId,
                subjectContactIds: [attribution.contactId],
              }
            : attribution?.kind === 'companion_private'
              ? { subjectScope: 'companion_internal' as const }
              : {}),
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
      },
    };
  });
}

function behavioralSummaryStage(arc: Pick<EpisodeArc, 'id' | 'targetEpisodeId'>): string {
  return `${BEHAVIORAL_SUMMARY_STAGE_PREFIX}${encodeURIComponent(arc.targetEpisodeId)}:${encodeURIComponent(arc.id)}`;
}

function parseBehavioralSummaryStage(stage: string | undefined): {
  targetEpisodeId: string;
  arcId: string;
} | null {
  if (!stage?.startsWith(BEHAVIORAL_SUMMARY_STAGE_PREFIX)) return null;
  const encoded = stage.slice(BEHAVIORAL_SUMMARY_STAGE_PREFIX.length).split(':');
  if (encoded.length !== 2 || !encoded[0] || !encoded[1]) return null;
  try {
    return {
      targetEpisodeId: decodeURIComponent(encoded[0]),
      arcId: decodeURIComponent(encoded[1]),
    };
  } catch {
    return null;
  }
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
 * Below the minimum the lane holds: the claim is released without a
 * checkpoint and the watermark does not advance, so the session stays eligible
 * and its turns accumulate (9 relevant now => hold; 25 total after more
 * conversation => process the whole accumulated chunk). A session that stops
 * growing below the minimum gets a final pass once its newest turn is
 * `finalPassIdleMinutes` old (d5e0p.2); one with no relevant turn at all is
 * checkpointed. Every skip emits a typed gate event with a reason.
 */
export class EpisodeSynthesisLane {
  private readonly sessionManager: SynthesisLaneSessionReader;
  private readonly synthesizer: Pick<EpisodicSynthesizer, 'run'>;
  private readonly watermarkStore: Pick<EpisodicStorePort, 'getProcessingWatermark'>;
  private readonly behavioralSummaryStore: Pick<
    EpisodicStorePort,
    'getEpisodesByIds' | 'listEpisodeArcsForEpisodes'
  > | null;
  private readonly workset: RecoverableConversationalActivityWorksetPort;
  private readonly config: EpisodeSynthesisLaneConfig;
  private readonly scopeClassifier: NearTurnMemoryScopeClassifierPort | null;
  private readonly companionNames: readonly string[];
  private readonly companionAuthorIds: readonly string[];
  private readonly memoryWriter: Pick<MemoryWriter, 'write'> | null;
  private readonly contactStore: SessionCounterpartyContactStore | null;
  private readonly companionId: string | undefined;
  private readonly onGateEvent?: (event: EpisodeSynthesisGateEvent) => void;
  private readonly onSessionFailure?: (event: EpisodeSynthesisSessionFailureEvent) => void;
  private readonly now: () => number;
  private readonly claimantId: string;
  private turnCount = 0;
  private activeDrain: Promise<EpisodeSynthesisDrainOutcome> | null = null;

  constructor(options: EpisodeSynthesisLaneOptions) {
    this.sessionManager = options.sessionManager;
    assertPositiveInteger(options.config.turnThreshold, 'turnThreshold');
    assertPositiveInteger(options.config.minRelevantTurns, 'minRelevantTurns');
    assertPositiveInteger(options.config.transcriptMessageLimit, 'transcriptMessageLimit');
    assertPositiveInteger(options.config.sessionFailure.maxAttempts, 'sessionFailure.maxAttempts');
    assertPositiveInteger(
      options.config.sessionFailure.retryBaseDelayMinutes,
      'sessionFailure.retryBaseDelayMinutes',
    );
    this.config = options.config;
    this.synthesizer = options.synthesizer;
    this.watermarkStore = options.watermarkStore;
    this.behavioralSummaryStore = options.behavioralSummaryStore ?? null;
    this.workset = options.workset;
    this.scopeClassifier = options.scopeClassifier ?? null;
    this.companionNames = options.companionNames ?? [];
    this.companionAuthorIds = options.companionAuthorIds ?? [];
    this.memoryWriter = options.memoryWriter ?? null;
    this.contactStore = options.contactStore ?? null;
    this.companionId = options.companionId?.trim() || undefined;
    this.onGateEvent = options.onGateEvent;
    this.onSessionFailure = options.onSessionFailure;
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

  async execute(
    action: Pick<InferredPostTurnAction, 'id' | 'channelId' | 'sourceMessageId' | 'payload'>,
    options: EpisodeSynthesisDrainOptions = {},
  ): Promise<EpisodeSynthesisDrainOutcome> {
    if (this.activeDrain) {
      return this.activeDrain;
    }
    let drain!: Promise<EpisodeSynthesisDrainOutcome>;
    drain = this.drain(action, options).finally(() => {
      if (this.activeDrain === drain) this.activeDrain = null;
    });
    this.activeDrain = drain;
    return drain;
  }

  private async drain(
    action: Pick<InferredPostTurnAction, 'id' | 'channelId' | 'sourceMessageId' | 'payload'>,
    options: EpisodeSynthesisDrainOptions,
  ): Promise<EpisodeSynthesisDrainOutcome> {
    const workItems = await this.workset.enumerate('episodic_synthesis');
    const failures: Error[] = [];
    let yielded = false;
    for (const workItem of workItems) {
      const ownClaim = workItem.claimantId === this.claimantId;
      if (ownClaim && workItem.retryAfterMs !== undefined && workItem.retryAfterMs > this.now()) {
        // A recorded failure holds its claim for the backoff window; other
        // sessions keep draining around it.
        log.info('Episode synthesis session is waiting out its failure backoff', {
          actionId: action.id,
          logicalSessionId: workItem.logicalSessionId,
          failureCount: workItem.failureCount ?? 0,
          retryAfterMs: workItem.retryAfterMs,
        });
        continue;
      }
      const resumedClaim = ownClaim
        ? await this.workset.resumeClaim({
            purpose: 'episodic_synthesis',
            logicalSessionId: workItem.logicalSessionId,
            claimantId: this.claimantId,
          })
        : null;
      const claim = resumedClaim ?? await this.workset.claim({
          purpose: 'episodic_synthesis',
          logicalSessionId: workItem.logicalSessionId,
          revision: workItem.revision,
          claimantId: this.claimantId,
        });
      if (!claim) continue;
      try {
        const disposition = await this.executeSession(action, claim);
        const claimInput = {
          purpose: 'episodic_synthesis' as const,
          logicalSessionId: claim.logicalSessionId,
          revision: claim.revision,
          claimantId: claim.claimantId,
        };
        // d5e0p.2: a held session keeps its unprocessed revision eligible.
        await (disposition === 'hold'
          ? this.workset.releaseClaim(claimInput)
          : this.workset.checkpoint(claimInput));
      } catch (error) {
        const bookkeepingFailure = await this.recordSessionFailure(action, claim, error);
        if (bookkeepingFailure) failures.push(bookkeepingFailure);
        continue;
      }
      const disposition = await options.onSafeBoundary?.({
        logicalSessionId: claim.logicalSessionId,
        revision: claim.revision,
      });
      if (disposition === 'yield') {
        yielded = true;
        break;
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Episode synthesis drain failed for ${failures.length} session(s)`);
    }
    return { outcome: yielded ? 'yield' : 'complete' };
  }

  /**
   * Durably record one session's failure on its workset row and bound it
   * (psfn-framework-d5e0p.3). Below the owner-file attempt cap the claim stays
   * held behind an exponential backoff; at the cap it is quarantined at its
   * claimed revision without advancing the checkpoint, so the session's
   * unprocessed source survives for newer activity or an operator release.
   *
   * A recorded failure is handled, not rethrown: rethrowing would re-run the
   * whole drain through post-turn retries and report "exhausted retries" for a
   * condition that is already bounded and visible. Only a failure to record
   * is returned for the drain to raise.
   */
  private async recordSessionFailure(
    action: Pick<InferredPostTurnAction, 'id'>,
    claim: ClaimedConversationalActivityWorkItem,
    error: unknown,
  ): Promise<Error | null> {
    const stage = this.resolveFailureStage(claim, error);
    const message = formatErrorCauseChain(error);
    const policy = this.config.sessionFailure;
    const attemptCount = (claim.failureCount ?? 0) + 1;
    const quarantined = attemptCount >= policy.maxAttempts;
    const failedAtMs = this.now();
    const retryAfterMs = quarantined
      ? undefined
      : failedAtMs + policy.retryBaseDelayMinutes * MINUTE_MS * 2 ** (attemptCount - 1);
    const claimInput = {
      purpose: 'episodic_synthesis' as const,
      logicalSessionId: claim.logicalSessionId,
      revision: claim.revision,
      claimantId: claim.claimantId,
    };
    try {
      await this.workset.recordFailure({
        ...claimInput,
        stage,
        message,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
      if (quarantined) {
        await this.workset.quarantineClaim(claimInput);
      }
    } catch (recordError) {
      log.error('Episode synthesis session failure could not be recorded', {
        actionId: action.id,
        logicalSessionId: claim.logicalSessionId,
        revision: claim.revision,
        stage,
        error: message,
        recordError: toErrorMessage(recordError),
      });
      return new EpisodeSynthesisFailureRecordError(claim.logicalSessionId, stage, [error, recordError]);
    }
    const details = {
      actionId: action.id,
      logicalSessionId: claim.logicalSessionId,
      revision: claim.revision,
      stage,
      attemptCount,
      maxAttempts: policy.maxAttempts,
      error: `${claim.logicalSessionId}/${stage}: ${message}`,
    };
    if (quarantined) {
      log.error('Episode synthesis session quarantined after exhausting its retries', details);
    } else {
      log.warn('Episode synthesis failed for session', { ...details, retryAfterMs });
    }
    this.onSessionFailure?.({
      sessionId: claim.logicalSessionId,
      stage,
      attemptCount,
      maxAttempts: policy.maxAttempts,
      quarantined,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      timestamp: failedAtMs,
    });
    return null;
  }

  /**
   * A behavioral-summary write names its own resumable stage. Any other failure
   * while a behavioral-summary stage is pending keeps that stage, so recording
   * the new failure never erases the resume pointer.
   */
  private resolveFailureStage(claim: ConversationalActivityWorkItem, error: unknown): string {
    if (error instanceof BehavioralSummaryWriteError) return error.stage;
    const pendingStage = claim.lastFailure?.stage;
    if (pendingStage && parseBehavioralSummaryStage(pendingStage)) return pendingStage;
    return EPISODE_SYNTHESIS_FAILURE_STAGE;
  }

  /**
   * Runs one claimed session. 'checkpoint' means the claimed revision is done
   * (processed, or skipped for a terminal reason); 'hold' means the session is
   * below the relevance minimum but may still grow, so it stays eligible.
   */
  private async executeSession(
    action: Pick<InferredPostTurnAction, 'id' | 'channelId' | 'sourceMessageId' | 'payload'>,
    workItem: ConversationalActivityWorkItem,
  ): Promise<'checkpoint' | 'hold'> {
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
      return 'checkpoint';
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
      return 'checkpoint';
    }

    const entries = this.sessionManager
      .getRecentMessages(sessionId, this.config.transcriptMessageLimit)
      .filter(isConversational);
    const channelId = entries[0]?.channelId ?? sessionId;

    if (await this.resumeBehavioralSummary(action, workItem, entries)) {
      log.info('Episode synthesis lane resumed its pending behavioral summary', {
        sessionId,
        actionId: action.id,
        trigger,
      });
      return 'checkpoint';
    }

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
      return 'checkpoint';
    }

    // Gate 2 (deterministic): minimum companion-relevant turn count. Below
    // the minimum the lane holds the session (claim released, revision still
    // eligible, watermark untouched) so its turns accumulate into the next
    // period. Many sessions never grow again once they end (each external
    // conversation, a short DM), so once the session has been idle for
    // finalPassIdleMinutes its remaining relevant turns get a final pass
    // instead of being held forever (d5e0p.2).
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
    const idleMs = this.now() - Math.max(...newEntries.map(entry => entry.timestamp));
    const finalPass = relevantTurnCount > 0
      && relevantTurnCount < this.config.minRelevantTurns
      && idleMs >= this.config.finalPassIdleMinutes * MINUTE_MS;
    if (relevantTurnCount < this.config.minRelevantTurns && !finalPass) {
      // No relevant turn at all is terminal for this revision (nothing to
      // episodize); a relevant but short session is held, not checkpointed.
      const disposition = relevantTurnCount === 0 ? 'checkpoint' : 'hold';
      log.warn('Episode synthesis skipped below the relevance minimum', {
        sessionId,
        actionId: action.id,
        trigger,
        newEntryCount: newEntries.length,
        relevantTurnCount,
        minRelevantTurns: this.config.minRelevantTurns,
        disposition,
        idleMinutes: Math.floor(idleMs / MINUTE_MS),
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
      return disposition;
    }

    const synthesis = await this.synthesizer.run({
      sessionId,
      sourceMessageId: action.sourceMessageId,
      ...(finalPass ? { finalPass: true } : {}),
    });
    const attribution = await resolveSessionMemoryAttribution({
      sessionId,
      activityKind: workItem.activityKind,
      entries,
      contactStore: this.contactStore,
      ...(this.companionId ? { localCompanionId: this.companionId } : {}),
      companionAuthorIds: this.companionAuthorIds,
    });
    await this.writeBehavioralSummaries({
      sessionId,
      actionId: action.id,
      sourceMessageId: action.sourceMessageId,
      attribution,
      synthesis,
    });
    if (synthesis.segmentationFailedChunkCount > 0) {
      throw new Error('Episode topic segmentation failed; unprocessed source remains retryable', {
        ...(synthesis.segmentationFailure ? { cause: new Error(synthesis.segmentationFailure) } : {}),
      });
    }
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
      finalPass,
      newEntryCount: newEntries.length,
      relevantTurnCount,
      candidateEpisodes: synthesis.candidateEpisodeCount,
      createdEpisodes: synthesis.createdEpisodes.length,
      skippedEpisodes: synthesis.skippedEpisodeIds.length,
      linkedArcs: synthesis.linkedArcs.length,
      heldBackEntries: synthesis.heldBackEntryCount,
      segmentationFailedChunks: synthesis.segmentationFailedChunkCount,
    });
    // An open trailing topic was held back unclaimed: keep the session
    // eligible so those turns are revisited (and given the idle final pass
    // if the conversation does not continue) instead of being orphaned.
    return synthesis.heldBackEntryCount > 0 ? 'hold' : 'checkpoint';
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
    attribution?: SessionMemoryAttribution;
    synthesis: EpisodicSynthesisRunResult;
  }): Promise<void> {
    if (!this.memoryWriter) return;
    for (const write of buildBehavioralSummaryWrites(input)) {
      try {
        await this.memoryWriter.write(write.payload);
      } catch (error) {
        throw new BehavioralSummaryWriteError(input.sessionId, behavioralSummaryStage(write.arc), error);
      }
    }
  }

  private async resumeBehavioralSummary(
    action: Pick<InferredPostTurnAction, 'id' | 'sourceMessageId'>,
    workItem: ConversationalActivityWorkItem,
    entries: readonly SessionEntry[] = [],
  ): Promise<boolean> {
    const completedBehavioralSummaryStage = workItem.completedStages.find(
      stage => stage.startsWith(BEHAVIORAL_SUMMARY_STAGE_PREFIX),
    );
    if (completedBehavioralSummaryStage) {
      if (!parseBehavioralSummaryStage(completedBehavioralSummaryStage)) {
        throw new Error('Episode behavioral-summary stage checkpoint is malformed');
      }
      return true;
    }
    const failedStage = workItem.lastFailure?.stage;
    const pending = parseBehavioralSummaryStage(failedStage);
    if (failedStage?.startsWith(BEHAVIORAL_SUMMARY_STAGE_PREFIX) && !pending) {
      throw new Error('Episode behavioral-summary failure checkpoint is malformed');
    }
    if (!pending) return false;
    if (!this.memoryWriter || !this.behavioralSummaryStore) {
      throw new Error('Episode behavioral-summary recovery requires its memory writer and durable episode artifact store');
    }
    const arcs = await this.behavioralSummaryStore.listEpisodeArcsForEpisodes(
      [pending.targetEpisodeId],
      { direction: 'incoming' },
    );
    const arc = arcs.find(candidate => candidate.id === pending.arcId);
    if (!arc) {
      // Dead-letter recovery (psfn-framework-eoj3s.1 / d5e0p.3): nightly sleep
      // consolidation may have merged or superseded the target episode or arc
      // while this behavioral-summary stage waited for retry. Checkpoint the
      // obsolete stage so the session's synthesis lane cannot wedge forever.
      log.warn('Skipping behavioral-summary recovery for missing or superseded arc; checkpointing stage', {
        sessionId: workItem.logicalSessionId,
        arcId: pending.arcId,
        targetEpisodeId: pending.targetEpisodeId,
        failedStage,
      });
      await this.workset.checkpointStage({
        purpose: 'episodic_synthesis',
        logicalSessionId: workItem.logicalSessionId,
        revision: workItem.revision,
        claimantId: workItem.claimantId ?? this.claimantId,
        stage: failedStage ?? `${BEHAVIORAL_SUMMARY_STAGE_PREFIX}${pending.targetEpisodeId}:${pending.arcId}`,
      });
      return true;
    }
    const episodes = await this.behavioralSummaryStore.getEpisodesByIds([
      arc.sourceEpisodeId,
      arc.targetEpisodeId,
    ]);
    if (episodes.length !== 2) {
      log.warn('Skipping behavioral-summary recovery for superseded arc endpoint; checkpointing stage', {
        sessionId: workItem.logicalSessionId,
        arcId: pending.arcId,
        sourceEpisodeId: arc.sourceEpisodeId,
        targetEpisodeId: arc.targetEpisodeId,
        resolvedCount: episodes.length,
        failedStage,
      });
      await this.workset.checkpointStage({
        purpose: 'episodic_synthesis',
        logicalSessionId: workItem.logicalSessionId,
        revision: workItem.revision,
        claimantId: workItem.claimantId ?? this.claimantId,
        stage: failedStage ?? behavioralSummaryStage(arc),
      });
      return true;
    }
    const attribution = await resolveSessionMemoryAttribution({
      sessionId: workItem.logicalSessionId,
      activityKind: workItem.activityKind,
      entries,
      contactStore: this.contactStore,
      ...(this.companionId ? { localCompanionId: this.companionId } : {}),
      companionAuthorIds: this.companionAuthorIds,
    });
    await this.writeBehavioralSummaries({
      sessionId: workItem.logicalSessionId,
      actionId: action.id,
      sourceMessageId: action.sourceMessageId,
      attribution,
      synthesis: {
        consideredEntries: 0,
        claimedEntriesSkipped: 0,
        candidateEpisodeCount: 0,
        createdEpisodes: episodes,
        skippedEpisodeIds: [],
        linkedArcs: [arc],
        heldBackEntryCount: 0,
        segmentationFailedChunkCount: 0,
      },
    });
    await this.workset.checkpointStage({
      purpose: 'episodic_synthesis',
      logicalSessionId: workItem.logicalSessionId,
      revision: workItem.revision,
      claimantId: workItem.claimantId ?? this.claimantId,
      stage: workItem.lastFailure?.stage ?? behavioralSummaryStage(arc),
    });
    return true;
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
