import { TEXT_EMOTION_LABEL_VAD_MAP } from '../../emotion/observer.js';
import type { EmotionStateSnapshot, VADVector } from '../../emotion/state.js';
import type {
  EmoSimAdapterOutput,
  EmoSimEmotionName,
  EmoSimEmotionVector,
  EmoSimEngineSnapshot,
} from './emosim-adapter.js';
import { EMOSIM_EMOTION_VECTOR } from './emosim-adapter.js';

export const OBSERVER_EMOTION_CROSSWALK_SCHEMA_VERSION = 1 as const;
export const OBSERVER_EMOTION_CROSSWALK_VERSION = 'psfn.observer-sidecar.crosswalk.v1' as const;
export const DEFAULT_OBSERVER_CROSSWALK_EMOTION_THRESHOLD = 0.05;
export const OBSERVER_CROSSWALK_WEAK_MAPPING_CONFIDENCE = 0.7;

export const OBSERVER_EMOTION_FAMILIES = Object.freeze([
  'positive_high_activation',
  'positive_low_activation',
  'positive_approach',
  'affiliation_love',
  'calm_safety',
  'aesthetic_cognitive',
  'threat_fear',
  'distress_loss',
  'anger_aversion',
  'self_conscious',
  'fatigue_disengagement',
  'surprise_ambiguity',
  'neutral',
] as const);

export type ObserverEmotionFamily = typeof OBSERVER_EMOTION_FAMILIES[number];
export type ObserverCrosswalkMappingKind = 'direct' | 'family' | 'weak' | 'unmapped';
export type ObserverCrosswalkDirection = 'rising' | 'falling' | 'flat';
export type ObserverCrosswalkSnapshotName = keyof EmoSimAdapterOutput['snapshots'];

export interface ObserverEmotionCrosswalkInput {
  psfn: EmotionStateSnapshot | null;
  emosim: EmoSimAdapterOutput;
  emosimSnapshot?: ObserverCrosswalkSnapshotName;
  emotionThreshold?: number;
  weakMappingConfidence?: number;
}

export interface ObserverCrosswalkMapping {
  family: ObserverEmotionFamily;
  mappingKind: ObserverCrosswalkMappingKind;
  confidence: number;
  caveat?: string;
}

export interface PsfnLabelCrosswalkMapping extends ObserverCrosswalkMapping {
  emosimEmotions: readonly EmoSimEmotionName[];
}

export interface EmoSimEmotionCrosswalkMapping extends ObserverCrosswalkMapping {
  psfnLabels: readonly string[];
}

export interface PsfnComparableLabel {
  label: string;
  score: number;
  canonicalTextLabel: boolean;
  family: ObserverEmotionFamily | null;
  mappingKind: ObserverCrosswalkMappingKind;
  mappingConfidence: number;
  weaklyMapped: boolean;
  emosimEmotions: readonly EmoSimEmotionName[];
  caveat?: string;
}

export interface EmoSimComparableEmotion {
  emotion: EmoSimEmotionName;
  intensity: number;
  family: ObserverEmotionFamily | null;
  mappingKind: ObserverCrosswalkMappingKind;
  mappingConfidence: number;
  weaklyMapped: boolean;
  psfnLabels: readonly string[];
  caveat?: string;
}

export interface ObserverFamilyScore {
  family: ObserverEmotionFamily;
  score: number;
}

export interface PsfnUnmappedLabel {
  label: string;
  score: number;
}

export interface EmoSimUnmappedEmotion {
  emotion: EmoSimEmotionName;
  intensity: number;
}

export interface PsfnValenceArousalDominance {
  valence: number;
  arousal: number;
  dominance: number;
  mood: VADVector;
  source: 'psfn-emotion-state-snapshot';
}

export interface EmoSimValenceArousal {
  valence: number;
  arousal: number;
  source: 'emosim-snapshot-mood';
}

export interface EmoSimDominanceProxy {
  value: number;
  confidence: number;
  source: 'family-weighted-emotion-intensity';
  caveat: string;
}

export interface PsfnIntensitySummary {
  strongestLabelIntensity: number;
  vadMagnitude: number;
  moodMagnitude: number;
  currentVsMoodDirection: ObserverCrosswalkDirection;
  caveat: string;
}

export interface EmoSimIntensitySummary {
  beforeTotalIntensity: number;
  afterStimulusTotalIntensity: number;
  afterTickTotalIntensity: number;
  stimulusDirection: ObserverCrosswalkDirection;
  tickDirection: ObserverCrosswalkDirection;
  overallDirection: ObserverCrosswalkDirection;
}

export interface PsfnCrosswalkDerived {
  available: boolean;
  labels: readonly PsfnComparableLabel[];
  primaryLabel: PsfnComparableLabel | null;
  valenceArousalDominance: PsfnValenceArousalDominance | null;
  familyScores: Record<ObserverEmotionFamily, number>;
  primaryFamily: ObserverFamilyScore | null;
  unmappedLabels: readonly PsfnUnmappedLabel[];
  weaklyMappedLabels: readonly PsfnComparableLabel[];
  intensity: PsfnIntensitySummary | null;
}

