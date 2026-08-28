import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import { createIcpFeltImpulseInitiationAdapter } from '../../core/icp/felt-impulse-initiation.js';
import type { KnownCompanionPeerAvailability } from '../../core/icp/agent-facing-autonomy.js';
import type { IcpFeltImpulseFunnelStorePort } from '../../core/icp/felt-impulse-funnel.js';
import { parseFeltImpulseCorrelationFirstCrossingMs } from '../../core/icp/felt-impulse-funnel.js';
import { createIcpInitiationSourceRuntime } from '../../core/icp/initiation-source-runtime.js';
import { createLlmIcpInitiationConsentEvaluator } from '../../core/icp/initiation-consent-evaluator.js';
import { createIcpIntentionCandidateAdapter } from '../../core/icp/intention-candidate-adapter.js';
import { registerIcpCoLocationThoughtAdapter } from '../../core/icp/co-location-thought-adapter.js';
import { createIcpWeightedThoughtCandidateAdapter } from '../../core/icp/weighted-thought-candidate-adapter.js';
import { createIcpCandidateLifecycleSupervisor } from '../../core/icp/candidate-lifecycle-supervisor.js';
import type { IcpAutonomySchedulerConfig } from '../../system/config/icp-autonomy-scheduler-config.js';
import {
  createIcpAutonomyRuntimeEnablement,
  type IcpAutonomyRuntimeEnablement,
} from '../../core/icp/runtime-enablement.js';

type SourceRuntimeOptions = Parameters<typeof createIcpInitiationSourceRuntime>[0];
type ConsentEvaluatorOptions = Parameters<typeof createLlmIcpInitiationConsentEvaluator>[0];
type IntentionAdapterOptions = Parameters<typeof createIcpIntentionCandidateAdapter>[0];
type CoLocationAdapterOptions = Parameters<typeof registerIcpCoLocationThoughtAdapter>[0];

export interface IcpInitiationSourceWiringInput {
  config: IcpAutonomySchedulerConfig;
  localCompanionId: string | undefined;
  candidateStore: SourceRuntimeOptions['store'] | undefined;
  feltImpulseFunnelStore: IcpFeltImpulseFunnelStorePort;
  peers: SourceRuntimeOptions['peers'] | undefined;
  gateway: SourceRuntimeOptions['gateway'];
  isExternalCompanionAuthorized: SourceRuntimeOptions['isExternalCompanionAuthorized'];
  llmProvider: ConsentEvaluatorOptions['llmProvider'];
  eventBus: EventBus;
  pendingFollowUpStore: IntentionAdapterOptions['pendingFollowUpStore'];
  concernStore: IntentionAdapterOptions['concernStore'];
  /** Durable social-desire recheck for consented desire provenance (oth4.2). */
  socialDesireStore: IntentionAdapterOptions['socialDesireStore'];
  presenceEnabled: boolean;
  contactStore: CoLocationAdapterOptions['contactStore'];
  weightedThoughtStore: CoLocationAdapterOptions['thoughtStore'] | undefined;
  lifecycleConfig: CoLocationAdapterOptions['lifecycleConfig'];
  /**
   * Peer directory for the affect-driven felt-impulse source (hrmrq.34, D4):
   * the agent-facing autonomy runtime's canonical-peer listing. Absent in
   * single-companion topologies — the felt-impulse subscription is then not
   * wired, and the omission is logged explicitly.
   */
  peerDirectory?: {
    listKnownPeerAvailability(): Promise<KnownCompanionPeerAvailability[]>;
  };
}

export interface IcpInitiationSourceWiring {
  runtimeEnablement: IcpAutonomyRuntimeEnablement;
  sourceRuntime: ReturnType<typeof createIcpInitiationSourceRuntime> | undefined;
  weightedThoughtCandidateAdapter:
    | ReturnType<typeof createIcpWeightedThoughtCandidateAdapter>
    | undefined;
  intentionCandidateAdapter: ReturnType<typeof createIcpIntentionCandidateAdapter> | undefined;
  unregisterCoLocationThoughtAdapter: () => void;
  /** Unsubscribe the EmoSim proactivity listener (no-op when not wired). */
  unregisterFeltImpulseAdapter: () => void;
  /** Stops and drains the source-independent durable candidate owner. */
  stopCandidateLifecycleSupervisor: () => Promise<void>;
}

