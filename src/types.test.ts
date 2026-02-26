import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './types.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('loadConfig voice DAVE options', () => {
  it('uses DAVE defaults when env values are unset', () => {
    delete process.env.DISCORD_VOICE_DAVE_ENCRYPTION;
    delete process.env.DISCORD_VOICE_DECRYPTION_FAILURE_TOLERANCE;

    const config = loadConfig();

    expect(config.voiceDaveEncryption).toBe(true);
    expect(config.voiceDecryptionFailureTolerance).toBe(24);
  });

  it('applies DAVE env overrides', () => {
    process.env.DISCORD_VOICE_DAVE_ENCRYPTION = 'false';
    process.env.DISCORD_VOICE_DECRYPTION_FAILURE_TOLERANCE = '9';

    const config = loadConfig();

    expect(config.voiceDaveEncryption).toBe(false);
    expect(config.voiceDecryptionFailureTolerance).toBe(9);
  });

  it('parses import-processing routing env values', () => {
    process.env.OPENROUTER_PROVIDER_ORDER = 'parasail,openai,parasail';
    process.env.IMPORT_PROCESSING_ROUTE_MODE = 'openrouter_zdr';
    process.env.IMPORT_PROCESSING_STRICT_POLICY = 'true';
    process.env.IMPORT_PROCESSING_LOCAL_ENDPOINT_URL = 'http://localhost:11434/v1';
    process.env.IMPORT_PROCESSING_LOCAL_MODEL = 'llama3.2:latest';

    const config = loadConfig();

    expect(config.openRouterProviderOrder).toEqual(['parasail', 'openai']);
    expect(config.importProcessingRouteMode).toBe('openrouter_zdr');
    expect(config.importProcessingStrictPolicy).toBe(true);
    expect(config.importProcessingLocalEndpointUrl).toBe('http://localhost:11434/v1');
    expect(config.importProcessingLocalModel).toBe('llama3.2:latest');
  });
});
