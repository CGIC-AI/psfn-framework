import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '../../core/agent/contracts.js';
import type { CompletionPurpose, ContextMessage, CorrelationMetadata, ObservabilityCallType } from '../../shared/contracts/runtime.js';
import type { LLMCompletionOptions } from './client.js';

type DeliberationPurpose = Extract<CompletionPurpose, 'background' | 'reasoning'>;

const DEFAULT_VOICES: DeliberationPurpose[] = ['reasoning', 'background'];
const DEFAULT_AGGREGATOR_PURPOSE: DeliberationPurpose = 'reasoning';

const DEFAULT_CAPS = {
  maxRounds: 4,
  maxTotalTokens: 8_000,
  maxWallTimeMs: 45_000,
};

const DEFAULT_FATIGUE = {
  noveltyFloor: 0.18,
  fatigueStep: 0.75,
  roundDrift: 0.08,
  minContinueProbability: 0.32,
};

const DEFAULT_COST = {
  inputUsdPerMillionTokens: 2,
  outputUsdPerMillionTokens: 8,
};

export type DeliberationStopReason =
  | 'fatigue_taper'
  | 'max_rounds'
  | 'token_cap'
  | 'time_cap';

export interface DeliberationCaps {
  maxRounds: number;
  maxTotalTokens: number;
  maxWallTimeMs: number;
  maxTokensPerRound?: number;
}

export interface DeliberationFatigueConfig {
  noveltyFloor: number;
  fatigueStep: number;
  roundDrift: number;
  minContinueProbability: number;
}