export interface EmoSimCrosswalkDerived {
  snapshot: ObserverCrosswalkSnapshotName;
  dominantEmotion: EmoSimEmotionName;
  emotions: readonly EmoSimComparableEmotion[];
  primaryEmotion: EmoSimComparableEmotion | null;
  valenceArousal: EmoSimValenceArousal;
  dominanceProxy: EmoSimDominanceProxy;
  familyScores: Record<ObserverEmotionFamily, number>;
  primaryFamily: ObserverFamilyScore | null;
  unmappedEmotions: readonly EmoSimUnmappedEmotion[];
  weaklyMappedEmotions: readonly EmoSimComparableEmotion[];
  intensity: EmoSimIntensitySummary;
}

export interface ObserverCrosswalkVadDivergence {
  psfn: Pick<PsfnValenceArousalDominance, 'valence' | 'arousal'> | null;
  emosim: Pick<EmoSimValenceArousal, 'valence' | 'arousal'>;
  delta: {
    valence: number | null;
    arousal: number | null;
    euclideanDistance: number | null;
  };
}

export interface ObserverCrosswalkDominanceDivergence {
  psfnDominance: number | null;
  emosimDominanceProxy: number;
  absoluteDelta: number | null;
  caveat: string;
}

export interface ObserverCrosswalkLabelDivergence {
  psfnPrimaryLabel: string | null;
  emosimDominantEmotion: EmoSimEmotionName;
  psfnPrimaryFamily: ObserverEmotionFamily | null;
  emosimPrimaryFamily: ObserverEmotionFamily | null;
  familyMismatch: boolean;
  familyOverlap: number | null;
}

export interface ObserverCrosswalkIntensityDivergence {
  psfnSignalIntensity: number | null;
  emosimSignalIntensity: number;
  absoluteDelta: number | null;
  directionMismatch: boolean | null;
}

export interface ObserverCrosswalkSuppressionDecayDivergence {
  psfnCurrentVsMoodDirection: ObserverCrosswalkDirection | null;
  emosimAfterStimulusToTickDirection: ObserverCrosswalkDirection;
  patternMismatch: boolean | null;
  caveat: string;
}

export interface ObserverCrosswalkUnknownsDivergence {
  psfnUnmappedCount: number;
  psfnWeakMappingCount: number;
  emosimUnmappedCount: number;
  emosimWeakMappingCount: number;
  unmappedIntensity: number;
}

export interface ObserverCrosswalkComparison {
  valenceArousal: ObserverCrosswalkVadDivergence;
  dominance: ObserverCrosswalkDominanceDivergence;
  labels: ObserverCrosswalkLabelDivergence;
  intensity: ObserverCrosswalkIntensityDivergence;
  suppressionOrDecay: ObserverCrosswalkSuppressionDecayDivergence;
  unknowns: ObserverCrosswalkUnknownsDivergence;
}

export interface ObserverEmotionCrosswalkOutput {
  schemaVersion: typeof OBSERVER_EMOTION_CROSSWALK_SCHEMA_VERSION;
  crosswalkVersion: typeof OBSERVER_EMOTION_CROSSWALK_VERSION;
  raw: {
    psfn: EmotionStateSnapshot | null;
    emosim: EmoSimAdapterOutput;
  };
  derived: {
    thresholds: {
      emotion: number;
      weakMappingConfidence: number;
    };
    psfn: PsfnCrosswalkDerived;
    emosim: EmoSimCrosswalkDerived;
    comparison: ObserverCrosswalkComparison;
  };
}

interface MappingDefinition {
  family: ObserverEmotionFamily;
  confidence: number;
  mappingKind: Exclude<ObserverCrosswalkMappingKind, 'unmapped'>;
  caveat?: string;
}

interface PsfnMappingDefinition extends MappingDefinition {
  emosimEmotions: readonly EmoSimEmotionName[];
}

interface EmoSimMappingDefinition extends MappingDefinition {
  psfnLabels: readonly string[];
}

const CANONICAL_PSFN_TEXT_LABELS = new Set(Object.keys(TEXT_EMOTION_LABEL_VAD_MAP));

