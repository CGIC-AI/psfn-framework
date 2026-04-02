import prism from 'prism-media';
import { createComponentLogger } from '../../logger.js';
import {
  createRuntimeVoiceTtsConnector,
  resolveRuntimeVoiceProviderGate,
  resolveRuntimeVoiceTtsProviderOrder,
} from '../../runtime/bootstrap-helpers.js';
import type { SubstrateConfig } from '../../types.js';
import type { EligibilityGate } from '../../capabilities/eligibility.js';
import type { StreamingTtsConnector, StreamingTtsProvider } from '../../voice/connectors/tts/index.js';
import { toErrorMessage } from '../../utils/errors.js';
import type { OpusAvailabilityResult, VoicePreflightResult } from './voice-types.js';

const log = createComponentLogger('DiscordVoice');

function hasTtsProviderConfig(provider: StreamingTtsProvider, config: SubstrateConfig): boolean {
  try {
    return createRuntimeVoiceTtsConnector(config, {
      provider,
      requireElevenLabsVoiceId: true,
    }) !== null;
  } catch {
    return false;
  }
}

export function buildConfiguredTtsConnectors(
  config: SubstrateConfig,
  preferredProviderId: StreamingTtsProvider,
  eligibilityGate?: EligibilityGate,
): StreamingTtsConnector[] {
  const providerOrder = resolveRuntimeVoiceTtsProviderOrder(
    config,
    preferredProviderId,
    { requireElevenLabsVoiceId: true },
  );
  const connectors: StreamingTtsConnector[] = [];

  for (const providerId of providerOrder) {
    try {
      const binding = createRuntimeVoiceTtsConnector(config, {
        provider: providerId,
        requireElevenLabsVoiceId: true,
        eligibilityGate,
      });
      if (binding) {
        connectors.push(binding.connector);
      }
    } catch (error) {
      log.warn('Discord voice TTS connector initialization failed', {
        provider: providerId,
        error: toErrorMessage(error),
      });
    }
  }

  return connectors;
}

export function checkOpusAvailability(): OpusAvailabilityResult {
  try {
    const decoder = new prism.opus.Decoder({
      rate: 48_000,
      channels: 2,
      frameSize: 960,
    });
    decoder.destroy();

    let backend = 'unknown';
    try {
      if ('module' in prism.opus && typeof (prism.opus as Record<string, unknown>).module === 'string') {
        backend = (prism.opus as Record<string, unknown>).module as string;
      }
    } catch {
      // Ignore introspection failures.
    }

    return { available: true, backend, error: null };
  } catch (error) {
    return {
      available: false,
      backend: null,
      error: toErrorMessage(error),
    };
  }
}

export function voicePreflight(config: SubstrateConfig): VoicePreflightResult {
  const opus = checkOpusAvailability();
  const missingConfig: string[] = [];
  const providerGate = resolveRuntimeVoiceProviderGate(config, {
    requireElevenLabsVoiceId: true,
  });

  if (!config.voiceTargetGuildId) missingConfig.push('VOICE_TARGET_GUILD_ID');
  if (!config.voiceTargetUserId) missingConfig.push('VOICE_TARGET_USER_ID');
  if (!providerGate.sttEnabled) missingConfig.push('VOICE_STT_PROVIDER_CONFIG');

  const configComplete = missingConfig.length === 0;
  const canReceive = opus.available && configComplete;

  if (!opus.available) {
    log.error(
      'No Opus decoder found. Voice receive pipeline will be disabled. '
      + 'Install one of: npm install @discordjs/opus (recommended, native), '
      + 'npm install opusscript (JS fallback, slower). '
      + `Error: ${opus.error}`,
    );
  }

  if (missingConfig.length > 0) {
    log.warn('Voice config incomplete, missing env vars', { missing: missingConfig });
  }

  if (canReceive) {
    log.info('Voice preflight passed', { opusBackend: opus.backend });
  }

  return {
    opusAvailable: opus.available,
    opusBackend: opus.backend,
    configComplete,
    missingConfig,
    canReceive,
  };
}

export function describeMissingVoiceConfig(
  config: SubstrateConfig,
  preferredTtsProviderId: StreamingTtsProvider | 'disabled',
  sttBindingPresent: boolean,
): Record<string, unknown> {
  const hasSelectedTtsConfig = preferredTtsProviderId !== 'disabled'
    ? hasTtsProviderConfig(preferredTtsProviderId, config)
    : false;

  return {
    hasGuild: Boolean(config.voiceTargetGuildId),
    hasUser: Boolean(config.voiceTargetUserId),
    hasSttConfig: sttBindingPresent,
    ttsProvider: preferredTtsProviderId,
    hasSelectedTtsConfig,
    hasElevenLabsConfig: hasTtsProviderConfig('elevenlabs', config),
    hasEchoConfig: hasTtsProviderConfig('echo', config),
  };
}
