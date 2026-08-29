// ── Admin Subsystem Health Service ──
// Aggregates the health of background lanes (memory near-turn, episode
// synthesis, active-context refresh, extraction, retrieval, social-graph) from
// the live event bus, plus scheduler-owned lane state (rest-window, timers,
// temporal wake-ups, reflections) read directly from the scheduler.
//
// Charter rules honoured here:
//   - Garden reflects REAL runtime state. Event-derived lanes are fed by an
//     in-memory ring buffer subscribed to the bus; they are honestly marked
//     `sinceProcessStart: true`. We never fabricate durable history.
//   - No fake healthy state. A lane that has never emitted since process start
//     reports status `never` ("no data since process start"). Skips carry the
//     gate reason; failures carry the error. Overdue scheduler lanes are marked
//     `stale`. Unknown stays unknown.

import type { EventBus, EventMap } from '../../../shared/event-bus.js';
import type { OperatorAlertSinkConfiguration } from '../../../shared/contracts/operator-alerting.js';
import type {
  MemorySubjectClassificationCoverage,
} from '../../../faculties/memory/memory-store-port.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import {
  BACKGROUND_WORK_HEALTH_LANES,
  BackgroundWorkHealthAccumulator,
} from './background-work-health.js';
import type {
  EpisodicProcessingWatermarkHealthSummary,
} from '../../../faculties/memory/episodic/store-port.js';
import {
  getPostgresPoolTelemetry,
  type PostgresPoolOwnerTelemetry,
} from '../../../persistence/postgres.js';
import type { PostTurnActionQueueStatus } from '../../../core/agent/post-turn-action-runtime.js';

/** Outcome of a single lane observation. */
export type SubsystemLaneOutcome = 'ran' | 'skipped' | 'degraded' | 'failed';

/** Roll-up status for a lane. */
export type SubsystemLaneStatus =
  | 'ok' // last observation ran cleanly
  | 'skipped' // last observation was a deterministic gate skip (reason attached)
  | 'degraded' // ran but degraded (e.g. served stale active-memory context)
  | 'failed' // last observation errored (error attached)
  | 'stale' // scheduler lane overdue relative to its interval
  | 'paused' // scheduler lane explicitly paused by operator
  | 'never'; // no data since process start / never run

export type SubsystemLaneSource = 'event_bus' | 'scheduler' | 'watermark' | 'post_turn_queue';

/** A single recorded lane observation (ring-buffer entry). */
export interface SubsystemLaneEvent {
  at: number;
  outcome: SubsystemLaneOutcome;
  reason?: string;
  error?: string;
  counts?: Record<string, number>;
}

export interface SubsystemLaneHealth {
  id: string;
  label: string;
  description: string;
  source: SubsystemLaneSource;
  /** True for event-bus lanes: history only spans since this process started. */
  sinceProcessStart: boolean;
  status: SubsystemLaneStatus;
  lastEventAt: number | null;
  lastOutcome: SubsystemLaneOutcome | null;
  lastReason: string | null;
  lastError: string | null;
  /** Salient counts from the most recent observation (episodes, memories, …). */
  counts: Record<string, number>;
  /** How many observations were seen since process start (event lanes) or 0. */
  observedEventCount: number;
  /** Most recent observations, newest first (bounded ring buffer). */
  recent: SubsystemLaneEvent[];
  // Durable scheduler/watermark fields (undefined for event-bus lanes):
  intervalMs?: number;
  lastRunAt?: number | null;
  nextRunDueAt?: number | null;
  deniedReason?: string | null;
}

export interface SubsystemHealthSnapshot {
  /** When this process (and therefore the event ring buffers) started. */
  processStartedAt: number;
  generatedAt: number;
  operatorAlerting?: OperatorAlertSinkConfiguration;
  /** Content-free pool ownership/capacity; never connection strings, SQL, or row content. */
  postgresPools: PostgresPoolOwnerTelemetry[];
  lanes: SubsystemLaneHealth[];
}

export interface AdminSubsystemHealthService {
  getSnapshot(): Promise<SubsystemHealthSnapshot>;
}

/** Minimal read view of scheduler task state the health service consumes. */
export interface SubsystemSchedulerTaskView {
  id: string;
  name: string;
  type: string;
  state: string;
  intervalMs: number;
  runAt?: number;
  lastRunAt?: number;
  lastFinishedAt?: number;
  lastOutcome?: string;
  lastError?: string;
  lastErrorAt?: number;
  lastDeniedReason?: string;
}

export interface SubsystemSchedulerStateProvider {
  getFullData(): { tasks: SubsystemSchedulerTaskView[] };
}

