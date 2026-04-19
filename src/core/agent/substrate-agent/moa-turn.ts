import { runDeliberation } from '../../../primitives/llm/deliberation.js';
import type { LLMContext, ObservabilityCallType, SubstrateMessage, TurnID, TurnUsage } from '../../../shared/contracts/runtime.js';
import type { ChargePolicyReferenceModelClass } from '../../../system/config/charge-policy-config.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { chargeSurface, getRunChargeContext, runWithChargeContext } from '../../../shared/telemetry/run-charge.js';
import { isRecord } from '../../../shared/utils/types.js';
import type { LLMProviderPort } from '../contracts.js';

interface MoaLogger {
  warn: (message: string, payload: Record<string, unknown>) => void;
}

export interface ResolvedMoaSettings {
  maxRounds: number;
  maxTokensPerRound?: number;
  timeoutMs: number;
  referenceModels: string[];
  aggregatorModel?: string;
}

export function resolveMoaSettings(config: SubstrateConfig, logger: MoaLogger): ResolvedMoaSettings | null {
  if (config.moaEnabled !== true) return null;

  const maxRoundsRaw = config.moaMaxRounds ?? 4;
  const timeoutMsRaw = config.moaTimeoutMs ?? 45_000;
  const maxTokensPerRoundRaw = config.moaMaxTokensPerRound;

  if (!Number.isFinite(maxRoundsRaw) || maxRoundsRaw <= 0) {
    logger.warn('MoA disabled for turn due invalid max rounds', {
      moaMaxRounds: config.moaMaxRounds,
    });
    return null;
  }
  if (!Number.isFinite(timeoutMsRaw) || timeoutMsRaw <= 0) {
    logger.warn('MoA disabled for turn due invalid timeout', {
      moaTimeoutMs: config.moaTimeoutMs,
    });
    return null;
  }
  if (
    maxTokensPerRoundRaw !== undefined
    && (!Number.isFinite(maxTokensPerRoundRaw) || maxTokensPerRoundRaw <= 0)
  ) {
    logger.warn('MoA disabled for turn due invalid token cap', {
      moaMaxTokensPerRound: config.moaMaxTokensPerRound,
    });
    return null;
  }

  const referenceModels: string[] = [];
  for (const value of config.moaReferenceModels ?? []) {
    const trimmed = value.trim();
    if (!trimmed || referenceModels.includes(trimmed)) continue;
    referenceModels.push(trimmed);
  }
  const aggregatorModel = config.moaAggregatorModel?.trim() || undefined;

  return {
    maxRounds: Math.max(1, Math.floor(maxRoundsRaw)),
    timeoutMs: Math.max(250, Math.floor(timeoutMsRaw)),
    ...(maxTokensPerRoundRaw !== undefined
      ? { maxTokensPerRound: Math.max(1, Math.floor(maxTokensPerRoundRaw)) }
      : {}),
    referenceModels,
    ...(aggregatorModel ? { aggregatorModel } : {}),
  };
}

function buildMoaPrompt(context: LLMContext): string {
  const transcript = context.messages
    .map(message => `${message.role}:\n${message.content}`)
    .join('\n\n');
  return [
    'Produce the best final assistant reply for the latest user turn.',
    `System instructions:\n${context.systemPrompt}`,
    transcript.length > 0 ? `Conversation transcript:\n${transcript}` : '',
    'Return only the assistant response text to send back.',
  ]
    .map(section => section.trim())
    .filter(section => section.length > 0)
    .join('\n\n');
}

