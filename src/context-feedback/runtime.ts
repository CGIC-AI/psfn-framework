import type { PostTurnActionInferer } from '../agent/substrate-agent.js';
import type { LLMProvider } from '../agent/contracts.js';
import type { PostTurnActionRuntime } from '../bootstrap/post-turn-actions.js';
import type { EventBus } from '../shared/event-bus.js';
import { createComponentLogger } from '../shared/logger.js';
import type { ContextManifest } from '../session/context-manifest.js';
import type { SessionStore } from '../session/store.js';
import type { PostTurnActionCandidate } from '../types.js';
import { isRecord } from '../shared/utils/types.js';
import {
  ContextEvaluator,
  type ContextFeedbackSignalKey,
} from './evaluator.js';

const log = createComponentLogger('ContextFeedback');
const CONTEXT_FEEDBACK_RECENT_LOOKBACK = 48;
const FOLLOW_UP_TEXT_MAX_CHARS = 1_200;

export const CONTEXT_FEEDBACK_ACTION_KIND = 'context.score_feedback';

export interface ContextFeedbackRuntimeAgentLoop {
  registerPostTurnActionInferer?(inferer: PostTurnActionInferer): () => void;
}

export interface WireContextFeedbackRuntimeOptions {
  agentLoop: ContextFeedbackRuntimeAgentLoop;
  postTurnActions: PostTurnActionRuntime;
  llmProvider: LLMProvider;
  sessionStore: Pick<SessionStore, 'getRecent'>;
  eventBus: EventBus;
}

export interface ContextFeedbackActionPayload {
  turnId: string;
  completedAt: number;
  channelId: string;
  userMessage: string;
  assistantResponse: string;
  responseModel: string;
  responseInputTokens: number;
  responseOutputTokens: number;
  contextManifest: ContextManifest;
  canonicalContactKey?: string;
}

function parseRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Context feedback payload field "${field}" must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Context feedback payload field "${field}" cannot be empty`);
  }
  return trimmed;
}

function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Context feedback payload field "${field}" must be a string when provided`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Context feedback payload field "${field}" must be a finite number`);
  }
  if (value < 0) {
    throw new Error(`Context feedback payload field "${field}" must be non-negative`);
  }
  return value;
}

function normalizeContextManifest(value: unknown): ContextManifest {
  if (!isRecord(value)) {
    throw new Error('Context feedback payload field "contextManifest" must be an object');
  }

  parseRequiredString(value.channelId, 'contextManifest.channelId');
  parseNonNegativeNumber(value.generatedAt, 'contextManifest.generatedAt');

  const session = value.session;
  if (!isRecord(session)) {
    throw new Error('Context feedback payload field "contextManifest.session" must be an object');
  }
  parseNonNegativeNumber(session.finalMessageCount, 'contextManifest.session.finalMessageCount');

  const memory = value.memory;
  if (!isRecord(memory)) {
    throw new Error('Context feedback payload field "contextManifest.memory" must be an object');
  }
  parseNonNegativeNumber(memory.includedCount, 'contextManifest.memory.includedCount');

  const budgets = value.budgets;
  if (!isRecord(budgets)) {
    throw new Error('Context feedback payload field "contextManifest.budgets" must be an object');
  }
  parseNonNegativeNumber(budgets.contextWindow, 'contextManifest.budgets.contextWindow');
  if (!Array.isArray(budgets.sections)) {
    throw new Error('Context feedback payload field "contextManifest.budgets.sections" must be an array');
  }
  for (const [index, section] of budgets.sections.entries()) {
    if (!isRecord(section)) {
      throw new Error(`Context feedback payload field "contextManifest.budgets.sections[${index}]" must be an object`);
    }
    parseRequiredString(section.section, `contextManifest.budgets.sections[${index}].section`);
    parseNonNegativeNumber(section.tokenCount, `contextManifest.budgets.sections[${index}].tokenCount`);
  }

  const compaction = value.compaction;
  if (!isRecord(compaction)) {
    throw new Error('Context feedback payload field "contextManifest.compaction" must be an object');
  }
  if (typeof compaction.triggered !== 'boolean') {
    throw new Error('Context feedback payload field "contextManifest.compaction.triggered" must be boolean');
  }

  return value as unknown as ContextManifest;
}

export function normalizeContextFeedbackActionPayload(payload: unknown): ContextFeedbackActionPayload | null {
  if (!isRecord(payload)) return null;
  const canonicalContactKey = parseOptionalString(payload.canonicalContactKey, 'canonicalContactKey');

  return {
    turnId: parseRequiredString(payload.turnId, 'turnId'),
    completedAt: parseNonNegativeNumber(payload.completedAt, 'completedAt'),
    channelId: parseRequiredString(payload.channelId, 'channelId'),
    userMessage: parseRequiredString(payload.userMessage, 'userMessage'),
    assistantResponse: parseRequiredString(payload.assistantResponse, 'assistantResponse'),
    responseModel: parseRequiredString(payload.responseModel, 'responseModel'),
    responseInputTokens: parseNonNegativeNumber(payload.responseInputTokens, 'responseInputTokens'),
    responseOutputTokens: parseNonNegativeNumber(payload.responseOutputTokens, 'responseOutputTokens'),
    contextManifest: normalizeContextManifest(payload.contextManifest),
    ...(canonicalContactKey ? { canonicalContactKey } : {}),
  };
}

function cloneContextManifest(manifest: ContextManifest): ContextManifest {
  return JSON.parse(JSON.stringify(manifest)) as ContextManifest;
}

function scoreBucket(score: number): 'low' | 'medium' | 'high' {
  if (score >= 0.8) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

function resolveFollowUpText(
  sessionStore: Pick<SessionStore, 'getRecent'>,
  payload: ContextFeedbackActionPayload,
): string | undefined {
  const recent = sessionStore.getRecent(payload.channelId, CONTEXT_FEEDBACK_RECENT_LOOKBACK);
  const firstFollowUp = recent
    .filter(entry => (
      entry.role === 'user'
      && Number.isFinite(entry.timestamp)
      && entry.timestamp > payload.completedAt
      && entry.content.trim().length > 0
    ))
    .sort((left, right) => left.timestamp - right.timestamp)
    .at(0);

  if (!firstFollowUp) return undefined;
  const trimmed = firstFollowUp.content.trim();
  if (trimmed.length <= FOLLOW_UP_TEXT_MAX_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, FOLLOW_UP_TEXT_MAX_CHARS)}…`;
}