const log = createComponentLogger('IcpInitiationSourceWiring');

/** Keep ICP source composition out of the already-large agent entrypoint. */
export function wireIcpInitiationSources(
  input: IcpInitiationSourceWiringInput,
): IcpInitiationSourceWiring {
  const runtimeEnablement = createIcpAutonomyRuntimeEnablement(input.config.enabled);
  const isAuthorized = () => runtimeEnablement.isEnabled()
    && input.isExternalCompanionAuthorized();
  const sourceRuntime = input.config.enabled
    && input.candidateStore && input.peers && input.localCompanionId
    ? createIcpInitiationSourceRuntime({
        localCompanionId: input.localCompanionId,
        store: input.candidateStore,
        peers: input.peers,
        gateway: input.gateway,
        consent: createLlmIcpInitiationConsentEvaluator({ llmProvider: input.llmProvider }),
        isExternalCompanionAuthorized: isAuthorized,
        policy: {
          candidateDefaultTtlMs: input.config.candidate.defaultTtlMs,
          retryCadenceMs: input.config.candidate.retryCadenceMs,
          maxRetryAttempts: input.config.candidate.maxRetryAttempts,
          permitTtlMs: input.config.permit.ttlMs,
        },
        eventBus: input.eventBus,
      })
    : undefined;
  const weightedThoughtCandidateAdapter = sourceRuntime && input.peers
    ? createIcpWeightedThoughtCandidateAdapter({ sourceRuntime, peers: input.peers })
    : undefined;
  const intentionCandidateAdapter = sourceRuntime && input.peers && input.candidateStore
    ? createIcpIntentionCandidateAdapter({
        sourceRuntime,
        peers: input.peers,
        pendingFollowUpStore: input.pendingFollowUpStore,
        concernStore: input.concernStore,
        candidateStore: input.candidateStore,
        ...(input.socialDesireStore ? { socialDesireStore: input.socialDesireStore } : {}),
      })
    : undefined;
  const candidateLifecycleSupervisor = sourceRuntime
    && input.candidateStore?.createClaimedCandidate
    && input.candidateStore.claimCandidate
    && input.candidateStore.renewCandidateClaim
    && input.candidateStore.releaseCandidateClaim
    && input.candidateStore.claimDueCandidates
    && input.candidateStore.transitionClaimedCandidate
    ? createIcpCandidateLifecycleSupervisor({
        store: input.candidateStore,
        sourceRuntime,
        retryCadenceMs: Math.min(
          input.config.candidate.retryCadenceMs,
          Math.max(1, Math.floor(input.config.permit.ttlMs / 3)),
        ),
        claimLeaseMs: Math.max(1, Math.floor(input.config.permit.ttlMs / 3)),
        batchSize: input.config.policyHolds.maxOutstanding,
      })
    : undefined;
  candidateLifecycleSupervisor?.start();
  const unregisterCoLocationThoughtAdapter = (
    input.config.enabled
      && input.presenceEnabled && input.weightedThoughtStore && input.localCompanionId
  )
    ? registerIcpCoLocationThoughtAdapter({
        eventBus: input.eventBus,
        localCompanionId: input.localCompanionId,
        contactStore: input.contactStore,
        thoughtStore: input.weightedThoughtStore,
        lifecycleConfig: input.lifecycleConfig,
      })
    : () => undefined;

  // ── Affect-driven felt-impulse source (hrmrq.34, operator ruling D4) ──
  // The companion-local EmoSim Proactivity Port publishes a provenance-bearing
  // qualified impulse, and this subscription turns it into
  // an ICP initiation candidate through the same source runtime every other
  // source uses (consent, preflight, permits, retry/TTL unchanged).
  let unregisterFeltImpulseAdapter: () => void = () => undefined;
  if (sourceRuntime && input.peerDirectory) {
    const feltImpulseAdapter = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime,
      peers: input.peerDirectory,
      isAuthorized,
      funnelStore: input.feltImpulseFunnelStore,
      eventBus: input.eventBus,
    });
    unregisterFeltImpulseAdapter = input.eventBus.on(
      'emotion.emosim.proactivity.impulse',
      async (signal) => {
        await feltImpulseAdapter.onImpulse(signal);
      },
    );
    log.info('ICP felt-impulse initiation source wired to the EmoSim Proactivity Port');
  } else {
    // Always install one required-event consumer. A disabled or incomplete ICP
    // lane is a terminal fail-closed disposition, not an absent subscriber
    // that makes the observer retry and log the same qualified impulse on each
    // later observation.
    const outcome = input.config.enabled ? 'suppressed' : 'not_authorized';
    const durableOutcome = input.config.enabled ? 'no_eligible_peer' : 'not_authorized';
    const reasonCode = !input.config.enabled
      ? 'autonomy_disabled'
      : sourceRuntime
        ? 'peer_directory_unavailable'
        : 'source_runtime_unavailable';
    unregisterFeltImpulseAdapter = input.eventBus.on('emotion.emosim.proactivity.impulse', async (signal) => {
      const existing = await input.feltImpulseFunnelStore.getOutcome(signal.correlationId);
      if (!existing) {
        await input.feltImpulseFunnelStore.recordOutcome({
          correlationId: signal.correlationId,
          firstCrossingMs: parseFeltImpulseCorrelationFirstCrossingMs(signal.correlationId),
          firedAtMs: signal.firedAtMs,
          recordedAtMs: Date.now(),
          outcome: durableOutcome,
        });
      }
      const emitTransition = async (
        stage: 'felt_impulse' | 'final_disposition',
        transitionOutcome: 'received' | 'suppressed' | 'not_authorized',
      ): Promise<void> => {
        try {
          await input.eventBus.emit('emotion.proactive.transition', {
            correlationId: signal.correlationId,
            lever: signal.kind,
            stage,
            outcome: transitionOutcome,
            firedAtMs: signal.firedAtMs,
            reasonCode,
            timestamp: Date.now(),
          });
        } catch (error) {
          log.warn('ICP felt-impulse terminal transition telemetry failed', {
            correlationId: signal.correlationId,
            stage,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      await emitTransition('felt_impulse', 'received');
      try {
        await input.eventBus.emit('icp.felt_impulse.outcome', {
          correlationId: signal.correlationId,
          outcome,
          reason: reasonCode,
          timestamp: Date.now(),
        });
      } catch (error) {
        log.warn('ICP felt-impulse terminal outcome telemetry failed', {
          correlationId: signal.correlationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await emitTransition('final_disposition', outcome);
    });
    if (input.config.enabled) {
      // Explicit, not silent: autonomy is on but the affect-driven impulse has
      // no candidate path (no source runtime or peer directory in this topology).
      log.warn('ICP felt-impulse initiation source unavailable; terminal suppression wired', {
        hasSourceRuntime: Boolean(sourceRuntime),
        hasPeerDirectory: Boolean(input.peerDirectory),
        hint: 'requires multi-companion topology (candidate store + peers) and the observer-sidecar levers enabled',
      });
    }
  }

  return {
    runtimeEnablement,
    sourceRuntime,
    weightedThoughtCandidateAdapter,
    intentionCandidateAdapter,
    unregisterCoLocationThoughtAdapter,
    unregisterFeltImpulseAdapter,
    stopCandidateLifecycleSupervisor: candidateLifecycleSupervisor
      ? () => candidateLifecycleSupervisor.stop()
      : async () => undefined,
  };
}