export interface EpisodicWatermarkStateProvider {
  listProcessingWatermarkHealth():
    | Promise<EpisodicProcessingWatermarkHealthSummary[]>
    | EpisodicProcessingWatermarkHealthSummary[];
}

export interface PostTurnActionQueueStateProvider {
  getStatus(): PostTurnActionQueueStatus;
}

export interface EpisodicWatermarkLaneDefinition {
  processor: string;
  label: string;
  description: string;
  intervalMs: number;
}

const DEFAULT_RING_LIMIT = 50;
/** A scheduler lane is stale once it is this many intervals past its last run. */
const DEFAULT_STALE_INTERVAL_FACTOR = 2;
const log = createComponentLogger('SubsystemHealthService');

interface EventLaneDefinition {
  id: string;
  label: string;
  description: string;
}

const EVENT_LANE_DEFINITIONS: readonly EventLaneDefinition[] = [
  {
    id: 'subject_classification_coverage',
    label: 'Memory subject classification coverage',
    description: 'Startup coverage of current, evidence-matched memory subject classifications.',
  },
  {
    id: 'near_turn',
    label: 'Near-turn memory lane',
    description: 'Cheap deterministic per-turn memory cadence (E5.2).',
  },
  {
    id: 'episode_synthesis',
    label: 'Episode synthesis gate',
    description: 'Deterministic candidate-episode trigger gate (E5.3); skips carry a reason.',
  },
  {
    id: 'active_context',
    label: 'Active-memory context refresh',
    description: 'Background active-memory refresh and turn degradation (E5.5).',
  },
  {
    id: 'extraction',
    label: 'Memory extraction',
    description: 'Fact/memory extraction lane.',
  },
  {
    id: 'retrieval',
    label: 'Memory retrieval',
    description: 'Turn-time memory retrieval lane.',
  },
  {
    id: 'social_graph',
    label: 'Social-graph builder',
    description: 'Background social-graph edge-proposal worker (E4.2).',
  },
  {
    id: 'orientation_rewrite',
    label: 'Orientation rewrite gate',
    description: 'Nightly core-memory orient rewrite; gated on evidence of change (jpvd.4).',
  },
  {
    id: 'dream_meaning',
    label: 'Dream meaning gate',
    description: 'Nightly first-person meaning pass; gated on cadence + new episodes (jpvd.4).',
  },
  {
    id: 'sleep_consolidation_refinement',
    label: 'Sleep-consolidation refinement gate',
    description: 'Bounded LLM episode cleanup; gated on unrefined-episode count (jpvd.4).',
  },
  {
    id: 'emotion_appraisal',
    label: 'Emotion appraisal gate',
    description: 'Chain-of-emotion appraisal; gated on turn cadence or VAD movement (jpvd.4).',
  },
  {
    id: 'concern_candidate_review',
    label: 'Concern candidate review gate',
    description: 'Follow-up candidate review; gated on pending count + turn interval (jpvd.4).',
  },
  {
    id: 'wiki_projection_rag',
    label: 'Wiki projection + RAG lane',
    description: 'Wiki pgvector projection sync and supplemental chat RAG (E8.3); fails closed for search, never blocks writes, and is deterministically gated (skips carry a reason).',
  },
  {
    id: 'free_time',
    label: 'Free-time lanes',
    description: 'Self-directed free time (E8.1); pre-spend gate skips carry a reason, '
      + 'block runs carry turns + background-lane charge spend. Charter 8.8/8.9.',
  },
  ...BACKGROUND_WORK_HEALTH_LANES,
  {
    id: 'weighted_thought_outreach',
    label: 'Weighted-thought outreach',
    description: 'Internal-state-driven outreach lane (charter 6.24); every tick reports the '
      + 'nudge gate with thought count and max weight, so a closed gate is distinguishable '
      + 'from a dead lane (hrmrq.85).',
  },
  {
    id: 'social_desire_outreach',
    label: 'Social-desire consent lane',
    description: 'Per-contact durable desire consent moments (oth4); every tick reports the '
      + 'desire snapshot size and evaluation counts, so an empty store is distinguishable '
      + 'from a dead lane (hrmrq.85).',
  },
];

/**
 * Deterministic pre-LLM gate lanes (jpvd.4): every one emits the shared
 * `DeterministicGateEvent` shape, so a single generic subscriber feeds them.
 * The extraction pre-LLM gate uses the same primitive but keeps surfacing its
 * skips through the existing `memory.extraction.end` telemetry (the extractor
 * has no direct event-bus handle), so it is not listed here.
 */
