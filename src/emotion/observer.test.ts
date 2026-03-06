import { describe, expect, it, vi } from 'vitest';
import {
  EmotionObserver,
  TEXT_EMOTION_LABEL_VAD_MAP,
  type TextEmotionClassifierLike,
} from './observer.js';
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

describe('EmotionObserver', () => {
  it('fuses categorical and lexicon VAD signals with confidence weighting', async () => {
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
    const lexiconSignedVad = { valence: 0.1, arousal: 0.1, dominance: 0.1 };
    const expected = {
      valence: ((joyVad.valence * 0.8) + (lexiconSignedVad.valence * 0.1)) / 0.9,
      arousal: ((joyVad.arousal * 0.8) + (lexiconSignedVad.arousal * 0.1)) / 0.9,
      dominance: ((joyVad.dominance * 0.8) + (lexiconSignedVad.dominance * 0.1)) / 0.9,
    };

    expect(result.observation.vad?.valence).toBeCloseTo(expected.valence, 6);
    expect(result.observation.vad?.arousal).toBeCloseTo(expected.arousal, 6);
    expect(result.observation.vad?.dominance).toBeCloseTo(expected.dominance, 6);
  });

  it('can promote lexicon-driven categorical labels when classifier confidence is weaker', async () => {
    const { classifier } = createClassifier([
      { label: 'joy', score: 0.2 },
      { label: 'neutral', score: 0.1 },
    ]);
    const lexicon = createLexicon({
      rage: { valence: 0.05, arousal: 0.95, dominance: 0.85 },
    });

    const observer = new EmotionObserver({ textClassifier: classifier, vadLexicon: lexicon });
    const result = await observer.observe('rage', 0);

    const lexiconConfidence = (0.9 + 0.9 + 0.7) / 3;
    expect(result.fusedLabel).toBe('anger');
    expect(result.observation.discrete).toEqual({ anger: 1 });
    expect(result.observation.confidence).toBeCloseTo(lexiconConfidence, 6);

    const angerVad = TEXT_EMOTION_LABEL_VAD_MAP.anger;
    expect(result.observation.vad?.valence).toBeCloseTo((angerVad.valence - 0.9) / 2, 6);
    expect(result.observation.vad?.arousal).toBeCloseTo((angerVad.arousal + 0.9) / 2, 6);
    expect(result.observation.vad?.dominance).toBeCloseTo((angerVad.dominance + 0.7) / 2, 6);
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
});
