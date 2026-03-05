import { JSONRPCErrorException } from 'json-rpc-2.0';
import type { ConfirmationQueueEntry } from '../capabilities/confirmation-queue.js';
import type { ChannelOutboundDock } from '../channels/types.js';
import { createComponentLogger } from '../logger.js';
import { toErrorMessage } from '../utils/errors.js';
import {
  GatewayErrors,
  type NotifyNtfyParams,
  type NotifyNtfyResult,
} from './protocol.js';

const log = createComponentLogger('Gateway');
const DEFAULT_CONFIRMATION_NOTIFICATION_PRIORITY = 4;

export interface GatewayNtfyConfig {
  baseUrl: string;
  defaultTopic: string;
  token?: string;
  timeoutMs: number;
  debounceWindowMs: number;
}

export class GatewayNtfyNotifier {
  private readonly recentAlerts = new Map<string, number>();
  private readonly config?: GatewayNtfyConfig;

  constructor(config?: GatewayNtfyConfig) {
    this.config = config;
  }

  isConfigured(): boolean {
    return Boolean(this.config);
  }

  async send(params: NotifyNtfyParams): Promise<NotifyNtfyResult> {
    const config = this.config;
    if (!config) {
      throw new JSONRPCErrorException('ntfy is not configured', GatewayErrors.PROVIDER_ERROR);
    }

    const message = params.message.trim();
    if (!message) {
      throw new JSONRPCErrorException('notify.ntfy requires a non-empty message', GatewayErrors.PROVIDER_ERROR);
    }

    const topic = params.topic?.trim() || config.defaultTopic;
    if (!topic) {
      throw new JSONRPCErrorException('notify.ntfy topic is not configured', GatewayErrors.PROVIDER_ERROR);
    }

    const title = params.title?.trim();
    const priority = this.normalizePriority(params.priority);

    const fingerprint = JSON.stringify({ topic, title: title ?? '', priority, message });
    if (this.isDebouncedAlert(fingerprint, config.debounceWindowMs)) {
      return { status: 'debounced', topic };
    }

    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    const endpoint = `${baseUrl}/${encodeURIComponent(topic)}`;
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
    };
    if (title) {
      headers.Title = toHeaderByteString(title);
    }
    if (priority !== undefined) {
      headers.Priority = String(priority);
    }
    if (config.token) {
      headers.Authorization = `Bearer ${config.token}`;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: message,
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) {
      throw new JSONRPCErrorException(
        `ntfy request failed: ${response.status} ${response.statusText}`,
        GatewayErrors.PROVIDER_ERROR,
      );
    }

    const messageId = response.headers.get('x-message-id') ?? undefined;
    return { status: 'sent', topic, ...(messageId ? { messageId } : {}) };
  }

  private normalizePriority(priority: number | undefined): number | undefined {
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      return undefined;
    }
    return Math.max(1, Math.min(5, Math.trunc(priority)));
  }

  private isDebouncedAlert(fingerprint: string, windowMs: number): boolean {
    if (windowMs <= 0) {
      return false;
    }

    const now = Date.now();
    const minTimestamp = now - windowMs;
    for (const [key, lastSeenAt] of this.recentAlerts) {
      if (lastSeenAt < minTimestamp) {
        this.recentAlerts.delete(key);
      }
    }

    const previous = this.recentAlerts.get(fingerprint);
    this.recentAlerts.set(fingerprint, now);
    return previous !== undefined && now - previous < windowMs;
  }
}

function toHeaderByteString(value: string): string {
  // Prevent header injection and keep undici ByteString constraints satisfied.
  const normalized = value.replace(/[\r\n]+/g, ' ').trim();
  if (!normalized) return '';
  // Encode unicode as UTF-8 bytes and present them as latin1 code units so
  // undici can send the raw bytes without throwing on surrogate code points.
  return Buffer.from(normalized, 'utf8').toString('latin1');
}

export interface PendingActionNotificationOptions {
  entry: ConfirmationQueueEntry;
  discordAdapter: ChannelOutboundDock;
  operatorDiscordChannelId?: string;
  ntfyTopic?: string;
  ntfyNotifier?: GatewayNtfyNotifier;
}

export async function notifyOperatorForPendingAction({
  entry,
  discordAdapter,
  operatorDiscordChannelId,
  ntfyTopic,
  ntfyNotifier,
}: PendingActionNotificationOptions): Promise<void> {
  const notification = formatPendingConfirmationAlert(entry);
  const operatorChannelId = operatorDiscordChannelId?.trim();
  let delivered = false;

  if (operatorChannelId) {
    try {
      await discordAdapter.outbound.sendText(
        { channelId: operatorChannelId },
        notification,
      );
      delivered = true;
    } catch (error) {
      log.warn('Failed to send confirmation alert via Discord', {
        confirmationId: entry.id,
        channelId: operatorChannelId,
        error: toErrorMessage(error),
      });
    }
  }

  if (!delivered && ntfyNotifier?.isConfigured()) {
    try {
      await ntfyNotifier.send({
        message: notification,
        title: 'PSFN approval required',
        priority: DEFAULT_CONFIRMATION_NOTIFICATION_PRIORITY,
        topic: ntfyTopic,
      });
      delivered = true;
    } catch (error) {
      log.warn('Failed to send confirmation alert via ntfy', {
        confirmationId: entry.id,
        error: toErrorMessage(error),
      });
    }
  }

  if (!delivered) {
    log.warn('No operator notification channel available for queued confirmation', {
      confirmationId: entry.id,
    });
  }
}

function formatPendingConfirmationAlert(entry: ConfirmationQueueEntry): string {
  return [
    `Approval required: ${entry.method} (${entry.action})`,
    `Scope: ${entry.scope}`,
    `Reason: ${entry.companionReason}`,
    `Confirmation ID: ${entry.id}`,
    `Expires: ${new Date(entry.expiresAt).toISOString()}`,
    'Review in admin: /confirmations',
  ].join('\n');
}
