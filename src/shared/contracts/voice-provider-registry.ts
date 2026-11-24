// ── Voice provider identifier registry (psfn-framework-kbdvl.1) ──
//
// Pure provider-id vocabulary shared between core config/settings coercion and
// host streaming STT/TTS connector registries.

export type StreamingSttProvider = 'deepgram' | (string & {});
export type StreamingTtsProvider = 'elevenlabs' | 'echo' | (string & {});

const registeredSttProviderIds = new Set<string>(['deepgram']);
const registeredTtsProviderIds = new Set<string>(['elevenlabs', 'echo']);

export function isStreamingSttProvider(provider: string): provider is StreamingSttProvider {
  if (provider.trim().length === 0) return false;
  return registeredSttProviderIds.has(provider.trim().toLowerCase());
}

export function isStreamingTtsProvider(provider: string): provider is StreamingTtsProvider {
  if (provider.trim().length === 0) return false;
  return registeredTtsProviderIds.has(provider.trim().toLowerCase());
}

export function registerStreamingSttProviderId(providerId: string): () => void {
  const normalized = providerId.trim().toLowerCase();
  const existed = registeredSttProviderIds.has(normalized);
  registeredSttProviderIds.add(normalized);
  return () => {
    if (!existed) {
      registeredSttProviderIds.delete(normalized);
    }
  };
}

export function registerStreamingTtsProviderId(providerId: string): () => void {
  const normalized = providerId.trim().toLowerCase();
  const existed = registeredTtsProviderIds.has(normalized);
  registeredTtsProviderIds.add(normalized);
  return () => {
    if (!existed) {
      registeredTtsProviderIds.delete(normalized);
    }
  };
}
