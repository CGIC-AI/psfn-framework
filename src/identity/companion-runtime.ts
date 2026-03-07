import type { SubstrateConfig } from '../types.js';
import { loadCharacterCard } from './loader.js';
import type { CharacterCardV2 } from './types.js';
import {
  DEFAULT_COMPANION_NAME,
  normalizeCompanionName,
} from './companion-naming.js';

export function resolveCompanionNameFromCard(
  card: CharacterCardV2 | null | undefined,
  fallback = DEFAULT_COMPANION_NAME,
): string {
  return normalizeCompanionName(card?.data.name, fallback);
}

export function resolveCompanionNameFromConfig(
  config: Pick<SubstrateConfig, 'characterCardPath' | 'characterName'> | null | undefined,
  fallback = DEFAULT_COMPANION_NAME,
): string {
  const configuredName = normalizeCompanionName(config?.characterName, fallback);
  const cardPath = config?.characterCardPath.trim();
  if (!cardPath) return configuredName;

  try {
    return resolveCompanionNameFromCard(loadCharacterCard(cardPath), configuredName);
  } catch {
    return configuredName;
  }
}