const GATE_EVENT_LANES: ReadonlyArray<{
  readonly event:
    | 'memory.orientation_rewrite.gate'
    | 'memory.dream_meaning.gate'
    | 'memory.sleep_consolidation.refinement_gate'
    | 'memory.sleeptime_wiki.gate'
    | 'emotion.appraisal.gate'
    | 'intention.concern_candidate.gate'
    | 'scheduler.free_time.gate';
  readonly lane: string;
}> = [
  { event: 'memory.orientation_rewrite.gate', lane: 'orientation_rewrite' },
  { event: 'memory.dream_meaning.gate', lane: 'dream_meaning' },
  { event: 'memory.sleep_consolidation.refinement_gate', lane: 'sleep_consolidation_refinement' },
  { event: 'memory.sleeptime_wiki.gate', lane: 'wiki_pass' },
  { event: 'emotion.appraisal.gate', lane: 'emotion_appraisal' },
  { event: 'intention.concern_candidate.gate', lane: 'concern_candidate_review' },
  { event: 'scheduler.free_time.gate', lane: 'free_time' },
];

interface LaneAccumulator {
  lastEvent: SubsystemLaneEvent | null;
  observedEventCount: number;
  recent: SubsystemLaneEvent[];
}

function trimNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function collectCounts(entries: Array<[string, number | undefined]>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [key, value] of entries) {
    if (value !== undefined) counts[key] = value;
  }
  return counts;
}

/** Keep only the finite numeric gate inputs; string inputs are labels, not counts. */
function numericInputCounts(inputs: Record<string, number | string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value === 'number' && Number.isFinite(value)) counts[key] = value;
  }
  return counts;
}

export class AdminSubsystemHealthDataService implements AdminSubsystemHealthService {
  private readonly ringLimit: number;
  private readonly staleFactor: number;
  private readonly now: () => number;
  private readonly processStartedAt: number;
  private readonly scheduler: SubsystemSchedulerStateProvider | null;
  private readonly operatorAlerting: SubsystemHealthSnapshot['operatorAlerting'];
  private readonly watermarkProvider: EpisodicWatermarkStateProvider | null;
  private readonly postTurnActionQueueProvider: PostTurnActionQueueStateProvider | null;
  private readonly watermarkDefinitionProvider: () => readonly EpisodicWatermarkLaneDefinition[];
  private readonly postgresPoolTelemetry: () => PostgresPoolOwnerTelemetry[];
  private readonly lanes = new Map<string, LaneAccumulator>();
  private readonly backgroundWorkHealth = new BackgroundWorkHealthAccumulator();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(deps: {
    eventBus: EventBus;
    scheduler?: SubsystemSchedulerStateProvider | null;
    watermarkProvider?: EpisodicWatermarkStateProvider | null;
    postTurnActionQueueProvider?: PostTurnActionQueueStateProvider | null;
    watermarkDefinitions?:
      | readonly EpisodicWatermarkLaneDefinition[]
      | (() => readonly EpisodicWatermarkLaneDefinition[]);
    ringLimit?: number;
    staleIntervalFactor?: number;
    now?: () => number;
    processStartedAt?: number;
    operatorAlerting?: SubsystemHealthSnapshot['operatorAlerting'];
    startupMemorySubjectClassificationCoverage?: MemorySubjectClassificationCoverage;
    postgresPoolTelemetry?: () => PostgresPoolOwnerTelemetry[];
  }) {
    this.ringLimit = Number.isFinite(deps.ringLimit)
      ? Math.max(1, Math.floor(deps.ringLimit as number))
      : DEFAULT_RING_LIMIT;
    this.staleFactor = Number.isFinite(deps.staleIntervalFactor)
      ? Math.max(1, deps.staleIntervalFactor as number)
      : DEFAULT_STALE_INTERVAL_FACTOR;
    this.now = deps.now ?? (() => Date.now());
    this.processStartedAt = deps.processStartedAt ?? this.now();
    this.scheduler = deps.scheduler ?? null;
    this.operatorAlerting = deps.operatorAlerting;
    this.watermarkProvider = deps.watermarkProvider ?? null;
    this.postgresPoolTelemetry = deps.postgresPoolTelemetry ?? getPostgresPoolTelemetry;
    this.postTurnActionQueueProvider = deps.postTurnActionQueueProvider ?? null;
    const watermarkDefinitions = deps.watermarkDefinitions;
    this.watermarkDefinitionProvider = typeof watermarkDefinitions === 'function'
      ? watermarkDefinitions
      : () => watermarkDefinitions ?? [];

    for (const def of EVENT_LANE_DEFINITIONS) {
      this.lanes.set(def.id, { lastEvent: null, observedEventCount: 0, recent: [] });
    }

    const coverage = deps.startupMemorySubjectClassificationCoverage;
    if (coverage) {
      const incomplete = coverage.missingCurrentClassificationCount > 0;
      this.record('subject_classification_coverage', {
        at: coverage.checkedAt,
        outcome: incomplete ? 'degraded' : 'ran',
        ...(incomplete ? { reason: 'missing_current_classifications' } : {}),
        counts: {
          totalMemoryCount: coverage.totalMemoryCount,
          currentClassificationCount: coverage.currentClassificationCount,
          missingCurrentClassificationCount: coverage.missingCurrentClassificationCount,
        },
      });
    }

    this.subscribe(deps.eventBus);
  }

