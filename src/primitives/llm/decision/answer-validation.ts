// Strict validation of decision answers against the questions that were asked.
//
// Both backends emit the OpenRouter Decisions API answer shape
// (`{type, noul}` / `{type, choice, probabilities?, confidence?}` /
// `{type, score, probabilities?, confidence?, legend?}`), so one validator owns
// the contract. Anything outside it — a missing or extra answer, a type
// mismatch, an unknown option, an out-of-range number — rejects the whole set:
// callers then apply their own safe default rather than act on a partial or
// drifted answer.

import { isRecord } from '../../../shared/utils/types.js';
import type {
  ChoiceDecisionQuestion,
  DecisionAnswer,
  DecisionAnswers,
  DecisionQuestion,
  DecisionQuestionSet,
  ScoreDecisionQuestion,
} from './types.js';

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readProbabilityMap(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): Record<string, number> | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const probabilities: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value)) {
    if (!allowedKeys.has(key) || !isUnitInterval(probability)) return null;
    probabilities[key] = probability;
  }
  return probabilities;
}

function readOptionalConfidence(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return isUnitInterval(value) ? value : null;
}

function validateChoice(question: ChoiceDecisionQuestion, raw: Record<string, unknown>): DecisionAnswer | null {
  const options = new Set(Object.keys(question.criteria));
  if (typeof raw.choice !== 'string' || !options.has(raw.choice)) return null;
  const probabilities = readProbabilityMap(raw.probabilities, options);
  const confidence = readOptionalConfidence(raw.confidence);
  if (probabilities === null || confidence === null) return null;
  return {
    type: 'choice',
    choice: raw.choice,
    ...(probabilities ? { probabilities } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

function validateScore(question: ScoreDecisionQuestion, raw: Record<string, unknown>): DecisionAnswer | null {
  const maxPosition = question.criteria.length - 1;
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score)) return null;
  if (raw.score < 0 || raw.score > maxPosition) return null;
  const levelKeys = new Set(question.criteria.map((_level, index) => String(index)));
  const probabilities = readProbabilityMap(raw.probabilities, levelKeys);
  const confidence = readOptionalConfidence(raw.confidence);
  if (probabilities === null || confidence === null) return null;
  return {
    type: 'score',
    score: raw.score,
    ...(probabilities ? { probabilities } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

function validateAnswer(question: DecisionQuestion, raw: unknown): DecisionAnswer | null {
  if (!isRecord(raw) || raw.type !== question.type) return null;
  switch (question.type) {
    case 'noul':
      return isUnitInterval(raw.noul) ? { type: 'noul', pYes: raw.noul } : null;
    case 'choice':
      return validateChoice(question, raw);
    case 'score':
      return validateScore(question, raw);
  }
}

/**
 * Validate a raw `answers` object against the asked questions. Returns null on
 * any contract violation (fail closed).
 */
export function validateDecisionAnswers(
  questions: DecisionQuestionSet,
  rawAnswers: unknown,
): DecisionAnswers | null {
  if (!isRecord(rawAnswers)) return null;
  const questionNames = Object.keys(questions);
  if (Object.keys(rawAnswers).length !== questionNames.length) return null;
  const answers: DecisionAnswers = {};
  for (const name of questionNames) {
    const question = questions[name];
    if (!question || !Object.hasOwn(rawAnswers, name)) return null;
    const answer = validateAnswer(question, rawAnswers[name]);
    if (!answer) return null;
    answers[name] = answer;
  }
  return answers;
}