export async function runMoaTurn(input: {
  llmClient: LLMProviderPort;
  context: LLMContext;
  message: SubstrateMessage;
  settings: ResolvedMoaSettings;
  config?: SubstrateConfig;
  turnId: TurnID;
  requestId: string;
  callType: ObservabilityCallType;
  contextWindow: number;
  emitTelemetry: (eventName: string, payload: Record<string, unknown>) => void;
}): Promise<{
  output: string;
  model: string;
  turnUsage: TurnUsage;
  rounds: number;
  stopReason: string;
}> {
  const activeChargeContext = getRunChargeContext();
  if (!activeChargeContext && input.config?.chargePolicy) {
    return runWithChargeContext({
      chargePolicy: input.config.chargePolicy,
      eventBus: {
        emit: async (eventName, payload) => {
          input.emitTelemetry(eventName, payload);
        },
      },
      lane: 'interactive',
      runId: input.requestId,
      correlation: {
        turnId: input.turnId,
        requestId: input.requestId,
        channelId: input.message.channelId,
        callType: input.callType,
        originType: input.callType,
        originStage: 'agent.moa.turn',
        purpose: 'agent.moa.turn',
      },
    }, async () => runMoaTurn(input));
  }

  const caps = {
    maxRounds: input.settings.maxRounds,
    maxWallTimeMs: input.settings.timeoutMs,
    ...(input.settings.maxTokensPerRound !== undefined
      ? {
        maxTokensPerRound: input.settings.maxTokensPerRound,
        maxTotalTokens: input.settings.maxTokensPerRound * input.settings.maxRounds,
      }
      : {}),
  };
  const deliberation = await runDeliberation(
    input.llmClient,
    buildMoaPrompt(input.context),
    {
      correlation: {
        turnId: input.turnId,
        requestId: input.requestId,
        channelId: input.message.channelId,
        callType: input.callType,
        originType: input.callType,
        originStage: 'agent.moa.turn',
        purpose: 'agent.moa.turn',
      },
      ...(input.settings.referenceModels.length > 0 ? { referenceModels: input.settings.referenceModels } : {}),
      ...(input.settings.aggregatorModel ? { aggregatorModel: input.settings.aggregatorModel } : {}),
      caps,
    },
  );

  for (const round of deliberation.rounds) {
    chargeSurface('moaRoundBase', {
      details: {
        round: round.index + 1,
        totalRounds: deliberation.rounds.length,
      },
    });

    for (const voice of round.voices) {
      const modelClass = resolveReferenceModelClass(voice.model, input.config);
      const consultCharge = resolveConsultCharge(input.config, modelClass);
      chargeSurface('externalModelConsult', {
        amount: consultCharge,
        details: {
          round: round.index + 1,
          model: voice.model,
          referenceModelClass: modelClass,
          voicePurpose: voice.purpose,
        },
      });
    }

    if (round.aggregatorModel) {
      const modelClass = resolveReferenceModelClass(round.aggregatorModel, input.config);
      const consultCharge = resolveConsultCharge(input.config, modelClass);
      chargeSurface('externalModelConsult', {
        amount: consultCharge,
        details: {
          round: round.index + 1,
          model: round.aggregatorModel,
          referenceModelClass: modelClass,
          role: 'aggregator',
        },
      });
    }
  }

  const llmCalls = deliberation.rounds.reduce(
    (sum, round) => sum + round.voices.length + (round.aggregatorModel ? 1 : 0),
    0,
  );
  const peakInputTokens = deliberation.rounds.reduce(
    (max, round) => Math.max(max, round.inputTokens),
    0,
  );
  const contextUtilization = input.contextWindow > 0
    ? Math.min(100, (peakInputTokens / input.contextWindow) * 100)
    : 0;
  const lastRound = deliberation.rounds[deliberation.rounds.length - 1];
  const model = lastRound.aggregatorModel
    ?? lastRound.voices[lastRound.voices.length - 1].model;

  const turnUsage: TurnUsage = {
    inputTokens: deliberation.totalInputTokens,
    outputTokens: deliberation.totalOutputTokens,
    cacheReadTokens: 0,
    llmCalls,
    toolCalls: 0,
    contextUtilization,
    ...(deliberation.estimatedCostUsd > 0 ? { estimatedCostUsd: deliberation.estimatedCostUsd } : {}),
  };

  input.emitTelemetry('agent.moa.turn', {
    turnId: input.turnId,
    requestId: input.requestId,
    channelId: input.message.channelId,
    callType: input.callType,
    purpose: 'agent.moa.turn',
    rounds: deliberation.rounds.length,
    stopReason: deliberation.stopReason,
    llmCalls,
    referenceModels: input.settings.referenceModels,
    aggregatorModel: input.settings.aggregatorModel ?? null,
    model,
    totalInputTokens: deliberation.totalInputTokens,
    totalOutputTokens: deliberation.totalOutputTokens,
    maxRounds: input.settings.maxRounds,
    maxTokensPerRound: input.settings.maxTokensPerRound ?? null,
    timeoutMs: input.settings.timeoutMs,
  });

  return {
    output: deliberation.output,
    model,
    turnUsage,
    rounds: deliberation.rounds.length,
    stopReason: deliberation.stopReason,
  };
}

function resolveReferenceModelClass(
  model: string,
  config: SubstrateConfig | undefined,
): ChargePolicyReferenceModelClass {
  const entry = config?.modelRegistry?.models.find((candidate) => (
    candidate.id === model
    || candidate.identity.model === model
    || candidate.identity.provider === model
  ));

  const metadataClass = isRecord(entry?.metadata) ? entry.metadata.chargeClass : undefined;
  if (
    metadataClass === 'local'
    || metadataClass === 'subscription'
    || metadataClass === 'cheap_cloud'
    || metadataClass === 'premium_cloud'
  ) {
    return metadataClass;
  }

  const provider = entry?.identity.provider.toLowerCase() ?? '';
  const modelId = model.toLowerCase();
  if (
    provider.includes('ollama')
    || provider.includes('transformers')
    || provider === 'local'
    || modelId.includes('/local')
    || modelId.includes('local:')
  ) {
    return 'local';
  }

  if (modelId.includes('premium')) {
    return 'premium_cloud';
  }
  if (modelId.includes('cheap')) {
    return 'cheap_cloud';
  }
  if (modelId.includes('subscription')) {
    return 'subscription';
  }

  const inputCost = entry?.cost?.inputPer1MUsd ?? 0;
  const outputCost = entry?.cost?.outputPer1MUsd ?? 0;
  const maxCost = Math.max(inputCost, outputCost);
  if (maxCost <= 0) {
    return 'subscription';
  }
  if (maxCost < 1) {
    return 'cheap_cloud';
  }
  return 'premium_cloud';
}

function resolveConsultCharge(
  config: SubstrateConfig | undefined,
  modelClass: ChargePolicyReferenceModelClass,
): number {
  const pricing = config?.chargePolicy?.referenceModelClassPricing[modelClass] ?? 0;
  const multiplier = config?.chargePolicy?.moa.perRoundMultiplierByReferenceModelClass[modelClass] ?? 1;
  return pricing * multiplier;
}