  /** Release all bus subscriptions (idempotent). */
  dispose(): void {
    while (this.unsubscribers.length > 0) {
      const unsub = this.unsubscribers.pop();
      unsub?.();
    }
  }

  async getSnapshot(): Promise<SubsystemHealthSnapshot> {
    const generatedAt = this.now();
    const lanes: SubsystemLaneHealth[] = [];

    for (const def of EVENT_LANE_DEFINITIONS) {
      lanes.push(this.buildEventLane(def));
    }

    for (const laneView of this.buildSchedulerLanes(generatedAt)) {
      lanes.push(laneView);
    }
    for (const laneView of await this.buildWatermarkLanes(generatedAt)) {
      lanes.push(laneView);
    }
    const postTurnQueueLane = this.buildPostTurnActionQueueLane(generatedAt);
    if (postTurnQueueLane) {
      lanes.push(postTurnQueueLane);
    }

    return {
      processStartedAt: this.processStartedAt,
      generatedAt,
      ...(this.operatorAlerting ? { operatorAlerting: this.operatorAlerting } : {}),
      postgresPools: this.postgresPoolTelemetry(),
      lanes,
    };
  }

  private subscribe(eventBus: EventBus): void {
    this.unsubscribers.push(
      eventBus.on('memory.near_turn.cadence', (payload) => {
        this.record('near_turn', {
          at: trimNumber(payload.firedAtMs) ?? this.now(),
          outcome: 'ran',
          counts: collectCounts([
            ['turnCount', trimNumber(payload.turnCount)],
            ['newEntriesSinceLastRun', trimNumber(payload.newEntriesSinceLastRun)],
            ['firesLastHour', trimNumber(payload.firesLastHour)],
          ]),
        });
      }),
    );

    this.unsubscribers.push(
      eventBus.on('memory.episode_synthesis.gate', (payload) => {
        const skipped = payload.outcome === 'skipped';
        this.record('episode_synthesis', {
          at: trimNumber(payload.timestamp) ?? this.now(),
          outcome: skipped ? 'skipped' : 'ran',
          ...(skipped && payload.reason ? { reason: payload.reason } : {}),
          counts: collectCounts([
            ['newEntryCount', trimNumber(payload.newEntryCount)],
            ['relevantTurnCount', trimNumber(payload.relevantTurnCount)],
            ['minRelevantTurns', trimNumber(payload.minRelevantTurns)],
          ]),
        });
      }),
    );

    this.unsubscribers.push(
      eventBus.on('memory.active_context.refresh', (payload) => {
        const degraded = payload.phase === 'degraded';
        this.record('active_context', {
          at: trimNumber(payload.timestamp) ?? this.now(),
          outcome: degraded ? 'failed' : 'ran',
          ...(degraded && payload.error ? { error: payload.error } : {}),
          counts: collectCounts([
            ['contextChars', trimNumber(payload.contextChars)],
            [
              'selectedMemories',
              Array.isArray(payload.selectedMemoryIds) ? payload.selectedMemoryIds.length : undefined,
            ],
          ]),
        });
      }),
    );

    this.unsubscribers.push(
      eventBus.on('memory.active_context.turn_degraded', (payload) => {
        this.record('active_context', {
          at: trimNumber(payload.timestamp) ?? this.now(),
          outcome: 'degraded',
          reason: payload.reason,
          ...(payload.lastRefreshError ? { error: payload.lastRefreshError } : {}),
        });
      }),
    );

    this.unsubscribers.push(
      eventBus.on('memory.extraction.end', (payload) => {
        this.record('extraction', {
          at: this.now(),
          outcome: 'ran',
          counts: collectCounts([
            ['extracted', trimNumber(payload.count)],
            ['accepted', trimNumber(payload.acceptedCount)],
            ['rejected', trimNumber(payload.rejectedCount)],
            ['written', trimNumber(payload.writeCount)],
            ['deduplicated', trimNumber(payload.deduplicatedCount)],
          ]),
        });
      }),
    );

    this.unsubscribers.push(
      eventBus.on('memory.retrieval', (payload) => {
        this.record('retrieval', {
          at: this.now(),
          outcome: 'ran',
          ...(payload.reason ? { reason: payload.reason } : {}),
          counts: collectCounts([
            ['returned', trimNumber(payload.returned ?? payload.returnedCount ?? payload.count)],
            ['candidates', trimNumber(payload.candidates ?? payload.candidateCount)],
            ['ranked', trimNumber(payload.ranked ?? payload.rankedCount)],
          ]),
        });
      }),
    );

    this.unsubscribers.push(
      eventBus.on('memory.social_graph.builder', (payload) => {
        this.record('social_graph', {
          at: trimNumber(payload.runAtMs) ?? this.now(),
          outcome: 'ran',
          counts: collectCounts([
            ['scanned', trimNumber(payload.scanned)],
            ['proposed', trimNumber(payload.proposed)],
            ['conflicts', trimNumber(payload.conflicts)],
            ['deduped', trimNumber(payload.deduped)],
          ]),
        });
      }),
    );

    this.unsubscribers.push(
      eventBus.on('agent.turn.performance', (payload) => {
        const update = this.backgroundWorkHealth.observe(payload, this.now());
        if (!update) return;
        const { laneId, ...event } = update;
        this.record(laneId, event);
      }),
    );

    // E8.3: wiki pgvector projection sync outcomes. A failed embedding/write
    // fails closed for semantic search but never blocks the wiki write.
    this.unsubscribers.push(
      eventBus.on('wiki.projection.sync', (payload) => {
        this.record('wiki_projection_rag', {
          at: trimNumber(payload.timestamp) ?? this.now(),
          outcome: payload.outcome === 'failed' ? 'failed' : 'ran',
          reason: payload.outcome === 'failed' ? 'projection_sync_failed' : 'projection_synced',
          ...(payload.error ? { error: payload.error } : {}),
          counts: collectCounts([
            ['chunks', trimNumber(payload.chunkCount)],
          ]),
        });
      }),
    );

    // E8.3: supplemental wiki RAG retrieval outcomes/skips for chat turns.
    this.unsubscribers.push(
      eventBus.on('wiki.retrieval', (payload) => {
        this.record('wiki_projection_rag', {
          at: trimNumber(payload.timestamp) ?? this.now(),
          outcome: payload.outcome === 'skipped'
            ? 'skipped'
            : payload.outcome === 'degraded'
              ? 'degraded'
              : 'ran',
          ...(payload.reason ? { reason: payload.reason } : {}),
          ...(payload.error ? { error: payload.error } : {}),
          counts: collectCounts([
            ['candidates', trimNumber(payload.candidateCount)],
            ['selected', trimNumber(payload.selectedCount)],
            ['tokens', trimNumber(payload.tokenCount)],
          ]),
        });
      }),
    );

    // Deterministic pre-LLM gate lanes (jpvd.4): uniform shape, one subscriber.
    for (const { event, lane } of GATE_EVENT_LANES) {
      this.unsubscribers.push(
        eventBus.on(event, (payload) => {
          const skipped = payload.outcome === 'skipped';
          this.record(lane, {
            at: trimNumber(payload.timestamp) ?? this.now(),
            outcome: skipped ? 'skipped' : 'ran',
            ...(payload.reason ? { reason: payload.reason } : {}),
            counts: numericInputCounts(payload.inputs),
          });
        }),
      );
    }

    // Outreach lane liveness (hrmrq.85): real subscribers for the per-tick
    // gate telemetry both autonomy lanes emit, so the Garden shows every tick
    // — a closed gate records 'skipped' with its reason; silence means the
    // lane is genuinely not ticking.
    this.unsubscribers.push(
      eventBus.on('intention.nudge.gate', (payload) => {
        this.record('weighted_thought_outreach', {
          at: trimNumber(payload.timestamp) ?? this.now(),
          outcome: payload.open ? 'ran' : 'skipped',
          reason: payload.reason,
          counts: collectCounts([
            ['thoughtCount', trimNumber(payload.thoughtCount)],
            ['maxWeight', trimNumber(payload.maxWeight)],
            ['threshold', trimNumber(payload.threshold)],
          ]),
        });
      }),
    );
    this.unsubscribers.push(
      eventBus.on('social_desire.outreach.gate', (payload) => {
        this.record('social_desire_outreach', {
          at: trimNumber(payload.timestamp) ?? this.now(),
          outcome: payload.desiresEvaluated > 0 ? 'ran' : 'skipped',
          reason: payload.desiresEvaluated > 0
            ? 'desires_evaluated'
            : payload.desireCount === 0 ? 'no_desires_accumulated' : 'no_desire_eligible',
          counts: collectCounts([
            ['desireCount', trimNumber(payload.desireCount)],
            ['desiresEvaluated', trimNumber(payload.desiresEvaluated)],
            ['consentMomentsEvaluated', trimNumber(payload.consentMomentsEvaluated)],
          ]),
        });
      }),
    );

    // Free-time block runs (E8.1): each completed block feeds the same
    // 'free_time' lane with turns + background-lane charge spend, so recent
    // blocks and their cost are visible alongside the gate skips (charter 8.9).
    this.unsubscribers.push(
      eventBus.on('scheduler.free_time.block', (payload) => {
        this.record('free_time', {
          at: trimNumber(payload.timestamp) ?? this.now(),
          outcome: 'ran',
          // restReason distinguishes rest-by-choice (companion_rested) from a
          // fail-closed chooser (chooser_error/timeout/…) in the Garden lane
          // (psfn-framework-hrmrq.69).
          reason: typeof payload.restReason === 'string'
            ? `${payload.lane}:${payload.endReason}:${payload.restReason}`
            : `${payload.lane}:${payload.endReason}`,
          counts: collectCounts([
            ['turnsUsed', trimNumber(payload.turnsUsed)],
            ['spentChargeUnits', trimNumber(payload.spentChargeUnits)],
            ['maxChargeUnits', trimNumber(payload.maxChargeUnits)],
            ['activity', payload.activity ? 1 : 0],
            ['returnSurfaced', payload.returnSurfaced ? 1 : 0],
          ]),
        });
      }),
    );
  }

