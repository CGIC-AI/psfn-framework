// ── Provider / model / voice surface discovery (psfn-framework-wckv.1.2) ──
// The set of selectable providers is derived from the runtime contracts, never
// a hand-maintained list. Only *presentational* defaults (labels, default base
// URLs, conventional env-var names) live here; an unknown provider type fails
// closed rather than silently falling back.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANONICAL_PROVIDER_TYPES } from '../../src/shared/contracts/runtime-base.js';
import { listStreamingSttProviders } from '../../src/primitives/voice/connectors/stt/index.js';
import { listStreamingTtsProviders } from '../../src/primitives/voice/connectors/tts/index.js';
import { isRecord } from '../../src/shared/utils/types.js';

export interface ProviderTypeInfo {
  type: string;
  label: string;
  /** Default OpenAI-compatible base URL, when a well-known one exists. */
  defaultApiBaseUrl?: string;
  /** Default models-list URL (openrouter requires one). */
  defaultModelsApiUrl?: string;
  /** Whether apiBaseUrl must be supplied by the operator (no default). */
  requiresApiBaseUrl: boolean;
  /** Whether a modelsApiUrl is required by the providers contract. */
  requiresModelsApiUrl: boolean;
  /** Conventional uppercase env var name for the key. */
  defaultApiKeyEnvName: string;
}

// Presentational metadata keyed by canonical type. The AUTHORITATIVE list is
// CANONICAL_PROVIDER_TYPES; this map only decorates it. A type present in the
// contract but missing here is surfaced as an error (fail closed), so adding a
// provider type upstream forces an onboarding update rather than a stale UX.
const PROVIDER_TYPE_METADATA: Record<string, Omit<ProviderTypeInfo, 'type'>> = {
  openrouter: {
    label: 'OpenRouter',
    defaultApiBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModelsApiUrl: 'https://openrouter.ai/api/v1/models',
    requiresApiBaseUrl: true,
    requiresModelsApiUrl: true,
    defaultApiKeyEnvName: 'OPENROUTER_API_KEY',
  },
  openai: {
    label: 'OpenAI',
    defaultApiBaseUrl: 'https://api.openai.com/v1',
    requiresApiBaseUrl: true,
    requiresModelsApiUrl: false,
    defaultApiKeyEnvName: 'OPENAI_API_KEY',
  },
  anthropic: {
    label: 'Anthropic',
    defaultApiBaseUrl: 'https://api.anthropic.com/v1',
    requiresApiBaseUrl: true,
    requiresModelsApiUrl: false,
    defaultApiKeyEnvName: 'ANTHROPIC_API_KEY',
  },
  google: {
    label: 'Google (Gemini)',
    defaultApiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresApiBaseUrl: true,
    requiresModelsApiUrl: false,
    defaultApiKeyEnvName: 'GOOGLE_API_KEY',
  },
  mistral: {
    label: 'Mistral',
    defaultApiBaseUrl: 'https://api.mistral.ai/v1',
    requiresApiBaseUrl: true,
    requiresModelsApiUrl: false,
    defaultApiKeyEnvName: 'MISTRAL_API_KEY',
  },
  litellm_proxy: {
    label: 'LiteLLM proxy (self-hosted router)',
    requiresApiBaseUrl: true,
    requiresModelsApiUrl: false,
    defaultApiKeyEnvName: 'LITELLM_API_KEY',
  },
  generic_openai: {
    label: 'Generic OpenAI-compatible endpoint',
    requiresApiBaseUrl: true,
    requiresModelsApiUrl: false,
    defaultApiKeyEnvName: 'OPENAI_API_KEY',
  },
};

/**
 * The selectable provider types, derived from the runtime contract. Throws if
 * the contract advertises a type this onboarding flow has no metadata for.
 */
export function discoverProviderTypes(): ProviderTypeInfo[] {
  return CANONICAL_PROVIDER_TYPES.map((type) => {
    const metadata = PROVIDER_TYPE_METADATA[type];
    if (!metadata) {
      throw new Error(
        `Onboarding is out of date: provider type "${type}" is in the runtime contract `
        + '(CANONICAL_PROVIDER_TYPES) but has no onboarding metadata. Add it to '
        + 'scripts/onboarding/discovery.ts before shipping.',
      );
    }
    return { type, ...metadata };
  });
}

export interface ModelSuggestion {
  id: string;
  slug: string;
  provider: string;
  role: 'primary' | 'extraction' | 'catalog';
}

/**
 * Read model slug suggestions from the canonical models seed. Used only to
 * pre-fill defaults; the operator may type any slug their provider serves.
 */
export function discoverModelSuggestions(seedDir: string): ModelSuggestion[] {
  const seed = readSeedJson(join(seedDir, 'models.seed.json'));
  const models = isRecord(seed) && Array.isArray(seed.models) ? seed.models : [];
  const suggestions: ModelSuggestion[] = [];
  for (const raw of models) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === 'string' ? raw.id : undefined;
    const identity = isRecord(raw.identity) ? raw.identity : undefined;
    const slug = identity && typeof identity.model === 'string' ? identity.model : undefined;
    const provider = identity && typeof identity.provider === 'string' ? identity.provider : 'openrouter';
    if (!id || !slug) continue;
    const role: ModelSuggestion['role'] = id === 'primary'
      ? 'primary'
      : id === 'extraction'
        ? 'extraction'
        : 'catalog';
    suggestions.push({ id, slug, provider, role });
  }
  return suggestions;
}

/** Default primary/extraction slugs from the seed, falling back to known-good values. */
export function defaultModelSlugs(seedDir: string): { primary: string; extraction: string } {
  const suggestions = discoverModelSuggestions(seedDir);
  const primary = suggestions.find((s) => s.role === 'primary')?.slug ?? 'z-ai/glm-5';
  const extraction = suggestions.find((s) => s.role === 'extraction')?.slug ?? 'deepseek/deepseek-v3.2';
  return { primary, extraction };
}

export interface VoiceProviderSurface {
  sttProviders: string[];
  ttsProviders: string[];
}

/** Registered streaming STT/TTS providers, discovered from the voice connectors. */
export function discoverVoiceProviders(): VoiceProviderSurface {
  return {
    sttProviders: listStreamingSttProviders(),
    ttsProviders: listStreamingTtsProviders(),
  };
}

/** Conventional secret env var name for a voice provider id. */
export function voiceProviderEnvName(kind: 'stt' | 'tts', providerId: string): string | undefined {
  const normalized = providerId.trim().toLowerCase();
  if (normalized === 'deepgram') return 'DEEPGRAM_API_KEY';
  if (normalized === 'elevenlabs') return 'ELEVENLABS_API_KEY';
  // echo and any keyless provider need no secret.
  void kind;
  return undefined;
}

function readSeedJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read model seed at ${path}: ${reason}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Model seed at ${path} is not valid JSON: ${reason}`);
  }
}