function buildContextFeedbackCandidate(context: Parameters<PostTurnActionInferer>[0]): PostTurnActionCandidate[] {
  if (!context.contextManifest) {
    return [];
  }
  if (!context.turnId || !Number.isFinite(context.completedAt) || context.completedAt <= 0) {
    return [];
  }
  if (!context.response.content.trim()) {
    return [];
  }

  return [{
    kind: CONTEXT_FEEDBACK_ACTION_KIND,
    dedupeKey: `${CONTEXT_FEEDBACK_ACTION_KIND}:${context.turnId}`,
    payload: {
      turnId: context.turnId,
      completedAt: context.completedAt,
      channelId: context.message.channelId,
      userMessage: context.message.content,
      assistantResponse: context.response.content,
      responseModel: context.response.metadata.model,
      responseInputTokens: context.response.metadata.inputTokens,
      responseOutputTokens: context.response.metadata.outputTokens,
      contextManifest: cloneContextManifest(context.contextManifest),
      ...(context.canonicalContactKey ? { canonicalContactKey: context.canonicalContactKey } : {}),
    } satisfies ContextFeedbackActionPayload,
    maxRetries: 1,
  }];
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function emitContextFeedbackTelemetry(
  eventBus: EventBus,
  payload: {
    actionId: string;
    turnId: string;
    channelId: string;
    phase: 'started' | 'scored' | 'persisted' | 'failed';
    score?: number;
    scoreBucket?: 'low' | 'medium' | 'high';
    signals?: Record<ContextFeedbackSignalKey, boolean>;
    followUpIncluded?: boolean;
    memoryId?: string;
    error?: string;
  },
): Promise<void> {
  try {
    await eventBus.emit('context.feedback.telemetry', {
      ...payload,
      timestamp: Date.now(),
    });
  } catch (error) {
    log.warn('Context feedback telemetry emit failed', {
      actionId: payload.actionId,
      phase: payload.phase,
      error: normalizeErrorMessage(error),
    });
  }
}

export function wireContextFeedbackRuntime(options: WireContextFeedbackRuntimeOptions): void {
  const evaluator = new ContextEvaluator(options.llmProvider);

  if (typeof options.agentLoop.registerPostTurnActionInferer === 'function') {
    options.agentLoop.registerPostTurnActionInferer(buildContextFeedbackCandidate);
  } else {
    log.warn('Context feedback inferer not registered because agent loop does not expose inferer registration');
  }

  options.postTurnActions.registerHandler(
    CONTEXT_FEEDBACK_ACTION_KIND,
    async (action) => {
      let payload: ContextFeedbackActionPayload | null = null;
      try {
        payload = normalizeContextFeedbackActionPayload(action.payload);
        if (!payload) {
          throw new Error(`Context feedback action "${action.id}" payload is missing or malformed`);
        }

        await emitContextFeedbackTelemetry(options.eventBus, {
          actionId: action.id,
          turnId: payload.turnId,
          channelId: payload.channelId,
          phase: 'started',
        });

        const followUpText = resolveFollowUpText(options.sessionStore, payload);
        const evaluation = await evaluator.evaluate({
          turnId: payload.turnId,
          channelId: payload.channelId,
          contextManifest: payload.contextManifest,
          userMessage: payload.userMessage,
          assistantResponse: payload.assistantResponse,
          responseMetadata: {
            model: payload.responseModel,
            inputTokens: payload.responseInputTokens,
            outputTokens: payload.responseOutputTokens,
          },
          ...(followUpText ? { userFollowUp: followUpText } : {}),
        });

        await emitContextFeedbackTelemetry(options.eventBus, {
          actionId: action.id,
          turnId: payload.turnId,
          channelId: payload.channelId,
          phase: 'scored',
          score: evaluation.effectivenessScore,
          scoreBucket: scoreBucket(evaluation.effectivenessScore),
          signals: evaluation.signals,
          followUpIncluded: Boolean(followUpText),
        });

        await emitContextFeedbackTelemetry(options.eventBus, {
          actionId: action.id,
          turnId: payload.turnId,
          channelId: payload.channelId,
          phase: 'persisted',
          score: evaluation.effectivenessScore,
          scoreBucket: scoreBucket(evaluation.effectivenessScore),
          signals: evaluation.signals,
          followUpIncluded: Boolean(followUpText),
        });
      } catch (error) {
        const errorMessage = normalizeErrorMessage(error);
        await emitContextFeedbackTelemetry(options.eventBus, {
          actionId: action.id,
          turnId: payload?.turnId ?? 'unknown',
          channelId: payload?.channelId ?? action.channelId,
          phase: 'failed',
          error: errorMessage,
        });
        throw error;
      }
    },
    { executionMode: 'background' },
  );

  log.info('Context feedback runtime wired');
}
