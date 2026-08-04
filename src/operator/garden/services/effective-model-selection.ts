import { resolveCandidates } from '../../../primitives/llm/model-hint-routing.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { EditableSettings } from '../../../system/settings.js';
import type { EffectiveModelSelectionProjection } from './types.js';

/**
 * Project the same chat candidate the gateway resolves for a companion turn.
 *
 * In fleet mode the companion agent transports its overlay-selected slot on
 * the wire, so the shared gateway resolver deliberately ignores any gateway
 * process-local selection. Passing the effective companion slot as a hint here
 * mirrors that production path while leaving the fleet catalog untouched.
 */
export function buildEffectiveModelSelectionProjection(
  config: SubstrateConfig,
  effectiveRuntimeSettings: EditableSettings,
): EffectiveModelSelectionProjection {
  const selectedSlotKey = effectiveRuntimeSettings.modelPurposeSelection?.chat;
  const candidate = resolveCandidates(
    config,
    'chat',
    selectedSlotKey ? { slotKey: selectedSlotKey } : undefined,
  ).at(0);

  return {
    chat: candidate
      ? {
          purpose: 'chat',
          source: selectedSlotKey ? 'companion_selection' : 'fleet_default',
          ...(candidate.slotKey ? { slotKey: candidate.slotKey } : {}),
          provider: candidate.provider,
          model: candidate.model,
        }
      : null,
  };
}
