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

  it('parses web fetch lane env values', () => {
    process.env.ALLOW_HTTP_FETCH = 'true';
    process.env.FETCH_DOMAIN_ALLOWLIST = 'example.com,docs.example.com';
    process.env.FETCH_LOCAL_CRAWLER_ENABLED = 'true';
    process.env.FETCH_LOCAL_CRAWLER_ALLOW_HTTP = 'true';
    process.env.FETCH_LOCAL_CRAWLER_HOST_ALLOWLIST = 'localhost,127.0.0.1';
    process.env.FETCH_LOCAL_CRAWLER_DOMAIN_ALLOWLIST = 'crawler.local';
    process.env.FETCH_TLS_CA_CERT_PATHS = '/etc/ssl/root.pem,/etc/ssl/intermediate.pem';

    const config = loadConfig();

    expect(config.webFetchAllowHttp).toBe(true);
    expect(config.webFetchDomainAllowlist).toEqual(['example.com', 'docs.example.com']);
    expect(config.webFetchLocalCrawlerEnabled).toBe(true);
    expect(config.webFetchLocalCrawlerAllowHttp).toBe(true);
    expect(config.webFetchLocalCrawlerHostAllowlist).toEqual(['localhost', '127.0.0.1']);
    expect(config.webFetchLocalCrawlerDomainAllowlist).toEqual(['crawler.local']);
    expect(config.webFetchTlsCaCertPaths).toEqual(['/etc/ssl/root.pem', '/etc/ssl/intermediate.pem']);
  });
});

describe('loadConfig TTS provider options', () => {
  it('defaults to elevenlabs when provider env vars are unset', () => {
    delete process.env.TTS_PROVIDER;
    delete process.env.VOICE_TTS_PROVIDER;
    delete process.env.ECHO_TTS_URL;
    delete process.env.ECHO_TTS_VOICE;
    delete process.env.ECHO_TTS_PRESET;
    delete process.env.ECHO_TTS_MODEL;

    const config = loadConfig();

    expect(config.ttsProvider).toBe('elevenlabs');
    expect(config.echoTtsUrl).toBeUndefined();
    expect(config.echoTtsVoice).toBeUndefined();
    expect(config.echoTtsPreset).toBeUndefined();
    expect(config.echoTtsModel).toBeUndefined();
  });

  it('parses echo provider and settings env vars', () => {
    process.env.TTS_PROVIDER = 'echo';
    process.env.ECHO_TTS_URL = 'http://127.0.0.1:5050/v1/audio/speech';
    process.env.ECHO_TTS_VOICE = 'echo-voice-1';
    process.env.ECHO_TTS_PRESET = 'normal';
    process.env.ECHO_TTS_MODEL = 'echo-v1';

    const config = loadConfig();

    expect(config.ttsProvider).toBe('echo');
    expect(config.echoTtsUrl).toBe('http://127.0.0.1:5050/v1/audio/speech');
    expect(config.echoTtsVoice).toBe('echo-voice-1');
    expect(config.echoTtsPreset).toBe('normal');
    expect(config.echoTtsModel).toBe('echo-v1');
  });

  it('falls back to elevenlabs when provider env var is invalid', () => {
    process.env.TTS_PROVIDER = 'definitely-not-a-provider';

    const config = loadConfig();

    expect(config.ttsProvider).toBe('elevenlabs');
  });
});
