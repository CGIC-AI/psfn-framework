import type { SubstrateConfig } from '../types.js';
import { loadSettings, saveSettings, type EditableSettings } from '../settings.js';
import {
  createEmbeddingDimensionMismatchWarning,
  type EmbeddingDimensionValidationResult,
} from '../backup/startup-checks.js';
import type { RuntimeChannelsConfigOverrides } from '../channels/config.js';
import {
  isStreamingSttProvider,
  isStreamingSttProviderConfigured,
  resolveDefaultStreamingSttProvider,
  type StreamingSttProvider,
} from '../voice/connectors/stt/index.js';
import {
  isStreamingTtsProvider,
  isStreamingTtsProviderConfigured,
  resolveDefaultStreamingTtsProvider,
  type StreamingTtsProvider,
} from '../voice/connectors/tts/index.js';

export type RuntimeVoiceSttProvider = StreamingSttProvider | 'disabled';
export type RuntimeVoiceTtsProvider = StreamingTtsProvider | 'disabled';

export interface RuntimeVoiceProviderGateOptions {
  allowEchoDefaults?: boolean;
  requireElevenLabsVoiceId?: boolean;
}

export interface RuntimeVoiceProviderGate {
  sttProvider: RuntimeVoiceSttProvider;
  ttsProvider: RuntimeVoiceTtsProvider;
  sttEnabled: boolean;
  ttsEnabled: boolean;
}

export function resolveRuntimeVoiceSttProvider(config: SubstrateConfig): RuntimeVoiceSttProvider {
  const configured = config.sttProvider;
  if (configured === 'disabled') return configured;
  if (typeof configured === 'string') {
    const normalized = configured.trim().toLowerCase();
    if (!normalized) {
      throw new Error('Invalid runtime voice STT provider: provider id cannot be empty');
    }
    if (!isStreamingSttProvider(normalized)) {
      throw new Error(`Unsupported runtime voice STT provider: ${configured}`);
    }
    return normalized;
  }

  return resolveDefaultStreamingSttProvider(config) ?? 'disabled';
}

export function resolveRuntimeVoiceTtsProvider(config: SubstrateConfig): RuntimeVoiceTtsProvider {
  const configured = config.ttsProvider;
  if (configured === 'disabled') return configured;
  if (typeof configured === 'string') {
    const normalized = configured.trim().toLowerCase();
    if (!normalized) {
      throw new Error('Invalid runtime voice TTS provider: provider id cannot be empty');
    }
    if (!isStreamingTtsProvider(normalized)) {
      throw new Error(`Unsupported runtime voice TTS provider: ${configured}`);
    }
    return normalized;
  }

  return resolveDefaultStreamingTtsProvider(config) ?? 'disabled';
}

export function resolveRuntimeVoiceProviderGate(
  config: SubstrateConfig,
  options: RuntimeVoiceProviderGateOptions = {},
): RuntimeVoiceProviderGate {
  const sttProvider = resolveRuntimeVoiceSttProvider(config);
  const ttsProvider = resolveRuntimeVoiceTtsProvider(config);
  const sttEnabled = sttProvider !== 'disabled' && isStreamingSttProviderConfigured(sttProvider, config);
  const ttsEnabled = ttsProvider !== 'disabled'
    && isStreamingTtsProviderConfigured(ttsProvider, config, options);

  return {
    sttProvider,
    ttsProvider,
    sttEnabled,
    ttsEnabled,
  };
}

export function buildRuntimeChannelsConfigOverrides(
  config: SubstrateConfig,
  settings: EditableSettings,
): RuntimeChannelsConfigOverrides {
  const telegramOverride: RuntimeChannelsConfigOverrides['telegram'] = {};

  if (Object.hasOwn(settings, 'telegramEnabled')) {
    telegramOverride.enabled = config.telegramEnabled ?? false;
  }
  if (Object.hasOwn(settings, 'telegramAuthorizedUsers')) {
    telegramOverride.allowedUsers = config.telegramAuthorizedUsers
      ? [...config.telegramAuthorizedUsers]
      : [];
  }

  if (telegramOverride.enabled === undefined && telegramOverride.allowedUsers === undefined) {
    return {};
  }

  return {
    telegram: telegramOverride,
  };
}

export function createEmbeddingDimensionMismatchFatalMessage(
  result: EmbeddingDimensionValidationResult,
): string | null {
  const mismatchWarning = createEmbeddingDimensionMismatchWarning(result);
  if (!mismatchWarning) return null;
  return `${mismatchWarning.message}: configured=${mismatchWarning.configuredDims}, stored=${mismatchWarning.storedDims}. ${mismatchWarning.recommendation}`;
}

export function installPromotedToolsPersistenceHook(config: SubstrateConfig): void {
  const existingHooks = config.runtimeHooks ?? {};
  config.runtimeHooks = {
    ...existingHooks,
    persistPromotedExtendedTools: (toolNames) => {
      const current = loadSettings(config.dataDir);
      saveSettings(config.dataDir, {
        ...current,
        promotedExtendedTools: [...toolNames],
      });
    },
  };
}