const PSFN_LABEL_CROSSWALK = Object.freeze({
  anger: directPsfn('anger_aversion', ['Anger', 'Contempt']),
  anticipation: weakPsfn(
    'positive_approach',
    ['Interest', 'Desire', 'Determination'],
    0.62,
    'PSFN anticipation has no single EmoSim primitive; mapped to approach and interest emotions.',
  ),
  confusion: directPsfn('aesthetic_cognitive', ['Confusion', 'Doubt'], 0.9),
  disgust: directPsfn('anger_aversion', ['Disgust'], 0.95),
  fear: directPsfn('threat_fear', ['Fear', 'Anxiety', 'Horror'], 0.92),
  joy: directPsfn('positive_high_activation', ['Joy', 'Ecstasy', 'Excitement', 'Amusement'], 0.95),
  love: directPsfn('affiliation_love', ['Love', 'Romance', 'Adoration'], 0.95),
  neutral: weakPsfn(
    'neutral',
    ['Calmness', 'Contentment'],
    0.45,
    'Neutral is absence or baseline in PSFN; EmoSim calm/contentment are affective states, not pure neutrality.',
  ),
  optimism: weakPsfn(
    'positive_approach',
    ['Satisfaction', 'Determination', 'Triumph', 'Interest'],
    0.58,
    'PSFN optimism has no direct EmoSim primitive; mapped to approach-oriented positive emotions.',
  ),
  pessimism: weakPsfn(
    'distress_loss',
    ['Disappointment', 'Doubt', 'Anxiety'],
    0.56,
    'PSFN pessimism has no direct EmoSim primitive; mapped to low-certainty negative expectations.',
  ),
  sadness: directPsfn('distress_loss', ['Sadness', 'Distress', 'Disappointment'], 0.94),
  surprise: weakPsfn(
    'surprise_ambiguity',
    ['Surprise (positive)', 'Surprise (negative)'],
    0.66,
    'PSFN surprise is valence-ambiguous; EmoSim splits positive and negative surprise.',
  ),
  trust: weakPsfn(
    'affiliation_love',
    ['Admiration', 'Relief', 'Calmness'],
    0.58,
    'PSFN trust has no direct EmoSim primitive; mapped to affiliation and safety-adjacent emotions.',
  ),
  admiration: directPsfn('affiliation_love', ['Admiration'], 0.82),
  amusement: directPsfn('positive_high_activation', ['Amusement'], 0.88),
  desire: directPsfn('positive_approach', ['Desire', 'Craving'], 0.82),
  disappointment: directPsfn('distress_loss', ['Disappointment'], 0.88),
  embarrassment: nonCanonicalPsfn('self_conscious', ['Embarrassment'], 0.82),
  guilt: nonCanonicalPsfn('self_conscious', ['Guilt'], 0.86),
  nervousness: directPsfn('threat_fear', ['Anxiety'], 0.82),
  pride: nonCanonicalPsfn('self_conscious', ['Pride'], 0.84),
  realization: directPsfn('aesthetic_cognitive', ['Realization'], 0.78),
  relief: directPsfn('positive_low_activation', ['Relief'], 0.84),
  remorse: weakPsfn(
    'self_conscious',
    ['Guilt', 'Shame'],
    0.64,
    'PSFN remorse is not a canonical text label; EmoSim separates guilt and shame.',
  ),
  shame: nonCanonicalPsfn('self_conscious', ['Shame'], 0.86),
} as const satisfies Readonly<Record<string, PsfnMappingDefinition>>);

const PSFN_LABEL_CROSSWALK_BY_LABEL: Readonly<Partial<Record<string, PsfnMappingDefinition>>> =
  PSFN_LABEL_CROSSWALK;

