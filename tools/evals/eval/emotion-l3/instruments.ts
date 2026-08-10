import type { EvalEmotionLabel } from '../src/types.js';
import {
  APPRAISAL_DIMENSIONS,
  type AppraisalVector,
  type EmotionL3AuditContext,
  type EmotionL3Instrument,
  type EmotionL3InstrumentResult,
  type EmotionLabelScore,
} from './types.js';

type Lexicon = Partial<Record<EvalEmotionLabel, readonly string[]>>;

const BASELINE_LEXICON: Lexicon = {
  anger: ['angry', 'furious', 'confront', 'stolen', 'unfair'],
  anticipation: ['waiting', 'refreshing', 'soon', 'decision'],
  confusion: ['confused', 'unclear', 'what happened', 'do not understand'],
  disgust: ['gag', 'rotten', 'spoiled', 'gross', 'revulsion'],
  fear: ['shaking', 'threat', 'rent is due', 'scared', 'panic'],
  joy: ['happy', 'relieved', 'laughing', 'delighted'],
  love: ['love', 'beloved', 'close to them'],
  neutral: ['routine', 'ordinary', 'scheduled'],
  optimism: ['working out', 'solid', 'hopeful', 'can actually see'],
  pessimism: ['pointless', 'will not work', 'hopeless'],
  sadness: ['heavy', 'empty room', 'lost', 'grief', 'alone'],
  surprise: ['suddenly', 'unexpected', 'out of nowhere'],
  trust: ['trust', 'reliable', 'count on'],
};

const LABEL_AWARE_EXTRA_LEXICON: Lexicon = {
  anger: ['ready to confront', 'my work as his own'],
  anticipation: ['inbox', 'official decision', 'waiting for'],
  confusion: ['incomplete', 'unknown', 'not sure'],
  disgust: ['smell', 'shrimp', 'want to gag'],
  fear: ['layoff email', 'hands will not stop shaking'],
  joy: ['burst into relieved', 'wonderful'],
  optimism: ['see this working out', 'favorable'],
  pessimism: ['likely fail', 'no chance'],
  sadness: ['staring at the empty room', 'depleted'],
  surprise: ['unexpected', 'just opened'],
};

export function createGoEmotionsBaselineFixtureInstrument(options: {
  version?: string;
  available?: boolean;
} = {}): EmotionL3Instrument {
  return {
    metadata: {
      instrumentId: 'goemotions-baseline-fixture',
      version: options.version ?? 'goemotions-fixture-v1',
      label: 'GoEmotions-style baseline fixture',
      classifierFamily: 'goemotions-roberta-style',
      artifactUri: 'fixture://eval/emotion-l3/goemotions-baseline',
      trainingData: 'fixture keyword proxy for incumbent GoEmotions-style classifier',
    },
    role: 'primary_instrument',
    outputKind: 'goemotions_style_multilabel',
    isAvailable: () => options.available ?? true,
    analyze: (input) => ({
      status: 'ok',
      confidence: 0.72,
      labels: topLabels(scoreText(input.text, BASELINE_LEXICON), 2),
    }),
  };
}

export function createLabelAwareMultiLabelFixtureInstrument(options: {
  version?: string;
  available?: boolean;
} = {}): EmotionL3Instrument {
  return {
    metadata: {
      instrumentId: 'label-aware-multilabel-fixture',
      version: options.version ?? 'label-aware-fixture-v1',
      label: 'Label-aware multi-label fixture',
      classifierFamily: 'spanemo-demux-lineage-fixture',
      artifactUri: 'fixture://eval/emotion-l3/label-aware-multilabel',
      trainingData: 'fixture keyword proxy for overlapping-label classifier lineage',
    },
    role: 'primary_instrument',
    outputKind: 'label_aware_multilabel',
    isAvailable: () => options.available ?? true,
    analyze: (input) => {
      const mergedScores = scoreText(input.text, {
        ...BASELINE_LEXICON,
        ...mergeLexicons(BASELINE_LEXICON, LABEL_AWARE_EXTRA_LEXICON),
      });
      return {
        status: 'ok',
        confidence: 0.78,
        labels: topLabels(mergedScores, 3),
      };
    },
  };
}

export function createAppraisalRegressorFixtureInstrument(options: {
  version?: string;
  available?: boolean;
} = {}): EmotionL3Instrument {
  return {
    metadata: {
      instrumentId: 'appraisal-regressor-fixture',
      version: options.version ?? 'appraisal-regressor-fixture-v1',
      label: 'Substrate appraisal regressor fixture',
      classifierFamily: 'crowd-envent-style-appraisal-regressor',
      artifactUri: 'fixture://eval/emotion-l3/appraisal-regressor',
      trainingData: 'deterministic fixture mapping onto substrate appraisal dimensions',
    },
    role: 'primary_instrument',
    outputKind: 'appraisal_regression',
    isAvailable: () => options.available ?? true,
    analyze: (input) => ({
      status: 'ok',
      confidence: 0.7,
      appraisal: appraisalFromText(input.text),
    }),
  };
}

