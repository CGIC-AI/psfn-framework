// Standalone companion scheduler runtime.
// Wires the core inner-life scheduler lanes without host-only backup, fleet
// maintenance, CogSec blind-review, or shared-world wiki caretaker tasks.

import { randomUUID } from 'node:crypto';

import { wirePostTurnActionRuntime } from '../startup/composition/post-turn-actions.js';
import type { PostTurnActionRuntime } from '../../core/agent/post-turn-action-runtime.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import { SalienceDecay } from '../../faculties/memory/decay.js';
import type {
  BiographyStageControl,
  BiographySynthesisService,
} from '../../faculties/memory/biographical/synthesis-service.js';
import type { BiographyCompanionReviewService } from '../../faculties/memory/biographical/companion-review-service.js';
import { createDefaultBiographicalDepthPolicy } from '../../system/config/biographical-depth-policy.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { resolveHealthEventOwner } from '../../shared/contracts/health-event.js';
import { registerAmbientPresenceOperation } from '../../core/scheduler/ambient-presence.js';
import {
  BackgroundMaintenanceRegistry,
  type BackgroundMaintenanceRegistrar,
} from '../../core/scheduler/background-maintenance.js';
import {
  registerConcernGroomingOperation,
  resolveCurrentInternalStateConcernVAD,
} from '../../core/intention/concern-grooming.js';
import { createDefaultConcernRouteDispatcher } from '../agent/concern-route-wiring.js';
import type { ConcernStorePort } from '../../core/intention/concern-store-port.js';
import {
  registerConcernReviewSupervisorTask,
  type ConcernReviewSupervisorWorkerPort,
} from '../../core/intention/concern-review-supervisor.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import {
  SocialGraphBuilderWorker,
  createSocialGraphBuilderMemoryReader,
  SOCIAL_GRAPH_BUILDER_OPERATION_ID,
} from '../../faculties/memory/social-graph/graph-builder-worker.js';
import type {
  SocialGraphProposalStore,
  SocialGraphBuilderWatermarkStore,
} from '../../faculties/memory/social-graph/proposals.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { CompanionAvailabilityRuntime } from '../../core/agent/companion-availability.js';
import { emitGardenQueueChanged } from '../../shared/garden-queue-change.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { EligibilityGate } from '../../system/capabilities/eligibility.js';
import type { SessionManager } from '../../core/session/manager.js';
import {
  createCompressionGuidelineEvolution,
  type CompressionGuidelineEvolutionPort,
} from '../../core/session/compression-guideline-evolution.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import {
  BACKGROUND_WORK_SUPERVISOR_TASK_ID,
  registerDurableBackgroundWorkSupervisorTask,
} from '../../core/agent/background-work/scheduler-task.js';
import type { SchedulerRuntimeConfig } from '../../system/config/scheduler-config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { SENSITIVITY_LEVELS } from '../../system/trust/types.js';
import type { AutomataBusReviewerTaskPort } from '../../faculties/automata/bus/reviewer-service.js';
import type { ProductionAutomataClassId } from '../../faculties/automata/registry-contract.js';
import {
  runGovernedAutomataClass,
  type AutomataClassLifecycleRuntime,
  type AutomataClassWorkResult,
} from '../../faculties/automata/bus/class-lifecycle.js';
import {
  resolvePostTurnActionQueuePath,
  type RuntimePathSnapshot,
} from '../../persistence/layout.js';

