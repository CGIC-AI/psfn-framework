import type { Model } from '@mariozechner/pi-ai';
import type { MessageModelOverride, ModelPurpose, SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { CoreSubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import {
  resolveExplicitModel,
  resolveModel,
  resolveModelSelection,
} from '../stream-adapter.js';
import { hasVisionTurnInputs } from './vision-attachments.js';

export interface ModelRuntimeState {
  modelResolved: boolean;
  modelSignature: string | null;
}

export type ModelRefreshReason = 'startup' | 'turn-start' | 'settings-update';

export interface ModelRuntimeLogger {
  info(message: string, payload: Record<string, unknown>): void;
  warn(message: string, payload: Record<string, unknown>): void;
}

export function getModelSignatureForPurpose(
  config: CoreSubstrateConfig,
  purpose: ModelPurpose,
): string {
  try {
    const selection = resolveModelSelection(config, purpose);
    const contextWindow = selection.contextWindow ?? config.defaultContextWindow;
    return `${purpose}::${selection.provider}::${selection.model}::${selection.maxTokens}::${contextWindow}`;
  } catch (error) {
    return `${purpose}::unresolved::${toErrorMessage(error)}`;
  }
}

export function resolveTurnModelPurpose(
  message?: SubstrateMessage,
): ModelPurpose {
  const channelId = message?.channelId ?? '';
  if (
    channelId === 'internal:heartbeat'
    || channelId.startsWith('internal:heartbeat:')
    || channelId.startsWith('internal:reflection:')
  ) {
    return 'memory';
  }
  return hasVisionTurnInputs(message) ? 'vision' : 'chat';
}

export function normalizeTurnModelOverride(
  message?: SubstrateMessage,
): MessageModelOverride | null {
  const raw = message?.routing?.modelOverride;
  if (!raw) return null;
  const provider = raw.provider.trim().toLowerCase();
  const model = raw.model.trim();
  if (!provider || !model) return null;

  return {
    provider,
    model,
    ...(raw.maxTokens !== undefined ? { maxTokens: raw.maxTokens } : {}),
    ...(raw.contextWindow !== undefined ? { contextWindow: raw.contextWindow } : {}),
    ...(raw.slotKey ? { slotKey: raw.slotKey } : {}),
    ...(raw.purpose ? { purpose: raw.purpose } : {}),
  };
}

export function getTurnModelSignature(
  config: CoreSubstrateConfig,
  message?: SubstrateMessage,
): string {
  const override = normalizeTurnModelOverride(message);
  if (!override) {
    const purpose = resolveTurnModelPurpose(message);
    return getModelSignatureForPurpose(config, purpose);
  }
  return `override::${override.provider}::${override.model}::${override.maxTokens ?? ''}::${override.contextWindow ?? ''}`;
}

interface RefreshModelFromConfigParams {
  reason: ModelRefreshReason;
  config: CoreSubstrateConfig;
  state: ModelRuntimeState;
  message?: SubstrateMessage;
  setAgentModel: (model: Model<any>) => void;
  getCurrentModelId: () => string;
  logger: ModelRuntimeLogger;
}

export function refreshModelFromConfig(
  params: RefreshModelFromConfigParams,
): ModelRuntimeState {
  const override = normalizeTurnModelOverride(params.message);
  const purpose = override ? null : resolveTurnModelPurpose(params.message);
  const nextSignature = getTurnModelSignature(params.config, params.message);

  if (params.state.modelResolved && params.state.modelSignature === nextSignature) {
    return params.state;
  }

  try {
    const resolved = override
      ? resolveExplicitModel(params.config, override)
      : resolveModel(params.config, purpose ?? 'chat');
    params.setAgentModel(resolved);
    if (purpose === 'vision' && !resolved.input.includes('image')) {
      params.logger.warn('Vision purpose resolved to model without image input capability', {
        reason: params.reason,
        model: resolved.id,
        provider: resolved.provider,
        channelId: params.message?.channelId,
      });
    }
    params.logger.info('Resolved runtime model', {
      reason: params.reason,
      model: resolved.id,
      override: Boolean(override),
      ...(purpose ? { purpose } : {}),
    });
    return {
      modelResolved: true,
      modelSignature: nextSignature,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    params.logger.warn('Model refresh failed; keeping previous chat model', {
      reason: params.reason,
      error: err.message,
      currentModel: params.getCurrentModelId(),
    });
    return {
      modelResolved: true,
      modelSignature: params.state.modelSignature,
    };
  }
}
