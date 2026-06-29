import type { CompletionPurpose, ContextMessage } from '../../../shared/contracts/runtime.js';
import {
  classifyAppraisalTrigger,
  hasDueSoonConcern,
  maxEmotionShift,
} from './classification.js';
import { buildNoopDecision, parseDecisionResponse } from './decision-parser.js';
import { buildAppraisalPromptPayload } from './drive-signals.js';
import { normalizeInput } from './input-normalization.js';
import {
  buildAppraisalPersonaContext,
  buildRuntimeAppraisalSystemPrompt,
} from './persona.js';
import {
  DEFAULT_APPRAISAL_FREQUENCY,
  DEFAULT_DUE_SOON_WINDOW_MS,
  DEFAULT_EMOTIONAL_SHIFT_THRESHOLD,
  DEFAULT_MAX_CONCERN_COUNT,
  DEFAULT_MAX_DECISIONS,
  DEFAULT_MAX_MESSAGE_CHARS,
  DEFAULT_RECENT_MESSAGE_COUNT,
  DEFAULT_SYSTEM_PROMPT,
  type AppraisalPersonaContext,
  type IntentionActionDecision,
  type IntentionAppraisalConfig,
  type IntentionAppraisalInput,
  type SessionAppraisalState,
} from './types.js';
import {
  normalizePositiveInteger,
  normalizePositiveNumber,
} from './shared.js';

export class IntentionAppraisal {
  private readonly llmProvider: IntentionAppraisalConfig['llmProvider'];
  private readonly appraisalFrequency: number;
  private readonly emotionalShiftThreshold: number;
  private readonly dueSoonWindowMs: number;
  private readonly recentMessageCount: number;
  private readonly maxMessageChars: number;
  private readonly maxConcernCount: number;
  private readonly maxDecisions: number;
  private readonly systemPrompt: string;
  private readonly fallbackCharacterName?: string;
  private readonly resolveCharacterPromptVariables: () => Record<string, string>;
  private readonly onEvaluationError?: IntentionAppraisalConfig['onEvaluationError'];
  private readonly sessionState = new Map<string, SessionAppraisalState>();

  constructor(config: IntentionAppraisalConfig) {
    this.llmProvider = config.llmProvider;
    this.appraisalFrequency = normalizePositiveInteger(
      config.appraisalFrequency,
      DEFAULT_APPRAISAL_FREQUENCY,
      'Intention appraisal frequency',
    );
    this.emotionalShiftThreshold = normalizePositiveNumber(
      config.emotionalShiftThreshold,
      DEFAULT_EMOTIONAL_SHIFT_THRESHOLD,
      'Intention appraisal emotionalShiftThreshold',
    );
    this.dueSoonWindowMs = normalizePositiveNumber(
      config.dueSoonWindowMs,
      DEFAULT_DUE_SOON_WINDOW_MS,
      'Intention appraisal dueSoonWindowMs',
    );
    this.recentMessageCount = normalizePositiveInteger(
      config.recentMessageCount,
      DEFAULT_RECENT_MESSAGE_COUNT,
      'Intention appraisal recentMessageCount',
    );
    this.maxMessageChars = normalizePositiveInteger(
      config.maxMessageChars,
      DEFAULT_MAX_MESSAGE_CHARS,
      'Intention appraisal maxMessageChars',
    );
    this.maxConcernCount = normalizePositiveInteger(
      config.maxConcernCount,
      DEFAULT_MAX_CONCERN_COUNT,
      'Intention appraisal maxConcernCount',
    );
    this.maxDecisions = normalizePositiveInteger(
      config.maxDecisions,
      DEFAULT_MAX_DECISIONS,
      'Intention appraisal maxDecisions',
    );
    this.systemPrompt = config.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
    this.fallbackCharacterName = config.characterName?.trim() || undefined;
    this.resolveCharacterPromptVariables = config.characterPromptVariablesProvider
      ?? (() => ({}));
    this.onEvaluationError = config.onEvaluationError;
  }

  async evaluate(input: IntentionAppraisalInput): Promise<IntentionActionDecision[]> {
    const normalized = normalizeInput(input, {
      recentMessageCount: this.recentMessageCount,
      maxMessageChars: this.maxMessageChars,
      maxConcernCount: this.maxConcernCount,
    });

    const state = this.sessionState.get(normalized.sessionId) ?? {
      turnsSinceLastAppraisal: 0,
      lastEmotion: null,
    };

    const turnsSinceLast = state.turnsSinceLastAppraisal + 1;
    const emotionTelemetryTrusted = normalized.currentEmotionTelemetry === null
      || normalized.currentEmotionTelemetry.status === 'trusted';
    const emotionalShift = emotionTelemetryTrusted
      ? maxEmotionShift(state.lastEmotion, normalized.currentEmotion)
      : 0;
    const concernDueSoon = hasDueSoonConcern(
      normalized.activeConcerns,
      normalized.now,
      this.dueSoonWindowMs,
    );
    const trigger = classifyAppraisalTrigger({
      triggerOverride: normalized.triggerOverride,
      emotionalShift,
      emotionalShiftThreshold: this.emotionalShiftThreshold,
      concernDueSoon,
      turnsSinceLast,
      appraisalFrequency: this.appraisalFrequency,
    });

    state.lastEmotion = emotionTelemetryTrusted ? normalized.currentEmotion : null;
    state.turnsSinceLastAppraisal = trigger ? 0 : turnsSinceLast;
    this.sessionState.set(normalized.sessionId, state);

    if (!trigger) {
      return [buildNoopDecision('no appraisal trigger matched')];
    }

    let persona: AppraisalPersonaContext | null;
    try {
      persona = buildAppraisalPersonaContext(
        this.resolveCharacterPromptVariables(),
        this.fallbackCharacterName,
      );
    } catch (error) {
      this.onEvaluationError?.(error, { sessionId: normalized.sessionId, trigger });
      return [buildNoopDecision('appraisal failed closed')];
    }

    const promptPayload = buildAppraisalPromptPayload({
      normalized,
      trigger,
      turnsSinceLast,
      emotionalShift,
      persona,
    });

    const completionPurpose: CompletionPurpose = 'background';
    const promptMessage: ContextMessage = {
      role: 'user',
      content: JSON.stringify(promptPayload, null, 2),
    };

    try {
      const completion = await this.llmProvider.complete({
        systemPrompt: buildRuntimeAppraisalSystemPrompt(this.systemPrompt, persona),
        messages: [promptMessage],
      }, completionPurpose);
      const parsed = parseDecisionResponse(completion.content, this.maxDecisions);
      const decisions = parsed.decisions.length > 0
        ? parsed.decisions
        : [buildNoopDecision('model returned no valid decisions')];
      return decisions;
    } catch (error) {
      this.onEvaluationError?.(error, { sessionId: normalized.sessionId, trigger });
      return [buildNoopDecision('appraisal failed closed')];
    }
  }
}
