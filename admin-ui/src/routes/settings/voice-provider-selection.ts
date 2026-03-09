const DISABLED_PROVIDER_ID = 'disabled';

interface VoiceProviderConfig {
  ttsProvider?: unknown;
  sttProvider?: unknown;
}

export interface VoiceProviderSelection {
  ttsProvider: string;
  sttProvider: string;
}

function normalizeProviderSelection(value: unknown): string {
  if (typeof value !== 'string') return DISABLED_PROVIDER_ID;
  const normalized = value.trim();
  return normalized || DISABLED_PROVIDER_ID;
}

export function resolveVoiceProviderSelection(config: VoiceProviderConfig): VoiceProviderSelection {
  return {
    ttsProvider: normalizeProviderSelection(config.ttsProvider),
    sttProvider: normalizeProviderSelection(config.sttProvider),
  };
}
