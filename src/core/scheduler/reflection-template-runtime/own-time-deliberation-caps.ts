import type { CompletionPurpose } from '../../../shared/contracts/runtime.js';
import {
  defaultDeliberationMaxRounds,
  type DeliberationResult,
} from '../../../primitives/llm/deliberation.js';
import { toCompletionRoutingPurpose, type RoutingPurpose } from '../../../primitives/llm/routing.js';
import { countTokens } from '../../../primitives/llm/tokens.js';
import { getShippedDeliberationCaps, type ReflectionTemplate } from '../reflection-policy.js';

/**
 * Run caps for a reflection deliberation, the companion thinking on its own
 * time at medium reasoning or more (psfn-framework-cdqin).
 *
 * The caps stay as runaway fuses, but they may not cut the deliberation short
 * of what its own rounds need:
 * - `maxTotalTokens` (input plus output, across every call) is at least what
 *   every call could use at its routed per-call budget, the slot budget that
 *   reasoning tokens share, with the full authoritative system prompt and the
 *   carried prior outputs as input;
 * - both caps are at least the shipped template caps, which are sized for
 *   reasoning (see `getShippedDeliberationCaps`).
 *
 * A template may raise either cap; a lower value is raised to the floor and
 * reported in `raised` so the caller can say so.
 */

export interface OwnTimeDeliberationShape {
  /** Rounds the run may take (stages, for a fixed stage sequence). */
  readonly rounds: number;
  /** Model calls per round: the voices and the aggregator, or one per stage. */
  readonly callsPerRound: number;
  /** Prior outputs the largest call carries as input. */
  readonly carriedOutputs: number;
  /** Purposes the run calls, to find the largest routed per-call budget. */
  readonly purposes: readonly CompletionPurpose[];
}

export type OwnTimeDeliberationCapName = 'maxTotalTokens' | 'maxWallTimeMs';

export interface OwnTimeDeliberationCaps {
  readonly maxTotalTokens: number;
  readonly maxWallTimeMs: number;
}

export interface OwnTimeDeliberationCapsResolution {
  readonly caps: OwnTimeDeliberationCaps;
  readonly raised: ReadonlyArray<{
    setting: OwnTimeDeliberationCapName;
    configured: number;
    effective: number;
  }>;
}

export interface ResolveOwnTimeDeliberationCapsInput {
  readonly template: ReflectionTemplate;
  readonly shape: OwnTimeDeliberationShape;
  /** Every text each call carries: the authoritative system prompt and the reflection prompt. */
  readonly inputTexts: readonly string[];
  /** The routed per-call output budget for a purpose; absent when routing is unavailable. */
  readonly completionBudget?: (purpose: RoutingPurpose) => number | undefined;
}

/** The shape of a voices-and-aggregator deliberation for a template. */
export function voiceDeliberationShape(template: ReflectionTemplate): OwnTimeDeliberationShape {
  const voices = new Set<CompletionPurpose>(template.deliberation?.voices ?? ['reasoning', 'background']);
  return {
    rounds: template.deliberation?.maxRounds ?? defaultDeliberationMaxRounds(),
    callsPerRound: voices.size + 1,
    // The aggregator carries every voice and the previous synthesis.
    carriedOutputs: voices.size + 1,
    // The aggregator runs on the reasoning purpose.
    purposes: [...voices, 'reasoning'],
  };
}

function largestCompletionBudget(input: ResolveOwnTimeDeliberationCapsInput): number | undefined {
  const budgets = input.shape.purposes
    .map(purpose => input.completionBudget?.(toCompletionRoutingPurpose(purpose)))
    .filter((budget): budget is number => budget !== undefined && Number.isFinite(budget) && budget > 0);
  return budgets.length > 0 ? Math.max(...budgets) : undefined;
}

function reasoningTokenFloor(input: ResolveOwnTimeDeliberationCapsInput): number {
  const budget = largestCompletionBudget(input);
  if (budget === undefined) return 0;
  const inputTokens = input.inputTexts.reduce((sum, text) => sum + countTokens(text), 0);
  const perCall = inputTokens + (input.shape.carriedOutputs + 1) * budget;
  return Math.max(1, Math.floor(input.shape.rounds)) * input.shape.callsPerRound * perCall;
}

export function resolveOwnTimeDeliberationCaps(
  input: ResolveOwnTimeDeliberationCapsInput,
): OwnTimeDeliberationCapsResolution {
  const shipped = getShippedDeliberationCaps(input.template.id);
  const configured = input.template.deliberation;
  const floors: Record<OwnTimeDeliberationCapName, number> = {
    maxTotalTokens: Math.max(shipped.maxTotalTokens, reasoningTokenFloor(input)),
    maxWallTimeMs: shipped.maxWallTimeMs,
  };
  const raised: Array<OwnTimeDeliberationCapsResolution['raised'][number]> = [];
  const resolve = (cap: OwnTimeDeliberationCapName): number => {
    const value = configured?.[cap];
    if (value === undefined) return floors[cap];
    const own = Math.floor(value);
    if (own >= floors[cap]) return own;
    raised.push({ setting: cap, configured: own, effective: floors[cap] });
    return floors[cap];
  };
  return {
    caps: { maxTotalTokens: resolve('maxTotalTokens'), maxWallTimeMs: resolve('maxWallTimeMs') },
    raised,
  };
}

export interface OwnTimeDeliberationCut {
  /** The cap setting that stopped the run. */
  setting: OwnTimeDeliberationCapName | 'maxTokensPerRound';
  limit: number;
  used: number;
}

/**
 * The cap that stopped a deliberation before it finished, if one did: rounds
 * (or stages) were left unrun, or the last round ended without its aggregator.
 * A cap crossed by the final call of a complete run cut nothing.
 */
export function describeOwnTimeDeliberationCut(
  result: DeliberationResult,
  shape: OwnTimeDeliberationShape,
): OwnTimeDeliberationCut | null {
  const { budget, exit } = result.episode;
  const lastRound = result.rounds.at(-1);
  const roundsLeft = result.rounds.length < Math.min(shape.rounds, budget.maxRounds);
  const aggregatorSkipped = shape.callsPerRound > 1 && lastRound !== undefined && lastRound.aggregatorModel === undefined;
  if (!roundsLeft && !aggregatorSkipped) return null;
  if (exit.maxTotalTokensReached) {
    return { setting: 'maxTotalTokens', limit: budget.maxTotalTokens, used: result.totalTokens };
  }
  if (exit.maxWallTimeReached) {
    return { setting: 'maxWallTimeMs', limit: budget.maxWallTimeMs, used: result.durationMs };
  }
  if (exit.maxTokensPerRoundReached && budget.maxTokensPerRound !== undefined) {
    return {
      setting: 'maxTokensPerRound',
      limit: budget.maxTokensPerRound,
      used: (lastRound?.inputTokens ?? 0) + (lastRound?.outputTokens ?? 0),
    };
  }
  return null;
}