  private record(laneId: string, event: SubsystemLaneEvent): void {
    const lane = this.lanes.get(laneId);
    if (!lane) return;
    lane.lastEvent = event;
    lane.observedEventCount += 1;
    lane.recent.push(event);
    if (lane.recent.length > this.ringLimit) {
      lane.recent.splice(0, lane.recent.length - this.ringLimit);
    }
  }

  private buildEventLane(def: EventLaneDefinition): SubsystemLaneHealth {
    const lane = this.lanes.get(def.id) ?? { lastEvent: null, observedEventCount: 0, recent: [] };
    const last = lane.lastEvent;
    const status: SubsystemLaneStatus = last === null ? 'never' : outcomeToStatus(last.outcome);
    return {
      id: def.id,
      label: def.label,
      description: def.description,
      source: 'event_bus',
      sinceProcessStart: true,
      status,
      lastEventAt: last?.at ?? null,
      lastOutcome: last?.outcome ?? null,
      lastReason: last?.reason ?? null,
      lastError: last?.error ?? null,
      counts: last?.counts ? { ...last.counts } : {},
      observedEventCount: lane.observedEventCount,
      recent: lane.recent
        .slice()
        .reverse()
        .map(entry => ({ ...entry, ...(entry.counts ? { counts: { ...entry.counts } } : {}) })),
    };
  }

