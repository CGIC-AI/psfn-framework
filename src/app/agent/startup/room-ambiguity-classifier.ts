// Room ambiguity classifier wiring (epic 4lf3r, site `room.ambiguity`).
//
// Constructed only when the owner opted in twice — scheduler.json
// roomSignal.classifier.enabled and settings.json
// decisionBackend.sites["room.ambiguity"].enabled (with its threshold) — so a
// default or local-only install sees no new model call. A companion fleet
// (multiCompanion) is refused: one physical message must be classified at most
// once across processes, and only an in-process claim exists today.

import type { DecisionRuntime } from '../../../primitives/llm/decision/decide.js';
import { SharedRoomClassifier } from '../../../core/participation/room-signal.js';
import {
  DecisionRoomAmbiguityClassifier,
  InProcessRoomClassificationClaim,
} from '../../../core/participation/room-ambiguity-decision.js';
import type { RoomSignalSettings } from '../../../system/config/participation-config.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { createComponentLogger } from '../../../shared/logger.js';

const log = createComponentLogger('room-ambiguity-classifier');

export function buildRoomAmbiguityClassifier(input: {
  config: Pick<SubstrateConfig, 'multiCompanion' | 'decisionBackend' | 'companionId'>;
  roomSignalSettings: RoomSignalSettings;
  decisions: DecisionRuntime | undefined;
}): SharedRoomClassifier | undefined {
  const { config, roomSignalSettings, decisions } = input;
  if (!roomSignalSettings.classifier.enabled) return undefined;
  if (config.decisionBackend?.sites['room.ambiguity']?.enabled !== true || !decisions) {
    log.warn('Room ambiguity classifier is enabled in scheduler.json but decisionBackend.sites["room.ambiguity"] is not; ambiguity stays suppressed');
    return undefined;
  }
  if (config.multiCompanion === true) {
    log.warn('Room ambiguity classifier needs a durable cross-process claim in a companion fleet; ambiguity stays suppressed');
    return undefined;
  }
  return new SharedRoomClassifier({
    classifier: new DecisionRoomAmbiguityClassifier({
      decisions,
      classifier: roomSignalSettings.classifier,
      ...(config.companionId ? { companionId: config.companionId } : {}),
    }),
    claims: new InProcessRoomClassificationClaim(roomSignalSettings.featureCacheSize),
    settings: roomSignalSettings,
  });
}
