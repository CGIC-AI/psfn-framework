import type { SubstrateConfig } from '../types.js';
import { loadSettings, saveSettings, type EditableSettings } from '../settings.js';
import {
  createEmbeddingDimensionMismatchWarning,
  type EmbeddingDimensionValidationResult,
} from '../backup/startup-checks.js';
import type { RuntimeChannelsConfigOverrides } from '../channels/config.js';
import type { StreamingTtsProvider } from '../voice/connectors/tts/index.js';

export type RuntimeVoiceSttProvider = 'deepgram' | 'disabled';
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
  const configured = (config as SubstrateConfig & { sttProvider?: RuntimeVoiceSttProvider }).sttProvider;
  if (configured === 'deepgram' || configured === 'disabled') return configured;
  return config.deepgramApiKey ? 'deepgram' : 'disabled';
}

export function resolveRuntimeVoiceTtsProvider(config: SubstrateConfig): RuntimeVoiceTtsProvider {
  const configured = (config as SubstrateConfig & { ttsProvider?: RuntimeVoiceTtsProvider }).ttsProvider;
  if (configured === 'elevenlabs' || configured === 'echo' || configured === 'disabled') return configured;
  return 'elevenlabs';
}

export function resolveRuntimeVoiceProviderGate(
  config: SubstrateConfig,
  options: RuntimeVoiceProviderGateOptions = {},
): RuntimeVoiceProviderGate {
  const sttProvider = resolveRuntimeVoiceSttProvider(config);
  const ttsProvider = resolveRuntimeVoiceTtsProvider(config);
  const sttEnabled = sttProvider === 'deepgram' && Boolean(config.deepgramApiKey);

  const allowEchoDefaults = options.allowEchoDefaults === true;
  const requireElevenLabsVoiceId = options.requireElevenLabsVoiceId === true;

  let ttsEnabled = false;
  if (ttsProvider === 'echo') {
    ttsEnabled = allowEchoDefaults || Boolean(config.echoTtsUrl && config.echoTtsVoice);
  } else if (ttsProvider === 'elevenlabs') {
    ttsEnabled = requireElevenLabsVoiceId
      ? Boolean(config.elevenLabsApiKey && config.elevenLabsVoiceId)
      : Boolean(config.elevenLabsApiKey);
  }

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
