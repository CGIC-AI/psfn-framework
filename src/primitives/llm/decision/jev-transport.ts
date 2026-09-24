// OpenRouter Decisions API transport for the Jev decision model (epic 4lf3r).
//
// Contract (verified 2026-09-24 against the published OpenAPI operation
// createApiAlphaDecisions and the OpenRouter Jev tutorial):
//   POST https://openrouter.ai/api/alpha/decisions
//   Authorization: Bearer <OpenRouter API key>
//   {model, state, questions: {<name>: {type: noul|choice|score, instructions,
//    criteria}}, provider?}
//   -> {id, model: <dated snapshot>, provider, answers: {<name>: {type, ...}},
//       usage: {input_tokens, output_tokens, cost?}}
//
// pi-ai only speaks chat completions, so this is a separate, deliberately small
// HTTP client. The endpoint is ALPHA: any response outside the documented
// shape, and any snapshot other than the pinned one, is a typed failure that
// the decision runtime answers locally. Nothing here throws on a bad response.
// Error bodies are never surfaced: they can echo the submitted state.

import { isRecord } from '../../../shared/utils/types.js';
import { validateDecisionAnswers } from './answer-validation.js';
import type { DecisionOutcome, DecisionQuestionSet } from './types.js';

export interface JevTransportConfig {
  endpointUrl: string;
  apiKey: string;
  /** Pinned release id sent as `model`, e.g. `typesafe/jev-1.13`. */
  model: string;
  /** Dated snapshot the response must name; null accepts any snapshot of `model`. */
  expectedSnapshot: string | null;
}

/** Minimal fetch surface so tests inject a recorded exchange (no live calls). */
export type DecisionsFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface JevTransportResult {
  outcome: DecisionOutcome;
  usage?: { inputTokens: number; outputTokens: number };
  httpStatus?: number;
}

/**
 * Zero-retention routing is not optional: the Decisions request always asks
 * OpenRouter for ZDR endpoints that do not collect data, with no fallback to a
 * provider that would. A routing refusal is an ordinary failure (local answers).
 */
const PRIVATE_PROVIDER_PREFERENCES = { zdr: true, data_collection: 'deny', allow_fallbacks: false } as const;

export function buildJevDecisionsRequestBody(
  model: string,
  state: Readonly<Record<string, unknown>>,
  questions: DecisionQuestionSet,
): Record<string, unknown> {
  return { model, state, questions, provider: PRIVATE_PROVIDER_PREFERENCES };
}

function readUsage(value: unknown): { inputTokens: number; outputTokens: number; costUsd?: number } | null {
  if (!isRecord(value)) return null;
  const { input_tokens: inputTokens, output_tokens: outputTokens, cost } = value;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) return null;
  if (cost !== undefined && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) return null;
  return {
    inputTokens: Number(inputTokens),
    outputTokens: Number(outputTokens),
    ...(typeof cost === 'number' ? { costUsd: cost } : {}),
  };
}

function snapshotMatches(config: JevTransportConfig, model: string): boolean {
  if (config.expectedSnapshot !== null) return model === config.expectedSnapshot;
  return model === config.model || model.startsWith(`${config.model}-`);
}

export async function requestJevDecision(
  config: JevTransportConfig,
  request: { state: Readonly<Record<string, unknown>>; questions: DecisionQuestionSet },
  options: { fetch: DecisionsFetch; signal: AbortSignal; now?: () => number },
): Promise<JevTransportResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const failed = (reason: 'invalid_output' | 'error' | 'aborted', httpStatus?: number): JevTransportResult => ({
    outcome: { ok: false, reason, backend: 'jev', latencyMs: now() - startedAt },
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  });

  let status: number;
  let text: string;
  try {
    const response = await options.fetch(config.endpointUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildJevDecisionsRequestBody(config.model, request.state, request.questions)),
      signal: options.signal,
    });
    status = response.status;
    if (!response.ok) return failed('error', status);
    text = await response.text();
  } catch {
    // Network or abort failure; the runtime answers locally.
    return failed(options.signal.aborted ? 'aborted' : 'error');
  }

  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // A non-JSON 2xx body is contract drift, not a crash.
    return failed('invalid_output', status);
  }
  if (!isRecord(body) || typeof body.model !== 'string' || !snapshotMatches(config, body.model)) {
    return failed('invalid_output', status);
  }
  const usage = readUsage(body.usage);
  const answers = validateDecisionAnswers(request.questions, body.answers);
  if (!usage || !answers) return failed('invalid_output', status);

  return {
    outcome: {
      ok: true,
      answers,
      backend: 'jev',
      probabilitySource: 'jev',
      latencyMs: now() - startedAt,
      model: body.model,
      ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    },
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    httpStatus: status,
  };
}
