import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { loadCharacterCard } from './loader.js';
import type { CharacterCardV2 } from './types.js';

function requireCompanionId(value: string | null | undefined, source: string): string {
  const trimmed = value?.trim();
  if (trimmed) return trimmed;
  throw new Error(`Missing companion ID from ${source}: explicit deployment identity is required`);
}

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

export function resolveCompanionIdFromConfig(
  config: Pick<SubstrateConfig, 'companionId'> | null | undefined,
): string {
  return requireCompanionId(config?.companionId, 'runtime config');
}

export function resolveCompanionIdentityFromConfig(
  config: Pick<SubstrateConfig, 'companionId' | 'characterCardPath' | 'characterName'> | null | undefined,
): {
  companionId: string;
  companionName: string;
} {
  return {
    companionId: resolveCompanionIdFromConfig(config),
    companionName: resolveCompanionNameFromConfig(config),
  };
}