const log = createComponentLogger('CompanionScheduler');
const MS_PER_MINUTE = 60_000;
const AUTOMATA_BUS_REVIEWER_TASK_ID = 'automata-bus-reviewer';
const AUTOMATA_BUS_REVIEWER_CLASS: ProductionAutomataClassId = 'scheduler.automata_bus_reviewer';
const AUTOMATA_BUS_REVIEWER_BRIEFING_QUERY = 'automata bus evidence review consistency';
const SOCIAL_GRAPH_BUILDER_CLASS: ProductionAutomataClassId = 'memory.social_graph_builder';
const SOCIAL_GRAPH_BUILDER_BRIEFING_QUERY = 'social graph proposal evidence scan';
const BIOGRAPHY_SYNTHESIS_CLASS: ProductionAutomataClassId = 'memory.biography_synthesis';
const BIOGRAPHY_SYNTHESIS_BRIEFING_QUERY = 'portable biography candidate synthesis evidence';
const BIOGRAPHY_REVIEW_CLASS: ProductionAutomataClassId = 'memory.biography_review';
const BIOGRAPHY_REVIEW_BRIEFING_QUERY = 'companion biography candidate self review';
const AUTOMATA_RETENTION_OPERATION_ID = 'automata-raw-session-retention';
const BIOGRAPHY_COMPANION_REVIEW_TASK_ID = 'biography-companion-review';
const BIOGRAPHY_SYNTHESIS_TASK_ID = 'biography-candidate-synthesis';

export { BACKGROUND_WORK_SUPERVISOR_TASK_ID };

export interface CompanionSchedulerRuntime {
  scheduler: Scheduler;
  postTurnActions: PostTurnActionRuntime;
  backgroundMaintenance: BackgroundMaintenanceRegistrar;
  compressionGuidelineEvolution: CompressionGuidelineEvolutionPort;
}

export interface BuildCompanionSchedulerRuntimeOptions {
  eventBus: EventBus;
  eligibilityGate: EligibilityGate;
  config: SubstrateConfig;
  schedulerConfig: SchedulerRuntimeConfig;
  sessionManager: SessionManager;
  llmProvider: LLMProviderPort;
  embeddingDims: number;
  memoryStore: MemoryStorePort;
  agentLoop: SubstrateAgent;
  concernStore?: ConcernStorePort | null;
  concernReviewWorker?: ConcernReviewSupervisorWorkerPort | null;
  pathSnapshot: RuntimePathSnapshot;
  contactStore?: ContactStorePort | null;
  socialGraphProposalStore?: SocialGraphProposalStore | null;
  socialGraphWatermarkStore?: SocialGraphBuilderWatermarkStore | null;
  companionAvailability?: Pick<CompanionAvailabilityRuntime, 'run'>;
  automataReviewer?: {
    task: AutomataBusReviewerTaskPort;
    companionId: string;
  };
  automataLifecycle?: AutomataClassLifecycleRuntime;
  automataRetention?: { runBounded(nowMs?: number): Promise<unknown> };
  biographySynthesis?: Pick<BiographySynthesisService, 'run'>;
  biographyCompanionReview?: Pick<BiographyCompanionReviewService, 'run'>;
}

async function runBiographyStageStandalone<
  T extends { readonly outcome: 'complete' | 'yield' },
>(input: {
  label: string;
  run: (control: BiographyStageControl) => Promise<T>;
  summarize: (telemetry: T) => string;
}): Promise<AutomataClassWorkResult<T | undefined>> {
  const telemetry = await input.run({});
  if (telemetry.outcome === 'yield') {
    throw new Error(`${input.label} yielded without fleet maintenance authority to yield to`);
  }
  return { value: telemetry, summary: input.summarize(telemetry) };
}

