import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import { createIcpFeltImpulseInitiationAdapter } from '../../core/icp/felt-impulse-initiation.js';
import type { KnownCompanionPeerAvailability } from '../../core/icp/agent-facing-autonomy.js';
import { createIcpInitiationSourceRuntime } from '../../core/icp/initiation-source-runtime.js';
import { createLlmIcpInitiationConsentEvaluator } from '../../core/icp/initiation-consent-evaluator.js';
import { createIcpIntentionCandidateAdapter } from '../../core/icp/intention-candidate-adapter.js';
import { registerIcpCoLocationThoughtAdapter } from '../../core/icp/co-location-thought-adapter.js';
import { createIcpWeightedThoughtCandidateAdapter } from '../../core/icp/weighted-thought-candidate-adapter.js';
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
  /** Unsubscribe the felt-impulse lever listener (no-op when not wired). */
  unregisterFeltImpulseAdapter: () => void;
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
  const intentionCandidateAdapter = sourceRuntime && input.peers
    ? createIcpIntentionCandidateAdapter({
        sourceRuntime,
        peers: input.peers,
        pendingFollowUpStore: input.pendingFollowUpStore,
        concernStore: input.concernStore,
        candidateStore: input.candidateStore,
        ...(input.socialDesireStore ? { socialDesireStore: input.socialDesireStore } : {}),
      })
    : undefined;
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
  // The emo-sim proactivity sidecar's would_message lever is the initiating
  // impulse: the observer-sidecar lever stage publishes
  // 'icp.felt_impulse.lever' on the bus, and this subscription turns it into
  // an ICP initiation candidate through the same source runtime every other
  // source uses (consent, preflight, permits, retry/TTL unchanged).
  let unregisterFeltImpulseAdapter: () => void = () => undefined;
  if (sourceRuntime && input.peerDirectory) {
    const feltImpulseAdapter = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime,
      peers: input.peerDirectory,
      isAuthorized,
      eventBus: input.eventBus,
    });
    unregisterFeltImpulseAdapter = input.eventBus.on('icp.felt_impulse.lever', async (signal) => {
      await feltImpulseAdapter.onLeverSignal(signal);
    });
    log.info('ICP felt-impulse initiation source wired to the emo-sim would_message lever');
  } else if (input.config.enabled) {
    // Explicit, not silent: autonomy is on but the affect-driven impulse has
    // no path (no source runtime or no peer directory in this topology).
    log.warn('ICP felt-impulse initiation source NOT wired', {
      hasSourceRuntime: Boolean(sourceRuntime),
      hasPeerDirectory: Boolean(input.peerDirectory),
      hint: 'requires multi-companion topology (candidate store + peers) and the observer-sidecar levers enabled',
    });
  }

  return {
    runtimeEnablement,
    sourceRuntime,
    weightedThoughtCandidateAdapter,
    intentionCandidateAdapter,
    unregisterCoLocationThoughtAdapter,
    unregisterFeltImpulseAdapter,
  };
}
