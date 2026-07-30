import type { ChannelOutboundDock } from '../../channels/backplane/types.js';
import {
  resolveOperatorAlertSinkConfiguration,
  type OperatorAlertSinkConfiguration,
  type OperatorAlertSinkId,
} from '../../shared/contracts/operator-alerting.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { normalizeNotificationSenderMetadata } from './notification-sender.js';
import type {
  NotifyNtfyParams,
  NotifyNtfyResult,
  OperatorAlertDelivery,
  OperatorAlertResult,
} from './protocol.js';

const log = createComponentLogger('OperatorAlertDispatcher');

interface OperatorAlertLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface GatewayOperatorAlertDispatcherOptions {
  ntfy: {
    isConfigured(): boolean;
    send(params: NotifyNtfyParams): Promise<NotifyNtfyResult>;
  };
  telegramDock?: ChannelOutboundDock;
  telegramChatId?: string;
  logger?: OperatorAlertLogger;
}

/**
 * Gateway-owned system-alert fan-out. Every configured sink is attempted;
 * one failed sink never prevents another from firing.
 */
export class GatewayOperatorAlertDispatcher {
  private readonly ntfy: GatewayOperatorAlertDispatcherOptions['ntfy'];
  private readonly telegramDock?: ChannelOutboundDock;
  private readonly telegramChatId?: string;
  private readonly logger: OperatorAlertLogger;

  constructor(options: GatewayOperatorAlertDispatcherOptions) {
    this.ntfy = options.ntfy;
    this.telegramDock = options.telegramDock;
    this.telegramChatId = options.telegramChatId?.trim() || undefined;
    this.logger = options.logger ?? log;
  }

  configuration(): OperatorAlertSinkConfiguration {
    return resolveOperatorAlertSinkConfiguration({
      ntfyConfigured: this.ntfy.isConfigured(),
      telegramEnabled: this.telegramDock !== undefined,
      telegramChatId: this.telegramChatId,
    });
  }

  async dispatch(params: NotifyNtfyParams): Promise<OperatorAlertResult> {
    const sender = normalizeNotificationSenderMetadata(params.sender);
    if (sender.kind !== 'system') {
      throw new Error('notify.operator accepts only system-derived notifications');
    }
    const message = params.message.trim();
    if (!message) {
      throw new Error('notify.operator requires a non-empty message');
    }

    const configuration = this.configuration();
    if (configuration.status === 'unconfigured') {
      throw new Error(configuration.warning!);
    }

    const attempts: Array<Promise<OperatorAlertDelivery>> = [];
    if (this.ntfy.isConfigured()) {
      attempts.push(
        this.ntfy.send({ ...params, sender, message })
          .then(result => ({
            sink: 'ntfy' as const,
            status: result.status,
            target: result.topic,
            ...(result.messageId ? { messageId: result.messageId } : {}),
          }))
          .catch(error => this.recordFailure('ntfy', error, sender.provenance)),
      );
    }

    if (this.telegramDock && this.telegramChatId) {
      const target = `telegram:${this.telegramChatId}`;
      const title = params.title?.trim();
      const content = escapeTelegramMarkdown(title ? `${title}\n\n${message}` : message);
      attempts.push(
        this.telegramDock.outbound.sendText({ channelId: target }, content)
          .then(() => ({ sink: 'telegram' as const, status: 'sent' as const, target }))
          .catch(error => this.recordFailure('telegram', error, sender.provenance)),
      );
    }

    const deliveries = await Promise.all(attempts);
    if (deliveries.every(delivery => delivery.status === 'failed')) {
      throw new Error(
        `Operator alert delivery failed for every configured sink (${deliveries
          .map(delivery => `${delivery.sink}: ${delivery.error ?? 'unknown error'}`)
          .join('; ')})`,
      );
    }
    return { deliveries };
  }

  private recordFailure(
    sink: OperatorAlertSinkId,
    error: unknown,
    provenance: string,
  ): OperatorAlertDelivery {
    const message = toErrorMessage(error);
    this.logger.error('Operator alert sink delivery failed', {
      sink,
      provenance,
      error: message,
    });
    return { sink, status: 'failed', error: message };
  }
}

function escapeTelegramMarkdown(value: string): string {
  return value.replace(/([\\_*[\]`])/g, '\\$1');
}
