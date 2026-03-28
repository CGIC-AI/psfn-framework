import type { SubstrateConfig } from '../system/config/runtime-config-contracts.js';
import { loadCharacterCard } from './loader.js';
import type { CharacterCardV2 } from './types.js';

function requireCompanionName(value: string | null | undefined, source: string): string {
  const trimmed = value?.trim();
  if (trimmed) return trimmed;
  throw new Error(`Missing companion name from ${source}: explicit identity is required`);
}

export function resolveCompanionNameFromCard(
  card: CharacterCardV2 | null | undefined,
): string {
  return requireCompanionName(card?.data.name, 'character card');
}

export function resolveCompanionNameFromConfig(
  config: Pick<SubstrateConfig, 'characterCardPath' | 'characterName'> | null | undefined,
): string {
  const cardPath = typeof config?.characterCardPath === 'string'
    ? config.characterCardPath.trim()
    : '';
  if (cardPath) {
    return resolveCompanionNameFromCard(loadCharacterCard(cardPath));
  }

  return requireCompanionName(config?.characterName, 'configured character name');
}
