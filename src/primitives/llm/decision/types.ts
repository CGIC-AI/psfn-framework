// Typed decision primitive contracts (epic psfn-framework-4lf3r).
//
// A decision is a narrow typed judgement over a JSON state: a yes/no
// probability (noul), one option out of N (choice), or a position on an ordered
// scale (score). The question shapes mirror the OpenRouter Decisions API
// (POST /api/alpha/decisions) so a remote backend maps across without
// translation, while the local backend answers the same questions with the
// configured background model.

import type { LLMWorkSpec } from '../../../shared/contracts/runtime.js';
import type { DecisionSiteId } from '../../../system/config/decision-backend-config.js';

interface NoulDecisionQuestion {
  type: 'noul';
  instructions: string;
  /** Optional guidance for what counts as yes and no. */
  criteria?: { true: string; false: string };
}

export interface ChoiceDecisionQuestion {
  type: 'choice';
  instructions: string;
  /** Option id -> description. The answer's `choice` is one of these keys. */
  criteria: Readonly<Record<string, string>>;
}

export interface ScoreDecisionQuestion {
  type: 'score';
  instructions: string;
  /** Ordered levels; index 0 is the lowest position on the scale. */
  criteria: readonly string[];
}

export type DecisionQuestion =
  | NoulDecisionQuestion
  | ChoiceDecisionQuestion
  | ScoreDecisionQuestion;

export type DecisionQuestionSet = Readonly<Record<string, DecisionQuestion>>;

interface NoulDecisionAnswer {
  type: 'noul';
  /** Probability that the answer is yes, in [0, 1]. */
  pYes: number;
}

interface ChoiceDecisionAnswer {
  type: 'choice';
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

interface ScoreDecisionAnswer {
  type: 'score';
  /** Probability-weighted position on the scale, in [0, levels - 1]. */
  score: number;
  /** Level index (as a string key) -> probability. */
  probabilities?: Record<string, number>;
  confidence?: number;
}

export type DecisionAnswer =
  | NoulDecisionAnswer
  | ChoiceDecisionAnswer
  | ScoreDecisionAnswer;

export type DecisionAnswers = Record<string, DecisionAnswer>;

/**
 * Where an answer's probabilities came from. Only `jev` and `logprob` are
 * calibrated in any sense; self-reported model numbers are recorded but must
 * not be read as calibrated probabilities.
 */
export type DecisionProbabilitySource = 'jev' | 'logprob' | 'self_report_uncalibrated';

/** `local-fallback` means the remote backend was selected but local answered. */
type DecisionBackendId = 'local' | 'jev' | 'local-fallback';

/**
 * Privacy class of a decision site. `companion_private` state never leaves the
 * local backend, whatever the configured mode.
 */
export type DecisionSitePrivacy = 'shareable' | 'companion_private';

export interface DecisionRequest {
  /** Stable decision-site id; its privacy class is code-owned (sites.ts). */
  siteId: DecisionSiteId;
  /** JSON state the questions are evaluated against. */
  state: Readonly<Record<string, unknown>>;
  questions: DecisionQuestionSet;
  /** Work spec for the local model call (purpose `decision`). */
  workSpec: LLMWorkSpec;
  signal?: AbortSignal;
}

type DecisionFailureReason =
  | 'invalid_output'
  | 'error'
  | 'aborted';

interface DecisionSuccess {
  ok: true;
  answers: DecisionAnswers;
  backend: DecisionBackendId;
  probabilitySource: DecisionProbabilitySource;
  latencyMs: number;
  /** Provider-reported cost in USD, when the backend reports one. */
  costUsd?: number;
  /** Model or dated snapshot that answered, when known. */
  model?: string;
}

interface DecisionFailure {
  ok: false;
  reason: DecisionFailureReason;
  backend: DecisionBackendId;
  latencyMs: number;
}

/** A decide() result. Callers apply their own safe default on failure. */
export type DecisionOutcome = DecisionSuccess | DecisionFailure;
