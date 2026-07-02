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

export type SubsystemLaneSource = 'event_bus' | 'scheduler';

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
  // Scheduler-only fields (undefined for event-bus lanes):
  intervalMs?: number;
  lastRunAt?: number | null;
  nextRunDueAt?: number | null;
  deniedReason?: string | null;
}

export interface SubsystemHealthSnapshot {
  /** When this process (and therefore the event ring buffers) started. */
  processStartedAt: number;
  generatedAt: number;
  lanes: SubsystemLaneHealth[];
}

export interface AdminSubsystemHealthService {
  getSnapshot(): SubsystemHealthSnapshot;
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

const DEFAULT_RING_LIMIT = 50;
/** A scheduler lane is stale once it is this many intervals past its last run. */
const DEFAULT_STALE_INTERVAL_FACTOR = 2;

interface EventLaneDefinition {
  id: string;
  label: string;
  description: string;
}

const EVENT_LANE_DEFINITIONS: readonly EventLaneDefinition[] = [
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

export class AdminSubsystemHealthDataService implements AdminSubsystemHealthService {
  private readonly ringLimit: number;
  private readonly staleFactor: number;
  private readonly now: () => number;
  private readonly processStartedAt: number;
  private readonly scheduler: SubsystemSchedulerStateProvider | null;
  private readonly lanes = new Map<string, LaneAccumulator>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(deps: {
    eventBus: EventBus;
    scheduler?: SubsystemSchedulerStateProvider | null;
    ringLimit?: number;
    staleIntervalFactor?: number;
    now?: () => number;
    processStartedAt?: number;
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

    for (const def of EVENT_LANE_DEFINITIONS) {
      this.lanes.set(def.id, { lastEvent: null, observedEventCount: 0, recent: [] });
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

  getSnapshot(): SubsystemHealthSnapshot {
    const generatedAt = this.now();
    const lanes: SubsystemLaneHealth[] = [];

    for (const def of EVENT_LANE_DEFINITIONS) {
      lanes.push(this.buildEventLane(def));
    }

    for (const laneView of this.buildSchedulerLanes(generatedAt)) {
      lanes.push(laneView);
    }

    return {
      processStartedAt: this.processStartedAt,
      generatedAt,
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
    } catch {
      return [];
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
