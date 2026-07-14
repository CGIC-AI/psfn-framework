import type { EventBus } from '../../shared/event-bus.js';
import { createIcpInitiationSourceRuntime } from '../../core/icp/initiation-source-runtime.js';
import { createLlmIcpInitiationConsentEvaluator } from '../../core/icp/initiation-consent-evaluator.js';
import { createIcpIntentionCandidateAdapter } from '../../core/icp/intention-candidate-adapter.js';
import { registerIcpCoLocationThoughtAdapter } from '../../core/icp/co-location-thought-adapter.js';
import { createIcpWeightedThoughtCandidateAdapter } from '../../core/icp/weighted-thought-candidate-adapter.js';

type SourceRuntimeOptions = Parameters<typeof createIcpInitiationSourceRuntime>[0];
type ConsentEvaluatorOptions = Parameters<typeof createLlmIcpInitiationConsentEvaluator>[0];
type IntentionAdapterOptions = Parameters<typeof createIcpIntentionCandidateAdapter>[0];
type CoLocationAdapterOptions = Parameters<typeof registerIcpCoLocationThoughtAdapter>[0];

export interface IcpInitiationSourceWiringInput {
  localCompanionId: string | undefined;
  candidateStore: SourceRuntimeOptions['store'] | undefined;
  peers: SourceRuntimeOptions['peers'] | undefined;
  gateway: SourceRuntimeOptions['gateway'];
  isExternalCompanionAuthorized: SourceRuntimeOptions['isExternalCompanionAuthorized'];
  llmProvider: ConsentEvaluatorOptions['llmProvider'];
  eventBus: EventBus;
  pendingFollowUpStore: IntentionAdapterOptions['pendingFollowUpStore'];
  concernStore: IntentionAdapterOptions['concernStore'];
  presenceEnabled: boolean;
  contactStore: CoLocationAdapterOptions['contactStore'];
  weightedThoughtStore: CoLocationAdapterOptions['thoughtStore'] | undefined;
  lifecycleConfig: CoLocationAdapterOptions['lifecycleConfig'];
}

export interface IcpInitiationSourceWiring {
  sourceRuntime: ReturnType<typeof createIcpInitiationSourceRuntime> | undefined;
  weightedThoughtCandidateAdapter:
    | ReturnType<typeof createIcpWeightedThoughtCandidateAdapter>
    | undefined;
  intentionCandidateAdapter: ReturnType<typeof createIcpIntentionCandidateAdapter> | undefined;
  unregisterCoLocationThoughtAdapter: () => void;
}

/** Keep ICP source composition out of the already-large agent entrypoint. */
export function wireIcpInitiationSources(
  input: IcpInitiationSourceWiringInput,
): IcpInitiationSourceWiring {
  const sourceRuntime = input.candidateStore && input.peers && input.localCompanionId
    ? createIcpInitiationSourceRuntime({
        localCompanionId: input.localCompanionId,
        store: input.candidateStore,
        peers: input.peers,
        gateway: input.gateway,
        consent: createLlmIcpInitiationConsentEvaluator({ llmProvider: input.llmProvider }),
        isExternalCompanionAuthorized: input.isExternalCompanionAuthorized,
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
      })
    : undefined;
  const unregisterCoLocationThoughtAdapter = (
    input.presenceEnabled && input.weightedThoughtStore && input.localCompanionId
  )
    ? registerIcpCoLocationThoughtAdapter({
        eventBus: input.eventBus,
        localCompanionId: input.localCompanionId,
        contactStore: input.contactStore,
        thoughtStore: input.weightedThoughtStore,
        lifecycleConfig: input.lifecycleConfig,
      })
    : () => undefined;

  return {
    sourceRuntime,
    weightedThoughtCandidateAdapter,
    intentionCandidateAdapter,
    unregisterCoLocationThoughtAdapter,
  };
}
