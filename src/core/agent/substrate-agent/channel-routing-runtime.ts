import type { ChannelPromptRegistryPort } from '../../../channels/backplane/registry-port.js';
import type { ChannelPromptDock } from '../../../channels/backplane/types.js';
import {
  isIcpContinuationTaskKind,
  type SubstrateMessage,
} from '../../../shared/contracts/runtime.js';
import type { ContextBudgetTurnCharacteristics } from '../../../shared/context-budget.js';
import { resolveIcpAutonomyCandidateSchedulerOrigin } from '../../icp/candidate-scheduler-origin.js';
import {
  normalizeTurnModelOverride,
  resolveTurnModelPurpose,
} from './model-runtime.js';

export function resolveChannelPromptDock(
  message: SubstrateMessage,
  channelRegistry: ChannelPromptRegistryPort,
): ChannelPromptDock | undefined {
  const fromChannelType = channelRegistry.get(message.channelType);
  if (fromChannelType) return fromChannelType;

  const separatorIndex = message.channelId.indexOf(':');
  if (separatorIndex > 0) {
    const prefix = message.channelId.slice(0, separatorIndex);
    const fromPrefix = channelRegistry.get(prefix);
    if (fromPrefix) return fromPrefix;
  }

  if (message.channelId.startsWith('discord-voice:')) {
    return channelRegistry.get('discord');
  }
  return undefined;
}

export function resolveChannelType(
  message: SubstrateMessage,
  channelRegistry: ChannelPromptRegistryPort,
): string | undefined {
  const channelDock = resolveChannelPromptDock(message, channelRegistry);
  const adapterType = channelDock?.prompt?.resolveChannelType(message);
  if (adapterType) return adapterType;
  if (channelDock?.capabilities.promptChannelType) {
    return channelDock.capabilities.promptChannelType;
  }

  if (message.channelId.startsWith('discord-voice:')) return 'discord_voice';
  if (message.channelId.startsWith('api:')) return 'api';
  if (message.channelId.startsWith('internal:')) return 'internal';
  if (message.channelType === 'discord') return 'discord_text';
  return undefined;
}

export function resolveTaskKind(
  message: SubstrateMessage,
  channelRegistry: ChannelPromptRegistryPort,
): string | undefined {
  const candidateOrigin = resolveIcpAutonomyCandidateSchedulerOrigin(message);
  if (candidateOrigin) return candidateOrigin.continuationTaskKind;
  if (message.routing?.icpContinuationTaskKind) {
    if (message.routing.privateTurnTrigger !== true
      || !message.routing.icpCorrelation
      || message.channelType !== 'companion'
      || message.authorId !== 'system:icp-initiation') {
      throw new Error('ICP continuation task kind requires a bound private target turn');
    }
    const taskKind: unknown = message.routing.icpContinuationTaskKind;
    if (!isIcpContinuationTaskKind(taskKind)) {
      throw new Error('ICP continuation task kind is invalid');
    }
    return taskKind;
  }
  const channelDock = resolveChannelPromptDock(message, channelRegistry);
  const adapterTaskKind = channelDock?.prompt?.resolveTaskKind?.(message);
  if (adapterTaskKind) return adapterTaskKind;

  if (!message.channelId.startsWith('internal:')) return undefined;

  const suffix = message.channelId.slice('internal:'.length).toLowerCase();
  if (!suffix) return undefined;

  if (suffix.includes('heartbeat')) return 'heartbeat';
  if (suffix.includes('reflection')) return 'reflection';
  if (suffix.includes('planning')) return 'planning';
  if (suffix.includes('maintenance')) return 'maintenance';
  return undefined;
}

export function buildTurnBudgetCharacteristics(
  message: SubstrateMessage,
  taskKind?: string,
): ContextBudgetTurnCharacteristics {
  const modelOverride = normalizeTurnModelOverride(message);
  const modelPurpose = modelOverride?.purpose ?? resolveTurnModelPurpose(message);

  return {
    channelId: message.channelId,
    channelType: message.channelType,
    isDirectMessage: message.isDirectMessage,
    messageText: message.content,
    ...(taskKind ? { taskKind } : {}),
    modelSelection: {
      purpose: modelPurpose,
      ...(modelOverride?.slotKey ? { slotKey: modelOverride.slotKey } : {}),
      ...(modelOverride?.provider ? { provider: modelOverride.provider } : {}),
      ...(modelOverride?.model ? { model: modelOverride.model } : {}),
      ...(modelOverride?.contextWindow !== undefined ? { contextWindow: modelOverride.contextWindow } : {}),
    },
  };
}