export interface DeliberationCostConfig {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export interface DeliberationVoiceTurn {
  purpose: DeliberationPurpose;
  requestedModel?: string;
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface DeliberationRound {
  index: number;
  voices: DeliberationVoiceTurn[];
  synthesis: string;
  aggregatorModel?: string;
  requestedAggregatorModel?: string;
  novelty: number;
  fatigue: number;
  continueProbability: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface DeliberationResult {
  sessionId: string;
  output: string;
  stopReason: DeliberationStopReason;
  rounds: DeliberationRound[];
  voices: DeliberationPurpose[];
  caps: DeliberationCaps;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

export interface DeliberationOptions {
  sessionId?: string;
  voices?: DeliberationPurpose[];
  referenceModels?: string[];
  aggregatorModel?: string;
  aggregatorPurpose?: DeliberationPurpose;
  correlation?: Partial<CorrelationMetadata>;
  caps?: Partial<DeliberationCaps>;
  fatigue?: Partial<DeliberationFatigueConfig>;
  cost?: Partial<DeliberationCostConfig>;
  now?: () => number;
}

interface DeliberationVoiceConfig {
  purpose: DeliberationPurpose;
  requestedModel?: string;
}

interface ResolvedDeliberationConfig {
  sessionId: string;
  voices: DeliberationVoiceConfig[];
  aggregatorModel?: string;
  aggregatorPurpose: DeliberationPurpose;
  correlation?: Partial<CorrelationMetadata>;
  caps: DeliberationCaps;
  fatigue: DeliberationFatigueConfig;
  cost: DeliberationCostConfig;
  now: () => number;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizePurposes(values: DeliberationPurpose[] | undefined): DeliberationPurpose[] {
  if (!Array.isArray(values) || values.length === 0) {
    return [...DEFAULT_VOICES];
  }

  const deduped: DeliberationPurpose[] = [];
  for (const purpose of values) {
    if (!deduped.includes(purpose)) deduped.push(purpose);
  }
  return deduped.length > 0 ? deduped : [...DEFAULT_VOICES];
}

function normalizeModelHints(values: string[] | undefined): string[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  const hints: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || hints.includes(trimmed)) continue;
    hints.push(trimmed);
  }
  return hints;
}

function resolveVoiceConfigs(
  purposes: DeliberationPurpose[],
  referenceModels: string[],
): DeliberationVoiceConfig[] {
  if (referenceModels.length === 0) {
    return purposes.map(purpose => ({ purpose }));
  }

  return referenceModels.map((requestedModel, index) => ({
    purpose: purposes[index % purposes.length],
    requestedModel,
  }));
}

function tokenizeForNovelty(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(token => token.trim())
    .filter(token => token.length > 2);
  return new Set(tokens);
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  const denominator = left.size + right.size - overlap;
  if (denominator <= 0) return 0;
  return overlap / denominator;
}

function noveltyAgainstHistory(candidate: string, history: Set<string>[]): number {
  if (history.length === 0) return 1;
  const candidateTokens = tokenizeForNovelty(candidate);
  if (candidateTokens.size === 0) return 0;

  let maxSimilarity = 0;
  for (const prior of history) {
    maxSimilarity = Math.max(maxSimilarity, jaccardSimilarity(candidateTokens, prior));
  }
  return clampUnit(1 - maxSimilarity);
}

function estimateCostUsd(
  costConfig: DeliberationCostConfig,
  inputTokens: number,
  outputTokens: number,
): number {
  const inputRate = Math.max(0, costConfig.inputUsdPerMillionTokens);
  const outputRate = Math.max(0, costConfig.outputUsdPerMillionTokens);
  return ((inputTokens * inputRate) + (outputTokens * outputRate)) / 1_000_000;
}

function resolveDeliberationConfig(options: DeliberationOptions = {}): ResolvedDeliberationConfig {
  const voices = normalizePurposes(options.voices);
  const referenceModels = normalizeModelHints(options.referenceModels);
  const aggregatorModel = options.aggregatorModel?.trim() || undefined;
  const caps: DeliberationCaps = {
    maxRounds: Math.max(1, Math.floor(options.caps?.maxRounds ?? DEFAULT_CAPS.maxRounds)),
    maxTotalTokens: Math.max(256, Math.floor(options.caps?.maxTotalTokens ?? DEFAULT_CAPS.maxTotalTokens)),
    maxWallTimeMs: Math.max(250, Math.floor(options.caps?.maxWallTimeMs ?? DEFAULT_CAPS.maxWallTimeMs)),
    ...(options.caps?.maxTokensPerRound !== undefined
      ? { maxTokensPerRound: Math.max(1, Math.floor(options.caps.maxTokensPerRound)) }
      : {}),
  };

  const fatigue: DeliberationFatigueConfig = {
    noveltyFloor: clampUnit(options.fatigue?.noveltyFloor ?? DEFAULT_FATIGUE.noveltyFloor),
    fatigueStep: Math.max(0, options.fatigue?.fatigueStep ?? DEFAULT_FATIGUE.fatigueStep),
    roundDrift: Math.max(0, options.fatigue?.roundDrift ?? DEFAULT_FATIGUE.roundDrift),
    minContinueProbability: clampUnit(
      options.fatigue?.minContinueProbability ?? DEFAULT_FATIGUE.minContinueProbability,
    ),
  };

  const cost: DeliberationCostConfig = {
    inputUsdPerMillionTokens: Math.max(
      0,
      options.cost?.inputUsdPerMillionTokens ?? DEFAULT_COST.inputUsdPerMillionTokens,
    ),
    outputUsdPerMillionTokens: Math.max(
      0,
      options.cost?.outputUsdPerMillionTokens ?? DEFAULT_COST.outputUsdPerMillionTokens,
    ),
  };

  return {
    sessionId: options.sessionId ?? randomUUID(),
    voices: resolveVoiceConfigs(voices, referenceModels),
    ...(aggregatorModel ? { aggregatorModel } : {}),
    aggregatorPurpose: options.aggregatorPurpose === 'background'
      ? 'background'
      : DEFAULT_AGGREGATOR_PURPOSE,
    ...(options.correlation ? { correlation: options.correlation } : {}),
    caps,
    fatigue,
    cost,
    now: options.now ?? Date.now,
  };
}

function buildVoiceMessages(
  prompt: string,
  previousSynthesis: string | null,
  roundIndex: number,
): ContextMessage[] {
  const messages: ContextMessage[] = [
    {
      role: 'user',
      content: `Reflection topic:\n${prompt}`,
    },
  ];

  if (previousSynthesis) {
    messages.push({
      role: 'assistant',
      content: `Previous round synthesis:\n${previousSynthesis}`,
    });
    messages.push({
      role: 'user',
      content: `Round ${roundIndex}: contribute only genuinely new angles or tensions.`,
    });
  } else {
    messages.push({
      role: 'user',
      content: `Round ${roundIndex}: share a strong perspective in 2-4 sentences.`,
    });
  }

  return messages;
}

function buildVoiceSystemPrompt(purpose: DeliberationPurpose): string {
  if (purpose === 'background') {
    return 'You are an intuitive inner voice. Focus on feelings, lived context, and practical implications. Keep it concise.';
  }
  return 'You are an analytical inner voice. Focus on structure, tradeoffs, and contradiction checks. Keep it concise.';
}

function buildAggregatorMessages(
  prompt: string,
  voiceTurns: DeliberationVoiceTurn[],
  previousSynthesis: string | null,
): ContextMessage[] {
  const voiceBlock = voiceTurns
    .map((voice, index) => `Voice ${index + 1} (${voice.purpose}):\n${voice.content}`)
    .join('\n\n');

  const content = [
    `Original reflection topic:\n${prompt}`,
    voiceBlock,
    previousSynthesis
      ? `Previous synthesis:\n${previousSynthesis}`
      : null,
    'Synthesize the strongest insights into one coherent reflection (2-5 sentences).',
  ]
    .filter(section => section != null)
    .join('\n\n');

  return [{ role: 'user', content }];
}

interface DeliberationCompletionProvider {
  complete(
    context: { systemPrompt: string; messages: ContextMessage[] },
    purpose: CompletionPurpose,
    options?: LLMCompletionOptions,
  ): Promise<{
    content: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }>;
}

async function completeForDeliberation(
  llmProvider: LLMProvider,
  context: { systemPrompt: string; messages: ContextMessage[] },
  purpose: CompletionPurpose,
  options?: LLMCompletionOptions,
): Promise<{
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}> {
  const completionProvider = llmProvider as DeliberationCompletionProvider;
  return completionProvider.complete(context, purpose, options);
}

function buildCompletionOptions(
  requestedModel: string | undefined,
  maxTokens: number | undefined,
  correlation?: CorrelationMetadata,
): LLMCompletionOptions | undefined {
  if (!requestedModel && maxTokens === undefined && !correlation) return undefined;
  return {
    ...(requestedModel || maxTokens !== undefined
      ? {
        modelHint: {
          ...(requestedModel ? { model: requestedModel } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
        },
      }
      : {}),
    ...(correlation ? { correlation } : {}),
  };
}

function buildDeliberationCorrelation(
  baseCorrelation: Partial<CorrelationMetadata> | undefined,
  originStage: string,
  fallbackOriginType: ObservabilityCallType,
): CorrelationMetadata {
  return {
    ...(baseCorrelation?.turnId ? { turnId: baseCorrelation.turnId } : {}),
    ...(baseCorrelation?.requestId ? { requestId: baseCorrelation.requestId } : {}),
    ...(baseCorrelation?.channelId ? { channelId: baseCorrelation.channelId } : {}),
    callType: baseCorrelation?.callType ?? baseCorrelation?.originType ?? fallbackOriginType,
    ...(baseCorrelation?.toolName ? { toolName: baseCorrelation.toolName } : {}),
    ...(baseCorrelation?.toolCallId ? { toolCallId: baseCorrelation.toolCallId } : {}),
    purpose: originStage,
    originType: baseCorrelation?.originType ?? baseCorrelation?.callType ?? fallbackOriginType,
    originStage,
  };
}

export async function runDeliberation(
  llmProvider: LLMProvider,
  prompt: string,
  options: DeliberationOptions = {},
): Promise<DeliberationResult> {
  const config = resolveDeliberationConfig(options);
  const startedAt = config.now();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let estimatedCostUsd = 0;
  let fatigue = 0;
  let output = '';
  let stopReason: DeliberationStopReason | null = null;
  let previousSynthesis: string | null = null;
  const noveltyHistory: Set<string>[] = [];
  const rounds: DeliberationRound[] = [];

  for (let roundIndex = 1; roundIndex <= config.caps.maxRounds; roundIndex += 1) {
    const elapsedBeforeRound = config.now() - startedAt;
    if (elapsedBeforeRound >= config.caps.maxWallTimeMs) {
      stopReason = 'time_cap';
      break;
    }
    if (totalInputTokens + totalOutputTokens >= config.caps.maxTotalTokens) {
      stopReason = 'token_cap';
      break;
    }

    const roundStartedAt = config.now();
    const voices: DeliberationVoiceTurn[] = [];
    let roundInputTokens = 0;
    let roundOutputTokens = 0;
    let aggregatorModel: string | undefined;

    for (const voice of config.voices) {
      const roundRemainingTokens = config.caps.maxTokensPerRound !== undefined
        ? Math.max(1, config.caps.maxTokensPerRound - (roundInputTokens + roundOutputTokens))
        : undefined;
      if (roundRemainingTokens !== undefined && roundRemainingTokens <= 0) {
        stopReason = 'token_cap';
        break;
      }

      const response = await completeForDeliberation(
        llmProvider,
        {
          systemPrompt: buildVoiceSystemPrompt(voice.purpose),
          messages: buildVoiceMessages(prompt, previousSynthesis, roundIndex),
        },
        voice.purpose,
          buildCompletionOptions(
            voice.requestedModel,
            roundRemainingTokens,
            buildDeliberationCorrelation(
              config.correlation,
              `deliberation.voice.${voice.purpose}`,
              voice.purpose === 'background' ? 'background' : 'tool',
            ),
          ),
      );

      totalInputTokens += response.inputTokens;
      totalOutputTokens += response.outputTokens;
      estimatedCostUsd += estimateCostUsd(config.cost, response.inputTokens, response.outputTokens);
      roundInputTokens += response.inputTokens;
      roundOutputTokens += response.outputTokens;

      voices.push({
        purpose: voice.purpose,
        ...(voice.requestedModel ? { requestedModel: voice.requestedModel } : {}),
        content: response.content.trim(),
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      });

      if (config.now() - startedAt >= config.caps.maxWallTimeMs) {
        stopReason = 'time_cap';
        break;
      }
      if (totalInputTokens + totalOutputTokens >= config.caps.maxTotalTokens) {
        stopReason = 'token_cap';
        break;
      }
      if (
        config.caps.maxTokensPerRound !== undefined
        && roundInputTokens + roundOutputTokens >= config.caps.maxTokensPerRound
      ) {
        stopReason = 'token_cap';
        break;
      }
    }

    if (voices.length === 0) {
      stopReason = stopReason ?? 'token_cap';
      break;
    }

    let synthesis = voices[voices.length - 1].content;

    if (!stopReason) {
      const roundRemainingTokens = config.caps.maxTokensPerRound !== undefined
        ? Math.max(1, config.caps.maxTokensPerRound - (roundInputTokens + roundOutputTokens))
        : undefined;
      if (roundRemainingTokens !== undefined && roundRemainingTokens <= 0) {
        stopReason = 'token_cap';
      } else {
        const synthesisResponse = await completeForDeliberation(
          llmProvider,
          {
            systemPrompt:
              'You are an inner synthesis layer. Merge multiple perspectives into a single reflection that preserves nuance and avoids repetition.',
            messages: buildAggregatorMessages(prompt, voices, previousSynthesis),
          },
          config.aggregatorPurpose,
          buildCompletionOptions(
            config.aggregatorModel,
            roundRemainingTokens,
            buildDeliberationCorrelation(
              config.correlation,
              'deliberation.aggregator',
              'summary',
            ),
          ),
        );
        synthesis = synthesisResponse.content.trim();
        aggregatorModel = synthesisResponse.model;
        totalInputTokens += synthesisResponse.inputTokens;
        totalOutputTokens += synthesisResponse.outputTokens;
        estimatedCostUsd += estimateCostUsd(
          config.cost,
          synthesisResponse.inputTokens,
          synthesisResponse.outputTokens,
        );
        roundInputTokens += synthesisResponse.inputTokens;
        roundOutputTokens += synthesisResponse.outputTokens;

        if (config.now() - startedAt >= config.caps.maxWallTimeMs) {
          stopReason = 'time_cap';
        } else if (totalInputTokens + totalOutputTokens >= config.caps.maxTotalTokens) {
          stopReason = 'token_cap';
        } else if (
          config.caps.maxTokensPerRound !== undefined
          && roundInputTokens + roundOutputTokens >= config.caps.maxTokensPerRound
        ) {
          stopReason = 'token_cap';
        }
      }
    }

    const novelty = noveltyAgainstHistory(synthesis, noveltyHistory);
    noveltyHistory.push(tokenizeForNovelty(synthesis));
    fatigue = clampUnit(
      fatigue
      + ((1 - novelty) * config.fatigue.fatigueStep)
      + (roundIndex > 1 ? config.fatigue.roundDrift : 0),
    );
    const continueProbability = clampUnit(1 - fatigue);

    rounds.push({
      index: roundIndex,
      voices,
      synthesis,
      ...(aggregatorModel ? { aggregatorModel } : {}),
      ...(config.aggregatorModel ? { requestedAggregatorModel: config.aggregatorModel } : {}),
      novelty,
      fatigue,
      continueProbability,
      inputTokens: roundInputTokens,
      outputTokens: roundOutputTokens,
      durationMs: config.now() - roundStartedAt,
    });
    output = synthesis;
    previousSynthesis = synthesis;

    if (stopReason) break;

    if (
      novelty <= config.fatigue.noveltyFloor
      || continueProbability <= config.fatigue.minContinueProbability
    ) {
      stopReason = 'fatigue_taper';
      break;
    }
  }

  if (!stopReason) {
    stopReason = rounds.length >= config.caps.maxRounds ? 'max_rounds' : 'fatigue_taper';
  }

  const endedAt = config.now();
  return {
    sessionId: config.sessionId,
    output,
    stopReason,
    rounds,
    voices: config.voices.map(voice => voice.purpose),
    caps: config.caps,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    estimatedCostUsd,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
  };
}