export function createLlmDisagreementAuditorFixtureInstrument(options: {
  version?: string;
} = {}): EmotionL3Instrument {
  return {
    metadata: {
      instrumentId: 'llm-disagreement-auditor-fixture',
      version: options.version ?? 'llm-auditor-fixture-v1',
      label: 'LLM disagreement auditor fixture',
      classifierFamily: 'llm-as-judge-disagreement-auditor',
      artifactUri: 'fixture://eval/emotion-l3/llm-disagreement-auditor',
    },
    role: 'disagreement_auditor',
    outputKind: 'llm_disagreement_audit',
    analyze: (_input, context) => ({
      status: 'ok',
      confidence: 0.62,
      audit: {
        disagreements: auditPrimaryResults(context),
      },
    }),
  };
}

function auditPrimaryResults(
  context: EmotionL3AuditContext | undefined,
): NonNullable<Extract<EmotionL3InstrumentResult, { status: 'ok' }>['audit']>['disagreements'] {
  if (context === undefined) {
    return [];
  }

  const disagreements = [];
  for (const [instrumentId, result] of context.primaryResults.entries()) {
    if (result.status !== 'ok') {
      disagreements.push({
        targetInstrumentId: instrumentId,
        kind: 'status' as const,
        severity: result.status === 'failed' ? 'high' as const : 'medium' as const,
        message: `Primary instrument returned ${result.status}.`,
      });
      continue;
    }
    if (result.labels !== undefined && result.labels.length === 0) {
      disagreements.push({
        targetInstrumentId: instrumentId,
        kind: 'label' as const,
        severity: 'medium' as const,
        message: 'Primary classifier produced no labels.',
      });
    }
  }
  return disagreements;
}

function scoreText(text: string, lexicon: Lexicon): Map<EvalEmotionLabel, number> {
  const normalized = text.toLowerCase();
  const scores = new Map<EvalEmotionLabel, number>();

  for (const [label, phrases] of Object.entries(lexicon) as [EvalEmotionLabel, readonly string[]][]) {
    const hits = phrases.filter((phrase) => normalized.includes(phrase)).length;
    if (hits > 0) {
      scores.set(label, Math.min(0.98, 0.52 + hits * 0.18));
    }
  }

  if (scores.size === 0) {
    scores.set('neutral', 0.54);
  }

  return scores;
}

function topLabels(
  scores: ReadonlyMap<EvalEmotionLabel, number>,
  limit: number,
): EmotionLabelScore[] {
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([label, score]) => ({ label, score: round(score) }));
}

function appraisalFromText(text: string): AppraisalVector {
  const labels = topLabels(scoreText(text, {
    ...BASELINE_LEXICON,
    ...mergeLexicons(BASELINE_LEXICON, LABEL_AWARE_EXTRA_LEXICON),
  }), 3).map((score) => score.label);
  const primaryLabel = labels[0] ?? 'neutral';
  const lower = text.toLowerCase();
  const vector: AppraisalVector = {
    suddenness: lower.includes('just') || lower.includes('unexpected') ? 0.88 : 0.35,
    goalRelevance: primaryLabel === 'neutral' ? 0.2 : 0.78,
    agencyResponsibility: labels.includes('anger') || labels.includes('disgust') ? 0.84 : 0.5,
    control: labels.includes('fear') || labels.includes('sadness') ? 0.22 : 0.62,
    normCompatibility: labels.includes('anger') || labels.includes('disgust') ? 0.18 : 0.68,
    urgency: labels.includes('fear') || labels.includes('anger') ? 0.88 : 0.42,
    valence: labels.some((label) => ['joy', 'love', 'optimism', 'trust'].includes(label))
      ? 0.68
      : primaryLabel === 'neutral'
        ? 0
        : -0.72,
    arousal: labels.includes('fear') || labels.includes('anger') ? 0.88 : 0.45,
  };

  return Object.fromEntries(
    APPRAISAL_DIMENSIONS.map((dimension) => [dimension, round(vector[dimension])]),
  ) as AppraisalVector;
}

function mergeLexicons(left: Lexicon, right: Lexicon): Lexicon {
  const merged: Lexicon = {};
  const labels = new Set<EvalEmotionLabel>([
    ...(Object.keys(left) as EvalEmotionLabel[]),
    ...(Object.keys(right) as EvalEmotionLabel[]),
  ]);
  for (const label of labels) {
    merged[label] = [...(left[label] ?? []), ...(right[label] ?? [])];
  }
  return merged;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
