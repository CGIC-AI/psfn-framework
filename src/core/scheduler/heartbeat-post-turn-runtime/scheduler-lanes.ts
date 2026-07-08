import { createComponentLogger } from '../../../shared/logger.js';
import type { DeterministicGateEvent } from '../../../shared/event-bus.js';
import { inferSessionChannelType } from '../../session/session-id.js';
import {
  ContactTrustDriftReviewLane,
  CONTACT_TRUST_DRIFT_REVIEW_ACTION_KIND,
  CONTACT_TRUST_DRIFT_REVIEW_CHANNEL_ID,
  type ContactTrustDriftReviewStore,
} from '../../contacts/trust-drift-review-lane.js';
import {
  SleeptimeMemoryAgent,
  SLEEPTIME_MEMORY_ACTION_KIND,
} from '../../../faculties/memory/sleeptime-agent.js';
import {
  NearTurnMemoryLane,
  NEAR_TURN_MEMORY_ACTION_KIND,
  type NearTurnMemoryCadenceTelemetry,
} from '../../../faculties/memory/near-turn-memory-lane.js';
import {
  EpisodeSynthesisLane,
  EPISODE_SYNTHESIS_ACTION_KIND,
  EPISODE_SYNTHESIS_TIMER_TASK_ID,
  type EpisodeSynthesisGateEvent,
} from '../../../faculties/memory/episodic/synthesis-lane.js';
import { toInferredPostTurnActions } from '../../intention/appraisal.js';
import { MAINTENANCE_REFLECTION_RUNTIME_CLASS } from '../../agent/worker-lanes.js';
import type {
  HeartbeatAgent,
  HeartbeatRuntimeOptions,
} from '../heartbeat-runtime-contracts.js';
import type { Scheduler } from '../scheduler.js';

const log = createComponentLogger('HeartbeatPostTurn');

export const SLEEPTIME_REST_WINDOW_TASK_ID = 'memory.sleeptime.rest-window';
const SLEEPTIME_REST_WINDOW_POLL_INTERVAL_MS = 5 * 60_000;
export const CONTACT_TRUST_DRIFT_REVIEW_TASK_ID = 'contacts.trust-drift-review.rest-window';

export interface SchedulerOwnedPostTurnLanes {
  sleeptimeAgent: SleeptimeMemoryAgent | null;
  nearTurnLane: NearTurnMemoryLane | null;
  episodeSynthesisLane: EpisodeSynthesisLane | null;
  driftReviewLane: ContactTrustDriftReviewLane | null;
}

interface CreateSchedulerOwnedPostTurnLanesOptions {
  agentLoop: HeartbeatAgent;
  runtimeOptions: HeartbeatRuntimeOptions;
}

interface RegisterSchedulerOwnedPostTurnLanesOptions extends CreateSchedulerOwnedPostTurnLanesOptions {
  scheduler: Scheduler;
  lanes: SchedulerOwnedPostTurnLanes;
  postTurnActions: NonNullable<HeartbeatRuntimeOptions['postTurnActions']>;
}

function resolveContactTrustDriftReviewStore(
  runtimeOptions: HeartbeatRuntimeOptions,
): ContactTrustDriftReviewStore | null {
  const driftContactStore = runtimeOptions.contactStore;
  return (
    driftContactStore
    && driftContactStore.listAll
    && driftContactStore.countVerifiedIdentityLinks
    && driftContactStore.getContactMaintenanceWatermark
    && driftContactStore.setContactMaintenanceWatermark
  )
    ? {
      listAll: driftContactStore.listAll.bind(driftContactStore),
      getEmotionalTimeSeries: driftContactStore.getEmotionalTimeSeries.bind(driftContactStore),
      countVerifiedIdentityLinks: driftContactStore.countVerifiedIdentityLinks.bind(driftContactStore),
      getContactMaintenanceWatermark: driftContactStore.getContactMaintenanceWatermark.bind(driftContactStore),
      setContactMaintenanceWatermark: driftContactStore.setContactMaintenanceWatermark.bind(driftContactStore),
    }
    : null;
}

