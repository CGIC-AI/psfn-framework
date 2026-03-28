import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { EmotionObserver } from '../../emotion/observer.js';
import { EmotionState } from '../../emotion/state.js';
import { getSharedAudioEmotionClassifier } from '../../emotion/audio-classifier.js';
import { composeIdentity } from '../../bootstrap/composition.js';
import { buildAgentCoreRuntime, type AgentCoreRuntime } from '../../agent-main/core-runtime.js';
import { CharacterCardVersionStore } from '../../identity/card-versioning.js';
import { resolveCharacterCardHistoryPath, type RuntimePathSnapshot } from '../../persistence/layout.js';
import { createStartupTextEmotionClassifier, warmRuntimeMlServices } from '../../runtime/ml-warmup.js';
import {
  createRuntimeSafeguardSurfaces,
  type RuntimeSafeguardSurfaces,
} from '../../runtime/safeguard-surfaces.js';
import { createGatewayNtfyNotifier, type NtfyNotifier } from '../../tools/ntfy.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { GatewayClient } from '../../boundary/gateway/client.js';
import type { CharacterCardV2 } from '../../identity/types.js';
import type { CapabilityRuntime } from '../../system/capabilities/runtime.js';
import { ConfirmationQueue } from '../../system/capabilities/confirmation-queue.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { MemoryStore } from '../../memory/store.js';

const log = createComponentLogger('Agent');

export interface BootstrappedAgentCoreRuntime {
  card: CharacterCardV2;
  systemPrompt: string;
  cardVersionStore: CharacterCardVersionStore;
  cardProposalQueue: ConfirmationQueue;
  coreRuntime: AgentCoreRuntime;
  emotionState: EmotionState;
  operatorNotifier: NtfyNotifier;
  safeguardSurfaces: Pick<
    RuntimeSafeguardSurfaces,
    'safeguardAuditTrail' | 'lifecycleRestartSafeguard' | 'externalRateLimiter'
  >;
}

export interface BootstrapAgentCoreRuntimeOptions {
  config: SubstrateConfig;
  pathSnapshot: RuntimePathSnapshot;
  eventBus: EventBus;
  gateway: GatewayClient;
  db: Database.Database;
  memoryStore: MemoryStore;
  capabilityRuntime: CapabilityRuntime;
}

export async function bootstrapAgentCoreRuntime(
  options: BootstrapAgentCoreRuntimeOptions,
): Promise<BootstrappedAgentCoreRuntime> {
  const {
    config,
    pathSnapshot,
    eventBus,
    gateway,
    db,
    memoryStore,
    capabilityRuntime,
  } = options;

  const { card, systemPrompt } = composeIdentity(config);
  const cardVersionStore = new CharacterCardVersionStore(
    config.characterCardPath,
    resolveCharacterCardHistoryPath(pathSnapshot.companionDataDir),
  );
  const cardProposalQueue = new ConfirmationQueue({
    idFactory: () => `card-${randomUUID()}`,
  });
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
  const operatorNotifier = createGatewayNtfyNotifier(gateway);
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
    db,
    memoryStore,
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
    identityCoolingOff,
    primaryUserId: process.env.PRIMARY_USER_ID ?? process.env.DISCORD_VOICE_USER_ID,
    primaryTelegramUserId: (
      process.env.PRIMARY_TELEGRAM_USER_ID
      ?? process.env.TELEGRAM_PRIMARY_USER_ID
      ?? ''
    ).trim() || undefined,
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