  private buildSchedulerLanes(generatedAt: number): SubsystemLaneHealth[] {
    if (!this.scheduler) return [];
    let tasks: SubsystemSchedulerTaskView[];
    try {
      tasks = this.scheduler.getFullData().tasks;
    } catch (error) {
      const message = toErrorMessage(error);
      log.warn('Failed to read scheduler state for subsystem health', { error: message });
      return [{
        id: 'scheduler:health-read',
        label: 'Scheduler health',
        description: 'Scheduler task state inspection.',
        source: 'scheduler',
        sinceProcessStart: false,
        status: 'failed',
        lastEventAt: generatedAt,
        lastOutcome: 'failed',
        lastReason: null,
        lastError: message,
        counts: {},
        observedEventCount: 0,
        recent: [],
      }];
    }

    return tasks.map((task) => {
      const lastRunAt = trimNumber(task.lastRunAt) ?? null;
      const intervalMs = trimNumber(task.intervalMs);
      const hasError = Boolean(task.lastError && task.lastError.trim());
      const denied = Boolean(task.lastDeniedReason && task.lastDeniedReason.trim());

      let status: SubsystemLaneStatus;
      if (task.state === 'paused') {
        status = 'paused';
      } else if (hasError) {
        status = 'failed';
      } else if (denied) {
        status = 'skipped';
      } else if (lastRunAt === null) {
        status = 'never';
      } else if (
        task.type === 'every'
        && intervalMs !== undefined
        && intervalMs > 0
        && generatedAt - lastRunAt > intervalMs * this.staleFactor
      ) {
        status = 'stale';
      } else {
        status = 'ok';
      }

      const nextRunDueAt = task.type === 'every' && intervalMs && lastRunAt !== null
        ? lastRunAt + intervalMs
        : trimNumber(task.runAt) ?? null;

      const lastOutcome: SubsystemLaneOutcome | null = hasError
        ? 'failed'
        : denied
          ? 'skipped'
          : lastRunAt !== null
            ? 'ran'
            : null;

      return {
        id: `scheduler:${task.id}`,
        label: task.name || task.id,
        description: `Scheduler task (${task.type}).`,
        source: 'scheduler' as const,
        sinceProcessStart: false,
        status,
        lastEventAt: lastRunAt,
        lastOutcome,
        lastReason: denied ? task.lastDeniedReason ?? null : null,
        lastError: hasError ? task.lastError ?? null : null,
        counts: {},
        observedEventCount: 0,
        recent: [],
        intervalMs: intervalMs ?? 0,
        lastRunAt,
        nextRunDueAt,
        deniedReason: denied ? task.lastDeniedReason ?? null : null,
      };
    });
  }