const EMOSIM_EMOTION_CROSSWALK = Object.freeze({
  Joy: directEmoSim('positive_high_activation', ['joy'], 0.95),
  Ecstasy: familyEmoSim('positive_high_activation', ['joy'], 0.82),
  Excitement: familyEmoSim('positive_high_activation', ['joy', 'anticipation'], 0.78),
  Amusement: directEmoSim('positive_high_activation', ['joy'], 0.88),
  Triumph: familyEmoSim('positive_high_activation', ['optimism', 'pride'], 0.72),
  Pride: weakEmoSim(
    'self_conscious',
    ['optimism', 'pride'],
    0.62,
    'PSFN canonical text labels do not separate pride from optimism; raw pride labels are preserved when present.',
  ),
  Satisfaction: weakEmoSim(
    'positive_low_activation',
    ['optimism'],
    0.64,
    'PSFN has no satisfaction primitive; mapped weakly to optimism.',
  ),
  Contentment: weakEmoSim(
    'positive_low_activation',
    ['neutral', 'trust'],
    0.55,
    'PSFN neutral/trust do not distinguish contentment from low-arousal positive mood.',
  ),
  Calmness: weakEmoSim(
    'calm_safety',
    ['neutral', 'trust'],
    0.58,
    'PSFN uses VAD arousal for calmness; there is no canonical calmness discrete label.',
  ),
  Relief: familyEmoSim('positive_low_activation', ['optimism', 'trust'], 0.72),
  Desire: familyEmoSim('positive_approach', ['anticipation', 'desire'], 0.76),
  Craving: weakEmoSim(
    'positive_approach',
    ['anticipation', 'desire'],
    0.58,
    'PSFN does not distinguish craving from desire or anticipation.',
  ),
  Interest: familyEmoSim('positive_approach', ['anticipation'], 0.74),
  Awe: weakEmoSim(
    'aesthetic_cognitive',
    ['surprise'],
    0.52,
    'PSFN has no awe primitive; mapped weakly to surprise/cognitive salience.',
  ),
  'Aesthetic Appreciation': weakEmoSim(
    'aesthetic_cognitive',
    ['joy', 'trust'],
    0.45,
    'PSFN has no aesthetic-appreciation primitive.',
  ),
  Entrancement: weakEmoSim(
    'aesthetic_cognitive',
    ['joy', 'anticipation'],
    0.48,
    'PSFN has no entrancement primitive.',
  ),
  Contemplation: weakEmoSim(
    'aesthetic_cognitive',
    ['neutral'],
    0.5,
    'PSFN has no contemplation primitive; comparison relies on low-arousal VAD.',
  ),
  Realization: familyEmoSim('aesthetic_cognitive', ['surprise'], 0.7),
  Nostalgia: weakEmoSim(
    'distress_loss',
    ['sadness', 'joy'],
    0.46,
    'PSFN has no nostalgia primitive and does not encode its mixed valence as a discrete label.',
  ),
  Determination: weakEmoSim(
    'positive_approach',
    ['anticipation', 'optimism'],
    0.6,
    'PSFN has no determination primitive; mapped to approach expectation.',
  ),
  Concentration: weakEmoSim(
    'aesthetic_cognitive',
    ['anticipation'],
    0.5,
    'PSFN has no concentration primitive; comparison relies on arousal and approach.',
  ),
  Love: directEmoSim('affiliation_love', ['love'], 0.95),
  Romance: familyEmoSim('affiliation_love', ['love'], 0.82),
  Adoration: familyEmoSim('affiliation_love', ['love', 'trust'], 0.78),
  Admiration: familyEmoSim('affiliation_love', ['trust', 'admiration'], 0.76),
  Sympathy: weakEmoSim(
    'affiliation_love',
    ['love', 'sadness'],
    0.58,
    'PSFN has no sympathy primitive; mapped to affiliative concern and sadness.',
  ),
  'Empathic Pain': weakEmoSim(
    'distress_loss',
    ['sadness', 'love'],
    0.54,
    'PSFN has no empathic-pain primitive.',
  ),
  Fear: directEmoSim('threat_fear', ['fear'], 0.95),
  Anxiety: familyEmoSim('threat_fear', ['fear', 'nervousness'], 0.78),
  Horror: familyEmoSim('threat_fear', ['fear'], 0.82),
  Distress: familyEmoSim('distress_loss', ['sadness', 'fear'], 0.76),
  Pain: weakEmoSim(
    'distress_loss',
    ['sadness'],
    0.56,
    'PSFN has no pain primitive; mapped to distress/sadness family.',
  ),
  Sadness: directEmoSim('distress_loss', ['sadness'], 0.95),
  Disappointment: familyEmoSim('distress_loss', ['sadness', 'pessimism'], 0.82),
  Tiredness: weakEmoSim(
    'fatigue_disengagement',
    ['neutral', 'sadness'],
    0.5,
    'PSFN has no tiredness primitive; comparison relies on low arousal and negative valence.',
  ),
  Boredom: weakEmoSim(
    'fatigue_disengagement',
    ['neutral', 'pessimism'],
    0.5,
    'PSFN has no boredom primitive; comparison relies on low arousal and negative valence.',
  ),
  Anger: directEmoSim('anger_aversion', ['anger'], 0.95),
  Contempt: familyEmoSim('anger_aversion', ['anger', 'disgust'], 0.74),
  Disgust: directEmoSim('anger_aversion', ['disgust'], 0.95),
  Envy: weakEmoSim(
    'anger_aversion',
    ['pessimism', 'anger'],
    0.52,
    'PSFN has no envy primitive.',
  ),
  Guilt: weakEmoSim(
    'self_conscious',
    ['pessimism', 'guilt'],
    0.62,
    'PSFN canonical text labels do not separate guilt from remorse/pessimism; raw guilt labels are preserved when present.',
  ),
  Shame: weakEmoSim(
    'self_conscious',
    ['pessimism', 'shame'],
    0.62,
    'PSFN canonical text labels do not separate shame from pessimism; raw shame labels are preserved when present.',
  ),
  Embarrassment: weakEmoSim(
    'self_conscious',
    ['confusion', 'embarrassment'],
    0.62,
    'PSFN canonical text labels normally alias embarrassment into confusion.',
  ),
  Awkwardness: weakEmoSim(
    'self_conscious',
    ['confusion', 'embarrassment'],
    0.58,
    'PSFN has no awkwardness primitive; mapped to self-conscious confusion.',
  ),
  Doubt: familyEmoSim('aesthetic_cognitive', ['confusion', 'pessimism'], 0.72),
  Confusion: directEmoSim('aesthetic_cognitive', ['confusion'], 0.95),
  'Surprise (positive)': weakEmoSim(
    'surprise_ambiguity',
    ['surprise'],
    0.68,
    'PSFN surprise does not preserve positive surprise valence as a discrete label.',
  ),
  'Surprise (negative)': weakEmoSim(
    'surprise_ambiguity',
    ['surprise'],
    0.68,
    'PSFN surprise does not preserve negative surprise valence as a discrete label.',
  ),
} as const satisfies Readonly<Partial<Record<EmoSimEmotionName, EmoSimMappingDefinition>>>);

