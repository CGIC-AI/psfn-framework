// Shadow-mode comparison records (epic 4lf3r).
//
// In shadow mode both backends answer; the site acts on the local answer and
// one record per decision is appended to a JSONL ledger. Records are
// content-free: site id, question names and types, the typed answers (option
// keys and probabilities, which are code-defined labels), latencies, cost and
// the answering snapshot. The decision state itself is never written.

import { appendJsonLine } from '../../../shared/utils/jsonl.js';
import type { DecisionSiteId } from '../../../system/config/decision-backend-config.js';
import type {
  DecisionAnswer,
  DecisionAnswers,
  DecisionOutcome,
  DecisionQuestionSet,
} from './types.js';

interface ShadowSide {
  ok: boolean;
  reason?: string;
  answers?: DecisionAnswers;
  latencyMs: number;
  probabilitySource?: string;
  model?: string;
  costUsd?: number;
}

export interface DecisionShadowRecord {
  schemaVersion: 1;
  recordType: 'decision_shadow_comparison';
  recordedAtMs: number;
  siteId: DecisionSiteId;
  questions: Record<string, DecisionQuestionSet[string]['type']>;
  local: ShadowSide;
  jev: ShadowSide;
  /** Per question: true/false when both answered, null when either failed. */
  agreement: Record<string, boolean | null>;
}

export interface DecisionShadowSink {
  record(entry: DecisionShadowRecord): void;
}

function toSide(outcome: DecisionOutcome): ShadowSide {
  if (!outcome.ok) return { ok: false, reason: outcome.reason, latencyMs: outcome.latencyMs };
  return {
    ok: true,
    answers: outcome.answers,
    latencyMs: outcome.latencyMs,
    probabilitySource: outcome.probabilitySource,
    ...(outcome.model !== undefined ? { model: outcome.model } : {}),
    ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
  };
}

/** Whether two answers to the same question agree on the acted-on value. */
function decisionAnswersAgree(left: DecisionAnswer, right: DecisionAnswer): boolean {
  if (left.type === 'noul' && right.type === 'noul') {
    return (left.pYes >= 0.5) === (right.pYes >= 0.5);
  }
  if (left.type === 'choice' && right.type === 'choice') return left.choice === right.choice;
  if (left.type === 'score' && right.type === 'score') {
    return Math.round(left.score) === Math.round(right.score);
  }
  return false;
}

export function buildDecisionShadowRecord(input: {
  siteId: DecisionSiteId;
  questions: DecisionQuestionSet;
  local: DecisionOutcome;
  jev: DecisionOutcome;
  recordedAtMs: number;
}): DecisionShadowRecord {
  const agreement: Record<string, boolean | null> = {};
  for (const name of Object.keys(input.questions)) {
    const localAnswer = input.local.ok ? input.local.answers[name] : undefined;
    const jevAnswer = input.jev.ok ? input.jev.answers[name] : undefined;
    agreement[name] = localAnswer && jevAnswer ? decisionAnswersAgree(localAnswer, jevAnswer) : null;
  }
  return {
    schemaVersion: 1,
    recordType: 'decision_shadow_comparison',
    recordedAtMs: input.recordedAtMs,
    siteId: input.siteId,
    questions: Object.fromEntries(
      Object.entries(input.questions).map(([name, question]) => [name, question.type]),
    ),
    local: toSide(input.local),
    jev: toSide(input.jev),
    agreement,
  };
}

export function createJsonlDecisionShadowSink(path: string): DecisionShadowSink {
  return { record: (entry) => appendJsonLine(path, entry) };
}
