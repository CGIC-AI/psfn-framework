import { JSONRPCErrorException } from 'json-rpc-2.0';
import { createHash } from 'node:crypto';
import type { ConfirmationQueueEntry } from '../../system/capabilities/confirmation-queue.js';
import type { ChannelOutboundDock } from '../../channels/backplane/types.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  GatewayErrors,
  type NotifyNtfyParams,
  type NotifyNtfyResult,
} from './protocol.js';
import { normalizeNotificationSenderMetadata } from './notification-sender.js';

const log = createComponentLogger('Gateway');
const DEFAULT_CONFIRMATION_NOTIFICATION_PRIORITY = 4;
const CONFIRMATION_NOTIFICATION_SENDER = Object.freeze({
  kind: 'system',
  provenance: 'system.gateway.confirmation',
});

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

  hasConfiguredTopic(topic?: string): boolean {
    return this.config !== undefined && this.resolveTopic(topic) !== undefined;
  }

  async send(params: NotifyNtfyParams): Promise<NotifyNtfyResult> {
    const config = this.config;
    if (!config) {
      throw new JSONRPCErrorException('ntfy is not configured', GatewayErrors.PROVIDER_ERROR);
    }

    let sender;
    try {
      sender = normalizeNotificationSenderMetadata(params.sender);
    } catch (error) {
      throw new JSONRPCErrorException(
        `notify.ntfy ${toErrorMessage(error)}`,
        GatewayErrors.PROVIDER_ERROR,
      );
    }

    const message = params.message.trim();
    if (!message) {
      throw new JSONRPCErrorException('notify.ntfy requires a non-empty message', GatewayErrors.PROVIDER_ERROR);
    }

    const topic = this.resolveTopic(params.topic);
    if (!topic) {
      throw new JSONRPCErrorException('notify.ntfy topic is not configured', GatewayErrors.PROVIDER_ERROR);
    }

    const title = params.title?.trim();
    const priority = this.normalizePriority(params.priority);
    const sequenceId = this.resolveSequenceId(params.idempotencyKey);

    const fingerprint = JSON.stringify({
      sender,
      topic,
      title: title ?? '',
      priority,
      message,
    });
    if (!sequenceId && this.isDebouncedAlert(fingerprint, config.debounceWindowMs)) {
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
    if (sequenceId) {
      headers['X-Sequence-ID'] = sequenceId;
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

  private resolveSequenceId(idempotencyKey: string | undefined): string | undefined {
    if (idempotencyKey === undefined) return undefined;
    const normalized = idempotencyKey.trim();
    if (!normalized) {
      throw new JSONRPCErrorException(
        'notify.ntfy idempotencyKey must be non-empty when provided',
        GatewayErrors.PROVIDER_ERROR,
      );
    }
    return createHash('sha256').update(normalized).digest('hex');
  }

  private normalizePriority(priority: number | undefined): number | undefined {
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      return undefined;
    }
    return Math.max(1, Math.min(5, Math.trunc(priority)));
  }

  private resolveTopic(topic?: string): string | undefined {
    const explicitTopic = topic?.trim();
    if (explicitTopic) return explicitTopic;
    const defaultTopic = this.config?.defaultTopic.trim();
    return defaultTopic || undefined;
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
  const deliveryErrors: string[] = [];

  if (operatorChannelId) {
    try {
      await discordAdapter.outbound.sendText(
        { channelId: operatorChannelId },
        notification,
      );
      delivered = true;
    } catch (error) {
      deliveryErrors.push(`Discord: ${toErrorMessage(error)}`);
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
        sender: CONFIRMATION_NOTIFICATION_SENDER,
        message: notification,
        title: 'PSFN approval required',
        priority: DEFAULT_CONFIRMATION_NOTIFICATION_PRIORITY,
        topic: ntfyTopic,
      });
      delivered = true;
    } catch (error) {
      deliveryErrors.push(`ntfy: ${toErrorMessage(error)}`);
      log.warn('Failed to send confirmation alert via ntfy', {
        confirmationId: entry.id,
        error: toErrorMessage(error),
      });
    }
  }

  if (!delivered) {
    const detail = deliveryErrors.length > 0
      ? ` (${deliveryErrors.join('; ')})`
      : '';
    throw new Error(`Queued confirmation ${entry.id} has no reachable operator notification sink${detail}`);
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