const EMOSIM_EMOTION_CROSSWALK_BY_NAME: Readonly<Partial<Record<EmoSimEmotionName, EmoSimMappingDefinition>>> =
  EMOSIM_EMOTION_CROSSWALK;

const FAMILY_DOMINANCE_PROXY: Readonly<Record<ObserverEmotionFamily, number>> = Object.freeze({
  positive_high_activation: 0.35,
  positive_low_activation: 0.15,
  positive_approach: 0.25,
  affiliation_love: 0.1,
  calm_safety: 0.05,
  aesthetic_cognitive: -0.05,
  threat_fear: -0.65,
  distress_loss: -0.55,
  anger_aversion: 0.35,
  self_conscious: -0.45,
  fatigue_disengagement: -0.45,
  surprise_ambiguity: -0.1,
  neutral: 0,
});

const PSFN_INTENSITY_CAVEAT = 'PSFN exposes a current VAD snapshot and EMA mood, not event-level intensity deltas; current-vs-mood direction is an observer-only proxy.';
const EMOSIM_DOMINANCE_CAVEAT = 'EmoSim exposes valence/arousal but no dominance axis; this value is an observer-only family-weighted proxy and must not be treated as raw EmoSim state.';
const SUPPRESSION_DECAY_CAVEAT = 'PSFN current-vs-mood and EmoSim after-stimulus-vs-tick are comparable only as directional observer proxies, not as shared decay mechanics.';
const DIRECTION_EPSILON = 0.025;

export function createObserverEmotionCrosswalk(
  input: ObserverEmotionCrosswalkInput,
): ObserverEmotionCrosswalkOutput {
  const emotionThreshold = normalizeThreshold(
    input.emotionThreshold,
    DEFAULT_OBSERVER_CROSSWALK_EMOTION_THRESHOLD,
    'emotionThreshold',
  );
  const weakMappingConfidence = normalizeThreshold(
    input.weakMappingConfidence,
    OBSERVER_CROSSWALK_WEAK_MAPPING_CONFIDENCE,
    'weakMappingConfidence',
  );
  const snapshotName = input.emosimSnapshot ?? 'afterTick';
  const emosimSnapshot = input.emosim.snapshots[snapshotName];
  const psfn = derivePsfn(input.psfn, emotionThreshold, weakMappingConfidence);
  const emosim = deriveEmosim(
    input.emosim,
    snapshotName,
    emosimSnapshot,
    emotionThreshold,
    weakMappingConfidence,
  );

  return {
    schemaVersion: OBSERVER_EMOTION_CROSSWALK_SCHEMA_VERSION,
    crosswalkVersion: OBSERVER_EMOTION_CROSSWALK_VERSION,
    raw: {
      psfn: input.psfn,
      emosim: input.emosim,
    },
    derived: {
      thresholds: {
        emotion: emotionThreshold,
        weakMappingConfidence,
      },
      psfn,
      emosim,
      comparison: compareDerived(psfn, emosim),
    },
  };
}

function derivePsfn(
  snapshot: EmotionStateSnapshot | null,
  emotionThreshold: number,
  weakMappingConfidence: number,
): PsfnCrosswalkDerived {
  if (!snapshot) {
    return {
      available: false,
      labels: [],
      primaryLabel: null,
      valenceArousalDominance: null,
      familyScores: emptyFamilyScores(),
      primaryFamily: null,
      unmappedLabels: [],
      weaklyMappedLabels: [],
      intensity: null,
    };
  }

  const familyScores = emptyFamilyScores();
  const labels: PsfnComparableLabel[] = [];
  const unmappedLabels: PsfnUnmappedLabel[] = [];

  for (const [rawLabel, rawScore] of Object.entries(snapshot.discrete)) {
    if (rawScore < emotionThreshold) continue;
    const label = normalizePsfnLabel(rawLabel);
    const mapping = PSFN_LABEL_CROSSWALK_BY_LABEL[label];
    if (!mapping) {
      const unmapped = { label, score: rawScore };
      unmappedLabels.push(unmapped);
      labels.push({
        ...unmapped,
        canonicalTextLabel: CANONICAL_PSFN_TEXT_LABELS.has(label),
        family: null,
        mappingKind: 'unmapped',
        mappingConfidence: 0,
        weaklyMapped: false,
        emosimEmotions: [],
        caveat: 'No PSFN-to-EmoSim mapping exists in this crosswalk version.',
      });
      continue;
    }

    const weaklyMapped = mapping.confidence < weakMappingConfidence || mapping.mappingKind === 'weak';
    const comparable: PsfnComparableLabel = {
      label,
      score: rawScore,
      canonicalTextLabel: CANONICAL_PSFN_TEXT_LABELS.has(label),
      family: mapping.family,
      mappingKind: mapping.mappingKind,
      mappingConfidence: mapping.confidence,
      weaklyMapped,
      emosimEmotions: mapping.emosimEmotions,
      ...(mapping.caveat ? { caveat: mapping.caveat } : {}),
    };
    labels.push(comparable);
    familyScores[mapping.family] += rawScore * mapping.confidence;
  }

  labels.sort(sortPsfnLabels);
  unmappedLabels.sort(sortUnmappedLabels);

  return {
    available: true,
    labels,
    primaryLabel: labels[0] ?? null,
    valenceArousalDominance: {
      valence: snapshot.vad.valence,
      arousal: snapshot.vad.arousal,
      dominance: snapshot.vad.dominance,
      mood: cloneVad(snapshot.mood),
      source: 'psfn-emotion-state-snapshot',
    },
    familyScores,
    primaryFamily: dominantFamily(familyScores),
    unmappedLabels,
    weaklyMappedLabels: labels.filter((label) => label.weaklyMapped),
    intensity: {
      strongestLabelIntensity: strongestPsfnLabelIntensity(snapshot.discrete),
      vadMagnitude: vadMagnitude(snapshot.vad),
      moodMagnitude: vadMagnitude(snapshot.mood),
      currentVsMoodDirection: directionFromDelta(vadMagnitude(snapshot.vad) - vadMagnitude(snapshot.mood)),
      caveat: PSFN_INTENSITY_CAVEAT,
    },
  };
}