export function createSchedulerOwnedPostTurnLanes(
  options: CreateSchedulerOwnedPostTurnLanesOptions,
): SchedulerOwnedPostTurnLanes {
  const { agentLoop, runtimeOptions } = options;
  const telemetryEventBus = runtimeOptions.eventBus;

  // True sleeptime: heavy passes (sleep consolidation, arc weaving, dream
  // meaning, orientation rewrite) are scheduler-owned rest-window work. The
  // agent is intentionally NOT reachable from the post-turn inferer below —
  // its only trigger surface is the rest-window scheduler task.
  const sleeptimeAgent = (
    runtimeOptions.llmProvider
    && runtimeOptions.memoryWriter
    && runtimeOptions.sessionManager
    && runtimeOptions.coreMemoryStore
    && runtimeOptions.episodicProcessingRestWindow
  )
    ? new SleeptimeMemoryAgent({
      llmProvider: runtimeOptions.llmProvider,
      sessionManager: runtimeOptions.sessionManager,
      coreMemoryStore: runtimeOptions.coreMemoryStore,
      memoryWriter: runtimeOptions.memoryWriter,
      promptRegistry: runtimeOptions.promptRegistry ?? null,
      restWindow: runtimeOptions.episodicProcessingRestWindow,
      ...(runtimeOptions.orientationRewriteGate
        ? { orientationRewriteGate: runtimeOptions.orientationRewriteGate }
        : {}),
      ...(telemetryEventBus
        ? {
          onGateEvent: (event: DeterministicGateEvent): void => {
            telemetryEventBus.emit('memory.orientation_rewrite.gate', event);
          },
        }
        : {}),
      sleepConsolidator: runtimeOptions.sleepConsolidator,
      arcWeaver: runtimeOptions.arcWeaver,
      dreamMeaningPass: runtimeOptions.dreamMeaningPass,
      sleeptimeWikiPass: runtimeOptions.sleeptimeWikiPass,
      memoryMaintenanceStore: runtimeOptions.memoryMaintenanceStore,
      episodicDiagnosticsStore: runtimeOptions.episodicDiagnosticsStore,
    })
    : null;

  // Lightweight near-turn memory lane (no LLM provider: structurally zero
  // token spend). Fires on the JSON-owned nearTurnMemory cadence.
  const nearTurnLane = (
    runtimeOptions.sessionManager
    && runtimeOptions.nearTurnMemoryCadence
  )
    ? new NearTurnMemoryLane({
      sessionManager: runtimeOptions.sessionManager,
      cadence: runtimeOptions.nearTurnMemoryCadence,
      scopeClassifier: runtimeOptions.memoryScopeClassifier ?? null,
      memoryMaintenanceStore: runtimeOptions.memoryMaintenanceStore ?? null,
      ...(telemetryEventBus
        ? {
          onCadenceTelemetry: (event: NearTurnMemoryCadenceTelemetry): void => {
            telemetryEventBus.emit('memory.near_turn.cadence', {
              channelId: event.channelId,
              sessionId: event.sessionId,
              scope: event.scope,
              turnCount: event.turnCount,
              newEntriesSinceLastRun: event.newEntriesSinceLastRun,
              firedAtMs: event.firedAtMs,
              firesLastHour: event.firesLastHour,
              timestamp: Date.now(),
            }).catch((error) => {
              log.warn('Near-turn cadence telemetry emit failed', {
                channelId: event.channelId,
                scope: event.scope,
                error: String(error),
              });
            });
          },
        }
        : {}),
    })
    : null;

  // Candidate-episode synthesis lane: timer-or-turn-threshold trigger with a
  // deterministic gate (E5.3). Zero LLM spend when the gate is closed.
  const episodeSynthesisLane = (
    runtimeOptions.sessionManager
    && runtimeOptions.episodicSynthesizer
    && runtimeOptions.episodicWatermarkStore
    && runtimeOptions.episodeSynthesis
  )
    ? new EpisodeSynthesisLane({
      sessionManager: runtimeOptions.sessionManager,
      synthesizer: runtimeOptions.episodicSynthesizer,
      watermarkStore: runtimeOptions.episodicWatermarkStore,
      config: runtimeOptions.episodeSynthesis,
      scopeClassifier: runtimeOptions.memoryScopeClassifier ?? null,
      ...(runtimeOptions.companionNames ? { companionNames: runtimeOptions.companionNames } : {}),
      ...(runtimeOptions.companionAuthorIds ? { companionAuthorIds: runtimeOptions.companionAuthorIds } : {}),
      memoryWriter: runtimeOptions.memoryWriter ?? null,
      ...(telemetryEventBus
        ? {
          onGateEvent: (event: EpisodeSynthesisGateEvent): void => {
            telemetryEventBus.emit('memory.episode_synthesis.gate', {
              sessionId: event.sessionId,
              channelId: event.channelId,
              trigger: event.trigger,
              outcome: event.outcome,
              ...(event.reason ? { reason: event.reason } : {}),
              newEntryCount: event.newEntryCount,
              relevantTurnCount: event.relevantTurnCount,
              minRelevantTurns: event.minRelevantTurns,
              timestamp: event.timestamp,
            }).catch((error) => {
              log.warn('Episode-synthesis gate telemetry emit failed', {
                sessionId: event.sessionId,
                outcome: event.outcome,
                error: String(error),
              });
            });
          },
        }
        : {}),
    })
    : null;

  const driftReviewStore = resolveContactTrustDriftReviewStore(runtimeOptions);
  const driftReviewLane = (
    driftReviewStore
    && runtimeOptions.episodicProcessingRestWindow
    && agentLoop.followUp
  )
    ? new ContactTrustDriftReviewLane({
      contactStore: driftReviewStore,
      restWindow: runtimeOptions.episodicProcessingRestWindow,
      deliverReview: (review) => {
        agentLoop.followUp?.({
          id: `contact-drift-review:${Date.now()}`,
          channelId: CONTACT_TRUST_DRIFT_REVIEW_CHANNEL_ID,
          channelType: 'terminal',
          authorId: 'scheduler',
          authorName: 'Contact Trust Review',
          content: review.content,
          timestamp: new Date(),
        });
      },
    })
    : null;

  return {
    sleeptimeAgent,
    nearTurnLane,
    episodeSynthesisLane,
    driftReviewLane,
  };
}

