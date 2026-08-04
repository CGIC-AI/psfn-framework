import { resolveCandidates } from '../../../primitives/llm/model-hint-routing.js';
import { resolveRoutingCandidates } from '../../../primitives/llm/routing.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { EditableSettings } from '../../../system/settings.js';
import type {
  EffectiveModelSelectionProjection,
  EffectiveModelSelectionView,
} from './types.js';

function toChatSelectionView(
  candidate: ReturnType<typeof resolveCandidates>[number] | undefined,
  source: EffectiveModelSelectionView['source'],
): EffectiveModelSelectionView | null {
  return candidate
    ? {
        purpose: 'chat',
        source,
        ...(candidate.slotKey ? { slotKey: candidate.slotKey } : {}),
        provider: candidate.provider,
        model: candidate.model,
      }
    : null;
}

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
  const fleetDefaultCandidate = resolveRoutingCandidates(config, 'chat').at(0);

  return {
    chat: toChatSelectionView(
      candidate,
      selectedSlotKey ? 'companion_selection' : 'fleet_default',
    ),
    fleetDefaultChat: toChatSelectionView(fleetDefaultCandidate, 'fleet_default'),
  };
}
