import { describe, expect, it, vi } from 'vitest';
import {
  EmotionObserver,
  TEXT_EMOTION_LABEL_VAD_MAP,
  type TextEmotionClassifierLike,
} from './observer.js';
import type {
  AudioEmotionClassification,
  AudioEmotionClassifierLike,
} from './audio-classifier.js';
import { EmotionState } from './state.js';
import type { TextEmotionClassification } from './text-classifier.js';
import type { VadLexicon } from './vad-lexicon.js';

function createClassifier(
  scores: readonly TextEmotionClassification[],
): { classifier: TextEmotionClassifierLike; classify: ReturnType<typeof vi.fn> } {
  const classify = vi.fn().mockResolvedValue(scores);
  return {
    classifier: { classify },
    classify,
  };
}

function createLexicon(
  entries: Record<string, { valence: number; arousal: number; dominance: number }>,
): VadLexicon {
  return new Map(
    Object.entries(entries).map(([token, vad]) => [token, Object.freeze({ ...vad })]),
  );
}

function createAudioClassifier(
  scores: readonly AudioEmotionClassification[],
): { classifier: AudioEmotionClassifierLike; classify: ReturnType<typeof vi.fn> } {
  const classify = vi.fn().mockResolvedValue(scores);
  return {
    classifier: { classify },
    classify,
  };
}

