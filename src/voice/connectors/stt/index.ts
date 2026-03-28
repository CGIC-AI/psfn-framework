import { createDeepgramStreamingSttConnector, type DeepgramStreamingSttConfig } from './deepgram-stream.js';
import type { EligibilityRequirements } from '../../../system/capabilities/eligibility.js';
import type { CredentialVaultPort } from '../../../custody/credential-vault.js';
import { resolveInlineOrEnvCredential } from '../../../custody/credential-vault.js';
import type { StreamingSttConnector } from './types.js';

export * from './types.js';
export * from './deepgram-stream.js';

export type StreamingSttProvider = 'deepgram' | (string & {});

export interface StreamingSttConfigByProvider {
  deepgram: DeepgramStreamingSttConfig;
  [provider: string]: unknown;
}

export interface StreamingSttProviderRuntimeConfig {
  [key: string]: unknown;
  credentialVault?: CredentialVaultPort;
  deepgramApiKey?: string;
  deepgramModel?: string;
  deepgramSttEndpoint?: string;
}

export interface StreamingSttProviderMetadata {
  isConfigured(config: StreamingSttProviderRuntimeConfig): boolean;
  eligibility?: EligibilityRequirements;
}

export interface StreamingSttProviderRegistration<TConfig = unknown> {
  createConnector: (config: TConfig) => StreamingSttConnector;
  metadata: StreamingSttProviderMetadata;
  resolveRuntimeConfig?: (config: StreamingSttProviderRuntimeConfig) => TConfig;
}

type AnyStreamingSttProviderRegistration = StreamingSttProviderRegistration<any>;

function resolveDeepgramApiKey(config: StreamingSttProviderRuntimeConfig): string | undefined {
  return resolveInlineOrEnvCredential(
    config.deepgramApiKey,
    config.credentialVault,
    'DEEPGRAM_API_KEY',
  );
}

const providerRegistrations = new Map<string, AnyStreamingSttProviderRegistration>([
  ['deepgram', {
    createConnector: createDeepgramStreamingSttConnector,
    metadata: {
      isConfigured: (config) => Boolean(resolveDeepgramApiKey(config)),
      eligibility: { requiredTokens: ['external.web'] },
    },
    resolveRuntimeConfig: (config) => {
      const apiKey = resolveDeepgramApiKey(config) ?? '';
      if (!apiKey) {
        throw new Error('Deepgram STT provider selected but DEEPGRAM_API_KEY is not configured');
      }

      const model = typeof config.deepgramModel === 'string'
        ? config.deepgramModel.trim()
        : '';
      if (!model) {
        throw new Error('Deepgram STT provider selected but deepgramModel is not configured in settings.json');
      }
      const endpoint = typeof config.deepgramSttEndpoint === 'string'
        ? config.deepgramSttEndpoint.trim()
        : '';
      if (!endpoint) {
        throw new Error('Deepgram STT provider selected but deepgramSttEndpoint is not configured in settings.json');
      }

      return {
        apiKey,
        model,
        endpoint,
      };
    },
  }],
]);

function normalizeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (!normalized) {
    throw new Error('Streaming STT provider id must be a non-empty string');
  }
  if (normalized === 'disabled') {
    throw new Error('Streaming STT provider id "disabled" is reserved');
  }
  return normalized;
}

export function listStreamingSttProviders(): StreamingSttProvider[] {
  return [...providerRegistrations.keys()] as StreamingSttProvider[];
}

export function isStreamingSttProvider(provider: string): provider is StreamingSttProvider {
  if (provider.trim().length === 0) return false;
  return providerRegistrations.has(provider.trim().toLowerCase());
}

export function registerStreamingSttProvider<TProvider extends StreamingSttProvider>(
  provider: TProvider,
  registration: StreamingSttProviderRegistration<StreamingSttConfigByProvider[TProvider]>,
): () => void {
  const providerId = normalizeProviderId(provider);
  const previousRegistration = providerRegistrations.get(providerId);
  providerRegistrations.set(providerId, registration as AnyStreamingSttProviderRegistration);

  return () => {
    if (previousRegistration) {
      providerRegistrations.set(providerId, previousRegistration);
      return;
    }
    providerRegistrations.delete(providerId);
  };
}

export function getStreamingSttProviderMetadata(
  provider: StreamingSttProvider,
): StreamingSttProviderMetadata | null {
  return providerRegistrations.get(normalizeProviderId(provider))?.metadata ?? null;
}

export function isStreamingSttProviderConfigured(
  provider: StreamingSttProvider,
  config: StreamingSttProviderRuntimeConfig,
): boolean {
  const metadata = getStreamingSttProviderMetadata(provider);
  return metadata?.isConfigured(config) ?? false;
}

export function getStreamingSttProviderEligibility(
  provider: StreamingSttProvider,
): EligibilityRequirements | null {
  return getStreamingSttProviderMetadata(provider)?.eligibility ?? null;
}

export function createStreamingSttConnector<TProvider extends StreamingSttProvider>(
  provider: TProvider,
  config: StreamingSttConfigByProvider[TProvider],
): StreamingSttConnector {
  const registration = providerRegistrations.get(normalizeProviderId(provider));
  if (registration) {
    return registration.createConnector(config);
  }

  throw new Error(`Unsupported streaming STT provider: ${provider}`);
}

export function resolveStreamingSttRuntimeConfig<TProvider extends StreamingSttProvider>(
  provider: TProvider,
  config: StreamingSttProviderRuntimeConfig,
): StreamingSttConfigByProvider[TProvider] {
  const registration = providerRegistrations.get(normalizeProviderId(provider));
  if (!registration) {
    throw new Error(`Unsupported streaming STT provider: ${provider}`);
  }
  if (!registration.resolveRuntimeConfig) {
    throw new Error(`Streaming STT provider "${provider}" does not expose runtime bootstrap config`);
  }

  return registration.resolveRuntimeConfig(config);
}
