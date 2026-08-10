import { EVAL_EMOTION_LABELS, type EvalEmotionLabel } from '../src/types.js';

export interface TokenLogprobEntry {
  token?: string | null;
  logprob?: number | null;
}

export interface NormalizedLogprobCandidate {
  token: string;
  normalizedToken: string;
  logprob: number;
  probability: number;
  emotionLabel?: EvalEmotionLabel;
}

export interface TokenEntropySummary {
  primaryToken: string;
  primaryLabel?: EvalEmotionLabel;
  entropy: number;
  candidates: NormalizedLogprobCandidate[];
}

export interface SuppressionSignal {
  alternativeLabel: EvalEmotionLabel;
  alternativeProbability: number;
  reason: 'expected_label_alternative' | 'competing_emotion_alternative';
}

const EMOTION_LABEL_SET = new Set<string>(EVAL_EMOTION_LABELS);

export function normalizeToken(token: string): string {
  return token
    .trim()
    .toLowerCase()
    .replace(/^[\s"'{\[]+/, '')
    .replace(/[\s"'}\],.:;!?]+$/, '');
}

export function tokenToEmotionLabel(token: string): EvalEmotionLabel | undefined {
  const normalized = normalizeToken(token);
  if (!EMOTION_LABEL_SET.has(normalized)) {
    return undefined;
  }
  return normalized as EvalEmotionLabel;
}

export function normalizeCandidates(entries: readonly TokenLogprobEntry[]): NormalizedLogprobCandidate[] {
  const rows = entries
    .map((entry) => ({
      token: typeof entry.token === 'string' ? entry.token : '',
      logprob: typeof entry.logprob === 'number' ? entry.logprob : Number.NaN,
    }))
    .filter((entry) => entry.token.trim().length > 0 && Number.isFinite(entry.logprob));

  if (rows.length === 0) {
    return [];
  }

  const maxLogprob = Math.max(...rows.map((entry) => entry.logprob));
  const weights = rows.map((entry) => Math.exp(entry.logprob - maxLogprob));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  return rows
    .map((entry, index) => {
      const normalizedToken = normalizeToken(entry.token);
      return {
        token: entry.token,
        normalizedToken,
        logprob: entry.logprob,
        probability: totalWeight > 0 ? weights[index] / totalWeight : 0,
        ...(tokenToEmotionLabel(normalizedToken)
          ? { emotionLabel: tokenToEmotionLabel(normalizedToken) }
          : {}),
      };
    })
    .sort((left, right) => right.probability - left.probability);
}

export function computeEntropy(candidates: readonly NormalizedLogprobCandidate[]): number {
  return candidates.reduce((sum, candidate) => {
    if (candidate.probability <= 0) {
      return sum;
    }
    return sum - (candidate.probability * Math.log(candidate.probability));
  }, 0);
}

export function summarizeTokenEntropy(
  primaryToken: string,
  topLogprobs: readonly TokenLogprobEntry[],
): TokenEntropySummary {
  const primaryEntry: TokenLogprobEntry = { token: primaryToken, logprob: 0 };
  const candidates = normalizeCandidates([primaryEntry, ...topLogprobs]);
  return {
    primaryToken,
    ...(tokenToEmotionLabel(primaryToken) ? { primaryLabel: tokenToEmotionLabel(primaryToken) } : {}),
    entropy: computeEntropy(candidates),
    candidates,
  };
}

export function detectSuppressionSignal(
  summary: TokenEntropySummary,
  expectedLabels: readonly EvalEmotionLabel[],
  threshold = 0.12,
): SuppressionSignal | undefined {
  const primaryLabel = summary.primaryLabel;
  const alternatives = summary.candidates.filter((candidate) => {
    if (!candidate.emotionLabel) {
      return false;
    }
    if (candidate.emotionLabel === primaryLabel) {
      return false;
    }
    return candidate.probability >= threshold;
  });

  const expectedAlternative = alternatives.find((candidate) =>
    expectedLabels.includes(candidate.emotionLabel as EvalEmotionLabel),
  );
  if (expectedAlternative?.emotionLabel) {
    return {
      alternativeLabel: expectedAlternative.emotionLabel,
      alternativeProbability: expectedAlternative.probability,
      reason: 'expected_label_alternative',
    };
  }

  const competingAlternative = alternatives[0];
  if (competingAlternative?.emotionLabel) {
    return {
      alternativeLabel: competingAlternative.emotionLabel,
      alternativeProbability: competingAlternative.probability,
      reason: 'competing_emotion_alternative',
    };
  }

  return undefined;
}