export function buildCompanionSchedulerRuntime(
  options: BuildCompanionSchedulerRuntimeOptions,
): CompanionSchedulerRuntime {
  const scheduler = new Scheduler(
    options.eventBus,
    {
      tickIntervalMs: options.schedulerConfig.tickIntervalMs,
      heartbeatIntervalMs: options.schedulerConfig.heartbeatIntervalMs,
    },
    {
      eligibilityGate: options.eligibilityGate,
      healthEventSource: {
        owner: resolveHealthEventOwner(options.config.companionId),
        process: 'agent',
      },
      taskBudgetMs: options.schedulerConfig.healthDetectors.stuckJobs.schedulerTaskBudgetMs,
      ...(options.companionAvailability
        ? {
            runProtectedTask: (state, handler) =>
              options.companionAvailability!.run(state, handler),
          }
        : {}),
    },
  );
  registerDurableBackgroundWorkSupervisorTask({
    agentLoop: options.agentLoop,
    intervalMs: options.schedulerConfig.tickIntervalMs,
    scheduler,
  });
  if (options.concernReviewWorker) {
    registerConcernReviewSupervisorTask({
      scheduler,
      worker: options.concernReviewWorker,
      intervalMs: options.schedulerConfig.tickIntervalMs,
    });
  }
  if (options.automataReviewer && options.automataLifecycle && options.automataReviewer.task.enabled) {
    const { task, companionId } = options.automataReviewer;
    const automataLifecycle = options.automataLifecycle;
    scheduler.register({
      id: AUTOMATA_BUS_REVIEWER_TASK_ID,
      name: 'Automata Bus Evidence Reviewer',
      description:
        'Nominates bounded Bus consistency candidates and appends only complete evidence-citing review decisions.',
      scheduleSource: 'automata-policy.json > bus.reviewer.cadenceMs',
      type: 'every',
      intervalMs: task.cadenceMs,
      availability: 'do_not_disturb',
      state: 'idle',
      handler: async () => {
        const runId = `automata-bus-review:${randomUUID()}`;
        await runGovernedAutomataClass({
          runtime: automataLifecycle,
          spec: {
            automatonClass: AUTOMATA_BUS_REVIEWER_CLASS,
            runId,
            workerId: AUTOMATA_BUS_REVIEWER_TASK_ID,
            taskId: AUTOMATA_BUS_REVIEWER_TASK_ID,
            taskLabel: 'Review Automata Bus evidence',
            taskSummary: 'Nominate and review a bounded batch of duplicate, contradiction, stale-evidence, and orphan-provenance candidates.',
          },
          briefingQuery: AUTOMATA_BUS_REVIEWER_BRIEFING_QUERY,
          work: async () => {
            const report = await task.run({
              companionId,
              runId,
              audience: 'operator',
              maxSensitivity: SENSITIVITY_LEVELS.at(-1)!,
            });
            return {
              value: report,
              summary: `Automata Bus review: attempted=${report.attempted} `
                + `skippedHandled=${report.skippedHandled} health=${report.health}`,
            };
          },
        });
      },
    }, { skipFirstRun: true });
  }

  const backgroundMaintenance = new BackgroundMaintenanceRegistry({
    scheduler,
    eligibilityGate: options.eligibilityGate,
    intervalMs: options.schedulerConfig.backgroundMaintenance.intervalMs,
  });
  const compressionGuidelineEvolution = createCompressionGuidelineEvolution({
    eligibilityGate: options.eligibilityGate,
    llmProvider: options.llmProvider,
  });

  if (options.automataRetention) {
    backgroundMaintenance.registerOperation({
      id: AUTOMATA_RETENTION_OPERATION_ID,
      name: 'Automata Raw Session Retention',
      description: 'Revalidates durable terminal evidence and purges only exact eligible sessions.',
      handler: async () => {
        await options.automataRetention!.runBounded();
      },
    });
  }

  const salienceDecay = new SalienceDecay(options.memoryStore, {
    memoryRetrievalPolicy: () => options.config.memoryRetrievalPolicy,
  });
  backgroundMaintenance.registerOperation({
    id: 'salience-decay',
    name: 'Memory Salience Decay',
    description: 'Applies the configured memory weight decay pass to durable memories.',
    handler: () => salienceDecay.run(),
    eligibility: { requiredTokens: ['memory.write'] },
  });

  const biographyRefreshIntervalMs = (
    options.config.biographicalDepthPolicy ?? createDefaultBiographicalDepthPolicy()
  ).full.refreshIntervalMs;
  if (options.biographyCompanionReview) {
    const review = options.biographyCompanionReview;
    scheduler.register({
      id: BIOGRAPHY_COMPANION_REVIEW_TASK_ID,
      name: 'Companion Biography Review',
      description:
        'The companion reviews staged biography candidates about itself and its relationships.',
      scheduleSource: 'settings.json > biographicalDepthPolicy.full.refreshIntervalMs',
      type: 'every',
      intervalMs: biographyRefreshIntervalMs,
      availability: 'do_not_disturb',
      state: 'idle',
      handler: async () => {
        const runId = `biography-review:${randomUUID()}`;
        const governed = await runGovernedAutomataClass({
          runtime: options.automataLifecycle,
          spec: {
            automatonClass: BIOGRAPHY_REVIEW_CLASS,
            runId,
            workerId: BIOGRAPHY_COMPANION_REVIEW_TASK_ID,
            taskId: BIOGRAPHY_COMPANION_REVIEW_TASK_ID,
            taskLabel: 'Review my own biography proposals',
            taskSummary: 'Decide a bounded batch of staged biography candidates about myself and my relationships.',
          },
          briefingQuery: BIOGRAPHY_REVIEW_BRIEFING_QUERY,
          work: async () => await runBiographyStageStandalone({
            label: 'Companion biography review',
            run: async control => await review.run(control),
            summarize: telemetry => (
              `considered=${telemetry.candidatesConsidered} approved=${telemetry.approved} `
              + `rejected=${telemetry.rejected} escalated=${telemetry.escalatedToHumanReview} `
              + `remaining=${telemetry.candidatesRemaining}`
            ),
          }),
        });
        if (governed.status === 'replayed' || governed.value === undefined) return;
        void options.eventBus.emit('memory.biography.companion_review', {
          ...governed.value,
          timestamp: Date.now(),
        });
      },
    }, { skipFirstRun: true });
  }

  if (options.biographySynthesis) {
    const synthesis = options.biographySynthesis;
    scheduler.register({
      id: BIOGRAPHY_SYNTHESIS_TASK_ID,
      name: 'Biography Candidate Synthesis',
      description:
        'Mines subject-authorized memory silos for typed biography candidates and stages them for review.',
      scheduleSource: 'settings.json > biographicalDepthPolicy.full.refreshIntervalMs',
      type: 'every',
      intervalMs: biographyRefreshIntervalMs,
      availability: 'do_not_disturb',
      state: 'idle',
      handler: async () => {
        const runId = `biography-synthesis:${randomUUID()}`;
        const governed = await runGovernedAutomataClass({
          runtime: options.automataLifecycle,
          spec: {
            automatonClass: BIOGRAPHY_SYNTHESIS_CLASS,
            runId,
            workerId: BIOGRAPHY_SYNTHESIS_TASK_ID,
            taskId: BIOGRAPHY_SYNTHESIS_TASK_ID,
            taskLabel: 'Synthesize portable biography candidates',
            taskSummary: 'Scan changed subject-authorized silos for typed biography candidates and stage them for review.',
          },
          briefingQuery: BIOGRAPHY_SYNTHESIS_BRIEFING_QUERY,
          work: async () => await runBiographyStageStandalone({
            label: 'Biography synthesis',
            run: async control => await synthesis.run(control),
            summarize: telemetry => (
              `targets=${telemetry.targetsScanned} unchanged=${telemetry.targetsUnchanged} `
              + `staged=${telemetry.candidatesStaged} remaining=${telemetry.targetsRemaining}`
            ),
          }),
        });
        if (governed.status === 'replayed' || governed.value === undefined) return;
        void options.eventBus.emit('memory.biography.synthesis', {
          ...governed.value,
          timestamp: Date.now(),
        });
      },
    }, { skipFirstRun: true });
  }

  scheduler.registerHeartbeat(async () => {
    const now = Date.now();
    await options.eventBus.emit('schedule.healthcheck', {
      timestamp: now,
      taskCount: scheduler.taskCount,
    });
  });

  registerAmbientPresenceOperation({
    backgroundMaintenance,
    sessionManager: options.sessionManager,
    restWindow: options.schedulerConfig.episodicProcessing,
    eventBus: options.eventBus,
    minIdleMs:
      options.schedulerConfig.backgroundMaintenance.ambientPresence.minIdleMinutes * MS_PER_MINUTE,
    minNoteIntervalMs:
      options.schedulerConfig.backgroundMaintenance.ambientPresence.minNoteIntervalMinutes * MS_PER_MINUTE,
  });

  if (options.concernStore) {
    registerConcernGroomingOperation({
      backgroundMaintenance,
      concernStore: options.concernStore,
      eventBus: options.eventBus,
      maxActiveConcerns:
        options.schedulerConfig.backgroundMaintenance.concernGrooming.maxActiveConcerns,
      routeDispatcher: createDefaultConcernRouteDispatcher({
        companionDataDir: options.pathSnapshot.companionDataDir,
        eventBus: options.eventBus,
      }),
      resolutionVadProvider: (concern, asOf) => resolveCurrentInternalStateConcernVAD(
        concern,
        options.agentLoop.getCurrentInternalState(),
        asOf,
      ),
    });
  }

  if (
    options.contactStore
    && options.socialGraphProposalStore
    && options.socialGraphWatermarkStore
  ) {
    const contactStore = options.contactStore;
    const memoryStore = options.memoryStore;
    const builderCadence = options.schedulerConfig.socialGraphBuilder;
    const socialGraphBuilder = new SocialGraphBuilderWorker({
      memoryReader: createSocialGraphBuilderMemoryReader({
        listRoomChannelIds: async () => (
          await contactStore.listKnownRooms({ limit: builderCadence.scanMemoryLimit })
        ).map(room => room.channelId),
        getMemoriesByChannel: (channelId, limit) => memoryStore.getMemoriesByChannel(channelId, limit),
      }),
      contacts: contactStore,
      proposalStore: options.socialGraphProposalStore,
      watermarkStore: options.socialGraphWatermarkStore,
      config: {
        coPresenceMinSessions: builderCadence.coPresenceMinSessions,
        coPresenceWindowMinutes: builderCadence.coPresenceWindowMinutes,
        scanMemoryLimit: builderCadence.scanMemoryLimit,
      },
      onComplete: (telemetry) => {
        void options.eventBus.emit('memory.social_graph.builder', {
          ...telemetry,
          timestamp: Date.now(),
        });
        if (telemetry.proposed > 0 || telemetry.conflicts > 0) {
          emitGardenQueueChanged(options.eventBus, 'graph-proposals');
        }
      },
    });
    const automataLifecycle = options.automataLifecycle;
    backgroundMaintenance.registerOperation({
      id: SOCIAL_GRAPH_BUILDER_OPERATION_ID,
      name: 'Social Graph Builder',
      description:
        'Scans bounded room-memory evidence and creates operator-reviewed social-graph proposals.',
      handler: async () => {
        await runGovernedAutomataClass({
          runtime: automataLifecycle,
          spec: {
            automatonClass: SOCIAL_GRAPH_BUILDER_CLASS,
            runId: `social-graph-builder:${randomUUID()}`,
            workerId: SOCIAL_GRAPH_BUILDER_OPERATION_ID,
            taskId: SOCIAL_GRAPH_BUILDER_OPERATION_ID,
            taskLabel: 'Build social-graph proposals',
            taskSummary:
              'Scan bounded room-memory evidence and propose operator-reviewed social-graph edges.',
          },
          briefingQuery: SOCIAL_GRAPH_BUILDER_BRIEFING_QUERY,
          work: async () => {
            const telemetry = await socialGraphBuilder.run();
            return {
              value: telemetry,
              summary: `Social-graph builder: scanned=${telemetry.scanned} `
                + `proposed=${telemetry.proposed} conflicts=${telemetry.conflicts} `
                + `deduped=${telemetry.deduped}`,
            };
          },
        });
      },
      eligibility: { requiredTokens: ['memory.write'] },
    });
    log.info('Social-graph builder worker registered', {
      intervalMs: options.schedulerConfig.backgroundMaintenance.intervalMs,
      coPresenceMinSessions: builderCadence.coPresenceMinSessions,
    });
  }

  const postTurnActions = wirePostTurnActionRuntime({
    eventBus: options.eventBus,
    scheduler,
    agentLoop: options.agentLoop,
    eligibilityGate: options.eligibilityGate,
    persistencePath: resolvePostTurnActionQueuePath(options.pathSnapshot.companionDataDir),
  });
  log.info(`Memory system enabled (${options.embeddingDims}d embeddings)`);
  return {
    scheduler,
    postTurnActions,
    backgroundMaintenance,
    compressionGuidelineEvolution,
  };
}