function deriveEmosim(
  output: EmoSimAdapterOutput,
  snapshotName: ObserverCrosswalkSnapshotName,
  snapshot: EmoSimEngineSnapshot,
  emotionThreshold: number,
  weakMappingConfidence: number,
): EmoSimCrosswalkDerived {
  const familyScores = emptyFamilyScores();
  const emotions: EmoSimComparableEmotion[] = [];
  const unmappedEmotions: EmoSimUnmappedEmotion[] = [];

  for (const emotion of EMOSIM_EMOTION_VECTOR) {
    const intensity = snapshot.emotions[emotion];
    if (intensity < emotionThreshold) continue;
    const mapping = EMOSIM_EMOTION_CROSSWALK_BY_NAME[emotion];
    if (!mapping) {
      const unmapped = { emotion, intensity };
      unmappedEmotions.push(unmapped);
      emotions.push({
        ...unmapped,
        family: null,
        mappingKind: 'unmapped',
        mappingConfidence: 0,
        weaklyMapped: false,
        psfnLabels: [],
        caveat: 'No EmoSim-to-PSFN mapping exists in this crosswalk version.',
      });
      continue;
    }

    const weaklyMapped = mapping.confidence < weakMappingConfidence || mapping.mappingKind === 'weak';
    const comparable: EmoSimComparableEmotion = {
      emotion,
      intensity,
      family: mapping.family,
      mappingKind: mapping.mappingKind,
      mappingConfidence: mapping.confidence,
      weaklyMapped,
      psfnLabels: mapping.psfnLabels,
      ...(mapping.caveat ? { caveat: mapping.caveat } : {}),
    };
    emotions.push(comparable);
    familyScores[mapping.family] += intensity * mapping.confidence;
  }

  emotions.sort(sortEmosimEmotions);
  unmappedEmotions.sort(sortUnmappedEmotions);

  return {
    snapshot: snapshotName,
    dominantEmotion: snapshot.dominant,
    emotions,
    primaryEmotion: emotions[0] ?? null,
    valenceArousal: {
      valence: snapshot.mood.valence,
      arousal: snapshot.mood.arousal,
      source: 'emosim-snapshot-mood',
    },
    dominanceProxy: deriveEmosimDominanceProxy(snapshot.emotions),
    familyScores,
    primaryFamily: dominantFamily(familyScores),
    unmappedEmotions,
    weaklyMappedEmotions: emotions.filter((emotion) => emotion.weaklyMapped),
    intensity: deriveEmosimIntensity(output),
  };
}

