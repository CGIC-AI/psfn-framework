export type OperatorAlertSinkId = 'ntfy' | 'telegram' | 'discord';

export interface OperatorAlertSinkConfiguration {
  configuredSinks: OperatorAlertSinkId[];
  status: 'configured' | 'unconfigured';
  warning: string | null;
}

export function resolveOperatorAlertSinkConfiguration(input: {
  ntfyConfigured: boolean;
  telegramEnabled: boolean;
  telegramChatId?: string;
  discordEnabled?: boolean;
  discordChannelId?: string;
}): OperatorAlertSinkConfiguration {
  const configuredSinks: OperatorAlertSinkId[] = [];
  if (input.ntfyConfigured) configuredSinks.push('ntfy');
  if (input.telegramEnabled && input.telegramChatId?.trim()) configuredSinks.push('telegram');
  if (input.discordEnabled && input.discordChannelId?.trim()) configuredSinks.push('discord');
  return configuredSinks.length > 0
    ? { configuredSinks, status: 'configured', warning: null }
    : {
        configuredSinks,
        status: 'unconfigured',
        warning: 'Operator alerting has zero configured sinks; alerts cannot leave the runtime.',
      };
}