export function registerSchedulerOwnedPostTurnLanes(
  options: RegisterSchedulerOwnedPostTurnLanesOptions,
): void {
  const {
    agentLoop,
    scheduler,
    runtimeOptions,
    lanes,
    postTurnActions,
  } = options;
  const telemetryEventBus = runtimeOptions.eventBus;

  if (lanes.sleeptimeAgent) {
    const sleeptimeAgent = lanes.sleeptimeAgent;
    if (telemetryEventBus && !scheduler.getTask(SLEEPTIME_REST_WINDOW_TASK_ID)) {
      scheduler.register({
        id: SLEEPTIME_REST_WINDOW_TASK_ID,
        name: 'Sleeptime Rest-Window Heavy Passes',
        type: 'every',
        intervalMs: SLEEPTIME_REST_WINDOW_POLL_INTERVAL_MS,
        handler: async () => {
          const actions = sleeptimeAgent.inferIdlePostTurnActions();
          for (const action of actions) {
            const payload = action.payload ?? {};
            const channelId = typeof payload.sourceChannelId === 'string'
              ? payload.sourceChannelId
              : typeof payload.sessionId === 'string'
                ? payload.sessionId
                : 'api:sleeptime';
            const inferredChannelType = inferSessionChannelType(channelId);
            const channelType = inferredChannelType && inferredChannelType !== 'subagent'
              ? inferredChannelType
              : 'api';
            const syntheticMessage = {
              id: `sleeptime-idle:${channelId}:${Date.now()}`,
              channelId,
              channelType,
              authorId: 'system:sleeptime',
              authorName: 'Sleeptime',
              content: 'Sleeptime rest-window maintenance became eligible.',
              timestamp: new Date(),
            };
            await telemetryEventBus.emit('agent.post_turn.actions.inferred', {
              message: syntheticMessage,
              response: {
                content: '',
                channelId,
                metadata: {
                  model: 'scheduler:sleeptime-idle',
                  inputTokens: 0,
                  outputTokens: 0,
                  durationMs: 0,
                },
              },
              actions: toInferredPostTurnActions([action], syntheticMessage),
            });
          }
        },
        eligibility: { requiredTokens: ['memory.write'] },
        state: 'idle',
      }, { skipFirstRun: true });
    }
    postTurnActions.registerHandler(
      SLEEPTIME_MEMORY_ACTION_KIND,
      async (action) => {
        await sleeptimeAgent.execute(action);
      },
      {
        executionMode: 'background',
        runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
      },
    );
  } else {
    log.info('Sleeptime memory agent wiring skipped: missing post-turn dependencies', {
      hasPostTurnActions: Boolean(runtimeOptions.postTurnActions),
      hasLLMProvider: Boolean(runtimeOptions.llmProvider),
      hasMemoryWriter: Boolean(runtimeOptions.memoryWriter),
      hasSessionManager: Boolean(runtimeOptions.sessionManager),
      hasCoreMemoryStore: Boolean(runtimeOptions.coreMemoryStore),
      hasRestWindow: Boolean(runtimeOptions.episodicProcessingRestWindow),
    });
  }

  if (lanes.driftReviewLane) {
    const driftReviewLane = lanes.driftReviewLane;
    if (telemetryEventBus && !scheduler.getTask(CONTACT_TRUST_DRIFT_REVIEW_TASK_ID)) {
      scheduler.register({
        id: CONTACT_TRUST_DRIFT_REVIEW_TASK_ID,
        name: 'Contact Trust-Drift Review',
        type: 'every',
        intervalMs: SLEEPTIME_REST_WINDOW_POLL_INTERVAL_MS,
        handler: async () => {
          const actions = await driftReviewLane.inferIdleActions();
          for (const action of actions) {
            const syntheticMessage = {
              id: `contact-drift-review-poll:${Date.now()}`,
              channelId: CONTACT_TRUST_DRIFT_REVIEW_CHANNEL_ID,
              channelType: 'terminal' as const,
              authorId: 'system:contact-drift-review',
              authorName: 'Contact Trust Review',
              content: 'Nightly contact trust-drift review became eligible.',
              timestamp: new Date(),
            };
            await telemetryEventBus.emit('agent.post_turn.actions.inferred', {
              message: syntheticMessage,
              response: {
                content: '',
                channelId: CONTACT_TRUST_DRIFT_REVIEW_CHANNEL_ID,
                metadata: {
                  model: 'scheduler:contact-drift-review',
                  inputTokens: 0,
                  outputTokens: 0,
                  durationMs: 0,
                },
              },
              actions: toInferredPostTurnActions([action], syntheticMessage),
            });
          }
        },
        eligibility: { requiredTokens: ['identity.read'] },
        state: 'idle',
      }, { skipFirstRun: true });
    }
    postTurnActions.registerHandler(
      CONTACT_TRUST_DRIFT_REVIEW_ACTION_KIND,
      async (action) => {
        await driftReviewLane.execute(action);
      },
      {
        executionMode: 'background',
        runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
      },
    );
  } else {
    const driftContactStore = runtimeOptions.contactStore;
    log.info('Contact trust-drift review wiring skipped: missing post-turn dependencies', {
      hasContactStore: Boolean(runtimeOptions.contactStore),
      hasDriftStoreSurface: Boolean(driftContactStore?.listAll && driftContactStore.setContactMaintenanceWatermark),
      hasRestWindow: Boolean(runtimeOptions.episodicProcessingRestWindow),
      hasFollowUp: Boolean(agentLoop.followUp),
    });
  }

  if (lanes.nearTurnLane) {
    const nearTurnLane = lanes.nearTurnLane;
    postTurnActions.registerHandler(
      NEAR_TURN_MEMORY_ACTION_KIND,
      async (action) => {
        await nearTurnLane.execute(action);
      },
      {
        executionMode: 'background',
        runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
      },
    );
  } else {
    log.info('Near-turn memory lane wiring skipped: missing dependencies', {
      hasSessionManager: Boolean(runtimeOptions.sessionManager),
      hasCadence: Boolean(runtimeOptions.nearTurnMemoryCadence),
    });
  }

  if (lanes.episodeSynthesisLane) {
    const episodeSynthesisLane = lanes.episodeSynthesisLane;
    postTurnActions.registerHandler(
      EPISODE_SYNTHESIS_ACTION_KIND,
      async (action) => {
        await episodeSynthesisLane.execute(action);
      },
      {
        executionMode: 'background',
        runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
      },
    );
    if (telemetryEventBus && !scheduler.getTask(EPISODE_SYNTHESIS_TIMER_TASK_ID)) {
      scheduler.register({
        id: EPISODE_SYNTHESIS_TIMER_TASK_ID,
        name: 'Episode Synthesis Gate Timer',
        type: 'every',
        intervalMs: episodeSynthesisLane.timerIntervalMs,
        handler: async () => {
          for (const action of episodeSynthesisLane.inferTimerActions()) {
            const payload = action.payload ?? {};
            const channelId = typeof payload.sourceChannelId === 'string'
              ? payload.sourceChannelId
              : typeof payload.sessionId === 'string'
                ? payload.sessionId
                : 'api:episode-synthesis';
            const inferredChannelType = inferSessionChannelType(channelId);
            const channelType = inferredChannelType && inferredChannelType !== 'subagent'
              ? inferredChannelType
              : 'api';
            const syntheticMessage = {
              id: `episode-synthesis-timer:${channelId}:${Date.now()}`,
              channelId,
              channelType,
              authorId: 'system:episode-synthesis',
              authorName: 'Episode Synthesis',
              content: 'Episode-synthesis gate timer fired.',
              timestamp: new Date(),
            };
            await telemetryEventBus.emit('agent.post_turn.actions.inferred', {
              message: syntheticMessage,
              response: {
                content: '',
                channelId,
                metadata: {
                  model: 'scheduler:episode-synthesis-timer',
                  inputTokens: 0,
                  outputTokens: 0,
                  durationMs: 0,
                },
              },
              actions: toInferredPostTurnActions([action], syntheticMessage),
            });
          }
        },
        eligibility: { requiredTokens: ['memory.write'] },
        state: 'idle',
      }, { skipFirstRun: true });
    }
  } else {
    log.info('Episode-synthesis lane wiring skipped: missing dependencies', {
      hasSessionManager: Boolean(runtimeOptions.sessionManager),
      hasSynthesizer: Boolean(runtimeOptions.episodicSynthesizer),
      hasWatermarkStore: Boolean(runtimeOptions.episodicWatermarkStore),
      hasGateConfig: Boolean(runtimeOptions.episodeSynthesis),
    });
  }
}
