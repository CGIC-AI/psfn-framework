import type { LLMProvider } from '../core/agent/contracts.js';
import type { ContextManifest } from '../session/context-manifest.js';
import type { ResponseMetadata } from '../shared/contracts/runtime.js';
import { isRecord } from '../shared/utils/types.js';

export const CONTEXT_FEEDBACK_SIGNAL_KEYS = [
  'confabulation',
  'missed_context',
  'wasted_tokens',
  'good',
] as const;

export type ContextFeedbackSignalKey = typeof CONTEXT_FEEDBACK_SIGNAL_KEYS[number];

export interface ContextEvaluationSignals {
  confabulation: boolean;
  missed_context: boolean;
  wasted_tokens: boolean;
  good: boolean;
}

export interface ContextEvaluationInput {
  turnId: string;
  channelId: string;
  contextManifest: ContextManifest;
  userMessage: string;
  assistantResponse: string;
  responseMetadata: Pick<ResponseMetadata, 'model' | 'inputTokens' | 'outputTokens'>;
  userFollowUp?: string;
}

export interface ContextEvaluationResult {
  effectivenessScore: number;
  signals: ContextEvaluationSignals;
  summary: string;
  evaluationModel: string;
}

interface ParsedEvaluationResponse {
  effectivenessScore: number;
  signals: ContextEvaluationSignals;
  summary: string;
}

const MAX_MESSAGE_CHARS = 4_000;
const MAX_FOLLOW_UP_CHARS = 1_200;

const EVALUATOR_SYSTEM_PROMPT = [
  'You evaluate context-composition effectiveness after an assistant response.',
  'Assess whether the context structure likely helped or hurt response quality.',
  'Return JSON only, no markdown, with EXACT keys:',
  '{"effectivenessScore":number,"signals":{"confabulation":boolean,"missed_context":boolean,"wasted_tokens":boolean,"good":boolean},"summary":string}',
  'Rules:',
  '- effectivenessScore must be in [0, 1].',
  '- confabulation=true when response likely invented unsupported facts.',
  '- missed_context=true when relevant available context appears unused.',
  '- wasted_tokens=true when context appears oversized/irrelevant for the response.',
  '- good=true when context composition appears effective overall.',
  '- summary must be concise and concrete (max ~280 chars).',
].join('\n');

function trimForPrompt(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

function extractJsonCandidate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Context evaluator response is empty');
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    const fencedBody = fenced[1].trim();
    if (fencedBody.startsWith('{') && fencedBody.endsWith('}')) {
      return fencedBody;
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error('Context evaluator response does not contain a JSON object');
}

function parseSignalFlags(value: unknown): ContextEvaluationSignals {
  if (!isRecord(value)) {
    throw new Error('Context evaluator response field "signals" must be an object');
  }

  const signals = {} as ContextEvaluationSignals;
  for (const key of CONTEXT_FEEDBACK_SIGNAL_KEYS) {
    const raw = value[key];
    if (typeof raw !== 'boolean') {
      throw new Error(`Context evaluator response field "signals.${key}" must be boolean`);
    }
    signals[key] = raw;
  }
  return signals;
}

function parseUnitInterval(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Context evaluator response field "${field}" must be a finite number`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`Context evaluator response field "${field}" must be within [0, 1]`);
  }
  return value;
}

export function parseContextEvaluationResponse(raw: string): ParsedEvaluationResponse {
  const jsonCandidate = extractJsonCandidate(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch (error) {
    throw new Error(`Context evaluator response is invalid JSON: ${String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('Context evaluator response must be a JSON object');
  }

  const effectivenessScore = parseUnitInterval(parsed.effectivenessScore, 'effectivenessScore');
  const signals = parseSignalFlags(parsed.signals);

  const summary = typeof parsed.summary === 'string'
    ? parsed.summary.trim()
    : '';
  if (!summary) {
    throw new Error('Context evaluator response field "summary" must be a non-empty string');
  }

  return {
    effectivenessScore,
    signals,
    summary,
  };
}

function buildEvaluationPrompt(input: ContextEvaluationInput): string {
  const payload = {
    turn: {
      turnId: input.turnId,
      channelId: input.channelId,
    },
    response: {
      userMessage: trimForPrompt(input.userMessage, MAX_MESSAGE_CHARS),
      assistantResponse: trimForPrompt(input.assistantResponse, MAX_MESSAGE_CHARS),
      metadata: input.responseMetadata,
      ...(input.userFollowUp
        ? { userFollowUp: trimForPrompt(input.userFollowUp, MAX_FOLLOW_UP_CHARS) }
        : {}),
    },
    contextManifest: input.contextManifest,
  };

  return JSON.stringify(payload, null, 2);
}

export class ContextEvaluator {
  private readonly llmProvider: LLMProvider;

  constructor(llmProvider: LLMProvider) {
    this.llmProvider = llmProvider;
  }

  async evaluate(input: ContextEvaluationInput): Promise<ContextEvaluationResult> {
    const completion = await this.llmProvider.complete({
      systemPrompt: EVALUATOR_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: buildEvaluationPrompt(input),
      }],
      correlation: {
        requestId: input.turnId,
        turnId: input.turnId,
        channelId: input.channelId,
        callType: 'memory',
        originType: 'memory',
        originStage: 'context.feedback',
        purpose: 'context.feedback',
      },
    }, 'memory');

    const parsed = parseContextEvaluationResponse(completion.content);
    return {
      ...parsed,
      evaluationModel: completion.model,
    };
  }
}