  private async buildWatermarkLanes(generatedAt: number): Promise<SubsystemLaneHealth[]> {
    if (!this.watermarkProvider) return [];
    let definitions: readonly EpisodicWatermarkLaneDefinition[];
    let summaries: EpisodicProcessingWatermarkHealthSummary[];
    try {
      definitions = this.validateWatermarkDefinitions(this.watermarkDefinitionProvider());
      if (definitions.length === 0) return [];
      summaries = await this.watermarkProvider.listProcessingWatermarkHealth();
    } catch (error) {
      const message = toErrorMessage(error);
      log.warn('Failed to read episodic processor watermarks for subsystem health', { error: message });
      return [{
        id: 'watermark:health-read',
        label: 'Episodic watermark health',
        description: 'Durable episodic processor watermark inspection.',
        source: 'watermark',
        sinceProcessStart: false,
        status: 'failed',
        lastEventAt: generatedAt,
        lastOutcome: 'failed',
        lastReason: null,
        lastError: message,
        counts: {},
        observedEventCount: 0,
        recent: [],
      }];
    }

    return definitions.map((definition) => {
      const summary = summaries.find(entry => entry.processor === definition.processor);
      const latestWatermark = summary?.latestWatermark;
      const parsedLastRunAt = latestWatermark
        ? Date.parse(latestWatermark.lastProcessedAt)
        : Number.NaN;
      const invalid = latestWatermark !== undefined && !Number.isFinite(parsedLastRunAt);
      const lastRunAt = Number.isFinite(parsedLastRunAt) ? parsedLastRunAt : null;
      const isFuture = lastRunAt !== null && lastRunAt > generatedAt;
      const blockedCount = summary?.blockedScopeCount ?? 0;
      const stale = lastRunAt !== null
        && generatedAt - lastRunAt > definition.intervalMs * this.staleFactor;
      const status: SubsystemLaneStatus = invalid || isFuture || blockedCount > 0
        ? 'failed'
        : lastRunAt === null
          ? 'never'
          : stale
            ? 'stale'
            : 'ok';
      const error = invalid
        ? `Invalid lastProcessedAt "${latestWatermark.lastProcessedAt}"`
        : isFuture
          ? `lastProcessedAt "${latestWatermark?.lastProcessedAt ?? ''}" is ahead of the runtime clock`
          : blockedCount > 0
            ? `${String(blockedCount)} watermark scope(s) are blocked`
            : null;
      return {
        id: `watermark:${definition.processor}`,
        label: definition.label,
        description: definition.description,
        source: 'watermark' as const,
        sinceProcessStart: false,
        status,
        lastEventAt: lastRunAt,
        lastOutcome: status === 'failed' ? 'failed' as const : lastRunAt === null ? null : 'ran' as const,
        lastReason: stale ? 'watermark_overdue' : null,
        lastError: error,
        counts: {
          scopeCount: summary?.scopeCount ?? 0,
          blockedScopeCount: blockedCount,
        },
        observedEventCount: 0,
        recent: [],
        intervalMs: definition.intervalMs,
        lastRunAt,
        nextRunDueAt: lastRunAt === null ? null : lastRunAt + definition.intervalMs,
        deniedReason: null,
      };
    });
  }

