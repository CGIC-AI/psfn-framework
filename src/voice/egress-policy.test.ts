import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsTtsClient } from './elevenlabs.js';
import { DeepgramSttClient } from './deepgram.js';

const mockFetch = vi.fn();

describe('voice egress policy', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects direct ElevenLabs egress when disabled', async () => {
    const client = new ElevenLabsTtsClient({
      apiKey: 'test-key',
      voiceId: 'test-voice',
      modelId: 'eleven_turbo_v2_5',
      endpointBase: 'https://api.elevenlabs.io/v1',
      allowDirectNetworkEgress: false,
    });

    await expect(client.synthesize('hello')).rejects.toThrow('Direct network egress is disabled');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects direct Deepgram egress when disabled', async () => {
    const client = new DeepgramSttClient({
      apiKey: 'test-key',
      model: 'nova-3',
      endpoint: 'https://api.deepgram.com/v1/listen',
      allowDirectNetworkEgress: false,
    });

    await expect(client.transcribeWav(Buffer.from([1, 2, 3]))).rejects.toThrow('Direct network egress is disabled');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
