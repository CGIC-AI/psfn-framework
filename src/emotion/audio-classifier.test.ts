import { describe, expect, it, vi } from 'vitest';
import {
  AudioEmotionClassifier,
  toAudioEmotionSignal,
  type AudioEmotionClassification,
} from './audio-classifier.js';

function createRuntimeHarness(result: { emotion?: string; event?: string }) {
  const acceptWaveform = vi.fn();
  const createStream = vi.fn().mockReturnValue({ acceptWaveform });
  const decode = vi.fn();
  const getResult = vi.fn().mockReturnValue(result);
  const OfflineRecognizer = vi.fn().mockImplementation(function OfflineRecognizerMock() {
    return {
      createStream,
      decode,
      getResult,
    };
  });
  const runtimeLoader = vi.fn().mockResolvedValue({
    OfflineRecognizer,
  });
  return {
    runtimeLoader,
    OfflineRecognizer,
    acceptWaveform,
    decode,
    getResult,
  };
}

describe('AudioEmotionClassifier', () => {
  it('lazily loads sherpa runtime and maps SenseVoice emotion/event labels', async () => {
    const harness = createRuntimeHarness({
      emotion: '<|HAPPY|>',
      event: '<|Laughter|>',
    });

    const classifier = new AudioEmotionClassifier({
      modelPath: '/tmp/model.int8.onnx',
      tokensPath: '/tmp/tokens.txt',
      runtimeLoader: harness.runtimeLoader,
    });

    expect(harness.runtimeLoader).not.toHaveBeenCalled();

    const pcm = Buffer.from([0, 0, 255, 127, 0, 128]);
    const classifications = await classifier.classify(pcm, 16_000);

    expect(harness.runtimeLoader).toHaveBeenCalledTimes(1);
    expect(harness.OfflineRecognizer).toHaveBeenCalledTimes(1);
    expect(harness.acceptWaveform).toHaveBeenCalledTimes(1);
    const waveformArg = harness.acceptWaveform.mock.calls[0][0] as {
      sampleRate: number;
      samples: Float32Array;
    };
    expect(waveformArg.sampleRate).toBe(16_000);
    expect(waveformArg.samples.length).toBe(3);
    expect(waveformArg.samples[0]).toBeCloseTo(0, 6);
    expect(waveformArg.samples[1]).toBeCloseTo(32767 / 32768, 6);
    expect(waveformArg.samples[2]).toBeCloseTo(-1, 6);

    expect(classifications).toEqual([
      { label: 'joy', score: 1, source: 'emotion' },
      { label: 'event:laughter', score: 1, source: 'event' },
    ]);
  });

  it('fails at use-time when model/tokens config is missing and never initializes runtime', async () => {
    const runtimeLoader = vi.fn();
    const classifier = new AudioEmotionClassifier({
      runtimeLoader,
    });

    await expect(classifier.classify(Buffer.from([0, 0]), 16_000)).rejects.toThrow(
      'SenseVoice audio emotion model configuration is required at use-time.',
    );
    expect(runtimeLoader).not.toHaveBeenCalled();
  });

  it('retries lazy initialization after runtime loader failure', async () => {
    const harness = createRuntimeHarness({
      emotion: '<|NEUTRAL|>',
      event: '<|Speech|>',
    });
    const runtimeLoader = vi.fn()
      .mockRejectedValueOnce(new Error('native module unavailable'))
      .mockResolvedValueOnce({
        OfflineRecognizer: harness.OfflineRecognizer,
      });

    const classifier = new AudioEmotionClassifier({
      modelPath: '/tmp/model.int8.onnx',
      tokensPath: '/tmp/tokens.txt',
      runtimeLoader,
    });

    await expect(classifier.classify(Buffer.from([0, 0]), 16_000)).rejects.toThrow('native module unavailable');
    await expect(classifier.classify(Buffer.from([0, 0]), 16_000)).resolves.toEqual([
      { label: 'neutral', score: 1, source: 'emotion' },
      { label: 'event:speech', score: 1, source: 'event' },
    ]);

    expect(runtimeLoader).toHaveBeenCalledTimes(2);
    expect(harness.OfflineRecognizer).toHaveBeenCalledTimes(1);
  });

  it('builds an audio emotion signal for multimodal fusion seams', () => {
    const classifications: AudioEmotionClassification[] = [
      { label: 'joy', score: 0.6, source: 'emotion' },
      { label: 'anger', score: 0.9, source: 'emotion' },
      { label: 'event:laughter', score: 1, source: 'event' },
      { label: 'event:laughter', score: 1, source: 'event' },
      { label: 'event:applause', score: 1, source: 'event' },
    ];

    const signal = toAudioEmotionSignal(classifications);

    expect(signal.strongestEmotionLabel).toBe('anger');
    expect(signal.strongestEmotionScore).toBeCloseTo(0.9, 6);
    expect(signal.observation.discrete).toEqual({ anger: 1 });
    expect(signal.observation.confidence).toBeCloseTo(0.9, 6);
    expect(signal.events).toEqual(['applause', 'laughter']);
  });
});
