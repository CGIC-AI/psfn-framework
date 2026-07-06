import { randomUUID } from 'node:crypto';
import { EmotionObserver } from '../../core/emotion/observer.js';
import { EmotionState } from '../../core/emotion/state.js';
import { getSharedAudioEmotionClassifier } from '../../core/emotion/audio-classifier.js';
import { composeIdentity } from '../startup/composition/composition.js';
import { buildAgentCoreRuntime, type AgentCoreRuntime } from './core-runtime.js';
import { CharacterCardVersionStore } from '../../core/identity/card-versioning.js';
import { resolveCharacterCardHistoryPath, type RuntimePathSnapshot } from '../../persistence/layout.js';
import { createStartupTextEmotionClassifier, warmRuntimeMlServices } from '../startup/support/ml-warmup.js';
import {
  createRuntimeSafeguardSurfaces,
  type RuntimeSafeguardSurfaces,
} from '../startup/support/safeguard-surfaces.js';
import { createGatewayNotificationPort, type NotificationPort } from '../../core/tools/ntfy.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { GatewayClient } from '../../boundary/gateway/client.js';
import type { CharacterCardV2 } from '../../core/identity/types.js';
import type { CapabilityRuntime } from '../../system/capabilities/runtime.js';
import { ConfirmationQueue } from '../../system/capabilities/confirmation-queue.js';
import {
  createApprovalQueuePortFromConfirmationQueue,
  type ApprovalQueuePort,
} from '../../system/capabilities/approval-queue-port.js';
import type { CoreSubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import type {
  EpisodicStorePort,
} from '../../faculties/memory/episodic/store-port.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { ContactTrackingGate } from '../../core/contacts/tracking-gate.js';
import type {
  IntentionRuntimeProviders,
  IntentionRuntimeWiring,
} from '../../core/intention/runtime-wiring.js';

const log = createComponentLogger('Agent');

export interface BootstrappedAgentCoreRuntime {
  card: CharacterCardV2;
  systemPrompt: string;
  cardVersionStore: CharacterCardVersionStore;
  cardProposalQueue: ApprovalQueuePort;
  coreRuntime: AgentCoreRuntime;
  emotionState: EmotionState;
  operatorNotifier: NotificationPort;
  safeguardSurfaces: Pick<
    RuntimeSafeguardSurfaces,
    'safeguardAuditTrail' | 'lifecycleRestartSafeguard' | 'externalRateLimiter'
  >;
}

export interface BootstrapAgentCoreRuntimeOptions {
  config: CoreSubstrateConfig;
  pathSnapshot: RuntimePathSnapshot;
  eventBus: EventBus;
  gateway: GatewayClient;
  memoryStore: MemoryStorePort;
  episodicStore: EpisodicStorePort;
  contactStore?: ContactStorePort;
  intentionRuntime?: IntentionRuntimeWiring;
  intentionProviders?: IntentionRuntimeProviders;
  capabilityRuntime: CapabilityRuntime;
  /** Contact-tracking policy gate (E3.4). Absent gate behaves as 'auto' everywhere. */
  contactTrackingGate?: ContactTrackingGate | null;
}

export async function bootstrapAgentCoreRuntime(
  options: BootstrapAgentCoreRuntimeOptions,
): Promise<BootstrappedAgentCoreRuntime> {
  const {
    config,
    pathSnapshot,
    eventBus,
    gateway,
    memoryStore,
    episodicStore,
    contactStore,
    intentionRuntime,
    intentionProviders,
    capabilityRuntime,
  } = options;

  const { card, systemPrompt } = composeIdentity(config);
  const cardVersionStore = new CharacterCardVersionStore(
    config.characterCardPath,
    resolveCharacterCardHistoryPath(pathSnapshot.companionDataDir),
  );
  const cardProposalQueue = createApprovalQueuePortFromConfirmationQueue(new ConfirmationQueue({
    idFactory: () => `card-${randomUUID()}`,
  }));
  log.info(`Loaded character: ${card.data.name}`);
  config.characterName = card.data.name;

  const textClassifier = createStartupTextEmotionClassifier({
    model: config.textEmotionModel,
    cacheDir: config.textEmotionCacheDir,
    dtype: config.textEmotionDtype,
  });
  await warmRuntimeMlServices({
    textClassifier,
    embeddingService: gateway,
    textEmotionModel: config.textEmotionModel!.trim(),
    logger: log,
  });

  const emotionObserver = new EmotionObserver({
    textClassifier,
    audioClassifier: getSharedAudioEmotionClassifier(),
  });
  const emotionState = new EmotionState();
  const operatorNotifier = createGatewayNotificationPort(gateway);
  const {
    safeguardAuditTrail,
    identityCoolingOff,
    lifecycleRestartSafeguard,
    externalRateLimiter,
  } = createRuntimeSafeguardSurfaces(pathSnapshot.companionDataDir, process.env);

  const coreRuntime = await buildAgentCoreRuntime({
    config,
    pathSnapshot,
    eventBus,
    gateway,
    memoryStore,
    episodicStore,
    contactStore,
    card,
    systemPrompt,
    capabilityRuntime,
    cardVersionStore,
    cardProposalQueue,
    emotionRuntime: {
      observer: emotionObserver,
      state: emotionState,
      requireWiring: true,
    },
    operatorNotifier,
    intentionRuntime,
    intentionProviders,
    identityCoolingOff,
    primaryUserId: config.voiceTargetUserId?.trim() || process.env.PRIMARY_USER_ID,
    primaryTelegramUserId: (
      process.env.PRIMARY_TELEGRAM_USER_ID
      ?? process.env.TELEGRAM_PRIMARY_USER_ID
      ?? ''
    ).trim() || undefined,
    contactTrackingGate: options.contactTrackingGate ?? null,
  });

  return {
    card,
    systemPrompt,
    cardVersionStore,
    cardProposalQueue,
    coreRuntime,
    emotionState,
    operatorNotifier,
    safeguardSurfaces: {
      safeguardAuditTrail,
      lifecycleRestartSafeguard,
      externalRateLimiter,
    },
  };
}