  private buildPostTurnActionQueueLane(generatedAt: number): SubsystemLaneHealth | null {
    if (!this.postTurnActionQueueProvider) return null;
    let queueStatus: PostTurnActionQueueStatus;
    try {
      queueStatus = this.postTurnActionQueueProvider.getStatus();
    } catch (error) {
      const message = toErrorMessage(error);
      log.warn('Failed to read post-turn action queue for subsystem health', { error: message });
      return {
        id: 'post_turn_action_queue',
        label: 'Deferred action queue',
        description: 'Durable defer-until-idle demand, coalescing, retries, rejects, and progress.',
        source: 'post_turn_queue',
        sinceProcessStart: false,
        status: 'failed',
        lastEventAt: generatedAt,
        lastOutcome: 'failed',
        lastReason: 'queue_health_read_failed',
        lastError: message,
        counts: {},
        observedEventCount: 0,
        recent: [],
      };
    }

    const deferredDepth = queueStatus.lanes.reduce((sum, lane) => sum + lane.deferredCount, 0);
    const oldestDeferredForMs = queueStatus.lanes.reduce(
      (oldest, lane) => Math.max(oldest, lane.oldestDeferredForMs ?? 0),
      0,
    );
    const persistenceError = queueStatus.persistence.lastPersistError
      ?? queueStatus.persistence.lastLoadError
      ?? (queueStatus.quarantine.persisted ? undefined : 'Queue quarantine state is not durable');
    // Failure and drop counters are lifetime telemetry. They describe what has
    // happened, not whether the queue is currently unhealthy. A scheduled
    // retry is the present-tense failure state; demand age remains observable
    // without treating expected foreground-idle waits as a stalled queue.
    const hasActiveRetry = queueStatus.retryScheduledCount > 0;
    const hasNoProgress = queueStatus.progress.stalled;
    const status: SubsystemLaneStatus = persistenceError || queueStatus.quarantine.count > 0
      ? 'failed'
      : hasActiveRetry || hasNoProgress
        ? 'degraded'
        : 'ok';
    const outcome: SubsystemLaneOutcome = status === 'failed'
      ? 'failed'
      : status === 'degraded'
        ? 'degraded'
        : 'ran';
    const reason = persistenceError
      ? 'queue_persistence_failed'
      : queueStatus.quarantine.count > 0
        ? 'queue_entries_quarantined'
        : hasActiveRetry
          ? 'queue_retry_scheduled'
          : hasNoProgress
            ? 'queue_no_progress'
            : null;

    return {
      id: 'post_turn_action_queue',
      label: 'Deferred action queue',
      description: 'Durable defer-until-idle demand, coalescing, retries, rejects, and progress.',
      source: 'post_turn_queue',
      sinceProcessStart: false,
      status,
      lastEventAt: queueStatus.progress.lastProgressAt ?? queueStatus.timestamp,
      lastOutcome: outcome,
      lastReason: reason,
      lastError: persistenceError ?? null,
      counts: {
        queueDepth: queueStatus.queueDepth,
        deferredDepth,
        oldestDeferredForMs,
        coalescedCount: queueStatus.coalescing.coalescedCount,
        activeCoalescedCount: queueStatus.coalescing.activeCoalescedCount,
        retryableFailureCount: queueStatus.failures.retryableFailureCount,
        permanentRejectCount: queueStatus.failures.permanentRejectCount,
        activeRetryCount: queueStatus.retryScheduledCount,
        waitingForForegroundIdleCount: queueStatus.progress.waitingForForegroundIdleCount,
        noProgressForMs: queueStatus.progress.noProgressForMs,
        expectedSchedulerRunIntervalMs: queueStatus.progress.expectedSchedulerRunIntervalMs,
        droppedCount: queueStatus.backPressure.droppedCount,
        completedCount: queueStatus.completions.completedCount,
        quarantinedCount: queueStatus.quarantine.count,
      },
      observedEventCount: 0,
      recent: [],
      lastRunAt: queueStatus.progress.lastProgressAt ?? null,
      nextRunDueAt: queueStatus.nextRunAt ?? null,
      deniedReason: null,
    };
  }

  private validateWatermarkDefinitions(
    definitions: readonly EpisodicWatermarkLaneDefinition[],
  ): readonly EpisodicWatermarkLaneDefinition[] {
    return definitions.map((definition) => {
      if (!definition.processor.trim()) {
        throw new Error('Episodic watermark health processor must be non-empty');
      }
      if (!Number.isFinite(definition.intervalMs) || definition.intervalMs <= 0) {
        throw new Error(
          `Episodic watermark health interval for "${definition.processor}" must be positive`,
        );
      }
      return { ...definition, processor: definition.processor.trim() };
    });
  }
}

function outcomeToStatus(outcome: SubsystemLaneOutcome): SubsystemLaneStatus {
  switch (outcome) {
    case 'ran':
      return 'ok';
    case 'skipped':
      return 'skipped';
    case 'degraded':
      return 'degraded';
    case 'failed':
      return 'failed';
    default:
      return 'never';
  }
}

// Compile-time guards: keep these aligned with the event bus payload types.
export type _EnsureNearTurnPayload = EventMap['memory.near_turn.cadence'];
export type _EnsureGatePayload = EventMap['memory.episode_synthesis.gate'];
export type _EnsureDeterministicGatePayload = EventMap['memory.orientation_rewrite.gate'];