describe('EmotionObserver', () => {
  it('uses classifier-only text signal without lexicon blending', async () => {
    const { classifier } = createClassifier([
      { label: 'joy', score: 0.8 },
      { label: 'anger', score: 0.2 },
      { label: 'neutral', score: 0.1 },
    ]);
    const lexicon = createLexicon({
      steady: { valence: 0.55, arousal: 0.55, dominance: 0.55 },
    });

    const observer = new EmotionObserver({ textClassifier: classifier, vadLexicon: lexicon });
    const result = await observer.observe('steady', 0);

    expect(result.fusedLabel).toBe('joy');
    expect(result.observation.discrete).toEqual({ joy: 1 });
    expect(result.observation.confidence).toBeCloseTo(0.8, 6);

    const joyVad = TEXT_EMOTION_LABEL_VAD_MAP.joy;
    expect(result.observation.vad?.valence).toBeCloseTo(joyVad.valence, 6);
    expect(result.observation.vad?.arousal).toBeCloseTo(joyVad.arousal, 6);
    expect(result.observation.vad?.dominance).toBeCloseTo(joyVad.dominance, 6);
  });

  it('normalizes go-emotions labels to canonical internal labels', async () => {
    const { classifier } = createClassifier([
      { label: 'admiration', score: 0.92 },
      { label: 'joy', score: 0.31 },
    ]);

    const observer = new EmotionObserver({ textClassifier: classifier, vadLexicon: createLexicon({}) });
    const result = await observer.observe('nice work', 0);

    expect(result.fusedLabel).toBe('trust');
    expect(result.observation.discrete).toEqual({ trust: 1 });
    expect(result.observation.confidence).toBeCloseTo(0.92, 6);
  });

  it('does not allow lexicon content to override classifier label or confidence', async () => {
    const { classifier } = createClassifier([
      { label: 'joy', score: 0.2 },
      { label: 'neutral', score: 0.1 },
    ]);
    const lexicon = createLexicon({
      rage: { valence: 0.05, arousal: 0.95, dominance: 0.85 },
    });

    const observer = new EmotionObserver({ textClassifier: classifier, vadLexicon: lexicon });
    const result = await observer.observe('rage', 0);

    expect(result.fusedLabel).toBe('joy');
    expect(result.observation.discrete).toEqual({ joy: 1 });
    expect(result.observation.confidence).toBeCloseTo(0.2, 6);

    const joyVad = TEXT_EMOTION_LABEL_VAD_MAP.joy;
    expect(result.observation.vad?.valence).toBeCloseTo(joyVad.valence, 6);
    expect(result.observation.vad?.arousal).toBeCloseTo(joyVad.arousal, 6);
    expect(result.observation.vad?.dominance).toBeCloseTo(joyVad.dominance, 6);
  });

  it('breaks classifier confidence ties by label for deterministic fused categorical output', async () => {
    const { classifier } = createClassifier([
      { label: 'joy', score: 0.6 },
      { label: 'anger', score: 0.6 },
      { label: 'neutral', score: 0.1 },
    ]);

    const observer = new EmotionObserver({
      textClassifier: classifier,
      vadLexicon: createLexicon({}),
    });
    const result = await observer.observe('unknown-token', 0);

    expect(result.fusedLabel).toBe('anger');
    expect(result.observation.discrete).toEqual({ anger: 1 });
    expect(result.observation.confidence).toBeCloseTo(0.6, 6);
  });

  it('updates EmotionState via decay-then-impulse flow on repeated observes', async () => {
    const { classifier } = createClassifier([
      { label: 'optimism', score: 0.4 },
      { label: 'neutral', score: 0.1 },
    ]);
    const state = new EmotionState({
      vadHalfLifeSeconds: { valence: 10, arousal: 10, dominance: 10 },
      moodAlpha: 0,
      confidenceAlpha: 1,
    });

    const observer = new EmotionObserver({
      state,
      textClassifier: classifier,
      vadLexicon: createLexicon({}),
    });

    const first = await observer.observe('unmatched-token', 0);
    const second = await observer.observe('unmatched-token', 10);

    expect(first.snapshot.vad.valence).toBeCloseTo(TEXT_EMOTION_LABEL_VAD_MAP.optimism.valence * 0.4, 6);
    expect(first.snapshot.vad.arousal).toBeCloseTo(TEXT_EMOTION_LABEL_VAD_MAP.optimism.arousal * 0.4, 6);
    expect(first.snapshot.vad.dominance).toBeCloseTo(TEXT_EMOTION_LABEL_VAD_MAP.optimism.dominance * 0.4, 6);

    expect(second.snapshot.vad.valence).toBeCloseTo((first.snapshot.vad.valence * 1.5), 6);
    expect(second.snapshot.vad.arousal).toBeCloseTo((first.snapshot.vad.arousal * 1.5), 6);
    expect(second.snapshot.vad.dominance).toBeCloseTo((first.snapshot.vad.dominance * 1.5), 6);
    expect(second.snapshot.confidence).toBeCloseTo(0.4, 6);
    expect(observer.getState()).toEqual(second.snapshot);
  });

  it('normalizes and truncates text input to the configured max length', async () => {
    const { classifier, classify } = createClassifier([{ label: 'neutral', score: 1 }]);

    const observer = new EmotionObserver({
      textClassifier: classifier,
      vadLexicon: createLexicon({}),
      maxTextLength: 5,
    });
    await observer.observe('   123456789   ', 0);

    expect(classify).toHaveBeenCalledWith('12345');
  });

  it('fails closed when text classifier throws even with lexicon signal present', async () => {
    const classify = vi.fn().mockRejectedValue(new Error('model unavailable'));
    const observer = new EmotionObserver({
      textClassifier: { classify },
      vadLexicon: createLexicon({
        rage: { valence: 0.05, arousal: 0.95, dominance: 0.85 },
      }),
    });

    await expect(observer.observe('rage', 0)).rejects.toThrow('model unavailable');
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('fails closed when classifier throws and lexicon has no signal', async () => {
    const classify = vi.fn().mockRejectedValue(new Error('cache miss'));
    const observer = new EmotionObserver({
      textClassifier: { classify },
      vadLexicon: createLexicon({}),
    });

    await expect(observer.buildObservation('unknown-token')).rejects.toThrow('cache miss');
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('fails closed when text classifier returns a malformed row before a valid one', async () => {
    const classify = vi.fn().mockResolvedValue([
      undefined,
      { label: 'joy', score: 0.7 },
    ] as unknown as readonly TextEmotionClassification[]);
    const observer = new EmotionObserver({
      textClassifier: { classify },
      vadLexicon: createLexicon({}),
    });

    await expect(observer.buildObservation('unknown-token')).rejects.toThrow(
      'classifications[0] must be an object',
    );
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('fails closed when text classifier returns an out-of-range score', async () => {
    const classify = vi.fn().mockResolvedValue([
      { label: 'joy', score: 1.2 },
    ] as const);
    const observer = new EmotionObserver({
      textClassifier: { classify },
      vadLexicon: createLexicon({}),
    });

    await expect(observer.observe('unknown-token', 0)).rejects.toThrow(
      'classifications[0].score must be between 0 and 1',
    );
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('builds audio modality observations when audio classifier is configured', async () => {
    const { classifier } = createClassifier([{ label: 'neutral', score: 1 }]);
    const { classifier: audioClassifier, classify } = createAudioClassifier([
      { label: 'joy', score: 1, source: 'emotion' },
      { label: 'event:laughter', score: 1, source: 'event' },
    ]);

    const observer = new EmotionObserver({
      textClassifier: classifier,
      audioClassifier,
      vadLexicon: createLexicon({}),
    });
    const audioBuffer = Buffer.from([0, 0]);
    const audio = await observer.buildAudioObservation({
      audioBuffer,
      sampleRate: 16_000,
    });

    expect(classify).toHaveBeenCalledWith(audioBuffer, 16_000);
    expect(audio.observation.discrete).toEqual({ joy: 1 });
    expect(audio.events).toEqual(['laughter']);
  });

  it('fuses text and audio modalities by confidence for multimodal observations', async () => {
    const { classifier: textClassifier } = createClassifier([
      { label: 'joy', score: 0.4 },
      { label: 'neutral', score: 0.2 },
    ]);
    const { classifier: audioClassifier } = createAudioClassifier([
      { label: 'anger', score: 0.9, source: 'emotion' },
      { label: 'event:laughter', score: 1, source: 'event' },
    ]);

    const observer = new EmotionObserver({
      textClassifier,
      audioClassifier,
      vadLexicon: createLexicon({}),
    });

    const result = await observer.buildModalityObservations({
      text: 'unmatched-token',
      audio: {
        audioBuffer: Buffer.from([0, 0]),
        sampleRate: 16_000,
      },
    });

    expect(result.fusedLabel).toBe('anger');
    expect(result.fusedLabelConfidence).toBeCloseTo(0.9, 6);
    expect(result.observation.discrete).toEqual({ anger: 1 });
    expect(result.audio?.events).toEqual(['laughter']);

    const joyVad = TEXT_EMOTION_LABEL_VAD_MAP.joy;
    const angerVad = TEXT_EMOTION_LABEL_VAD_MAP.anger;
    expect(result.observation.vad?.valence).toBeCloseTo(
      ((joyVad.valence * 0.4) + (angerVad.valence * 0.9)) / 1.3,
      6,
    );
    expect(result.observation.vad?.arousal).toBeCloseTo(
      ((joyVad.arousal * 0.4) + (angerVad.arousal * 0.9)) / 1.3,
      6,
    );
    expect(result.observation.vad?.dominance).toBeCloseTo(
      ((joyVad.dominance * 0.4) + (angerVad.dominance * 0.9)) / 1.3,
      6,
    );
  });

  it('preserves text-only behavior in multimodal fusion path when audio is absent', async () => {
    const { classifier } = createClassifier([
      { label: 'neutral', score: 1 },
    ]);
    const observer = new EmotionObserver({
      textClassifier: classifier,
      vadLexicon: createLexicon({}),
    });

    const result = await observer.buildModalityObservations({
      text: 'just-text',
    });

    expect(result.audio).toBeUndefined();
    expect(result.fusedLabel).toBe('neutral');
    expect(result.fusedLabelConfidence).toBeCloseTo(1, 6);
    expect(result.observation).toEqual(result.text);
  });

  it('fails closed when modality observations contain no positive-confidence signals', async () => {
    const { classifier: textClassifier } = createClassifier([
      { label: 'neutral', score: 0 },
      { label: 'joy', score: 0 },
    ]);
    const { classifier: audioClassifier } = createAudioClassifier([
      { label: 'event:laughter', score: 1, source: 'event' },
    ]);
    const observer = new EmotionObserver({
      textClassifier,
      audioClassifier,
      vadLexicon: createLexicon({}),
    });

    await expect(observer.buildModalityObservations({
      text: 'unknown-token',
      audio: {
        audioBuffer: Buffer.from([0, 0]),
        sampleRate: 16_000,
      },
    })).rejects.toThrow('modality observations must include at least one signal with positive confidence');
  });

  it('fails closed when audio modality is requested without an audio classifier', async () => {
    const { classifier } = createClassifier([{ label: 'neutral', score: 1 }]);
    const observer = new EmotionObserver({
      textClassifier: classifier,
      vadLexicon: createLexicon({}),
    });

    await expect(observer.buildAudioObservation({
      audioBuffer: Buffer.from([0, 0]),
      sampleRate: 16_000,
    })).rejects.toThrow('audio emotion classifier is not configured');
  });
});
