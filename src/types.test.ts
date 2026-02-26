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
});