function compareDerived(
  psfn: PsfnCrosswalkDerived,
  emosim: EmoSimCrosswalkDerived,
): ObserverCrosswalkComparison {
  const psfnVad = psfn.valenceArousalDominance;
  const valenceDelta = psfnVad ? psfnVad.valence - emosim.valenceArousal.valence : null;
  const arousalDelta = psfnVad ? psfnVad.arousal - emosim.valenceArousal.arousal : null;
  const psfnIntensity = psfn.intensity;
  const psfnSignalIntensity = psfnIntensity
    ? Math.max(psfnIntensity.strongestLabelIntensity, psfnIntensity.vadMagnitude)
    : null;
  const emosimSignalIntensity = emosim.intensity.afterTickTotalIntensity;

  return {
    valenceArousal: {
      psfn: psfnVad ? { valence: psfnVad.valence, arousal: psfnVad.arousal } : null,
      emosim: {
        valence: emosim.valenceArousal.valence,
        arousal: emosim.valenceArousal.arousal,
      },
      delta: {
        valence: valenceDelta,
        arousal: arousalDelta,
        euclideanDistance: valenceDelta === null || arousalDelta === null
          ? null
          : Math.hypot(valenceDelta, arousalDelta),
      },
    },
    dominance: {
      psfnDominance: psfnVad?.dominance ?? null,
      emosimDominanceProxy: emosim.dominanceProxy.value,
      absoluteDelta: psfnVad ? Math.abs(psfnVad.dominance - emosim.dominanceProxy.value) : null,
      caveat: emosim.dominanceProxy.caveat,
    },
    labels: {
      psfnPrimaryLabel: psfn.primaryLabel?.label ?? null,
      emosimDominantEmotion: emosim.dominantEmotion,
      psfnPrimaryFamily: psfn.primaryFamily?.family ?? null,
      emosimPrimaryFamily: emosim.primaryFamily?.family ?? null,
      familyMismatch: familyMismatch(psfn.primaryFamily, emosim.primaryFamily),
      familyOverlap: familyOverlap(psfn.familyScores, emosim.familyScores),
    },
    intensity: {
      psfnSignalIntensity,
      emosimSignalIntensity,
      absoluteDelta: psfnSignalIntensity === null
        ? null
        : Math.abs(psfnSignalIntensity - emosimSignalIntensity),
      directionMismatch: psfnIntensity
        ? psfnIntensity.currentVsMoodDirection !== emosim.intensity.overallDirection
        : null,
    },
    suppressionOrDecay: {
      psfnCurrentVsMoodDirection: psfnIntensity?.currentVsMoodDirection ?? null,
      emosimAfterStimulusToTickDirection: emosim.intensity.tickDirection,
      patternMismatch: psfnIntensity
        ? psfnIntensity.currentVsMoodDirection !== emosim.intensity.tickDirection
        : null,
      caveat: SUPPRESSION_DECAY_CAVEAT,
    },
    unknowns: {
      psfnUnmappedCount: psfn.unmappedLabels.length,
      psfnWeakMappingCount: psfn.weaklyMappedLabels.length,
      emosimUnmappedCount: emosim.unmappedEmotions.length,
      emosimWeakMappingCount: emosim.weaklyMappedEmotions.length,
      unmappedIntensity: sumPsfnUnmapped(psfn.unmappedLabels) + sumEmosimUnmapped(emosim.unmappedEmotions),
    },
  };
}

function deriveEmosimDominanceProxy(emotions: EmoSimEmotionVector): EmoSimDominanceProxy {
  let weightedDominance = 0;
  let totalWeight = 0;

  for (const emotion of EMOSIM_EMOTION_VECTOR) {
    const intensity = emotions[emotion];
    if (intensity <= 0) continue;
    const mapping = EMOSIM_EMOTION_CROSSWALK_BY_NAME[emotion];
    if (!mapping) continue;
    weightedDominance += FAMILY_DOMINANCE_PROXY[mapping.family] * intensity * mapping.confidence;
    totalWeight += intensity * mapping.confidence;
  }

  return {
    value: totalWeight > 0 ? clampSigned(weightedDominance / totalWeight) : 0,
    confidence: totalWeight > 0 ? 0.35 : 0,
    source: 'family-weighted-emotion-intensity',
    caveat: EMOSIM_DOMINANCE_CAVEAT,
  };
}

function deriveEmosimIntensity(output: EmoSimAdapterOutput): EmoSimIntensitySummary {
  const beforeTotalIntensity = sumEmotionVector(output.snapshots.before.emotions);
  const afterStimulusTotalIntensity = sumEmotionVector(output.snapshots.afterStimulus.emotions);
  const afterTickTotalIntensity = sumEmotionVector(output.snapshots.afterTick.emotions);

  return {
    beforeTotalIntensity,
    afterStimulusTotalIntensity,
    afterTickTotalIntensity,
    stimulusDirection: directionFromDelta(afterStimulusTotalIntensity - beforeTotalIntensity),
    tickDirection: directionFromDelta(afterTickTotalIntensity - afterStimulusTotalIntensity),
    overallDirection: directionFromDelta(afterTickTotalIntensity - beforeTotalIntensity),
  };
}

function directPsfn(
  family: ObserverEmotionFamily,
  emosimEmotions: readonly EmoSimEmotionName[],
  confidence = 0.95,
): PsfnMappingDefinition {
  return {
    family,
    emosimEmotions,
    confidence,
    mappingKind: 'direct',
  };
}

function nonCanonicalPsfn(
  family: ObserverEmotionFamily,
  emosimEmotions: readonly EmoSimEmotionName[],
  confidence: number,
): PsfnMappingDefinition {
  return {
    family,
    emosimEmotions,
    confidence,
    mappingKind: 'direct',
    caveat: 'This is not a current canonical PSFN text label; the raw discrete label is preserved and compared explicitly.',
  };
}

function weakPsfn(
  family: ObserverEmotionFamily,
  emosimEmotions: readonly EmoSimEmotionName[],
  confidence: number,
  caveat: string,
): PsfnMappingDefinition {
  return {
    family,
    emosimEmotions,
    confidence,
    mappingKind: 'weak',
    caveat,
  };
}

