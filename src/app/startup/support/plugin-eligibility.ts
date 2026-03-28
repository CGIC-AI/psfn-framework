import type {
  EligibilityGate,
  EligibilityOperation,
  EligibilityRequirements,
} from '../../../system/capabilities/eligibility.js';
import type { ChannelAdapter } from '../../../channels/backplane/types.js';
import type { StreamingSttConnector } from '../../../primitives/voice/connectors/stt/index.js';
import type { StreamingTtsConnector } from '../../../primitives/voice/connectors/tts/index.js';

export type RuntimePluginKind = 'channel' | 'stt' | 'tts';

function hasEffectiveEligibilityRequirements(requirements: EligibilityRequirements): boolean {
  return Boolean(
    (requirements.requiredTokens?.length ?? 0) > 0
    || requirements.minimumTier,
  );
}

function requireEligibilityRequirements(
  pluginType: RuntimePluginKind,
  pluginId: string,
  requirements?: EligibilityRequirements,
): EligibilityRequirements {
  if (!requirements) {
    throw new Error(`${pluginType} plugin "${pluginId}" is missing eligibility requirements`);
  }
  return requirements;
}

function requireEligibility(
  eligibilityGate: EligibilityGate | undefined,
  operation: EligibilityOperation,
  requirements: EligibilityRequirements,
): void {
  if (!eligibilityGate || !hasEffectiveEligibilityRequirements(requirements)) {
    return;
  }
  eligibilityGate.requireAllowed(operation, requirements);
}

export function requirePluginActivationEligibility(
  eligibilityGate: EligibilityGate | undefined,
  pluginType: RuntimePluginKind,
  pluginId: string,
  requirements?: EligibilityRequirements,
): void {
  const resolvedRequirements = requireEligibilityRequirements(pluginType, pluginId, requirements);
  requireEligibility(eligibilityGate, {
    kind: 'plugin.activate',
    pluginType,
    pluginId,
  }, resolvedRequirements);
}

function requirePluginActionEligibility(
  eligibilityGate: EligibilityGate | undefined,
  pluginType: RuntimePluginKind,
  pluginId: string,
  action: string,
  requirements?: EligibilityRequirements,
): void {
  const resolvedRequirements = requireEligibilityRequirements(pluginType, pluginId, requirements);
  requireEligibility(eligibilityGate, {
    kind: 'plugin.action',
    pluginType,
    pluginId,
    action,
  }, resolvedRequirements);
}

export function wrapChannelAdapterWithEligibility(
  adapter: ChannelAdapter,
  eligibilityGate: EligibilityGate | undefined,
  requirements?: EligibilityRequirements,
): ChannelAdapter {
  const resolvedRequirements = requireEligibilityRequirements('channel', adapter.id, requirements);
  if (!eligibilityGate || !hasEffectiveEligibilityRequirements(resolvedRequirements)) {
    return adapter;
  }

  const gateway = {
    ...adapter.gateway,
    start: async (): Promise<void> => {
      requirePluginActivationEligibility(eligibilityGate, 'channel', adapter.id, requirements);
      await adapter.gateway.start();
    },
  };

  const outbound = {
    ...adapter.outbound,
    sendText: async (...args: Parameters<ChannelAdapter['outbound']['sendText']>): Promise<void> => {
      requirePluginActionEligibility(eligibilityGate, 'channel', adapter.id, 'sendText', requirements);
      await adapter.outbound.sendText(...args);
    },
    ...(adapter.outbound.sendMedia
      ? {
        sendMedia: async (
          ...args: Parameters<NonNullable<ChannelAdapter['outbound']['sendMedia']>>
        ): Promise<void> => {
          requirePluginActionEligibility(eligibilityGate, 'channel', adapter.id, 'sendMedia', requirements);
          await adapter.outbound.sendMedia?.(...args);
        },
      }
      : {}),
  };

  const streaming = adapter.streaming
    ? {
      ...adapter.streaming,
      sendTyping: async (
        ...args: Parameters<NonNullable<ChannelAdapter['streaming']>['sendTyping']>
      ): Promise<void> => {
        requirePluginActionEligibility(eligibilityGate, 'channel', adapter.id, 'sendTyping', requirements);
        await adapter.streaming?.sendTyping(...args);
      },
    }
    : undefined;

  return {
    ...adapter,
    gateway,
    outbound,
    ...(streaming ? { streaming } : {}),
    ...(adapter.send
      ? {
        send: async (...args: Parameters<NonNullable<ChannelAdapter['send']>>): Promise<void> => {
          requirePluginActionEligibility(eligibilityGate, 'channel', adapter.id, 'send', requirements);
          await adapter.send?.(...args);
        },
      }
      : {}),
  };
}

export function wrapStreamingSttConnectorWithEligibility(
  connector: StreamingSttConnector,
  provider: string,
  eligibilityGate: EligibilityGate | undefined,
  requirements?: EligibilityRequirements,
): StreamingSttConnector {
  const resolvedRequirements = requireEligibilityRequirements('stt', provider, requirements);
  if (!eligibilityGate || !hasEffectiveEligibilityRequirements(resolvedRequirements)) {
    return connector;
  }

  return {
    ...connector,
    startStream: async (
      ...args: Parameters<StreamingSttConnector['startStream']>
    ): Promise<Awaited<ReturnType<StreamingSttConnector['startStream']>>> => {
      requirePluginActionEligibility(eligibilityGate, 'stt', provider, 'startStream', resolvedRequirements);
      return connector.startStream(...args);
    },
  };
}

export function wrapStreamingTtsConnectorWithEligibility(
  connector: StreamingTtsConnector,
  provider: string,
  eligibilityGate: EligibilityGate | undefined,
  requirements?: EligibilityRequirements,
): StreamingTtsConnector {
  const resolvedRequirements = requireEligibilityRequirements('tts', provider, requirements);
  if (!eligibilityGate || !hasEffectiveEligibilityRequirements(resolvedRequirements)) {
    return connector;
  }

  return {
    ...connector,
    synthesizeStream: async (
      ...args: Parameters<StreamingTtsConnector['synthesizeStream']>
    ): Promise<Awaited<ReturnType<StreamingTtsConnector['synthesizeStream']>>> => {
      requirePluginActionEligibility(eligibilityGate, 'tts', provider, 'synthesizeStream', resolvedRequirements);
      return connector.synthesizeStream(...args);
    },
    synthesizeBuffer: async (
      ...args: Parameters<StreamingTtsConnector['synthesizeBuffer']>
    ): Promise<Awaited<ReturnType<StreamingTtsConnector['synthesizeBuffer']>>> => {
      requirePluginActionEligibility(eligibilityGate, 'tts', provider, 'synthesizeBuffer', resolvedRequirements);
      return connector.synthesizeBuffer(...args);
    },
  };
}
