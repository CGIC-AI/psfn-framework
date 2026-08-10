import type { LlmResponseProviderId, LlmResponseTarget } from './types.js';

const KNOWN_PROVIDERS = new Set<LlmResponseProviderId>(['fixture', 'openrouter', 'deepseek']);
const LIVE_PROVIDERS = new Set<LlmResponseProviderId>(['openrouter', 'deepseek']);

export function parseTarget(rawTarget: string): LlmResponseTarget {
  const trimmed = rawTarget.trim();
  const separatorIndex = trimmed.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    throw new Error(`Target "${rawTarget}" must use provider:model syntax`);
  }

  const providerId = trimmed.slice(0, separatorIndex).trim();
  const modelId = trimmed.slice(separatorIndex + 1).trim();
  if (!isKnownProvider(providerId)) {
    throw new Error(`Unknown LLM response provider "${providerId}"`);
  }
  if (!modelId) {
    throw new Error(`Target "${rawTarget}" must include a model id`);
  }

  return { providerId, modelId };
}

export function parseTargets(rawTargets: readonly string[]): LlmResponseTarget[] {
  const targets = rawTargets.length === 0 ? ['fixture:fixture-response-model'] : rawTargets;
  return targets.map(parseTarget);
}

export function isLiveProvider(providerId: LlmResponseProviderId): boolean {
  return LIVE_PROVIDERS.has(providerId);
}

export function secretSourceNamesForTarget(target: LlmResponseTarget): string[] {
  switch (target.providerId) {
    case 'fixture':
      return [];
    case 'openrouter':
      return ['OPENROUTER_API_KEY'];
    case 'deepseek':
      return ['DEEPSEEK_API_KEY'];
  }
}

function isKnownProvider(providerId: string): providerId is LlmResponseProviderId {
  return KNOWN_PROVIDERS.has(providerId as LlmResponseProviderId);
}