function directEmoSim(
  family: ObserverEmotionFamily,
  psfnLabels: readonly string[],
  confidence = 0.95,
): EmoSimMappingDefinition {
  return {
    family,
    psfnLabels,
    confidence,
    mappingKind: 'direct',
  };
}

function familyEmoSim(
  family: ObserverEmotionFamily,
  psfnLabels: readonly string[],
  confidence: number,
): EmoSimMappingDefinition {
  return {
    family,
    psfnLabels,
    confidence,
    mappingKind: 'family',
  };
}

function weakEmoSim(
  family: ObserverEmotionFamily,
  psfnLabels: readonly string[],
  confidence: number,
  caveat: string,
): EmoSimMappingDefinition {
  return {
    family,
    psfnLabels,
    confidence,
    mappingKind: 'weak',
    caveat,
  };
}

function normalizeThreshold(value: number | undefined, fallback: number, fieldName: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${fieldName} must be between 0 and 1`);
  }
  return value;
}

function normalizePsfnLabel(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (!normalized) {
    throw new RangeError('PSFN discrete emotion labels must be non-empty');
  }
  return normalized;
}

function emptyFamilyScores(): Record<ObserverEmotionFamily, number> {
  return Object.fromEntries(
    OBSERVER_EMOTION_FAMILIES.map((family) => [family, 0] as const),
  ) as Record<ObserverEmotionFamily, number>;
}

function dominantFamily(scores: Record<ObserverEmotionFamily, number>): ObserverFamilyScore | null {
  let primary: ObserverFamilyScore | null = null;
  for (const family of OBSERVER_EMOTION_FAMILIES) {
    const score = scores[family];
    if (score <= 0) continue;
    if (!primary || score > primary.score) {
      primary = { family, score };
      continue;
    }
    if (score === primary.score && family.localeCompare(primary.family) < 0) {
      primary = { family, score };
    }
  }
  return primary;
}

function familyMismatch(
  psfnFamily: ObserverFamilyScore | null,
  emosimFamily: ObserverFamilyScore | null,
): boolean {
  if (!psfnFamily && !emosimFamily) return false;
  if (!psfnFamily || !emosimFamily) return true;
  return psfnFamily.family !== emosimFamily.family;
}

function familyOverlap(
  psfnScores: Record<ObserverEmotionFamily, number>,
  emosimScores: Record<ObserverEmotionFamily, number>,
): number | null {
  let intersection = 0;
  let union = 0;

  for (const family of OBSERVER_EMOTION_FAMILIES) {
    const psfnScore = psfnScores[family];
    const emosimScore = emosimScores[family];
    intersection += Math.min(psfnScore, emosimScore);
    union += Math.max(psfnScore, emosimScore);
  }

  return union > 0 ? intersection / union : null;
}

function strongestPsfnLabelIntensity(discrete: Record<string, number>): number {
  let strongest = 0;
  for (const score of Object.values(discrete)) {
    strongest = Math.max(strongest, score);
  }
  return strongest;
}

function vadMagnitude(vad: VADVector): number {
  return Math.hypot(vad.valence, vad.arousal, vad.dominance) / Math.sqrt(3);
}

function directionFromDelta(delta: number): ObserverCrosswalkDirection {
  if (delta > DIRECTION_EPSILON) return 'rising';
  if (delta < -DIRECTION_EPSILON) return 'falling';
  return 'flat';
}

function sumEmotionVector(vector: EmoSimEmotionVector): number {
  let total = 0;
  for (const emotion of EMOSIM_EMOTION_VECTOR) {
    total += vector[emotion];
  }
  return total;
}

function sumPsfnUnmapped(labels: readonly PsfnUnmappedLabel[]): number {
  return labels.reduce((total, label) => total + label.score, 0);
}

function sumEmosimUnmapped(emotions: readonly EmoSimUnmappedEmotion[]): number {
  return emotions.reduce((total, emotion) => total + emotion.intensity, 0);
}

function sortPsfnLabels(left: PsfnComparableLabel, right: PsfnComparableLabel): number {
  if (left.score !== right.score) return right.score - left.score;
  return left.label.localeCompare(right.label);
}

function sortUnmappedLabels(left: PsfnUnmappedLabel, right: PsfnUnmappedLabel): number {
  if (left.score !== right.score) return right.score - left.score;
  return left.label.localeCompare(right.label);
}

function sortEmosimEmotions(left: EmoSimComparableEmotion, right: EmoSimComparableEmotion): number {
  if (left.intensity !== right.intensity) return right.intensity - left.intensity;
  return left.emotion.localeCompare(right.emotion);
}

function sortUnmappedEmotions(left: EmoSimUnmappedEmotion, right: EmoSimUnmappedEmotion): number {
  if (left.intensity !== right.intensity) return right.intensity - left.intensity;
  return left.emotion.localeCompare(right.emotion);
}

function cloneVad(vad: VADVector): VADVector {
  return {
    valence: vad.valence,
    arousal: vad.arousal,
    dominance: vad.dominance,
  };
}

function clampSigned(value: number): number {
  return Math.max(-1, Math.min(1, value));
}
