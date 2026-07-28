import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANONICAL_PROVIDER_TYPES } from '../../src/shared/contracts/runtime-base.js';
import {
  defaultModelSlugs,
  discoverModelSuggestions,
  discoverProviderTypes,
  discoverVoiceProviders,
  voiceProviderEnvName,
} from './discovery.js';

const SEED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../config');

describe('provider surface discovery', () => {
  it('covers exactly the canonical provider types from the contract', () => {
    const discovered = discoverProviderTypes().map((info) => info.type).sort();
    expect(discovered).toEqual([...CANONICAL_PROVIDER_TYPES].sort());
  });

  it('marks openrouter as requiring a models URL and others not', () => {
    const byType = new Map(discoverProviderTypes().map((info) => [info.type, info]));
    expect(byType.get('openrouter')?.requiresModelsApiUrl).toBe(true);
    expect(byType.get('openai')?.requiresModelsApiUrl).toBe(false);
  });
});

describe('model suggestion discovery from the seed', () => {
  it('reads primary/extraction defaults from models.seed.json (not hardcoded)', () => {
    const suggestions = discoverModelSuggestions(SEED_DIR);
    expect(suggestions.some((s) => s.role === 'primary')).toBe(true);
    expect(suggestions.some((s) => s.role === 'extraction')).toBe(true);
    const defaults = defaultModelSlugs(SEED_DIR);
    expect(defaults.primary.length).toBeGreaterThan(0);
    expect(defaults.extraction.length).toBeGreaterThan(0);
  });
});

describe('voice provider discovery', () => {
  it('discovers registered stt/tts providers from the connectors', () => {
    const surface = discoverVoiceProviders();
    expect(surface.sttProviders).toContain('deepgram');
    expect(surface.ttsProviders).toContain('elevenlabs');
  });

  it('maps known voice providers to their secret env names', () => {
    expect(voiceProviderEnvName('stt', 'deepgram')).toBe('DEEPGRAM_API_KEY');
    expect(voiceProviderEnvName('tts', 'elevenlabs')).toBe('ELEVENLABS_API_KEY');
    expect(voiceProviderEnvName('tts', 'echo')).toBeUndefined();
  });
});
